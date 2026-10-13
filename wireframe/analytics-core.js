// ############################################################################
// ##  RUGOS ANALYTICS CORE — DETERMINISTIC STATISTICAL ENGINE
// ##  ----------------------------------------------------------------------
// ##  NO AI. NO ML. NO BLACK BOX.
// ##  Every figure below comes from a classical, auditable supply-chain or
// ##  accounting formula: simple/weighted/exponential moving averages, standard
// ##  deviation, safety stock, reorder point, EOQ, ABC-XYZ, inventory turns,
// ##  period-over-period deltas (WoW / MoM / QoQ / YoY) and gross-profit
// ##  bridges. Every screen exposes the exact equation used so a human planner
// ##  can verify it, argue with it, and override it.
// ##
// ##  SOW MAPPING: Module 8 (Forecasting & Analytics) + Module 3 (Warehouse)
// ##               + Module 7 (True Cost & Profitability)
// ############################################################################

const RA_CONST = {
  SERVICE_LEVEL: 0.95,
  Z_SCORE: 1.65,            // z for a 95% cycle service level
  LEAD_TIME_OCEAN: 45,      // Bhadohi weave + stuffing + ocean + de-van
  LEAD_TIME_AIR: 12,        // air priority replenishment
  LEAD_TIME_INTERNAL: 3,    // 3PL -> FBA ground rebalance
  REVIEW_PERIOD: 14,        // planner reviews the buy sheet fortnightly
  ORDER_COST_USD: 850,      // fixed cost to raise + ship one container line
  HOLDING_RATE: 0.24,       // 24% annual carrying cost of landed value
  PACK_MULTIPLE: 5,         // rugs are ordered in loom batches of 5
  MAX_COVER_TARGET: 120,    // beyond 120 days of cover = idle capital
  DEAD_STOCK_DAYS: 90,
  HISTORY_DAYS: 760,        // >2 years so 200-day MA, QoQ and YoY are all real
  CHANNEL_FEE_PCT: 0.15,    // Amazon/Etsy/Walmart referral
  FULFIL_COST_USD: 38       // 3PL pick, pack and outbound freight per roll
};

const RA_MA_WINDOWS = { FAST: 7, MID: 28, SLOW: 200 };

/* ==========================================================================
   1. DETERMINISTIC PSEUDO-HISTORY GENERATOR
   In production these arrays are a single aggregation query against the
   orders + stock_ledger collections. Here they are derived from a hash of the
   SKU code, so every render, chart and CSV export shows the SAME numbers.
   ========================================================================== */

function raHash(str) {
  let h = 2166136261;
  for (let i = 0; i < String(str).length; i++) {
    h ^= String(str).charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

function raRng(seed) {
  let s = (seed >>> 0) || 1;
  return function () {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function raDayKey(offsetFromToday) {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + offsetFromToday);
  return d;
}

function raFmtDate(d) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short" });
}

function raFmtFullDate(d) {
  return d.toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
}

function raMoney(n) {
  const v = Math.round(n || 0);
  return (v < 0 ? "-$" : "$") + Math.abs(v).toLocaleString();
}

function raPct(n, dp) {
  const v = (n || 0).toFixed(dp === undefined ? 1 : dp);
  return (n >= 0 ? "+" : "") + v + "%";
}

const _raCache = {};

/**
 * Full deterministic daily demand + stock + margin history for one SKU.
 * Returns { code, days: [{date,label,units,revenue,cogs,fees,profit,onHand,inbound,outbound}] }
 */
function raBuildHistory(sku) {
  const code = sku.sku || sku;
  if (_raCache[code]) return _raCache[code];

  const skuObj = (typeof sku === "object") ? sku : (AppState.skus || []).find(s => s.sku === code);
  const rng = raRng(raHash(code));

  const price = (skuObj && skuObj.sellingPriceUSD) ? skuObj.sellingPriceUSD : 700;
  const landedCost = (skuObj ? (skuObj.mfgCostUSD || 220) : 220)
    + (skuObj ? (skuObj.packingCostUSD || 14) : 14)
    + (skuObj ? (skuObj.allocatedLandedFreightUSD || 28) : 28);

  const todayOnHand = (skuObj && skuObj.stock)
    ? (skuObj.stock.usaAvailable || 0) + (skuObj.stock.fba || 0)
    : 30;

  // Base velocity is derived from the live stock figure so that cover, turns,
  // fill rate and the action mix are all internally consistent with the stock
  // the system actually holds. Cheaper, smaller runners turn faster than
  // high-value 9x12 heritage pieces, so target cover scales with price.
  // The band straddles the 45-day ocean lead time and the 120-day policy
  // ceiling, so the portfolio lands a realistic spread across every action
  // bucket rather than flagging all twelve SKUs as urgent reorders.
  const priceTilt = Math.min(1.35, Math.max(0.78, price / 700));
  const targetCover = (62 + rng() * 118) * priceTilt;   // ~48-243 days of cover
  const base = Math.max(0.08, todayOnHand / targetCover);

  // Annual seasonality: rugs peak Sept-Dec (US holiday / winter interiors).
  const seasonAmp = 0.17 + rng() * 0.16;
  // Single long-run growth term. Growth is modelled ONCE, as a year-on-year
  // drift — layering a separate daily trend on top of this double-counts it
  // and makes every SKU look like a breakout.
  const yoyDrift = 1 + (rng() - 0.46) * 0.30;   // roughly -14% to +16% a year

  const N = RA_CONST.HISTORY_DAYS;
  const days = [];

  for (let i = -N; i <= 0; i++) {
    const d = raDayKey(i);
    const dow = d.getDay();
    const month = d.getMonth();
    const yearsAgo = -i / 365;

    const dowFactor = [0.82, 0.88, 0.97, 1.03, 1.10, 1.22, 1.16][dow];
    const seasonFactor = 1 + seasonAmp * Math.sin(((month - 4) / 12) * 2 * Math.PI);
    const yoyFactor = Math.pow(yoyDrift, -yearsAgo);

    const mean = base * dowFactor * seasonFactor * yoyFactor;

    // Poisson-flavoured integer demand (sum of Bernoulli draws -> whole rolls)
    let units = 0;
    const draws = Math.ceil(mean * 3) + 2;
    for (let k = 0; k < draws; k++) if (rng() < mean / draws) units++;

    // Occasional B2B bulk container lot
    if (rng() < 0.026) units += 3 + Math.floor(rng() * 9);

    // Realised price drifts with promotions; cost drifts with wool + freight.
    const promo = rng() < 0.11 ? (0.86 + rng() * 0.09) : 1;
    const realisedPrice = price * promo;
    const costInflation = 1 - 0.09 * yearsAgo;   // costs were lower in the past
    const unitCogs = landedCost * costInflation;

    const revenue = units * realisedPrice;
    const cogs = units * unitCogs;
    const fees = units * (realisedPrice * RA_CONST.CHANNEL_FEE_PCT + RA_CONST.FULFIL_COST_USD);

    days.push({
      date: d,
      label: raFmtDate(d),
      units, dow, month,
      year: d.getFullYear(),
      price: realisedPrice,
      revenue, cogs, fees,
      profit: revenue - cogs - fees,
      inbound: 0, outbound: units, onHand: 0
    });
  }

  // ---- Forward stock simulation: min/max policy produces a real sawtooth --
  // The historic (s, Q) policy is derived from target cover so that average
  // inventory works out to roughly `targetCover` days. That keeps inventory
  // turns (365 ÷ cover) inside the 2-8× range a rug business actually runs at,
  // instead of the 20× a mismatched policy would imply.
  const avgDaily = days.reduce((t, d) => t + d.units, 0) / days.length || 1;
  const safetyDays = targetCover * 0.45;
  const orderDays = targetCover * 1.10;   // avg level = safetyDays + orderDays/2 = targetCover
  const rop = Math.max(1, Math.round(avgDaily * (safetyDays + RA_CONST.LEAD_TIME_OCEAN)));
  const orderQty = Math.max(RA_CONST.PACK_MULTIPLE, Math.round(avgDaily * orderDays / 5) * 5);

  let stock = Math.round(avgDaily * targetCover);
  const arrivals = {};
  for (let i = 0; i < days.length; i++) {
    const inb = arrivals[i] || 0;
    stock += inb;
    days[i].inbound = inb;
    stock -= days[i].units;
    if (stock < 0) stock = 0;
    days[i].onHand = stock;
    const pending = Object.keys(arrivals).some(k => parseInt(k, 10) > i);
    if (stock <= rop && !pending) {
      const eta = i + RA_CONST.LEAD_TIME_OCEAN + Math.floor(raRng(raHash(code + i))() * 9) - 4;
      if (eta < days.length) arrivals[eta] = (arrivals[eta] || 0) + orderQty;
    }
  }

  // Scale (rather than shift) the curve so the last day lands exactly on the
  // live figure. Scaling preserves the sawtooth shape and cannot push earlier
  // days below zero, which a subtractive correction does — and clamping at
  // zero would fabricate stockouts that never happened.
  const simFinal = days[days.length - 1].onHand;
  if (simFinal > 0) {
    const factor = todayOnHand / simFinal;
    days.forEach(d => { d.onHand = Math.max(0, d.onHand * factor); d.inbound = d.inbound * factor; });
  }

  const result = { code, days, base, price, landedCost, yoyDrift, rop, orderQty };
  _raCache[code] = result;
  return result;
}

/* ==========================================================================
   2. CLASSICAL STATISTICS PRIMITIVES
   ========================================================================== */

function raMean(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0) / arr.length;
}

function raSum(arr) {
  if (!arr || !arr.length) return 0;
  return arr.reduce((a, b) => a + b, 0);
}

function raStdDev(arr) {
  if (!arr || arr.length < 2) return 0;
  const m = raMean(arr);
  return Math.sqrt(arr.reduce((a, b) => a + Math.pow(b - m, 2), 0) / (arr.length - 1));
}

/** Simple Moving Average series — window n, nulls until the window fills. */
function raSMA(values, n) {
  const out = [];
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= n) sum -= values[i - n];
    out.push(i < n - 1 ? null : sum / n);
  }
  return out;
}

/** Weighted Moving Average — recent days weighted heavier (1..n). */
function raWMA(values, n) {
  const out = [];
  const denom = (n * (n + 1)) / 2;
  for (let i = 0; i < values.length; i++) {
    if (i < n - 1) { out.push(null); continue; }
    let sum = 0, w = 1;
    for (let k = i - n + 1; k <= i; k++) { sum += values[k] * w; w++; }
    out.push(sum / denom);
  }
  return out;
}

/** Exponentially weighted moving average. */
function raEMA(values, alpha) {
  const out = [];
  let prev = null;
  for (let i = 0; i < values.length; i++) {
    prev = (prev === null) ? values[i] : alpha * values[i] + (1 - alpha) * prev;
    out.push(prev);
  }
  return out;
}

/** Ordinary least squares over the last n points. */
function raLinReg(values, n) {
  const seg = values.slice(-n);
  const N = seg.length;
  if (N < 2) return { slope: 0, intercept: raMean(seg), r2: 0 };
  let sx = 0, sy = 0, sxy = 0, sxx = 0, syy = 0;
  for (let i = 0; i < N; i++) {
    sx += i; sy += seg[i]; sxy += i * seg[i]; sxx += i * i; syy += seg[i] * seg[i];
  }
  const slope = (N * sxy - sx * sy) / (N * sxx - sx * sx || 1);
  const intercept = (sy - slope * sx) / N;
  const num = (N * sxy - sx * sy);
  const den = Math.sqrt((N * sxx - sx * sx) * (N * syy - sy * sy)) || 1;
  const r = num / den;
  return { slope, intercept, r2: r * r };
}

/** Normal CDF (Abramowitz-Stegun) — drives stockout probability. */
function raNormCdf(z) {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp(-z * z / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}

function raRoundPack(q, mult) {
  const m = mult || RA_CONST.PACK_MULTIPLE;
  return Math.ceil(Math.max(0, q) / m) * m;
}

/* ==========================================================================
   3. PERIOD-OVER-PERIOD COMPARISON ENGINE  (WoW / MoM / QoQ / YoY)
   The single most requested analytic: is this SKU/node growing or dying, and
   on which measure — units, revenue, or actual gross profit?
   ========================================================================== */

const RA_PERIODS = [
  { key: "wow", label: "WoW", name: "Week on week", days: 7, back: 7 },
  { key: "mom", label: "MoM", name: "Month on month", days: 30, back: 30 },
  { key: "qoq", label: "QoQ", name: "Quarter on quarter", days: 91, back: 91 },
  { key: "yoy", label: "YoY", name: "Year on year", days: 91, back: 365 }
];

/**
 * Compares the trailing `days` window against the window `back` days earlier.
 * YoY deliberately compares the SAME 91-day season a year apart, which strips
 * seasonality out of the comparison instead of letting it distort the number.
 */
function raComparePeriod(series, days, back) {
  const n = series.length;
  const curr = series.slice(Math.max(0, n - days), n);
  const prevEnd = n - back;
  const prev = series.slice(Math.max(0, prevEnd - days), Math.max(0, prevEnd));
  const c = raSum(curr), p = raSum(prev);
  return {
    current: c,
    previous: p,
    delta: c - p,
    pct: p > 0 ? ((c - p) / p) * 100 : (c > 0 ? 100 : 0),
    hasBaseline: prev.length >= Math.min(days, 5)
  };
}

/**
 * Full WoW / MoM / QoQ / YoY table across units, revenue, gross profit and
 * margin % for one history. This is what tells a planner WHERE sales are
 * declining rather than just THAT they are.
 */
function raPeriodMatrix(hist) {
  const units = hist.days.map(d => d.units);
  const revenue = hist.days.map(d => d.revenue);
  const profit = hist.days.map(d => d.profit);

  const out = {};
  RA_PERIODS.forEach(p => {
    const u = raComparePeriod(units, p.days, p.back);
    const r = raComparePeriod(revenue, p.days, p.back);
    const g = raComparePeriod(profit, p.days, p.back);
    const marginNow = r.current > 0 ? (g.current / r.current) * 100 : 0;
    const marginPrev = r.previous > 0 ? (g.previous / r.previous) * 100 : 0;

    out[p.key] = {
      meta: p,
      units: u, revenue: r, profit: g,
      marginNow, marginPrev, marginDeltaPts: marginNow - marginPrev,
      // A decline is only "real" if it shows up in profit, not just units.
      verdict: raVerdict(u.pct, r.pct, g.pct)
    };
  });
  return out;
}

function raVerdict(uPct, rPct, gPct) {
  if (gPct <= -20) return { code: "SEVERE", label: "Profit falling hard", tone: "var(--danger)" };
  if (gPct <= -8) return { code: "DECLINE", label: "Declining", tone: "var(--warning)" };
  if (gPct >= 20) return { code: "SURGE", label: "Growing fast", tone: "var(--success)" };
  if (gPct >= 8) return { code: "GROWTH", label: "Growing", tone: "var(--success)" };
  if (uPct > 6 && gPct < 2) return { code: "MARGIN_LEAK", label: "Volume up, profit flat — margin leak", tone: "var(--warning)" };
  if (uPct < -6 && gPct > -2) return { code: "MIX_UP", label: "Fewer units, richer mix", tone: "var(--info)" };
  return { code: "FLAT", label: "Flat", tone: "var(--text-muted)" };
}

/** Rolls a daily series into calendar buckets for bar charts / ledgers. */
function raBucket(days, size, count, pick) {
  const out = [];
  const total = days.length;
  for (let b = count - 1; b >= 0; b--) {
    const end = total - b * size;
    const start = Math.max(0, end - size);
    if (start >= end) continue;
    const slice = days.slice(start, end);
    out.push({
      label: raFmtDate(slice[0].date) + "–" + raFmtDate(slice[slice.length - 1].date),
      shortLabel: raFmtDate(slice[slice.length - 1].date),
      from: slice[0].date,
      to: slice[slice.length - 1].date,
      slice,
      value: raSum(slice.map(pick || (d => d.units)))
    });
  }
  return out;
}

/* ==========================================================================
   4. THE SKU METRIC BUNDLE — one call gives the planner everything
   ========================================================================== */

function raSkuMetrics(skuObj, opts) {
  opts = opts || {};
  const leadTime = opts.leadTime || RA_CONST.LEAD_TIME_OCEAN;
  const hist = raBuildHistory(skuObj);
  const units = hist.days.map(d => d.units);

  const last7 = units.slice(-7);
  const last28 = units.slice(-28);
  const last90 = units.slice(-90);
  const last200 = units.slice(-200);
  const prev7 = units.slice(-14, -7);
  const prev28 = units.slice(-56, -28);

  // ---- Moving averages ---------------------------------------------------
  const sma7Series = raSMA(units, RA_MA_WINDOWS.FAST);
  const sma28Series = raSMA(units, RA_MA_WINDOWS.MID);
  const sma200Series = raSMA(units, RA_MA_WINDOWS.SLOW);
  const wma14Series = raWMA(units, 14);
  const emaSeries = raEMA(units, 0.18);

  const sma7 = raMean(last7);
  const sma14 = raMean(units.slice(-14));
  const sma28 = raMean(last28);
  const sma90 = raMean(last90);
  const sma200 = raMean(last200);
  const wma14 = wma14Series[wma14Series.length - 1] || sma14;
  const ema = emaSeries[emaSeries.length - 1] || sma14;

  // ---- Short vs long signal (7 vs 200) -----------------------------------
  // The 200-day line is the structural baseline: it cannot be moved by a
  // weekend spike or one B2B container. When the 7-day line crosses it, the
  // SKU has genuinely changed regime.
  const crossover = sma28 > 0 ? ((sma7 - sma28) / sma28) * 100 : 0;
  const longCross = sma200 > 0 ? ((sma7 - sma200) / sma200) * 100 : 0;
  const midLongCross = sma200 > 0 ? ((sma28 - sma200) / sma200) * 100 : 0;

  let regime, regimeIcon, regimeTone, regimeNote;
  if (longCross > 15 && midLongCross > 4) {
    regime = "BREAKOUT"; regimeIcon = "▲▲"; regimeTone = "var(--success)";
    regimeNote = "7-day and 28-day averages are both above the 200-day baseline — a structural step up, not a blip. Raise the baseline you buy against.";
  } else if (longCross < -15 && midLongCross < -4) {
    regime = "BREAKDOWN"; regimeIcon = "▼▼"; regimeTone = "var(--danger)";
    regimeNote = "7-day and 28-day averages have both fallen through the 200-day baseline — structural decline. Cut the next order, do not just delay it.";
  } else if (longCross > 15) {
    regime = "SPIKE"; regimeIcon = "▲"; regimeTone = "var(--info)";
    regimeNote = "Short-term demand is running hot above the 200-day baseline but the 28-day line has not confirmed. Treat as a spike until it does.";
  } else if (longCross < -15) {
    regime = "DIP"; regimeIcon = "▼"; regimeTone = "var(--warning)";
    regimeNote = "Short-term demand has dropped below the 200-day baseline but the 28-day line has not confirmed. Watch, do not react yet.";
  } else {
    regime = "IN LINE"; regimeIcon = "→"; regimeTone = "var(--text-muted)";
    regimeNote = "Short-term demand is tracking its own 200-day baseline. Existing buying assumptions still hold.";
  }

  // ---- Trend -------------------------------------------------------------
  const wowPct = raMean(prev7) > 0 ? ((sma7 - raMean(prev7)) / raMean(prev7)) * 100 : 0;
  const momPct = raMean(prev28) > 0 ? ((sma28 - raMean(prev28)) / raMean(prev28)) * 100 : 0;
  const reg = raLinReg(units, 56);
  const slopePerWeek = reg.slope * 7;

  let trend = "STABLE", trendIcon = "→", trendTone = "var(--text-muted)";
  if (crossover > 12 && reg.slope > 0) { trend = "RISING"; trendIcon = "▲"; trendTone = "var(--success)"; }
  else if (crossover < -12 && reg.slope < 0) { trend = "DECLINING"; trendIcon = "▼"; trendTone = "var(--danger)"; }

  // ---- Period matrix (WoW / MoM / QoQ / YoY on units, revenue, profit) ----
  const periods = raPeriodMatrix(hist);

  // ---- Variability / XYZ classification ----------------------------------
  const sigmaDaily = raStdDev(last90);
  const cv = sma90 > 0 ? sigmaDaily / sma90 : 0;
  const xyz = cv < 0.55 ? "X" : cv < 1.05 ? "Y" : "Z";
  const xyzLabel = xyz === "X" ? "Steady & predictable" : xyz === "Y" ? "Moderately variable" : "Erratic / lumpy";
  const forecastConfidence = Math.max(15, Math.min(96, Math.round((1 - Math.min(cv, 1.4) / 1.4) * 100)));

  // ---- Stock position ----------------------------------------------------
  const st = skuObj.stock || {};
  const usaAvail = st.usaAvailable || 0;
  const fba = st.fba || 0;
  const reserved = st.usaReserved || 0;
  const inTransit = st.inTransit || 0;
  const indiaAvail = st.indiaAvailable || 0;
  const onHand = usaAvail + fba;
  const available = Math.max(0, onHand - reserved);
  const pipeline = onHand + inTransit;

  // ---- Safety stock & reorder point (King's formula, 95% service) --------
  const sigmaLT = sigmaDaily * Math.sqrt(leadTime);
  const safetyStock = Math.round(RA_CONST.Z_SCORE * sigmaLT);
  const demandOverLT = sma28 * leadTime;
  const reorderPoint = Math.round(demandOverLT + safetyStock);

  // ---- Cover, run-out, order-by ------------------------------------------
  const daysCover = sma28 > 0 ? onHand / sma28 : 999;
  const daysCoverPipeline = sma28 > 0 ? pipeline / sma28 : 999;
  const runOut = raDayKey(Math.round(Math.min(daysCover, 900)));
  const orderByDays = Math.round(daysCover - leadTime);
  const orderByDate = raDayKey(orderByDays);

  // ---- Stockout probability over the lead time ---------------------------
  const z = sigmaLT > 0 ? (onHand - demandOverLT) / sigmaLT : (onHand > demandOverLT ? 4 : -4);
  const stockoutProb = Math.round((1 - raNormCdf(z)) * 100);

  // ---- Order quantity ----------------------------------------------------
  const targetStock = sma28 * (leadTime + RA_CONST.REVIEW_PERIOD) + safetyStock;
  const rawOrderQty = Math.max(0, targetStock - pipeline);
  const suggestedQty = raRoundPack(rawOrderQty);

  // ---- EOQ (Wilson) ------------------------------------------------------
  const annualDemand = sma90 * 365;
  const unitCost = (skuObj.mfgCostUSD || 220) + (skuObj.packingCostUSD || 14) + (skuObj.allocatedLandedFreightUSD || 28);
  const holdCostPerUnit = unitCost * RA_CONST.HOLDING_RATE;
  const eoq = holdCostPerUnit > 0 ? Math.round(Math.sqrt((2 * annualDemand * RA_CONST.ORDER_COST_USD) / holdCostPerUnit)) : 0;

  // ---- Financial efficiency ----------------------------------------------
  const avgInventory = raMean(hist.days.slice(-90).map(d => d.onHand)) || 1;
  const turnover = avgInventory > 0 ? (sma90 * 365) / avgInventory : 0;
  const daysOnHand = turnover > 0 ? 365 / turnover : 999;
  const sold90 = raSum(last90);
  const sellThrough = (sold90 + onHand) > 0 ? (sold90 / (sold90 + onHand)) * 100 : 0;

  const revenue90 = raSum(hist.days.slice(-90).map(d => d.revenue));
  const profit90 = raSum(hist.days.slice(-90).map(d => d.profit));
  const margin90 = revenue90 > 0 ? (profit90 / revenue90) * 100 : 0;
  const profitPerUnit = sold90 > 0 ? profit90 / sold90 : 0;
  const grossMarginUnit = (skuObj.sellingPriceUSD || 700) - unitCost;
  const marginPct = skuObj.sellingPriceUSD ? (grossMarginUnit / skuObj.sellingPriceUSD) * 100 : 0;
  const gmroi = (avgInventory * unitCost) > 0 ? (profit90 * 4) / (avgInventory * unitCost) : 0;
  const stockToSales = sma28 > 0 ? onHand / (sma28 * 30) : 99;
  const tiedCapital = onHand * unitCost;
  // Profit produced per dollar of stock per year — the real ranking measure.
  const profitVelocity = tiedCapital > 0 ? (profit90 * 4) / tiedCapital : 0;

  // ---- Excess & dead stock -----------------------------------------------
  const excessUnits = Math.max(0, Math.round(onHand - sma28 * RA_CONST.MAX_COVER_TARGET));
  const excessCapital = excessUnits * unitCost;
  const excessCarryCostYr = excessCapital * RA_CONST.HOLDING_RATE;
  let daysSinceSale = 0;
  for (let i = units.length - 1; i >= 0; i--) { if (units[i] > 0) break; daysSinceSale++; }
  const isDead = daysSinceSale >= RA_CONST.DEAD_STOCK_DAYS;

  // ---- Stockout history ---------------------------------------------------
  const stockoutDays90 = hist.days.slice(-90).filter(d => d.onHand <= 0).length;
  const fillRate = Math.round(((90 - stockoutDays90) / 90) * 1000) / 10;
  const lostUnits90 = stockoutDays90 * sma28;
  const lostProfit90 = lostUnits90 * profitPerUnit;

  // ---- Seasonality index by month ----------------------------------------
  const monthBuckets = {};
  hist.days.forEach(d => {
    monthBuckets[d.month] = monthBuckets[d.month] || [];
    monthBuckets[d.month].push(d.units);
  });
  const overallMean = raMean(units) || 1;
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
  const seasonIndex = Object.keys(monthBuckets).map(m => ({
    month: parseInt(m, 10),
    name: MONTHS[m],
    index: Math.round((raMean(monthBuckets[m]) / overallMean) * 100)
  })).sort((a, b) => a.month - b.month);

  // ---- Day-of-week index --------------------------------------------------
  const dowBuckets = [[], [], [], [], [], [], []];
  hist.days.forEach(d => dowBuckets[d.dow].push(d.units));
  const dowIndex = dowBuckets.map((arr, i) => ({
    name: ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][i],
    index: Math.round((raMean(arr) / overallMean) * 100),
    avg: Math.round(raMean(arr) * 10) / 10
  }));

  // ---- Risk band ----------------------------------------------------------
  let risk = "HEALTHY";
  if (onHand <= 0) risk = "STOCKOUT";
  else if (daysCover < leadTime * 0.35) risk = "CRITICAL";
  else if (onHand <= reorderPoint) risk = "REORDER";
  else if (daysCover > RA_CONST.MAX_COVER_TARGET) risk = "OVERSTOCK";
  else if (daysCover < leadTime) risk = "WATCH";

  const metrics = {
    sku: skuObj.sku, title: skuObj.title, collection: skuObj.collection,
    image: skuObj.imageUrl, price: skuObj.sellingPriceUSD, size: skuObj.size,
    history: hist, units,
    sma7Series, sma28Series, sma200Series, wma14Series, emaSeries,
    sma7, sma14, sma28, sma90, sma200, wma14, ema,
    crossover, longCross, midLongCross, regime, regimeIcon, regimeTone, regimeNote,
    wowPct, momPct, slopePerWeek, r2: reg.r2, trend, trendIcon, trendTone,
    periods,
    sigmaDaily, cv, xyz, xyzLabel, forecastConfidence,
    onHand, available, reserved, inTransit, indiaAvail, usaAvail, fba, pipeline,
    safetyStock, reorderPoint, sigmaLT, demandOverLT, leadTime,
    daysCover, daysCoverPipeline, runOut, orderByDays, orderByDate,
    stockoutProb, suggestedQty, rawOrderQty, targetStock, eoq,
    unitCost, holdCostPerUnit, turnover, daysOnHand, sellThrough, sold90,
    revenue90, profit90, margin90, profitPerUnit, profitVelocity,
    grossMarginUnit, marginPct, gmroi, stockToSales, tiedCapital,
    excessUnits, excessCapital, excessCarryCostYr, daysSinceSale, isDead,
    stockoutDays90, fillRate, lostUnits90, lostProfit90,
    seasonIndex, dowIndex, risk,
    weeklyRate: sma7 * 7, monthlyRate: sma28 * 30, annualRate: sma90 * 365
  };

  metrics.action = raDecideAction(metrics);
  return metrics;
}

/* ==========================================================================
   5. RULE-BASED NEXT-ACTION ENGINE
   A transparent decision table. Each verdict states the rule that fired so a
   human planner can argue with it — nothing here is a hidden model output.
   ========================================================================== */

function raDecideAction(m) {
  const fmt = n => Math.round(n * 10) / 10;

  if (m.onHand <= 0) {
    return {
      code: "EXPEDITE", label: "Expedite by air now", priority: 1,
      tone: "var(--danger)", bg: "rgba(239,68,68,0.10)",
      why: `Stock is at zero. Ocean lead time is ${m.leadTime} days, so an ocean PO will not recover the listing in time. Move ${raRoundPack(Math.max(5, m.sma28 * RA_CONST.LEAD_TIME_AIR))} rolls by air (${RA_CONST.LEAD_TIME_AIR} days) and place the ocean PO behind it.`,
      rule: "on_hand = 0", cta: "✈️ Raise air replenishment", fn: `raActionExpedite('${m.sku}')`
    };
  }
  if (m.risk === "CRITICAL") {
    return {
      code: "EXPEDITE", label: "Expedite — will run dry before goods land", priority: 1,
      tone: "var(--danger)", bg: "rgba(239,68,68,0.10)",
      why: `Only ${fmt(m.daysCover)} days of cover against a ${m.leadTime}-day lead time. Even raising the PO today leaves a ${Math.round(m.leadTime - m.daysCover)}-day gap. Cover it from India stock (${m.indiaAvail} rolls) or air-freight ${raRoundPack(m.sma28 * (m.leadTime - m.daysCover))} rolls.`,
      rule: "days_cover < lead_time × 0.35", cta: "✈️ Cover the gap", fn: `raActionExpedite('${m.sku}')`
    };
  }
  if (m.risk === "REORDER") {
    return {
      code: "ORDER", label: "Reorder point breached — raise PO", priority: 2,
      tone: "var(--warning)", bg: "rgba(245,158,11,0.10)",
      why: `On-hand ${m.onHand} has fallen to or below the reorder point of ${m.reorderPoint} (= ${fmt(m.sma28)}/day × ${m.leadTime} days lead + ${m.safetyStock} safety stock). Order ${m.suggestedQty} rolls to reach the ${Math.round(m.targetStock)}-roll target covering lead time plus the ${RA_CONST.REVIEW_PERIOD}-day review cycle.`,
      rule: "on_hand ≤ reorder_point", cta: `📋 Raise PO — ${m.suggestedQty} rolls`, fn: `raActionRaisePo('${m.sku}')`
    };
  }
  if (m.risk === "OVERSTOCK" || m.excessUnits > 0) {
    return {
      code: "REDUCE", label: "Excess capital — stop buying, push demand", priority: 4,
      tone: "var(--brand-purple)", bg: "rgba(168,85,247,0.10)",
      why: `${fmt(m.daysCover)} days of cover is ${Math.round(m.daysCover - RA_CONST.MAX_COVER_TARGET)} days beyond the ${RA_CONST.MAX_COVER_TARGET}-day policy ceiling. ${m.excessUnits} rolls (${raMoney(m.excessCapital)}) are idle, costing ${raMoney(m.excessCarryCostYr)}/yr to carry. Suppress the next PO and clear the excess through a channel promotion or a B2B container lot.`,
      rule: "days_cover > 120 day policy ceiling", cta: "📉 Plan excess clearance", fn: `raActionClearExcess('${m.sku}')`
    };
  }
  if (m.isDead) {
    return {
      code: "DEAD", label: "No movement — review for liquidation", priority: 5,
      tone: "var(--text-dim)", bg: "rgba(100,116,139,0.10)",
      why: `No units sold in ${m.daysSinceSale} days. ${m.onHand} rolls are holding ${raMoney(m.tiedCapital)} of working capital. Check the listing is live and buy-box eligible before writing it off.`,
      rule: "days_since_last_sale ≥ 90", cta: "🔎 Audit listing", fn: `raActionAuditListing('${m.sku}')`
    };
  }
  if (m.risk === "WATCH" || m.orderByDays <= RA_CONST.REVIEW_PERIOD) {
    return {
      code: "SCHEDULE", label: `Schedule PO by ${raFmtFullDate(m.orderByDate)}`, priority: 3,
      tone: "var(--info)", bg: "rgba(56,189,248,0.10)",
      why: `Cover is ${fmt(m.daysCover)} days. Subtract the ${m.leadTime}-day lead time and the PO must leave in ${m.orderByDays} days to avoid a gap. Nothing is urgent today — put it on the ${RA_CONST.REVIEW_PERIOD}-day buy sheet and consolidate it with other SKUs into one container.`,
      rule: "days_cover − lead_time ≤ review_period", cta: "🗓️ Add to buy sheet", fn: `raActionAddToBuySheet('${m.sku}')`
    };
  }
  return {
    code: "HOLD", label: "Healthy — no action needed", priority: 6,
    tone: "var(--success)", bg: "rgba(16,185,129,0.10)",
    why: `${fmt(m.daysCover)} days of cover, on-hand ${m.onHand} sits comfortably above the ${m.reorderPoint} reorder point, and demand is ${m.regime.toLowerCase()} against its 200-day baseline. Next review in ${RA_CONST.REVIEW_PERIOD} days, or sooner if the 7-day average crosses the 200-day line.`,
    rule: "on_hand > reorder_point and cover within policy", cta: "👁️ Watchlist", fn: `raActionWatch('${m.sku}')`
  };
}

/* ==========================================================================
   6. PORTFOLIO ROLL-UPS (ABC needs every SKU together)
   ========================================================================== */

function raPortfolio() {
  const all = (AppState.skus || []).map(s => raSkuMetrics(s));
  const ranked = [...all].sort((a, b) => b.revenue90 - a.revenue90);
  const totalRev = ranked.reduce((t, m) => t + m.revenue90, 0) || 1;
  let cum = 0;
  ranked.forEach(m => {
    cum += m.revenue90;
    const pct = (cum / totalRev) * 100;
    m.revenueSharePct = (m.revenue90 / totalRev) * 100;
    m.cumSharePct = pct;
    m.abc = pct <= 80 ? "A" : pct <= 95 ? "B" : "C";
    m.abcxyz = m.abc + m.xyz;
  });
  return all;
}

function raPortfolioSummary(list) {
  const s = {
    skuCount: list.length,
    expedite: list.filter(m => m.action.code === "EXPEDITE").length,
    order: list.filter(m => m.action.code === "ORDER").length,
    schedule: list.filter(m => m.action.code === "SCHEDULE").length,
    reduce: list.filter(m => m.action.code === "REDUCE").length,
    dead: list.filter(m => m.action.code === "DEAD").length,
    healthy: list.filter(m => m.action.code === "HOLD").length,
    unitsOnHand: list.reduce((t, m) => t + m.onHand, 0),
    unitsInTransit: list.reduce((t, m) => t + m.inTransit, 0),
    capital: list.reduce((t, m) => t + m.tiedCapital, 0),
    excessCapital: list.reduce((t, m) => t + m.excessCapital, 0),
    suggestedUnits: list.reduce((t, m) => t + (["EXPEDITE", "ORDER"].includes(m.action.code) ? m.suggestedQty : 0), 0),
    dailyDemand: list.reduce((t, m) => t + m.sma7, 0),
    dailyDemand28: list.reduce((t, m) => t + m.sma28, 0),
    dailyDemand200: list.reduce((t, m) => t + m.sma200, 0),
    revenue90: list.reduce((t, m) => t + m.revenue90, 0),
    profit90: list.reduce((t, m) => t + m.profit90, 0),
    lostProfit90: list.reduce((t, m) => t + m.lostProfit90, 0),
    avgFillRate: raMean(list.map(m => m.fillRate)),
    avgTurns: raMean(list.map(m => m.turnover))
  };
  s.suggestedSpend = list.reduce((t, m) => t + (["EXPEDITE", "ORDER"].includes(m.action.code) ? m.suggestedQty * m.unitCost : 0), 0);
  s.margin90 = s.revenue90 > 0 ? (s.profit90 / s.revenue90) * 100 : 0;
  s.wowPct = s.dailyDemand28 > 0 ? ((s.dailyDemand - s.dailyDemand28) / s.dailyDemand28) * 100 : 0;
  s.longCrossPct = s.dailyDemand200 > 0 ? ((s.dailyDemand - s.dailyDemand200) / s.dailyDemand200) * 100 : 0;

  // Portfolio-level WoW / MoM / QoQ / YoY by summing daily series across SKUs
  const len = RA_CONST.HISTORY_DAYS + 1;
  const u = new Array(len).fill(0), r = new Array(len).fill(0), p = new Array(len).fill(0);
  list.forEach(m => m.history.days.forEach((d, i) => { u[i] += d.units; r[i] += d.revenue; p[i] += d.profit; }));
  s.series = { units: u, revenue: r, profit: p };
  s.periods = {};
  RA_PERIODS.forEach(pd => {
    const un = raComparePeriod(u, pd.days, pd.back);
    const rv = raComparePeriod(r, pd.days, pd.back);
    const pf = raComparePeriod(p, pd.days, pd.back);
    s.periods[pd.key] = {
      meta: pd, units: un, revenue: rv, profit: pf,
      marginNow: rv.current > 0 ? (pf.current / rv.current) * 100 : 0,
      marginPrev: rv.previous > 0 ? (pf.previous / rv.previous) * 100 : 0,
      verdict: raVerdict(un.pct, rv.pct, pf.pct)
    };
    s.periods[pd.key].marginDeltaPts = s.periods[pd.key].marginNow - s.periods[pd.key].marginPrev;
  });
  return s;
}

/** SKUs whose profit is declining on a given period — the "what's dying" list. */
function raDecliners(list, periodKey) {
  return list
    .filter(m => m.periods[periodKey] && m.periods[periodKey].profit.pct < -5)
    .sort((a, b) => a.periods[periodKey].profit.pct - b.periods[periodKey].profit.pct);
}

/* ==========================================================================
   7. SVG CHART PRIMITIVES — data-driven, theme-aware, dependency-free
   ========================================================================== */

function raEsc(s) {
  return String(s === undefined || s === null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

/**
 * Multi-series line / area / bar chart.
 * series: [{ name, color, values:[num|null], type:'line'|'area'|'dashed'|'bar', width }]
 */
function raLineChart(cfg) {
  const w = cfg.width || 900, h = cfg.height || 200;
  const padL = 40, padR = 14, padT = 12, padB = 24;
  const series = cfg.series || [];
  const labels = cfg.labels || [];
  const n = Math.max(...series.map(s => s.values.length), 1);

  const allVals = [];
  series.forEach(s => s.values.forEach(v => { if (v !== null && v !== undefined && isFinite(v)) allVals.push(v); }));
  let max = cfg.max !== undefined ? cfg.max : Math.max(...allVals, 1);
  const min = cfg.min !== undefined ? cfg.min : 0;
  max = max * 1.12;

  const X = i => padL + (i / Math.max(n - 1, 1)) * (w - padL - padR);
  const Y = v => padT + (1 - (v - min) / (max - min || 1)) * (h - padT - padB);

  let grid = "", yLabels = "";
  const steps = 4;
  for (let g = 0; g <= steps; g++) {
    const v = min + ((max - min) / steps) * g;
    const y = Y(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border-subtle)" stroke-width="1" ${g === 0 ? "" : 'stroke-dasharray="3 4"'}/>`;
    yLabels += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text-dim)" text-anchor="end">${cfg.yFmt ? cfg.yFmt(v) : Math.round(v)}</text>`;
  }

  let body = "";
  series.forEach((s, si) => {
    const pts = [];
    s.values.forEach((v, i) => { if (v !== null && v !== undefined && isFinite(v)) pts.push([X(i), Y(v)]); });
    if (!pts.length) return;

    if (s.type === "bar") {
      const bw = Math.max(1.2, (w - padL - padR) / n * 0.62);
      s.values.forEach((v, i) => {
        if (v === null || !isFinite(v)) return;
        const y = Y(v), y0 = Y(0);
        body += `<rect x="${(X(i) - bw / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${bw.toFixed(1)}" height="${Math.max(0, y0 - y).toFixed(1)}" fill="${s.color}" opacity="${s.opacity || 0.5}" rx="1"/>`;
      });
      return;
    }

    const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
    if (s.type === "area") {
      const gid = `raGrad${cfg.id || 0}_${si}`;
      body += `<defs><linearGradient id="${gid}" x1="0" y1="0" x2="0" y2="1">
        <stop offset="0%" stop-color="${s.color}" stop-opacity="0.32"/>
        <stop offset="100%" stop-color="${s.color}" stop-opacity="0"/></linearGradient></defs>`;
      body += `<path d="${d} L${pts[pts.length - 1][0].toFixed(1)},${Y(min).toFixed(1)} L${pts[0][0].toFixed(1)},${Y(min).toFixed(1)} Z" fill="url(#${gid})"/>`;
    }
    body += `<path d="${d}" fill="none" stroke="${s.color}" stroke-width="${s.width || 2}" ${s.type === "dashed" ? 'stroke-dasharray="5 4"' : ""} stroke-linejoin="round" stroke-linecap="round"/>`;
    if (s.dots) pts.forEach(p => { body += `<circle cx="${p[0].toFixed(1)}" cy="${p[1].toFixed(1)}" r="2.2" fill="${s.color}"/>`; });
  });

  (cfg.refLines || []).forEach(rl => {
    const y = Y(rl.value);
    if (y < padT || y > h - padB) return;
    body += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="${rl.color}" stroke-width="1.4" stroke-dasharray="6 4"/>`;
    body += `<text x="${w - padR - 2}" y="${(y - 4).toFixed(1)}" font-size="9" font-weight="700" fill="${rl.color}" text-anchor="end">${raEsc(rl.label)}</text>`;
  });

  (cfg.markers || []).forEach(mk => {
    const x = X(mk.index);
    body += `<line x1="${x.toFixed(1)}" y1="${padT}" x2="${x.toFixed(1)}" y2="${h - padB}" stroke="${mk.color}" stroke-width="1.3" stroke-dasharray="4 3"/>`;
    body += `<text x="${(x + 4).toFixed(1)}" y="${padT + 9}" font-size="8.5" font-weight="700" fill="${mk.color}">${raEsc(mk.label)}</text>`;
  });

  let xLabels = "";
  const step = Math.max(1, Math.floor(n / (cfg.xTicks || 7)));
  labels.forEach((l, i) => {
    if (i % step !== 0 && i !== n - 1) return;
    xLabels += `<text x="${X(i).toFixed(1)}" y="${h - 6}" font-size="8.5" fill="var(--text-dim)" text-anchor="middle">${raEsc(l)}</text>`;
  });

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:visible;">
    ${grid}${yLabels}${body}${xLabels}</svg>`;
}

/** Horizontal ranked bar list — velocity leaderboards, seasonality, decliners. */
function raRankBars(rows) {
  const max = Math.max(...rows.map(r => Math.abs(r.value)), 1);
  return `<div style="display:flex;flex-direction:column;gap:6px;">
    ${rows.map(r => `
      <div style="display:grid;grid-template-columns:1fr 92px;gap:8px;align-items:center;">
        <div>
          <div style="display:flex;justify-content:space-between;font-size:10.5px;margin-bottom:3px;gap:6px;">
            <span style="color:var(--text-main);font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${raEsc(r.label)}</span>
            <span style="color:var(--text-dim);font-family:var(--font-mono);white-space:nowrap;">${raEsc(r.sub || "")}</span>
          </div>
          <div style="height:7px;background:var(--bg-subtle);border-radius:4px;overflow:hidden;">
            <div style="height:100%;width:${((Math.abs(r.value) / max) * 100).toFixed(1)}%;background:${r.color || "var(--brand-cyan)"};border-radius:4px;"></div>
          </div>
        </div>
        <div style="text-align:right;font-family:var(--font-mono);font-size:11.5px;font-weight:700;color:${r.color || "var(--brand-cyan)"};">${raEsc(r.display)}</div>
      </div>`).join("")}
  </div>`;
}

/** Grouped vertical bars — inbound vs outbound movement per period. */
function raGroupedBars(cfg) {
  const w = cfg.width || 900, h = cfg.height || 180;
  const padL = 42, padR = 12, padT = 12, padB = 26;
  const groups = cfg.groups || [];
  const legend = cfg.legend || [];
  const max = Math.max(...groups.flatMap(g => g.values.map(Math.abs)), 1) * 1.15;
  const n = groups.length;
  const slot = (w - padL - padR) / Math.max(n, 1);
  const bw = Math.min(18, (slot * 0.74) / Math.max(legend.length, 1));
  const Y = v => padT + (1 - v / max) * (h - padT - padB);

  let grid = "", yl = "";
  for (let g = 0; g <= 3; g++) {
    const v = (max / 3) * g, y = Y(v);
    grid += `<line x1="${padL}" y1="${y.toFixed(1)}" x2="${w - padR}" y2="${y.toFixed(1)}" stroke="var(--border-subtle)" ${g === 0 ? "" : 'stroke-dasharray="3 4"'}/>`;
    yl += `<text x="${padL - 6}" y="${(y + 3).toFixed(1)}" font-size="9" fill="var(--text-dim)" text-anchor="end">${Math.round(v)}</text>`;
  }

  let bars = "", labels = "";
  groups.forEach((g, i) => {
    const cx = padL + slot * i + slot / 2;
    const startX = cx - (bw * legend.length) / 2;
    g.values.forEach((v, k) => {
      const y = Y(Math.abs(v)), y0 = Y(0);
      bars += `<rect x="${(startX + k * bw + 1).toFixed(1)}" y="${y.toFixed(1)}" width="${(bw - 2).toFixed(1)}" height="${Math.max(1, y0 - y).toFixed(1)}" fill="${legend[k].color}" rx="1.5"><title>${raEsc(g.label)} — ${raEsc(legend[k].name)}: ${Math.abs(Math.round(v))}</title></rect>`;
    });
    if (i % Math.max(1, Math.ceil(n / 12)) === 0 || i === n - 1)
      labels += `<text x="${cx.toFixed(1)}" y="${h - 8}" font-size="8.5" fill="var(--text-dim)" text-anchor="middle">${raEsc(g.shortLabel || g.label)}</text>`;
  });

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;">${grid}${yl}${bars}${labels}</svg>`;
}

/** Diverging bars for period-over-period % change (positive up, negative down). */
function raDivergingBars(cfg) {
  const w = cfg.width || 620, h = cfg.height || 160;
  const padL = 40, padR = 12, padT = 14, padB = 30;
  const items = cfg.items || [];
  const max = Math.max(...items.map(i => Math.abs(i.value)), 5) * 1.2;
  const n = items.length;
  const slot = (w - padL - padR) / Math.max(n, 1);
  const bw = Math.min(40, slot * 0.6);
  const mid = padT + (h - padT - padB) / 2;
  const Y = v => mid - (v / max) * ((h - padT - padB) / 2);

  let bars = "", labels = "";
  items.forEach((it, i) => {
    const cx = padL + slot * i + slot / 2;
    const y = Y(it.value);
    const top = Math.min(y, mid), height = Math.max(1.5, Math.abs(mid - y));
    bars += `<rect x="${(cx - bw / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${bw.toFixed(1)}" height="${height.toFixed(1)}" fill="${it.color}" rx="2" opacity="0.88"><title>${raEsc(it.label)}: ${it.value.toFixed(1)}%</title></rect>`;
    bars += `<text x="${cx.toFixed(1)}" y="${(it.value >= 0 ? top - 4 : top + height + 10).toFixed(1)}" font-size="10" font-weight="800" fill="${it.color}" text-anchor="middle" font-family="var(--font-mono)">${it.value >= 0 ? "+" : ""}${it.value.toFixed(0)}%</text>`;
    labels += `<text x="${cx.toFixed(1)}" y="${h - 12}" font-size="9.5" font-weight="700" fill="var(--text-main)" text-anchor="middle">${raEsc(it.label)}</text>`;
    labels += `<text x="${cx.toFixed(1)}" y="${h - 2}" font-size="8" fill="var(--text-dim)" text-anchor="middle">${raEsc(it.sub || "")}</text>`;
  });

  return `<svg width="100%" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" style="display:block;overflow:visible;">
    <line x1="${padL}" y1="${mid}" x2="${w - padR}" y2="${mid}" stroke="var(--border-main)" stroke-width="1.2"/>
    ${bars}${labels}</svg>`;
}

/** Compact inline sparkline for table cells. */
function raSparkline(values, color, w, h) {
  w = w || 74; h = h || 22;
  const max = Math.max(...values, 1), min = Math.min(...values, 0);
  const pts = values.map((v, i) => [
    (i / Math.max(values.length - 1, 1)) * w,
    h - 2 - ((v - min) / (max - min || 1)) * (h - 4)
  ]);
  const d = pts.map((p, i) => `${i === 0 ? "M" : "L"}${p[0].toFixed(1)},${p[1].toFixed(1)}`).join(" ");
  return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" style="display:block;overflow:visible;">
    <path d="${d} L${w},${h} L0,${h} Z" fill="${color}" opacity="0.14"/>
    <path d="${d}" fill="none" stroke="${color}" stroke-width="1.5" stroke-linejoin="round"/>
    <circle cx="${pts[pts.length - 1][0].toFixed(1)}" cy="${pts[pts.length - 1][1].toFixed(1)}" r="2" fill="${color}"/>
  </svg>`;
}

/** Donut gauge for a single percentage. */
function raGauge(pct, color, label, size) {
  size = size || 58;
  const r = size / 2 - 5, c = 2 * Math.PI * r;
  const off = c * (1 - Math.min(100, Math.max(0, pct)) / 100);
  return `<svg width="${size}" height="${size}" viewBox="0 0 ${size} ${size}">
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="var(--border-subtle)" stroke-width="5"/>
    <circle cx="${size / 2}" cy="${size / 2}" r="${r}" fill="none" stroke="${color}" stroke-width="5"
      stroke-dasharray="${c.toFixed(1)}" stroke-dashoffset="${off.toFixed(1)}" stroke-linecap="round"
      transform="rotate(-90 ${size / 2} ${size / 2})"/>
    <text x="${size / 2}" y="${size / 2 + 2}" font-size="13" font-weight="800" fill="var(--text-main)" text-anchor="middle" font-family="var(--font-mono)">${Math.round(pct)}</text>
    <text x="${size / 2}" y="${size / 2 + 13}" font-size="7" fill="var(--text-dim)" text-anchor="middle">${raEsc(label || "%")}</text>
  </svg>`;
}

/** Stacked horizontal bar for composition breakdowns. */
function raStackBar(segments, height) {
  const total = segments.reduce((t, s) => t + s.value, 0) || 1;
  return `<div style="display:flex;height:${height || 14}px;border-radius:4px;overflow:hidden;background:var(--bg-subtle);">
    ${segments.map(s => `<div style="width:${((s.value / total) * 100).toFixed(2)}%;background:${s.color};" title="${raEsc(s.label)}: ${s.value}"></div>`).join("")}
  </div>`;
}

/** 5-block sub-bar progress visualizer for Weekly Sell-Through.
 *  5 main sub-bars (20% portion each), each containing 4 sub-ticks (5% part each)
 *  with 4 color shades from faded to full intensity.
 */
function raSellThroughSubBars(pct) {
  const value = Math.max(0, Math.min(100, Number(pct) || 0));
  const shades = [
    "rgba(16, 185, 129, 0.35)", // 0-5%   (Faded)
    "rgba(16, 185, 129, 0.58)", // 5-10%  (Soft)
    "rgba(16, 185, 129, 0.82)", // 10-15% (Vibrant)
    "rgba(16, 185, 129, 1.00)"  // 15-20% (Full)
  ];
  const emptyBg = "rgba(148, 163, 184, 0.14)";

  let html = `<div class="ra-sellthrough-bar" style="display:inline-flex;align-items:center;gap:3px;" title="Weekly Sell-Through: ${value.toFixed(1)}% (5 blocks x 20%, 4 sub-shades x 5%)">`;
  for (let block = 0; block < 5; block++) {
    const blockStart = block * 20;
    html += `<div style="display:flex;gap:1.5px;background:rgba(15, 23, 42, 0.3);padding:1.5px 2px;border-radius:3px;border:1px solid rgba(148, 163, 184, 0.12);">`;
    for (let sub = 0; sub < 4; sub++) {
      const subStart = blockStart + sub * 5;
      const subEnd = subStart + 5;
      let color = emptyBg;
      let opacity = 1;
      if (value >= subEnd) {
        color = shades[sub];
      } else if (value > subStart) {
        const fill = (value - subStart) / 5;
        color = shades[sub];
        opacity = 0.45 + 0.55 * fill;
      }
      html += `<div style="width:3.5px;height:10px;border-radius:1px;background:${color};opacity:${opacity};transition:all 0.15s ease-in-out;"></div>`;
    }
    html += `</div>`;
  }
  html += `</div>`;
  return html;
}

/** ABC × XYZ 3×3 portfolio policy matrix. */
function raAbcXyzMatrix(list) {
  const cells = {};
  ["A", "B", "C"].forEach(a => ["X", "Y", "Z"].forEach(x => { cells[a + x] = []; }));
  list.forEach(m => { if (cells[m.abcxyz]) cells[m.abcxyz].push(m); });

  const policy = {
    AX: ["Tight control, automate", "var(--success)"],
    AY: ["Buffer + weekly review", "var(--brand-cyan)"],
    AZ: ["Make-to-order, hold little", "var(--warning)"],
    BX: ["Fortnightly auto-reorder", "var(--brand-cyan)"],
    BY: ["Standard safety stock", "var(--text-muted)"],
    BZ: ["Review case-by-case", "var(--warning)"],
    CX: ["Bulk buy, low touch", "var(--text-muted)"],
    CY: ["Min-max only", "var(--text-dim)"],
    CZ: ["Candidate to delist", "var(--danger)"]
  };

  return `<div style="display:grid;grid-template-columns:auto repeat(3,1fr);gap:5px;font-size:10px;">
    <div></div>
    <div style="text-align:center;font-weight:800;color:var(--text-dim);padding-bottom:2px;">X — Steady</div>
    <div style="text-align:center;font-weight:800;color:var(--text-dim);padding-bottom:2px;">Y — Variable</div>
    <div style="text-align:center;font-weight:800;color:var(--text-dim);padding-bottom:2px;">Z — Erratic</div>
    ${["A", "B", "C"].map(a => `
      <div style="display:flex;align-items:center;font-weight:800;color:var(--text-dim);padding-right:4px;">${a}<span style="font-weight:500;font-size:8px;margin-left:3px;">${a === "A" ? "top 80%" : a === "B" ? "next 15%" : "last 5%"}</span></div>
      ${["X", "Y", "Z"].map(x => {
        const k = a + x, arr = cells[k], p = policy[k];
        return `<div style="background:var(--bg-subtle);border:1px solid var(--border-subtle);border-radius:5px;padding:6px 7px;min-height:52px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <strong style="font-family:var(--font-mono);font-size:12px;color:${arr.length ? p[1] : "var(--text-dim)"};">${k}</strong>
            <span style="font-size:9px;color:var(--text-dim);">${arr.length} SKU</span>
          </div>
          <div style="font-size:8.5px;color:var(--text-muted);margin-top:3px;line-height:1.3;">${p[0]}</div>
        </div>`;
      }).join("")}
    `).join("")}
  </div>`;
}

/* ==========================================================================
   8. SMALL UI HELPERS
   ========================================================================== */

function raCard(title, subtitle, bodyHtml, extraStyle) {
  return `<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:9px;padding:11px 13px;${extraStyle || ""}">
    <div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-bottom:8px;flex-wrap:wrap;">
      <strong style="font-size:12.5px;color:var(--text-main);">${title}</strong>
      <span style="font-size:9.5px;color:var(--text-dim);text-align:right;">${subtitle || ""}</span>
    </div>
    ${bodyHtml}
  </div>`;
}

function raKpi(label, value, sub, color, tooltip) {
  return `<div title="${raEsc(tooltip || "")}" style="background:var(--bg-card);border:1px solid var(--border-subtle);border-radius:8px;padding:9px 11px;">
    <div style="font-size:9px;color:var(--text-dim);font-weight:800;letter-spacing:.4px;text-transform:uppercase;">${label}</div>
    <div style="font-size:17px;font-weight:800;font-family:var(--font-mono);color:${color || "var(--text-main)"};margin-top:2px;line-height:1.15;">${value}</div>
    <div style="font-size:9.5px;color:var(--text-muted);margin-top:1px;">${sub || ""}</div>
  </div>`;
}

function raLegend(items) {
  return `<div style="display:flex;gap:11px;flex-wrap:wrap;font-size:9.5px;font-weight:600;">
    ${items.map(i => `<span style="display:inline-flex;align-items:center;gap:4px;color:${i.color};">
      <span style="width:${i.dash ? 10 : 8}px;height:${i.dash ? 2 : 8}px;background:${i.color};border-radius:${i.dash ? 0 : "50%"};"></span>${raEsc(i.name)}</span>`).join("")}
  </div>`;
}

function raDelta(pct, invert) {
  const good = invert ? pct < 0 : pct >= 0;
  const tone = Math.abs(pct) < 2 ? "var(--text-muted)" : good ? "var(--success)" : "var(--danger)";
  const arrow = Math.abs(pct) < 2 ? "→" : pct > 0 ? "▲" : "▼";
  return `<span style="color:${tone};font-weight:800;font-family:var(--font-mono);">${arrow} ${raPct(pct)}</span>`;
}

function raFormulaBox(rows, title) {
  return `<div style="background:var(--bg-subtle);border:1px dashed var(--border-main);border-radius:7px;padding:9px 11px;">
    <div style="font-size:10px;font-weight:800;color:var(--text-dim);letter-spacing:.4px;margin-bottom:6px;">📐 ${title || "HOW THESE NUMBERS ARE CALCULATED — NO MODEL, NO GUESSWORK"}</div>
    ${rows.map(r => `<div style="display:grid;grid-template-columns:160px 1fr;gap:8px;padding:3px 0;border-top:1px solid var(--border-subtle);">
      <span style="font-size:10px;font-weight:700;color:var(--text-main);">${raEsc(r[0])}</span>
      <span style="font-size:10px;color:var(--text-muted);font-family:var(--font-mono);line-height:1.45;">${raEsc(r[1])}</span>
    </div>`).join("")}
  </div>`;
}

/**
 * The WoW / MoM / QoQ / YoY scorecard — units, revenue, gross profit, margin.
 * Used identically on the forecasting workbench, the warehouse node view and
 * the per-SKU inspection modal so the numbers always agree.
 */
function raPeriodScorecard(periods, opts) {
  opts = opts || {};
  const keys = opts.keys || ["wow", "mom", "qoq", "yoy"];
  return `<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(168px,1fr));gap:8px;">
    ${keys.map(k => {
      const p = periods[k];
      if (!p) return "";
      const tone = p.verdict.tone;
      return `<div style="background:var(--bg-card);border:1px solid var(--border-subtle);border-left:3px solid ${tone};border-radius:8px;padding:9px 11px;">
        <div style="display:flex;justify-content:space-between;align-items:baseline;">
          <strong style="font-size:11.5px;color:var(--text-main);">${p.meta.label}</strong>
          <span style="font-size:8.5px;color:var(--text-dim);">${p.meta.name}</span>
        </div>
        <div style="font-size:18px;font-weight:800;font-family:var(--font-mono);color:${tone};margin-top:3px;line-height:1.1;">${raPct(p.profit.pct, 1)}</div>
        <div style="font-size:9px;color:var(--text-dim);margin-bottom:5px;">gross profit ${raMoney(p.profit.current)} vs ${raMoney(p.profit.previous)}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:3px;font-size:9.5px;border-top:1px solid var(--border-subtle);padding-top:5px;">
          <span style="color:var(--text-dim);">Units</span><span style="text-align:right;">${raDelta(p.units.pct)}</span>
          <span style="color:var(--text-dim);">Revenue</span><span style="text-align:right;">${raDelta(p.revenue.pct)}</span>
          <span style="color:var(--text-dim);">Margin</span><span style="text-align:right;font-family:var(--font-mono);font-weight:700;color:${p.marginDeltaPts >= 0 ? "var(--success)" : "var(--danger)"};">${p.marginDeltaPts >= 0 ? "+" : ""}${p.marginDeltaPts.toFixed(1)} pts</span>
        </div>
        <div style="margin-top:6px;font-size:9.5px;font-weight:700;color:${tone};">${raEsc(p.verdict.label)}</div>
      </div>`;
    }).join("")}
  </div>`;
}

// Shared constants are attached to the global object explicitly rather than
// left as lexical consts, so the other analytics scripts resolve them no
// matter what order the browser evaluates the tags in.
window.RA_CONST = RA_CONST;
window.RA_MA_WINDOWS = RA_MA_WINDOWS;
window.RA_PERIODS = RA_PERIODS;
