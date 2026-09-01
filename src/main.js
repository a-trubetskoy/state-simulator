import * as d3 from "d3";
import { feature, merge, neighbors } from "topojson-client";
import { Deck, OrthographicView, COORDINATE_SYSTEM } from "@deck.gl/core";
import {
  PathLayer,
  PolygonLayer,
  ScatterplotLayer,
  SolidPolygonLayer,
} from "@deck.gl/layers";
import { DataFilterExtension, MaskExtension } from "@deck.gl/extensions";
import { PRESETS, resolvePreset, partialCounties } from "./presets.js";
import { createGlobeMap } from "./globe/map.js";
import { createStateLabeler } from "./labels.js";
import {
  allocatePieces,
  partsContain,
  reclassifyRecords,
  rewindGeometry,
  splitCountyGeometry,
  tractsAcrossCut,
} from "./split.js";
import "./style.css";

// The map covers all of North America: US counties, Canada's census
// divisions, and every Mexican state and Caribbean/Central American country
// as a single paintable unit. A Canadian division's initial "state" is its
// province; the rest are their own. Either way a unit paints into the union
// exactly like a county, so Calgary's division or the whole of Baja
// California can join a state.
// The fourth file is scenery: the land beyond the map's own units — South
// America, Eurasia, Africa, Oceania, Antarctica, Greenland — so that turning
// the globe shows a world instead of an empty sphere. Nothing about it is
// paintable, hoverable or countable; it is drawn and that is all.
const [topo, data, overlays, worldTopo] = await Promise.all([
  fetch("/data/na-counties-topo.json").then((r) => r.json()),
  fetch("/data/na-county-data.json").then((r) => r.json()),
  fetch("/data/na-map-overlays.json").then((r) => r.json()),
  fetch("/data/world-land.json").then((r) => r.json()),
]);
const counties = feature(topo, topo.objects.counties).features;
const worldLand = feature(worldTopo, worldTopo.objects.land).features;
// The globe renderer brings the lakes in as four tiers by area and the rivers
// as four by rank, fading each in with the zoom (see globe/layers.js). This path
// draws the first tier of each and leaves it there. A zoom here only pushes a
// new viewState — it never rebuilds the layer list — so following the zoom would
// mean rebuilding every layer on each wheel tick, which is the cost this path
// avoids during a gesture on purpose. The first tier is also the one that
// matters for parity: it holds every lake Natural Earth carved out of its own
// land, which is the set that has to be drawn or the continent shows holes.
const worldLakes = feature(worldTopo, worldTopo.objects.lakes1).features;
// The scenery's own lines, already told apart by the build so the map doesn't
// have to: `coast` is every edge where that land meets water, `borders` every
// edge where it meets another country, `lakeEdges` a lake's true shore with
// every lake-to-lake seam (Michigan/Huron at the Straits of Mackinac, and
// others) already dropped. Each is one MultiLineString, so the whole world's
// coastline projects in a single pass. The Panama seam is in neither of the
// first two — the map draws its own border there.
const worldCoast = feature(worldTopo, worldTopo.objects.coast).geometry;
const worldBorders = feature(worldTopo, worldTopo.objects.borders).geometry;
const worldLakeMesh = feature(worldTopo, worldTopo.objects.lakeEdges1).geometry;
// The world's rivers, the one thing in that file that is not scenery: they run
// over the map's own counties as much as over the land behind it. One
// MultiLineString per tier, like the meshes above, drawn like them in a single
// pass each. The first tier, for the reason given above the lakes.
const RIVER_TIERS = [{ group: "rivers1", width: 1 }];
const worldRivers = RIVER_TIERS.map((t) => ({
  ...t,
  geometry: feature(worldTopo, worldTopo.objects[t.group]).geometry,
}));

// Land area per unit, in square miles, straight from the same boundary
// geometry the map draws — not a separately published figure, so it can
// never drift from what's on screen. d3.geoArea gives the true spherical
// area of a lon/lat polygon (independent of any projection); the Census and
// StatCan cartographic files it's built from already exclude the Great
// Lakes and other named water, so this lines up with the usual "land area"
// convention without extra work.
const EARTH_RADIUS_KM = 6371;
const SQMI_PER_KM2 = 0.386102159;
for (const f of counties) {
  data.counties[f.id].landArea = d3.geoArea(f.geometry) * EARTH_RADIUS_KM ** 2 * SQMI_PER_KM2;
}

// States outside the US: the provinces, the Mexican states and the
// Caribbean/Central American countries. They stay out of Congress and the
// electoral college, and wear a uniform faint tan instead of a state color —
// until their territory is painted into a (custom or real) state, which is
// how a province joins the union.
const FOREIGN = new Set(data.foreign ?? []);

// ------------------------------------------------------------------- model

// A small palette of clearly distinct soft fills. States are colored
// map-style (four-color-theorem spirit): a greedy graph coloring guarantees
// no two bordering states share a fill. The palette is hand-picked to look
// good in any arrangement, so avoiding an exact repeat is the only
// constraint. Custom and admitted states draw from the same palette so the
// map stays uniform.
const BASE_COLORS = [
  "#f3dd88", "#c6d98c", "#b3d1ec", "#f3c2bc", "#d9c7e6", "#f0c792", "#b8e3d6",
];
// Reserve fills in the same soft style — pink, periwinkle, spring green —
// drawn on only when a state's neighbors wear every base color. They stay
// out of BASE_COLORS so the original map's coloring doesn't change.
const BACKUP_COLORS = ["#eec2d7", "#c0bfe8", "#abd9ad"];

// DC is a state on the map but not in Congress: no senators, no House seats,
// and a fixed 3 electoral votes (23rd Amendment).
const DC_SID = "11";

const origAssign = new Map(counties.map((c) => [c.id, c.properties.st]));
let assign = new Map(origAssign);

// FOREIGN holds state ids, and a unit's home state is what puts it outside
// the union: a Canadian census division's state is its province, while a
// Mexican state or a Caribbean country is its own. (Before Canada was broken
// into divisions the two coincided, and these tests read FOREIGN directly.)
const isForeignUnit = (id) => FOREIGN.has(origAssign.get(id));

// County and state adjacency, derived from shared TopoJSON arcs.
const countyAdj = new Map(); // fips -> [neighboring county fips]
const stateNeighbors = new Map(); // state fips -> Set of bordering state fips
{
  const geoms = topo.objects.counties.geometries;
  neighbors(geoms).forEach((adj, i) => {
    const a = geoms[i].properties.st;
    countyAdj.set(geoms[i].id, adj.map((j) => geoms[j].id));
    for (const j of adj) {
      const b = geoms[j].properties.st;
      if (a === b) continue;
      if (!stateNeighbors.has(a)) stateNeighbors.set(a, new Set());
      stateNeighbors.get(a).add(b);
    }
  });
  // The two sides of the US land border come from different sources (Census
  // vs Statistics Canada / Natural Earth) and share no arcs, so the walk
  // above can't see across it; the build ships the missing (county, foreign
  // unit) pairs with the seam segments.
  const addAdj = (x, y) => {
    const list = countyAdj.get(x) ?? [];
    if (!list.includes(y)) list.push(y);
    countyAdj.set(x, list);
  };
  const addNeighbor = (x, y) => {
    if (!stateNeighbors.has(x)) stateNeighbors.set(x, new Set());
    stateNeighbors.get(x).add(y);
  };
  for (const s of overlays.seams ?? []) {
    addAdj(s.c, s.f);
    addAdj(s.f, s.c);
    addNeighbor(origAssign.get(s.c), origAssign.get(s.f));
    addNeighbor(origAssign.get(s.f), origAssign.get(s.c));
  }
}

// Foreign units all share one near-white wash of the classic atlas tan: the
// convention for "on the map, but not in the union", kept faint enough to
// read as unpainted. Painting their territory into a state is what gives it
// a real color.
const FOREIGN_FILL = "#faf7f1";

const stateInfo = new Map(); // stateId -> { name, origName, color, custom, foreign }
{
  // Welsh–Powell: color highest-degree states first so the tricky ones (MO,
  // TN with 8 neighbors) get first pick. Rotating the palette per state keeps
  // the map varied instead of letting the first color dominate. Foreign units
  // stay out of the palette — they are all the same tan by design.
  const degree = (s) => stateNeighbors.get(s)?.size ?? 0;
  Object.keys(data.states)
    .filter((fips) => !FOREIGN.has(fips))
    .sort((a, b) => degree(b) - degree(a) || a.localeCompare(b))
    .forEach((fips, i) => {
      const takenCount = new Map();
      for (const n of stateNeighbors.get(fips) ?? []) {
        const c = stateInfo.get(n)?.color;
        if (c && c !== FOREIGN_FILL) takenCount.set(c, (takenCount.get(c) ?? 0) + 1);
      }
      const start = i % BASE_COLORS.length;
      const rotated = BASE_COLORS.slice(start).concat(BASE_COLORS.slice(0, start));
      const color =
        rotated.find((c) => !takenCount.has(c)) ??
        rotated.reduce((best, c) => (takenCount.get(c) < takenCount.get(best) ? c : best));
      // origName pins the official name, so a rename can be told apart from
      // an untouched state even though both keep the real fips id.
      stateInfo.set(fips, { name: data.states[fips], origName: data.states[fips], color, custom: false });
    });
  for (const id of FOREIGN)
    stateInfo.set(id, {
      name: data.states[id],
      origName: data.states[id],
      color: FOREIGN_FILL,
      custom: false,
      foreign: true,
    });
}

// The as-loaded coloring, so Reset can undo hand-picked colors along with
// everything else.
const origColors = new Map([...stateInfo].map(([sid, info]) => [sid, info.color]));

let customCount = 0;
let selected = null; // stateId or null
let paintMode = false;
let viewMode = "atlas"; // "atlas" | "data"
// Painting needs visible county lines, so paint mode always renders the atlas.
const inDataView = () => viewMode === "data" && !paintMode;

// Live county count per state, kept in sync as counties are painted.
const stateCounts = new Map();
function recountStates() {
  stateCounts.clear();
  for (const sid of assign.values()) stateCounts.set(sid, (stateCounts.get(sid) ?? 0) + 1);
}
recountStates();

// States whose territory no longer matches the original map: every custom
// state (it never had an original footprint) plus any original state that
// has given up or picked up a county.
function modifiedStates() {
  const mod = new Set();
  for (const [fips, sid] of assign) {
    const orig = origAssign.get(fips);
    if (sid !== orig) {
      mod.add(sid);
      mod.add(orig);
    }
  }
  // A foreign unit admitted to the union is a change of its own, even
  // before any county moves.
  for (const sid of FOREIGN) if (!stateInfo.get(sid).foreign) mod.add(sid);
  return mod;
}

// Rotates which color a tie favors, so a state with no neighbors to avoid
// (an admitted island like the Bahamas, Cuba, Haiti, Puerto Rico) doesn't
// always land on BASE_COLORS[0] — without it every isolated state comes in
// the same shade since there's nothing else to break the tie.
let colorRotation = 0;
function rotatedBaseColors() {
  const start = colorRotation++ % BASE_COLORS.length;
  return BASE_COLORS.slice(start).concat(BASE_COLORS.slice(0, start));
}

// Pick a base fill no neighbor is wearing, falling back to the backup tier
// when the base palette is exhausted. Foreign tan doesn't count as taken —
// it is the shared backdrop, not a claim on a palette slot, matching the
// initial coloring. With everything taken, use the base color the fewest
// neighbors wear.
function pickStateColor(neighborSids) {
  const taken = new Map();
  for (const sid of neighborSids) {
    const c = stateInfo.get(sid)?.color;
    if (c && c !== FOREIGN_FILL) taken.set(c, (taken.get(c) ?? 0) + 1);
  }
  const rotated = rotatedBaseColors();
  return (
    rotated.find((c) => !taken.has(c)) ??
    BACKUP_COLORS.find((c) => !taken.has(c)) ??
    rotated.reduce((best, c) => (taken.get(c) < taken.get(best) ? c : best))
  );
}

function leastUsedBaseColor() {
  const count = new Map(BASE_COLORS.map((c) => [c, 0]));
  for (const info of stateInfo.values()) {
    if (count.has(info.color)) count.set(info.color, count.get(info.color) + 1);
  }
  return rotatedBaseColors().reduce((best, c) => (count.get(c) < count.get(best) ? c : best));
}

// States currently bordering the given set of counties.
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
  // Provisional color; the real pick happens once the state has territory
  // and its neighbors are known (recolorState).
  stateInfo.set(id, { name, color: leastUsedBaseColor(), custom: true });
  return id;
}

// Re-pick a custom state's color from its actual surroundings: keep it
// unless a neighbor wears the same fill, then choose a free one.
function recolorState(sid) {
  const info = stateInfo.get(sid);
  if (!info?.custom) return;
  const fipsList = [...assign].filter(([, s]) => s === sid).map(([f]) => f);
  if (!fipsList.length) return;
  const nbrs = borderingStates(fipsList).filter((n) => n !== sid);
  if (!nbrs.some((n) => stateInfo.get(n).color === info.color)) return;
  const color = pickStateColor(nbrs);
  if (color !== info.color) {
    info.color = color;
    scheduleRefresh();
  }
}

// House apportionment: Huntington–Hill, 435 seats, DC excluded. Each state's
// House seats and electoral votes (seats plus two senators; a fixed 3 for DC)
// are stamped onto its stats, so electoral votes rank and map like any other
// stat. Foreign units are excluded too — until their territory is painted
// into a (custom or real) state, at which point that state's seats simply
// count the new population.
function apportion(stats) {
  const eligible = [...stats.entries()].filter(
    ([sid, s]) => sid !== DC_SID && !stateInfo.get(sid)?.foreign && s.n > 0 && s.pop > 0
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
    s.ev = sid === DC_SID ? 3 : s.seats ? s.seats + 2 : 0;
  }
}

function computeStats(assignMap = assign) {
  const m = new Map();
  for (const [fips, sid] of assignMap) {
    const c = data.counties[fips];
    let s = m.get(sid);
    if (!s) {
      m.set(
        sid,
        (s = {
          pop: 0, gdp: 0, landArea: 0, eduT: 0, eduB: 0, dem: 0, gop: 0, tot: 0,
          incSum: 0, incPop: 0, lifeSum: 0, lifePop: 0,
          rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0, n: 0,
        })
      );
    }
    s.pop += c.pop;
    s.gdp += c.gdp ?? 0;
    s.landArea += c.landArea ?? 0;
    s.eduT += c.eduT;
    s.eduB += c.eduB;
    s.dem += c.dem ?? 0;
    s.gop += c.gop ?? 0;
    s.tot += c.tot ?? 0;
    if (c.mhi) {
      s.incSum += c.mhi * c.pop;
      s.incPop += c.pop;
    }
    if (c.life) {
      s.lifeSum += c.life * c.pop;
      s.lifePop += c.pop;
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
    // Population-weighted mean of county medians — an approximation, since
    // medians aren't additive.
    s.mhi = s.incPop ? s.incSum / s.incPop : 0;
    // Same approximation for life expectancy, which isn't additive either.
    s.life = s.lifePop ? s.lifeSum / s.lifePop : 0;
  }
  apportion(m);
  return m;
}

// Stats are recomputed at most once per model change; everything that renders
// in between reads this cache.
let statsCache = null;
const getStats = () => (statsCache ??= computeStats());

// The original map's stats never change, so its ranking (used as the
// baseline for the rank-change indicator) is computed once, lazily. The
// original union never changes either: FOREIGN, not the live foreign flags,
// decides who ranked, so admitting a unit later can't rewrite the baseline.
let origRanksCache = null;
const getOrigRanks = () =>
  (origRanksCache ??= ranksFor(computeStats(origAssign), (sid) => FOREIGN.has(sid)));

// A replay of the 2024 presidential vote, winner-take-all per state.
// Electoral votes come from the apportionment already stamped on the stats.
function computeElections(stats) {
  const tally = { ev: { d: 0, r: 0, x: 0 } };
  for (const s of stats.values()) {
    if (s.n === 0 || s.pop === 0) continue;
    const side = s.dem > s.gop ? "d" : s.gop > s.dem ? "r" : "x";
    tally.ev[side] += s.ev;
  }
  return tally;
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
const fmtMoneyK = (d) => "$" + Math.round(d / 1e3) + "k";
const fmtPct = (p) => p.toFixed(1) + "%";
const fmtYears = (y) => y.toFixed(1) + " yrs";
const fmtMargin = (m) =>
  Math.abs(m) < 0.05 ? "Even" : (m > 0 ? "D+" : "R+") + Math.abs(m).toFixed(1);
const fmtArea = (sqmi) =>
  (sqmi >= 1e6 ? (sqmi / 1e6).toFixed(1).replace(/\.0$/, "") + "M"
  : sqmi >= 1e3 ? Math.round(sqmi / 1e3) + "K"
  : Math.round(sqmi)) + " mi²";

// `has` marks states missing a stat's inputs so they show "—" instead of a
// fake zero and stay out of that ranking. `bar` picks the mini-bar style in
// the rankings list: scaled to the max, or diverging around zero.
const STAT_DEFS = {
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
const SYMBOL_STATS = {
  pop: { mark: "circle", noun: "population", fill: [217, 123, 38, 115], edge: [156, 85, 20, 255] },
  gdp: { mark: "square", noun: "GDP", fill: [47, 143, 91, 115], edge: [30, 107, 64, 255] },
  ev: { mark: "dots", noun: "electoral votes", unit: "electoral vote", fill: [125, 102, 186, 115], edge: [86, 66, 138, 255] },
};

// Hues are re-stepped from the old muted set for the waffle's small dots:
// an 8px dot carries far less color than a bar segment, and the old steps
// failed colorblind-separation checks (White/Black blues nearly identical,
// Asian/Native a classic red-green pair). Same hue per group, more chroma,
// bigger lightness splits between neighbors.
const RACE_GROUPS = [
  { key: "rW", label: "White", color: "#5b8fd0" },
  { key: "rB", label: "Black", color: "#7b4fa6" },
  { key: "rH", label: "Hispanic", color: "#c98a20" },
  { key: "rA", label: "Asian", color: "#35a189" },
  { key: "rN", label: "Native", color: "#ad4f3f" },
];

// ------------------------------------------------------------- projection

// The map is drawn by deck.gl, which takes plain 2-D coordinates, so every
// shape is projected once at load into the same 975x610 space the map has
// always used. Recording the path context's moveTo/lineTo calls instead of
// letting geoPath build a string keeps d3's adaptive resampling, so the
// vertices handed to the GPU are exactly the ones geoPath drew.
//
// The projection is an orthographic globe centered on the continent — one
// view that lets everything from Panama to Ellesmere Island to the Aleutians
// share a frame without picking a distortion compromise. It is a still
// picture of the globe: pan and zoom move the picture, never the sphere, so
// the baked-coordinates architecture is untouched. Alaska and Hawaii draw in
// place like everything else, and are ALSO duplicated into two boxed insets
// (open by default, collapsible) so they stay usable while the view is
// parked on the lower 48. A duplicate carries the same unit id, so painting in an inset
// paints the globe copy too; everything derived from geometry (centroids,
// labels) reads only the globe copies.
//
// Crucially, the projection is fitted so the LOWER 48 fill the 975x610
// design box at zoom 1, exactly like the old US-only map — the rest of the
// continent simply extends past the box, reached by panning or zooming out
// below 1. Every size calibrated in map units (state name caps, data labels,
// symbol radii, dot pitches) was tuned against that scale and keeps working
// unchanged; fitting the whole continent into the box instead would render
// them all ~2.7x too large at the home view.
const regionOfState = (st) => (st === "02" ? "ak" : st === "15" ? "hi" : "main");
const INSET_OF = new Map(counties.map((f) => [f.id, regionOfState(f.properties.st)]));
const insetOf = (id) => INSET_OF.get(id) ?? "main";

const conusFeatures = counties.filter(
  (f) => !isForeignUnit(f.id) && insetOf(f.id) === "main"
);
// Which way the globe faces. This used to be a literal buried in the
// projection; it is a runtime parameter now, so nothing downstream — layers,
// masks, labels, hover, carving — is hardwired to North America. Turning the
// globe re-bakes the projected geometry (see bakeMain) and every one of those
// keeps working unchanged, which is what adding Europe or Asia later needs.
const HOME_ROTATION = [96, -45];
let viewRotation = [...HOME_ROTATION];

// The fit runs ONCE, at the home rotation, so the lower 48 fill the 975x610
// design box exactly as they always have. Scale and translate are frozen from
// it and never recomputed: turning the globe has to spin it under the viewer,
// and re-fitting per rotation would instead re-frame whatever swung into
// view, so the sphere would breathe as it turned. Translate is where the
// sub-viewer point lands on screen, so holding it fixed is precisely what
// pins the globe's center.
const HOME_FIT = d3
  .geoOrthographic()
  .rotate(HOME_ROTATION)
  .fitSize([975, 610], { type: "FeatureCollection", features: conusFeatures });
const GLOBE_SCALE = HOME_FIT.scale();
const GLOBE_TRANSLATE = HOME_FIT.translate();
const mainProjection = (rotate) =>
  d3.geoOrthographic().rotate(rotate).scale(GLOBE_SCALE).translate(GLOBE_TRANSLATE);

const PROJ = { main: HOME_FIT };

// C7. The globe renderer takes over the main map: the same orthographic view,
// drawn from geometry that lives on the sphere and turns with a mat3 uniform
// instead of being re-projected on the CPU. Everything else on this page is
// unchanged — the model, the stats, the sidebar, the presets, and the two inset
// boxes, which keep the deck.gl path and their own fixed cameras.
//
// `?deck` puts the old renderer back. That is not a hedge: the plan's decision
// point after C3 is "does it look identical to the current map side by side",
// and nothing else can answer it. C8 deletes the loser.
const USE_GLOBE = !/[?&]deck\b/.test(location.search);
// Counties the globe's carver asked for and was refused: a county duplicated
// into an inset box stays whole because the insets keep the deck path and
// cannot show a carve. Read (and cleared) by applyCarve to word its notice.
const carveSkips = new Set(); // fips
const globeMap = USE_GLOBE
  ? await createGlobeMap({
      canvas: document.getElementById("map-canvas"),
      features: counties,
      carve: {
        countyRows: data.counties,
        fetchTracts: (fips) => {
          if (insetOf(fips) !== "main") return carveSkips.add(fips), null;
          // A unit with no census tracts — a Canadian division, a Mexican
          // state, a Caribbean country — carves as one tract covering the
          // whole of it, so its numbers divide between the pieces by land
          // share alone (see the whole-unit note in src/globe/carve.js).
          if (isForeignUnit(fips)) return { whole: true };
          return tractFile(fips);
        },
      },
    })
  : null;
if (globeMap) {
  // The compiler fits the same projection to the same lower-48 features, so
  // this is a tautology until one of the two files changes and it stops being
  // one — at which point every pixel is half a continent out and nothing else
  // would say so.
  const cam = globeMap.geometry.camera;
  const off = Math.max(
    Math.abs(cam.globeScale - GLOBE_SCALE),
    Math.abs(cam.globeTranslate[0] - GLOBE_TRANSLATE[0]),
    Math.abs(cam.globeTranslate[1] - GLOBE_TRANSLATE[1])
  );
  if (off > 1e-6)
    throw new Error(
      `the compiled globe is fitted at ${cam.globeScale}/${cam.globeTranslate} and this map at ` +
        `${GLOBE_SCALE}/${GLOBE_TRANSLATE} — rerun npm run data:geometry`
    );
}

const makeTracer = (projection) => {
  const recorded = [];
  let line = null;
  const trace = d3.geoPath(projection, {
    moveTo(x, y) {
      recorded.push((line = [[x, y]]));
    },
    lineTo(x, y) {
      line.push([x, y]);
    },
    closePath() {},
    arc() {},
  });
  return (geometry) => {
    recorded.length = 0;
    trace(geometry);
    return recorded.slice();
  };
};
// ak/hi are registered below; "spin" is registered per frame while the globe
// is being turned, since the preview projects through a facing the rest of
// the map has not been baked to yet.
const tracers = { main: makeTracer(PROJ.main) };

// Every ring or line the projection emitted for one GeoJSON geometry.
function projectLines(geometry, region = "main") {
  return tracers[region](geometry);
}

// deck.gl's polygon layers take one outer ring plus its holes, so each part of
// a MultiPolygon becomes a record of its own. Ring roles are re-derived from
// winding rather than trusted from the source order: clipping (an inset's box,
// the globe's horizon, the antimeridian cut through the Aleutians) can split a
// polygon into several pieces, or emit a surviving hole before the outer ring
// it belongs to — the Northwest Territories in the Alaska box come out as
// [Great Bear Lake fragment, mainland]. geoPath draws outer rings clockwise on
// screen (negative signed area with y down) and holes counterclockwise.
function projectParts(geometry, props, region = "main") {
  const polygons =
    geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  const parts = [];
  for (const rings of polygons) {
    const projected = projectLines({ type: "Polygon", coordinates: rings }, region);
    const outerParts = [];
    const holes = [];
    for (const ring of projected) {
      if (ring.length < 3) continue;
      if (d3.polygonArea(ring) < 0) outerParts.push({ ...props, rings: [ring] });
      else holes.push(ring);
    }
    for (const hole of holes) {
      // A clipped hole shares at most a clip-edge stretch with its outer
      // ring, so testing vertices until one lands strictly inside is safe:
      // disjoint outer pieces can't contain any of a foreign hole's vertices.
      const home =
        outerParts.length === 1
          ? outerParts[0]
          : outerParts.find((p) => hole.some((pt) => d3.polygonContains(p.rings[0], pt)));
      home?.rings.push(hole);
    }
    parts.push(...outerParts);
  }
  return parts;
}

// Closed rings, ready for a PathLayer: repeating the first point is how deck.gl
// recognizes a loop and joins it instead of capping it. The record keeps the
// part's region so the rings split across the two decks like everything else.
const closedRings = (parts) =>
  parts.flatMap((p) => p.rings.map((r) => ({ region: p.region, path: [...r, r[0]] })));

// Every array the layers read. Each holds the globe copies (region "main",
// re-baked whenever the globe turns) followed by the AK/HI inset duplicates
// (fitted to fixed boxes, so baked once and simply re-appended). One array
// per kind rather than one per region because the two layer stacks filter by
// region anyway — only the order WITHIN a region decides what draws over
// what, and every bake preserves that order.
// They are mutated in place, never reassigned: long-lived captures hold them
// (the labeler was handed mainCountyParts at construction, and rebuildWorld's
// BASE_ snapshots are taken from them), and a fresh array would strand those.
const countyParts = [];
const nationParts = [];
const lakeParts = { under: [], over: [] };
const lakeEdges = { under: [], over: [] };
const coastPaths = [];
const shorePaths = [];
const borderPaths = [];
const edgeBandPaths = [];
const arcPaths = [];
const apronParts = [];
// The scenery land, its lakes, and its two sets of lines. Globe copies only:
// the two inset boxes are framed tight on Alaska and Hawaii, so nothing beyond
// the map's own units reaches them.
const worldParts = [];
const worldLakeParts = [];
const worldLakeEdges = [];
const worldCoastPaths = [];
const worldBorderPaths = [];
const worldRiverPaths = Object.fromEntries(RIVER_TIERS.map((t) => [t.group, []]));
// Globe furniture: the ocean disc and the graticule. The disc is analytic
// and rotation-independent — an
// orthographic sphere always projects to a circle of radius `scale` about
// `translate`, and both are frozen — so it is built once. The graticule is
// re-baked with everything else, since its lines do move with the facing.
const SPHERE_DISC = {
  region: "main",
  rings: [
    d3.range(512).map((i) => {
      const a = (i / 512) * 2 * Math.PI;
      return [
        GLOBE_TRANSLATE[0] + GLOBE_SCALE * Math.cos(a),
        GLOBE_TRANSLATE[1] + GLOBE_SCALE * Math.sin(a),
      ];
    }),
  ],
};
const GRATICULE = d3.geoGraticule10();
const graticulePaths = [];

// What the inset bake produced, kept aside so a main re-bake can put it back
// without re-projecting the boxes (their projections never move).
const INSET_BAKE = {
  countyParts: [],
  lakesUnder: [],
  lakesOver: [],
  coastPaths: [],
  shorePaths: [],
  borderPaths: [],
  arcPaths: [],
  apronParts: [],
};

// ----------------------------------------------------- home view and insets

// The home view IS the design box: the projection above puts the lower 48
// exactly there, so home is the identity transform, and the continent around
// it is context to pan into (or see whole by zooming out below 1).
const HOME_TRANSFORM = d3.zoomIdentity;

// The extent of the projected globe copies, for the zoom's lower bound and
// the label raster's coverage. Recomputed after every bake: turning the globe
// swings different land into view, and both consumers need the new extent.
// It stays tight around the land rather than covering the whole projected
// sphere, because the label raster allocates one cell per map unit over these
// bounds — a full-disc raster would be several times the cells for ocean.
const MAP_BOUNDS = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
function computeMapBounds() {
  // On the globe there is no baked geometry to measure, and no bake to hang
  // this off either: the facing changes every frame of a drag. A coarse point
  // set over the unit outlines, projected through the current rotation, is the
  // same answer for three orders of magnitude less work — a bound only cares
  // about extremes. See the plan's C7 note, which left this open.
  if (globeMap) {
    Object.assign(MAP_BOUNDS, globeMap.landBounds());
    return;
  }
  MAP_BOUNDS.x0 = MAP_BOUNDS.y0 = Infinity;
  MAP_BOUNDS.x1 = MAP_BOUNDS.y1 = -Infinity;
  for (const p of countyParts) {
    if (p.region !== "main") continue;
    for (const ring of p.rings)
      for (const [x, y] of ring) {
        if (x < MAP_BOUNDS.x0) MAP_BOUNDS.x0 = x;
        if (x > MAP_BOUNDS.x1) MAP_BOUNDS.x1 = x;
        if (y < MAP_BOUNDS.y0) MAP_BOUNDS.y0 = y;
        if (y > MAP_BOUNDS.y1) MAP_BOUNDS.y1 = y;
      }
  }
}

// The inset boxes are UI, not map: they render on their own canvas with a
// fixed camera that pins them to the map's bottom-left corner at constant
// pixel size, so panning and zooming the map leaves them put (see
// insetViewState below). The box coordinates here are the design space the
// inset projections are fitted into; the camera decides where on screen
// that space lands. Whatever map scrolls under an open box is hidden by a
// white backing.
// Both boxes sit flush against this design-space y, so resizing one only
// means changing its height — the y that keeps its bottom edge in place
// follows automatically instead of being worked out by hand each time.
const INSET_BOTTOM_Y = 618;
const inset = (x, w, h, name) => ({ x, y: INSET_BOTTOM_Y - h, w, h, name });
const INSET_GAP = 10;
const INSETS = {};
INSETS.ak = inset(8, 315, 266, "Alaska");
INSETS.hi = inset(INSETS.ak.x + INSETS.ak.w + INSET_GAP, 195, 120, "Hawaii");
{
  const fc = (region) => ({
    type: "FeatureCollection",
    features: counties.filter((f) => insetOf(f.id) === region),
  });
  const pad = (b) => {
    const p = 10;
    return [
      [b.x + p, b.y + p],
      [b.x + b.w - p, b.y + b.h - p],
    ];
  };
  // The Alaska inset frames the state's main body. Fitting the whole state
  // would spend most of the box on the Aleutian chain and shrink the
  // mainland, so polygon parts west of AK_INSET_WEST (or past the
  // antimeridian) stay out of the fit; the clip extent below cuts them at
  // the frame instead.
  const AK_INSET_WEST = -172;
  const akBody = {
    type: "FeatureCollection",
    features: counties
      .filter((f) => insetOf(f.id) === "ak")
      .flatMap((f) => {
        const polys =
          f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates;
        // Mean longitude of the outer ring is enough to sort parts: source
        // rings never cross the antimeridian (the far islands sit at
        // positive longitudes instead).
        const kept = polys.filter((rings) => {
          const lon = d3.mean(rings[0], (p) => p[0]);
          return lon > AK_INSET_WEST && lon < 0;
        });
        return kept.length
          ? [{ type: "Feature", geometry: { type: "MultiPolygon", coordinates: kept } }]
          : [];
      }),
  };
  // The same conic parameters geoAlbersUsa uses for its own AK/HI insets.
  PROJ.ak = d3
    .geoConicEqualArea()
    .rotate([154, 0])
    .parallels([55, 65])
    .fitExtent(pad(INSETS.ak), akBody);
  PROJ.hi = d3
    .geoConicEqualArea()
    .rotate([157, 0])
    .parallels([8, 18])
    .fitExtent(pad(INSETS.hi), fc("hi"));
  // Both inset projections clip at their box, so geometry the fit leaves
  // outside (the far Aleutians) cuts cleanly at the frame instead of
  // spilling across the map.
  const box = (b) => [
    [b.x, b.y],
    [b.x + b.w, b.y + b.h],
  ];
  PROJ.ak.clipExtent(box(INSETS.ak));
  PROJ.hi.clipExtent(box(INSETS.hi));
  tracers.ak = makeTracer(PROJ.ak);
  tracers.hi = makeTracer(PROJ.hi);
}

// Grouped and filtered views of countyParts. Both are mutated in place by
// assembleBake (and by rebuildWorld when a county is carved), never
// reassigned — the labeler holds mainCountyParts from construction on.
const partsByFips = new Map();
const mainCountyParts = [];

// Area-weighted centroid of each county in map coordinates: the globe copies
// for placing the data view's scaled symbols, and each inset's own copies
// (insetCountyGeo) for the same job inside the Alaska/Hawaii boxes.
const countyGeo = new Map();
const insetCountyGeo = { ak: new Map(), hi: new Map() };
function computeCountyGeo() {
  countyGeo.clear();
  insetCountyGeo.ak.clear();
  insetCountyGeo.hi.clear();
  // The globe's own centroids for the main map — one weighted sum per unit over
  // its compiled triangles, computed once and re-projected per facing, with the
  // far side of the world left out the way clipping used to leave it out. The
  // two inset boxes keep their fixed projections, so their copies still come
  // from the parts below.
  const targets = globeMap
    ? { ak: insetCountyGeo.ak, hi: insetCountyGeo.hi }
    : { main: countyGeo, ak: insetCountyGeo.ak, hi: insetCountyGeo.hi };
  if (globeMap) for (const [fips, g] of globeMap.centroids()) countyGeo.set(fips, g);
  for (const [fips, parts] of partsByFips) {
    const acc = {};
    for (const p of parts) {
      const a = Math.abs(d3.polygonArea(p.rings[0]));
      if (!a) continue;
      const [cx, cy] = d3.polygonCentroid(p.rings[0]);
      const t = acc[p.region] ?? (acc[p.region] = { x: 0, y: 0, a: 0 });
      t.x += cx * a;
      t.y += cy * a;
      t.a += a;
    }
    for (const region in acc) {
      const target = targets[region];
      if (!target) continue;
      const t = acc[region];
      target.set(fips, { x: t.x / t.a, y: t.y / t.a, area: t.a });
    }
  }
}
// ------------------------------------------------------------------- baking
//
// Everything below turns lon/lat source geometry into the projected plane the
// layers draw. It is split three ways so that turning the globe costs only
// the part that actually depends on the facing:
//
//   - the lon/lat FACTS (arc topology, apron rings, the merged land shape)
//     are computed once here: they describe the data, not the projection;
//   - bakeMain() re-projects those facts through the current rotation;
//   - bakeInsets() does the same through the two fixed inset projections,
//     once, because those boxes never move.
//
// assembleBake() then concatenates the two into the shared arrays and
// refreshes everything derived from them.

// The land shape: the white backing under the fills and the mask that clips
// the seam aprons to land. Globe only — each inset gets a plain white box as
// its backing instead.
const NATION_GEOMETRY = merge(topo, topo.objects.counties.geometries);

// One record per shared boundary segment, carrying the counties on either
// side. The hairline/state-border layer and the band mask draw from this
// single list and restyle segments through attribute updates (a color, a
// filter value), so painting a county never re-projects the borders. The
// selection outline draws a small cached subset of the list instead (see
// selectedEdges).
const ARC_RECORDS = [];
{
  const sides = [];
  for (const g of topo.objects.counties.geometries) {
    const rings = g.type === "Polygon" ? g.arcs : g.arcs.flat();
    for (const ring of rings) {
      for (const a of ring) (sides[a < 0 ? ~a : a] ??= []).push(g.id);
    }
  }
  const used = sides.flatMap((s, i) => (s ? [i] : []));
  const lines = feature(topo, {
    type: "MultiLineString",
    arcs: used.map((i) => [i]),
  }).geometry.coordinates;
  used.forEach((i, k) => {
    // topojson.mesh pairs an arc's first and last user, and an arc only one
    // county uses pairs with itself — which is how the nation's edge is told
    // apart from an interior border. Same pairing here.
    const s = sides[i];
    ARC_RECORDS.push({
      a: s[0],
      b: s[s.length - 1],
      arc: i,
      geometry: { type: "LineString", coordinates: lines[k] },
    });
  });
}

// Under-fill along the seam: the Natural Earth and Census lines disagree by
// up to a few km, so each foreign border unit gets a ribbon of dumb quads
// straddling the seam, drawn under the county fills and clipped to the land
// mask. Whatever the mismatch leaves uncovered shows the unit's own fill
// instead of the page background — including after a cross-border merge,
// when both sides wear the same color and the seam disappears entirely.
// The quads are built in lon/lat, so they are a fact about the border, not
// about the facing, and every bake simply re-projects them.
const APRON_RINGS = [];
{
  const APRON_KM = 6;
  const KM_PER_DEG = 111.32;
  for (const s of overlays.seams ?? []) {
    const pts = s.line;
    for (let i = 0; i < pts.length - 1; i++) {
      const [ax, ay] = pts[i];
      const [bx, by] = pts[i + 1];
      const kx = KM_PER_DEG * Math.cos((((ay + by) / 2) * Math.PI) / 180);
      const sx = (bx - ax) * kx;
      const sy = (by - ay) * KM_PER_DEG;
      const len = Math.hypot(sx, sy);
      if (!len) continue;
      const ux = sx / len;
      const uy = sy / len;
      const nx = -uy;
      const ny = ux;
      // Lengthwise overshoot covers the notches quads leave at joints; run
      // ends stay tight so the ribbon barely pokes past where the border
      // meets the sea (and the land mask clips what little it does).
      const e0 = i === 0 ? 0.5 : APRON_KM;
      const e1 = i === pts.length - 2 ? 0.5 : APRON_KM;
      const ring = [
        [ax + (-ux * e0 + nx * APRON_KM) / kx, ay + (-uy * e0 + ny * APRON_KM) / KM_PER_DEG],
        [bx + (ux * e1 + nx * APRON_KM) / kx, by + (uy * e1 + ny * APRON_KM) / KM_PER_DEG],
        [bx + (ux * e1 - nx * APRON_KM) / kx, by + (uy * e1 - ny * APRON_KM) / KM_PER_DEG],
        [ax + (-ux * e0 - nx * APRON_KM) / kx, ay + (-uy * e0 - ny * APRON_KM) / KM_PER_DEG],
      ];
      ring.push(ring[0]);
      APRON_RINGS.push({ fips: s.f, inset: insetOf(s.c), geometry: { type: "Polygon", coordinates: [ring] } });
    }
  }
}

// The map's outer boundary as classified runs, tagged with the region that
// owns them. Region-parameterized so the globe bake and the inset bake share
// one definition: the globe takes every run, while a box takes the runs its
// own land owns plus whatever foreign ("main"-tagged) run its clip extent
// catches — only the coasts beside the box's own land (BC's shore by the
// panhandle) survive that.
const projectRuns = (cls, region) =>
  overlays.boundary
    .filter((r) => r.cls === cls)
    .flatMap((r) => {
      const geometry = { type: "LineString", coordinates: r.line };
      if (region === "main" || r.region === region) {
        return projectLines(geometry, region).map((path) => ({ path, region, unit: r.unit }));
      }
      if (r.region !== "main") return [];
      const out = [];
      for (const path of projectLines(geometry, region)) {
        if (path.length >= 2) out.push({ path, region, unit: r.unit });
      }
      return out;
    });

// The map-edge entries of the border-band mask: every classified boundary
// run — coast, lakeshore, and the fixed dark border — wears the band while
// the unit that owns it is in the union. Classified runs, not whole
// boundary arcs, because one arc can carry both the international seam and
// a coastline (San Diego, the North Slope, Maine's Bay of Fundy shore,
// Minnesota's Superior shore): the assignment-aware seam segments below
// cover the seam stretch, and these runs cover the rest, so neither part
// goes bandless.
const edgeBandRecords = (runs) =>
  runs.map((r) => ({ a: r.unit, b: r.unit, edge: true, region: r.region, path: r.path }));

// Re-projects every globe copy through the current rotation. Returns a fresh
// set of main-region arrays; assembleBake puts them into the shared ones.
function bakeMain() {
  const out = {
    countyParts: counties.flatMap((f) => projectParts(f.geometry, { fips: f.id, region: "main" })),
    nationParts: projectParts(NATION_GEOMETRY, { region: "main" }),
    worldParts: worldLand.flatMap((f) => projectParts(f.geometry, { region: "main" })),
    worldLakeParts: worldLakes.flatMap((f) => projectParts(f.geometry, { region: "main" })),
    worldCoastPaths: projectLines(worldCoast, "main").map((path) => ({ path, region: "main" })),
    worldBorderPaths: projectLines(worldBorders, "main").map((path) => ({ path, region: "main" })),
    worldLakeEdgePaths: projectLines(worldLakeMesh, "main").map((path) => ({ path, region: "main" })),
    worldRiverPaths: Object.fromEntries(
      worldRivers.map((t) => [
        t.group,
        projectLines(t.geometry, "main").map((path) => ({ path, region: "main" })),
      ])
    ),
    lakesUnder: [],
    lakesOver: [],
    arcPaths: [],
    apronParts: [],
  };
  for (const f of overlays.lakes.features) {
    const key = f.properties.onland ? "lakesOver" : "lakesUnder";
    out[key].push(...projectParts(f.geometry, { region: "main" }));
  }
  const coastPaths = projectRuns("coast", "main");
  // Great Lakes shorelines share the coast's blue line but not its halo — the
  // lake fill already reads as water, so a halo would just ring it in an off
  // shade.
  out.coastPaths = coastPaths;
  out.shorePaths = [...coastPaths, ...projectRuns("lakeshore", "main")];
  // Land borders with territory beyond the map's units (Panama–Colombia): a
  // fixed dark line.
  out.borderPaths = projectRuns("border", "main");

  for (const r of ARC_RECORDS) {
    for (const path of projectLines(r.geometry, "main")) {
      if (path.length >= 2)
        out.arcPaths.push({ a: r.a, b: r.b, arc: r.arc, region: "main", path });
    }
  }
  // The US–Canada/Mexico seam: the two sides come from different sources and
  // share no arcs, so the build ships the Census side of the border as
  // segments annotated with the county and foreign unit that flank it.
  // Appended here with a/b set to that pair, a seam segment renders and
  // filters exactly like a shared-arc state border — paint Alberta into
  // Montana's state and the line disappears. The classified boundary runs
  // (the edge records above) leave the seam stretch out, so these segments
  // are the band's only claim there.
  for (const s of overlays.seams ?? []) {
    const geometry = { type: "LineString", coordinates: s.line };
    for (const path of projectLines(geometry, "main")) {
      if (path.length >= 2)
        out.arcPaths.push({ a: s.c, b: s.f, arc: -1, region: "main", path });
    }
  }
  for (const a of APRON_RINGS) {
    out.apronParts.push(...projectParts(a.geometry, { fips: a.fips, region: "main" }));
  }
  out.graticulePaths = projectLines(GRATICULE, "main").map((path) => ({ path, region: "main" }));
  return out;
}

// The same, through the two fixed inset projections. Run once: the boxes are
// pinned UI, so their geometry never depends on which way the globe faces.
function bakeInsets() {
  // Foreign land the boxes frame (Yukon and British Columbia beside Alaska):
  // every foreign unit is run through each inset projection and whatever
  // survives its clip extent is kept, so a box shows the same faded
  // neighbors the globe does instead of bare sea beyond the border. Foreign
  // parts go first, like the globe copies (the source data leads with them),
  // so the Census county shapes paint over any overlap along the seam.
  for (const region of ["ak", "hi"]) {
    for (const f of counties) {
      if (isForeignUnit(f.id))
        INSET_BAKE.countyParts.push(...projectParts(f.geometry, { fips: f.id, region }, region));
    }
  }
  for (const f of counties) {
    const region = insetOf(f.id);
    if (region !== "main")
      INSET_BAKE.countyParts.push(...projectParts(f.geometry, { fips: f.id, region }, region));
  }
  // The boxes frame foreign land, and that land's carved lakes with it: the
  // Alaska box's top corner holds a slice of the Northwest Territories with
  // part of Great Bear Lake. Every lake is offered to each inset projection
  // and the clip extent keeps whatever falls inside the box, so a carved
  // hole there shows lake blue instead of the backing's white.
  for (const f of overlays.lakes.features) {
    const key = f.properties.onland ? "lakesOver" : "lakesUnder";
    for (const region of ["ak", "hi"]) {
      INSET_BAKE[key].push(...projectParts(f.geometry, { region }, region));
    }
  }
  for (const region of ["ak", "hi"]) {
    const coast = projectRuns("coast", region);
    INSET_BAKE.coastPaths.push(...coast);
    INSET_BAKE.shorePaths.push(...coast, ...projectRuns("lakeshore", region));
    INSET_BAKE.borderPaths.push(...projectRuns("border", region));
    for (const r of ARC_RECORDS) {
      // An arc goes to its own unit's box, and a foreign arc (the Yukon–BC
      // line, foreign coastlines) to whichever box's clip catches it, so the
      // hairlines and the border filters treat that land exactly as the globe
      // does — including the grey line and band appearing once a unit is
      // painted into the union.
      const own = insetOf(r.a);
      if (own !== region && !(own === "main" && isForeignUnit(r.a))) continue;
      for (const path of projectLines(r.geometry, region)) {
        if (path.length >= 2)
          INSET_BAKE.arcPaths.push({ a: r.a, b: r.b, arc: r.arc, region, path });
      }
    }
  }
  // Alaska's seam segments are duplicated into its box, where they draw
  // Alaska's Canada edge, and its aprons follow for the same reason.
  for (const s of overlays.seams ?? []) {
    if (insetOf(s.c) !== "ak") continue;
    const geometry = { type: "LineString", coordinates: s.line };
    for (const path of projectLines(geometry, "ak")) {
      if (path.length >= 2)
        INSET_BAKE.arcPaths.push({ a: s.c, b: s.f, arc: -1, region: "ak", path });
    }
  }
  for (const a of APRON_RINGS) {
    if (a.inset === "main") continue;
    INSET_BAKE.apronParts.push(
      ...projectParts(a.geometry, { fips: a.fips, region: a.inset }, a.inset)
    );
  }
}

// Puts a fresh main bake and the fixed inset bake into the shared arrays, in
// place, and refreshes everything read off them.
function assembleBake(main) {
  // Element-by-element, not push(...source): these arrays run to tens of
  // thousands of parts, and a spread passes every one as a call argument.
  const put = (target, ...sources) => {
    target.length = 0;
    for (const s of sources) for (const v of s) target.push(v);
  };
  put(countyParts, main.countyParts, INSET_BAKE.countyParts);
  put(nationParts, main.nationParts);
  put(worldParts, main.worldParts);
  put(worldLakeParts, main.worldLakeParts);
  put(worldLakeEdges, main.worldLakeEdgePaths);
  put(worldCoastPaths, main.worldCoastPaths);
  put(worldBorderPaths, main.worldBorderPaths);
  for (const t of RIVER_TIERS) put(worldRiverPaths[t.group], main.worldRiverPaths[t.group]);
  put(lakeParts.under, main.lakesUnder, INSET_BAKE.lakesUnder);
  put(lakeParts.over, main.lakesOver, INSET_BAKE.lakesOver);
  put(lakeEdges.under, closedRings(lakeParts.under));
  put(lakeEdges.over, closedRings(lakeParts.over));
  put(coastPaths, main.coastPaths, INSET_BAKE.coastPaths);
  put(shorePaths, main.shorePaths, INSET_BAKE.shorePaths);
  put(borderPaths, main.borderPaths, INSET_BAKE.borderPaths);
  put(edgeBandPaths, edgeBandRecords([...shorePaths, ...borderPaths]));
  put(arcPaths, main.arcPaths, INSET_BAKE.arcPaths);
  put(apronParts, main.apronParts, INSET_BAKE.apronParts);
  put(graticulePaths, main.graticulePaths);

  put(mainCountyParts, countyParts.filter((p) => p.region === "main"));
  partsByFips.clear();
  for (const p of countyParts) {
    const list = partsByFips.get(p.fips);
    if (list) list.push(p);
    else partsByFips.set(p.fips, [p]);
  }
  computeCountyGeo();
  computeMapBounds();
}

bakeInsets();
assembleBake(bakeMain());

// The globe copies are always drawn; the inset duplicates render in a
// second deck on a canvas above the map, over a white backing (so they
// cover whatever map happens to lie under the box). Both boxes start open —
// except on a narrow screen (the stylesheet's stacked-layout cutoff), where
// their fixed pixel size would cover most of the map; the toggle buttons
// still open them. Collapsing a box just filters its region out of the inset
// arrays; the main arrays never change, so deck's layer data stays
// referentially stable across ordinary refreshes.
const narrowScreen = window.matchMedia("(max-width: 800px)");
const insetHidden = { ak: narrowScreen.matches, hi: narrowScreen.matches };
const isMain = (d) => d.region === "main";

// ------------------------------------------------ carves: base plus overlay

// A carved county stops being a unit and its pieces take its place: a
// partition of its tracts, two pieces after the first cut and more as later
// cuts refine it (see split.js). The arrays the layers read are therefore
// derived: the as-loaded BASE arrays with each carved parent removed and its
// pieces' records added. Crucially, the parent's original boundary records
// are re-owned from the CURRENT world on every rebuild — not patched per
// carve — so a neighbour carved later, or a piece carved again, can never
// leave a record naming a retired unit. Carves are rare events, so the
// derived arrays rebuild wholesale; what matters is that BETWEEN carves
// every layer keeps referentially stable data. The working arrays
// (countyParts, mainCountyParts, arcPaths, edgeBandPaths, and the maps)
// mutate in place because long-lived captures hold them — the labeler was
// handed mainCountyParts at construction — while MAIN/INSET_ALL get fresh
// filtered snapshots so deck.gl notices the change.
const splits = new Map(); // parentId -> { pieces, backingId, idSeq, origState, parentPartsByRegion, ...splitCountyGeometry() }
// The globe path's counterpart of `splits`: C6's carver owns the cuts and the
// pieces (inside globeMap), and these two hold what the APP remembers about
// them — the states a carved county came from, and which piece rows are
// registered in the model right now. See syncGlobeCarves.
const globeCarveMeta = new Map(); // parent fips -> { origState, parentState, largestPiece }
let globePieceIndex = new Map(); // piece id -> the registered piece
let carveMode = false; // the Carve button's knife tool is armed
let carvePending = []; // click-to-draw knife vertices awaiting their finish
let knifeDrag = null; // a left press while carving, until it settles as drag or click
let carving = false; // a finished stroke, GeoJSON import, or preset carve is being applied (tract fetches)

// The as-baked world, before any carve: what rebuildWorld re-derives from
// every time carves change. Re-snapshotted after a re-bake, since turning the
// globe replaces every projected coordinate in them. Adjacency is not in that
// group — it comes from the topology, which no rotation can change — so
// BASE_ADJ is taken once.
const BASE_COUNTY_PARTS = [];
const BASE_ARC_PATHS = [];
const BASE_EDGE_BAND = [];
function snapshotBase() {
  const put = (target, source) => {
    target.length = 0;
    for (const v of source) target.push(v);
  };
  put(BASE_COUNTY_PARTS, countyParts);
  put(BASE_ARC_PATHS, arcPaths);
  put(BASE_EDGE_BAND, edgeBandPaths);
}
snapshotBase();
const BASE_ADJ = new Map([...countyAdj].map(([k, v]) => [k, v.slice()]));

function rebuildWorld() {
  const parents = new Set(splits.keys());
  const all = [...splits.values()];

  // Boundary records touching a carved county are re-owned from the current
  // partitions (see split.js's reclassifyRecords): a probe just inside the
  // drawn line asks which piece — or which un-carved neighbour — flanks it.
  const pieceParent = new Map();
  for (const [pid, s] of splits) for (const p of s.pieces) pieceParent.set(p.id, pid);
  const touched = (r) => parents.has(r.a) || parents.has(r.b);
  const opts = {
    ownerAt: (pt, r) => {
      let inFringe = false;
      for (const id of r.a === r.b ? [r.a] : [r.a, r.b]) {
        const s = splits.get(id);
        if (!s) continue;
        const c = s.contains.get(r.region);
        if (!c || !c.parent(pt)) continue;
        for (const [pid, inPiece] of c.pieces) if (inPiece(pt)) return pid;
        // Inside the drawn county but between its true tract unions — the
        // drawn-versus-true fringe. Unresolved on purpose: the ladder's
        // deeper probes will land in the piece whose territory lies beyond,
        // so a fringe stretch never reads as the backing piece's border.
        inFringe = true;
        break;
      }
      if (inFringe) return null;
      const aSplit = parents.has(r.a);
      const bSplit = parents.has(r.b);
      if (aSplit && bSplit) return null;
      return aSplit ? r.b : r.a; // outside the carved side: the un-carved neighbour owns it
    },
    defaultsFor: (r) => [splits.get(r.a)?.backingId ?? r.a, splits.get(r.b)?.backingId ?? r.b],
    familyOf: (id) => pieceParent.get(id) ?? id,
  };
  const reownedArcs = reclassifyRecords(BASE_ARC_PATHS.filter(touched), opts);
  const reownedEdges = reclassifyRecords(BASE_EDGE_BAND.filter(touched), opts);
  arcPaths.length = 0;
  arcPaths.push(
    ...BASE_ARC_PATHS.filter((r) => !touched(r)),
    ...reownedArcs,
    ...all.flatMap((s) => s.dividerRecords)
  );
  edgeBandPaths.length = 0;
  edgeBandPaths.push(...BASE_EDGE_BAND.filter((r) => !touched(r)), ...reownedEdges);

  // Carved parts lead the fill array so every base county draws over them:
  // the neighbours' fills clip whatever the tract-detail pieces poke past
  // the drawn county line (split.js explains the two-source mismatch).
  // Order within the carved block: backings, then the fringe ribbons cut
  // from the re-owned records above, then the piece unions — so the fringe
  // wears its OWNER's color, not the backing's, and the fills agree with the
  // border classification to the pixel.
  countyParts.length = 0;
  countyParts.push(
    ...all.flatMap((s) => s.backingParts),
    ...fringeRibbons([...reownedArcs, ...reownedEdges], pieceParent),
    ...all.flatMap((s) => s.pieceParts),
    ...BASE_COUNTY_PARTS.filter((p) => !parents.has(p.fips))
  );
  mainCountyParts.length = 0;
  for (const p of countyParts) if (p.region === "main") mainCountyParts.push(p);

  partsByFips.clear();
  for (const p of countyParts) {
    const list = partsByFips.get(p.fips);
    if (list) list.push(p);
    else partsByFips.set(p.fips, [p]);
  }
  // The backing piece renders as the parent-shaped backing, which must not
  // serve as any piece's hover shape or centroid — each piece's own tract
  // union does.
  for (const s of all) for (const [pid, parts] of s.hoverParts) partsByFips.set(pid, parts);

  // Adjacency: base pairs minus carved parents, then every pair the
  // re-owned records and the dividers actually draw — which is exactly what
  // borders a piece.
  countyAdj.clear();
  for (const [k, v] of BASE_ADJ)
    if (!parents.has(k)) countyAdj.set(k, v.filter((n) => !parents.has(n)));
  const addAdj = (x, y) => {
    const list = countyAdj.get(x) ?? [];
    if (!list.includes(y)) list.push(y);
    countyAdj.set(x, list);
  };
  for (const r of arcPaths) {
    if (r.a === r.b) continue;
    if (!pieceParent.has(r.a) && !pieceParent.has(r.b)) continue;
    addAdj(r.a, r.b);
    addAdj(r.b, r.a);
  }
  computeCountyGeo();
  rebuildDerived();
}

// The fringe between a piece's true tract union and its county's drawn
// outline is covered by the parent-shaped backing, which wears the WRONG
// color wherever the stretch belongs to a different piece — thin slivers of
// a foreign state tracing county lines. Each piece-owned boundary run
// therefore gets a ribbon of dumb quads extruded just inside the drawn line
// in that piece's own fips, drawn over the backing and under the true
// unions (the same trick as the border seam's aprons): the unions cover the
// ribbon wherever real territory exists, so only the fringe ever shows it.
// Overshoot past the drawn line is clipped by the neighbours' fills, which
// draw later. Depth is the map's own simplification tolerance — the bound
// on how far drawn and true can disagree.
function fringeRibbons(records, pieceParent) {
  const DEPTH = 0.35; // design units, ~1.6 km of ground
  const out = [];
  for (const r of records) {
    const sides = r.a === r.b ? [r.a] : [r.a, r.b];
    for (const pid of sides) {
      const parent = pieceParent.get(pid);
      if (!parent) continue;
      const s = splits.get(parent);
      if (pid === s.backingId) continue; // the backing already paints its own fringe
      const inParent = s.contains.get(r.region)?.parent;
      if (!inParent) continue;
      const path = r.path;
      for (let i = 0; i < path.length - 1; i++) {
        const [x1, y1] = path[i];
        const [x2, y2] = path[i + 1];
        const dx = x2 - x1;
        const dy = y2 - y1;
        const len = Math.hypot(dx, dy);
        if (!len) continue;
        const ux = dx / len;
        const uy = dy / len;
        const nx = -uy;
        const ny = ux;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        // extrude toward the piece's own county
        const sgn = inParent([mx + nx * 0.05, my + ny * 0.05])
          ? 1
          : inParent([mx - nx * 0.05, my - ny * 0.05])
            ? -1
            : 0;
        if (!sgn) continue;
        const ox = nx * sgn * DEPTH;
        const oy = ny * sgn * DEPTH;
        // lengthwise overshoot closes the notches quads leave at joints
        const e = Math.min(DEPTH, len);
        out.push({
          fips: pid,
          region: r.region,
          rings: [
            [
              [x1 - ux * e, y1 - uy * e],
              [x2 + ux * e, y2 + uy * e],
              [x2 + ux * e + ox, y2 + uy * e + oy],
              [x1 - ux * e + ox, y1 - uy * e + oy],
            ],
          ],
        });
      }
    }
  }
  return out;
}

// The per-deck slices of every shared array. Both objects are filled by
// rebuildDerived, which hands out FRESH arrays each time: deck.gl re-uploads
// a layer's buffers when its `data` reference changes, so mutating a shared
// array in place (which a re-bake does, to keep long-lived captures valid)
// would otherwise leave the GPU drawing the old geometry.
const MAIN = {};
const INSET_ALL = {};
let V = {};
function rebuildVisible() {
  const open = (arr) => arr.filter((d) => !insetHidden[d.region]);
  V = {
    countyParts: open(INSET_ALL.countyParts),
    arcPaths: open(INSET_ALL.arcPaths),
    bandMaskPaths: open(INSET_ALL.bandMaskPaths),
    coastPaths: open(INSET_ALL.coastPaths),
    shorePaths: open(INSET_ALL.shorePaths),
    apronParts: open(INSET_ALL.apronParts),
    lakesUnder: open(INSET_ALL.lakesUnder),
    lakesOver: open(INSET_ALL.lakesOver),
    lakeEdgesUnder: open(INSET_ALL.lakeEdgesUnder),
    lakeEdgesOver: open(INSET_ALL.lakeEdgesOver),
    backing: ["ak", "hi"]
      .filter((k) => !insetHidden[k])
      .map((k) => {
        const b = INSETS[k];
        return {
          rings: [
            [
              [b.x, b.y],
              [b.x + b.w, b.y],
              [b.x + b.w, b.y + b.h],
              [b.x, b.y + b.h],
            ],
          ],
        };
      }),
  };
}

function rebuildDerived() {
  // The band mask reads interior segments (shared arcs, the seam entries,
  // and a split's divider — the outer-boundary arcs, a === b, are covered by
  // the edge runs instead) plus the edge runs themselves.
  const bandMaskPaths = [...arcPaths.filter((d) => d.a !== d.b), ...edgeBandPaths];
  const notMain = (d) => !isMain(d);
  MAIN.countyParts = mainCountyParts.slice();
  MAIN.arcPaths = arcPaths.filter(isMain);
  MAIN.bandMaskPaths = bandMaskPaths.filter(isMain);
  MAIN.nationParts = nationParts.slice();
  MAIN.worldParts = worldParts.slice();
  MAIN.worldLakeParts = worldLakeParts.slice();
  MAIN.worldLakeEdges = worldLakeEdges.slice();
  MAIN.worldCoastPaths = worldCoastPaths.slice();
  MAIN.worldBorderPaths = worldBorderPaths.slice();
  MAIN.worldRiverPaths = Object.fromEntries(
    RIVER_TIERS.map((t) => [t.group, worldRiverPaths[t.group].slice()])
  );
  MAIN.coastPaths = coastPaths.filter(isMain);
  MAIN.shorePaths = shorePaths.filter(isMain);
  MAIN.borderPaths = borderPaths.filter(isMain);
  MAIN.apronParts = apronParts.filter(isMain);
  MAIN.lakesUnder = lakeParts.under.filter(isMain);
  MAIN.lakesOver = lakeParts.over.filter(isMain);
  MAIN.lakeEdgesUnder = lakeEdges.under.filter(isMain);
  MAIN.lakeEdgesOver = lakeEdges.over.filter(isMain);
  MAIN.graticulePaths = graticulePaths.slice();
  INSET_ALL.countyParts = countyParts.filter(notMain);
  INSET_ALL.arcPaths = arcPaths.filter(notMain);
  INSET_ALL.bandMaskPaths = bandMaskPaths.filter(notMain);
  INSET_ALL.coastPaths = coastPaths.filter(notMain);
  INSET_ALL.shorePaths = shorePaths.filter(notMain);
  INSET_ALL.borderPaths = borderPaths.filter(notMain);
  INSET_ALL.apronParts = apronParts.filter(notMain);
  INSET_ALL.lakesUnder = lakeParts.under.filter(notMain);
  INSET_ALL.lakesOver = lakeParts.over.filter(notMain);
  INSET_ALL.lakeEdgesUnder = lakeEdges.under.filter(notMain);
  INSET_ALL.lakeEdgesOver = lakeEdges.over.filter(notMain);
  rebuildVisible();
}
rebuildDerived();

// --------------------------------------------------------------------- map

const rgba = (css, alpha = 255) => {
  const c = d3.rgb(css);
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b), alpha];
};

// One water blue and one shoreline blue for every lake, carved or drawn on
// top, so the two render paths are indistinguishable on the map.
const LAKE = rgba("#d5e8f4");
const HALO = rgba("#cde4f2");
const WHITE = rgba("#ffffff");
const COUNTY_LINE = rgba("#ffffff", 128);
const STATE_LINE = rgba("#999999");
// Fully transparent: what the merged line layer paints for a segment that
// currently draws nothing (a county hairline while the data view is up).
const TRANSPARENT = [0, 0, 0, 0];
const COAST = rgba("#8ab8d6");
const LAND = rgba("#5b6472");
const HOVER = [0, 0, 0, 18]; // the old fill-opacity: 0.07
const GREY_LAND = rgba("#e4e4e4"); // data view: the ground itself carries no color
const NO_DATA = rgba("#cccccc");
// Non-union units in data view: the atlas tan's hue, washed well toward the
// page white. The full tan sits at the same lightness as GREY_LAND, so the
// union wouldn't separate from its context; the pale wash lets the context
// recede while the warm hue still says "on the map, not in the union" — and
// keeps it apart from NO_DATA's grey, which means a state missing data.
const FOREIGN_LAND = rgba("#f4f0e9");
// Globe mode only: the sea the sphere shows where no unit covers it, and the
// graticule over it. Both stay paler than the coast blue so the continent
// keeps reading as the subject and the sphere as its ground.
const OCEAN = rgba("#e8f1f7");
const GRATICULE_LINE = rgba("#b9cfdf", 150);
// The scenery land beyond the map's units wears exactly what a non-union unit
// wears: the same tan, the same white hairline between neighbours, the same
// blue shoreline and halo, the same water blue in its lakes. There is no
// second style for "not the map" — what marks the map out is that its ground
// carries state colors, hover, labels and paint, and none of that reaches
// here. A tan of its own only put a seam across the Panama border.
const WORLD_LAND = rgba(FOREIGN_FILL);

// The band inside a state's border is the state's own fill pushed deeper: the
// same hue, more saturated (capped at 1) and darker by the usual multiplier.
// That alone is enough for most hues — it's what gives red, purple and blue
// their rich-looking band. But HSL's lightness doesn't track perceived
// brightness consistently across hues: yellow and green read as bright even
// at a fairly low HSL l, so the same multiplier barely darkens them. Rather
// than replace the multiplier (which would flatten the hues it already suits),
// only step in when the result doesn't clear a minimum perceptual (CIELAB)
// lightness drop, and bisect HSL's own l — never LCH chroma directly — down
// until it does, since any l in HSL is guaranteed to stay in the sRGB gamut.
const MIN_LAB_DROP = 8;
const deepen = (css) => {
  const c = d3.hsl(css);
  const s = Math.min(1, c.s * 1.35);
  let l = c.l * 0.82;
  const fillLabL = d3.lab(css).l;
  if (fillLabL - d3.lab(d3.hsl(c.h, s, l)).l < MIN_LAB_DROP) {
    const target = fillLabL - MIN_LAB_DROP;
    let lo = 0,
      hi = l;
    for (let i = 0; i < 20; i++) {
      const mid = (lo + hi) / 2;
      if (d3.lab(d3.hsl(c.h, s, mid)).l > target) hi = mid;
      else lo = mid;
    }
    l = lo;
  }
  return d3.hsl(c.h, s, l);
};
// Unselected states grey out while painting: the fill keeps its lightness but
// loses nearly all its saturation. Because the ground stays as dark as ever,
// the white county and state hairlines read exactly as they do outside paint
// mode, while the selected state's full color pops against the grey.
const dimmed = (color) => {
  const c = d3.hsl(color);
  c.s *= 0.12;
  return c;
};
// The selected state's fill takes a small step toward its band color — a bit
// more saturated, a shade darker — so the whole state reads as active, not
// just the ground near its outline.
const highlight = (color) => {
  const c = d3.hsl(color);
  c.s = Math.min(1, c.s * 1.25);
  c.l *= 0.955;
  return c;
};

const BAND_WIDTH = 10; // pixels across the border, so five to a side
const FLAT = { coordinateSystem: COORDINATE_SYSTEM.CARTESIAN };
const EMPTY = [];

// Shared extension instances: deck.gl compares these by reference, so building
// them once keeps a layer rebuild from looking like a change.
const borderFilter = new DataFilterExtension({ filterSize: 1 });
const BORDER_EXT = [borderFilter];
const BAND_EXT = [new MaskExtension()];
const SHOWN = [0.5, 1.5];

const mapWrap = document.getElementById("map-wrap");
const insetCanvas = document.getElementById("inset-canvas");
const svg = d3.select("#map");
const labelGroup = svg.select("#data-labels");
const stateLabelGroup = svg.select("#state-labels");
const knifeGroup = svg.select("#knife"); // the split tool's drawn cut line
const insetGroup = svg.select("#inset-ui");
// Labels read only the globe copies: the inset duplicates would otherwise
// hand each of Alaska's counties two positions and the raster a second,
// competing Alaska. The raster spans the whole continent (with a margin for
// leader lines), not just the design box.
const LABEL_MARGIN = 24;
// Rebuilt whenever the globe turns: the labeler sizes its raster (three typed
// arrays, one cell per map unit) from these bounds at construction, and a new
// facing swings different land into view, so the old grid neither covers nor
// fits the new one. The group is emptied first so the retired labeler's
// <textPath> defs and text go with it.
function makeMainLabeler() {
  stateLabelGroup.selectAll("*").remove();
  // C5 does this job on the globe, over a Mercator raster, and keeps the answer
  // in lon/lat so a turn re-projects the baselines instead of re-running the
  // layout. The two inset boxes keep the SVG labeler below: their projections
  // never move, so nothing about them wants baking to the sphere.
  //
  // The layout reads whole units, so a carved county — whose parent has left
  // the assignment — is handed to the state of its largest piece. Coarse on
  // purpose, and the same rule the deck path's spin preview uses: at label
  // scale a county is a few raster cells, and the exact split would mean
  // teaching the raster about piece geometry for a placement nudge.
  if (globeMap)
    return {
      update: (args) => globeMap.updateLabels({ ...args, assign: globeLabelAssign(args.assign) }),
    };
  return createStateLabeler({
    group: stateLabelGroup,
    name: "main",
    countyParts: mainCountyParts,
    bounds: {
      x0: MAP_BOUNDS.x0 - LABEL_MARGIN,
      y0: MAP_BOUNDS.y0 - LABEL_MARGIN,
      x1: MAP_BOUNDS.x1 + LABEL_MARGIN,
      y1: MAP_BOUNDS.y1 + LABEL_MARGIN,
    },
  });
}
let stateLabeler = makeMainLabeler();
// Each inset box runs the same label pipeline over its own duplicates
// (foreign context included, so names keep off Canada), bounded by the box —
// which also keeps every placement, leader lines included, inside the frame.
// The group rides the inset-UI transform (see placeInsetUi), not the zoom,
// so the labels stay pinned with the boxes. Each labeler gets a child group
// of its own: update() toggles display on the group it was given, and the
// two boxes hide independently.
const insetLabelGroup = svg.select("#inset-state-labels");
const insetMaskHoles = svg.select("#inset-mask-holes");
// The data-view counterpart: one text per state's value, positioned from the
// inset's own county duplicates (see insetCountyGeo) instead of the globe
// copies renderDataLabels uses for #data-labels. Rides the same transform as
// the name labels above, so it stays pinned with the boxes. Its font-size is
// set below, once LABEL_SIZE exists.
const insetDataLabelGroup = svg.select("#inset-data-labels");
const insetLabelers = {};
for (const key of ["ak", "hi"]) {
  const b = INSETS[key];
  insetLabelers[key] = createStateLabeler({
    group: insetLabelGroup.append("g"),
    name: key,
    countyParts: countyParts.filter((p) => p.region === key),
    bounds: { x0: b.x, y0: b.y, x1: b.x + b.w, y1: b.y + b.h },
  });
}

let viewWidth = Math.max(1, mapWrap.clientWidth);
let viewHeight = Math.max(1, mapWrap.clientHeight);
// HOME_TRANSFORM (the lower-48 framing) is computed in the projection
// section, where the projected shapes it derives from live.
let transform = HOME_TRANSFORM;
let hoverFips = null;
let mapVersion = 0; // bumped whenever fills or borders change
// The state labels read far fewer inputs than the map does, and their rebuild
// is the most expensive step of a refresh (a continent-wide raster), so they
// key on versions of their own instead of mapVersion: assignVersion moves when
// territory changes hands (the geometry stage), labelsVersion when territory,
// a state name, or a foreign flag changes (the text stage). A selection or
// color change moves neither, so clicking a state never re-rasters the map.
let assignVersion = 0;
let labelsVersion = 0;
function touchTerritory() {
  assignVersion++;
  labelsVersion++;
}

// The SVG viewBox fit (xMidYMid meet) now has to be reproduced by hand: the
// 975x610 map is scaled to fit the canvas and centred, and d3.zoom's k/x/y ride
// on top of that. Solving screen = (world * k + t) * fit + offset against
// deck's screen = (world - target) * 2^zoom + size/2 gives these two lines.
function viewState() {
  const fit = Math.min(viewWidth / 975, viewHeight / 610);
  return {
    target: [(487.5 - transform.x) / transform.k, (305 - transform.y) / transform.k, 0],
    zoom: Math.log2(transform.k * fit),
  };
}

// The camera for the inset deck. The boxes render at a fixed on-screen size
// — insetScale() CSS pixels per design unit: 1 on desktop, and on a map too
// narrow for the full-size cluster (Alaska and Hawaii side by side, plus the
// anchor margin at both ends) the whole cluster scales down to fit the
// width. The target is solved from screen = (world - target) * s + size/2 so
// the cluster's bottom-left design corner (the Alaska box's left edge, and
// the shared INSET_BOTTOM_Y) pins to a fixed spot just above the Reset view
// / Alaska / Hawaii buttons. Pan and zoom never touch this view.
const INSET_ANCHOR = { left: 8, bottom: 38 };
function insetScale() {
  const clusterW = INSETS.hi.x + INSETS.hi.w - INSETS.ak.x;
  return Math.max(0.3, Math.min(1, (viewWidth - 2 * INSET_ANCHOR.left) / clusterW));
}
function insetViewState() {
  const s = insetScale();
  return {
    target: [
      INSETS.ak.x + (viewWidth / 2 - INSET_ANCHOR.left) / s,
      INSET_BOTTOM_Y - (viewHeight / 2 - INSET_ANCHOR.bottom) / s,
      0,
    ],
    zoom: Math.log2(s),
  };
}

let deck;
let hoverDeck;
let insetDeck;

// ---------------------------------------------------------------- data view

// Choropleth ramps. Both stay off their palest end so every state keeps a
// visible tint against the white page.
const seqColor = (t) => rgba(d3.interpolateYlGnBu(0.08 + 0.84 * t));
const divColor = (t) => rgba(d3.interpolateRdBu(0.08 + 0.84 * t));
const clamp01 = (t) => Math.max(0, Math.min(1, t));

// Drops Tukey outliers (often DC, on a per-capita stat) before a choropleth's
// min/max or ends get sized, so one extreme state can't stretch the ramp and
// flatten it for everyone else. The outlier itself is still painted — its
// color just clamps to the ramp's deepest end instead of sitting mid-scale.
function trimOutliers(vals) {
  if (vals.length < 4) return vals;
  const sorted = [...vals].sort((a, b) => a - b);
  const q1 = d3.quantileSorted(sorted, 0.25);
  const q3 = d3.quantileSorted(sorted, 0.75);
  const iqr = q3 - q1;
  if (iqr <= 0) return vals;
  const trimmed = sorted.filter((v) => v >= q1 - 1.5 * iqr && v <= q3 + 1.5 * iqr);
  return trimmed.length >= 2 ? trimmed : vals;
}

// The data view covers the union only. Units still outside it stay out of
// every reading — fills, marks, labels, the legend's ends — so a populous
// neighbor can't stretch the ramp and flatten the contrast between states.
// The live foreign flag decides, not FOREIGN: an admitted unit is a state.
const statEntries = (def) =>
  [...getStats().entries()].filter(
    ([sid, s]) => !stateInfo.get(sid)?.foreign && s.n > 0 && (!def.has || def.has(s))
  );

// One fill per state: a sequential ramp over the current min–max, or a
// red–white–blue ramp centred on an even margin.
function choroplethFills(key) {
  const def = STAT_DEFS[key];
  const entries = statEntries(def);
  const vals = entries.map(([, s]) => def.get(s));
  const trimmed = trimOutliers(vals);
  const fills = new Map();
  if (def.bar === "diverge") {
    const m = Math.max(1e-9, ...trimmed.map(Math.abs));
    for (const [sid, s] of entries) fills.set(sid, divColor(clamp01((def.get(s) / m + 1) / 2)));
  } else {
    const lo = Math.min(...trimmed);
    const span = Math.max(1e-9, Math.max(...trimmed) - lo);
    for (const [sid, s] of entries) fills.set(sid, seqColor(clamp01((def.get(s) - lo) / span)));
  }
  return fills;
}

// Scaled symbols for the population and GDP views: one mark per state at the
// area-weighted centroid of its counties, mark area proportional to the value.
// Sizes anchor to the biggest state on the original map, so repainting one
// state doesn't rescale every other symbol.
const CIRCLE_MAX_R = 36; // map px
const SQUARE_MAX_SIDE = CIRCLE_MAX_R * Math.sqrt(Math.PI); // equal area at the anchor
const symbolAnchor = {};
for (const [sid, s] of computeStats()) {
  if (FOREIGN.has(sid)) continue; // the anchor is a state of the original union
  for (const key of Object.keys(SYMBOL_STATS)) {
    symbolAnchor[key] = Math.max(symbolAnchor[key] ?? 0, s[key]);
  }
}

// sid -> the area-weighted centroid of the state's counties: where a state's
// symbol sits, and where its choropleth label goes. Takes countyGeo by
// default (the globe copies); passing insetCountyGeo.ak/.hi gives the same
// centroids inside an inset box instead.
function stateCentroids(geo = countyGeo) {
  const acc = new Map();
  for (const [fips, sid] of assign) {
    const g = geo.get(fips);
    if (!g) continue;
    let t = acc.get(sid);
    if (!t) acc.set(sid, (t = { x: 0, y: 0, a: 0 }));
    t.x += g.x * g.area;
    t.y += g.y * g.area;
    t.a += g.area;
  }
  const out = new Map();
  for (const [sid, t] of acc)
    if (t.a) out.set(sid, { x: t.x / t.a, y: t.y / t.a, area: t.a });
  return out;
}

// The "dots" mark is a counted unit chart: one small circle per vote, laid
// out in a near-square grid — 17 votes become 4x4 plus a leftover row of 1.
// Rounding the square root keeps the grid at most one row from square.
const DOT_R = 1.9; // map px
const DOT_PITCH = 5; // dot center to dot center
function dotGrid(n) {
  const cols = Math.max(1, Math.round(Math.sqrt(n)));
  return { cols, rows: Math.ceil(n / cols) };
}

// Each point carries its mark's half-width and half-height (equal for a
// circle's radius or a square's half-side, distinct for a dot grid or a
// label's text box) and its state's land area, which decides who yields in a
// collision.
// Memoized on the same `mapVersion:statKey` renderDataLabels keys on, because
// it is the same data. The walk below visits every county (through
// stateCentroids) and then relaxes every mark against its neighbours, and a
// hover frame — which deliberately leaves mapVersion alone — must not pay for
// either.
let symbolCache = { key: "", marks: EMPTY };
function symbolData(key) {
  const memo = `${mapVersion}:${key}`;
  if (symbolCache.key !== memo) symbolCache = { key: memo, marks: computeSymbolData(key) };
  return symbolCache.marks;
}

function computeSymbolData(key, centroids = stateCentroids()) {
  const stats = getStats();
  const mark = SYMBOL_STATS[key].mark;
  const max = mark === "square" ? SQUARE_MAX_SIDE / 2 : CIRCLE_MAX_R;
  const out = [];
  for (const [sid, c] of centroids) {
    if (stateInfo.get(sid)?.foreign) continue; // marks are for the union only
    const v = stats.get(sid)?.[key] ?? 0;
    if (!(v > 0)) continue;
    let hw, hh;
    if (mark === "dots") {
      const { cols, rows } = dotGrid(v);
      hw = ((cols - 1) * DOT_PITCH) / 2 + DOT_R;
      hh = ((rows - 1) * DOT_PITCH) / 2 + DOT_R;
    } else {
      hw = hh = max * Math.sqrt(v / symbolAnchor[key]);
    }
    out.push({ x: c.x, y: c.y, v, area: c.area, hw, hh });
  }
  // Large marks first, so the small ones draw on top and stay visible.
  out.sort((a, b) => b.v - a.v);
  return spreadMarks(out, mark === "circle");
}

// Expand each grid mark into its individual dots: full rows of `cols` from
// the top, the leftover row centered beneath them.
// Keyed on the marks array itself: symbolData hands back the same array until
// mapVersion moves, so a hover frame reuses these dots — there are thousands of
// them at the top of the range — instead of expanding them again.
let dotCache = { marks: null, dots: EMPTY };
function dotPositions(points) {
  if (dotCache.marks === points) return dotCache.dots;
  const out = [];
  for (const p of points) {
    const { cols, rows } = dotGrid(p.v);
    for (let i = 0; i < rows; i++) {
      const inRow = Math.min(cols, p.v - i * cols);
      for (let j = 0; j < inRow; j++) {
        out.push({
          x: p.x + (j - (inRow - 1) / 2) * DOT_PITCH,
          y: p.y + (i - (rows - 1) / 2) * DOT_PITCH,
        });
      }
    }
  }
  dotCache = { marks: points, dots: out };
  return out;
}

// Collision avoidance for marks and labels alike. Priority goes to the state
// with the LEAST land area: a tiny state or DC has nowhere else its mark can
// honestly sit, while a big state's mark can wander its own interior and
// still read as that state. So marks place in ascending area order, and each
// one slides directly away from any already-placed mark it overlaps until
// tangent. One slide can cause a new overlap, so each mark repeats its sweep
// until a pass finds it clear. The input's draw order is left untouched.
const MARK_GAP = 1; // edge-to-edge, so mark strokes and label halos just touch
function spreadMarks(points, circle) {
  const order = [...points].sort((a, b) => a.area - b.area);
  for (let i = 1; i < order.length; i++) {
    const p = order[i];
    for (let pass = 0; pass < 50; pass++) {
      let clear = true;
      for (let j = 0; j < i; j++) {
        const q = order[j];
        const dx = p.x - q.x;
        const dy = p.y - q.y;
        const needX = p.hw + q.hw + MARK_GAP;
        const needY = p.hh + q.hh + MARK_GAP;
        // Squares and labels are axis-aligned boxes: apart once either axis
        // gap opens.
        if (circle ? Math.hypot(dx, dy) >= needX : Math.abs(dx) >= needX || Math.abs(dy) >= needY)
          continue;
        const d = Math.hypot(dx, dy);
        const ux = d ? dx / d : 1; // coincident centers: direction is arbitrary
        const uy = d ? dy / d : 0;
        // Distance along (ux, uy) at which the pair separates: touching rims
        // for circles, the first axis gap to open for boxes.
        const t = circle
          ? needX
          : Math.min(ux ? needX / Math.abs(ux) : Infinity, uy ? needY / Math.abs(uy) : Infinity);
        p.x = q.x + ux * t;
        p.y = q.y + uy * t;
        clear = false;
      }
      if (clear) break;
    }
  }
  return points;
}

// Every state's formatted value at one shared size: centered on the mark for
// symbol stats, on the state's centroid for choropleths. The labels live in
// the overlay SVG rather than a deck text layer: the browser rasterizes
// vector text at its final on-screen size, so it stays sharp at any zoom,
// where a GPU glyph atlas goes soft. Position and font size are in the SVG's
// 975x610 viewBox units — the same space deck draws in — and the group rides
// d3.zoom's transform, so the labels track the map.
const LABEL_SIZE = 9; // viewBox units; the font-family and halo live in the CSS
const LABEL_CHAR_W = 0.62; // Verdana digit advance as a fraction of font size
labelGroup.attr("font-size", LABEL_SIZE);
// The inset group rides a fixed pin, not the zoom (see placeInsetUi), so its
// text renders at a constant CSS pixel size while the globe labels above grow
// and shrink with the map's fit and zoom. LABEL_SIZE was tuned against the
// globe at its usual on-screen scale, which reads small pinned at 1:1 — this
// runs bigger to land at a comparable size in the boxes.
const INSET_LABEL_SIZE = 15;
insetDataLabelGroup.attr("font-size", INSET_LABEL_SIZE);

// A label sits inside its mark only while the mark stands taller than 120%
// of the text; any shorter and the label would bury the mark, so it drops to
// just below it instead. Width plays no part: text wider than its mark still
// reads fine while the mark shows above and below the line.
const LABEL_INSIDE_MIN = 1.2 * LABEL_SIZE; // mark height, viewBox units

// One label per state for the choropleth stats, at the same centroids the
// symbols use, spread apart by the same rule the symbols follow — the text
// box stands in for the mark. States the fill skips for lack of data get no
// label either. Each label also learns whether its state's fill is dark, so
// the renderer can flip it to white-on-black for readability.
function choroplethLabels(key, centroids = stateCentroids(), fills = choroplethFills(key)) {
  const def = STAT_DEFS[key];
  const stats = getStats();
  const out = [];
  for (const [sid, c] of centroids) {
    const s = stats.get(sid);
    if (stateInfo.get(sid)?.foreign || !s || s.n === 0 || (def.has && !def.has(s))) continue;
    const v = def.get(s);
    const [r, g, b] = fills.get(sid) ?? NO_DATA;
    out.push({
      x: c.x,
      y: c.y,
      v,
      area: c.area,
      hw: (LABEL_CHAR_W * LABEL_SIZE * def.fmt(v).length) / 2,
      hh: LABEL_SIZE / 2,
      dark: (299 * r + 587 * g + 114 * b) / 1000 < 128, // perceived luma (YIQ)
    });
  }
  return spreadMarks(out, false);
}

// The data view's marks, as SVG over the map. On the deck path these are three
// layers in the map stack (data-circles, data-squares, data-dots); the globe
// draws nothing that is placed from a projected centroid, so they move up here
// beside the values they carry and are laid out from exactly the same
// symbolData. Widths are in design units, which is what deck's "common" units
// meant, and the group rides d3.zoom's transform like every other overlay.
const markGroup = d3.select("#data-marks");
const cssRgba = ([r, g, b, a = 255]) => `rgba(${r},${g},${b},${a / 255})`;
function renderDataMarks(symbol, marks) {
  const shapes = !symbol
    ? []
    : symbol.mark === "dots"
      ? dotPositions(marks).map((d) => ({ cx: d.x, cy: d.y, r: DOT_R, w: 0.5 }))
      : symbol.mark === "circle"
        ? marks.map((d) => ({ cx: d.x, cy: d.y, r: d.hw, w: 1 }))
        : marks.map((d) => ({ x: d.x - d.hw, y: d.y - d.hw, s: 2 * d.hw, w: 1 }));
  markGroup.attr("fill", symbol ? cssRgba(symbol.fill) : "none");
  markGroup.attr("stroke", symbol ? cssRgba(symbol.edge) : "none");
  markGroup
    .selectAll(symbol?.mark === "square" ? "rect" : "circle")
    .data(shapes)
    .join(symbol?.mark === "square" ? "rect" : "circle")
    .attr("stroke-width", (d) => d.w)
    .attr("cx", (d) => d.cx)
    .attr("cy", (d) => d.cy)
    .attr("r", (d) => d.r)
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .attr("width", (d) => d.s)
    .attr("height", (d) => d.s);
  // Joining on one tag leaves the other kind behind when the stat changes.
  markGroup.selectAll(symbol?.mark === "square" ? "circle" : "rect").remove();
}

let labelKey = "";
function renderDataLabels() {
  const statKey = rankStatSel.value;
  const key = inDataView() ? `${mapVersion}:${statKey}` : "";
  if (key === labelKey) return; // hover refreshes land here; nothing to redo
  labelKey = key;
  const fmt = STAT_DEFS[statKey].fmt;
  const symbol = SYMBOL_STATS[statKey];
  const fills = key && !symbol ? choroplethFills(statKey) : null;
  const toLabels = (marks) =>
    marks.map((d) => {
      // A dot grid never takes an inside label: text across the pattern would
      // cover some of the countable dots.
      const below = symbol && (symbol.mark === "dots" || 2 * d.hh <= LABEL_INSIDE_MIN);
      return {
        text: fmt(d.v),
        dark: !!d.dark,
        x: d.x,
        y: below ? d.y + d.hh + LABEL_SIZE * 0.75 : d.y,
      };
    });

  const marks = !key ? [] : symbol ? symbolData(statKey) : choroplethLabels(statKey, stateCentroids(), fills);
  if (globeMap) renderDataMarks(key && symbol ? symbol : null, marks);
  labelGroup
    .selectAll("text")
    .data(toLabels(marks))
    .join("text")
    .classed("inverse", (d) => d.dark)
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .text((d) => d.text);

  // Each inset box runs the same pipeline over its own county duplicates
  // (insetCountyGeo) instead of the globe copies above, skipped while the
  // box is collapsed — same stat and fills, so a state reads the same number
  // and color whether it's the globe copy or the inset one.
  const insetMarks = (region) =>
    !key || insetHidden[region]
      ? []
      : symbol
        ? computeSymbolData(statKey, stateCentroids(insetCountyGeo[region]))
        : choroplethLabels(statKey, stateCentroids(insetCountyGeo[region]), fills);
  insetDataLabelGroup
    .selectAll("text")
    .data(["ak", "hi"].flatMap((region) => toLabels(insetMarks(region))))
    .join("text")
    .classed("inverse", (d) => d.dark)
    .attr("x", (d) => d.x)
    .attr("y", (d) => d.y)
    .text((d) => d.text);
}

// Hover highlight target: the county under the pointer in atlas view, its
// whole state in data view (where county lines don't exist). Returns every
// copy — globe and inset — so hovering a county lights it in both places;
// the layers split the list by region.
let hoverStateCache = { sid: null, parts: EMPTY };
function hoverParts() {
  if (!hoverFips) return EMPTY;
  if (!inDataView()) return partsByFips.get(hoverFips) ?? EMPTY;
  const sid = assign.get(hoverFips);
  // Collected via partsByFips, not countyParts, so a split county's halves
  // contribute their own tract-union shapes — the parent-shaped backing part
  // would tint the whole county for whichever state holds the remainder.
  if (hoverStateCache.sid !== sid)
    hoverStateCache = {
      sid,
      parts: [...partsByFips].flatMap(([f, parts]) => (assign.get(f) === sid ? parts : [])),
    };
  return hoverStateCache.parts;
}

// The same question for the globe, which tints by unit rather than by
// projected part: the county under the pointer, or in data view every county
// of its state, since county lines aren't drawn there and the reading is the
// state's. Cached on the answer's inputs, so a mouse move inside one state
// costs a comparison.
let hoverUnitCache = { key: "", list: EMPTY };
function hoverUnits() {
  if (!hoverFips) return EMPTY;
  if (!inDataView()) return [hoverFips];
  const sid = assign.get(hoverFips);
  const key = `${sid}:${assignVersion}`;
  if (hoverUnitCache.key !== key) {
    const list = [];
    for (const [fips, s] of assign) if (s === sid) list.push(fips);
    hoverUnitCache = { key, list };
  }
  return hoverUnitCache.list;
}

// deck.gl compares layer data by reference, so these two arrays have to be the
// same objects from frame to frame: a fresh one — even holding exactly what the
// last one held — reads as changed data and redraws every layer on both decks.
// hoverParts above already caches per hovered unit; splitting that result by
// region is what used to mint new arrays on every mouse move. Empty results
// collapse to the shared EMPTY for the same reason: most hovers touch no inset
// part at all, and a fresh [] each time would redraw the inset deck forever.
let hoverSplitCache = { parts: null, hidden: "", main: EMPTY, inset: EMPTY };
function hoverSplit() {
  const parts = hoverParts();
  const hidden = `${insetHidden.ak}|${insetHidden.hi}`;
  if (hoverSplitCache.parts !== parts || hoverSplitCache.hidden !== hidden) {
    const main = parts.filter((p) => p.region === "main");
    const inset = parts.filter((p) => p.region !== "main" && !insetHidden[p.region]);
    hoverSplitCache = {
      parts,
      hidden,
      main: main.length ? main : EMPTY,
      inset: inset.length ? inset : EMPTY,
    };
  }
  return hoverSplitCache;
}

// The selected state's edge: every segment with exactly one side in the
// state, plus the map-edge runs (coast, lakeshore, fixed border) its units
// own, subset on the CPU. The casing and outline layers used to feed the
// full arc list through a GPU filter, which cost two extra passes over the
// continent's arcs on every frame a state was selected; the actual edge is
// around a percent of them. The subset keys on the selection and on
// assignVersion (a brush stroke moves the edge), so between changes the
// layers see referentially stable data, and when it does change,
// re-tessellating the small subset is far cheaper than the full passes were.
let selEdgeCache = { key: "", main: EMPTY, inset: EMPTY };
function selectedEdges() {
  if (!selected) return { main: EMPTY, inset: EMPTY };
  const key = `${selected}:${assignVersion}:${insetHidden.ak}|${insetHidden.hi}`;
  if (selEdgeCache.key !== key) {
    const inSel = (id) => assign.get(id) === selected;
    const edge = [
      ...arcPaths.filter((d) => inSel(d.a) !== inSel(d.b)),
      // The coastline, lakeshore and fixed-border runs the state's units own:
      // without them the outline traced only the land border, so a coastal
      // state read as half-outlined and an island state not at all. The seam
      // stretches stay out of these runs — the assignment-aware seam segments
      // in arcPaths already cover them, which keeps a cross-border merge from
      // drawing a stale line through its middle.
      ...edgeBandPaths.filter((d) => inSel(d.a)),
    ];
    const main = edge.filter(isMain);
    const inset = edge.filter((d) => !isMain(d) && !insetHidden[d.region]);
    selEdgeCache = {
      key,
      main: main.length ? main : EMPTY,
      inset: inset.length ? inset : EMPTY,
    };
  }
  return selEdgeCache;
}

// The two hover-tint layers, shared by the full rebuild and by the cheap
// hover-only refresh path (refreshHoverOnly below).
const countyHoverLayer = (data) =>
  new SolidPolygonLayer({
    id: "county-hover",
    data,
    getPolygon: (d) => d.rings,
    getFillColor: HOVER,
    ...FLAT,
  });
const insetHoverLayer = (data) =>
  new SolidPolygonLayer({
    id: "inset-hover",
    data,
    getPolygon: (d) => d.rings,
    getFillColor: HOVER,
    ...FLAT,
  });

// What colour a state's ground and its border band wear right now. Pulled out
// of buildLayers so the globe renderer reads exactly the same definitions: the
// deck path calls these per projected part, the globe writes each answer into
// one palette texel per unit (see paintGlobe). Memoized per call, because a
// refresh asks about the same fifty-odd states thousands of times.
function groundColors() {
  const dataView = inDataView();
  const statKey = rankStatSel.value;
  const symbol = dataView ? SYMBOL_STATS[statKey] : undefined;
  const fills = new Map();
  const fillOf = (sid) => {
    const dim = paintMode && sid !== selected;
    const hot = sid === selected;
    const key = dim ? sid + "!" : hot ? sid + "*" : sid;
    let color = fills.get(key);
    if (!color) {
      const base = stateInfo.get(sid).color;
      fills.set(key, (color = rgba(dim ? dimmed(base) : hot ? highlight(base) : base)));
    }
    return color;
  };
  const bands = new Map();
  const bandOf = (sid) => {
    const dim = paintMode && sid !== selected;
    const hot = sid === selected;
    const key = dim ? sid + "!" : hot ? sid + "*" : sid;
    let color = bands.get(key);
    if (!color) {
      // The selected state's band deepens from its boosted fill, so the
      // fill-to-band contrast stays the same while both step up together.
      // Units outside the union wear no band at all: their "band" is the
      // fill itself, so the map edge and the seam stay flat on the foreign
      // side — no dark rim around Canada or Mexico.
      const info = stateInfo.get(sid);
      const boosted = hot ? highlight(info.color) : info.color;
      const deep = info.foreign ? boosted : deepen(boosted);
      bands.set(key, (color = rgba(dim ? dimmed(deep) : deep)));
    }
    return color;
  };
  // Data view fills: symbol stats leave the ground a uniform grey; everything
  // else colors each county by its state's value. Units outside the union
  // keep the atlas tan in both cases — they read as context, never as data.
  const choro = dataView && !symbol ? choroplethFills(statKey) : null;
  const groundOf = !dataView
    ? fillOf
    : (sid) => {
        if (stateInfo.get(sid)?.foreign) return FOREIGN_LAND;
        return choro ? (choro.get(sid) ?? NO_DATA) : GREY_LAND;
      };
  return { fillOf, bandOf, groundOf, dataView, statKey, symbol, choro };
}

// deck.gl takes 0-255 bytes and GLSL takes 0-1 floats.
const glColor = ([r, g, b, a = 255]) => [r / 255, g / 255, b / 255, a / 255];

// The globe's whole repaint: three texels per unit and nothing else. No
// geometry moves when a county changes hands, a state is selected, paint mode
// dims the rest of the map or the view flips to data — which is what the
// palette and the per-unit attribute table were built for.
function paintGlobe() {
  const { bandOf, groundOf, dataView } = groundColors();
  // A small dense index per state, so the shader can compare two units'
  // owners with one integer test. Rebuilt per repaint; there are ~60 states.
  const stateOrder = new Map([...stateInfo.keys()].map((sid, i) => [sid, i]));
  globeMap.paint({
    assign,
    stateOrder,
    fillOf: groundOf,
    // The band is drawn through a stencil stroked along the state borders, so
    // in the data view — where there are no bands — nothing reads this.
    bandOf: dataView ? groundOf : bandOf,
    isForeign: (sid) => !!stateInfo.get(sid)?.foreign,
    selected,
  });
  globeMap.setView({
    dataView,
    selected: !!selected,
    // The atlas outline is the selected state's own colour pushed darker; in
    // data view that colour means nothing, so a neutral dark line marks it.
    selectionColor: selected
      ? glColor(dataView ? rgba("#333333") : rgba(d3.color(stateInfo.get(selected).color).darker(1.4)))
      : undefined,
  });
  globeMap.requestDraw();
}

// Builds both decks' layer lists in one pass, so the inset stack shares the
// accessors (fills, bands, filters) with the globe stack.
function buildLayers() {
  const trigger = mapVersion;
  const dataView = inDataView();
  const statKey = rankStatSel.value;
  const symbol = dataView ? SYMBOL_STATS[statKey] : undefined;
  const symbols = symbol ? symbolData(statKey) : EMPTY;
  // Each open inset gets its own marks, sized and placed from its own county
  // duplicates (insetCountyGeo) rather than the globe copies above — the
  // same reasoning as the inset data labels.
  const insetSymbols = symbol
    ? ["ak", "hi"].flatMap((region) =>
        insetHidden[region] ? [] : computeSymbolData(statKey, stateCentroids(insetCountyGeo[region]))
      )
    : EMPTY;
  // Keyed by state, not by part: the deck layers below look one up per record,
  // and the globe writes each one into the palette once per unit. Same
  // definitions either way — see groundColors.
  const { fillOf: fillForState, bandOf: bandForState, groundOf } = groundColors();
  const fillOf = (part) => fillForState(assign.get(part.fips));
  const bandOf = (part) => bandForState(assign.get(part.fips));
  const countyFill = (part) => groundOf(assign.get(part.fips));

  const isBorder = (d) => assign.get(d.a) !== assign.get(d.b);
  // County hairlines and state borders share one layer per deck: same arc
  // data, same width, only the color differs per segment — so the continent's
  // arcs make one pass instead of two. A state border draws grey; every other
  // arc draws the white hairline in atlas view and nothing in data view,
  // where county lines don't exist. Painting restyles segments through the
  // same per-segment attribute update the old filter used.
  const lineColor = (d) =>
    isBorder(d) && !foreignBorder(d) ? STATE_LINE : dataView ? TRANSPARENT : COUNTY_LINE;
  // Borders between two units that are both still outside the union get no
  // state-border treatment (no band, no grey line): unpainted territory all
  // wears one tan and reads as context, not as states. The white county
  // hairline still separates the units, and the US–foreign seam keeps the
  // full treatment — it is the union's outer edge.
  const isForeignSid = (sid) => stateInfo.get(sid)?.foreign;
  const foreignBorder = (d) =>
    isForeignSid(assign.get(d.a)) && isForeignSid(assign.get(d.b));
  // Which segments carry the border band. Interior segments — shared arcs
  // and the appended seam segments — wear it while their two sides belong
  // to different members of the union. Edge runs (the map's outer boundary)
  // wear it while the unit that owns them is in the union, so a foreign
  // unit's coastline stays bare until its territory is painted in.
  const bandFilter = (d) =>
    (d.edge ? !isForeignSid(assign.get(d.a)) : isBorder(d) && !foreignBorder(d)) ? 1 : 0;
  // The selected state's edge segments, already subset and cached (see
  // selectedEdges above).
  const selEdge = selectedEdges();
  // The atlas outline is the selected state's own color pushed darker; in data
  // view that color means nothing, so a neutral dark line marks the selection.
  const outline = !selected
    ? WHITE
    : dataView
      ? rgba("#333333")
      : rgba(d3.color(stateInfo.get(selected).color).darker(1.4));

  const { main: hoverMain, inset: hoverInset } = hoverSplit();

  // Hover highlight: 7% black over the county (or, in data view, the state)
  // under the pointer, the same 0.93 multiply the overlay path used to give.
  // It gets a deck to itself because deck.gl redraws a whole deck whenever any
  // layer's data changes: left in the map stack, one mouse move repainted all
  // ~20 map layers and threw away the picking buffer that the next pick then
  // had to rebuild. The cost of the move is compositing order â this canvas
  // is above the map's lines, lakes, data symbols and selection outline, so
  // the tint now falls on those too instead of sitting under them. The inset
  // hover stays down in the inset stack (below), where it has to be: this
  // canvas is under the inset canvas, so a tint drawn here would vanish
  // beneath the boxes' white backing.
  const hoverLayers = [countyHoverLayer(hoverMain)];

  const mapLayers = [
    // Globe furniture, under everything: the ocean disc is the sphere itself,
    // and the graticule rides on it.
    new SolidPolygonLayer({
      id: "globe-sphere",
      data: [SPHERE_DISC],
      getPolygon: (d) => d.rings,
      getFillColor: OCEAN,
      ...FLAT,
    }),
    new PathLayer({
      id: "globe-graticule",
      data: MAIN.graticulePaths,
      getPath: (d) => d.path,
      getColor: GRATICULE_LINE,
      getWidth: 0.7,
      widthUnits: "common",
      ...FLAT,
    }),
    // The rest of the world, under everything the map proper draws. It is
    // scenery in both views: the sphere is bare without it. The map's own
    // units cover none of it — the build leaves out every country the map
    // draws — so nothing overlaps and no seam shows.
    //
    // The six layers are the map's own stack in miniature, in the same order
    // and the same colors: halo under the land, then the fill, the lines
    // between countries, the lakes over them, and the shoreline last. What it
    // leaves out is everything that belongs to a paintable unit — no border
    // band, no selection, no hover, no state line.
    new PathLayer({
      id: "world-coast-halo",
      data: MAIN.worldCoastPaths,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: HALO,
      getWidth: 16,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "world-land",
      data: MAIN.worldParts,
      getPolygon: (d) => d.rings,
      getFillColor: dataView ? FOREIGN_LAND : WORLD_LAND,
      ...FLAT,
    }),
    // Country lines, like the county hairlines they match: gone in data view,
    // where the ground is read by color and a line inside it would only break
    // the wash up.
    new PathLayer({
      id: "world-borders",
      data: MAIN.worldBorderPaths,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: COUNTY_LINE,
      getWidth: 1,
      widthUnits: "pixels",
      capRounded: true,
      ...FLAT,
    }),
    // Natural Earth carves the largest lakes out of the countries it draws and
    // leaves the rest sitting inside them, so these are drawn over the land
    // either way: over a hole they fill it, over a country they cover it. Both
    // read the same, which is what the map's own two lake layers achieve
    // between them.
    new SolidPolygonLayer({
      id: "world-lakes",
      data: MAIN.worldLakeParts,
      getPolygon: (d) => d.rings,
      getFillColor: dataView ? WHITE : LAKE,
      ...FLAT,
    }),
    new PathLayer({
      id: "world-lake-edges",
      data: MAIN.worldLakeEdges,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new PathLayer({
      id: "world-coast-line",
      data: MAIN.worldCoastPaths,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    // Water first: lakes the Census file carves out of the land, then a soft
    // halo along the ocean shoreline (only — a halo over a Great Lake would
    // ring it in an off shade). The lakes get a slight same-color stroke to
    // close generalization slivers against the Census shoreline; the overshoot
    // hides under the white nation shape drawn on top of them. Data view
    // drops the blue water fill and the halo: carved lakes show the page
    // white through their holes (their shoreline stays, via coast-line
    // below), and the on-top lakes further down match by going white.
    new SolidPolygonLayer({
      id: "lakes-under",
      data: MAIN.lakesUnder,
      visible: !dataView,
      getPolygon: (d) => d.rings,
      getFillColor: LAKE,
      ...FLAT,
    }),
    new PathLayer({
      id: "lakes-under-edge",
      data: MAIN.lakeEdgesUnder,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: LAKE,
      getWidth: 2,
      widthUnits: "common",
      ...FLAT,
    }),
    // Not drawn: this stroke only feeds the band's mask, below. It is a plain
    // line straddling every state border and the nation's edge, so it covers
    // exactly the ground within half its width of a border — including, where
    // a river border doubles back on itself, the whole of a meander too tight
    // to hold a band.
    new PathLayer({
      id: "band-mask",
      data: MAIN.bandMaskPaths,
      visible: !dataView,
      operation: "mask",
      getPath: (d) => d.path,
      getWidth: BAND_WIDTH,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      getFilterValue: bandFilter,
      filterRange: SHOWN,
      updateTriggers: { getFilterValue: trigger },
      extensions: BORDER_EXT,
      ...FLAT,
    }),
    new PathLayer({
      id: "coast-halo",
      data: MAIN.coastPaths,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: HALO,
      getWidth: 16,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "nation-backing",
      data: MAIN.nationParts,
      getPolygon: (d) => d.rings,
      getFillColor: WHITE,
      ...FLAT,
    }),
    // The seam aprons (see their construction above), clipped to the land so
    // they can't paint tan into the sea.
    new SolidPolygonLayer({
      id: "land-mask",
      data: MAIN.nationParts,
      operation: "mask",
      getPolygon: (d) => d.rings,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "seam-aprons",
      data: MAIN.apronParts,
      getPolygon: (d) => d.rings,
      getFillColor: countyFill,
      updateTriggers: { getFillColor: [trigger, statKey, dataView] },
      extensions: BAND_EXT,
      maskId: "land-mask",
      maskByInstance: false,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "counties",
      data: MAIN.countyParts,
      getPolygon: (d) => d.rings,
      getFillColor: countyFill,
      updateTriggers: { getFillColor: [trigger, statKey, dataView] },
      pickable: true,
      ...FLAT,
    }),
    // Atlas-style borders: along the inside of every state border and the
    // nation's edge runs a band of that state's own color, more saturated than
    // its fill. It is the counties over again in the deeper color, showing only
    // where the mask above lets them — so the band is the state's own ground by
    // construction and can't spill across a border however the line bends. The
    // bands go under the county hairlines and the white state border, which is
    // what keeps those lines reading over the top of them.
    new SolidPolygonLayer({
      id: "band",
      data: MAIN.countyParts,
      visible: !dataView,
      getPolygon: (d) => d.rings,
      getFillColor: bandOf,
      updateTriggers: { getFillColor: trigger },
      extensions: BAND_EXT,
      maskId: "band-mask",
      maskByInstance: false,
      ...FLAT,
    }),
    new PathLayer({
      id: "map-lines",
      data: MAIN.arcPaths,
      getPath: (d) => d.path,
      getColor: lineColor,
      getWidth: 1,
      widthUnits: "pixels",
      capRounded: true,
      updateTriggers: { getColor: [trigger, dataView] },
      ...FLAT,
    }),
    // Rivers, over the ground and under every edge of the water they run into.
    // Above the county fills and the border band, because a river is a fact
    // about the ground and breaking it wherever a state line happens to fall
    // would read as a rendering fault. Below the lakes and the coastline, so a
    // mouth that overshoots its estuary is covered by the edge it overshot
    // rather than striking out across open water. The coastline's blue, in a
    // weight that tapers with the tier, and gone in data view, where the ground
    // is read by color and a thread across it is only clutter.
    //
    // Two differences from the globe stack. The tiers are frozen at their home
    // view state rather than following the zoom, for the reason given where
    // RIVER_TIERS is defined. And the globe draws every lake in the world above
    // this line, where here the scenery lakes are drawn far below, back with the
    // rest of the world — so a river running into Lake Victoria is covered there
    // and not here. That costs a few pixels of overshoot on lakes outside North
    // America, and closing it would mean drawing the world's lakes twice.
    ...RIVER_TIERS.map(
      (t) =>
        new PathLayer({
          id: t.group,
          data: MAIN.worldRiverPaths[t.group],
          visible: !dataView,
          getPath: (d) => d.path,
          getColor: COAST,
          getWidth: t.width,
          widthUnits: "pixels",
          jointRounded: true,
          capRounded: true,
          ...FLAT,
        })
    ),
    // Lakes that sit inside unit polygons (not carved out of the land) are
    // drawn over the fills instead, in the same water blue — and their edge
    // matches the carved lakes' lakeshore treatment (the coast-line layer
    // below), so the two render paths are indistinguishable. In data view
    // the fill flips to page white: a carved lake shows the page through its
    // hole there, and an on-top lake has to read the same — its water
    // carries no data, so it blanks the stat color underneath.
    new SolidPolygonLayer({
      id: "lakes-over",
      data: MAIN.lakesOver,
      getPolygon: (d) => d.rings,
      getFillColor: dataView ? WHITE : LAKE,
      ...FLAT,
    }),
    new PathLayer({
      id: "lakes-over-edge",
      data: MAIN.lakeEdgesOver,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    // The map's outer edge: blue where the far side is water (ocean and
    // Great Lakes alike), dark where it's land beyond the map's units.
    new PathLayer({
      id: "coast-line",
      data: MAIN.shorePaths,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new PathLayer({
      id: "border-line",
      data: MAIN.borderPaths,
      getPath: (d) => d.path,
      getColor: LAND,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    // Data view symbols, on top of everything but the selection outline.
    new ScatterplotLayer({
      id: "data-circles",
      data: symbol?.mark === "circle" ? symbols : EMPTY,
      getPosition: (d) => [d.x, d.y],
      getRadius: (d) => d.hw,
      radiusUnits: "common",
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 1,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    new PolygonLayer({
      id: "data-squares",
      data: symbol?.mark === "square" ? symbols : EMPTY,
      getPolygon: (d) => {
        const h = d.hw;
        return [
          [d.x - h, d.y - h],
          [d.x + h, d.y - h],
          [d.x + h, d.y + h],
          [d.x - h, d.y + h],
        ];
      },
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 1,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    // The electoral-vote unit chart: every dot is one vote, so the stroke
    // thins to keep the tiny circles from reading as rings.
    new ScatterplotLayer({
      id: "data-dots",
      data: symbol?.mark === "dots" ? dotPositions(symbols) : EMPTY,
      getPosition: (d) => [d.x, d.y],
      getRadius: DOT_R,
      radiusUnits: "common",
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 0.5,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    // The selection edge is a dark line over a wider white casing. The casing
    // cuts a bright gap between the line and the border bands on either side,
    // which is what makes the selection pop instead of sinking into them.
    new PathLayer({
      id: "selected-casing",
      data: selEdge.main,
      visible: !!selected,
      getPath: (d) => d.path,
      getColor: WHITE,
      getWidth: 5.6,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new PathLayer({
      id: "selected-outline",
      data: selEdge.main,
      visible: !!selected,
      getPath: (d) => d.path,
      getColor: outline,
      getWidth: 2.6,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
  ];

  // ---- Alaska/Hawaii insets: a duplicate mini-map on the inset deck's own
  // canvas, above the map. A white backing hides whatever map lies under
  // the box; the content mirrors the atlas stack (fills — the faded foreign
  // neighbors included — lakes, seam aprons, band, hover, lines, coast,
  // selection; the state names ride the overlay SVG, like the globe's). The
  // V arrays hold only the open boxes' data, so a collapsed inset costs
  // nothing.
  const insetLayers = [
    // The insets need a mask of their own: deck fits a mask to its first
    // viewport, so the main deck's mask — refitted to wherever the map is
    // zoomed — would crop the boxes right out. Width is in common units
    // because the mask pass renders through a detached viewport where
    // "pixels" means texels, not screen; at this deck's zoom 0, one common
    // unit IS one CSS pixel, so the band width matches the main map's.
    new PathLayer({
      id: "inset-band-mask",
      data: V.bandMaskPaths,
      visible: !dataView,
      operation: "mask",
      getPath: (d) => d.path,
      getWidth: BAND_WIDTH,
      widthUnits: "common",
      jointRounded: true,
      capRounded: true,
      getFilterValue: bandFilter,
      filterRange: SHOWN,
      updateTriggers: { getFilterValue: trigger },
      extensions: BORDER_EXT,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "inset-backing",
      data: V.backing,
      getPolygon: (d) => d.rings,
      getFillColor: WHITE,
      ...FLAT,
    }),
    // Carved lakes, as on the main map: drawn under the county fills and
    // showing through their holes (the Northwest Territories' corner of the
    // Alaska box holds a slice of Great Bear Lake). In data view the fill
    // drops out and the hole shows the backing's white, like the page white
    // on the globe.
    new SolidPolygonLayer({
      id: "inset-lakes-under",
      data: V.lakesUnder,
      visible: !dataView,
      getPolygon: (d) => d.rings,
      getFillColor: LAKE,
      ...FLAT,
    }),
    new PathLayer({
      id: "inset-lakes-under-edge",
      data: V.lakeEdgesUnder,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: LAKE,
      getWidth: 2,
      widthUnits: "common",
      ...FLAT,
    }),
    // The ocean halo, as on the main map. It rides above the white backing
    // (which plays the sea inside the box) and under the county fills (which
    // stand in for the nation shape and hide its landward half).
    new PathLayer({
      id: "inset-coast-halo",
      data: V.coastPaths,
      visible: !dataView,
      getPath: (d) => d.path,
      getColor: HALO,
      getWidth: 16,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    // The seam under-fill, as on the main map, so a cross-border merge can't
    // open a white crack along the Canada seam inside the box. The main map
    // clips its aprons to the land mask; at the boxes' fixed scale the
    // aprons' overshoot past the seam's sea ends is a fraction of a pixel,
    // so no mask is needed here.
    new SolidPolygonLayer({
      id: "inset-seam-aprons",
      data: V.apronParts,
      getPolygon: (d) => d.rings,
      getFillColor: countyFill,
      updateTriggers: { getFillColor: [trigger, statKey, dataView] },
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "inset-counties",
      data: V.countyParts,
      getPolygon: (d) => d.rings,
      getFillColor: countyFill,
      updateTriggers: { getFillColor: [trigger, statKey, dataView] },
      pickable: true,
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "inset-band",
      data: V.countyParts,
      visible: !dataView,
      getPolygon: (d) => d.rings,
      getFillColor: bandOf,
      updateTriggers: { getFillColor: trigger },
      extensions: BAND_EXT,
      maskId: "inset-band-mask",
      maskByInstance: false,
      ...FLAT,
    }),
    insetHoverLayer(hoverInset),
    new PathLayer({
      id: "inset-map-lines",
      data: V.arcPaths,
      getPath: (d) => d.path,
      getColor: lineColor,
      getWidth: 0.5,
      widthUnits: "pixels",
      capRounded: true,
      updateTriggers: { getColor: [trigger, dataView] },
      ...FLAT,
    }),
    // On-top lakes, as on the main map: over the fills, page white in data
    // view. None land in the current boxes, but the stacks stay mirrored.
    new SolidPolygonLayer({
      id: "inset-lakes-over",
      data: V.lakesOver,
      getPolygon: (d) => d.rings,
      getFillColor: dataView ? WHITE : LAKE,
      ...FLAT,
    }),
    new PathLayer({
      id: "inset-lakes-over-edge",
      data: V.lakeEdgesOver,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new PathLayer({
      id: "inset-coast-line",
      data: V.shorePaths,
      getPath: (d) => d.path,
      getColor: COAST,
      getWidth: 1.1,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    // Data view symbols, the same three marks as the globe stack, mirrored
    // over insetSymbols so a state's graduated bubble/square/dots shows up
    // inside its box too, not just on the (often out-of-view) globe copy.
    new ScatterplotLayer({
      id: "inset-data-circles",
      data: symbol?.mark === "circle" ? insetSymbols : EMPTY,
      getPosition: (d) => [d.x, d.y],
      getRadius: (d) => d.hw,
      radiusUnits: "common",
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 1,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    new PolygonLayer({
      id: "inset-data-squares",
      data: symbol?.mark === "square" ? insetSymbols : EMPTY,
      getPolygon: (d) => {
        const h = d.hw;
        return [
          [d.x - h, d.y - h],
          [d.x + h, d.y - h],
          [d.x + h, d.y + h],
          [d.x - h, d.y + h],
        ];
      },
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 1,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    new ScatterplotLayer({
      id: "inset-data-dots",
      data: symbol?.mark === "dots" ? dotPositions(insetSymbols) : EMPTY,
      getPosition: (d) => [d.x, d.y],
      getRadius: DOT_R,
      radiusUnits: "common",
      stroked: true,
      getFillColor: symbol?.fill ?? WHITE,
      getLineColor: symbol?.edge ?? WHITE,
      getLineWidth: 0.5,
      lineWidthUnits: "common",
      ...FLAT,
    }),
    new PathLayer({
      id: "inset-selected-casing",
      data: selEdge.inset,
      visible: !!selected,
      getPath: (d) => d.path,
      getColor: WHITE,
      getWidth: 5.6,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
    new PathLayer({
      id: "inset-selected-outline",
      data: selEdge.inset,
      visible: !!selected,
      getPath: (d) => d.path,
      getColor: outline,
      getWidth: 2.6,
      widthUnits: "pixels",
      jointRounded: true,
      capRounded: true,
      ...FLAT,
    }),
  ];

  return { map: mapLayers, hover: hoverLayers, inset: insetLayers };
}

// All three decks ask for the high-performance GPU explicitly. On a machine
// with both integrated and discrete graphics the browser is otherwise free
// to put WebGL on the integrated one, and this map's per-frame geometry is
// sized for the discrete card.
const DEVICE_PROPS = {
  webgl: { antialias: true, powerPreference: "high-performance" },
};

// Every canvas fills the same box, so one resize drives all three decks, the
// globe and the SVG frames. deck.gl used to own this callback for the map
// canvas; with the globe drawing on that canvas, the observer has to be ours.
function onViewResize(width, height) {
  viewWidth = Math.max(1, width);
  viewHeight = Math.max(1, height);
  if (globeMap) {
    globeMap.resize(viewWidth, viewHeight);
    // setTransform bakes the letterbox fit into the camera's pan, and the
    // resize just changed that fit. Without re-deriving the pan here, any
    // width-changing resize while the map is zoomed or panned leaves the
    // drawn globe (and every pick) shifted against the SVG overlay — data
    // symbols float off their states and a click lands countries away.
    globeMap.setTransform(transform);
  } else {
    deck?.setProps({ viewState: viewState() });
    hoverDeck?.setProps({ viewState: viewState() });
  }
  insetDeck?.setProps({ viewState: insetViewState() });
  placeInsetUi();
  globeMap?.requestDraw();
}

if (!globeMap) {
  deck = new Deck({
    canvas: "map-canvas",
    views: new OrthographicView({ id: "map-view", flipY: true }),
    controller: false,
    viewState: viewState(),
    // Nothing here is 3-D: layers stack in the order they are listed, exactly
    // as SVG paints them.
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
    deviceProps: DEVICE_PROPS,
    layers: [],
    onResize: ({ width, height }) => onViewResize(width, height),
  });
}

// The hover deck, on a canvas between the map and the insets. Its camera has
// to track the map's exactly, because it draws map content: unlike the inset
// deck below â whose camera is pinned and never moves â every pan and zoom
// has to push a new viewState here as well.
// The globe needs neither this canvas nor this deck. Its scene lives in a
// texture, so a hover frame copies that texture and draws one county over it —
// the same arrangement inside ONE context, which it has to be, because a second
// context could not share the 28 MB of buffers.
if (!globeMap) {
  hoverDeck = new Deck({
    canvas: "hover-canvas",
    views: new OrthographicView({ id: "hover-view", flipY: true }),
    controller: false,
    viewState: viewState(),
    parameters: { depthWriteEnabled: false, depthCompare: "always" },
    deviceProps: DEVICE_PROPS,
    layers: [],
  });
} else {
  // display, not `hidden`: the stylesheet gives this canvas display: block.
  document.getElementById("hover-canvas").style.display = "none";
  new ResizeObserver(([e]) => onViewResize(e.contentRect.width, e.contentRect.height)).observe(
    mapWrap
  );
  onViewResize(mapWrap.clientWidth, mapWrap.clientHeight);
}

// The third deck: the Alaska/Hawaii insets, on their own canvas above the
// map. Fixed-camera HUD elements can't share the map's deck — deck fits a
// mask layer to its first viewport, so the pinned inset band and the
// pan-and-zoom map band would fight over the one mask fitting.
insetDeck = new Deck({
  canvas: "inset-canvas",
  views: new OrthographicView({ id: "inset-view", flipY: true }),
  controller: false,
  viewState: insetViewState(),
  parameters: { depthWriteEnabled: false, depthCompare: "always" },
  deviceProps: DEVICE_PROPS,
  layers: [],
});

// The map is a canvas now, but the pointer still lands on an SVG stretched over
// it. Keeping d3.zoom on an element with the map's own 975x610 viewBox means
// the wheel feel and the scale limits stay the same numbers in the same
// coordinate space; only the transform's destination changed. Panning is
// deliberately unbounded (no translateExtent), so the map can be dragged
// past its edges even at minimum zoom.
// Zoom 1 frames the lower 48 (the same scale the US-only map always had, so
// 16 keeps its meaning as the max); the lower bound is whatever fits the
// land now in view — recomputed after a re-bake, since turning the globe
// changes what that is.
const minZoomFor = () =>
  Math.min(
    1,
    975 / (MAP_BOUNDS.x1 - MAP_BOUNDS.x0),
    610 / (MAP_BOUNDS.y1 - MAP_BOUNDS.y0)
  );
let MIN_ZOOM = minZoomFor();
// While a pan or wheel gesture is in flight, GPU picking pauses: every pick
// renders the county layer into the picking buffer and then reads pixels
// back synchronously — a CPU–GPU stall injected exactly when frames are at
// their most expensive (drag-panning fires pointermove all the way through).
// The hover tint is drawn in map coordinates, so the frozen tint stays glued
// to its county while the map moves under the pointer; the gesture's end
// runs one pick to catch whatever sits under the cursor now. Painting never
// coincides with a gesture — the zoom filter blocks drag-pan in paint mode
// and wheel while a button is down — so pausing here can't block a brush.
let gesturing = false;
// The zoom that would frame the whole sphere, with a little air around it. The
// camera never goes there on its own — it is only the zoom's lower bound, so
// the view CAN be pulled back that far. The land-fit floor (MIN_ZOOM) is far
// tighter, so the sphere fit is what actually bounds the wheel.
const GLOBE_FIT_K = (Math.min(975, 610) * 0.92) / (2 * GLOBE_SCALE);
const applyScaleExtent = () =>
  zoom.scaleExtent([Math.min(MIN_ZOOM, GLOBE_FIT_K), 16]);
const zoom = d3
  .zoom()
  .scaleExtent([Math.min(MIN_ZOOM, GLOBE_FIT_K), 16])
  .extent([[0, 0], [975, 610]])
  .filter((ev) => {
    if (ev.type === "wheel") return !ev.button;
    // No drag-pan, ever: a drag always means something else — painting
    // states, a carve stroke, or turning the globe. d3.zoom owns the wheel
    // and the programmatic transforms only.
    return false;
  })
  .on("start.hover", () => {
    gesturing = true;
  })
  .on("end.hover", (ev) => {
    gesturing = false;
    // Programmatic transforms carry no sourceEvent and need no catch-up
    // pick (the startup seed runs before the refresh section initializes,
    // and the reset buttons live outside the map, where no hover is live).
    if (ev.sourceEvent) scheduleHover();
  })
  .on("zoom", (ev) => {
    transform = ev.transform;
    if (globeMap) {
      globeMap.setTransform(transform);
      globeMap.requestDraw();
    } else {
      const view = viewState();
      deck.setProps({ viewState: view });
      hoverDeck.setProps({ viewState: view });
    }
    labelGroup.attr("transform", transform);
    markGroup.attr("transform", transform);
    stateLabelGroup.attr("transform", transform);
    knifeGroup.attr("transform", transform);
    // The tooltip is pinned in screen space, so the map sliding under it
    // would leave it pointing at the wrong county; the end-of-gesture pick
    // brings it back. Only user gestures carry a sourceEvent — programmatic
    // transforms (the startup seed, Reset view) skip the hide, and the seed
    // in particular runs before the tooltip section below has initialized.
    if (ev.sourceEvent) hideTooltip();
  });
svg.call(zoom).on("dblclick.zoom", null);
// Seed the zoom with the home transform so the SVG label groups and d3.zoom's
// internal state start on the same shifted view deck draws; assigning
// `transform` alone leaves the labels (and the first wheel gesture) at
// identity, misaligned with the map.
svg.call(zoom.transform, HOME_TRANSFORM);

// Test hook: drive the view from the same numbers as the reference build.
window.__setTransform = (k, x, y) => svg.call(zoom.transform, d3.zoomIdentity.translate(x, y).scale(k));

// ----------------------------------------------------------- turning the globe

// Re-face the globe. Everything projected is rebuilt from the same lon/lat
// sources the load path used, in the same order, so a rotation leaves the map
// in exactly the state a fresh load at that facing would have produced —
// including any carves, which are re-projected from the tract topology they
// were cut from rather than being lost.
function setRotation(rot) {
  viewRotation = [rot[0], Math.max(-90, Math.min(90, rot[1]))];
  // On the globe a turn is a uniform write, so this runs per frame of a drag
  // rather than once at the end of one. Everything a re-bake used to produce is
  // either unchanged (the geometry, which lives on the sphere) or is one of the
  // two things below: the extent of the land in view, and the county centroids
  // the data view places its symbols and values from.
  if (globeMap) {
    globeMap.setRotation(viewRotation);
    computeMapBounds();
    computeCountyGeo();
    MIN_ZOOM = minZoomFor();
    applyScaleExtent();
    // Not scheduleRefresh: nothing in the model moved, so the sidebar, the
    // stats and the label LAYOUT all stand. Only the placements that read a
    // projection have to be redone, and only in the view that shows them.
    if (inDataView()) {
      mapVersion++;
      renderDataLabels();
    }
    globeMap.requestDraw();
    return;
  }
  PROJ.main = mainProjection(viewRotation);
  tracers.main = makeTracer(PROJ.main);
  assembleBake(bakeMain());
  snapshotBase();
  rebakeSplits();
  // Carve hit-testing indexes the as-baked shapes, so it has to go; it
  // rebuilds itself on the next cut.
  carveIndex = null;
  // rebuildWorld re-derives the live arrays from the fresh BASE_ snapshots
  // and whatever carves stand, and finishes with computeCountyGeo and
  // rebuildDerived — so it is the right call whether or not anything is
  // carved.
  rebuildWorld();
  stateLabeler = makeMainLabeler();
  MIN_ZOOM = minZoomFor();
  applyScaleExtent();
  scheduleRefresh();
}

// A drag in globe mode turns the sphere. Design-space pixels convert to
// degrees through the globe's own radius, so a grab tracks the surface under
// the cursor at any zoom: one radius of travel is one radian of arc.
const DEG_PER_UNIT = 180 / Math.PI / GLOBE_SCALE;
let spinFrom = null; // { x, y, rot } while a spin drag is live
// A spin is not a d3.zoom gesture, so nothing suppresses the click that
// follows it; without this a turn of the globe would also clear the selection
// on release.
let spinMoved = false;

// ------------------------------------------------------- the spin preview
//
// A spin has to redraw the map every frame, and a full bake is ~130 ms — fine
// for the one settle at the end of a drag, hopeless at 60 fps. The cost is
// dominated by per-geometry stream overhead across thousands of counties and
// arcs, so thinning the whole map does not help. What the preview draws
// instead is one merged, thinned outline per state: ~130 geometries and ~12k
// points, about 4 ms to re-project. So the map keeps its own colors while it
// turns, and only the detail — county lines, border bands, lakes, the state
// names — waits for the settle.

const SPIN_STEP = 8; // keep one vertex in eight
const SPIN_MIN_DEG = 0.25; // and drop rings smaller than this across

// How far a ring reaches, in degrees, along its wider axis.
function ringSpan(ring) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const [x, y] of ring) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return Math.max(x1 - x0, y1 - y0);
}

// A ring's winding is what tells d3 which side of it is inside, and a stride
// through a wiggly sliver can hand back a ring that turns the other way —
// three of Belize's cays, a Nunavut islet and one Hudson Bay pond do exactly
// that. Such a ring no longer reads as a small island but as a polygon
// covering the rest of the world, and clipping that to the hemisphere emits
// the horizon circle, which the preview then fills: the whole globe floods
// with one color the moment a drag starts. So a thinned ring is kept only
// while it still turns the way the original did. Spherical area over a
// hemisphere is that test, and it reads holes correctly too — a hole covers
// "everything but", before and after.
function turnsTheSameWay(a, b) {
  const inverted = (ring) => d3.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI;
  return inverted(a) === inverted(b);
}

function thinRing(ring) {
  if (ring.length <= SPIN_STEP + 2) return ring;
  const out = [];
  for (let i = 0; i < ring.length; i += SPIN_STEP) out.push(ring[i]);
  if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
  return out.length >= 4 && turnsTheSameWay(out, ring) ? out : ring;
}

// Two cuts, and the second is the one that pays. Thinning alone barely helps:
// most of a merged outline's rings are already short — every lake islet and
// offshore rock the source draws — so a stride hits its don't-collapse floor
// on thousands of them and the point count hardly moves. Dropping those rings
// outright is what makes the preview cheap, and a speck a quarter degree
// across is invisible at any zoom a spin happens at.
function coarsen(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  // The outer ring decides whether the polygon appears at all; holes are
  // judged on their own, so a big lake stays a hole and a pond does not.
  const coarsePoly = (rings) =>
    [rings[0], ...rings.slice(1).filter((r) => ringSpan(r) >= SPIN_MIN_DEG)].map(thinRing);
  const kept = [];
  for (const rings of polys) {
    if (ringSpan(rings[0]) >= SPIN_MIN_DEG) kept.push(coarsePoly(rings));
  }
  // A state the filter would drop whole — DC, a small island country — still
  // has to draw: one enclosed by its neighbors would otherwise leave a hole
  // in the land where it belongs. Its widest polygon is kept at any size.
  if (!kept.length && polys.length) {
    kept.push(coarsePoly(polys.reduce((a, b) => (ringSpan(b[0]) > ringSpan(a[0]) ? b : a))));
  }
  return { type: "MultiPolygon", coordinates: kept };
}

// The scenery land, coarsened once. Nothing it holds can change hands, so
// unlike the states it is built on first use and then kept for good.
let spinWorld = null;
const spinWorldGeometry = () =>
  (spinWorld ??= worldLand.map((f) => coarsen(f.geometry)).filter((g) => g.coordinates.length));

// The preview's outlines, one per state, merged straight off the topology so
// that neighbors share their border exactly and the coarse shapes still tile
// without slivers — which is why the preview needs no white backing under it.
// Merging and thinning ~3500 units costs ~50 ms, so the result is cached
// until territory changes hands. Colors are not baked in here: a recolor
// moves no border, so the two are read separately.
let spinShapes = EMPTY;
let spinShapesFor = -1;
function spinGeometry() {
  if (spinShapesFor === assignVersion) return spinShapes;
  const groups = new Map();
  for (const g of topo.objects.counties.geometries) {
    // A carve divides a county between states, and merging cannot cut an arc,
    // so the preview gives a carved county whole to the state that holds its
    // biggest piece — coarse, like everything else it draws.
    const sid = assign.get(splits.get(g.id)?.backingId ?? g.id);
    if (!sid) continue;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(g);
  }
  spinShapes = [...groups].map(([sid, gs]) => ({ sid, geometry: coarsen(merge(topo, gs)) }));
  spinShapesFor = assignVersion;
  return spinShapes;
}

// What color each state wears in the preview, on the same rules the full map
// follows — minus the paint-mode dim, since the press that starts a spin is
// filtered out while painting. Read once when the drag begins: nothing can
// repaint the map mid-spin.
let spinFill = new Map();
function spinColors() {
  const dataView = inDataView();
  const statKey = rankStatSel.value;
  const choro = dataView && !SYMBOL_STATS[statKey] ? choroplethFills(statKey) : null;
  const out = new Map();
  for (const [sid, info] of stateInfo) {
    out.set(
      sid,
      !dataView
        ? rgba(sid === selected ? highlight(info.color) : info.color)
        : info.foreign
          ? FOREIGN_LAND
          : choro
            ? (choro.get(sid) ?? NO_DATA)
            : GREY_LAND
    );
  }
  return out;
}

// The frames of a spin: the sphere, the graticule, and the coarse state
// outlines in the colors the map is wearing.
function spinLayers() {
  // The preview projects through a tracer of its own. PROJ.main and
  // tracers.main still hold the facing the last settle baked, and hover,
  // picking, carving and the labels all read that — they come back only when
  // the settle re-bakes them at the facing the drag ended on.
  tracers.spin = makeTracer(mainProjection(viewRotation));
  const parts = [];
  // Scenery first, so the map's own states draw over it exactly as they do in
  // the full stack.
  for (const geometry of spinWorldGeometry()) {
    parts.push(...projectParts(geometry, { color: WORLD_LAND }, "spin"));
  }
  for (const { sid, geometry } of spinGeometry()) {
    parts.push(...projectParts(geometry, { color: spinFill.get(sid) ?? GREY_LAND }, "spin"));
  }
  return [
    new SolidPolygonLayer({
      id: "spin-sphere",
      data: [SPHERE_DISC],
      getPolygon: (d) => d.rings,
      getFillColor: OCEAN,
      ...FLAT,
    }),
    new PathLayer({
      id: "spin-graticule",
      data: projectLines(GRATICULE, "spin").map((path) => ({ path })),
      getPath: (d) => d.path,
      getColor: GRATICULE_LINE,
      getWidth: 0.7,
      widthUnits: "common",
      ...FLAT,
    }),
    new SolidPolygonLayer({
      id: "spin-land",
      data: parts,
      getPolygon: (d) => d.rings,
      getFillColor: (d) => d.color,
      ...FLAT,
    }),
  ];
}

// The drag has travelled far enough to count: swap the map for the preview.
// Everything the preview leaves out has to go with it — the hover tint and
// the state names are placed against the facing of the last bake, so they
// would sit over the wrong ground the moment the globe moves. The labels hide
// through a class on the SVG rather than their own display attribute, which
// the labeler owns and rewrites on every refresh.
function beginSpin() {
  spinMoved = true;
  // The whole preview apparatus exists because a full bake is ~130 ms. On the
  // globe a turn is a mat3 uniform, so there is nothing to preview and nothing
  // to settle — the real map turns under the cursor, county lines, labels and
  // all. This is the change the rewrite was for.
  if (globeMap) return;
  spinFill = spinColors();
  hoverDeck.setProps({ layers: [] });
  svg.classed("spinning", true);
}

let spinFrame = 0;
function spinTo(rot) {
  if (globeMap) {
    setRotation(rot);
    return;
  }
  viewRotation = [rot[0], Math.max(-90, Math.min(90, rot[1]))];
  // Pointer events outrun the display — a high-rate mouse fires several per
  // frame — so the retrace waits for the frame that will actually show it.
  if (!spinFrame) spinFrame = requestAnimationFrame(drawSpin);
}
function drawSpin() {
  spinFrame = 0;
  deck.setProps({ layers: spinLayers() });
}

// The end of the gesture: the coarse preview gives way to a full bake at the
// facing the drag ended on. The settle is the expensive step, and it happens
// once per gesture rather than once per frame. The preview class comes off
// before the bake rather than after, because the bake and the refresh it
// schedules both finish before the browser paints again — so the labels return
// in the same frame as the baked map instead of flashing at their old places
// for one.
function settleSpin() {
  spinFrom = null;
  // A press that never moved leaves the facing alone, so it costs no bake and
  // still reads as a plain click on whatever is under it.
  if (!spinMoved) return;
  // Nothing to settle: every frame of the drag was already the real map.
  if (globeMap) return;
  if (spinFrame) cancelAnimationFrame(spinFrame);
  spinFrame = 0;
  svg.classed("spinning", false);
  setRotation(viewRotation);
}

// ------------------------------------------------------------- inset boxes

// The Alaska and Hawaii insets are toggled by the buttons next to "Reset
// view" (both start open). Each
// open box's thin frame is drawn in the overlay SVG; placeInsetUi gives the
// frame group the transform that maps the boxes' design coordinates to the
// same fixed screen spot the inset deck's camera puts their content, and a
// non-scaling stroke keeps the frame hairline-thin.

// The overlay SVG works in its 975x610 viewBox, so the frames need design →
// CSS (the inset camera at its current scale) → viewBox (the reverse of the
// SVG's own meet fit), rebuilt whenever the canvas resizes.
function placeInsetUi() {
  const s = insetScale();
  const t = insetViewState().target;
  const fit = Math.min(viewWidth / 975, viewHeight / 610);
  const ax = (viewWidth / 2 - (viewWidth - 975 * fit) / 2) / s - t[0];
  const ay = (viewHeight / 2 - (viewHeight - 610 * fit) / 2) / s - t[1];
  const place = `scale(${s / fit}) translate(${ax} ${ay})`;
  insetGroup.attr("transform", place);
  insetLabelGroup.attr("transform", place);
  insetDataLabelGroup.attr("transform", place);
  insetMaskHoles.attr("transform", place);
  clipInsetCanvas();
}

// The inset deck's canvas spans the whole map, and wide strokes (the 16px
// coast halo, a selection casing) drawn along an edge the clip extent cut
// poke half their width past the frame — over the map. A CSS clip on the
// canvas cuts everything at the open boxes. CSS pixels, straight from the
// inset camera's screen = world - target + size/2.
function clipInsetCanvas() {
  const t = insetViewState().target;
  const d = ["ak", "hi"]
    .filter((key) => !insetHidden[key])
    .map((key) => {
      const b = INSETS[key];
      const x = b.x - t[0] + viewWidth / 2;
      const y = b.y - t[1] + viewHeight / 2;
      return `M${x} ${y}h${b.w}v${b.h}h${-b.w}Z`;
    })
    .join("");
  insetCanvas.style.clipPath = `path("${d || "M0 0Z"}")`;
}
placeInsetUi();

function renderInsetUi() {
  const frame = (key) => {
    if (insetHidden[key]) return "";
    const b = INSETS[key];
    return `<rect class="inset-frame" x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
  };
  insetGroup.html(frame("ak") + frame("hi"));
  // The label mask's holes and the canvas clip track the frames: an open box
  // knocks the globe labels out from over itself and bounds its own drawing.
  const hole = (key) => {
    if (insetHidden[key]) return "";
    const b = INSETS[key];
    return `<rect x="${b.x}" y="${b.y}" width="${b.w}" height="${b.h}"/>`;
  };
  insetMaskHoles.html(hole("ak") + hole("hi"));
  clipInsetCanvas();
  for (const key of ["ak", "hi"]) {
    const btn = document.getElementById(`inset-${key}`);
    btn.classList.toggle("active", !insetHidden[key]);
    btn.setAttribute("aria-pressed", String(!insetHidden[key]));
    btn.title = `${insetHidden[key] ? "Show" : "Hide"} the ${INSETS[key].name} inset`;
  }
}
renderInsetUi();
for (const key of ["ak", "hi"]) {
  document.getElementById(`inset-${key}`).addEventListener("click", () => {
    insetHidden[key] = !insetHidden[key];
    rebuildVisible();
    renderInsetUi();
    scheduleRefresh();
  });
}

// Crossing the phone/desktop cutoff resets the boxes to that side's default
// (closed on a phone, open on desktop). The load-time seed alone would leave
// the boxes open after a rotation or a resize into the narrow layout — where,
// even scaled down, they are better off out of the way until asked for.
narrowScreen.addEventListener("change", (e) => {
  insetHidden.ak = insetHidden.hi = e.matches;
  rebuildVisible();
  renderInsetUi();
  scheduleRefresh();
});

// Merging the spin preview's outlines costs ~50 ms; paying it at startup
// keeps it out of the first frame of the first drag, which is where it would
// show as a stutter. The globe renderer has no preview to build.
if (!globeMap) (spinGeometry(), spinWorldGeometry());

// Which open inset box, if any, the given CSS-pixel point falls in — the
// inverse of the inset camera: a shift and, on a narrow map, its scale.
function insetBoxAt(x, y) {
  const s = insetScale();
  const t = insetViewState().target;
  const wx = (x - viewWidth / 2) / s + t[0];
  const wy = (y - viewHeight / 2) / s + t[1];
  for (const key of ["ak", "hi"]) {
    if (insetHidden[key]) continue;
    const b = INSETS[key];
    if (wx >= b.x && wx <= b.x + b.w && wy >= b.y && wy <= b.y + b.h) return key;
  }
  return null;
}

// The county under the pointer, picked on the GPU. An open inset sits above
// the globe, so inside its box only the inset deck is asked — a miss on the
// white backing is a miss, not a fall-through to whatever map hides under
// the box.
function pickCounty(ev) {
  const rect = mapWrap.getBoundingClientRect();
  const x = ev.clientX - rect.left;
  const y = ev.clientY - rect.top;
  if (insetBoxAt(x, y))
    return insetDeck.pickObject({ x, y, layerIds: ["inset-counties"] })?.object?.fips ?? null;
  // Outside a box the globe answers analytically: invert the camera to a
  // lon/lat, then ask a grid over the source rings. Half a microsecond, no
  // readback, and so no reason to stop picking during a gesture.
  if (globeMap) return globeMap.pickAt(x, y);
  return deck.pickObject({ x, y, layerIds: ["counties"] })?.object?.fips ?? null;
}

// A pointer event in map (design-space) coordinates: through the SVG's
// viewBox fit, then back out of the zoom — the space the projected parts,
// the tract centroids, and the knife line all share.
function pointerWorld(ev) {
  const [vx, vy] = d3.pointer(ev, svg.node());
  return transform.invert([vx, vy]);
}

// ----------------------------------------------------------------- refresh

let raf = 0;
let sidebarDirty = false;
// Whether the next frame owes a full rebuild (model changed) or just hover.
let fullRefresh = false;

// Anything that changes the model — an assignment, a color, the selection,
// paint mode. The version number is what tells deck.gl's accessors to re-run.
function scheduleRefresh() {
  mapVersion++;
  statsCache = null;
  hoverStateCache.sid = null;
  sidebarDirty = true;
  fullRefresh = true;
  if (!raf) raf = requestAnimationFrame(doRefresh);
}

// Hover only moves one small overlay layer, so it leaves the fills, the borders
// and the whole sidebar alone.
function scheduleHover() {
  if (!raf) raf = requestAnimationFrame(doRefresh);
}

// What the hover layers were last given, so a hover-only frame can tell
// whether anything it owns actually changed (hoverSplit returns its cache
// object; a new object means new content). The inset hover layer sits in
// the middle of the inset deck's stack, so updating it re-sends the whole
// list with just that one layer rebuilt — deck matches the re-passed
// instances by identity and skips them outright, which makes the splice
// cheaper than a rebuild, not just equivalent.
let hoverApplied = null;
let hoverUnitsApplied = "";
let insetLayerList = EMPTY;

// The cheap path for pure hover frames: the pointer moved, nothing else did.
// Rebuilding and re-diffing the full three-deck stack (~40 layers) on every
// mouse move is real CPU work for no change — only the two hover layers can
// differ here.
function refreshHoverOnly() {
  // The globe's half of this is its own comparison, on its own inputs: a set of
  // units rather than a set of projected parts. Everything else here is the
  // inset deck, which still wants the parts.
  if (globeMap) {
    const key = `${hoverFips}:${inDataView()}:${assignVersion}`;
    if (key !== hoverUnitsApplied) {
      hoverUnitsApplied = key;
      globeMap.setHover(hoverUnits());
      globeMap.requestDraw();
    }
  }
  const split = hoverSplit();
  if (split === hoverApplied) return;
  const prev = hoverApplied;
  hoverApplied = split;
  if (!globeMap && (!prev || split.main !== prev.main)) {
    hoverDeck.setProps({ layers: [countyHoverLayer(split.main)] });
  }
  if (!prev || split.inset !== prev.inset) {
    insetLayerList = insetLayerList.map((l) =>
      l.id === "inset-hover" ? insetHoverLayer(split.inset) : l
    );
    insetDeck.setProps({ layers: insetLayerList });
  }
}

function doRefresh() {
  raf = 0;
  // Picking is only cheap to do once per frame, and this is that frame's one
  // chance to run it before the layers below read hoverFips — running it via
  // its own separate requestAnimationFrame would push the hover shade a full
  // frame further behind the cursor.
  processPointerMove();
  // Read after the pick: a brush stroke inside processPointerMove upgrades
  // this frame to a full refresh.
  if (!fullRefresh) {
    refreshHoverOnly();
    return;
  }
  fullRefresh = false;
  const layers = buildLayers();
  hoverApplied = hoverSplit();
  insetLayerList = layers.inset;
  if (globeMap) {
    paintGlobe();
    hoverUnitsApplied = `${hoverFips}:${inDataView()}:${assignVersion}`;
    globeMap.setHover(hoverUnits());
  } else {
    deck.setProps({ layers: layers.map });
    hoverDeck.setProps({ layers: layers.hover });
  }
  insetDeck.setProps({ layers: layers.inset });
  renderDataLabels();
  stateLabeler.update({ assignVersion, labelsVersion, visible: !inDataView(), assign, stateInfo });
  for (const key of ["ak", "hi"])
    insetLabelers[key].update({
      assignVersion,
      labelsVersion,
      visible: !inDataView() && !insetHidden[key],
      assign,
      stateInfo,
    });
  renderLegend();
  if (sidebarDirty) {
    sidebarDirty = false;
    renderSidebar();
  }
}

// ----------------------------------------------------------- touch gestures
//
// On touch, one finger keeps the left-button meaning the mouse has — spin the
// globe, paint, drive the knife — and two fingers pinch-zoom and pan. The
// pinch builds a d3 transform in the SVG's own 975x610 viewBox space and
// applies it through zoom.transform, so it rides the exact pipeline the wheel
// does: the zoom handler moves the decks and the label groups, and nothing
// else has to know a pinch exists. Mouse and pen never enter this section.
//
// The little state machine below arbitrates the fingers: "one" is a live
// single-finger gesture (owned by the existing handlers), a second finger
// cancels it and starts a "pinch", and when the pinch loses a finger the
// survivor is a "tail" — inert on purpose, so the finger left resting on the
// glass can't start painting or spinning until it lifts and presses again.

const activeTouches = new Map(); // pointerId -> [x, y] in viewBox coordinates
let touchState = "idle"; // "idle" | "one" | "pinch" | "tail"
let pinchAnchor = null; // { t0, p0, d0 } — transform, world midpoint, distance at anchor time
// A multi-finger gesture can still end in a browser-synthesized click for the
// primary finger (which would clear the selection); clicks before this stamp
// are swallowed.
let suppressClicksUntil = 0;
// Double-tap synthesis: the last clean touch tap, and the stamp of the last
// synthesized activation so a browser that fires a real dblclick for the same
// double-tap (Chrome on Android does under touch-action: none) doesn't run it
// twice.
let lastTap = null; // { t, x, y } in client coordinates
let lastSyntheticDbl = -Infinity;

const vbPoint = (ev) => d3.pointer(ev, svg.node());

// The two oldest fingers drive the pinch; a third is tracked but ignored.
function pinchPair() {
  const it = activeTouches.values();
  return [it.next().value, it.next().value];
}

function beginPinch() {
  const [a, b] = pinchPair();
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  pinchAnchor = {
    t0: transform,
    p0: transform.invert(c),
    d0: Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1e-3),
  };
}

function applyPinch(ev) {
  const [a, b] = pinchPair();
  const c = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const d = Math.max(Math.hypot(a[0] - b[0], a[1] - b[1]), 1e-3);
  // zoom.transform applies its argument verbatim — neither the filter nor the
  // scale extent runs — so the clamp happens here, read live because a globe
  // turn moves the lower bound (applyScaleExtent). The world anchor pins the
  // ground under the fingers' midpoint, which is also what makes the pair a
  // pan when it travels without spreading. Pan is unclamped, like the wheel's.
  const [kMin, kMax] = zoom.scaleExtent();
  const k = Math.max(kMin, Math.min(kMax, pinchAnchor.t0.k * (d / pinchAnchor.d0)));
  const t = d3.zoomIdentity.translate(c[0], c[1]).scale(k).translate(-pinchAnchor.p0[0], -pinchAnchor.p0[1]);
  // Passing ev sets sourceEvent on the emitted zoom events, so the handler
  // treats a pinch exactly like a wheel (hides the tooltip, catches up hover).
  svg.call(zoom.transform, t, c, ev);
}

// A second finger abandons whatever the first was doing, without committing
// it: the spin settles where it is, the brush stroke and the knife stroke
// stop (placed knife vertices survive — pinch to reposition, keep placing),
// and the parked give-back click is forgotten.
function cancelOneFingerAction() {
  if (spinFrom) {
    settleSpin();
    spinMoved = false;
  }
  brush = 0;
  clickUndo = null;
  if (knifeDrag) {
    knifeDrag = null;
    renderKnife(null);
  }
  lastPointerEvent = null;
  hideTooltip();
  if (hoverFips) {
    hoverFips = null;
    scheduleHover();
  }
}

// Touch bookkeeping for a press. True means the event belongs to the pinch
// machinery and the mode logic must not see it.
function touchDown(ev) {
  if (ev.pointerType !== "touch") return false;
  activeTouches.set(ev.pointerId, vbPoint(ev));
  if (touchState === "idle" && activeTouches.size === 1) {
    touchState = "one";
    return false; // the existing one-finger logic runs
  }
  if (touchState === "one") {
    cancelOneFingerAction();
    touchState = "pinch";
    beginPinch();
    return true;
  }
  if (touchState === "tail" && activeTouches.size >= 2) {
    touchState = "pinch";
    beginPinch();
    return true;
  }
  return true; // a third finger mid-pinch, or any stray press
}

// The same for a move: a pinch move re-applies the transform, a tail move is
// swallowed, a one-finger move falls through to the existing handlers.
function touchMove(ev) {
  if (ev.pointerType !== "touch") return false;
  if (activeTouches.has(ev.pointerId)) activeTouches.set(ev.pointerId, vbPoint(ev));
  if (touchState === "pinch") {
    applyPinch(ev);
    return true;
  }
  return touchState === "tail";
}

function endTouchSequence(ev) {
  touchState = "idle";
  pinchAnchor = null;
  suppressClicksUntil = ev.timeStamp + 500;
}

// A release (or cancel). "skip" = the pinch machinery consumed it, "tap" = a
// tracked single-finger touch ended and may be half of a double-tap, false =
// not touch, or not this machinery's business — the ordinary settle runs.
function touchRelease(ev) {
  if (ev.pointerType !== "touch") return false;
  const tracked = activeTouches.delete(ev.pointerId);
  if (touchState === "pinch") {
    if (activeTouches.size >= 2) beginPinch(); // re-anchor on the survivors
    else if (activeTouches.size === 1) {
      pinchAnchor = null;
      touchState = "tail";
    } else endTouchSequence(ev);
    return "skip";
  }
  if (touchState === "tail") {
    if (activeTouches.size === 0) endTouchSequence(ev);
    return "skip";
  }
  if (touchState === "one" && activeTouches.size === 0) touchState = "idle";
  return tracked ? "tap" : false;
}

// Two clean taps close together in time and place synthesize the dblclick
// touch never reliably gets (iOS Safari fires none under touch-action: none).
// Read before the release settles — the settle resets the flags that tell a
// tap from a drag — but acted on after it, so the second tap's own action
// (vertex placement, the selection click) lands first, like desktop's
// click-click-dblclick order.
function detectDoubleTap(ev) {
  if (!spinMoved && !knifeDrag?.moved) {
    const prev = lastTap;
    lastTap = { t: ev.timeStamp, x: ev.clientX, y: ev.clientY };
    if (
      prev &&
      ev.timeStamp - prev.t < 350 &&
      Math.hypot(ev.clientX - prev.x, ev.clientY - prev.y) < 30
    )
      return (lastTap = null), true;
  } else lastTap = null;
  return false;
}

// ---------------------------------------------------------------- painting

let brush = 0; // the ev.buttons bit that sustains the stroke; 0 = idle
let brushRevert = false; // this stroke gives counties back instead of claiming
// A left press on a county the state holds but didn't start with is ambiguous:
// released in place it means "give this county back", but the same press can
// also begin a claiming drag out of the state's own territory (all the ground
// a custom state has). The county is parked here until the pointer either
// leaves it (a drag — claim as usual) or lifts on it (a click — give it back).
let clickUndo = null;

function applyBrush(fips) {
  const target = brushRevert ? origAssign.get(fips) : selected;
  const prev = assign.get(fips);
  if (!target || prev === target) return;
  assign.set(fips, target);
  touchTerritory();
  stateCounts.set(prev, (stateCounts.get(prev) ?? 1) - 1);
  stateCounts.set(target, (stateCounts.get(target) ?? 0) + 1);
  // A custom state's real color is picked when it claims its first county,
  // once its surroundings are known.
  if (target === selected && stateCounts.get(target) === 1) recolorState(target);
  scheduleRefresh();
}

svg.on("pointerdown", (ev) => {
  // Touch bookkeeping first: a second finger turns any gesture into a pinch,
  // and while the pinch (or its leftover tail finger) is live, no mode logic
  // may see the press.
  if (touchDown(ev)) return;
  // A left press grabs the sphere. d3.zoom's own drag-pan is filtered out
  // entirely, so the two can't fight over the gesture; the wheel still zooms.
  if (!paintMode && !carveMode && ev.button === 0) {
    const [x, y] = pointerWorld(ev);
    spinFrom = { x, y, rot: [...viewRotation] };
    spinMoved = false;
    hideTooltip();
    ev.preventDefault();
    return;
  }
  // The armed carve knife: a left press starts a possible stroke — a drag
  // becomes a freehand cut, a stationary click places a vertex of a
  // click-to-draw cut (double-click or Enter finishes it). A right press
  // removes the last placed vertex.
  if (carveMode) {
    if (carving) return; // the previous stroke is still being applied
    if (ev.button === 2) {
      if (carvePending.length) {
        carvePending.pop();
        renderKnife(pointerWorld(ev));
      }
      ev.preventDefault();
      return;
    }
    if (ev.button !== 0) return;
    knifeDrag = { points: [pointerWorld(ev)], moved: false };
    lastPointerEvent = ev;
    ev.preventDefault();
    return;
  }
  if (!paintMode || !selected) return;
  const fips = pickCounty(ev);
  if (!fips) return;
  brush = ev.button === 2 ? 2 : 1;
  brushRevert = ev.button === 2; // right-click gives back
  clickUndo = null;
  // The stroke-sustain check reads lastPointerEvent's buttons, and without
  // this line that is still the pre-press move (buttons: 0) — the refresh the
  // brush schedules would then kill the stroke before the drag's first move.
  lastPointerEvent = ev;
  ev.preventDefault();
  // Left-pressing a county the state holds but didn't start with gives it
  // back — but only if the press stays a click. The decision waits for the
  // release (see clickUndo above), so a drag that starts there claims.
  if (!brushRevert && assign.get(fips) === selected && origAssign.get(fips) !== selected) {
    clickUndo = fips;
    return;
  }
  applyBrush(fips);
});
function settlePointerAction() {
  // A spin settles on release (see settleSpin).
  if (spinFrom) {
    settleSpin();
    return;
  }
  // A knife stroke settles on release: a drag cuts, a stationary click
  // places a vertex (at the press point, so a micro-wiggle can't move it).
  if (carveMode && knifeDrag) {
    const stroke = knifeDrag;
    knifeDrag = null;
    if (stroke.moved) finishCarve(stroke.points);
    else {
      carvePending.push(stroke.points[0]);
      renderKnife(null);
    }
    return;
  }
  if (brush && clickUndo) {
    brushRevert = true;
    applyBrush(clickUndo);
    brushRevert = false;
  }
  clickUndo = null;
  brush = 0;
}

function settlePointer(ev) {
  const release = touchRelease(ev);
  if (release === "skip") return;
  // The double-tap test reads the tap-or-drag flags the settle resets, so it
  // runs first; the activation waits until the settle has landed the tap's
  // own action (see detectDoubleTap).
  const dbl = release === "tap" && ev.type === "pointerup" && detectDoubleTap(ev);
  settlePointerAction();
  if (dbl) {
    lastSyntheticDbl = ev.timeStamp;
    handleDoubleActivate(ev);
  }
  // A lifted finger hovers nothing: clear the tint and the stored move, the
  // way pointerleave does for a mouse that left the map. (Kept after the
  // settle — the knife settle above wants the stroke's state intact.)
  if (ev.pointerType === "touch") {
    lastPointerEvent = null;
    if (hoverFips) {
      hoverFips = null;
      scheduleHover();
    }
  }
}
window.addEventListener("pointerup", settlePointer);
// Touch gestures can end in a cancel instead of a release — an OS edge
// swipe, an incoming call, palm rejection — and without this the spin, the
// knife stroke or the brush would stay live with no finger down.
window.addEventListener("pointercancel", settlePointer);
svg.on("contextmenu", (ev) => ev.preventDefault());

// Clicking a state selects it; clicking anywhere that isn't a county — the
// sea, a lake, past the border — clears the selection. A drag-pan never
// deselects: d3.zoom suppresses the click that follows a moved gesture.
svg.on("click", (ev) => {
  // The click a browser synthesizes for the primary finger of a finished
  // pinch is not a selection gesture either.
  if (ev.timeStamp < suppressClicksUntil) return;
  if (paintMode || carveMode) return;
  // The click that ends a spin drag is not a selection gesture.
  if (spinMoved) {
    spinMoved = false;
    return;
  }
  const fips = pickCounty(ev);
  select(fips ? assign.get(fips) : null);
});

// Double-click on a carved county's piece merges the county back together.
// While carving, it instead finishes the click-to-draw cut — its two clicks
// each placed a vertex at the same spot, and the cut dedupes them. d3.zoom's
// own dblclick zoom is already unbound above. Touch reaches this through the
// synthesized double-tap (detectDoubleTap), so the native handler skips a
// dblclick the synthesis already answered.
svg.on("dblclick", (ev) => {
  if (ev.timeStamp < suppressClicksUntil) return;
  if (ev.timeStamp - lastSyntheticDbl < 300) return;
  handleDoubleActivate(ev);
});
function handleDoubleActivate(ev) {
  if (paintMode) return;
  if (carveMode) {
    if (carvePending.length >= 2) finishCarve(carvePending);
    return;
  }
  const fips = pickCounty(ev);
  if (!fips) return;
  if (globeMap) {
    if (!globePieceIndex.has(fips)) return;
    // The whole county lands in the double-clicked piece's state, which is
    // the least surprising reading of "make this one whole again".
    const keepSid = assign.get(fips);
    const parent = globeMap.carve.rejoin(fips);
    if (!parent) return;
    syncGlobeCarves();
    assign.set(parent, keepSid);
    recountStates();
    touchTerritory();
    scheduleRefresh();
    mapNote(`${data.counties[parent].name} is whole again.`);
    return;
  }
  for (const [pid, s] of splits) {
    if (s.pieces.some((p) => p.id === fips)) {
      unsplitCounty(pid, fips);
      mapNote(`${data.counties[pid].name} is whole again.`);
      return;
    }
  }
}

// ----------------------------------------------------------------- tooltip

const tooltip = document.getElementById("tooltip");
// What the visible tooltip was rendered for — "fips:mapVersion", or null
// while hidden. Writing the tooltip's HTML and reading its size back for the
// edge clamp forces a synchronous layout pass, so it happens once when the
// pointer enters a county (or when the model under it changes, e.g. a brush
// stroke painting it), not on every mouse move: the tooltip sits where it
// appeared instead of following the cursor.
let tooltipFor = null;

function hideTooltip() {
  tooltip.hidden = true;
  tooltipFor = null;
}

// Show the freshly written tooltip by the pointer, clamped to the map edge.
// Reading offsetWidth/Height forces the layout pass the comment above
// describes, which is why callers write the HTML at most once per hover.
function placeTooltip(ev) {
  tooltip.hidden = false;
  const wrap = mapWrap.getBoundingClientRect();
  const x = ev.clientX - wrap.left;
  const y = ev.clientY - wrap.top;
  tooltip.style.left = Math.min(x + 14, wrap.width - tooltip.offsetWidth - 8) + "px";
  tooltip.style.top = Math.min(y + 18, wrap.height - tooltip.offsetHeight - 8) + "px";
}

// GPU picking (inside pickCounty) forces a render-and-readback, so it can't
// run on every raw pointermove — a fast mouse fires those far more often than
// the display can redraw. Instead each pointermove just records the latest
// event and asks for a refresh; doRefresh (one tick per animation frame,
// however it was scheduled) does the actual pick, feeding the hover
// highlight, the tooltip and the brush from whatever position is freshest by
// the time that frame's layers are built.
let lastPointerEvent = null;

function processPointerMove() {
  const ev = lastPointerEvent;
  // The gesture pause exists because a deck pick renders the county layer into
  // a picking buffer and reads it back — a CPU-GPU stall injected exactly when
  // frames are most expensive. The globe's pick is arithmetic, so it keeps up
  // through a pan or a wheel and the tint no longer freezes mid-gesture.
  if (!ev || (gesturing && !globeMap)) return;
  // The armed carve knife feeds on the pointer while a stroke is down;
  // otherwise carving leaves the ordinary county hover and tooltip alone —
  // they help aim the cut.
  if (carveMode) {
    const p = pointerWorld(ev);
    if (knifeDrag) {
      if (!(ev.buttons & 1)) {
        // The release happened outside the window, so no pointerup came:
        // drop the stroke and wipe whatever line it had drawn.
        knifeDrag = null;
        renderKnife(null);
      } else {
        // A press becomes a freehand stroke once it travels a few screen
        // pixels; until then it stays a candidate click (vertex placement).
        const start = knifeDrag.points[0];
        if (!knifeDrag.moved && Math.hypot(p[0] - start[0], p[1] - start[1]) * transform.k > 4) {
          knifeDrag.moved = true;
          carvePending.length = 0; // a drag starts a fresh cut
        }
        if (knifeDrag.moved) {
          knifeDrag.points.push(p);
          renderKnife(null);
          hoverFips = null;
          hideTooltip();
          return;
        }
      }
    }
    if (carvePending.length) renderKnife(p); // rubber-band to the cursor
  }
  const fips = pickCounty(ev);
  // doRefresh (our caller) is already mid-render this frame, so just setting
  // hoverFips is enough for the layers it builds next to pick it up — no
  // need to schedule another frame for it.
  hoverFips = fips;
  if (brush) {
    if (!(ev.buttons & brush)) brush = 0;
    else if (fips) {
      // Moving off the pressed county settles the click-or-drag ambiguity:
      // it's a drag, so the stroke claims from here on.
      if (clickUndo && fips !== clickUndo) clickUndo = null;
      if (!clickUndo) applyBrush(fips);
    }
  }
  // The tooltip is hover UI, and touch has no hover: under a finger it would
  // just sit beside a paint stroke re-rendering itself per county. The hover
  // tint and the brush above still run for touch.
  if (!fips || ev.pointerType === "touch") {
    hideTooltip();
    return;
  }
  const key = fips + ":" + mapVersion;
  if (key === tooltipFor) return;
  tooltipFor = key;
  if (inDataView()) {
    // County lines aren't drawn in data view, so the tooltip talks about the
    // state and the stat on display instead of the county. A unit outside
    // the union gets no reading — the view doesn't cover it, and quoting a
    // stat here would contradict the tan on the map.
    const sid = assign.get(fips);
    const info = stateInfo.get(sid);
    if (info.foreign) {
      tooltip.innerHTML = `<b>${info.name}</b>`;
    } else {
      const def = STAT_DEFS[rankStatSel.value];
      const s = getStats().get(sid);
      const v = s && s.n > 0 && (!def.has || def.has(s)) ? def.fmt(def.get(s)) : "—";
      tooltip.innerHTML = `<b>${info.name}</b><br>${rankStatSel.selectedOptions[0].textContent}: ${v}`;
    }
  } else {
    const c = data.counties[fips];
    const margin = c.tot ? " · " + fmtMargin((100 * (c.dem - c.gop)) / c.tot) : "";
    const income = c.mhi ? `<br>${fmtMoney(c.mhi)} median income` : "";
    const lifeExp = c.life ? `<br>${fmtYears(c.life)} life expectancy` : "";
    // A foreign unit standing alone is its own state; skip the redundant
    // "Alberta · Alberta".
    const sName = stateInfo.get(assign.get(fips)).name;
    const title = c.name === sName ? `<b>${c.name}</b>` : `<b>${c.name}</b> · ${sName}`;
    // A split county's halves carry real tract counts for population, race,
    // education and income, but GDP and the 2024 vote only exist per county
    // and divide by population share — say so wherever the numbers show. A
    // piece of a unit carved as a single tract (nothing finer published: a
    // Canadian division, a Mexican state, a country) divides everything by
    // land share, which is a stronger caveat and gets its own wording. Such a
    // piece is recognizable by its one weight keyed by the parent itself.
    const piece = globeMap ? globePieceIndex.get(fips) : null;
    const wholeCut = !!piece && piece.weights.has(piece.fips);
    const est = wholeCut
      ? `<br><span class="tip-note">Piece of a carved unit · figures estimated by land share</span>`
      : c.est
        ? `<br><span class="tip-note">Piece of a carved county · GDP &amp; 2024 vote estimated</span>`
        : "";
    tooltip.innerHTML = `${title}<br>${fmtPop(c.pop)} people${margin}${income}${lifeExp}${est}`;
  }
  placeTooltip(ev);
}

svg.on("pointermove", (ev) => {
  // A pinch move re-applies the two-finger transform; a tail move (the finger
  // a pinch left behind) is inert. Either way the mode logic below never sees
  // it — which also keeps lastPointerEvent null for the whole pinch, so no
  // pick runs mid-gesture.
  if (touchMove(ev)) return;
  // Mid-spin the pointer is steering the globe, not hovering a county: one
  // radius of travel is one radian of arc, so the grabbed point tracks the
  // cursor. Dragging right brings lower longitudes to the middle, and
  // dragging down brings higher latitudes, which is why the two signs differ.
  if (spinFrom) {
    // The release happened outside the window, so no pointerup came: settle
    // here instead, or the map would sit in its preview — no county lines, no
    // labels — until the next press.
    if (!(ev.buttons & 1)) {
      settleSpin();
      // No click follows a release the window never saw, so the guard that
      // swallows the click at the end of a spin is cleared here instead.
      spinMoved = false;
      return;
    }
    const [x, y] = pointerWorld(ev);
    const dx = x - spinFrom.x;
    const dy = y - spinFrom.y;
    // Until the press has travelled, it is still a plain click on whatever is
    // under it — so the preview never flashes up for one.
    if (!spinMoved && Math.hypot(dx, dy) > 0.5) beginSpin();
    if (spinMoved) {
      spinTo([
        spinFrom.rot[0] + dx * DEG_PER_UNIT,
        spinFrom.rot[1] - dy * DEG_PER_UNIT,
      ]);
    }
    return;
  }
  lastPointerEvent = ev;
  scheduleHover();
});
svg.on("pointerleave", () => {
  // Clear the stored event so a later doRefresh — triggered by something
  // else entirely — can't re-pick a stale position and reopen the tooltip
  // for a pointer that's already gone.
  lastPointerEvent = null;
  hideTooltip();
  if (hoverFips) {
    hoverFips = null;
    scheduleHover();
  }
});

// ---------------------------------------------------------------- sidebar

const el = (id) => document.getElementById(id);
const rankStatSel = el("rank-stat");

function ranksFor(stats, isForeign = (sid) => stateInfo.get(sid)?.foreign) {
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

function renderElections(tally) {
  const rows = [["pres", tally.ev]];
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

// The breakdown draws as a waffle: 100 dots, one per person in a hundred,
// filled group by group in reading order. Largest-remainder rounding turns
// the percentages into whole people that always sum to exactly 100, and the
// legend quotes those same people counts, so the two never disagree by a dot.
function renderRaceWaffle(s) {
  const wrap = el("race-wrap");
  if (!s.rT) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  const named = RACE_GROUPS.map((rg) => ({ ...rg, pct: (100 * s[rg.key]) / s.rT }));
  const other = Math.max(0, 100 - named.reduce((sum, rg) => sum + rg.pct, 0));
  const segs = [...named, { label: "Other", color: "#a9a9a9", pct: other }];
  for (const g of segs) g.people = Math.floor(g.pct);
  let left = 100 - segs.reduce((sum, g) => sum + g.people, 0);
  for (const g of [...segs].sort((a, b) => (b.pct % 1) - (a.pct % 1))) {
    if (left <= 0) break;
    g.people += 1;
    left -= 1;
  }
  el("race-grid").innerHTML = segs
    .filter((g) => g.people > 0)
    .map((g) =>
      `<i title="${g.label} — ${g.people} of 100 people (${g.pct.toFixed(1)}%)" style="background:${g.color}"></i>`.repeat(
        g.people
      )
    )
    .join("");
  el("race-legend").innerHTML = segs
    .filter((g) => g.people > 0)
    .map((g) => `<span><i style="background:${g.color}"></i>${g.label} ${g.people}%</span>`)
    .join("");
}

// One dot per unit — House seat or electoral vote. The grid fits itself to
// the panel's 104x28 visual band: the largest dot pitch that still fits,
// growing sideways before shrinking the dots — so a handful of votes gets
// big, bold dots while California's 54 still fit.
function renderStatDots(id, n) {
  const box = el(id);
  const count = n > 0 ? n : 0;
  let pitch = 3.5;
  for (let p = 11; p >= 4; p -= 0.5) {
    if (Math.ceil(count / Math.floor(28 / p)) * p <= 104) {
      pitch = p;
      break;
    }
  }
  const rows = Math.floor(28 / pitch);
  const cols = Math.max(1, Math.ceil(count / rows));
  box.style.gridTemplateColumns = `repeat(${cols}, ${0.75 * pitch}px)`;
  box.style.gap = `${0.25 * pitch}px`;
  box.replaceChildren(...Array.from({ length: count }, () => document.createElement("i")));
}

function renderSidebar() {
  const stats = getStats();
  const ranks = ranksFor(stats);

  renderElections(computeElections(stats));

  // selected-state card
  el("empty-card").hidden = !!selected;
  el("state-card").hidden = !selected;
  if (selected) {
    const info = stateInfo.get(selected);
    const s = stats.get(selected) ?? {
      pop: 0, gdp: 0, gdppc: 0, bach: 0, mhi: 0, incPop: 0, life: 0, lifePop: 0, tot: 0,
      rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0, n: 0,
    };
    const dot = el("state-dot");
    dot.style.background = info.color;
    // Foreign units share the atlas tan by design, so theirs stays fixed.
    dot.disabled = !!info.foreign;
    dot.title = info.foreign ? "" : "Change color";
    if (document.activeElement !== el("state-name")) el("state-name").value = info.name;
    // A unit outside the union offers admission as its headline action.
    el("add-state").hidden = !info.foreign;
    el("v-pop").textContent = fmtPop(s.pop);
    el("v-gdp").textContent = fmtBigMoney(s.gdp);
    el("v-gdppc").textContent = fmtMoneyK(s.gdppc);
    el("v-mhi").textContent = s.incPop ? fmtMoney(s.mhi) : "—";
    el("v-bach").textContent = fmtPct(s.bach);
    el("v-life").textContent = s.lifePop ? fmtYears(s.life) : "—";
    el("v-margin").textContent = s.tot ? fmtMargin(s.margin) : "—";
    el("v-seats").textContent = s.seats || "—";
    el("v-ev").textContent = s.ev || "—";
    el("v-n").textContent = s.n;
    for (const key of ["pop", "gdp", "gdppc", "mhi", "bach", "life", "margin", "ev"]) {
      const i = ranks[key].indexOf(selected);
      el("r-" + key).textContent = i === -1 ? "—" : `#${i + 1} of ${ranks[key].length}`;
    }
    // Bars are scaled against the current leader, like the rankings list;
    // a state missing a stat's inputs shows an empty track.
    for (const key of ["pop", "gdp", "gdppc", "mhi", "bach", "life"]) {
      const def = STAT_DEFS[key];
      const top = ranks[key][0];
      const ok = top && s.n > 0 && (!def.has || def.has(s));
      el("b-" + key).style.width = ok
        ? (100 * def.get(s)) / Math.max(1e-9, def.get(stats.get(top))) + "%"
        : "0%";
    }
    // The lean dial pegs at D+30 / R+30; without vote data it hides rather
    // than pointing, misleadingly, at even.
    const hasMargin = s.n > 0 && s.tot > 0;
    el("dial-margin").style.visibility = hasMargin ? "" : "hidden";
    const lean = Math.max(-30, Math.min(30, s.margin || 0));
    el("dial-needle").setAttribute("transform", `rotate(${(-lean * 90) / 30} 26 27)`);
    renderStatDots("d-seats", s.seats);
    renderStatDots("d-ev", s.ev);
    renderRaceWaffle(s);
  }

  // rankings list with mini bars scaled to the leader
  const key = rankStatSel.value;
  const def = STAT_DEFS[key];
  const sids = ranks[key];
  const modified = modifiedStates();
  const origSids = getOrigRanks()[key];
  const maxAbs = Math.max(1e-9, ...sids.map((sid) => Math.abs(def.get(stats.get(sid)))));
  el("rank-list").innerHTML = sids
    .map((sid, i) => {
      const info = stateInfo.get(sid);
      const v = def.get(stats.get(sid));
      const bar =
        def.bar === "diverge"
          ? `<span class="bar diverge"><i class="${v >= 0 ? "bd" : "br"}" style="width:${(50 * Math.abs(v)) / maxAbs}%"></i></span>`
          : `<span class="bar"><i style="width:${(100 * v) / maxAbs}%"></i></span>`;
      // The delta compares this stat's current rank against the same
      // state's rank on the original, unedited map — so a state with no
      // rank there (a custom state, or a unit just admitted) gets the
      // "new" badge instead of an up/down delta.
      let chg = "";
      if (modified.has(sid)) {
        const origIdx = origSids.indexOf(sid);
        if (origIdx === -1) {
          chg = `<span class="chg new" title="Not part of the original map's rankings">★</span>`;
        } else {
          const delta = origIdx - i;
          chg =
            delta > 0
              ? `<span class="chg up" title="Up ${delta} from #${origIdx + 1} on the original map">▲${delta}</span>`
              : delta < 0
                ? `<span class="chg down" title="Down ${-delta} from #${origIdx + 1} on the original map">▼${-delta}</span>`
                : `<span class="chg same" title="Unchanged from #${origIdx + 1} on the original map">–</span>`;
        }
      }
      return `<li data-sid="${sid}" class="${sid === selected ? "sel" : ""}${modified.has(sid) ? " changed" : ""}">
        <span class="pos">${i + 1}</span>
        <span class="chg-wrap">${chg}</span>
        <span class="dot" style="background:${info.color}"></span>
        <span class="nm">${info.name}</span>
        ${bar}
        <span class="val">${def.fmt(v)}</span>
      </li>`;
    })
    .join("");

  updateTrayPeek();
}

// -------------------------------------------------------------------- tray

// On the phone layout the state panel and the sidebar live in a bottom sheet
// (#tray) that peeks above the bottom edge. The peek shows the grab handle
// plus a cut-off sliver of the sheet's own content — the hint that there is
// more to pull up. While the sheet is down, a tap anywhere on it opens it and
// a drag anywhere on it moves it; once open, only the handle drags or closes
// it, because fingers inside the sheet scroll the content. A moved drag snaps
// open or closed on release, and the peek label names the selected state so a
// tap on the map shows something even while the sheet is down. On desktop the
// sheet dissolves into the main grid (display: contents), so the handlers
// here bail behind the same 800px cutoff the stylesheet uses.
const tray = el("tray");
const trayHandle = el("tray-handle");
const trayContent = el("tray-content");
const trayPeekLabel = el("tray-peek");
let trayOpen = false;
let trayDrag = null; // { y0, top0, moved } while a handle drag is live
let trayDragged = false; // swallows the click that follows a moved drag

function setTrayOpen(on) {
  trayOpen = on;
  tray.classList.toggle("open", on);
  trayHandle.setAttribute("aria-expanded", String(on));
  // The closed sheet peeks the top of its content; forget any scroll so that
  // is what actually shows.
  if (!on) trayContent.scrollTop = 0;
}

function updateTrayPeek() {
  const info = selected && stateInfo.get(selected);
  if (!info) {
    trayPeekLabel.textContent = "State details & rankings";
    return;
  }
  const s = getStats().get(selected);
  trayPeekLabel.textContent =
    s && s.n > 0 ? `${info.name} · ${fmtPop(s.pop)} people` : info.name;
}

// How much of the sheet stays visible when closed — the stylesheet owns the
// number, so read it back rather than let the two drift apart.
function trayPeekHeight() {
  const peek = parseFloat(getComputedStyle(tray).getPropertyValue("--tray-peek"));
  return peek || trayHandle.offsetHeight;
}

tray.addEventListener("click", (ev) => {
  if (trayDragged) {
    trayDragged = false;
    return;
  }
  if (!narrowScreen.matches) return;
  // Closed: any tap on the visible peek opens the sheet — pointer capture
  // (below) retargets the click to the sheet itself, so nothing under the
  // finger fires instead. Open: only the handle closes; other clicks belong
  // to the content.
  if (!trayOpen || ev.target === tray || ev.target.closest("#tray-handle")) {
    setTrayOpen(!trayOpen);
  }
});
tray.addEventListener("pointerdown", (ev) => {
  if (!narrowScreen.matches) return;
  const onHandle = Boolean(ev.target.closest("#tray-handle"));
  // The open sheet drags only by its handle — fingers inside it scroll the
  // content. The closed sheet drags from anywhere on the peek.
  if (trayOpen && !onHandle) return;
  // A press on the closed content sliver must not act on what lies under the
  // finger (focus the name input, press a button) — it only steers the sheet.
  if (!onHandle) ev.preventDefault();
  trayDrag = { y0: ev.clientY, top0: tray.getBoundingClientRect().top, moved: false };
  tray.setPointerCapture(ev.pointerId);
  tray.classList.add("dragging");
});
tray.addEventListener("pointermove", (ev) => {
  if (!trayDrag) return;
  const dy = ev.clientY - trayDrag.y0;
  if (Math.abs(dy) > 4) trayDrag.moved = true;
  if (!trayDrag.moved) return;
  // The sheet rides translateY between fully open (0) and peek-only.
  const openTop = window.innerHeight - tray.offsetHeight;
  const closed = tray.offsetHeight - trayPeekHeight();
  const ty = Math.max(0, Math.min(closed, trayDrag.top0 + dy - openTop));
  tray.style.transform = `translateY(${ty}px)`;
});
function settleTrayDrag() {
  if (!trayDrag) return;
  const moved = trayDrag.moved;
  trayDrag = null;
  // Transition back on before the snap, so the sheet glides to its resting
  // place; the inline transform comes off last so the glide starts from
  // where the finger left it.
  tray.classList.remove("dragging");
  if (moved) {
    trayDragged = true;
    const shown = window.innerHeight - tray.getBoundingClientRect().top;
    setTrayOpen(shown > tray.offsetHeight / 2);
  }
  tray.style.transform = "";
}
tray.addEventListener("pointerup", settleTrayDrag);
tray.addEventListener("pointercancel", settleTrayDrag);

el("rank-list").addEventListener("click", (ev) => {
  const li = ev.target.closest("li[data-sid]");
  if (li) select(li.dataset.sid);
});
// The selected stat drives the rankings, the data view, the election card's
// visibility and the sources line, so a change refreshes all of them.
rankStatSel.addEventListener("change", () => {
  syncStatViews();
  scheduleRefresh();
});

// A rename lands in the model and the paint banner immediately, but the
// refresh it owes — refitting the map label (labels.js's text stage; the
// raster/hull geometry stays cached) and rebuilding the deck layers and the
// sidebar — settles once, shortly after typing pauses, instead of running on
// every keystroke.
let renameTimer = 0;
el("state-name").addEventListener("input", (ev) => {
  if (!selected) return;
  stateInfo.get(selected).name = ev.target.value || "Unnamed";
  el("paint-name").textContent = stateInfo.get(selected).name;
  clearTimeout(renameTimer);
  renameTimer = setTimeout(() => {
    labelsVersion++;
    scheduleRefresh();
  }, 300);
});

// Color picker: the swatch by the name opens the full palette, base colors
// on the top row and backups below.
const colorMenu = el("color-menu");

function renderColorMenu() {
  const info = stateInfo.get(selected);
  colorMenu.replaceChildren(
    ...[...BASE_COLORS, ...BACKUP_COLORS].map((c) => {
      const b = document.createElement("button");
      b.className = "swatch";
      b.style.background = c;
      if (c === info.color) b.classList.add("current");
      b.addEventListener("click", () => {
        info.color = c;
        colorMenu.hidden = true;
        scheduleRefresh();
      });
      return b;
    })
  );
}

el("state-dot").addEventListener("click", () => {
  if (!selected) return;
  if (colorMenu.hidden) renderColorMenu();
  colorMenu.hidden = !colorMenu.hidden;
});

document.addEventListener("pointerdown", (ev) => {
  if (!colorMenu.hidden && !ev.target.closest(".dot-wrap")) colorMenu.hidden = true;
});

// The selected state as JSON on the clipboard: the state's name (plus its
// FIPS, unless it's a custom state) and every county it holds, by name and
// FIPS, in FIPS order.
el("copy-json").addEventListener("click", async () => {
  if (!selected) return;
  const info = stateInfo.get(selected);
  // A carved piece has no FIPS of its own — its session-local id means
  // nothing elsewhere — so it exports its parent county's code plus what
  // reconstructs it: the tract GEOIDs alone when the piece follows tract
  // lines (the shape presets read), or C6's cut records when it follows a
  // drawn line, since a split tract can't be written down as a tract list.
  const pieceEntry = globeMap
    ? (id) => globeMap.carve.pieceById(id) && globeMap.carve.serialize(id)
    : (() => {
        const pieceInfo = new Map();
        for (const [pid, s] of splits)
          for (const p of s.pieces) pieceInfo.set(p.id, { fips: pid, tracts: [...p.tracts].sort() });
        return (id) => pieceInfo.get(id);
      })();
  const payload = {
    state: { name: info.name, ...(info.custom ? {} : { fips: selected }) },
    counties: [...assign]
      .filter(([, sid]) => sid === selected)
      .map(([id]) => {
        const entry = pieceEntry(id);
        return entry
          ? { name: data.counties[id].name, ...entry }
          : { name: data.counties[id].name, fips: id };
      })
      .sort((a, b) => a.fips.localeCompare(b.fips) || a.name.localeCompare(b.name)),
  };
  const btn = el("copy-json");
  try {
    await navigator.clipboard.writeText(JSON.stringify(payload, null, 2));
    btn.textContent = "Copied!";
  } catch {
    btn.textContent = "Copy failed";
  }
  setTimeout(() => (btn.textContent = "Copy JSON"), 1200);
});

// "Add as US state": admit the selected foreign unit into the union. It
// keeps its id, name and territory; dropping the foreign flag is what pulls
// it into rankings, apportionment and the election replay (where its
// electoral votes sit in the no-data middle — it cast no 2024 vote), and a
// real state color replaces the shared tan.
el("add-state").addEventListener("click", () => {
  const info = selected && stateInfo.get(selected);
  if (!info?.foreign) return;
  info.foreign = false;
  const fipsList = [...assign].filter(([, sid]) => sid === selected).map(([f]) => f);
  info.color = pickStateColor(borderingStates(fipsList).filter((n) => n !== selected));
  // Dropping the foreign flag puts the unit's name on the map.
  labelsVersion++;
  scheduleRefresh();
});

window.__select = (sid) => select(sid);
window.__setPaintModeHook = (on) => setPaintMode(on);
window.__applyPreset = (id) => applyPreset(PRESETS.find((p) => p.id === id));

function select(sid) {
  if (sid === selected) return;
  if (paintMode) setPaintMode(false);
  colorMenu.hidden = true;
  selected = sid;
  scheduleRefresh();
}

// -------------------------------------------------------------- paint mode

function setPaintMode(on) {
  if (on) setCarveMode(false); // the knife and the brush never overlap
  const wasPainting = paintMode;
  paintMode = on && !!selected;
  brush = 0;
  // Leaving paint mode: settle the state's color against its final borders.
  if (wasPainting && !paintMode && selected) recolorState(selected);
  el("paint-banner").hidden = !paintMode;
  // Painting always shows the atlas, so the view toggle steps aside until done.
  el("view-toggle").hidden = paintMode;
  if (paintMode) el("paint-name").textContent = stateInfo.get(selected).name;
  el("edit-borders").textContent = paintMode ? "Done painting" : "Edit borders";
  el("from-geojson").hidden = !paintMode; // the import paints into the state being edited
  svg.classed("painting", paintMode || carveMode);
  scheduleRefresh(); // apply or clear the dim on every county
}

el("edit-borders").addEventListener("click", () => setPaintMode(!paintMode));
el("paint-done").addEventListener("click", () => setPaintMode(false));

// "Discard" bails out of a paint job: every county the state has claimed goes
// back to its original owner. A custom state — which has no ground of its own
// — is deleted outright and the selection cleared; an original state keeps
// its own territory and stays selected.
el("paint-discard").addEventListener("click", () => {
  if (!selected) return;
  const sid = selected;
  for (const [fips, cur] of assign) {
    if (cur === sid && origAssign.get(fips) !== sid) assign.set(fips, origAssign.get(fips));
  }
  touchTerritory();
  recountStates();
  setPaintMode(false);
  if (stateInfo.get(sid).custom) {
    stateInfo.delete(sid);
    selected = null;
    colorMenu.hidden = true;
  }
  scheduleRefresh();
});
// Enter finishes a click-to-draw knife cut (like double-click). Escape backs
// out one level at a time: name editing, then an unfinished knife line, then
// whichever mode is live (painting and carving never overlap), then the
// selection itself.
window.addEventListener("keydown", (ev) => {
  const typing = /^(INPUT|TEXTAREA)$/.test(document.activeElement?.tagName ?? "");
  if (ev.key === "Enter") {
    if (carveMode && carvePending.length >= 2 && !typing) finishCarve(carvePending);
    return;
  }
  if (ev.key !== "Escape") return;
  if (typing) document.activeElement.blur();
  else if (carveMode) {
    if (carvePending.length || knifeDrag) clearKnife();
    else setCarveMode(false);
  } else if (paintMode) setPaintMode(false);
  else if (selected) select(null);
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
  setCarveMode(false);
  // Reset means the as-loaded map, so carved counties become whole again —
  // which also restores origAssign to its parent-keyed original.
  if (globeMap) {
    if (globeCarveMeta.size) {
      globeMap.carve.reset();
      syncGlobeCarves();
    }
  } else {
    for (const pid of [...splits.keys()]) unsplitCounty(pid);
  }
  assign = new Map(origAssign);
  for (const [sid, info] of stateInfo) if (info.custom) stateInfo.delete(sid);
  // Admitted units step back out of the union, and every color — including
  // hand-picked ones — returns to the original map's.
  for (const id of FOREIGN) stateInfo.get(id).foreign = true;
  for (const [sid, info] of stateInfo) info.color = origColors.get(sid);
  customCount = 0;
  selected = null;
  touchTerritory();
  recountStates();
  setPaintMode(false);
  scheduleRefresh();
  // "Reset states" also returns to the actual home view — a turned globe
  // shouldn't survive a reset any more than hand-picked colors do.
  if (viewRotation[0] !== HOME_ROTATION[0] || viewRotation[1] !== HOME_ROTATION[1]) {
    setRotation(HOME_ROTATION);
  }
  svg.call(zoom.transform, HOME_TRANSFORM);
});

el("reset-view").addEventListener("click", () => {
  // A turned globe is part of the view, so resetting the view faces it home
  // again as well as undoing the pan and zoom.
  if (viewRotation[0] !== HOME_ROTATION[0] || viewRotation[1] !== HOME_ROTATION[1]) {
    setRotation(HOME_ROTATION);
  }
  svg.call(zoom.transform, HOME_TRANSFORM);
});

// ----------------------------------------------------------------- presets

const searchInput = el("preset-search");
const presetMenu = el("preset-menu");

function renderPresetMenu(query) {
  const q = query.trim().toLowerCase();
  const hits = PRESETS.filter(
    (p) =>
      !q ||
      (p.label ?? p.name).toLowerCase().includes(q) ||
      p.name.toLowerCase().includes(q) ||
      p.desc.toLowerCase().includes(q)
  );
  presetMenu.innerHTML = hits.length
    ? hits
        .map(
          (p) => `<div class="preset-item" data-id="${p.id}">
            <b>${p.label ?? p.name}</b><small>${p.desc}</small>
          </div>`
        )
        .join("")
    : `<div class="preset-none">No matching presets</div>`;
  presetMenu.hidden = false;
}

// A preset whose sole target `states` entry still carries that exact name
// merges straight into that existing state (e.g. DC back into Maryland)
// instead of spinning up a same-named duplicate and orphaning the original.
function mergeTarget(preset) {
  if (preset.states?.length !== 1) return null;
  const sid = preset.states[0];
  return stateInfo.get(sid)?.name === preset.name ? sid : null;
}

// Presets speak in county FIPS; a carved county answers to its pieces.
// (resolvePreset also returns the pieces themselves for whole-state presets —
// they live in data.counties — and they pass through unchanged.)
const liveUnitIds = (fips) => {
  if (globeMap) {
    const pieces = globeMap.carve.piecesOf(fips);
    return pieces.length ? pieces.map((p) => p.id) : [fips];
  }
  const s = splits.get(fips);
  return s ? s.pieces.map((p) => p.id) : [fips];
};

// A preset's partial counties (see presets.js) are claimed by carving them
// along the given tract GEOIDs — the same engine the freehand knife drives,
// just told directly which tracts fall inside instead of deriving that from
// a stroke. Reapplying a preset that already carved a county this way is a
// no-op there: carveCounty finds nothing left to divide.
async function applyPreset(preset) {
  if (preset.parts) {
    const sids = preset.parts.map((part) => {
      const sid = createState(part.name);
      for (const fips of part.counties) for (const id of liveUnitIds(fips)) assign.set(id, sid);
      return sid;
    });
    touchTerritory();
    recountStates();
    for (const sid of sids) recolorState(sid);
    selected = sids[sids.length - 1];
    setPaintMode(false);
    scheduleRefresh();
    return;
  }

  const partials = partialCounties(preset);
  if (partials.length && carving) {
    mapNote("Still carving — try again in a moment.");
    return;
  }

  const fipsList = resolvePreset(preset, data.counties);
  const sid = mergeTarget(preset) ?? createState(preset.name);
  for (const fips of fipsList) for (const id of liveUnitIds(fips)) assign.set(id, sid);

  // A preset's partial counties are carved along the tract ids it names — the
  // same engine the knife drives, told directly which tracts fall inside. On
  // the globe that is C6's own file format: each entry replays as a cut along
  // tract lines, and reapplying a preset that already carved a county walks
  // into the standing cut instead of making it again.
  if (partials.length && globeMap) {
    carving = true;
    try {
      const missing = [];
      let carvedAny = false;
      for (const { fips, tracts } of partials) {
        if (!(await tractFile(fips))) {
          missing.push(data.counties[fips]?.name ?? fips);
          continue;
        }
        if ((await globeMap.carve.applyEntry({ fips, tracts })).length) carvedAny = true;
      }
      if (carvedAny) syncGlobeCarves();
      // A second pass claims: every cut now stands, so applyEntry just walks
      // the tree and returns the pieces on each entry's side — including any
      // this preset made on an earlier run.
      for (const { fips, tracts } of partials) await claimEntryPieces({ fips, tracts }, sid);
      if (missing.length) mapNote(`No tract data for ${listNames(missing)}.`);
    } finally {
      carving = false;
    }
  } else if (partials.length) {
    carving = true;
    try {
      const missing = [];
      let carvedAny = false;
      for (const { fips, tracts } of partials) {
        const payload = await tractFile(fips);
        if (!payload) {
          missing.push(data.counties[fips]?.name ?? fips);
          continue;
        }
        const centroids = tractCentroids(fips, payload);
        const inside = new Set(tracts);
        if (carveCounty(fips, payload, centroids, inside)) carvedAny = true;
        const pieces = splits.get(fips)?.pieces ?? [{ id: fips, tracts: new Set(centroids.keys()) }];
        for (const piece of pieces) {
          if ([...piece.tracts].every((t) => inside.has(t))) assign.set(piece.id, sid);
        }
      }
      if (carvedAny) rebuildWorld();
      if (missing.length) mapNote(`No tract data for ${listNames(missing)}.`);
    } finally {
      carving = false;
    }
  }

  touchTerritory();
  recountStates();
  recolorState(sid);
  selected = sid;
  setPaintMode(false);
  scheduleRefresh();
}

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

// ---------------------------------------------------------- county carving

// The Carve button arms a knife that works directly on the map — no drill-in
// view, no per-county mode. Drag a freehand line, or click it corner by
// corner and finish with a double-click or Enter, and the stroke applies to
// every county it fully slices: each one is cut along its census tracts into
// pieces that paint, border, and rank like any other unit. "Fully slices"
// means the stroke passes through the county and both starts and ends
// outside it — a county the line merely grazes, or terminates inside, stays
// whole. A cut through an already-carved county refines its partition, so
// pieces carve again; every piece keeps the state of whatever it was cut
// from, so carving just creates seams to paint across. Double-clicking a
// piece rejoins its whole county. The heavy lifting — turning the line into
// tracts (tractsAcrossCut), reconciling tract detail with the drawn county
// outline, and dividing the county's published row so no state total ever
// moves — lives in split.js.
//
// Tract data ships per county (public/data/tracts, npm run data:tracts) and
// loads lazily, only for counties actually carved.

const carveBtn = el("carve");

// Small transient notice over the map, for outcomes that have no other UI.
let mapNoteTimer = 0;
function mapNote(text) {
  const note = el("map-note");
  note.textContent = text;
  note.hidden = false;
  clearTimeout(mapNoteTimer);
  mapNoteTimer = setTimeout(() => (note.hidden = true), 5000);
}

function setCarveMode(on) {
  if (carveMode === !!on) return;
  carveMode = !!on;
  if (carveMode && paintMode) setPaintMode(false);
  clearKnife();
  carveBtn.classList.toggle("active", carveMode);
  carveBtn.setAttribute("aria-pressed", String(carveMode));
  el("carve-banner").hidden = !carveMode;
  svg.classed("painting", carveMode || paintMode); // the knife crosshair
  knifeGroup.attr("transform", transform);
}
carveBtn.addEventListener("click", () => setCarveMode(!carveMode));
// Done finishes a pending click-drawn cut before leaving the mode — on touch
// it is the only way to finish one besides a double-tap, and with a mouse it
// beats discarding a cut the user just drew. finishCarve slices the points
// and clears the knife itself, so setCarveMode's own clearKnife is a no-op.
el("carve-done").addEventListener("click", () => {
  if (carvePending.length >= 2 && !carving) finishCarve(carvePending);
  setCarveMode(false);
});
// The button form of the right-press that removes the last placed vertex —
// touch has no right button.
el("carve-undo").addEventListener("click", () => {
  if (carving || !carvePending.length) return;
  carvePending.pop();
  renderKnife(null);
});
// The globe's knife cuts along the drawn line itself, and the checkbox asks
// for the old whole-tract assignment instead. The deck fallback only ever does
// whole tracts, so on it the checkbox would be a lie and stays hidden.
if (globeMap) el("carve-intact-wrap").hidden = false;

// The knife line rides the overlay SVG (in map coordinates, under the zoom
// transform like the labels), so redrawing it per pointer move is a cheap
// attribute write instead of a deck layer rebuild. While a freehand stroke
// is live it draws the stroke; otherwise it draws the placed vertices plus a
// rubber-band segment to the cursor.
function renderKnife(cursor) {
  const pts = knifeDrag?.moved
    ? knifeDrag.points
    : cursor && carvePending.length
      ? [...carvePending, cursor]
      : carvePending;
  const path = pts.length >= 2 ? "M" + pts.map(([x, y]) => `${x},${y}`).join("L") : "";
  knifeGroup.select(".knife-casing").attr("d", path);
  knifeGroup.select(".knife-line").attr("d", path);
  knifeGroup
    .selectAll("circle")
    .data(knifeDrag?.moved ? [] : carvePending)
    .join("circle")
    .attr("r", 3 / transform.k)
    .attr("cx", (p) => p[0])
    .attr("cy", (p) => p[1]);
}

function clearKnife() {
  carvePending.length = 0;
  knifeDrag = null;
  renderKnife(null);
}

function finishCarve(points) {
  const pts = points.slice();
  clearKnife();
  applyCarve(pts); // async (tract fetches); the knife stays armed after
}

// Which base county holds a point, via a bbox-then-exact index over the
// as-loaded county shapes (globe copies). Base shapes, not live ones: a cut
// over a carved county's territory finds the retired parent, whose tract
// partition is what a further cut refines.
let carveIndex = null;
function buildCarveIndex() {
  carveIndex = new Map();
  for (const p of BASE_COUNTY_PARTS) {
    if (p.region !== "main" || isForeignUnit(p.fips)) continue;
    let e = carveIndex.get(p.fips);
    if (!e)
      carveIndex.set(p.fips, (e = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, parts: [] }));
    e.parts.push(p);
    for (const [x, y] of p.rings[0]) {
      if (x < e.x0) e.x0 = x;
      if (x > e.x1) e.x1 = x;
      if (y < e.y0) e.y0 = y;
      if (y > e.y1) e.y1 = y;
    }
  }
  for (const e of carveIndex.values()) e.contains = partsContain(e.parts);
}

function countyAt(pt) {
  for (const [fips, e] of carveIndex) {
    if (pt[0] < e.x0 || pt[0] > e.x1 || pt[1] < e.y0 || pt[1] > e.y1) continue;
    if (e.contains(pt)) return fips;
  }
  return null;
}

// The counties a stroke fully slices: sample the line finely enough that no
// county can slip between two samples, take every county the samples land
// in, and drop the counties holding the stroke's endpoints — a cut that
// ends inside a county hasn't sliced it.
function carveCandidates(pts) {
  if (!carveIndex) buildCarveIndex();
  const SAMPLE = 0.5; // design units, ~2.3 km of ground — finer than any county
  const touched = new Set();
  const visit = (pt) => {
    const fips = countyAt(pt);
    if (fips) touched.add(fips);
    return fips;
  };
  for (let i = 0; i < pts.length - 1; i++) {
    const [x1, y1] = pts[i];
    const [x2, y2] = pts[i + 1];
    const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / SAMPLE));
    for (let j = 0; j < n; j++) visit([x1 + ((x2 - x1) * j) / n, y1 + ((y2 - y1) * j) / n]);
  }
  touched.delete(visit(pts[0]));
  touched.delete(visit(pts[pts.length - 1]));
  return touched;
}

// One tract-file fetch per county, remembered — the "no data here" answer
// included.
const tractFiles = new Map();
async function tractFile(fips) {
  if (tractFiles.has(fips)) return tractFiles.get(fips);
  let payload = null;
  try {
    const res = await fetch(`/data/tracts/${fips}.json`);
    if (res.ok) payload = await res.json();
  } catch {
    // unreachable or malformed — remembered as no data
  }
  tractFiles.set(fips, payload);
  return payload;
}

// Area-weighted projected centroid per tract (globe copies): the points the
// knife assigns to one side or the other. Cached per county — the
// projection never changes, and a county carved twice shouldn't re-project
// its thousands of tracts.
const tractCentroidCache = new Map();
function tractCentroids(fips, payload) {
  let centroids = tractCentroidCache.get(fips);
  if (centroids) return centroids;
  centroids = new Map();
  for (const f of feature(payload.topo, payload.topo.objects.tracts).features) {
    let area = 0;
    let x = 0;
    let y = 0;
    for (const p of projectParts(f.geometry, {})) {
      const a = Math.abs(d3.polygonArea(p.rings[0]));
      if (!a) continue;
      const [cx, cy] = d3.polygonCentroid(p.rings[0]);
      area += a;
      x += cx * a;
      y += cy * a;
    }
    if (area) centroids.set(f.id, [x / area, y / area]);
  }
  tractCentroidCache.set(fips, centroids);
  return centroids;
}

const listNames = (names) =>
  names.length <= 2
    ? names.join(" and ")
    : `${names.slice(0, -1).join(", ")}, and ${names[names.length - 1]}`;

// ----------------------------------------------- carving, on the globe path
//
// C6's carver (src/globe/carve.js) owns the cuts, the pieces and their
// allocated rows; the bridge in src/globe/map.js keeps the renderer agreeing
// with it. What is left for here is the APP model, and syncGlobeCarves is the
// one place it is reconciled: piece rows into data.counties, assignments and
// their originals, the inset table, the adjacency the state coloring reads.
// Everything below it — the knife, a preset's partial counties, the GeoJSON
// import, rejoin, reset — changes the carver first and then calls it.

// A recut's new leaves extend the divided leaf's id by one i/o letter
// (carve.js, relabel), so stripping letters walks back to whatever piece this
// one was cut from — which is whose state it inherits, the same "carving just
// creates seams to paint across" rule the deck path has.
function inheritPieceState(id, meta) {
  let probe = id;
  while (probe.length > 1) {
    if (assign.has(probe)) return assign.get(probe);
    const last = probe[probe.length - 1];
    if ((last === "i" || last === "o") && !probe.endsWith(":")) probe = probe.slice(0, -1);
    else break;
  }
  return meta.parentState;
}

// Adjacency for the state coloring. Exact piece-to-piece pairs come from the
// dividers; a piece's OUTER neighbours are over-approximated as all of its
// county's, which can only ever make the coloring stricter — the exact answer
// would mean re-deriving which stretch of the county line each piece owns,
// for a constraint that is advisory to begin with.
function rebuildGlobeAdjacency(pieces, dividers) {
  const parents = new Set(globeCarveMeta.keys());
  const expand = (n) => (parents.has(n) ? globeMap.carve.piecesOf(n).map((p) => p.id) : [n]);
  countyAdj.clear();
  for (const [k, v] of BASE_ADJ) {
    if (parents.has(k)) continue;
    countyAdj.set(k, v.flatMap(expand));
  }
  for (const p of pieces) countyAdj.set(p.id, (BASE_ADJ.get(p.fips) ?? []).flatMap(expand));
  for (const d of dividers) {
    for (const [x, y] of [
      [d.a, d.b],
      [d.b, d.a],
    ]) {
      const list = countyAdj.get(x) ?? [];
      if (!list.includes(y)) list.push(y);
      countyAdj.set(x, list);
    }
  }
}

// The globe labeler reads whole units; a carved parent is handed to the state
// of its largest piece (see makeMainLabeler for why coarse is right here).
function globeLabelAssign(base) {
  if (!globeCarveMeta.size) return base;
  const merged = new Map(base);
  for (const [fips, meta] of globeCarveMeta) {
    const sid = assign.get(meta.largestPiece);
    if (sid !== undefined) merged.set(fips, sid);
  }
  return merged;
}

// Reconcile the app model with the carver, wholesale — the same
// derive-not-patch rule the carver itself follows, so no sequence of carves,
// recuts and rejoins can leave the two disagreeing.
function syncGlobeCarves() {
  const { pieces, dividers } = globeMap.carve.sync();
  const next = new Map(pieces.map((p) => [p.id, p]));
  const parents = new Set(pieces.map((p) => p.fips));

  // What the county's states were, captured before the parent is retired.
  for (const fips of parents) {
    if (!globeCarveMeta.has(fips))
      globeCarveMeta.set(fips, { origState: origAssign.get(fips), parentState: assign.get(fips) });
  }

  // New pieces inherit their state while the pieces they were cut from are
  // still in the assignment.
  const inherited = new Map();
  for (const p of pieces) {
    if (!assign.has(p.id)) inherited.set(p.id, inheritPieceState(p.id, globeCarveMeta.get(p.fips)));
  }

  // Retired pieces leave the model.
  for (const [id] of globePieceIndex) {
    if (next.has(id)) continue;
    assign.delete(id);
    origAssign.delete(id);
    INSET_OF.delete(id);
    delete data.counties[id];
  }

  // Rows land fresh on every sync — a recut re-allocates every piece of its
  // county — and each piece is original territory of the parent's original
  // state, so right-click give-back and Discard return it there.
  for (const p of pieces) {
    data.counties[p.id] = p.row;
    if (!inherited.has(p.id)) continue;
    assign.set(p.id, inherited.get(p.id));
    origAssign.set(p.id, globeCarveMeta.get(p.fips).origState);
    INSET_OF.set(p.id, insetOf(p.fips));
  }

  // The first carve retires the parent; a county whose last cut is undone
  // comes back in one piece.
  for (const fips of parents) {
    assign.delete(fips);
    origAssign.delete(fips);
  }
  for (const [fips, meta] of [...globeCarveMeta]) {
    if (parents.has(fips)) {
      meta.largestPiece = pieces
        .filter((p) => p.fips === fips)
        .reduce((a, b) => (b.km2 > a.km2 ? b : a)).id;
    } else {
      assign.set(fips, meta.parentState);
      origAssign.set(fips, meta.origState);
      globeCarveMeta.delete(fips);
    }
  }

  rebuildGlobeAdjacency(pieces, dividers);
  globePieceIndex = next;
  // The data view places its symbols and value labels from these; on the globe
  // only a rotation recomputes them otherwise.
  computeCountyGeo();
}

// Claim for a state the pieces an exported `{ fips, tracts }` entry names:
// replay it (a cut already standing is walked into, not made again) and take
// the pieces on its inside. A piece that mostly lies OUTSIDE the named tracts
// is skipped — a boundary that only grazes a county collapses to the whole of
// it (carve.js's graze floor), and "that side of the cut" then covers ground
// the entry never asked for.
async function claimEntryPieces(entry, sid) {
  const ids = await globeMap.carve.applyEntry(entry);
  const inside = entry.tracts ? new Set(entry.tracts) : null;
  let claimed = 0;
  for (const id of ids) {
    const piece = globeMap.carve.pieceById(id);
    if (!piece) continue;
    if (inside) {
      let ok = true;
      for (const [t, w] of piece.weights) {
        if (w >= 0.5 && !inside.has(t)) {
          ok = false;
          break;
        }
      }
      if (!ok) continue;
    }
    assign.set(id, sid);
    claimed++;
  }
  return claimed;
}

// The knife's design-space polyline as lon/lat. Long chords are subdivided
// first: a freehand stroke records a point every few pixels, but click-to-draw
// can span the map, and a straight line in the projection is not a straight
// line on the ground.
function designStrokeToLonLat(points) {
  const STEP = 4; // design units, ~19 km
  const out = [];
  for (let i = 0; i < points.length; i++) {
    if (i) {
      const [x1, y1] = points[i - 1];
      const [x2, y2] = points[i];
      const n = Math.ceil(Math.hypot(x2 - x1, y2 - y1) / STEP);
      for (let j = 1; j < n; j++) {
        const p = globeMap.unprojectDesign([x1 + ((x2 - x1) * j) / n, y1 + ((y2 - y1) * j) / n]);
        if (p) out.push(p);
      }
    }
    const p = globeMap.unprojectDesign(points[i]);
    if (p) out.push(p);
  }
  return out;
}

async function applyCarveGlobe(points) {
  carveSkips.clear();
  const res = await globeMap.carve.line(designStrokeToLonLat(points), {
    keepTractsIntact: el("carve-intact").checked,
  });
  if (res.carved.length) {
    syncGlobeCarves();
    recountStates();
    touchTerritory();
    scheduleRefresh();
  }
  // The carver reports counties by name, so the inset refusals — recorded by
  // fips in the tract loader — are matched back through the same unit list
  // the names came from.
  const nameOf = (f) => globeMap.units[globeMap.unitOf.get(f)]?.name ?? f;
  const inset = new Set([...carveSkips].map(nameOf));
  const noData = (res.noData ?? []).filter((n) => !inset.has(n));
  const notes = [];
  if (res.carved.length)
    notes.push(`Carved ${listNames(res.carved)} — when done carving, double-click a piece to rejoin.`);
  if (noData.length) notes.push(`No tract data for ${listNames(noData)}.`);
  if (inset.size)
    notes.push(
      `${listNames([...inset])} ${inset.size === 1 ? "is" : "are"} duplicated in an inset box, which can't show a carve — left whole.`
    );
  if (res.full?.length)
    notes.push(`${listNames(res.full)} ${res.full.length === 1 ? "is" : "are"} carved as fine as it goes.`);
  if (res.rejected) notes.push(`Nothing was cut: ${res.rejected}.`);
  mapNote(notes.length ? notes.join(" ") : "To slice a county, draw the line in one side and out the other.");
}

// A finished stroke, applied: refine the partition of every candidate
// county whose tracts the cut divides. One world rebuild at the end covers
// however many counties the stroke went through.
async function applyCarve(points) {
  if (carving || points.length < 2) return;
  carving = true;
  try {
    if (globeMap) {
      await applyCarveGlobe(points);
      return;
    }
    const carved = [];
    const noData = [];
    for (const fips of carveCandidates(points)) {
      const payload = await tractFile(fips);
      if (!payload) {
        noData.push(data.counties[fips].name);
        continue;
      }
      const centroids = tractCentroids(fips, payload);
      // The far-outside closure the cut is completed with has to clear both
      // the county and the whole stroke.
      const e = carveIndex.get(fips);
      const bounds = { x0: e.x0, y0: e.y0, x1: e.x1, y1: e.y1 };
      for (const [x, y] of points) {
        if (x < bounds.x0) bounds.x0 = x;
        if (x > bounds.x1) bounds.x1 = x;
        if (y < bounds.y0) bounds.y0 = y;
        if (y > bounds.y1) bounds.y1 = y;
      }
      const inside = tractsAcrossCut(points, centroids, bounds);
      if (!inside) continue; // grazed: every tract landed on one side
      if (carveCounty(fips, payload, centroids, inside)) carved.push(data.counties[fips].name);
    }
    if (carved.length) {
      rebuildWorld();
      recountStates();
      touchTerritory();
      scheduleRefresh();
    }
    const notes = [];
    if (carved.length)
      notes.push(`Carved ${listNames(carved)} — when done carving, double-click a piece to rejoin.`);
    if (noData.length) notes.push(`No tract data for ${listNames(noData)}.`);
    mapNote(notes.length ? notes.join(" ") : "To slice a county, draw the line in one side and out the other.");
  } finally {
    carving = false;
  }
}

// Refine one county's partition by a cut: every current piece the cut
// divides splits in two, pieces wholly on one side stay as they are (same
// id, same state, same painting), and an un-carved county starts as the
// single piece of everything. Returns whether anything changed; the caller
// batches the world rebuild.
function carveCounty(fips, payload, centroids, inside) {
  const s = splits.get(fips);
  const oldPieces = s ? s.pieces : [{ id: fips, tracts: new Set(centroids.keys()) }];
  let idSeq = s?.idSeq ?? 0;

  const dividing = oldPieces.filter((piece) => {
    let some = false;
    let all = true;
    for (const t of piece.tracts) inside.has(t) ? (some = true) : (all = false);
    return some && !all;
  });
  if (!dividing.length) return false;
  // Piece ids are the parent id plus a letter; 26 pieces of one county is
  // far past any sane map, so the knife just stops there.
  if (idSeq + 2 * dividing.length > 26) {
    mapNote(`${data.counties[fips].name} is carved as fine as it goes.`);
    return false;
  }

  const pieces = [];
  const stateOf = new Map(); // piece id -> the state it starts in
  for (const piece of oldPieces) {
    if (!dividing.includes(piece)) {
      pieces.push(piece);
      stateOf.set(piece.id, assign.get(piece.id));
      continue;
    }
    const st = assign.get(piece.id);
    for (const keep of [true, false]) {
      const tracts = new Set([...piece.tracts].filter((t) => inside.has(t) === keep));
      const id = fips + String.fromCharCode(97 + idSeq++);
      pieces.push({ id, tracts });
      stateOf.set(id, st);
    }
    // Retire the divided piece — unless it is the un-carved county itself,
    // whose row, original assignment, and inset region applyPartition still
    // reads (the parent's row and region entries live on for exactly that).
    if (piece.id !== fips) {
      assign.delete(piece.id);
      origAssign.delete(piece.id);
      INSET_OF.delete(piece.id);
      delete data.counties[piece.id];
    }
  }
  applyPartition(fips, payload, pieces, stateOf, idSeq);
  return true;
}

// Install a county's new partition: geometry, allocated rows, names, and
// the registry entry the world rebuild reads.
function applyPartition(fips, payload, pieces, stateOf, idSeq) {
  const s = splits.get(fips);
  const parent = data.counties[fips]; // the parent row stays for allocation and naming
  const orig = s?.origState ?? origAssign.get(fips);
  const parentPartsByRegion = s?.parentPartsByRegion ?? d3.group(partsByFips.get(fips), (p) => p.region);

  // The biggest piece wears the parent-shaped backing, so the drawn-versus-
  // true fringe along the county edge misattributes as little as possible.
  const popOf = (tracts) => {
    let total = 0;
    for (const id of tracts) total += payload.rows[id]?.pop || 0;
    return total;
  };
  const backingId = pieces.reduce((best, p) => (popOf(p.tracts) > popOf(best.tracts) ? p : best)).id;

  const geo = splitCountyGeometry({
    tractTopo: payload.topo,
    pieces,
    backingId,
    parentPartsByRegion,
    projectParts,
    projectLines,
  });
  const rows = allocatePieces(parent, payload.rows, pieces, geo.landShares);

  // Name each piece by where it sits among its siblings: eight compass
  // directions around the unweighted mean of the piece centroids (screen y
  // grows southward), "central" for a piece sitting on it, numbers only
  // when two pieces land on the same word.
  const centers = pieces.map((p) => {
    let x = 0;
    let y = 0;
    let n = 0;
    for (const part of geo.hoverParts.get(p.id)) {
      if (part.region !== "main") continue;
      for (const [px, py] of part.rings[0]) (x += px), (y += py), n++;
    }
    return n ? [x / n, y / n] : [0, 0];
  });
  const mean = [
    centers.reduce((t, c) => t + c[0], 0) / centers.length,
    centers.reduce((t, c) => t + c[1], 0) / centers.length,
  ];
  const spread = Math.max(1e-9, ...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1])));
  const COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"];
  const used = new Map();
  pieces.forEach((p, i) => {
    const dx = centers[i][0] - mean[0];
    const dy = centers[i][1] - mean[1];
    let word = "central";
    if (Math.hypot(dx, dy) > 0.2 * spread) {
      const angle = Math.atan2(-dy, dx); // y grows southward; north is up
      word = COMPASS[((Math.round(angle / (Math.PI / 4)) % 8) + 8) % 8];
    }
    const n = (used.get(word) ?? 0) + 1;
    used.set(word, n);
    rows.get(p.id).name = `${parent.name} (${word}${n > 1 ? ` ${n}` : ""})`;
  });

  const region = INSET_OF.get(fips) ?? "main";
  for (const p of pieces) {
    data.counties[p.id] = rows.get(p.id);
    assign.set(p.id, stateOf.get(p.id));
    // Every piece is original territory of the parent's original state, so
    // right-click give-back and Discard return it there — and the original
    // rankings baseline is unmoved, because the piece rows sum to the
    // parent's.
    origAssign.set(p.id, orig);
    INSET_OF.set(p.id, region);
  }
  // the first carve retires the parent itself
  if (assign.has(fips)) {
    assign.delete(fips);
    origAssign.delete(fips);
  }
  // The tract topology is kept, not just its projected output: turning the
  // globe re-projects every carve from it (see rebakeSplits), so a carved
  // county survives a rotation instead of having to be re-cut.
  splits.set(fips, {
    pieces,
    backingId,
    idSeq,
    origState: orig,
    parentPartsByRegion,
    tractTopo: payload.topo,
    ...geo,
  });
}

// Re-project every carve through the current facing. The pieces themselves —
// which tracts belong to which — are a fact about the cut, not the
// projection, so only the geometry is rebuilt; the allocated rows, names and
// ids all stand. The parent's own parts come from the freshly baked
// BASE_COUNTY_PARTS, since the parent was retired from partsByFips by its
// first carve.
function rebakeSplits() {
  if (!splits.size) return;
  const parentParts = new Map();
  for (const p of BASE_COUNTY_PARTS) {
    if (!splits.has(p.fips)) continue;
    const byRegion = parentParts.get(p.fips) ?? new Map();
    const list = byRegion.get(p.region) ?? [];
    list.push(p);
    byRegion.set(p.region, list);
    parentParts.set(p.fips, byRegion);
  }
  for (const [fips, s] of splits) {
    const parentPartsByRegion = parentParts.get(fips) ?? new Map();
    const geo = splitCountyGeometry({
      tractTopo: s.tractTopo,
      pieces: s.pieces,
      backingId: s.backingId,
      parentPartsByRegion,
      projectParts,
      projectLines,
    });
    splits.set(fips, { ...s, parentPartsByRegion, ...geo });
  }
}

// ------------------------------------------------------------ from GeoJSON

// Paint the state being edited from a GeoJSON boundary — for the regions
// that don't follow county lines (the Mississippi Delta, a metro area, a
// watershed). Counties wholly inside the boundary are claimed whole;
// counties the boundary crosses are carved along their census tracts (each
// tract joins by its centroid, exactly like a knife cut) and the inside
// pieces are painted; everything else is untouched. US counties only — the
// boundary math is tract-based, and nothing below the unit exists elsewhere.
async function importGeoJSON(file) {
  if (carving || !paintMode || !selected) return;
  carving = true;
  try {
    let parsed;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      mapNote("That file isn't JSON.");
      return;
    }
    const geoms = [];
    (function collect(g) {
      if (!g) return;
      if (g.type === "FeatureCollection") (g.features ?? []).forEach(collect);
      else if (g.type === "Feature") collect(g.geometry);
      else if (g.type === "GeometryCollection") (g.geometries ?? []).forEach(collect);
      else if (g.type === "Polygon" || g.type === "MultiPolygon") geoms.push(g);
    })(parsed);
    if (!geoms.length) {
      mapNote("No polygons in that GeoJSON.");
      return;
    }
    // Project the boundary into map coordinates once; every containment
    // question below is then planar, in the same space as the county parts
    // and the tract centroids. Ring winding is normalized first — a
    // backwards ring would project as everything-but-the-region and paint
    // the exact inverse of the file.
    const regionParts = geoms.flatMap((g) => projectParts(rewindGeometry(g), {}));
    if (!regionParts.length) {
      mapNote("That boundary projects to nothing on this map.");
      return;
    }
    const inRegion = partsContain(regionParts);
    const rb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
    for (const p of regionParts)
      for (const [x, y] of p.rings[0]) {
        if (x < rb.x0) rb.x0 = x;
        if (x > rb.x1) rb.x1 = x;
        if (y < rb.y0) rb.y0 = y;
        if (y > rb.y1) rb.y1 = y;
      }
    if (!carveIndex) buildCarveIndex();

    const sid = selected;
    let whole = 0;
    let carvedAny = false;
    const carved = [];
    const noData = [];
    // Globe path only: entries to claim once every cut stands, and partially
    // covered counties that live in an inset box, which cannot show a carve.
    const pendingClaims = [];
    const insetPartial = [];
    for (const [fips, e] of carveIndex) {
      if (e.x1 < rb.x0 || e.x0 > rb.x1 || e.y1 < rb.y0 || e.y0 > rb.y1) continue;
      // Classify by the county's own outline vertices: all inside means the
      // whole county is claimed without touching its tracts, none inside
      // means it only matters if the boundary sits wholly within it.
      let inside = 0;
      let total = 0;
      for (const p of e.parts) {
        for (const v of p.rings[0]) {
          total++;
          if (inRegion(v)) inside++;
        }
      }
      if (inside === total) {
        for (const id of liveUnitIds(fips)) assign.set(id, sid);
        whole++;
        continue;
      }
      if (inside === 0 && !regionParts.some((p) => p.rings[0].some((v) => e.contains(v)))) continue;

      const payload = await tractFile(fips);
      if (!payload) {
        noData.push(data.counties[fips].name);
        continue;
      }
      const centroids = tractCentroids(fips, payload);
      const insideTracts = new Set();
      for (const [tid, c] of centroids) if (inRegion(c)) insideTracts.add(tid);
      if (!insideTracts.size) continue;
      // The globe carves through C6: the tract set becomes an exported-format
      // entry, replayed as a cut along tract lines. Claims wait for the second
      // pass below, once the model has been synced.
      if (globeMap) {
        if (insideTracts.size === centroids.size) {
          // every tract centroid inside even though the outline strays out:
          // the whole county belongs to the region
          for (const id of liveUnitIds(fips)) assign.set(id, sid);
          whole++;
        } else if (insetOf(fips) !== "main") {
          insetPartial.push(data.counties[fips].name);
        } else {
          const entry = { fips, tracts: [...insideTracts].sort() };
          if ((await globeMap.carve.applyEntry(entry)).length) {
            carvedAny = true;
            pendingClaims.push(entry);
            carved.push(data.counties[fips].name);
          }
        }
        continue;
      }
      if (insideTracts.size < centroids.size)
        carvedAny = carveCounty(fips, payload, centroids, insideTracts) || carvedAny;
      const s = splits.get(fips);
      if (!s) {
        // every tract centroid inside even though the outline strays out:
        // the whole county belongs to the region
        assign.set(fips, sid);
        whole++;
        continue;
      }
      let claimed = false;
      for (const piece of s.pieces) {
        if ([...piece.tracts].every((t) => insideTracts.has(t))) {
          assign.set(piece.id, sid);
          claimed = true;
        }
      }
      if (claimed) carved.push(data.counties[fips].name);
    }

    if (globeMap && carvedAny) {
      syncGlobeCarves();
      for (const entry of pendingClaims) await claimEntryPieces(entry, sid);
    } else if (carvedAny) rebuildWorld();
    if (whole || carved.length) {
      recountStates();
      touchTerritory();
      recolorState(sid);
      scheduleRefresh();
    }
    const bits = [];
    if (whole) bits.push(`${whole} whole count${whole === 1 ? "y" : "ies"}`);
    if (carved.length) bits.push(`${carved.length} carved along the boundary`);
    const notes = [];
    if (bits.length) notes.push(`Painted ${bits.join(" and ")}.`);
    if (noData.length) notes.push(`No tract data for ${listNames(noData)}.`);
    if (insetPartial.length)
      notes.push(
        `${listNames(insetPartial)} ${insetPartial.length === 1 ? "crosses" : "cross"} the boundary but ` +
          `${insetPartial.length === 1 ? "sits" : "sit"} in an inset box, which can't show a carve — left whole.`
      );
    mapNote(notes.length ? notes.join(" ") : "Nothing on the map falls inside that boundary.");
  } finally {
    carving = false;
  }
}

const geojsonInput = el("geojson-file");
el("from-geojson").addEventListener("click", () => geojsonInput.click());
geojsonInput.addEventListener("change", () => {
  const file = geojsonInput.files?.[0];
  geojsonInput.value = ""; // so the same file can be imported again
  if (file) importGeoJSON(file);
});

// Rejoin a carved county. The whole county lands in the state of the piece
// that was double-clicked (or the backing piece's, from Reset), which is the
// least surprising reading of "make this one whole again".
function unsplitCounty(pid, keepId) {
  const s = splits.get(pid);
  if (!s) return;
  const sid = assign.get(keepId ?? s.backingId);
  for (const piece of s.pieces) {
    assign.delete(piece.id);
    origAssign.delete(piece.id);
    INSET_OF.delete(piece.id);
    delete data.counties[piece.id];
  }
  assign.set(pid, sid);
  origAssign.set(pid, s.origState);
  splits.delete(pid);
  rebuildWorld();
  recountStates();
  touchTerritory();
  scheduleRefresh();
}

// -------------------------------------------------------------- view toggle

function setViewMode(mode) {
  viewMode = mode;
  el("view-atlas").classList.toggle("active", mode === "atlas");
  el("view-data").classList.toggle("active", mode === "data");
  scheduleRefresh();
}
el("view-atlas").addEventListener("click", () => setViewMode("atlas"));
el("view-data").addEventListener("click", () => setViewMode("data"));
window.__setViewMode = (m) => setViewMode(m);

// Legend for the data view: what the marks mean for symbol stats, the color
// ramp with its current ends for choropleths.
function renderLegend() {
  const box = el("map-legend");
  if (!inDataView()) {
    box.hidden = true;
    return;
  }
  const key = rankStatSel.value;
  const def = STAT_DEFS[key];
  const label = rankStatSel.selectedOptions[0].textContent;
  const sym = SYMBOL_STATS[key];
  if (sym) {
    const [fr, fg, fb, fa] = sym.fill;
    const [er, eg, eb] = sym.edge;
    const swatch = `background:rgba(${fr},${fg},${fb},${(fa / 255).toFixed(2)});border-color:rgb(${er},${eg},${eb})`;
    box.innerHTML = `<b>${label}</b><div class="legend-note"><i class="sym ${sym.mark}" style="${swatch}"></i>${
      sym.mark === "dots"
        ? `One dot per ${sym.unit}`
        : `${sym.mark === "circle" ? "Circle" : "Square"} area scales with ${sym.noun}`
    }</div>`;
  } else {
    const vals = statEntries(def).map(([, s]) => def.get(s));
    const trimmed = trimOutliers(vals);
    const diverge = def.bar === "diverge";
    const m = Math.max(1e-9, ...trimmed.map(Math.abs));
    const lo = diverge ? -m : Math.min(...trimmed);
    const hi = diverge ? m : Math.max(...trimmed);
    const ramp = diverge ? divColor : seqColor;
    const stops = d3
      .range(8)
      .map((i) => `rgb(${ramp(i / 7).slice(0, 3).join(",")})`)
      .join(",");
    box.innerHTML = `<b>${label}</b>
      <div class="legend-bar" style="background:linear-gradient(90deg,${stops})"></div>
      <div class="legend-ends"><span>${def.fmt(lo)}</span><span>${def.fmt(hi)}</span></div>`;
  }
  box.hidden = false;
}

// -------------------------------------------------------------------- init

// Only the sources behind what's on screen: the selected stat's own inputs,
// plus the basemap.
function renderSources() {
  const m = data.meta;
  const SOURCES_FOR = {
    pop: [`Population: Census ${m.popYear}`],
    landArea: ["Land area: computed from the map's own unit boundaries"],
    gdp: [`GDP: BEA ${m.gdpYear}`],
    gdppc: [`GDP: BEA ${m.gdpYear}`, `Population: Census ${m.popYear}`],
    mhi: [`Income: SAIPE ${m.incomeYear}`],
    bach: [`Education: ACS ${m.eduWindow} (adults 25+)`],
    life: [
      `Life expectancy: County Health Rankings & Roadmaps (NCHS), ${m.lifeExpWindow}`,
      "Canada: StatCan provincial life tables, Alberta and BC refined to census-division level",
      "Mexico: INEGI state life tables",
      "Rest of Central America/Caribbean: UN World Population Prospects",
    ],
    // The margin view carries the election replay, whose apportionment also
    // leans on population.
    margin: [
      ...(m.electionYear ? [`President: ${m.electionYear} county returns`] : []),
      `Population: Census ${m.popYear}`,
    ],
    // Electoral votes come straight from population via apportionment; the
    // election replay panel shows alongside, so its returns are cited too.
    ev: [
      `Population: Census ${m.popYear}`,
      ...(m.electionYear ? [`President: ${m.electionYear} county returns`] : []),
    ],
  };
  const list = SOURCES_FOR[rankStatSel.value] ?? [
    `Race/ethnicity: Census ${m.raceYear}`,
    "Canada: 2021 Census Profile (visible minority & Indigenous identity, mapped onto the US categories)",
  ];
  list.push("Non-US pop, GDP, education & income: hand-compiled estimates");
  el("sources").textContent = [...list, "Shorelines & lakes: Natural Earth"].join(" · ");
}

// The election replay appears while a stat it explains is on screen: the D–R
// margin it retells, or the electoral votes it tallies.
function syncStatViews() {
  const key = rankStatSel.value;
  el("elections").hidden = key !== "margin" && key !== "ev";
  renderSources();
}

syncStatViews();
scheduleRefresh();
