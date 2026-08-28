// County carving: the pure logic behind cutting counties into paintable
// pieces along census-tract lines. No DOM, no deck.gl — main.js passes its
// projection helpers in, which also lets this module run under Node against
// the real data files.
//
// A carved county is a PARTITION of its tracts into pieces (two after the
// first cut, more after each further cut refines it). Three decisions
// everything here follows from:
//
// 1. The county keeps its drawn shape. Tract outlines (1:500k) disagree with
//    the map's simplified county outline by up to a kilometre or two, and
//    rebuilding the county from tract unions would reopen every problem the
//    US–Canada seam had (two sources, no shared arcs). Instead one piece —
//    the backing — is rendered as the parent's own polygon drawn under
//    everything, the other pieces' tract unions draw over it, and the
//    neighbours' fills (drawn later) clip whatever fringe pokes past the
//    drawn county line. The fills therefore tile exactly, at the cost of a
//    sub-pixel-at-normal-zoom fringe where the two sources disagree.
//
// 2. A carve never moves a state or national total. Tract ACS values are a
//    different vintage than the county row, so they are used only as SHARES
//    to divide the county's published numbers; the piece rows sum back to
//    the county row exactly (the same apportionment idea the build already
//    uses to split provincial GDP across Canada's divisions). GDP and the
//    2024 vote have no tract-level source at all, so they divide by
//    population share and the rows are flagged estimated.
//
// 3. Boundary ownership is derived, not stored. Which piece owns each
//    stretch of a carved county's original border depends on every carve
//    made since — a neighbour may itself be carved later — so the as-loaded
//    boundary records are re-owned from the CURRENT world on every rebuild
//    (reclassifyRecords), instead of being patched per carve and going
//    stale.

import { merge } from "topojson-client";
import * as d3 from "d3";

// Fields the county row carries that tracts also report — each divides by
// its own tract shares — and the county-only fields that divide by
// population share instead.
const TRACT_BACKED = ["pop", "eduT", "eduB", "rT", "rW", "rB", "rN", "rA", "rH"];
const POP_ALLOCATED = ["gdp", "dem", "gop", "tot"];

// Divide the county's published row across the pieces of a partition.
// pieces: [{ id, tracts: Set }]; landShares: Map(id -> spherical-area share)
// from splitCountyGeometry. Returns Map(id -> row). Every piece takes its
// rounded share and the piece with the largest population absorbs the
// rounding residue, so the pieces reproduce the county value to the unit.
export function allocatePieces(county, tractRows, pieces, landShares) {
  const ids = Object.keys(tractRows);
  const sum = (field, tracts) => {
    let t = 0;
    for (const id of ids) if (tracts.has(id)) t += tractRows[id][field] || 0;
    return t;
  };
  const shares = (field, fallback) => {
    const per = pieces.map((p) => sum(field, p.tracts));
    const total = per.reduce((a, b) => a + b, 0);
    return total > 0 ? per.map((v) => v / total) : fallback;
  };
  const areaShares = pieces.map((p) => landShares.get(p.id) ?? 1 / pieces.length);
  const popShares = shares("pop", areaShares);
  const biggest = popShares.indexOf(Math.max(...popShares));

  const rows = new Map(pieces.map((p) => [p.id, { st: county.st, est: true }]));
  const put = (field, shareList, round = true) => {
    const v = county[field];
    if (v == null) return;
    const values = shareList.map((s) => (round ? Math.round(v * s) : v * s));
    values[biggest] += v - values.reduce((a, b) => a + b, 0);
    pieces.forEach((p, i) => (rows.get(p.id)[field] = values[i]));
  };
  for (const f of TRACT_BACKED) put(f, shares(f, popShares));
  for (const f of POP_ALLOCATED) put(f, popShares);
  put("landArea", areaShares, false);

  // Median household income: population-weighted mean of tract medians per
  // piece, scaled so the county-wide mean lands exactly on the county's
  // published median — the state's (weighted-mean) income statistic then
  // doesn't move when a county is carved.
  const weightedMedian = (filter) => {
    let ws = 0;
    let w = 0;
    for (const id of ids) {
      const r = tractRows[id];
      if (filter(id) && r.mhi != null && r.pop > 0) {
        ws += r.mhi * r.pop;
        w += r.pop;
      }
    }
    return w > 0 ? ws / w : null;
  };
  const whole = weightedMedian(() => true);
  const scale = county.mhi && whole ? county.mhi / whole : null;
  for (const p of pieces) {
    const m = weightedMedian((id) => p.tracts.has(id));
    rows.get(p.id).mhi = scale && m != null ? Math.round(m * scale) : county.mhi ?? null;
  }
  return rows;
}

// Translate a knife stroke into tracts. The drawn polyline (projected map
// coordinates, like the tract parts) rarely reaches the county edge, so both
// ends are extended well past everything along their own closing direction,
// and the two far ends are joined by an arc swung far outside the county —
// which turns "one side of an open line" into an ordinary closed polygon
// that point-in-polygon can answer. Each tract joins the side its centroid
// falls on. The arc can run either way around: every point of it is far
// outside the county, so it never decides a tract, only closes the region.
// A stroke drawn as a loop encloses in the obvious way (even-odd), so
// circling an area cuts it out as an enclave.
//
// Returns the Set of tract ids inside the closed region, or null when the
// cut doesn't leave a tract on both sides.
export function tractsAcrossCut(points, centroids, bounds) {
  // Collapse near-duplicate consecutive points (a double-click's second
  // vertex, freehand jitter).
  const pts = [];
  for (const p of points) {
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-3) pts.push(p);
  }
  if (pts.length < 2) return null;

  const size = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, 1);
  const O = [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2];
  const R = 12 * size;

  // The closing direction at each end comes from a short lookback, not the
  // final segment alone — a freehand stroke's last few points wobble.
  const lookback = Math.max(size / 50, 1e-3);
  const endDir = (last) => {
    const end = last ? pts[pts.length - 1] : pts[0];
    let i = last ? pts.length - 2 : 1;
    let ref = pts[i];
    while (last ? i > 0 : i < pts.length - 1) {
      if (Math.hypot(end[0] - ref[0], end[1] - ref[1]) >= lookback) break;
      i += last ? -1 : 1;
      ref = pts[i];
    }
    const d = Math.hypot(end[0] - ref[0], end[1] - ref[1]) || 1;
    return [(end[0] - ref[0]) / d, (end[1] - ref[1]) / d];
  };
  const project = (p, dir) => [p[0] + dir[0] * 2 * R, p[1] + dir[1] * 2 * R];
  const aFar = project(pts[0], endDir(false));
  const bFar = project(pts[pts.length - 1], endDir(true));

  // Arc from bFar around to aFar, radius interpolated between their own so
  // every closure point stays far outside the county.
  const angle = (p) => Math.atan2(p[1] - O[1], p[0] - O[0]);
  const radius = (p) => Math.hypot(p[0] - O[0], p[1] - O[1]);
  let a0 = angle(bFar);
  let a1 = angle(aFar);
  if (a1 <= a0) a1 += 2 * Math.PI;
  const r0 = radius(bFar);
  const r1 = radius(aFar);
  const closure = [];
  const STEPS = 48;
  for (let i = 1; i < STEPS; i++) {
    const t = i / STEPS;
    const a = a0 + (a1 - a0) * t;
    const r = r0 + (r1 - r0) * t;
    closure.push([O[0] + r * Math.cos(a), O[1] + r * Math.sin(a)]);
  }

  const poly = [aFar, ...pts, bFar, ...closure];
  const inside = new Set();
  for (const [tid, c] of centroids) if (d3.polygonContains(poly, c)) inside.add(tid);
  if (!inside.size || inside.size === centroids.size) return null;
  return inside;
}

// Spherical polygon area that tolerates a stray backwards ring: no tract
// union comes near a hemisphere, so any ring measuring bigger than one is
// read as its complement.
function sphericalArea(geometry) {
  const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
  let total = 0;
  for (const rings of polys) {
    const area = d3.geoArea({ type: "Polygon", coordinates: rings });
    total += area > 2 * Math.PI ? 4 * Math.PI - area : area;
  }
  return total;
}

// Point-in-parts test over projected polygon parts (outer ring minus holes).
// Exported for the carve tool, which asks which county each stretch of a
// drawn line passes through.
export const partsContain = (parts) => (pt) => {
  for (const p of parts) {
    if (!d3.polygonContains(p.rings[0], pt)) continue;
    let inHole = false;
    for (let i = 1; i < p.rings.length; i++) {
      if (d3.polygonContains(p.rings[i], pt)) {
        inHole = true;
        break;
      }
    }
    if (!inHole) return true;
  }
  return false;
};

// The whole geometric side of one carved county's current partition:
//   renderParts — what the county fill layers draw in the parent's place:
//     the parent-shaped backing owned by the backing piece first, the other
//     pieces' tract unions over it (the caller puts these ahead of every
//     base county part, so neighbours clip the fringe)
//   hoverParts — every piece's own tract-union parts, keyed by piece id, for
//     the hover tint and the symbol centroids (the backing shape can't
//     serve: it spans the whole county)
//   dividerRecords — the interior piece-piece boundaries, read arc by arc
//     from the tract topology so each record knows the two pieces it
//     separates; they filter, band, and outline like any shared-arc border
//   contains — per region, point-in-polygon closures for the parent shape
//     and each piece's union, which is what reclassifyRecords resolves
//     boundary ownership against on every world rebuild
//   landShares — each piece's share of the partition's spherical area
export function splitCountyGeometry({
  tractTopo,
  pieces,
  backingId,
  parentPartsByRegion,
  projectParts,
  projectLines,
}) {
  const geoms = tractTopo.objects.tracts.geometries;
  const byId = new Map(geoms.map((g) => [g.id, g]));
  const unions = pieces.map((p) =>
    merge(tractTopo, [...p.tracts].map((id) => byId.get(id)).filter(Boolean))
  );

  const areas = unions.map(sphericalArea);
  const areaTotal = areas.reduce((a, b) => a + b, 0) || 1;
  const landShares = new Map(pieces.map((p, i) => [p.id, areas[i] / areaTotal]));

  const renderParts = [];
  const hoverParts = new Map(pieces.map((p) => [p.id, []]));
  const contains = new Map();
  for (const [region, parts] of parentPartsByRegion) {
    renderParts.push(...parts.map((p) => ({ fips: backingId, region, rings: p.rings })));
    const pieceFns = new Map();
    pieces.forEach((piece, i) => {
      const unionParts = projectParts(unions[i], { fips: piece.id, region }, region);
      if (piece.id !== backingId) renderParts.push(...unionParts);
      hoverParts.get(piece.id).push(...unionParts);
      pieceFns.set(piece.id, partsContain(unionParts));
    });
    contains.set(region, { parent: partsContain(parts), pieces: pieceFns });
  }

  // Interior boundaries, arc by arc from the tract topology: an arc used by
  // two tracts of different pieces separates those pieces (the same
  // first-and-last-user pairing the main map's arc walk uses). Arcs are
  // batched per piece pair so projection runs once per pair, not per arc.
  const pieceOf = new Map();
  for (const p of pieces) for (const t of p.tracts) pieceOf.set(t, p.id);
  const sides = [];
  for (const g of geoms) {
    const rings = g.type === "Polygon" ? g.arcs : g.arcs.flat();
    for (const ring of rings) for (const a of ring) (sides[a < 0 ? ~a : a] ??= []).push(g.id);
  }
  const byPair = new Map();
  sides.forEach((s, i) => {
    if (!s) return;
    const pa = pieceOf.get(s[0]);
    const pb = pieceOf.get(s[s.length - 1]);
    if (pa == null || pb == null || pa === pb) return;
    const key = pa < pb ? `${pa}|${pb}` : `${pb}|${pa}`;
    if (!byPair.has(key)) byPair.set(key, { a: pa, b: pb, arcs: [] });
    byPair.get(key).arcs.push(i);
  });
  const dividerRecords = [];
  for (const { a, b, arcs } of byPair.values()) {
    const geometry = { type: "MultiLineString", arcs: arcs.map((i) => [i]) };
    const lines = mergeArcsToLines(tractTopo, geometry);
    for (const region of parentPartsByRegion.keys()) {
      for (const line of lines) {
        for (const path of projectLines({ type: "LineString", coordinates: line }, region)) {
          if (path.length >= 2) dividerRecords.push({ a, b, arc: -2, region, path });
        }
      }
    }
  }

  return { renderParts, hoverParts, dividerRecords, contains, landShares };
}

// Decode a set of topology arcs into coordinate lines. (topojson-client's
// feature() does exactly this for a MultiLineString geometry.)
import { feature as topoFeature } from "topojson-client";
function mergeArcsToLines(topo, geometry) {
  return topoFeature(topo, geometry).geometry.coordinates;
}

// Re-own boundary records against the current set of carves. Every record
// passed in touches at least one carved county; each segment is probed just
// inside the drawn line on both perpendicular sides (growing offsets, since
// a sliver can be thinner than the first step), and the probes answer which
// piece — or which un-carved neighbour — flanks it there. Segments then
// group into maximal runs of one flanking pair, so a border whose far side
// changes piece midway splits exactly where it should. Classifying by what
// is rendered (the piece unions over the backing) keeps the border lines,
// the band, and painting agreeing with the fills to the pixel.
//
// opts.ownerAt(pt, record) — the unit at pt among the record's sides, or
//   null when pt falls outside every carved parent there (both sides carved
//   and the probe missed, or past the map edge).
// opts.defaultsFor(record) — [fallbackA, fallbackB]: each side resolved to
//   its backing piece (or itself), for stretches no probe could classify.
// opts.familyOf(id) — a piece's parent county (or the id itself), so a
//   default can be told apart from a resolved piece of the same county.
const PROBE_STEPS = [0.03, 0.08, 0.2];

export function reclassifyRecords(records, { ownerAt, defaultsFor, familyOf }) {
  const out = [];
  for (const r of records) {
    const path = r.path;
    const self = r.a === r.b;
    const pairs = [];
    for (let i = 0; i < path.length - 1; i++) {
      const [x1, y1] = path[i];
      const [x2, y2] = path[i + 1];
      const len = Math.hypot(x2 - x1, y2 - y1);
      let o0 = null;
      let o1 = null;
      if (len) {
        const nx = -(y2 - y1) / len;
        const ny = (x2 - x1) / len;
        const mx = (x1 + x2) / 2;
        const my = (y1 + y2) / 2;
        for (const eps of PROBE_STEPS) {
          if (o0 == null) o0 = ownerAt([mx + nx * eps, my + ny * eps], r);
          if (o0 != null) break;
        }
        for (const eps of PROBE_STEPS) {
          if (o1 == null) o1 = ownerAt([mx - nx * eps, my - ny * eps], r);
          if (o1 != null) break;
        }
      }
      pairs.push(self ? [o0 ?? o1, o0 ?? o1] : [o0, o1]);
    }
    // A missed probe takes the nearest classified neighbour in its slot;
    // whatever is still open falls to the defaults, keeping the two slots on
    // different counties.
    for (const slot of [0, 1]) {
      let carry = null;
      for (let i = 0; i < pairs.length; i++)
        pairs[i][slot] != null ? (carry = pairs[i][slot]) : (pairs[i][slot] = carry);
      carry = null;
      for (let i = pairs.length - 1; i >= 0; i--)
        pairs[i][slot] != null ? (carry = pairs[i][slot]) : (pairs[i][slot] = carry);
    }
    const [da, db] = defaultsFor(r);
    for (const p of pairs) {
      if (p[0] == null && p[1] == null) {
        p[0] = da;
        p[1] = db;
      } else if (p[0] == null) {
        p[0] = familyOf(p[1]) === familyOf(da) ? db : da;
      } else if (p[1] == null) {
        p[1] = familyOf(p[0]) === familyOf(db) ? da : db;
      }
    }
    // Maximal same-pair runs; adjacent runs share their boundary vertex so
    // the drawn line stays continuous.
    let start = 0;
    for (let i = 1; i <= pairs.length; i++) {
      if (i === pairs.length || pairs[i][0] !== pairs[start][0] || pairs[i][1] !== pairs[start][1]) {
        out.push({ ...r, a: pairs[start][0], b: pairs[start][1], path: path.slice(start, i + 1) });
        start = i;
      }
    }
  }
  return out;
}
