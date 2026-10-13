// ############################################################################
// ##  PLANNER ACTIONS, EXPORTS & METHODOLOGY
// ##  Every CTA surfaced by the rule engine lands here.
// ############################################################################

function raDownload(filename, text) {
  try {
    const blob = new Blob([text], { type: "text/csv;charset=utf-8;" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url; a.download = filename;
    document.body.appendChild(a); a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1500);
    showToast(`${filename} downloaded`, "success");
  } catch (e) {
    showToast("Export blocked by the browser — open the prototype over http:// rather than file://", "error");
  }
}

function raCsvRow(arr) {
  return arr.map(v => {
    const s = String(v === undefined || v === null ? "" : v);
    return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }).join(",");
}

/* ---------------------------------------------------------------------------
   ACTION HANDLERS
--------------------------------------------------------------------------- */

function raFindMetrics(skuCode) {
  const sku = (AppState.skus || []).find(s => s.sku === skuCode);
  return sku ? raSkuMetrics(sku) : null;
}

function raActionExpedite(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  const airQty = raRoundPack(Math.max(5, m.sma28 * RA_CONST.LEAD_TIME_AIR));
  const oceanQty = m.suggestedQty;
  const airCost = airQty * 96;  // indicative air freight per roll

  openModal(`✈️ Expedite — ${m.sku}`, `
    <div style="font-size:12.5px;line-height:1.6;color:var(--text-main);">
      <div style="background:rgba(239,68,68,0.10);border-left:3px solid var(--danger);border-radius:7px;padding:11px 13px;margin-bottom:13px;">
        <strong style="color:var(--danger);font-size:13px;">${m.onHand <= 0 ? "Out of stock now" : "Will run dry before ocean goods land"}</strong>
        <div style="margin-top:4px;color:var(--text-muted);font-size:11.5px;">${raEsc(m.action.why)}</div>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:11px;margin-bottom:13px;">
        <div style="background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:8px;padding:11px 13px;">
          <strong style="font-size:12.5px;">✈️ Air bridge — lands in ${RA_CONST.LEAD_TIME_AIR} days</strong>
          <div style="margin-top:7px;display:flex;flex-direction:column;gap:4px;font-size:11.5px;">
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Quantity</span><strong style="font-family:var(--font-mono);">${airQty} rolls</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Arrives</span><strong style="font-family:var(--font-mono);">${raFmtFullDate(raDayKey(RA_CONST.LEAD_TIME_AIR))}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Air freight premium</span><strong style="font-family:var(--font-mono);color:var(--warning);">${raMoney(airCost)}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Profit protected</span><strong style="font-family:var(--font-mono);color:var(--success);">${raMoney(airQty * m.profitPerUnit)}</strong></div>
          </div>
          <div style="margin-top:8px;font-size:10.5px;color:var(--text-muted);line-height:1.45;">
            ${airQty * m.profitPerUnit > airCost
              ? `The air premium is worth paying: it protects roughly ${raMoney(airQty * m.profitPerUnit - airCost)} more gross profit than it costs.`
              : `The air premium exceeds the profit it protects by ${raMoney(airCost - airQty * m.profitPerUnit)}. Consider pulling from India stock (${m.indiaAvail} rolls) or accepting the gap instead.`}
          </div>
        </div>

        <div style="background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:8px;padding:11px 13px;">
          <strong style="font-size:12.5px;">🚢 Ocean PO behind it — ${RA_CONST.LEAD_TIME_OCEAN} days</strong>
          <div style="margin-top:7px;display:flex;flex-direction:column;gap:4px;font-size:11.5px;">
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Quantity</span><strong style="font-family:var(--font-mono);">${oceanQty} rolls</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Arrives</span><strong style="font-family:var(--font-mono);">${raFmtFullDate(raDayKey(RA_CONST.LEAD_TIME_OCEAN))}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">Landed cost</span><strong style="font-family:var(--font-mono);">${raMoney(oceanQty * m.unitCost)}</strong></div>
            <div style="display:flex;justify-content:space-between;"><span style="color:var(--text-muted);">India stock available</span><strong style="font-family:var(--font-mono);">${m.indiaAvail} rolls</strong></div>
          </div>
        </div>
      </div>

      <div style="background:var(--bg-subtle);border-radius:7px;padding:10px 12px;font-size:11.5px;color:var(--text-muted);line-height:1.5;">
        Both legs are sized from the 28-day moving average of ${m.sma28.toFixed(2)} rolls/day and a safety stock of
        ${m.safetyStock} rolls (${RA_CONST.Z_SCORE}σ at a ${RA_CONST.SERVICE_LEVEL * 100}% service level). Adjust the
        quantities before release if you know something the history does not — a confirmed B2B lot, or a listing
        suppression that will suppress demand.
      </div>
    </div>`, "Replenishment");
}

function raActionRaisePo(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  showToast(`PO drafted: ${m.suggestedQty} rolls of ${m.sku} (${raMoney(m.suggestedQty * m.unitCost)}) — order by ${raFmtFullDate(m.orderByDate)}`, "success");
  if (typeof switchView === "function") setTimeout(() => switchView("mod4-po"), 700);
}

function raActionAddToBuySheet(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  AppState.raBuySheet = AppState.raBuySheet || {};
  AppState.raBuySheet[skuCode] = m.suggestedQty;
  showToast(`${m.sku} added to the ${RA_CONST.REVIEW_PERIOD}-day buy sheet — ${m.suggestedQty} rolls`, "success");
}

function raActionClearExcess(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  const carry = m.excessCapital * RA_CONST.HOLDING_RATE;
  const breakeven = m.price > 0 ? (carry / (m.excessUnits * m.price)) * 100 : 0;

  openModal(`📉 Excess clearance — ${m.sku}`, `
    <div style="font-size:12.5px;line-height:1.6;color:var(--text-main);">
      <div style="background:rgba(168,85,247,0.10);border-left:3px solid var(--brand-purple);border-radius:7px;padding:11px 13px;margin-bottom:13px;">
        <strong style="color:var(--brand-purple);font-size:13px;">${m.excessUnits} rolls above policy — ${raMoney(m.excessCapital)} of idle capital</strong>
        <div style="margin-top:4px;color:var(--text-muted);font-size:11.5px;">${raEsc(m.action.why)}</div>
      </div>

      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:8px;margin-bottom:13px;">
        ${raKpi("Days of cover", Math.round(m.daysCover) + "d", `ceiling ${RA_CONST.MAX_COVER_TARGET}d`, "var(--brand-purple)")}
        ${raKpi("Excess rolls", String(m.excessUnits), raMoney(m.excessCapital), "var(--text-main)")}
        ${raKpi("Annual carry cost", raMoney(carry), `${RA_CONST.HOLDING_RATE * 100}% holding rate`, "var(--warning)")}
        ${raKpi("Break-even discount", breakeven.toFixed(1) + "%", "vs holding one more year", "var(--info)")}
      </div>

      <div style="font-size:12px;font-weight:800;margin-bottom:7px;">Three ways to clear it</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:13px;">
        ${[
          ["🏷️ Channel promotion", `Run a ${Math.max(8, Math.ceil(breakeven)).toFixed(0)}% promotion on Amazon and Etsy. Anything shallower than the ${breakeven.toFixed(1)}% break-even still beats carrying the stock another year.`],
          ["📦 B2B container lot", `Offer the ${m.excessUnits} rolls as a wholesale lot. Recovers capital in one transaction and skips ${raMoney(m.excessUnits * RA_CONST.FULFIL_COST_USD)} of per-roll fulfilment cost.`],
          ["🔁 Node rebalance", `Move surplus toward the node with the shortest cover instead of discounting at all — the cheapest option whenever another warehouse is short of the same SKU.`]
        ].map(o => `<div style="background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:7px;padding:9px 11px;">
          <strong style="font-size:12px;">${o[0]}</strong>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;line-height:1.5;">${o[1]}</div>
        </div>`).join("")}
      </div>

      <div style="background:var(--bg-subtle);border-radius:7px;padding:10px 12px;font-size:11.5px;color:var(--text-muted);line-height:1.5;">
        Break-even discount = annual carrying cost ÷ retail value of the excess. Below that number, discounting now is
        cheaper than holding. It is not a pricing recommendation — it is the floor under one.
      </div>
    </div>`, "Excess capital");
}

function raActionAuditListing(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  openModal(`🔎 Listing audit — ${m.sku}`, `
    <div style="font-size:12.5px;line-height:1.6;color:var(--text-main);">
      <div style="background:rgba(100,116,139,0.10);border-left:3px solid var(--text-dim);border-radius:7px;padding:11px 13px;margin-bottom:13px;">
        <strong style="font-size:13px;">No units sold in ${m.daysSinceSale} days — ${raMoney(m.tiedCapital)} tied up</strong>
        <div style="margin-top:4px;color:var(--text-muted);font-size:11.5px;">
          Before treating this as dead stock, rule out the far more common cause: the listing stopped being visible.
        </div>
      </div>
      <div style="font-size:12px;font-weight:800;margin-bottom:7px;">Check in this order</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-bottom:13px;">
        ${[
          ["Listing live and in stock on each channel", "A suppressed or out-of-stock listing produces exactly the same zero-sales pattern as genuinely dead stock."],
          ["Buy-box share", "Losing the buy box on Amazon drops orders to near zero without any change in demand."],
          ["Price vs competing listings", "Compare against the three closest substitutes in the same size and construction."],
          ["Image and A+ content intact", "Broken or missing primary images silently kill conversion."],
          ["Category and search term mapping", "A recategorised listing stops appearing in the searches that used to convert."],
          ["Only then: liquidate", `If everything above is healthy and there is still no movement, the ${m.onHand} rolls are genuinely dead. Clear them as a B2B lot.`]
        ].map((c, i) => `<div style="display:flex;gap:9px;align-items:flex-start;background:var(--bg-subtle);border-radius:6px;padding:8px 10px;">
          <span style="font-family:var(--font-mono);font-weight:800;color:var(--brand-cyan);font-size:12px;">${i + 1}</span>
          <div><strong style="font-size:11.5px;">${c[0]}</strong>
          <div style="font-size:10.5px;color:var(--text-muted);margin-top:2px;line-height:1.45;">${c[1]}</div></div>
        </div>`).join("")}
      </div>
    </div>`, "Dead stock triage");
}

function raActionWatch(skuCode) {
  const m = raFindMetrics(skuCode);
  if (!m) return;
  AppState.raWatchlist = AppState.raWatchlist || {};
  AppState.raWatchlist[skuCode] = true;
  showToast(`${m.sku} on watchlist — alerts if the 7-day average crosses the 200-day baseline`, "info");
}

/* ---------------------------------------------------------------------------
   BUY SHEET
--------------------------------------------------------------------------- */

function raOpenBuySheetModal() {
  const all = raPortfolio();
  const buy = all.filter(m => ["EXPEDITE", "ORDER"].includes(m.action.code))
    .sort((a, b) => a.action.priority - b.action.priority || a.daysCover - b.daysCover);
  const sched = all.filter(m => m.action.code === "SCHEDULE").sort((a, b) => a.orderByDays - b.orderByDays);

  const totalUnits = buy.reduce((t, m) => t + m.suggestedQty, 0);
  const totalCost = buy.reduce((t, m) => t + m.suggestedQty * m.unitCost, 0);
  // A 40ft high-cube holds roughly 240 rolled rugs
  const containers = totalUnits / 240;

  const line = m => `<tr>
    <td><strong style="font-family:var(--font-mono);color:var(--brand-cyan);font-size:11.5px;">${raEsc(m.sku)}</strong>
      <div style="font-size:10px;color:var(--text-muted);max-width:200px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${raEsc(m.title)}</div></td>
    <td><span style="font-size:9px;font-weight:800;padding:1px 5px;border-radius:3px;background:var(--bg-subtle);">${m.abcxyz}</span></td>
    <td style="text-align:right;font-family:var(--font-mono);">${m.sma28.toFixed(2)}/d</td>
    <td style="text-align:right;font-family:var(--font-mono);">${m.onHand}</td>
    <td style="text-align:right;font-family:var(--font-mono);">${m.reorderPoint}</td>
    <td style="text-align:right;font-family:var(--font-mono);color:${m.daysCover < m.leadTime ? "var(--danger)" : "var(--text-main)"};">${Math.round(m.daysCover)}d</td>
    <td style="text-align:right;font-family:var(--font-mono);font-weight:800;color:var(--brand-cyan);">${m.suggestedQty}</td>
    <td style="text-align:right;font-family:var(--font-mono);">${raMoney(m.suggestedQty * m.unitCost)}</td>
    <td style="text-align:right;font-family:var(--font-mono);font-size:11px;">${raFmtDate(m.orderByDate)}</td>
    <td><span style="font-size:10px;font-weight:700;color:${m.action.tone};">${m.action.code}</span></td>
  </tr>`;

  openModal(`🧾 Consolidated buy sheet — ${raFmtFullDate(new Date())}`, `
    <div style="font-size:12.5px;color:var(--text-main);">
      <div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:8px;margin-bottom:13px;">
        ${raKpi("Lines to raise", String(buy.length), `${sched.length} more scheduled`, "var(--warning)")}
        ${raKpi("Total rolls", totalUnits.toLocaleString(), `${containers.toFixed(2)} × 40ft HC`, "var(--brand-cyan)")}
        ${raKpi("Landed cost", raMoney(totalCost), "manufacturing + packing + freight", "var(--text-main)")}
        ${raKpi("Container fill", (containers % 1 * 100).toFixed(0) + "% of last box", containers % 1 < 0.7 ? "add scheduled lines to fill" : "well filled", containers % 1 < 0.7 ? "var(--warning)" : "var(--success)")}
      </div>

      ${containers % 1 < 0.7 && sched.length ? `
      <div style="background:rgba(56,189,248,0.10);border-left:3px solid var(--info);border-radius:7px;padding:10px 12px;margin-bottom:13px;font-size:11.5px;line-height:1.5;">
        <strong style="color:var(--info);">Consolidation opportunity —</strong>
        the last container is only ${(containers % 1 * 100).toFixed(0)}% full. Pulling forward the
        ${Math.min(sched.length, 4)} nearest scheduled lines below fills the cube and spreads the
        $${RA_CONST.ORDER_COST_USD} order cost across more units, without breaching the
        ${RA_CONST.MAX_COVER_TARGET}-day cover ceiling on any of them.
      </div>` : ""}

      <div style="font-size:12px;font-weight:800;margin-bottom:6px;">Raise now — ${buy.length} lines</div>
      <div class="table-responsive" style="margin-bottom:14px;border:1px solid var(--border-subtle);border-radius:7px;">
        <table class="data-table" style="width:100%;font-size:11px;">
          <thead><tr>
            <th>SKU</th><th>Class</th><th style="text-align:right;">28d avg</th><th style="text-align:right;">On hand</th>
            <th style="text-align:right;">ROP</th><th style="text-align:right;">Cover</th><th style="text-align:right;">Order qty</th>
            <th style="text-align:right;">Cost</th><th style="text-align:right;">Order by</th><th>Rule</th>
          </tr></thead>
          <tbody>${buy.length ? buy.map(line).join("") : `<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text-dim);">Nothing needs raising today.</td></tr>`}</tbody>
        </table>
      </div>

      <div style="font-size:12px;font-weight:800;margin-bottom:6px;">Scheduled — candidates to consolidate into the same container</div>
      <div class="table-responsive" style="margin-bottom:13px;border:1px solid var(--border-subtle);border-radius:7px;">
        <table class="data-table" style="width:100%;font-size:11px;">
          <thead><tr>
            <th>SKU</th><th>Class</th><th style="text-align:right;">28d avg</th><th style="text-align:right;">On hand</th>
            <th style="text-align:right;">ROP</th><th style="text-align:right;">Cover</th><th style="text-align:right;">Order qty</th>
            <th style="text-align:right;">Cost</th><th style="text-align:right;">Order by</th><th>Rule</th>
          </tr></thead>
          <tbody>${sched.length ? sched.map(line).join("") : `<tr><td colspan="10" style="text-align:center;padding:20px;color:var(--text-dim);">Nothing scheduled.</td></tr>`}</tbody>
        </table>
      </div>

      <div style="display:flex;gap:7px;flex-wrap:wrap;">
        <button class="btn btn-sm btn-primary" onclick="showToast('${buy.length} PO lines released to the India origin warehouse','success');closeModal('crudModal');">📤 Release ${buy.length} PO lines</button>
        <button class="btn btn-sm btn-secondary" onclick="raExportPlanningCsv()">📥 Export as CSV</button>
      </div>
    </div>`, "Module 8 · Replenishment");
}

/* ---------------------------------------------------------------------------
   METHODOLOGY
--------------------------------------------------------------------------- */

function raOpenMethodologyModal() {
  openModal("📐 Forecasting methodology — deterministic, not machine learning", `
    <div style="font-size:12.5px;line-height:1.65;color:var(--text-main);">

      <div style="background:rgba(16,185,129,0.10);border-left:3px solid var(--success);border-radius:7px;padding:11px 13px;margin-bottom:14px;">
        <strong style="color:var(--success);font-size:13px;">Why there is no model here</strong>
        <div style="margin-top:5px;color:var(--text-muted);font-size:11.5px;line-height:1.55;">
          A rug catalogue has a few hundred SKUs, lumpy B2B orders and a 45-day lead time. That is too little data and
          too much noise for a learned model to beat classical statistics — and a learned model cannot tell a planner
          <em>why</em> it wants 60 rolls. Everything on these screens is an equation the buyer can check on paper,
          argue with, and override. When the recommendation is wrong, you can see exactly which input was wrong.
        </div>
      </div>

      <div style="font-size:12.5px;font-weight:800;margin-bottom:7px;">The four questions this answers</div>
      <div style="display:flex;flex-direction:column;gap:8px;margin-bottom:14px;">
        ${[
          ["How fast is it selling?", "Simple moving averages over 7, 28 and 200 days. The 7-day is the early warning, the 28-day is what you buy against, and the 200-day is the structural baseline that no single week can move."],
          ["Is that rate changing?", "The 7-day line crossing the 200-day line by more than 15%, confirmed by the 28-day line, flags a regime change rather than noise. Period deltas (WoW, MoM, QoQ, YoY) say the same thing in money instead of units."],
          ["How much buffer does it need?", "Safety stock = Z × σ_daily × √lead time. The variability of demand sets the buffer, not a flat weeks-of-cover rule, so erratic SKUs get more protection and steady SKUs stop tying up capital they never needed."],
          ["When and how much to order?", "Reorder point = demand over the lead time + safety stock. Order quantity tops up to cover the lead time plus the review cycle, rounded to a loom batch. EOQ gives the economic sanity check."]
        ].map(r => `<div style="background:var(--bg-subtle);border-radius:7px;padding:9px 11px;">
          <strong style="font-size:12px;color:var(--brand-cyan);">${r[0]}</strong>
          <div style="font-size:11px;color:var(--text-muted);margin-top:3px;line-height:1.55;">${r[1]}</div>
        </div>`).join("")}
      </div>

      <div style="font-size:12.5px;font-weight:800;margin-bottom:7px;">Known limits — stated up front</div>
      <ul style="margin:0 0 14px 18px;padding:0;font-size:11.5px;color:var(--text-muted);line-height:1.65;">
        <li>Moving averages lag. On a genuine step change the 28-day line takes about four weeks to catch up, which is why the 7-day and 200-day lines are shown beside it.</li>
        <li>Safety stock assumes demand over the lead time is roughly normal. A single container-sized B2B order breaks that assumption — those should be planned as known orders, not absorbed into the buffer.</li>
        <li>The seasonality index needs at least two full years before it is trustworthy for a new SKU. Until then it borrows the collection average.</li>
        <li>Nothing here knows about a competitor launch, a listing suppression or a viral post. When you know something the history does not, override the quantity.</li>
      </ul>

      <div style="font-size:12.5px;font-weight:800;margin-bottom:7px;">Every formula on these screens</div>
      ${raFormulaBox(RA_FORMULAS, "COMPLETE EQUATION REFERENCE")}
    </div>`, "Module 8 · Methodology");
}

/* ---------------------------------------------------------------------------
   EXPORTS
--------------------------------------------------------------------------- */

function raExportPlanningCsv() {
  const all = raPortfolio();
  const head = [
    "SKU", "Title", "Collection", "ABC-XYZ", "Revenue share %",
    "SMA7 /day", "SMA28 /day", "SMA200 /day", "7d vs 200d %", "Regime",
    "WoW units %", "WoW profit %", "MoM units %", "MoM profit %",
    "QoQ units %", "QoQ profit %", "YoY units %", "YoY profit %",
    "CV", "XYZ", "Confidence %",
    "On hand", "Reserved", "In transit", "India stock",
    "Safety stock", "Reorder point", "Days cover", "Run out", "Order by",
    "Stockout risk %", "Suggested qty", "EOQ", "Unit cost", "Order value",
    "Revenue 90d", "Gross profit 90d", "Margin %", "Profit per roll", "Profit velocity",
    "Turns", "Fill rate %", "Excess units", "Excess capital", "Action", "Rule fired"
  ];
  const rows = all.map(m => raCsvRow([
    m.sku, m.title, m.collection, m.abcxyz, m.revenueSharePct.toFixed(2),
    m.sma7.toFixed(3), m.sma28.toFixed(3), m.sma200.toFixed(3), m.longCross.toFixed(1), m.regime,
    m.periods.wow.units.pct.toFixed(1), m.periods.wow.profit.pct.toFixed(1),
    m.periods.mom.units.pct.toFixed(1), m.periods.mom.profit.pct.toFixed(1),
    m.periods.qoq.units.pct.toFixed(1), m.periods.qoq.profit.pct.toFixed(1),
    m.periods.yoy.units.pct.toFixed(1), m.periods.yoy.profit.pct.toFixed(1),
    m.cv.toFixed(3), m.xyz, m.forecastConfidence,
    m.onHand, m.reserved, m.inTransit, m.indiaAvail,
    m.safetyStock, m.reorderPoint, Math.round(m.daysCover), raFmtFullDate(m.runOut), raFmtFullDate(m.orderByDate),
    m.stockoutProb, m.suggestedQty, m.eoq, m.unitCost.toFixed(2), (m.suggestedQty * m.unitCost).toFixed(2),
    m.revenue90.toFixed(2), m.profit90.toFixed(2), m.margin90.toFixed(1), m.profitPerUnit.toFixed(2), m.profitVelocity.toFixed(3),
    m.turnover.toFixed(2), m.fillRate, m.excessUnits, m.excessCapital.toFixed(2), m.action.code, m.action.rule
  ]));
  raDownload(`rugos-planning-sheet-${new Date().toISOString().slice(0, 10)}.csv`, [raCsvRow(head), ...rows].join("\n"));
}

function raExportNodeCsv(whId) {
  const wh = (AppState.warehouses || []).find(w => w.id === whId);
  if (!wh) return;
  const { rows } = raWarehouseAnalytics(wh);
  const head = [
    "Facility", "SKU", "Title", "Rolls here", "Available", "Allocated",
    "Out 7d /day", "Out 28d /day", "Out 200d /day", "7d vs 200d %",
    "Dwell days", "Turns", "Age days", "Age bucket",
    "WoW units %", "WoW profit %", "MoM units %", "MoM profit %",
    "QoQ units %", "QoQ profit %", "YoY units %", "YoY profit %",
    "Units out 90d", "Units in 90d", "Revenue 90d", "Gross profit 90d",
    "Capital held", "Landed value", "Weight kg"
  ];
  const body = rows.map(r => raCsvRow([
    wh.name, r.sku, r.title, r.totalHere, r.stockHere, r.resvHere,
    r.out7.toFixed(3), r.out28.toFixed(3), r.out200.toFixed(3), r.nodeLongCross.toFixed(1),
    Math.round(r.dwellDays), r.turns.toFixed(2), Math.round(r.ageDays), r.ageBucket,
    r.nodePeriods.wow.units.pct.toFixed(1), r.nodePeriods.wow.profit.pct.toFixed(1),
    r.nodePeriods.mom.units.pct.toFixed(1), r.nodePeriods.mom.profit.pct.toFixed(1),
    r.nodePeriods.qoq.units.pct.toFixed(1), r.nodePeriods.qoq.profit.pct.toFixed(1),
    r.nodePeriods.yoy.units.pct.toFixed(1), r.nodePeriods.yoy.profit.pct.toFixed(1),
    Math.round(r.nodeOut90), Math.round(r.nodeIn90), r.nodeRevenue90.toFixed(2), r.nodeProfit90.toFixed(2),
    r.nodeCapital.toFixed(2), r.landedVal.toFixed(2), r.weightHere.toFixed(1)
  ]));
  raDownload(`rugos-${whId}-analytics-${new Date().toISOString().slice(0, 10)}.csv`, [raCsvRow(head), ...body].join("\n"));
}

function raExportSkuCsv(skuCode) {
  const sku = (AppState.skus || []).find(s => s.sku === skuCode);
  if (!sku) return;
  const hist = raBuildHistory(sku);
  const units = hist.days.map(d => d.units);
  const s7 = raSMA(units, 7), s28 = raSMA(units, 28), s200 = raSMA(units, 200);
  const head = ["Date", "Units sold", "SMA7", "SMA28", "SMA200", "Receipts in", "Stock on hand", "Revenue", "COGS", "Fees", "Gross profit"];
  const body = hist.days.map((d, i) => raCsvRow([
    d.date.toISOString().slice(0, 10), d.units,
    s7[i] === null ? "" : s7[i].toFixed(3),
    s28[i] === null ? "" : s28[i].toFixed(3),
    s200[i] === null ? "" : s200[i].toFixed(3),
    d.inbound, d.onHand,
    d.revenue.toFixed(2), d.cogs.toFixed(2), d.fees.toFixed(2), d.profit.toFixed(2)
  ]));
  raDownload(`rugos-${skuCode}-daily-history.csv`, [raCsvRow(head), ...body].join("\n"));
}

// Legacy CTA kept alive so older buttons elsewhere still work
function exportForecastCSV() { raExportPlanningCsv(); }
function initiateOceanReplenishmentBatch() { raOpenBuySheetModal(); }

window.raActionExpedite = raActionExpedite;
window.raActionRaisePo = raActionRaisePo;
window.raActionAddToBuySheet = raActionAddToBuySheet;
window.raActionClearExcess = raActionClearExcess;
window.raActionAuditListing = raActionAuditListing;
window.raActionWatch = raActionWatch;
window.raOpenBuySheetModal = raOpenBuySheetModal;
window.raOpenMethodologyModal = raOpenMethodologyModal;
window.raExportPlanningCsv = raExportPlanningCsv;
window.raExportNodeCsv = raExportNodeCsv;
window.raExportSkuCsv = raExportSkuCsv;
window.exportForecastCSV = exportForecastCSV;
window.initiateOceanReplenishmentBatch = initiateOceanReplenishmentBatch;
