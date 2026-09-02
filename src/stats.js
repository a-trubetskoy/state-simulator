// The scoring layer: everything that turns a stats map into numbers, rankings
// and display strings. Nothing here touches the DOM, the map, or the loaded
// data files — every function takes the stats map (or a plain array) it works
// on, so all of it can be read, tested and reasoned about on its own.
//
// A "stats map" is state id -> the accumulator computeStats builds in main.js:
// summed pop/gdp/landArea/votes/race counts, the derived rates (gdppc, bach,
// margin, mhi, life), and the seats and ev apportion stamps on afterwards.
//
// Whether a state counts is always passed in as an `isForeign` predicate
// rather than read from a module of its own. Units outside the union stay out
// of apportionment and out of every ranking, and the caller decides what
// "outside" means: the live foreign flag for the current map, or the
// as-loaded FOREIGN set for the original-map baseline.

import { quantileSorted } from "d3";

// DC is a state on the map but not in Congress: no senators, no House seats,
// and a fixed 3 electoral votes (23rd Amendment).
export const DC_SID = "11";

export const fmtPop = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? Math.round(n / 1e3) + "K"
  : String(n);
export const fmtBigMoney = (thousands) => {
  const d = thousands * 1000;
  return d >= 1e12 ? "$" + (d / 1e12).toFixed(2) + "T"
    : d >= 1e9 ? "$" + (d / 1e9).toFixed(1) + "B"
    : "$" + Math.round(d / 1e6) + "M";
};
export const fmtMoney = (d) => "$" + Math.round(d).toLocaleString("en-US");
export const fmtMoneyK = (d) => "$" + Math.round(d / 1e3) + "k";
export const fmtPct = (p) => p.toFixed(1) + "%";
export const fmtYears = (y) => y.toFixed(1) + " yrs";
export const fmtMargin = (m) =>
  Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1);
export const fmtArea = (sqmi) =>
  (sqmi >= 1e6 ? (sqmi / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : sqmi >= 1e3 ? Math.round(sqmi / 1e3) + "K"
  : Math.round(sqmi)) + " mi²";

// `has` marks states missing a stat's inputs so they show "—" instead of a
// fake zero and stay out of that ranking. `bar` picks the mini-bar style in
// the rankings list: scaled to the max, or diverging around zero.
export const STAT_DEFS = {
  pop: { get: (s) => s.pop, fmt: fmtPop, bar: "abs" },
  landArea: { get: (s) => s.landArea, fmt: fmtArea, bar: "abs" },
  gdp: { get: (s) => s.gdp, fmt: fmtBigMoney, has: (s) => s.gdp > 0, bar: "abs" },
  gdppc: { get: (s) => s.gdppc, fmt: fmtMoneyK, has: (s) => s.gdp > 0, bar: "abs" },
  mhi: { get: (s) => s.mhi, fmt: fmtMoney, has: (s) => s.incPop > 0, bar: "abs" },
  bach: { get: (s) => s.bach, fmt: fmtPct, bar: "abs" },
  life: { get: (s) => s.life, fmt: fmtYears, has: (s) => s.lifePop > 0, bar: "abs" },
  margin: { get: (s) => s.margin, fmt: fmtMargin, has: (s) => s.tot > 0, bar: "diverge" },
  ev: { get: (s) => s.ev, fmt: String, has: (s) => s.ev > 0, bar: "abs" },
  wht: { get: (s) => (s.rT ? (100 * s.rW) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  blk: { get: (s) => (s.rT ? (100 * s.rB) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  hsp: { get: (s) => (s.rT ? (100 * s.rH) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  asn: { get: (s) => (s.rT ? (100 * s.rA) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  nat: { get: (s) => (s.rT ? (100 * s.rN) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
};

// Data view: totals (population, GDP, electoral votes) become scaled symbols,
// because a total isn't a property of every point of a state; rates and
// margins apply everywhere, so they color whole states as choropleths.
export const SYMBOL_STATS = {
  pop: { mark: "circle", noun: "population", fill: [217, 123, 38, 115], edge: [156, 85, 20, 255] },
  gdp: { mark: "square", noun: "GDP", fill: [47, 143, 91, 115], edge: [30, 107, 64, 255] },
  ev: { mark: "dots", noun: "electoral votes", unit: "electoral vote", fill: [125, 102, 186, 115], edge: [86, 66, 138, 255] },
};

// Hues are re-stepped from the old muted set for the waffle's small dots:
// an 8px dot carries far less color than a bar segment, and the old steps
// failed colorblind-separation checks (White/Black blues nearly identical,
// Asian/Native a classic red-green pair). Same hue per group, more chroma,
// bigger lightness splits between neighbors.
export const RACE_GROUPS = [
  { key: "rW", label: "White", color: "#9db5d3" },
  { key: "rB", label: "Black", color: "#9b84d6" },
  { key: "rH", label: "Hispanic", color: "#efb14a" },
  { key: "rA", label: "Asian", color: "#74c48e" },
  { key: "rN", label: "Native", color: "#e08e64" },
];

// House apportionment: Huntington–Hill, 435 seats, DC excluded. Each state's
// House seats and electoral votes (seats plus two senators; a fixed 3 for DC)
// are stamped onto its stats, so electoral votes rank and map like any other
// stat. Foreign units are excluded too — until their territory is painted
// into a (custom or real) state, at which point that state's seats simply
// count the new population.
export function apportion(stats, isForeign) {
  const eligible = [...stats.entries()].filter(
    ([sid, s]) => sid !== DC_SID && !isForeign(sid) && s.n > 0 && s.pop > 0
  );
  const seats = new Map(eligible.map(([sid]) => [sid, 1]));
  let remaining = 435 - eligible.length;
  while (remaining-- > 0 && eligible.length) {
    let best = null;
    let bp = -1;
    for (const [sid, s] of eligible) {
      const n = seats.get(sid);
      const p = s.pop / Math.sqrt(n * (n + 1));
      if (p > bp) {
        bp = p;
        best = sid;
      }
    }
    seats.set(best, seats.get(best) + 1);
  }
  for (const [sid, s] of stats) {
    s.seats = seats.get(sid) ?? 0;
    // DC's fixed 3 only holds while it's actually in the union — the flag
    // menu can now send it (or any state) out, same as any other unit.
    s.ev = sid === DC_SID && !isForeign(sid) ? 3 : s.seats ? s.seats + 2 : 0;
  }
}

// A replay of the 2024 presidential vote, winner-take-all per state.
// Electoral votes come from the apportionment already stamped on the stats.
export function computeElections(stats) {
  const tally = { ev: { d: 0, r: 0, x: 0 } };
  for (const s of stats.values()) {
    if (s.n === 0 || s.pop === 0) continue;
    const side = s.dem > s.gop ? "d" : s.gop > s.dem ? "r" : "x";
    tally.ev[side] += s.ev;
  }
  return tally;
}

// The union rolled up as one unit: sums every in-union state's raw
// accumulators, then derives the rates exactly the way computeStats does per
// state, so a whole-USA card reads like any state card. Electoral votes sum
// the apportioned stamps (538 on the original map).
export function sumStats(stats, isForeign) {
  const t = {
    pop: 0, gdp: 0, landArea: 0, eduT: 0, eduB: 0, dem: 0, gop: 0, tot: 0,
    incSum: 0, incPop: 0, lifeSum: 0, lifePop: 0,
    rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0, n: 0, ev: 0,
  };
  for (const [sid, s] of stats) {
    if (s.n === 0 || isForeign(sid)) continue;
    for (const k of Object.keys(t)) t[k] += s[k];
  }
  t.gdppc = t.pop ? (t.gdp * 1000) / t.pop : 0;
  t.bach = t.eduT ? (100 * t.eduB) / t.eduT : 0;
  t.margin = t.tot ? (100 * (t.dem - t.gop)) / t.tot : 0;
  t.mhi = t.incPop ? t.incSum / t.incPop : 0;
  t.life = t.lifePop ? t.lifeSum / t.lifePop : 0;
  return t;
}

// Every stat's leaderboard at once: stat key -> state ids, best first.
export function ranksFor(stats, isForeign) {
  const out = {};
  for (const [key, def] of Object.entries(STAT_DEFS)) {
    out[key] = [...stats.entries()]
      // Units still outside the union rank nowhere; once their territory is
      // painted into a (custom or real) state — or the unit is admitted
      // whole — it counts.
      .filter(([sid, s]) => s.n > 0 && !isForeign(sid) && (!def.has || def.has(s)))
      // Ties (common for electoral votes) fall back to population.
      .sort((a, b) => def.get(b[1]) - def.get(a[1]) || b[1].pop - a[1].pop)
      .map(([sid]) => sid);
  }
  return out;
}

// Drops Tukey outliers (often DC, on a per-capita stat) before a choropleth's
// min/max or ends get sized, so one extreme state can't stretch the ramp and
// flatten it for everyone else. The outlier itself is still painted — its
// color just clamps to the ramp's deepest end instead of sitting mid-scale.
export function trimOutliers(vals) {
  if (vals.length < 4) return vals;
  const sorted = [...vals].sort((a, b) => a - b);
  const q1 = quantileSorted(sorted, 0.25);
  const q3 = quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return vals;
  const trimmed = sorted.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  return trimmed.length >= 2 ? trimmed : vals;
}
