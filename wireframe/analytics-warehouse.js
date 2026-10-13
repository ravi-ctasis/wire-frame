// ############################################################################
// ##  WAREHOUSE NODE ANALYTICS + PER-SKU INSPECTION DEEP DIVE
// ##  ----------------------------------------------------------------------
// ##  Answers, for one physical facility:
// ##    - what came in, what went out, what is left (pre / post stock ledger)
// ##    - how fast stock moves through this node (velocity, dwell, turns)
// ##    - where sales and PROFIT are declining WoW / MoM / QoQ / YoY
// ##    - which SKUs are ageing, dead, or eating capital in this building
// ############################################################################

/* --------------------------------------------------------------------------
   Node model. Each facility sees a different slice of total demand:
   the USA 3PL ships nearly all e-commerce, the EU hub a minority share, and
   the India origin warehouse "consumes" stock as outbound replenishment
   rather than retail sales.
-------------------------------------------------------------------------- */
function raNodeProfile(wh) {
  const isUSA = (wh.type || "").includes("3PL") || wh.country === "United States";
  const isEU = (wh.id || "").includes("EU") || wh.country === "Germany";
  if (isUSA) return { key: "usa", share: 1.0, label: "USA 3PL fulfilment", flow: "Retail outbound", leadTime: RA_CONST.LEAD_TIME_OCEAN };
  if (isEU) return { key: "eu", share: 0.35, label: "EU distribution hub", flow: "Retail + B2B outbound", leadTime: RA_CONST.LEAD_TIME_OCEAN };
  return { key: "india", share: 0.62, label: "India origin & export", flow: "Replenishment outbound", leadTime: 18 };
}

/** Per-SKU metrics scoped to one warehouse node. */
function raNodeSkuMetrics(sku, wh) {
  const node = raNodeProfile(wh);
  const m = raSkuMetrics(sku, { leadTime: node.leadTime });
  const hist = m.history;

  const stockHere = node.key === "usa" ? (sku.stock.usaAvailable || 0)
    : node.key === "eu" ? Math.round((sku.stock.usaAvailable || 12) * 0.45)
    : (sku.stock.indiaAvailable || 0);
  const resvHere = node.key === "usa" ? (sku.stock.usaReserved || 0)
    : node.key === "eu" ? Math.round((sku.stock.usaReserved || 4) * 0.5)
    : (sku.stock.indiaPacked || 0);

  // Scale the daily flow series to this node's share of movement.
  const days = hist.days.map(d => ({
    date: d.date, label: d.label,
    out: d.units * node.share,
    in: d.inbound * node.share,
    revenue: d.revenue * node.share,
    profit: d.profit * node.share,
    onHand: d.onHand * node.share
  }));

  const outSeries = days.map(d => d.out);
  const inSeries = days.map(d => d.in);
  const profitSeries = days.map(d => d.profit);
  const revSeries = days.map(d => d.revenue);

  const out7 = raMean(outSeries.slice(-7));
  const out28 = raMean(outSeries.slice(-28));
  const out200 = raMean(outSeries.slice(-200));
  const totalHere = stockHere + resvHere;
  const dwellDays = out28 > 0 ? totalHere / out28 : 999;
  const avgInv90 = raMean(days.slice(-90).map(d => d.onHand)) || 1;
  const turns = avgInv90 > 0 ? (raSum(outSeries.slice(-90)) * 4) / avgInv90 : 0;

  const unitCost = m.unitCost;
  const landedVal = totalHere * (sku.sellingPriceUSD || 500) * 0.42;

  const periods = {};
  RA_PERIODS.forEach(p => {
    const u = raComparePeriod(outSeries, p.days, p.back);
    const r = raComparePeriod(revSeries, p.days, p.back);
    const g = raComparePeriod(profitSeries, p.days, p.back);
    periods[p.key] = {
      meta: p, units: u, revenue: r, profit: g,
      marginNow: r.current > 0 ? (g.current / r.current) * 100 : 0,
      marginPrev: r.previous > 0 ? (g.previous / r.previous) * 100 : 0,
      verdict: raVerdict(u.pct, r.pct, g.pct)
    };
    periods[p.key].marginDeltaPts = periods[p.key].marginNow - periods[p.key].marginPrev;
  });

  // Ageing: how long has the oldest layer of this stock been sitting here?
  let cumulative = 0, ageDays = 0;
  for (let i = outSeries.length - 1; i >= 0 && cumulative < totalHere; i--) {
    cumulative += outSeries[i];
    ageDays++;
  }
  const ageBucket = ageDays <= 30 ? "0–30d" : ageDays <= 60 ? "31–60d" : ageDays <= 90 ? "61–90d" : ageDays <= 180 ? "91–180d" : "180d+";
  const ageTone = ageDays <= 60 ? "var(--success)" : ageDays <= 90 ? "var(--warning)" : "var(--danger)";

  return Object.assign({}, m, {
    node, days, outSeries, inSeries, profitSeries, revSeries,
    stockHere, resvHere, totalHere, landedVal,
    out7, out28, out200, dwellDays, turns, avgInv90,
    nodePeriods: periods, ageDays, ageBucket, ageTone,
    nodeProfit90: raSum(profitSeries.slice(-90)),
    nodeRevenue90: raSum(revSeries.slice(-90)),
    nodeOut90: raSum(outSeries.slice(-90)),
    nodeIn90: raSum(inSeries.slice(-90)),
    nodeCapital: totalHere * unitCost,
    nodeLongCross: out200 > 0 ? ((out7 - out200) / out200) * 100 : 0,
    weightHere: totalHere * (sku.weightKg || 25)
  });
}

function raWarehouseAnalytics(wh) {
  const rows = (AppState.skus || []).map(s => raNodeSkuMetrics(s, wh));
  const node = raNodeProfile(wh);
  const agg = {
    node,
    skuCount: rows.length,
    units: rows.reduce((t, r) => t + r.totalHere, 0),
    available: rows.reduce((t, r) => t + r.stockHere, 0),
    reserved: rows.reduce((t, r) => t + r.resvHere, 0),
    capital: rows.reduce((t, r) => t + r.nodeCapital, 0),
    landedVal: rows.reduce((t, r) => t + r.landedVal, 0),
    weightKg: rows.reduce((t, r) => t + r.weightHere, 0),
    out90: rows.reduce((t, r) => t + r.nodeOut90, 0),
    in90: rows.reduce((t, r) => t + r.nodeIn90, 0),
    profit90: rows.reduce((t, r) => t + r.nodeProfit90, 0),
    revenue90: rows.reduce((t, r) => t + r.nodeRevenue90, 0),
    out7: rows.reduce((t, r) => t + r.out7, 0),
    out28: rows.reduce((t, r) => t + r.out28, 0),
    out200: rows.reduce((t, r) => t + r.out200, 0),
    excessCapital: rows.reduce((t, r) => t + r.excessCapital, 0),
    aged90: rows.filter(r => r.ageDays > 90).length
  };
  agg.turns = rows.length ? raMean(rows.map(r => r.turns)) : 0;
  agg.dwell = agg.out28 > 0 ? agg.units / agg.out28 : 999;
  agg.margin90 = agg.revenue90 > 0 ? (agg.profit90 / agg.revenue90) * 100 : 0;
  agg.longCross = agg.out200 > 0 ? ((agg.out7 - agg.out200) / agg.out200) * 100 : 0;
  agg.netFlow90 = agg.in90 - agg.out90;

  // Node-level period matrix, summed across SKUs
  const len = rows[0] ? rows[0].outSeries.length : 0;
  const u = new Array(len).fill(0), r = new Array(len).fill(0), p = new Array(len).fill(0);
  rows.forEach(row => row.days.forEach((d, i) => { u[i] += d.out; r[i] += d.revenue; p[i] += d.profit; }));
  agg.series = { units: u, revenue: r, profit: p, labels: rows[0] ? rows[0].days.map(d => d.label) : [] };
  agg.periods = {};
  RA_PERIODS.forEach(pd => {
    const un = raComparePeriod(u, pd.days, pd.back);
    const rv = raComparePeriod(r, pd.days, pd.back);
    const pf = raComparePeriod(p, pd.days, pd.back);
    agg.periods[pd.key] = {
      meta: pd, units: un, revenue: rv, profit: pf,
      marginNow: rv.current > 0 ? (pf.current / rv.current) * 100 : 0,
      marginPrev: rv.previous > 0 ? (pf.previous / rv.previous) * 100 : 0,
      verdict: raVerdict(un.pct, rv.pct, pf.pct)
    };
    agg.periods[pd.key].marginDeltaPts = agg.periods[pd.key].marginNow - agg.periods[pd.key].marginPrev;
  });

  return { rows, agg };
}

/* --------------------------------------------------------------------------
   The extra tab button injected into the warehouse detail page.
-------------------------------------------------------------------------- */
function raWarehouseTabButton(wh) {
  const { agg } = raWarehouseAnalytics(wh);
  const tone = agg.periods.qoq.profit.pct >= 0 ? "var(--success)" : "var(--danger)";
  return `
    <button class="detail-tab-btn" onclick="switchDetailTab('wh-tab-analytics', this)">
      <span>📊 Stock & Sales Analytics</span>
      <span class="detail-tab-badge" style="color:${tone};">${raPct(agg.periods.qoq.profit.pct, 0)} QoQ profit</span>
    </button>`;
}

/* --------------------------------------------------------------------------
   The analytics tab pane itself.
-------------------------------------------------------------------------- */
function raWarehouseAnalyticsTab(wh) {
  const { rows, agg } = raWarehouseAnalytics(wh);
  const pKey = (AppState.tableFilters.whAnalytics && AppState.tableFilters.whAnalytics.period) || "qoq";

  // ---- Pre / post stock ledger, 12 trailing weeks ------------------------
  const weeks = 12, wsize = 7;
  const ledger = [];
  let ptr = agg.series.units.length;
  const onHandSeries = [];
  rows.forEach(r => r.days.forEach((d, i) => { onHandSeries[i] = (onHandSeries[i] || 0) + d.onHand; }));

  for (let b = weeks - 1; b >= 0; b--) {
    const end = ptr - b * wsize;
    const start = Math.max(0, end - wsize);
    if (start >= end) continue;
    const outQ = raSum(agg.series.units.slice(start, end));
    let inQ = 0;
    rows.forEach(r => { inQ += raSum(r.inSeries.slice(start, end)); });
    const opening = onHandSeries[start] || 0;
    const closing = onHandSeries[end - 1] || 0;
    ledger.push({
      label: raFmtDate(rows[0].days[start].date) + " – " + raFmtDate(rows[0].days[end - 1].date),
      shortLabel: raFmtDate(rows[0].days[end - 1].date),
      opening, inQ, outQ, closing,
      net: inQ - outQ,
      profit: raSum(agg.series.profit.slice(start, end)),
      turnPct: opening > 0 ? (outQ / opening) * 100 : 0
    });
  }

  // ---- Node demand curve with 7 / 28 / 200 day averages ------------------
  const show = 260;
  const uSeries = agg.series.units;
  const sma7 = raSMA(uSeries, 7).slice(-show);
  const sma28 = raSMA(uSeries, 28).slice(-show);
  const sma200 = raSMA(uSeries, 200).slice(-show);
  const labels = agg.series.labels.slice(-show);

  // ---- Movement velocity leaderboard -------------------------------------
  const fastest = [...rows].sort((a, b) => a.dwellDays - b.dwellDays).slice(0, 6).map(r => ({
    label: r.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
    sub: `${r.totalHere} rolls here`,
    value: 400 - Math.min(r.dwellDays, 400),
    display: r.dwellDays > 900 ? "∞" : Math.round(r.dwellDays) + "d",
    color: r.dwellDays < 45 ? "var(--success)" : r.dwellDays < 90 ? "var(--brand-cyan)" : "var(--warning)"
  }));

  const stagnant = [...rows].sort((a, b) => b.ageDays - a.ageDays).slice(0, 6).map(r => ({
    label: r.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
    sub: `${raMoney(r.nodeCapital)} tied up`,
    value: Math.min(r.ageDays, 400),
    display: Math.round(r.ageDays) + "d",
    color: r.ageTone
  }));

  const decl = rows.filter(r => r.nodePeriods[pKey].profit.pct < -5)
    .sort((a, b) => a.nodePeriods[pKey].profit.pct - b.nodePeriods[pKey].profit.pct);

  const ageBuckets = [
    { label: "0–30d", color: "#10b981" }, { label: "31–60d", color: "#06b6d4" },
    { label: "61–90d", color: "#f59e0b" }, { label: "91–180d", color: "#f97316" },
    { label: "180d+", color: "#ef4444" }
  ].map(b => ({
    ...b,
    value: rows.filter(r => r.ageBucket === b.label).reduce((t, r) => t + r.totalHere, 0),
    capital: rows.filter(r => r.ageBucket === b.label).reduce((t, r) => t + r.nodeCapital, 0)
  }));

  const periodTabs = RA_PERIODS.map(p =>
    `<button class="btn btn-xs ${pKey === p.key ? "btn-primary" : "btn-ghost"}" onclick="raSetWhPeriod('${p.key}')" title="${raEsc(p.name)}">${p.label}</button>`).join("");

  return `
  <div class="detail-tab-pane" id="wh-tab-analytics">
    <div class="card" style="border-top:none;border-radius:0 0 var(--radius-lg) var(--radius-lg);padding:20px;margin-bottom:24px;">

      <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;flex-wrap:wrap;margin-bottom:14px;">
        <div>
          <h3 style="font-size:16px;font-weight:800;margin:0 0 4px 0;color:var(--text-main);">📊 Stock Movement, Sales Trend & Profitability — ${raEsc(wh.name)}</h3>
          <p style="color:var(--text-muted);font-size:12px;margin:0;line-height:1.5;max-width:780px;">
            Everything on this tab is scoped to this facility only: what physically moved in and out, how fast it moved,
            how long it has been sitting, and whether the sales and gross profit generated from this node are growing or
            shrinking. Classical statistics only — moving averages, period deltas and stock ledgers. No forecasting model.
          </p>
        </div>
        <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;">
          <span style="font-size:10px;font-weight:800;color:var(--text-dim);text-transform:uppercase;">Compare</span>
          <div style="display:flex;background:var(--bg-subtle);padding:2px;border-radius:6px;border:1px solid var(--border-subtle);gap:2px;">${periodTabs}</div>
          <button class="btn btn-sm btn-secondary" onclick="raExportNodeCsv('${raEsc(wh.id)}')">📥 Export node CSV</button>
        </div>
      </div>

      <!-- KPI STRIP -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(148px,1fr));gap:8px;margin-bottom:14px;">
        ${raKpi("Stock in this node", agg.units.toLocaleString() + " rolls", `${agg.available} available · ${agg.reserved} allocated`, "var(--brand-cyan)",
          "Physical rolls held in this facility, available plus allocated to open orders.")}
        ${raKpi("Capital held here", raMoney(agg.capital), `${raMoney(agg.landedVal)} landed value`, "var(--text-main)",
          "Rolls × landed unit cost (manufacturing + packing + allocated freight).")}
        ${raKpi("Outbound velocity", agg.out28.toFixed(1) + " /day", `7d ${agg.out7.toFixed(1)} · 200d ${agg.out200.toFixed(1)}`,
          agg.longCross >= 0 ? "var(--success)" : "var(--danger)",
          "28-day moving average of rolls leaving this node, with the 7-day signal and 200-day baseline.")}
        ${raKpi("Average dwell", agg.dwell > 900 ? "∞" : Math.round(agg.dwell) + " days", `${agg.turns.toFixed(1)}× turns/yr`,
          agg.dwell < 60 ? "var(--success)" : agg.dwell < 120 ? "var(--warning)" : "var(--danger)",
          "How long the average roll sits in this building = stock ÷ 28-day outbound rate.")}
        ${raKpi("Net flow — 90d", (agg.netFlow90 >= 0 ? "+" : "") + Math.round(agg.netFlow90) + " rolls", `${Math.round(agg.in90)} in · ${Math.round(agg.out90)} out`,
          agg.netFlow90 >= 0 ? "var(--info)" : "var(--warning)",
          "Inbound receipts less outbound shipments over 90 days. Persistently positive means the node is filling up faster than it empties.")}
        ${raKpi("Gross profit — 90d", raMoney(agg.profit90), `${agg.margin90.toFixed(1)}% margin`, "var(--success)",
          "Revenue attributed to this node less landed COGS, channel fees and fulfilment cost.")}
        ${raKpi("Idle capital here", raMoney(agg.excessCapital), `${agg.aged90} SKUs aged 90d+`, "var(--brand-purple)",
          "Value of stock in this node beyond the 120-day cover policy ceiling.")}
        ${raKpi(pKey.toUpperCase() + " profit", raPct(agg.periods[pKey].profit.pct, 1), raEsc(agg.periods[pKey].verdict.label),
          agg.periods[pKey].verdict.tone,
          "Gross profit this period against the matching period earlier, for this node only.")}
      </div>

      <!-- PERIOD SCORECARD -->
      <div style="margin-bottom:14px;">
        <div style="font-size:12px;font-weight:800;color:var(--text-main);margin-bottom:7px;">
          Sales & profit trend for this facility — where it is growing and where it is declining
        </div>
        ${raPeriodScorecard(agg.periods)}
      </div>

      <!-- DEMAND CURVE + PRE/POST LEDGER CHART -->
      <div style="display:grid;grid-template-columns:1.25fr 1fr;gap:10px;margin-bottom:12px;">
        ${raCard(
          `Outbound movement vs moving averages — last ${show} days`,
          raLegend([
            { name: "Daily rolls out", color: "#f59e0b" },
            { name: "7-day MA", color: "#6366f1" },
            { name: "28-day MA", color: "#06b6d4" },
            { name: "200-day MA", color: "#a855f7" }
          ]),
          raLineChart({
            id: 21, width: 640, height: 186, labels, xTicks: 8,
            series: [
              { name: "daily", color: "#f59e0b", values: uSeries.slice(-show), type: "bar", opacity: 0.28 },
              { name: "200", color: "#a855f7", values: sma200, type: "line", width: 2.6 },
              { name: "28", color: "#06b6d4", values: sma28, type: "line", width: 2 },
              { name: "7", color: "#6366f1", values: sma7, type: "line", width: 1.8 }
            ]
          }) + `
          <div style="margin-top:8px;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5;color:var(--text-main);">
            The 7-day line is <strong style="color:${agg.longCross >= 0 ? "var(--success)" : "var(--danger)"};">${raPct(agg.longCross, 1)}</strong>
            against this node's 200-day baseline of ${agg.out200.toFixed(1)} rolls/day.
            ${Math.abs(agg.longCross) < 12
              ? "Throughput is tracking its long-run rate, so current staffing, bin allocation and inbound cadence are correctly sized."
              : agg.longCross > 0
                ? "Throughput is running materially above the long-run rate. Check pick capacity and inbound scheduling before the next container lands, or dock congestion will show up as late dispatch."
                : "Throughput has dropped materially below the long-run rate while stock keeps arriving. Slow the inbound cadence for this node or dwell time and storage cost will climb."}
          </div>`
        )}

        ${raCard(
          "Inbound vs outbound — 12 weeks",
          raLegend([{ name: "Received in", color: "#10b981" }, { name: "Shipped out", color: "#ef4444" }]),
          raGroupedBars({
            width: 470, height: 186,
            legend: [{ name: "In", color: "#10b981" }, { name: "Out", color: "#ef4444" }],
            groups: ledger.map(l => ({ label: l.label, shortLabel: l.shortLabel, values: [l.inQ, l.outQ] }))
          }) + `
          <div style="margin-top:8px;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5;color:var(--text-main);">
            ${(() => {
              const pos = ledger.filter(l => l.net > 0).length;
              if (pos >= 9) return "Inbound has exceeded outbound in most of the last 12 weeks — this node is accumulating. Pause the next replenishment leg and work the ageing buckets down first.";
              if (pos <= 3) return "Outbound has exceeded inbound in most of the last 12 weeks — this node is draining. Confirm the in-transit container will land before cover reaches the safety line.";
              return "Inbound and outbound are broadly balanced across the last 12 weeks, which is what a healthy node looks like. Stock level is being held by cadence, not by luck.";
            })()}
          </div>`
        )}
      </div>

      <!-- PRE / POST STOCK LEDGER -->
      <div class="card" style="padding:0;overflow:hidden;margin-bottom:12px;">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:12.5px;">📒 Pre / post stock ledger — weekly reconciliation</strong>
            <div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;">
              Opening stock + receipts − shipments = closing stock, for each of the last 12 weeks. This is the movement
              audit trail behind every velocity figure on this tab.
            </div>
          </div>
        </div>
        <div class="table-responsive">
          <table class="data-table" style="width:100%;font-size:11.5px;">
            <thead>
              <tr>
                <th>Week</th>
                <th style="text-align:right;">Opening stock</th>
                <th style="text-align:right;">Received in (+)</th>
                <th style="text-align:right;">Shipped out (−)</th>
                <th style="text-align:right;">Net movement</th>
                <th style="text-align:right;">Closing stock</th>
                <th style="text-align:right;">Weekly sell-through</th>
                <th style="text-align:right;">Gross profit</th>
              </tr>
            </thead>
            <tbody>
              ${ledger.map(l => `
                <tr>
                  <td style="font-family:var(--font-mono);font-size:11px;">${raEsc(l.label)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${Math.round(l.opening)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--success);">${l.inQ > 0 ? "+" + Math.round(l.inQ) : "—"}</td>
                  <td style="text-align:right;font-family:var(--font-mono);color:var(--danger);">−${Math.round(l.outQ)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${l.net >= 0 ? "var(--info)" : "var(--warning)"};">${l.net >= 0 ? "+" : ""}${Math.round(l.net)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;">${Math.round(l.closing)}</td>
                  <td style="text-align:right;">
                    <div style="display:flex;align-items:center;gap:6px;justify-content:flex-end;">
                      <div style="width:56px;">${raStackBar([
                        { label: "Sold", value: Math.min(l.turnPct, 100), color: l.turnPct > 18 ? "#10b981" : "#06b6d4" },
                        { label: "Held", value: Math.max(0, 100 - l.turnPct), color: "var(--bg-elevated)" }
                      ], 6)}</div>
                      <span style="font-family:var(--font-mono);font-size:11px;">${l.turnPct.toFixed(1)}%</span>
                    </div>
                  </td>
                  <td style="text-align:right;font-family:var(--font-mono);color:${l.profit >= 0 ? "var(--success)" : "var(--danger)"};">${raMoney(l.profit)}</td>
                </tr>`).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <!-- VELOCITY / AGEING / DECLINERS -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:10px;margin-bottom:12px;">
        ${raCard("⚡ Fastest moving through this node", "Dwell time — lower is better", raRankBars(fastest) + `
          <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
            Dwell = rolls held here ÷ 28-day outbound rate. Give the shortest-dwell SKUs the pick faces closest to the
            dispatch door; they are touched most often.
          </div>`)}
        ${raCard("🕸️ Longest sitting — ageing risk", "Days since this stock layer arrived", raRankBars(stagnant) + `
          <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
            Estimated by walking the outbound series backwards until it consumes the current on-hand quantity — the
            classic FIFO ageing method. Anything past 90 days is a markdown or B2B-lot candidate.
          </div>`)}
        ${raCard(`📉 Profit declining here — ${pKey.toUpperCase()}`, `${decl.length} of ${rows.length} SKUs`,
          decl.length ? raRankBars(decl.slice(0, 6).map(r => ({
            label: r.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
            sub: `${raMoney(r.nodePeriods[pKey].profit.delta)}`,
            value: Math.abs(r.nodePeriods[pKey].profit.pct),
            display: raPct(r.nodePeriods[pKey].profit.pct, 0),
            color: "var(--danger)"
          }))) + `
          <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
            Ranked on gross profit rather than units — a SKU shipping more rolls at a deeper discount still shows up here,
            which is exactly the case unit-only reporting hides.
          </div>` :
          `<div style="font-size:11px;color:var(--text-muted);padding:16px 0;text-align:center;">No SKU in this facility is down more than 5% on gross profit ${pKey.toUpperCase()}.</div>`)}
        ${raCard("📦 Stock ageing profile", `${agg.units} rolls · ${raMoney(agg.capital)}`, `
          <div style="margin-bottom:8px;">${raStackBar(ageBuckets.map(b => ({ label: b.label, value: b.value, color: b.color })), 16)}</div>
          <div style="display:flex;flex-direction:column;gap:4px;">
            ${ageBuckets.map(b => `
              <div style="display:flex;justify-content:space-between;align-items:center;font-size:10.5px;">
                <span style="display:inline-flex;align-items:center;gap:5px;color:var(--text-muted);">
                  <span style="width:8px;height:8px;border-radius:2px;background:${b.color};"></span>${b.label}</span>
                <span style="font-family:var(--font-mono);color:var(--text-main);">${Math.round(b.value)} rolls · ${raMoney(b.capital)}</span>
              </div>`).join("")}
          </div>
          <div style="margin-top:8px;font-size:10px;color:var(--text-muted);line-height:1.45;">
            Capital in the 91-180d and 180d+ bands is costing ${RA_CONST.HOLDING_RATE * 100}% a year to carry.
            Clearing it at a discount today usually beats holding it at full price for another two quarters.
          </div>`)}
      </div>

      <!-- SKU INSPECTION TABLE -->
      <div class="card" style="padding:0;overflow:hidden;">
        <div style="padding:10px 14px;border-bottom:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:8px;">
          <div>
            <strong style="font-size:12.5px;">🔎 SKU inspection — movement, trend and profit inside this facility</strong>
            <div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;">Open any row for the full pre/post stock history and period breakdown.</div>
          </div>
          <input type="text" class="form-control" style="max-width:250px;" placeholder="Filter SKUs in this facility..." oninput="filterWhInventoryTable(this.value)">
        </div>
        <div class="table-responsive">
          <table class="data-table" style="width:100%;font-size:11.5px;">
            <thead>
              <tr>
                <th style="min-width:180px;">SKU</th>
                <th style="min-width:88px;">90-day shape</th>
                <th>Held here</th>
                <th>Movement velocity</th>
                <th>7d vs 200d</th>
                <th>${pKey.toUpperCase()} units</th>
                <th>${pKey.toUpperCase()} profit</th>
                <th>Dwell / ageing</th>
                <th>Capital</th>
                <th style="text-align:center;">Inspect</th>
              </tr>
            </thead>
            <tbody id="wh-analytics-table-body">
              ${rows.map(r => {
                const p = r.nodePeriods[pKey];
                return `
                <tr>
                  <td>
                    <strong style="color:var(--brand-cyan);font-family:var(--font-mono);font-size:12px;">${raEsc(r.sku)}</strong>
                    <div style="font-size:10px;color:var(--text-muted);max-width:175px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${raEsc(r.title)}</div>
                  </td>
                  <td>${raSparkline(r.outSeries.slice(-90), r.nodeLongCross > 12 ? "#10b981" : r.nodeLongCross < -12 ? "#ef4444" : "#06b6d4", 80, 24)}</td>
                  <td>
                    <strong style="font-family:var(--font-mono);font-size:12.5px;">${r.totalHere}</strong><span style="font-size:9px;color:var(--text-dim);"> rolls</span>
                    <div style="font-size:9.5px;color:var(--text-dim);">${r.stockHere} free · ${r.resvHere} allocated</div>
                  </td>
                  <td>
                    <strong style="font-family:var(--font-mono);">${r.out28.toFixed(2)}</strong><span style="font-size:9px;color:var(--text-dim);">/day</span>
                    <div style="font-size:9.5px;color:var(--text-dim);">${r.turns.toFixed(1)}× turns/yr</div>
                  </td>
                  <td>
                    <strong style="color:${r.nodeLongCross > 12 ? "var(--success)" : r.nodeLongCross < -12 ? "var(--danger)" : "var(--text-muted)"};font-family:var(--font-mono);">${raPct(r.nodeLongCross, 0)}</strong>
                    <div style="font-size:9px;color:var(--text-dim);">base ${r.out200.toFixed(2)}/d</div>
                  </td>
                  <td>${raDelta(p.units.pct)}
                    <div style="font-size:9px;color:var(--text-dim);">${Math.round(p.units.current)} vs ${Math.round(p.units.previous)}</div>
                  </td>
                  <td>
                    <strong style="color:${p.verdict.tone};font-family:var(--font-mono);">${raPct(p.profit.pct, 0)}</strong>
                    <div style="font-size:9px;color:var(--text-dim);">${raMoney(p.profit.current)}</div>
                  </td>
                  <td>
                    <strong style="font-family:var(--font-mono);color:${r.dwellDays < 60 ? "var(--success)" : r.dwellDays < 120 ? "var(--warning)" : "var(--danger)"};">${r.dwellDays > 900 ? "∞" : Math.round(r.dwellDays)}d</strong>
                    <div style="font-size:9px;color:${r.ageTone};">aged ${r.ageBucket}</div>
                  </td>
                  <td style="font-family:var(--font-mono);">${raMoney(r.nodeCapital)}</td>
                  <td style="text-align:center;">
                    <button class="btn btn-xs btn-primary" onclick="raOpenSkuAnalytics('${raEsc(r.sku)}','${raEsc(wh.id)}')">📊 Analytics</button>
                    <button class="btn btn-xs btn-secondary" style="margin-top:4px;" onclick="openSkuDetail('${raEsc(r.sku)}')">SKU →</button>
                  </td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>
      </div>

      <div style="margin-top:12px;">
        ${raFormulaBox([
          ["Node demand share", `this facility is modelled at ${Math.round(agg.node.share * 100)}% of total SKU movement (${agg.node.flow})`],
          ["Pre / post ledger", "closing = opening + receipts − shipments, reconciled weekly against the stock ledger"],
          ["Movement velocity", "28-day moving average of rolls shipped out of this node per day"],
          ["Dwell time", "rolls held ÷ 28-day outbound rate — how long the average roll sits in this building"],
          ["Node turns", "annualised outbound units ÷ average on-hand over 90 days"],
          ["Ageing", "walk the outbound series backwards until it consumes current on-hand (FIFO layer age)"],
          ["Sell-through", "units shipped in the week ÷ opening stock for that week"],
          ["Period deltas", "trailing window vs the matching window one period earlier, on units, revenue and gross profit"],
          ["Carrying cost", `idle capital × ${RA_CONST.HOLDING_RATE * 100}% annual holding rate`]
        ], "HOW THIS FACILITY'S NUMBERS ARE CALCULATED — CLASSICAL FORMULAS ONLY")}
      </div>

    </div>
  </div>`;
}

function raSetWhPeriod(key) {
  AppState.tableFilters.whAnalytics = Object.assign({}, AppState.tableFilters.whAnalytics, { period: key });
  renderCurrentView();
}

/* ==========================================================================
   PER-SKU INSPECTION DEEP DIVE MODAL
   ========================================================================== */

function raOpenSkuAnalytics(skuCode, whId) {
  const sku = (AppState.skus || []).find(s => s.sku === skuCode);
  if (!sku) return showToast("SKU not found", "error");
  const wh = whId ? (AppState.warehouses || []).find(w => w.id === whId) : null;

  const m = wh ? raNodeSkuMetrics(sku, wh) : raSkuMetrics(sku);
  const scope = wh ? wh.name : "All nodes (USA 3PL + FBA)";
  const periods = wh ? m.nodePeriods : m.periods;
  const outSeries = wh ? m.outSeries : m.units;

  const show = 260;
  const sma7 = raSMA(outSeries, 7).slice(-show);
  const sma28 = raSMA(outSeries, 28).slice(-show);
  const sma200 = raSMA(outSeries, 200).slice(-show);
  const labels = m.history.days.map(d => d.label).slice(-show);

  // Pre / post stock history: on-hand curve with the reorder point and safety line
  const onHandSeries = (wh ? m.days.map(d => d.onHand) : m.history.days.map(d => d.onHand)).slice(-show);
  const inboundSeries = (wh ? m.inSeries : m.history.days.map(d => d.inbound)).slice(-show);

  // Monthly profit bridge, last 12 months
  const monthly = raBucket(m.history.days, 30, 12, d => d.profit).map((b, i, arr) => ({
    label: b.label, shortLabel: b.shortLabel,
    profit: b.value,
    revenue: raSum(b.slice.map(d => d.revenue)),
    units: raSum(b.slice.map(d => d.units)),
    prev: i > 0 ? arr[i - 1].value : null
  }));

  const dowRows = m.dowIndex.map(d => ({
    label: d.name, value: d.index, display: d.index + "%", sub: d.avg + "/day",
    color: d.index >= 115 ? "var(--success)" : d.index <= 85 ? "var(--warning)" : "var(--text-muted)"
  }));

  const body = `
    <div style="font-size:12px;color:var(--text-main);">

      <!-- HEADER -->
      <div style="display:flex;gap:14px;align-items:flex-start;margin-bottom:14px;flex-wrap:wrap;">
        <img src="${raEsc(sku.imageUrl || "")}" alt="" style="width:76px;height:76px;border-radius:8px;object-fit:cover;border:1px solid var(--border-main);">
        <div style="flex:1;min-width:230px;">
          <strong style="font-size:15px;color:var(--text-main);">${raEsc(sku.title)}</strong>
          <div style="font-family:var(--font-mono);font-size:12px;color:var(--brand-cyan);margin-top:2px;">${raEsc(sku.sku)}</div>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;">
            ${raEsc(sku.size)} · ${raEsc(sku.collection)} · scope: <strong style="color:var(--text-main);">${raEsc(scope)}</strong>
          </div>
        </div>
        <div style="background:${m.action.bg};border-left:3px solid ${m.action.tone};border-radius:7px;padding:9px 12px;max-width:340px;">
          <strong style="color:${m.action.tone};font-size:12px;">${m.action.label}</strong>
          <div style="font-size:10.5px;color:var(--text-muted);line-height:1.45;margin-top:3px;">${raEsc(m.action.why)}</div>
          <div style="font-size:9px;color:var(--text-dim);margin-top:5px;font-family:var(--font-mono);">rule fired: ${raEsc(m.action.rule)}</div>
        </div>
      </div>

      <!-- KPIs -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(132px,1fr));gap:7px;margin-bottom:13px;">
        ${raKpi("7-day velocity", (wh ? m.out7 : m.sma7).toFixed(2) + "/day", `28d ${(wh ? m.out28 : m.sma28).toFixed(2)}`, "var(--brand-cyan)")}
        ${raKpi("200-day baseline", (wh ? m.out200 : m.sma200).toFixed(2) + "/day", raPct(wh ? m.nodeLongCross : m.longCross, 1) + " vs 7d",
          (wh ? m.nodeLongCross : m.longCross) >= 0 ? "var(--success)" : "var(--danger)")}
        ${raKpi("Stock position", (wh ? m.totalHere : m.onHand) + " rolls", `cover ${m.daysCover > 900 ? "∞" : Math.round(m.daysCover)}d`, "var(--text-main)")}
        ${raKpi("Dwell / ageing", wh ? (m.dwellDays > 900 ? "∞" : Math.round(m.dwellDays) + "d") : Math.round(m.daysOnHand) + "d", wh ? `aged ${m.ageBucket}` : `${m.turnover.toFixed(1)}× turns`, wh ? m.ageTone : "var(--info)")}
        ${raKpi("Gross profit — 90d", raMoney(wh ? m.nodeProfit90 : m.profit90), `${m.margin90.toFixed(1)}% margin`, "var(--success)")}
        ${raKpi("Profit per roll", raMoney(m.profitPerUnit), `unit cost ${raMoney(m.unitCost)}`, "var(--text-main)")}
        ${raKpi("Profit velocity", m.profitVelocity.toFixed(2) + "×", "per $ of stock per year", m.profitVelocity > 1 ? "var(--success)" : "var(--text-muted)")}
        ${raKpi("Stockout risk", m.stockoutProb + "%", `${m.stockoutDays90} dry days / 90d`, m.stockoutProb > 40 ? "var(--danger)" : "var(--success)")}
      </div>

      <!-- PERIOD SCORECARD -->
      <div style="font-size:12px;font-weight:800;margin-bottom:7px;">Sales & profit trend — WoW / MoM / QoQ / YoY</div>
      <div style="margin-bottom:13px;">${raPeriodScorecard(periods)}</div>

      <!-- DEMAND CHART -->
      ${raCard(`Daily movement vs 7 / 28 / 200-day moving averages — last ${show} days`,
        raLegend([
          { name: "Daily units", color: "#f59e0b" },
          { name: "7-day MA", color: "#6366f1" },
          { name: "28-day MA", color: "#06b6d4" },
          { name: "200-day MA", color: "#a855f7" }
        ]),
        raLineChart({
          id: 31, width: 880, height: 190, labels, xTicks: 9,
          series: [
            { name: "d", color: "#f59e0b", values: outSeries.slice(-show), type: "bar", opacity: 0.3 },
            { name: "200", color: "#a855f7", values: sma200, type: "line", width: 2.6 },
            { name: "28", color: "#06b6d4", values: sma28, type: "line", width: 2 },
            { name: "7", color: "#6366f1", values: sma7, type: "line", width: 1.8 }
          ]
        }) + `
        <div style="margin-top:8px;background:var(--bg-subtle);border-left:2px solid ${m.regimeTone};border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5;">
          <strong style="color:${m.regimeTone};">${m.regimeIcon} ${m.regime}</strong> — ${raEsc(m.regimeNote)}
        </div>`,
        "margin-bottom:10px;")}

      <!-- PRE / POST STOCK HISTORY -->
      ${raCard("Pre / post stock history — on-hand against policy lines",
        raLegend([
          { name: "Stock on hand", color: "#06b6d4" },
          { name: "Receipts in", color: "#10b981" },
          { name: "Reorder point", color: "var(--warning)", dash: true },
          { name: "Safety stock", color: "var(--danger)", dash: true }
        ]),
        raLineChart({
          id: 32, width: 880, height: 190, labels, xTicks: 9,
          refLines: [
            { value: m.reorderPoint, label: "Reorder point " + m.reorderPoint, color: "var(--warning)" },
            { value: m.safetyStock, label: "Safety stock " + m.safetyStock, color: "var(--danger)" }
          ],
          series: [
            { name: "in", color: "#10b981", values: inboundSeries, type: "bar", opacity: 0.55 },
            { name: "onhand", color: "#06b6d4", values: onHandSeries, type: "area", width: 2.2 }
          ]
        }) + `
        <div style="margin-top:8px;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5;">
          The sawtooth is the replenishment cycle: each green bar is a receipt landing, each downward slope is
          ${(wh ? m.out28 : m.sma28).toFixed(2)} rolls/day of demand eating it away. Stock dipped below the safety line on
          <strong style="color:var(--danger);">${m.history.days.slice(-show).filter(d => d.onHand < m.safetyStock).length} of the last ${show} days</strong>
          and hit zero on ${m.stockoutDays90} days in the last 90 — costing roughly
          <strong style="color:var(--danger);">${raMoney(m.lostProfit90)}</strong> of gross profit at ${raMoney(m.profitPerUnit)} per roll.
        </div>`,
        "margin-bottom:10px;")}

      <!-- MONTHLY PROFIT BRIDGE -->
      ${raCard("Gross profit by month — last 12 periods", "Revenue less landed COGS, channel fees and fulfilment", `
        <div class="table-responsive" style="max-height:260px;overflow-y:auto;">
          <table class="data-table" style="width:100%;font-size:11px;">
            <thead><tr>
              <th>Period</th><th style="text-align:right;">Units</th><th style="text-align:right;">Revenue</th>
              <th style="text-align:right;">Gross profit</th><th style="text-align:right;">Margin</th><th style="text-align:right;">vs prior</th>
            </tr></thead>
            <tbody>
              ${monthly.slice().reverse().map(b => {
                const marg = b.revenue > 0 ? (b.profit / b.revenue) * 100 : 0;
                const chg = b.prev !== null && b.prev > 0 ? ((b.profit - b.prev) / Math.abs(b.prev)) * 100 : null;
                return `<tr>
                  <td style="font-family:var(--font-mono);font-size:10.5px;">${raEsc(b.label)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${Math.round(b.units)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${raMoney(b.revenue)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${b.profit >= 0 ? "var(--success)" : "var(--danger)"};">${raMoney(b.profit)}</td>
                  <td style="text-align:right;font-family:var(--font-mono);">${marg.toFixed(1)}%</td>
                  <td style="text-align:right;">${chg === null ? "—" : raDelta(chg)}</td>
                </tr>`;
              }).join("")}
            </tbody>
          </table>
        </div>`, "margin-bottom:10px;")}

      <!-- SECONDARY PANELS -->
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:10px;margin-bottom:10px;">
        ${raCard("🗓️ Seasonality index", "100 = average day", raRankBars(m.seasonIndex.map(s => ({
          label: s.name, value: s.index, display: s.index + "%",
          sub: s.index >= 115 ? "peak" : s.index <= 85 ? "trough" : "",
          color: s.index >= 115 ? "var(--success)" : s.index <= 85 ? "var(--warning)" : "var(--text-muted)"
        }))))}
        ${raCard("📅 Day-of-week pattern", "Drives pick-staffing, not buying", raRankBars(dowRows))}
        ${raCard("🧮 Replenishment maths", "Every input shown", `
          <div style="display:flex;flex-direction:column;gap:5px;font-size:11px;">
            ${[
              ["Lead time", m.leadTime + " days"],
              ["σ daily demand", m.sigmaDaily.toFixed(2) + " rolls"],
              ["σ over lead time", m.sigmaLT.toFixed(2) + " rolls"],
              ["Safety stock", `${RA_CONST.Z_SCORE} × ${m.sigmaDaily.toFixed(2)} × √${m.leadTime} = ${m.safetyStock}`],
              ["Demand over lead time", `${m.sma28.toFixed(2)} × ${m.leadTime} = ${Math.round(m.demandOverLT)}`],
              ["Reorder point", `${Math.round(m.demandOverLT)} + ${m.safetyStock} = ${m.reorderPoint}`],
              ["Target stock", Math.round(m.targetStock) + " rolls"],
              ["Suggested order", `${m.suggestedQty} rolls (${raMoney(m.suggestedQty * m.unitCost)})`],
              ["EOQ", m.eoq + " rolls"],
              ["Order by", raFmtFullDate(m.orderByDate)]
            ].map(r => `<div style="display:flex;justify-content:space-between;gap:8px;border-bottom:1px solid var(--border-subtle);padding-bottom:3px;">
              <span style="color:var(--text-muted);">${raEsc(r[0])}</span>
              <span style="font-family:var(--font-mono);font-weight:700;text-align:right;">${raEsc(r[1])}</span></div>`).join("")}
          </div>`)}
      </div>

      <div style="display:flex;gap:7px;flex-wrap:wrap;margin-bottom:10px;">
        <button class="btn btn-sm btn-primary" onclick="${m.action.fn}">${m.action.cta}</button>
        <button class="btn btn-sm btn-secondary" onclick="raExportSkuCsv('${raEsc(sku.sku)}')">📥 Export daily history CSV</button>
        <button class="btn btn-sm btn-secondary" onclick="openSkuDetail('${raEsc(sku.sku)}');closeModal('crudModal');">Open full SKU master →</button>
      </div>

      ${raFormulaBox(RA_FORMULAS.slice(0, 10))}
    </div>`;

  openModal(`📊 SKU Analytics — ${sku.sku}`, body, "Deterministic · No ML");
}

window.raWarehouseTabButton = raWarehouseTabButton;
window.raWarehouseAnalyticsTab = raWarehouseAnalyticsTab;
window.raSetWhPeriod = raSetWhPeriod;
window.raOpenSkuAnalytics = raOpenSkuAnalytics;
