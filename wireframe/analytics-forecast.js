// ############################################################################
// ##  MODULE 8 — DEMAND & REPLENISHMENT PLANNING WORKBENCH
// ##  Action-first layout: the planner sees WHAT TO DO before the data.
// ##  Loaded after app.js so this definition supersedes the original stub.
// ############################################################################

function raForecastFilters() {
  const t = AppState.tableFilters;
  t.forecasting = Object.assign({
    search: "", collection: "all", actionFilter: "all", abc: "all",
    period: "qoq", sortBy: "priority", sortDir: "asc", page: 1, pageSize: 8
  }, t.forecasting || {});
  return t.forecasting;
}

function raSetForecastSort(key) {
  const f = raForecastFilters();
  if (f.sortBy === key) f.sortDir = f.sortDir === "asc" ? "desc" : "asc";
  else { f.sortBy = key; f.sortDir = key === "priority" ? "asc" : "desc"; }
  f.page = 1;
  renderCurrentView();
}

function raSetActionFilter(code) {
  const f = raForecastFilters();
  f.actionFilter = code;
  f.page = 1;
  renderCurrentView();
}

function raSetPeriod(key) {
  raForecastFilters().period = key;
  renderCurrentView();
}

function renderForecastingView() {
  const f = raForecastFilters();
  const horizon = AppState.forecastHorizon || 60;
  const all = raPortfolio();
  const sum = raPortfolioSummary(all);
  const pKey = f.period;

  // ---- Filtering ---------------------------------------------------------
  let rows = all.filter(m => {
    const q = (f.search || "").toLowerCase();
    const okSearch = !q || m.sku.toLowerCase().includes(q) || (m.title || "").toLowerCase().includes(q);
    const okAction = f.actionFilter === "all" || m.action.code === f.actionFilter;
    const okColl = f.collection === "all" || (m.collection || "") === f.collection;
    const okAbc = f.abc === "all" || m.abc === f.abc;
    return okSearch && okAction && okColl && okAbc;
  });

  const sortKeys = {
    priority: m => m.action.priority * 1000 + m.daysCover,
    cover: m => m.daysCover,
    velocity: m => m.sma7,
    trend: m => m.longCross,
    period: m => m.periods[pKey].profit.pct,
    risk: m => m.stockoutProb,
    profit: m => m.profit90,
    qty: m => m.suggestedQty
  };
  const kf = sortKeys[f.sortBy] || sortKeys.priority;
  rows.sort((a, b) => (f.sortDir === "asc" ? 1 : -1) * (kf(a) - kf(b)));

  const pg = paginateArray(rows, f.page, f.pageSize);

  // ---- Portfolio demand series -------------------------------------------
  const portDaily = sum.series.units;
  const portLabels = all[0] ? all[0].history.days.map(d => d.label) : [];
  const sma7Full = raSMA(portDaily, 7);
  const sma28Full = raSMA(portDaily, 28);
  const sma200Full = raSMA(portDaily, 200);

  const show = AppState.forecastWindow || 260;
  const dailySlice = portDaily.slice(-show);
  const sma7Slice = sma7Full.slice(-show);
  const sma28Slice = sma28Full.slice(-show);
  const sma200Slice = sma200Full.slice(-show);
  const labelSlice = portLabels.slice(-show);

  const last200 = sma200Full[sma200Full.length - 1] || 0;
  const last7 = sma7Full[sma7Full.length - 1] || 0;
  const last28 = sma28Full[sma28Full.length - 1] || 0;
  const longCross = last200 > 0 ? ((last7 - last200) / last200) * 100 : 0;
  const midCross = last200 > 0 ? ((last28 - last200) / last200) * 100 : 0;

  let regimeLabel, regimeTone, regimeCopy;
  if (longCross > 12 && midCross > 3) {
    regimeLabel = "Structural uptrend"; regimeTone = "var(--success)";
    regimeCopy = "Both the 7-day and 28-day lines sit above the 200-day baseline. This is a genuine step change in demand, not a weekend spike — raise the baseline you buy against and pull the next container forward.";
  } else if (longCross < -12 && midCross < -3) {
    regimeLabel = "Structural downtrend"; regimeTone = "var(--danger)";
    regimeCopy = "Both the 7-day and 28-day lines have fallen through the 200-day baseline. Cut order quantities rather than just delaying them, and work the excess down before it ages past 120 days of cover.";
  } else if (Math.abs(longCross) > 12) {
    regimeLabel = longCross > 0 ? "Unconfirmed spike" : "Unconfirmed dip"; regimeTone = "var(--warning)";
    regimeCopy = "The 7-day line has moved sharply against the 200-day baseline but the 28-day line has not confirmed it yet. Hold the current buying plan for one more review cycle before reacting.";
  } else {
    regimeLabel = "Tracking baseline"; regimeTone = "var(--text-muted)";
    regimeCopy = "Short-term demand is tracking the 200-day baseline within ±12%. Existing cover assumptions and order quantities still hold.";
  }

  // ---- Cover projection over the horizon ---------------------------------
  const projOnHand = [], projWithPo = [], projLabels = [];
  const dailyRun = sum.dailyDemand28 || 1;
  let stock = sum.unitsOnHand, stockPo = sum.unitsOnHand;
  const inboundAt = Math.min(horizon - 1, RA_CONST.LEAD_TIME_OCEAN);
  for (let d = 0; d <= horizon; d++) {
    projOnHand.push(Math.max(0, stock));
    if (d === inboundAt) stockPo += sum.unitsInTransit + sum.suggestedUnits;
    projWithPo.push(Math.max(0, stockPo));
    projLabels.push(raFmtDate(raDayKey(d)));
    stock -= dailyRun; stockPo -= dailyRun;
  }
  const portSafety = all.reduce((t, m) => t + m.safetyStock, 0);
  const portRop = all.reduce((t, m) => t + m.reorderPoint, 0);

  // ---- Leaderboards -------------------------------------------------------
  const movers = [...all].sort((a, b) => b.sma7 - a.sma7).slice(0, 6).map(m => ({
    label: m.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
    sub: `${m.regimeIcon} ${raPct(m.longCross, 0)} vs 200d`,
    value: m.sma7, display: m.sma7.toFixed(1) + "/d",
    color: m.longCross > 12 ? "var(--success)" : m.longCross < -12 ? "var(--danger)" : "var(--brand-cyan)"
  }));

  const decliners = raDecliners(all, pKey).slice(0, 6).map(m => ({
    label: m.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
    sub: `${raMoney(m.periods[pKey].profit.delta)} profit`,
    value: Math.abs(m.periods[pKey].profit.pct),
    display: raPct(m.periods[pKey].profit.pct, 0),
    color: "var(--danger)"
  }));

  const profitLeaders = [...all].sort((a, b) => b.profitVelocity - a.profitVelocity).slice(0, 6).map(m => ({
    label: m.sku.replace("SKU-RUG-", "").replace("SKU-", ""),
    sub: `${raMoney(m.profit90)} / 90d`,
    value: m.profitVelocity,
    display: m.profitVelocity.toFixed(2) + "×",
    color: m.profitVelocity > 1 ? "var(--success)" : "var(--text-muted)"
  }));

  const seasonAgg = {};
  all.forEach(m => m.seasonIndex.forEach(s => {
    seasonAgg[s.name] = seasonAgg[s.name] || [];
    seasonAgg[s.name].push(s.index);
  }));
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const seasonRows = MONTHS.filter(mn => seasonAgg[mn]).map(mn => {
    const v = raMean(seasonAgg[mn]);
    return {
      label: mn, value: v, display: Math.round(v) + "%",
      sub: v >= 115 ? "peak" : v <= 85 ? "trough" : "",
      color: v >= 115 ? "var(--success)" : v <= 85 ? "var(--warning)" : "var(--text-muted)"
    };
  });

  const actionChips = [
    { code: "all", icon: "📋", label: "Every SKU", n: all.length, tone: "var(--text-muted)" },
    { code: "EXPEDITE", icon: "✈️", label: "Expedite now", n: sum.expedite, tone: "var(--danger)" },
    { code: "ORDER", icon: "📦", label: "Raise PO today", n: sum.order, tone: "var(--warning)" },
    { code: "SCHEDULE", icon: "🗓️", label: "Schedule on buy sheet", n: sum.schedule, tone: "var(--info)" },
    { code: "REDUCE", icon: "📉", label: "Stop buying / clear excess", n: sum.reduce, tone: "var(--brand-purple)" },
    { code: "DEAD", icon: "🪦", label: "No movement", n: sum.dead, tone: "var(--text-dim)" },
    { code: "HOLD", icon: "✅", label: "Healthy, leave alone", n: sum.healthy, tone: "var(--success)" }
  ];

  const th = (key, label, hint) => `<th style="cursor:pointer;white-space:nowrap;" onclick="raSetForecastSort('${key}')" title="${raEsc(hint || "")}">
      ${label} <span style="opacity:${f.sortBy === key ? 1 : 0.25};font-size:9px;">${f.sortBy === key && f.sortDir === "desc" ? "▼" : "▲"}</span></th>`;

  const periodTabs = RA_PERIODS.map(p => `<button class="btn btn-xs ${pKey === p.key ? "btn-primary" : "btn-ghost"}" onclick="raSetPeriod('${p.key}')" title="${raEsc(p.name)}">${p.label}</button>`).join("");

  return `
    <div class="page-header">
      <div class="page-title-wrap">
        <h1 style="margin:0;font-size:20px;">📈 Demand & Replenishment Planning Workbench</h1>
        <p style="margin:4px 0 0 0;font-size:12px;color:var(--text-muted);">
          7-day, 28-day and 200-day moving averages, demand variability, statistical safety stock, reorder points, EOQ and
          week/month/quarter/year profit comparisons — every figure from a classical supply-chain or accounting formula.
          No machine-learning model is involved anywhere on this screen.
        </p>
      </div>
      <div class="page-actions" style="display:flex;gap:8px;">
        <button class="btn btn-sm btn-secondary" onclick="raExportPlanningCsv()">📥 Export planning sheet</button>
        <button class="btn btn-sm btn-secondary" onclick="raOpenMethodologyModal()">📐 Methodology</button>
        <button class="btn btn-sm btn-primary" onclick="raOpenBuySheetModal()">🧾 Build buy sheet (${sum.expedite + sum.order})</button>
      </div>
    </div>

    <!-- ============ 1. DECISION QUEUE ============ -->
    <div class="card" style="padding:12px 14px;margin-bottom:12px;border-left:3px solid var(--brand-cyan);">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;flex-wrap:wrap;gap:8px;">
        <strong style="font-size:13px;">🧭 Decision queue — ${sum.expedite + sum.order} SKUs need a purchasing decision today</strong>
        <span style="font-size:10.5px;color:var(--text-dim);">Click a bucket to filter the table below. Buckets come from the rule table, not a model.</span>
      </div>
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(138px,1fr));gap:7px;">
        ${actionChips.map(c => `
          <button onclick="raSetActionFilter('${c.code}')" style="
            text-align:left;cursor:pointer;background:${f.actionFilter === c.code ? "var(--bg-elevated)" : "var(--bg-subtle)"};
            border:1px solid ${f.actionFilter === c.code ? c.tone : "var(--border-subtle)"};border-radius:7px;padding:8px 10px;
            display:flex;flex-direction:column;gap:2px;transition:all .15s;">
            <span style="font-size:18px;font-weight:800;font-family:var(--font-mono);color:${c.tone};line-height:1;">${c.icon} ${c.n}</span>
            <span style="font-size:10px;color:var(--text-muted);font-weight:600;line-height:1.25;">${c.label}</span>
          </button>`).join("")}
      </div>
    </div>

    <!-- ============ 2. PORTFOLIO KPIs ============ -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(142px,1fr));gap:8px;margin-bottom:12px;">
      ${raKpi("Demand — 7d avg", sum.dailyDemand.toFixed(1) + " /day",
        `${raPct(longCross, 1)} vs 200d baseline`,
        longCross >= 0 ? "var(--success)" : "var(--danger)",
        "Sum of each SKU's 7-day simple moving average, compared against the 200-day structural baseline.")}
      ${raKpi("200-day baseline", last200.toFixed(1) + " /day", `28d line ${raPct(midCross, 1)}`, "var(--text-main)",
        "The 200-day moving average. Slow enough that no single week can move it — this is the number to buy against.")}
      ${raKpi("Units on hand", sum.unitsOnHand.toLocaleString(), `+ ${sum.unitsInTransit} in transit`, "var(--brand-cyan)",
        "USA 3PL available plus Amazon FBA, across every SKU.")}
      ${raKpi("Portfolio cover", (sum.unitsOnHand / (sum.dailyDemand28 || 1)).toFixed(0) + " days",
        `Policy ceiling ${RA_CONST.MAX_COVER_TARGET}d`, "var(--text-main)",
        "On-hand units ÷ 28-day average daily demand.")}
      ${raKpi("Suggested buy", sum.suggestedUnits.toLocaleString() + " rolls",
        `≈ ${raMoney(sum.suggestedSpend)} landed`, "var(--warning)",
        "Sum of order quantities for SKUs at or below their reorder point.")}
      ${raKpi("Gross profit — 90d", raMoney(sum.profit90), `${sum.margin90.toFixed(1)}% margin`, "var(--success)",
        "Revenue less landed COGS, channel referral fees and 3PL fulfilment, over the last 90 days.")}
      ${raKpi("Idle capital", raMoney(sum.excessCapital), `of ${raMoney(sum.capital)} total`, "var(--brand-purple)",
        "Value of stock above the 120-day cover policy ceiling.")}
      ${raKpi("Profit lost to stockouts", raMoney(sum.lostProfit90),
        `${sum.avgFillRate.toFixed(1)}% fill rate`, "var(--danger)",
        "Stockout days × average daily demand × profit per unit, over 90 days.")}
    </div>

    <!-- ============ 3. PERIOD SCORECARD ============ -->
    <div class="card" style="padding:12px 14px;margin-bottom:12px;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:9px;flex-wrap:wrap;gap:8px;">
        <div>
          <strong style="font-size:13px;">📊 Sales & profit trend — week, month, quarter and year on year</strong>
          <div style="font-size:10.5px;color:var(--text-dim);margin-top:2px;">
            Each card compares the trailing window against the matching window one period earlier.
            YoY deliberately compares the same 91-day season a year apart, so seasonality cannot distort it.
          </div>
        </div>
      </div>
      ${raPeriodScorecard(sum.periods)}
      <div style="margin-top:9px;display:grid;grid-template-columns:1fr 1fr;gap:10px;">
        <div style="background:var(--bg-subtle);border-radius:7px;padding:9px 11px;">
          <div style="font-size:9.5px;font-weight:800;color:var(--text-dim);margin-bottom:5px;">PROFIT MOMENTUM ACROSS PERIODS</div>
          ${raDivergingBars({
            width: 560, height: 150,
            items: RA_PERIODS.map(p => ({
              label: p.label,
              sub: raMoney(sum.periods[p.key].profit.current),
              value: sum.periods[p.key].profit.pct,
              color: sum.periods[p.key].verdict.tone
            }))
          })}
        </div>
        <div style="background:var(--bg-subtle);border-radius:7px;padding:9px 11px;">
          <div style="font-size:9.5px;font-weight:800;color:var(--text-dim);margin-bottom:5px;">WHAT THE SPREAD TELLS YOU</div>
          <div style="font-size:11px;color:var(--text-main);line-height:1.5;">
            ${(() => {
              const w = sum.periods.wow.profit.pct, q = sum.periods.qoq.profit.pct, y = sum.periods.yoy.profit.pct;
              if (y > 5 && q < -5) return "The year is up but the quarter is down — the business is bigger than last year yet losing momentum right now. Treat this as a demand problem to fix, not a capacity problem to fund: check listing health, buy-box share and competitor pricing before cutting purchase orders.";
              if (y < -5 && q > 5) return "The quarter is recovering off a weaker year. The recovery is real but not yet proven across a full season — replenish to the 28-day average rather than the 7-day, so you do not over-buy into a bounce.";
              if (y < -5 && q < -5) return "Both the year and the quarter are down. This is structural decline, not seasonality. Cut order quantities, clear ageing stock at the best price you can get now rather than later, and review which SKUs deserve to stay in the range at all.";
              if (y > 5 && q > 5) return "Year and quarter are both up. Growth is confirmed across two independent windows, so it is safe to raise the buying baseline. Make sure safety stock rises with it, otherwise service level will slip exactly when volume is highest.";
              return "Growth is broadly flat across every window. Hold the current buying plan and spend the review cycle on the SKU-level decliners below rather than on portfolio-wide changes.";
            })()}
          </div>
          <div style="margin-top:8px;padding-top:7px;border-top:1px solid var(--border-subtle);font-size:10px;color:var(--text-muted);line-height:1.45;">
            <strong style="color:var(--text-main);">Margin check —</strong>
            gross margin moved ${sum.periods[pKey].marginDeltaPts >= 0 ? "up" : "down"}
            <strong style="color:${sum.periods[pKey].marginDeltaPts >= 0 ? "var(--success)" : "var(--danger)"};">${Math.abs(sum.periods[pKey].marginDeltaPts).toFixed(1)} points</strong>
            ${pKey.toUpperCase()}, from ${sum.periods[pKey].marginPrev.toFixed(1)}% to ${sum.periods[pKey].marginNow.toFixed(1)}%.
            ${Math.abs(sum.periods[pKey].marginDeltaPts) > 2
              ? "A move this size is usually discounting or freight, not mix — check promotion depth and the courier invoice audit before adjusting prices."
              : "Margin is stable, so any change in profit is coming from volume rather than pricing."}
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 4. MOVING AVERAGES + PROJECTION ============ -->
    <div style="display:grid;grid-template-columns:1.3fr 1fr;gap:10px;margin-bottom:10px;">

      ${raCard(
        `Daily demand vs moving averages — last ${show} days`,
        raLegend([
          { name: "Actual daily units", color: "#f59e0b" },
          { name: "7-day MA (signal)", color: "#6366f1" },
          { name: "28-day MA (buying baseline)", color: "#06b6d4" },
          { name: "200-day MA (structural)", color: "#a855f7" }
        ]),
        raLineChart({
          id: 1, width: 660, height: 192, labels: labelSlice, xTicks: 9,
          series: [
            { name: "daily", color: "#f59e0b", values: dailySlice, type: "bar", opacity: 0.30 },
            { name: "sma200", color: "#a855f7", values: sma200Slice, type: "line", width: 2.6 },
            { name: "sma28", color: "#06b6d4", values: sma28Slice, type: "line", width: 2 },
            { name: "sma7", color: "#6366f1", values: sma7Slice, type: "line", width: 1.8 }
          ]
        }) + `
        <div style="display:flex;gap:8px;margin-top:8px;flex-wrap:wrap;">
          <div style="flex:1.2;min-width:190px;background:${regimeTone === "var(--text-muted)" ? "var(--bg-subtle)" : "rgba(255,255,255,0.03)"};border-left:2px solid ${regimeTone};border-radius:6px;padding:8px 10px;">
            <div style="font-size:9.5px;color:var(--text-dim);font-weight:800;">SIGNAL READING — <span style="color:${regimeTone};">${regimeLabel.toUpperCase()}</span></div>
            <div style="font-size:11px;color:var(--text-main);line-height:1.45;margin-top:3px;">${regimeCopy}</div>
          </div>
          <div style="flex:1;min-width:170px;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;">
            <div style="font-size:9.5px;color:var(--text-dim);font-weight:800;">WHY THREE AVERAGES</div>
            <div style="font-size:10.5px;color:var(--text-muted);line-height:1.45;margin-top:3px;">
              <strong style="color:#6366f1;">7-day</strong> is the early warning — it reacts fast but also reacts to noise.
              <strong style="color:#06b6d4;">28-day</strong> is what you actually buy against: it absorbs weekend spikes and one-off B2B lots.
              <strong style="color:#a855f7;">200-day</strong> is the structural baseline — nothing short of a real change in the business moves it,
              so a 7-day crossing of the 200-day line is the signal that the SKU has changed regime.
            </div>
          </div>
        </div>`
      )}

      ${raCard(
        `Projected stock position — next ${horizon} days`,
        raLegend([
          { name: "If you do nothing", color: "#ef4444" },
          { name: "With in-transit + suggested PO", color: "#10b981", dash: true }
        ]),
        raLineChart({
          id: 2, width: 470, height: 192, labels: projLabels, xTicks: 6,
          refLines: [
            { value: portRop, label: "Reorder point", color: "var(--warning)" },
            { value: portSafety, label: "Safety stock", color: "var(--danger)" }
          ],
          markers: [{ index: inboundAt, label: "PO lands", color: "var(--success)" }],
          series: [
            { name: "no action", color: "#ef4444", values: projOnHand, type: "area", width: 2.2 },
            { name: "with po", color: "#10b981", values: projWithPo, type: "dashed", width: 2 }
          ]
        }) + `
        <div style="margin-top:8px;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;font-size:11px;line-height:1.5;color:var(--text-main);">
          Burning <strong>${dailyRun.toFixed(1)} rolls/day</strong>, portfolio stock touches the safety line around
          <strong style="color:var(--danger);">day ${Math.max(0, Math.round((sum.unitsOnHand - portSafety) / dailyRun))}</strong>.
          With a ${RA_CONST.LEAD_TIME_OCEAN}-day ocean lead time, the PO has to leave within
          <strong style="color:var(--warning);">${Math.max(0, Math.round((sum.unitsOnHand - portSafety) / dailyRun) - RA_CONST.LEAD_TIME_OCEAN)} days</strong> to land before that.
        </div>`
      )}
    </div>

    <!-- ============ 5. LEADERBOARDS ============ -->
    <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(255px,1fr));gap:10px;margin-bottom:10px;">
      ${raCard("🏃 Fastest movers — 7-day velocity", "Rolls sold per day", raRankBars(movers))}
      ${raCard(`📉 Profit declining — ${pKey.toUpperCase()}`, `${raDecliners(all, pKey).length} SKUs falling`,
        decliners.length ? raRankBars(decliners) + `
        <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
          Ranked by gross-profit decline, not unit decline — a SKU can sell more rolls and still earn less once
          discounting and freight are taken out. Click through to a SKU to see which of the two is happening.
        </div>` :
        `<div style="font-size:11px;color:var(--text-muted);padding:14px 0;text-align:center;">No SKU is down more than 5% on gross profit ${pKey.toUpperCase()}.</div>`)}
      ${raCard("💰 Profit per dollar of stock", "Annualised gross profit ÷ capital tied up", raRankBars(profitLeaders) + `
        <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
          The ranking that decides where the next container's cube should go. A 2.0× SKU returns two dollars of
          gross profit a year for every dollar of stock it holds.
        </div>`)}
      ${raCard("🗓️ Seasonality index", "100 = average day of the year", raRankBars(seasonRows) + `
        <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
          Each calendar month's average daily sales ÷ the all-period average, over ${Math.round(RA_CONST.HISTORY_DAYS / 365 * 10) / 10} years.
          Order for months above 115 one full lead time (${RA_CONST.LEAD_TIME_OCEAN} days) ahead.
        </div>`)}
      ${raCard("🎯 ABC × XYZ policy matrix", "Value ranking × demand stability", raAbcXyzMatrix(all) + `
        <div style="margin-top:7px;font-size:10px;color:var(--text-muted);line-height:1.45;">
          ABC from 90-day revenue share (Pareto 80/95). XYZ from the coefficient of variation (σ ÷ mean) of daily
          demand. The cell tells you which stocking policy to run.
        </div>`)}
    </div>

    <!-- ============ 6. CONTROLS ============ -->
    <div class="card" style="margin-bottom:10px;padding:10px 13px;">
      <div style="display:flex;justify-content:space-between;align-items:center;gap:12px;flex-wrap:wrap;">
        <div style="display:flex;gap:8px;flex:1;min-width:280px;flex-wrap:wrap;">
          <input type="text" class="form-control" style="max-width:240px;" placeholder="Search SKU or rug design..."
            value="${raEsc(f.search)}" oninput="setTableFilter('forecasting','search',this.value)">
          <select class="form-control" style="max-width:160px;" onchange="setTableFilter('forecasting','collection',this.value)">
            <option value="all">All collections</option>
            ${[...new Set((AppState.skus || []).map(s => s.collection))].map(c =>
              `<option value="${raEsc(c)}" ${f.collection === c ? "selected" : ""}>${raEsc(c)}</option>`).join("")}
          </select>
          <select class="form-control" style="max-width:150px;" onchange="setTableFilter('forecasting','abc',this.value)">
            <option value="all" ${f.abc === "all" ? "selected" : ""}>All ABC classes</option>
            <option value="A" ${f.abc === "A" ? "selected" : ""}>A — top 80% revenue</option>
            <option value="B" ${f.abc === "B" ? "selected" : ""}>B — next 15%</option>
            <option value="C" ${f.abc === "C" ? "selected" : ""}>C — tail 5%</option>
          </select>
        </div>
        <div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap;">
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:800;color:var(--text-dim);text-transform:uppercase;">Compare</span>
            <div style="display:flex;background:var(--bg-subtle);padding:2px;border-radius:6px;border:1px solid var(--border-subtle);gap:2px;">${periodTabs}</div>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span style="font-size:10px;font-weight:800;color:var(--text-dim);text-transform:uppercase;">Horizon</span>
            <div style="display:flex;background:var(--bg-subtle);padding:2px;border-radius:6px;border:1px solid var(--border-subtle);gap:2px;">
              ${[30, 60, 90, 120].map(d => `<button class="btn btn-xs ${horizon === d ? "btn-primary" : "btn-ghost"}" onclick="setForecastHorizon(${d})">${d}D</button>`).join("")}
            </div>
          </div>
        </div>
      </div>
    </div>

    <!-- ============ 7. PLANNING TABLE ============ -->
    <div class="card" style="padding:0;overflow:hidden;margin-bottom:10px;">
      <div class="table-responsive">
        <table class="data-table" style="width:100%;font-size:11.5px;">
          <thead>
            <tr>
              <th style="min-width:182px;">SKU / class</th>
              <th style="min-width:92px;">90-day shape</th>
              ${th("velocity", "Velocity", "7-day and 28-day simple moving averages of daily units sold")}
              ${th("trend", "7d vs 200d", "Short-term average against the 200-day structural baseline")}
              ${th("period", pKey.toUpperCase() + " profit", "Gross profit this period against the matching period earlier")}
              <th title="Coefficient of variation = standard deviation ÷ mean of daily demand">Variability</th>
              <th>Stock position</th>
              ${th("cover", "Cover", "On-hand ÷ 28-day average daily demand")}
              <th title="Safety stock = 1.65 × σ_daily × √lead time (95% service level)">Safety / ROP</th>
              ${th("risk", "Stockout risk", "Probability demand over the lead time exceeds current stock")}
              ${th("qty", "Order qty", "Target stock for lead time + review period, less on-hand and in-transit")}
              <th style="min-width:245px;">Recommended next step</th>
            </tr>
          </thead>
          <tbody>
            ${pg.items.length === 0 ? `<tr><td colspan="12" style="text-align:center;padding:28px;color:var(--text-dim);">No SKUs match these filters.</td></tr>` :
              pg.items.map(m => {
                const p = m.periods[pKey];
                const coverColor = m.daysCover < m.leadTime * 0.35 ? "var(--danger)" :
                  m.onHand <= m.reorderPoint ? "var(--warning)" :
                  m.daysCover > RA_CONST.MAX_COVER_TARGET ? "var(--brand-purple)" : "var(--success)";
                return `
              <tr>
                <td>
                  <strong style="color:var(--brand-cyan);font-family:var(--font-mono);font-size:12px;">${raEsc(m.sku)}</strong>
                  <div style="font-size:10px;color:var(--text-muted);max-width:175px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${raEsc(m.title)}</div>
                  <div style="margin-top:3px;display:flex;gap:4px;align-items:center;">
                    <span style="font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;background:var(--bg-subtle);color:${m.abc === "A" ? "var(--success)" : m.abc === "B" ? "var(--info)" : "var(--text-dim)"};">${m.abcxyz}</span>
                    <span style="font-size:9px;color:var(--text-dim);">${m.revenueSharePct.toFixed(1)}% of revenue</span>
                  </div>
                </td>
                <td>${raSparkline(m.units.slice(-90), m.longCross > 12 ? "#10b981" : m.longCross < -12 ? "#ef4444" : "#06b6d4", 84, 24)}
                  <div style="font-size:9px;color:var(--text-dim);margin-top:1px;">${m.sold90} sold / 90d</div></td>
                <td>
                  <strong style="font-family:var(--font-mono);font-size:12.5px;">${m.sma7.toFixed(1)}</strong><span style="font-size:9px;color:var(--text-dim);">/day (7d)</span>
                  <div style="font-size:9.5px;color:var(--text-muted);">28d ${m.sma28.toFixed(1)} · 200d ${m.sma200.toFixed(1)}</div>
                  <div style="font-size:9px;color:var(--text-dim);">${Math.round(m.weeklyRate)}/wk · ${Math.round(m.monthlyRate)}/mo</div>
                </td>
                <td>
                  <strong style="color:${m.regimeTone};font-size:11.5px;white-space:nowrap;">${m.regimeIcon} ${m.regime}</strong>
                  <div style="font-size:9.5px;color:var(--text-dim);font-family:var(--font-mono);">${raPct(m.longCross, 0)} vs 200d</div>
                  <div style="font-size:9px;color:var(--text-dim);">28d line ${raPct(m.midLongCross, 0)}</div>
                </td>
                <td>
                  <strong style="color:${p.verdict.tone};font-family:var(--font-mono);font-size:12.5px;">${raPct(p.profit.pct, 0)}</strong>
                  <div style="font-size:9.5px;color:var(--text-dim);">${raMoney(p.profit.current)} vs ${raMoney(p.profit.previous)}</div>
                  <div style="font-size:9px;color:var(--text-dim);">units ${raPct(p.units.pct, 0)} · margin ${p.marginDeltaPts >= 0 ? "+" : ""}${p.marginDeltaPts.toFixed(1)}pts</div>
                </td>
                <td>
                  <strong style="font-family:var(--font-mono);">CV ${m.cv.toFixed(2)}</strong>
                  <div style="font-size:9.5px;color:var(--text-dim);">${m.xyz} — ${m.xyzLabel}</div>
                  <div style="font-size:9px;color:var(--text-dim);">confidence ${m.forecastConfidence}%</div>
                </td>
                <td>
                  <strong style="font-family:var(--font-mono);font-size:12.5px;">${m.onHand}</strong><span style="font-size:9px;color:var(--text-dim);"> on hand</span>
                  <div style="font-size:9.5px;color:var(--text-dim);">${m.reserved} reserved · ${m.inTransit} in transit</div>
                  <div style="margin-top:3px;">${raStackBar([
                    { label: "Available", value: m.available, color: "#10b981" },
                    { label: "Reserved", value: m.reserved, color: "#f59e0b" },
                    { label: "In transit", value: m.inTransit, color: "#6366f1" }
                  ], 6)}</div>
                </td>
                <td>
                  <strong style="color:${coverColor};font-family:var(--font-mono);font-size:13px;">${m.daysCover > 900 ? "∞" : m.daysCover.toFixed(0)}d</strong>
                  <div style="font-size:9.5px;color:var(--text-dim);">runs out ${m.daysCover > 900 ? "—" : raFmtDate(m.runOut)}</div>
                  <div style="font-size:9px;color:var(--text-dim);">${m.daysCoverPipeline > 900 ? "∞" : m.daysCoverPipeline.toFixed(0)}d incl. transit</div>
                </td>
                <td>
                  <span style="font-family:var(--font-mono);font-size:11.5px;color:var(--danger);">SS ${m.safetyStock}</span>
                  <div style="font-family:var(--font-mono);font-size:11.5px;color:var(--warning);">ROP ${m.reorderPoint}</div>
                  <div style="font-size:9px;color:var(--text-dim);">σ ${m.sigmaDaily.toFixed(2)}/day</div>
                </td>
                <td>
                  <div style="display:flex;align-items:center;gap:6px;">
                    ${raGauge(m.stockoutProb, m.stockoutProb > 50 ? "var(--danger)" : m.stockoutProb > 20 ? "var(--warning)" : "var(--success)", "% risk", 44)}
                    <div style="font-size:9px;color:var(--text-dim);line-height:1.3;">over the<br>${m.leadTime}-day<br>lead time</div>
                  </div>
                </td>
                <td>
                  <strong style="color:var(--brand-cyan);font-family:var(--font-mono);font-size:13px;">${m.suggestedQty}</strong>
                  <div style="font-size:9px;color:var(--text-dim);">EOQ ${m.eoq} · ${raMoney(m.suggestedQty * m.unitCost)}</div>
                  <div style="font-size:9px;color:var(--text-dim);">order by ${raFmtDate(m.orderByDate)}</div>
                </td>
                <td>
                  <div style="background:${m.action.bg};border-left:2px solid ${m.action.tone};border-radius:5px;padding:6px 8px;">
                    <strong style="color:${m.action.tone};font-size:11px;">${m.action.label}</strong>
                    <div style="font-size:9.5px;color:var(--text-muted);line-height:1.45;margin-top:2px;">${raEsc(m.action.why)}</div>
                    <div style="display:flex;gap:5px;margin-top:6px;flex-wrap:wrap;">
                      <button class="btn btn-xs btn-primary" style="font-size:10px;" onclick="${m.action.fn}">${m.action.cta}</button>
                      <button class="btn btn-xs btn-secondary" style="font-size:10px;" onclick="raOpenSkuAnalytics('${m.sku}')">📊 Deep dive</button>
                    </div>
                  </div>
                </td>
              </tr>`;
              }).join("")}
          </tbody>
        </table>
      </div>
      <div style="padding:9px 15px;border-top:1px solid var(--border-subtle);display:flex;justify-content:space-between;align-items:center;">
        <span style="font-size:11.5px;color:var(--text-muted);">
          Showing ${pg.total === 0 ? 0 : pg.start}–${pg.end} of ${pg.total} SKUs
        </span>
        <div style="display:flex;gap:4px;align-items:center;">
          <button class="pagination-btn" ${pg.currentPage === 1 ? "disabled" : ""} onclick="setTablePage('forecasting',${pg.currentPage - 1})">◀</button>
          <span style="padding:4px 8px;font-size:11.5px;font-weight:600;">Page ${pg.currentPage} of ${pg.totalPages}</span>
          <button class="pagination-btn" ${pg.currentPage === pg.totalPages ? "disabled" : ""} onclick="setTablePage('forecasting',${pg.currentPage + 1})">▶</button>
        </div>
      </div>
    </div>

    <!-- ============ 8. TRANSPARENCY PANEL ============ -->
    ${raFormulaBox(RA_FORMULAS)}
  `;
}

const RA_FORMULAS = [
  ["Moving average", "SMA(n) = Σ(units over last n days) ÷ n — n = 7 (signal), 28 (buying baseline), 200 (structural baseline)"],
  ["Weighted MA", "WMA(14) = Σ(unitsᵢ × i) ÷ Σ(i) — recent days carry more weight than old ones"],
  ["Regime flag", "(SMA7 − SMA200) ÷ SMA200 , confirmed by (SMA28 − SMA200) ÷ SMA200 ; > +15% = breakout, < −15% = breakdown"],
  ["WoW / MoM / QoQ", "Σ(trailing window) vs Σ(same-length window one period earlier), on units, revenue and gross profit"],
  ["YoY", "same 91-day season this year vs last year, so seasonality cancels instead of distorting the number"],
  ["Gross profit", `revenue − landed COGS − channel fee (${RA_CONST.CHANNEL_FEE_PCT * 100}% of selling price) − $${RA_CONST.FULFIL_COST_USD} 3PL pick/pack/ship`],
  ["Variability", "CV = σ(daily units, 90d) ÷ mean(daily units, 90d) → X < 0.55, Y < 1.05, Z ≥ 1.05"],
  ["Safety stock", `SS = Z × σ_daily × √(lead time) — Z = ${RA_CONST.Z_SCORE} for a ${RA_CONST.SERVICE_LEVEL * 100}% service level`],
  ["Reorder point", "ROP = (SMA28 × lead time) + safety stock"],
  ["Order quantity", `Q = SMA28 × (lead time + ${RA_CONST.REVIEW_PERIOD}d review) + SS − on-hand − in-transit, rounded up to a ${RA_CONST.PACK_MULTIPLE}-roll loom batch`],
  ["EOQ (Wilson)", `EOQ = √(2 × annual demand × $${RA_CONST.ORDER_COST_USD} order cost ÷ (unit cost × ${RA_CONST.HOLDING_RATE * 100}% holding rate))`],
  ["Stockout risk", "P = 1 − Φ((on-hand − SMA28×L) ÷ (σ_daily×√L)) — Φ is the standard normal CDF"],
  ["Days of cover", "on-hand ÷ SMA28 ; order-by date = today + (cover − lead time)"],
  ["ABC class", "rank SKUs by 90-day revenue, cumulative share ≤ 80% = A, ≤ 95% = B, rest = C"],
  ["Inventory turns", "annualised units sold ÷ average on-hand over 90 days ; days-on-hand = 365 ÷ turns"],
  ["Profit velocity", "annualised gross profit ÷ capital tied up in stock — dollars earned per dollar held"],
  ["Stockout cost", "stockout days × SMA28 × gross profit per unit — the price of running the buffer too thin"]
];

window.RA_FORMULAS = RA_FORMULAS;
window.renderForecastingView = renderForecastingView;
window.raSetForecastSort = raSetForecastSort;
window.raSetActionFilter = raSetActionFilter;
window.raSetPeriod = raSetPeriod;
