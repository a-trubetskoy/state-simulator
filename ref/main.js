// Frozen copy of the pre-deck.gl SVG renderer, kept only so the new one can be
// screenshot-diffed against it. Delete once the migration is signed off.
import * as d3 from "d3";
import { feature, mesh, merge, neighbors } from "topojson-client";
import { PRESETS, resolvePreset } from "../src/presets.js";
import "./style.css";

const [topo, data, overlays] = await Promise.all([
  fetch("/data/us-counties-topo.json").then((r) => r.json()),
  fetch("/data/county-data.json").then((r) => r.json()),
  fetch("/data/map-overlays.json").then((r) => r.json()),
]);
const counties = feature(topo, topo.objects.counties).features;

// ------------------------------------------------------------------- model

const BASE_COLORS = [
  "#f5e29c", "#b5d99c", "#a3c8e8", "#f0b3ab", "#cdb6de", "#eaa96b", "#9cd6c6",
];
const CUSTOM_COLORS = [
  "#e63946", "#7b2cbf", "#f77f00", "#2a9d8f", "#4361ee",
  "#ef476f", "#06a77d", "#b5179e", "#ff8500", "#118ab2",
];

const DC_SID = "11";

const labDist = (a, b) => {
  const la = d3.lab(a);
  const lb = d3.lab(b);
  return Math.hypot(la.l - lb.l, la.a - lb.a, la.b - lb.b);
};
const similar = (a, b) => labDist(a, b) < 22;

const origAssign = new Map(counties.map((c) => [c.id, c.properties.st]));
let assign = new Map(origAssign);

const countyAdj = new Map();
const stateNeighbors = new Map();
{
  const geoms = topo.objects.counties.geometries;
  neighbors(geoms).forEach((adj, i) => {
    const a = geoms[i].id.slice(0, 2);
    countyAdj.set(geoms[i].id, adj.map((j) => geoms[j].id));
    for (const j of adj) {
      const b = geoms[j].id.slice(0, 2);
      if (a === b) continue;
      if (!stateNeighbors.has(a)) stateNeighbors.set(a, new Set());
      stateNeighbors.get(a).add(b);
    }
  });
}

const stateInfo = new Map();
{
  const degree = (s) => stateNeighbors.get(s)?.size ?? 0;
  Object.keys(data.states)
    .sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))
    .forEach((fips, i) => {
      const takenCount = new Map();
      for (const n of stateNeighbors.get(fips) ?? []) {
        const c = stateInfo.get(n)?.color;
        if (c) takenCount.set(c, (takenCount.get(c) ?? 0) + 1);
      }
      const start = i % BASE_COLORS.length;
      const rotated = BASE_COLORS.slice(start).concat(BASE_COLORS.slice(0, start));
      const color =
        rotated.find((c) => !takenCount.has(c)) ??
        rotated.reduce((best, c) => (takenCount.get(c) < takenCount.get(best) ? c : best));
      stateInfo.set(fips, { name: data.states[fips], color, custom: false });
    });
}

let customCount = 0;
let selected = null;
let paintMode = false;

const stateCounts = new Map();
function recountStates() {
  stateCounts.clear();
  for (const sid of assign.values()) stateCounts.set(sid, (stateCounts.get(sid) ?? 0) + 1);
}
recountStates();

function pickStateColor(neighborSids) {
  const avoid = neighborSids.map((sid) => stateInfo.get(sid)?.color).filter(Boolean);
  const ok = (c) => !avoid.some((a) => similar(a, c));
  return (
    BASE_COLORS.find(ok) ??
    CUSTOM_COLORS.find(ok) ??
    BASE_COLORS[customCount % BASE_COLORS.length]
  );
}

function leastUsedBaseColor() {
  const count = new Map(BASE_COLORS.map((c) => [c, 0]));
  for (const info of stateInfo.values()) {
    if (count.has(info.color)) count.set(info.color, count.get(info.color) + 1);
  }
  return [...count].sort((a, b) => a[1] - b[1])[0][0];
}

function borderingStates(fipsList) {
  const inRegion = new Set(fipsList);
  const out = new Set();
  for (const fips of fipsList) {
    for (const n of countyAdj.get(fips) ?? []) {
      if (!inRegion.has(n)) out.add(assign.get(n));
    }
  }
  return [...out];
}

function createState(name) {
  const id = "c" + ++customCount;
  stateInfo.set(id, { name, color: leastUsedBaseColor(), custom: true });
  return id;
}

function recolorState(sid) {
  const info = stateInfo.get(sid);
  if (!info?.custom) return;
  const fipsList = [...assign].filter(([, s]) => s === sid).map(([f]) => f);
  if (!fipsList.length) return;
  const nbrs = borderingStates(fipsList).filter((n) => n !== sid);
  const clash = nbrs.some((n) => similar(stateInfo.get(n).color, info.color));
  if (BASE_COLORS.includes(info.color) && !clash) return;
  const color = pickStateColor(nbrs);
  if (color !== info.color) {
    info.color = color;
    scheduleRefresh(true);
  }
}

function computeStats() {
  const m = new Map();
  for (const [fips, sid] of assign) {
    const c = data.counties[fips];
    let s = m.get(sid);
    if (!s) {
      m.set(
        sid,
        (s = {
          pop: 0, gdp: 0, eduT: 0, eduB: 0, dem: 0, gop: 0, tot: 0,
          incSum: 0, incPop: 0, rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0, n: 0,
        })
      );
    }
    s.pop += c.pop;
    s.gdp += c.gdp ?? 0;
    s.eduT += c.eduT;
    s.eduB += c.eduB;
    s.dem += c.dem ?? 0;
    s.gop += c.gop ?? 0;
    s.tot += c.tot ?? 0;
    if (c.mhi) {
      s.incSum += c.mhi * c.pop;
      s.incPop += c.pop;
    }
    s.rT += c.rT;
    s.rW += c.rW;
    s.rB += c.rB;
    s.rN += c.rN;
    s.rA += c.rA;
    s.rH += c.rH;
    s.n += 1;
  }
  for (const s of m.values()) {
    s.gdppc = s.pop ? (s.gdp * 1000) / s.pop : 0;
    s.bach = s.eduT ? (100 * s.eduB) / s.eduT : 0;
    s.margin = s.tot ? (100 * (s.dem - s.gop)) / s.tot : 0;
    s.mhi = s.incPop ? s.incSum / s.incPop : 0;
  }
  return m;
}

function computeElections(stats) {
  const eligible = [...stats.entries()].filter(
    ([sid, s]) => sid !== DC_SID && s.n > 0 && s.pop > 0
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

  const tally = {
    ev: { d: 0, r: 0, x: 0 },
    sen: { d: 0, r: 0, x: 0 },
    house: { d: 0, r: 0, x: 0 },
  };
  for (const [sid, s] of stats.entries()) {
    if (s.n === 0 || s.pop === 0) continue;
    const isDC = sid === DC_SID;
    const n = isDC ? 0 : seats.get(sid) ?? 0;
    const ev = isDC ? 3 : n + 2;
    const side = s.dem > s.gop ? "d" : s.gop > s.dem ? "r" : "x";
    const two = s.dem + s.gop;
    if (!two) {
      tally.ev.x += ev;
      tally.sen.x += isDC ? 0 : 2;
      tally.house.x += n;
      continue;
    }
    tally.ev[side] += ev;
    if (!isDC) {
      tally.sen[side] += 2;
      const dSeats = Math.min(n, Math.max(0, Math.round((s.dem / two) * n)));
      tally.house.d += dSeats;
      tally.house.r += n - dSeats;
    }
  }
  return { seats, tally };
}

const fmtPop = (n) =>
  n >= 1e6 ? (n / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : n >= 1e3 ? Math.round(n / 1e3) + "K"
  : String(n);
const fmtBigMoney = (thousands) => {
  const d = thousands * 1000;
  return d >= 1e12 ? "$" + (d / 1e12).toFixed(2) + "T"
    : d >= 1e9 ? "$" + (d / 1e9).toFixed(1) + "B"
    : "$" + Math.round(d / 1e6) + "M";
};
const fmtMoney = (d) => "$" + Math.round(d).toLocaleString("en-US");
const fmtPct = (p) => p.toFixed(1) + "%";
const fmtMargin = (m) =>
  Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1);

const STAT_DEFS = {
  pop: { get: (s) => s.pop, fmt: fmtPop, bar: "abs" },
  gdp: { get: (s) => s.gdp, fmt: fmtBigMoney, bar: "abs" },
  gdppc: { get: (s) => s.gdppc, fmt: fmtMoney, bar: "abs" },
  mhi: { get: (s) => s.mhi, fmt: fmtMoney, has: (s) => s.incPop > 0, bar: "abs" },
  bach: { get: (s) => s.bach, fmt: fmtPct, bar: "abs" },
  margin: { get: (s) => s.margin, fmt: fmtMargin, has: (s) => s.tot > 0, bar: "diverge" },
  wht: { get: (s) => (s.rT ? (100 * s.rW) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  blk: { get: (s) => (s.rT ? (100 * s.rB) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  hsp: { get: (s) => (s.rT ? (100 * s.rH) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
  asn: { get: (s) => (s.rT ? (100 * s.rA) / s.rT : 0), fmt: fmtPct, has: (s) => s.rT > 0, bar: "abs" },
};

const RACE_GROUPS = [
  { key: "rW", label: "White", color: "#7f9fc4" },
  { key: "rB", label: "Black", color: "#9678b6" },
  { key: "rH", label: "Hispanic", color: "#e0a353" },
  { key: "rA", label: "Asian", color: "#66b295" },
  { key: "rN", label: "Native", color: "#c47f72" },
];

// --------------------------------------------------------------------- map

const svg = d3.select("#map");
const defs = svg.append("defs");
const g = svg.append("g");
const path = d3.geoPath(
  d3.geoAlbersUsa().fitSize([975, 610], { type: "FeatureCollection", features: counties })
);

const waterG = g.append("g").attr("class", "water");
for (const f of overlays.lakes.features) {
  if (!f.properties.onland) waterG.append("path").attr("class", "lake").attr("d", path(f.geometry));
}
waterG
  .append("path")
  .attr("class", "coast-halo")
  .attr("d", path(overlays.coast))
  .attr("vector-effect", "non-scaling-stroke");
const nationD = path(merge(topo, topo.objects.counties.geometries));
g.append("path").attr("class", "nation-backing").attr("d", nationD);

const countySel = g
  .append("g")
  .selectAll("path")
  .data(counties)
  .join("path")
  .attr("class", "county")
  .attr("d", path)
  .attr("data-id", (d) => d.id);

const hoverPath = g.append("path").attr("class", "county-hover");

const countyLines = g
  .append("path")
  .attr("class", "county-lines")
  .attr("vector-effect", "non-scaling-stroke")
  .attr("d", path(mesh(topo, topo.objects.counties)));

defs.append("clipPath").attr("id", "nation-clip").append("path").attr("d", nationD);
const bandPath = g
  .append("path")
  .attr("class", "band")
  .attr("clip-path", "url(#nation-clip)")
  .attr("vector-effect", "non-scaling-stroke");

const exteriorBandD = path(mesh(topo, topo.objects.counties, (a, b) => a === b)) ?? "";
const borderPath = g.append("path").attr("class", "state-borders").attr("vector-effect", "non-scaling-stroke");

const lakesTopG = g.append("g").attr("class", "lakes-top");
for (const f of overlays.lakes.features) {
  if (f.properties.onland) {
    lakesTopG
      .append("path")
      .attr("class", "lake-top")
      .attr("d", path(f.geometry))
      .attr("vector-effect", "non-scaling-stroke");
  }
}

g.append("path")
  .attr("class", "coast-line")
  // The blue shoreline covers the ocean coast and the Great Lakes; the halo
  // above covers the ocean coast only.
  .attr("d", [path(overlays.coast), path(overlays.lakeshore)].filter(Boolean).join(""))
  .attr("vector-effect", "non-scaling-stroke");
g.append("path")
  .attr("class", "land-border")
  .attr("d", path(overlays.border))
  .attr("vector-effect", "non-scaling-stroke");

const selectedPath = g.append("path").attr("class", "selected-outline").attr("vector-effect", "non-scaling-stroke");

const pathById = new Map();
countySel.each(function (d) {
  pathById.set(d.id, this);
});

const zoom = d3
  .zoom()
  .scaleExtent([1, 16])
  .extent([[0, 0], [975, 610]])
  .translateExtent([[0, 0], [975, 610]])
  .filter((ev) => {
    if (ev.type === "wheel") return !ev.button;
    return !paintMode && !ev.button;
  })
  .on("zoom", (ev) => g.attr("transform", ev.transform));
svg.call(zoom).on("dblclick.zoom", null);

// Test hook: drive the reference view from the same numbers as the new one.
window.__setTransform = (k, x, y) => svg.call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(k));

// ----------------------------------------------------------------- refresh

let raf = 0;
let dirtyAll = true;
const dirty = new Set();

function scheduleRefresh(all = false) {
  if (all) dirtyAll = true;
  if (!raf) raf = requestAnimationFrame(doRefresh);
}

function doRefresh() {
  raf = 0;
  const isDim = (fips) => paintMode && assign.get(fips) !== selected;
  if (dirtyAll) {
    countySel
      .attr("fill", (d) => stateInfo.get(assign.get(d.id)).color)
      .classed("dim", (d) => isDim(d.id));
  } else {
    for (const fips of dirty) {
      const node = pathById.get(fips);
      node.setAttribute("fill", stateInfo.get(assign.get(fips)).color);
      node.classList.toggle("dim", isDim(fips));
    }
  }
  dirty.clear();
  dirtyAll = false;

  const interiorD =
    path(mesh(topo, topo.objects.counties, (a, b) => assign.get(a.id) !== assign.get(b.id))) ?? "";
  bandPath.attr("d", exteriorBandD + interiorD);
  borderPath.attr("d", interiorD || null);
  selectedPath.attr(
    "d",
    selected
      ? path(
          mesh(
            topo,
            topo.objects.counties,
            (a, b) => (assign.get(a.id) === selected) !== (assign.get(b.id) === selected)
          )
        )
      : null
  );
  selectedPath.style("stroke", selected ? d3.color(stateInfo.get(selected).color).darker(1.4) : null);

  renderSidebar();
}

// ---------------------------------------------------------------- painting

let brush = 0;

function setBrush(n) {
  brush = n;
  svg.classed("stroking", n !== 0);
}

function applyBrush(fips) {
  const target = brush === 2 ? origAssign.get(fips) : selected;
  const prev = assign.get(fips);
  if (!target || prev === target) return;
  assign.set(fips, target);
  stateCounts.set(prev, (stateCounts.get(prev) ?? 1) - 1);
  stateCounts.set(target, (stateCounts.get(target) ?? 0) + 1);
  dirty.add(fips);
  if (target === selected && stateCounts.get(target) === 1) recolorState(target);
  scheduleRefresh();
}

svg.on("pointerdown", (ev) => {
  const fips = ev.target.dataset?.id;
  if (!paintMode || !selected || !fips) return;
  setBrush(ev.button === 2 ? 2 : 1);
  ev.target.releasePointerCapture?.(ev.pointerId);
  ev.preventDefault();
  applyBrush(fips);
});
svg.on("pointerover", (ev) => {
  const fips = ev.target.dataset?.id;
  if (!brush || !fips) return;
  if (!(ev.buttons & (brush === 2 ? 2 : 1))) {
    setBrush(0);
    return;
  }
  applyBrush(fips);
});
window.addEventListener("pointerup", () => setBrush(0));
svg.on("contextmenu", (ev) => ev.preventDefault());

svg.on("click", (ev) => {
  if (paintMode) return;
  const fips = ev.target.dataset?.id;
  if (fips) select(assign.get(fips));
});

// ----------------------------------------------------------------- tooltip

const tooltip = document.getElementById("tooltip");
svg.on("pointermove", (ev) => {
  const fips = ev.target.dataset?.id;
  if (!fips) {
    tooltip.hidden = true;
    hoverPath.attr("d", null);
    return;
  }
  hoverPath.attr("d", pathById.get(fips).getAttribute("d"));
  const c = data.counties[fips];
  const margin = c.tot ? " · " + fmtMargin((100 * (c.dem - c.gop)) / c.tot) : "";
  const income = c.mhi ? `<br>${fmtMoney(c.mhi)} median income` : "";
  tooltip.innerHTML = `<b>${c.name}</b> · ${stateInfo.get(assign.get(fips)).name}<br>${fmtPop(c.pop)} people${margin}${income}`;
  tooltip.hidden = false;
  const wrap = document.getElementById("map-wrap").getBoundingClientRect();
  const x = ev.clientX - wrap.left;
  const y = ev.clientY - wrap.top;
  tooltip.style.left = Math.min(x + 14, wrap.width - tooltip.offsetWidth - 8) + "px";
  tooltip.style.top = Math.min(y + 18, wrap.height - tooltip.offsetHeight - 8) + "px";
});
svg.on("pointerleave", () => {
  tooltip.hidden = true;
  hoverPath.attr("d", null);
});

// ---------------------------------------------------------------- sidebar

const el = (id) => document.getElementById(id);
const rankStatSel = el("rank-stat");

function ranksFor(stats) {
  const out = {};
  for (const [key, def] of Object.entries(STAT_DEFS)) {
    out[key] = [...stats.entries()]
      .filter(([, s]) => s.n > 0 && (!def.has || def.has(s)))
      .sort((a, b) => def.get(b[1]) - def.get(a[1]))
      .map(([sid]) => sid);
  }
  return out;
}

function renderElections(tally) {
  const rows = [
    ["pres", tally.ev],
    ["sen", tally.sen],
    ["house", tally.house],
  ];
  for (const [id, t] of rows) {
    const total = t.d + t.r + t.x || 1;
    el(`e-${id}-d`).textContent = t.d;
    el(`e-${id}-r`).textContent = t.r;
    el(`e-${id}-d`).classList.toggle("win", t.d > total / 2);
    el(`e-${id}-r`).classList.toggle("win", t.r > total / 2);
    const [ed, ex, er] = el(`e-${id}-bar`).children;
    ed.style.width = (100 * t.d) / total + "%";
    ex.style.width = (100 * t.x) / total + "%";
    er.style.width = (100 * t.r) / total + "%";
  }
}

function renderRaceBar(s) {
  const wrap = el("race-wrap");
  if (!s.rT) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const named = RACE_GROUPS.map((rg) => ({ ...rg, pct: (100 * s[rg.key]) / s.rT }));
  const other = Math.max(0, 100 - named.reduce((sum, rg) => sum + rg.pct, 0));
  const segs = [...named, { label: "Other", color: "#a9a9a9", pct: other }];
  el("race-bar").innerHTML = segs
    .map(
      (rg) =>
        `<i title="${rg.label} ${rg.pct.toFixed(1)}%" style="width:${rg.pct}%;background:${rg.color}"></i>`
    )
    .join("");
  el("race-legend").innerHTML = segs
    .filter((rg) => rg.pct >= 1)
    .map((rg) => `<span><i style="background:${rg.color}"></i>${rg.label} ${Math.round(rg.pct)}%</span>`)
    .join("");
}

function renderSidebar() {
  const stats = computeStats();
  const ranks = ranksFor(stats);
  const elections = computeElections(stats);

  renderElections(elections.tally);

  el("empty-card").hidden = !!selected;
  el("state-card").hidden = !selected;
  if (selected) {
    const info = stateInfo.get(selected);
    const s = stats.get(selected) ?? {
      pop: 0, gdp: 0, gdppc: 0, bach: 0, mhi: 0, incPop: 0, tot: 0,
      rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0, n: 0,
    };
    el("state-dot").style.background = info.color;
    if (document.activeElement !== el("state-name")) el("state-name").value = info.name;
    el("v-pop").textContent = fmtPop(s.pop);
    el("v-gdp").textContent = fmtBigMoney(s.gdp);
    el("v-gdppc").textContent = fmtMoney(s.gdppc);
    el("v-mhi").textContent = s.incPop ? fmtMoney(s.mhi) : "—";
    el("v-bach").textContent = fmtPct(s.bach);
    el("v-margin").textContent = s.tot ? fmtMargin(s.margin) : "—";
    const seats = selected === DC_SID ? null : elections.seats.get(selected);
    el("v-seats").textContent = seats ?? "—";
    el("v-ev").textContent = selected === DC_SID ? 3 : seats ? seats + 2 : "—";
    el("v-n").textContent = s.n;
    for (const key of ["pop", "gdp", "gdppc", "mhi", "bach", "margin"]) {
      const i = ranks[key].indexOf(selected);
      el("r-" + key).textContent = i === -1 ? "—" : `#${i + 1} of ${ranks[key].length}`;
    }
    renderRaceBar(s);
  }

  const key = rankStatSel.value;
  const def = STAT_DEFS[key];
  const sids = ranks[key];
  const maxAbs = Math.max(1e-9, ...sids.map((sid) => Math.abs(def.get(stats.get(sid)))));
  el("rank-list").innerHTML = sids
    .map((sid, i) => {
      const info = stateInfo.get(sid);
      const v = def.get(stats.get(sid));
      const bar =
        def.bar === "diverge"
          ? `<span class="bar diverge"><i class="${v >= 0 ? "bd" : "br"}" style="width:${(50 * Math.abs(v)) / maxAbs}%"></i></span>`
          : `<span class="bar"><i style="width:${(100 * v) / maxAbs}%"></i></span>`;
      return `<li data-sid="${sid}" class="${sid === selected ? "sel" : ""}${info.custom ? " custom" : ""}">
        <span class="pos">${i + 1}</span>
        <span class="dot" style="background:${info.color}"></span>
        <span class="nm">${info.name}</span>
        ${bar}
        <span class="val">${def.fmt(v)}</span>
      </li>`;
    })
    .join("");
}

el("rank-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-sid]");
  if (li) select(li.dataset.sid);
});
rankStatSel.addEventListener("change", renderSidebar);

el("state-name").addEventListener("input", (ev) => {
  if (!selected) return;
  stateInfo.get(selected).name = ev.target.value || "Unnamed";
  el("paint-name").textContent = stateInfo.get(selected).name;
  renderSidebar();
});

function select(sid) {
  if (paintMode && sid !== selected) setPaintMode(false);
  selected = sid;
  scheduleRefresh();
}
window.__select = select;

// -------------------------------------------------------------- paint mode

function setPaintMode(on) {
  const wasPainting = paintMode;
  paintMode = on && !!selected;
  setBrush(0);
  if (wasPainting && !paintMode && selected) recolorState(selected);
  el("paint-banner").hidden = !paintMode;
  if (paintMode) el("paint-name").textContent = stateInfo.get(selected).name;
  el("edit-borders").textContent = paintMode ? "Done painting" : "Edit borders";
  svg.classed("painting", paintMode);
  scheduleRefresh(true);
}
window.__setPaintMode = setPaintMode;

el("edit-borders").addEventListener("click", () => setPaintMode(!paintMode));
el("paint-done").addEventListener("click", () => setPaintMode(false));
window.addEventListener("keydown", (ev) => {
  if (ev.key === "Escape") setPaintMode(false);
});

el("new-state").addEventListener("click", () => {
  const sid = createState(`New State ${customCount + 1}`);
  selected = sid;
  setPaintMode(true);
  scheduleRefresh();
  el("state-name").value = stateInfo.get(sid).name;
  el("state-name").focus();
  el("state-name").select();
});

el("reset").addEventListener("click", () => {
  assign = new Map(origAssign);
  for (const [sid, info] of stateInfo) if (info.custom) stateInfo.delete(sid);
  customCount = 0;
  selected = null;
  recountStates();
  setPaintMode(false);
  scheduleRefresh(true);
  svg.call(zoom.transform, d3.zoomIdentity);
});

el("reset-view").addEventListener("click", () => {
  svg.call(zoom.transform, d3.zoomIdentity);
});

// ----------------------------------------------------------------- presets

const searchInput = el("preset-search");
const presetMenu = el("preset-menu");

function renderPresetMenu(query) {
  const q = query.trim().toLowerCase();
  const hits = PRESETS.filter(
    (p) => !q || p.name.toLowerCase().includes(q) || p.desc.toLowerCase().includes(q)
  );
  presetMenu.innerHTML = hits.length
    ? hits
        .map(
          (p) => `<div class="preset-item" data-id="${p.id}">
            <b>${p.name}</b><small>${p.desc}</small>
          </div>`
        )
        .join("")
    : `<div class="preset-none">No matching presets</div>`;
  presetMenu.hidden = false;
}

function applyPreset(preset) {
  const fipsList = resolvePreset(preset, data.counties);
  const sid = createState(preset.name);
  for (const fips of fipsList) assign.set(fips, sid);
  recountStates();
  recolorState(sid);
  selected = sid;
  setPaintMode(false);
  scheduleRefresh(true);
}
window.__applyPreset = (id) => applyPreset(PRESETS.find((p) => p.id === id));

searchInput.addEventListener("focus", () => renderPresetMenu(searchInput.value));
searchInput.addEventListener("input", () => renderPresetMenu(searchInput.value));
searchInput.addEventListener("blur", () => setTimeout(() => (presetMenu.hidden = true), 150));
presetMenu.addEventListener("pointerdown", (ev) => {
  const item = ev.target.closest(".preset-item");
  if (!item) return;
  applyPreset(PRESETS.find((p) => p.id === item.dataset.id));
  searchInput.value = "";
  presetMenu.hidden = true;
  searchInput.blur();
});

// -------------------------------------------------------------------- init

el("sources").textContent =
  `Population: Census ${data.meta.popYear} · GDP: BEA ${data.meta.gdpYear} · ` +
  `Income: SAIPE ${data.meta.incomeYear} · Race/ethnicity: Census ${data.meta.raceYear} · ` +
  `Education: ACS ${data.meta.eduWindow} (adults 25+)` +
  (data.meta.electionYear ? ` · President: ${data.meta.electionYear} county returns` : "") +
  ` · Shorelines & lakes: Natural Earth`;

scheduleRefresh(true);
