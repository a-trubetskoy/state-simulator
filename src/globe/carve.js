// C6 — carving, on the sphere.
//
// A carved county stops being a unit and its pieces take its place. Three things
// changed from the deck.gl app's version, and the first one is the reason for
// the other two.
//
// 1. A cut is FAITHFUL TO THE DRAWN LINE. The old knife assigned whole tracts to
//    one side or the other by their centroids, so the piece boundary was a
//    ragged tract lattice that could sit a few kilometres off the line the user
//    drew. Here the line itself is the boundary: tracts straddling it are split,
//    and everything a tract reports — population, education, race, and by
//    extension the county-only fields that divide by population — is
//    apportioned by the land area on each side. `keepTractsIntact` asks for the
//    old behaviour, which is still what a hand-authored preset means when it
//    names a list of tract GEOIDs.
//
// 2. A piece is the parent county's OWN POLYGON, cut. Not a union of tract
//    shapes. The tract outlines (1:500k) and the map's simplified county outline
//    disagree by up to a kilometre or two, and the deck.gl app spends a backing
//    shape, a set of fringe ribbons and a five-step probe ladder
//    (reclassifyRecords) reconciling them. Cutting the county's own triangles
//    means the pieces tile the county exactly, by construction, and none of that
//    machinery has an equivalent here. Tract geometry is still read — it is what
//    says how much of a straddling tract lies on each side — but nothing is
//    drawn from it.
//
// 3. Cuts are kept, in lon/lat, and the partition is DERIVED from them. A piece
//    is a leaf of a tree whose branches are cuts, so its identity is the path
//    that reaches it. That is what makes the export honest: a piece cannot be
//    written down as a list of tract ids any more, because a split tract belongs
//    to two pieces, so what is written down is the cuts plus which side of each,
//    and loading replays them. It also means a turn of the globe costs nothing —
//    a cut is a fact about the ground, not about the facing, which is what the
//    projected knife in the deck.gl app never managed.

import { allocatePieces } from "../split.js";
import {
  bboxOf,
  cutTriangles,
  isLoop,
  pointInRing,
  regionSide,
  selfCrossing,
  signedArea,
  strokeToCut,
  triangulatePolygon,
} from "./cut.js";

const RAD = Math.PI / 180;
const EARTH_KM = 6371.0088;

// Guards. Each one exists because a stroke is drawn by hand and can ask for
// something that is not a partition.
const MIN_PIECE_SHARE = 1e-4; //  a "piece" under this much of the county is a graze, not a cut
const TRACT_SNAP = 5e-3; //       a tract sliver under this share rounds to nothing
const MAX_PIECES = 26; //         a county this finely divided stops taking cuts
const EXTEND = 6; //              divider extensions, in county widths

// ------------------------------------------------------------------ measuring

/**
 * Ground area of a lon/lat ring, in steradians, positive counterclockwise.
 *
 * The obvious version — planar area times the cosine of the middle latitude — is
 * a quadrature, and a quadrature of the parts does not sum to the quadrature of
 * the whole. That is fatal here rather than merely untidy, because the one claim
 * everything else rests on is that the pieces TILE the county: if the measure
 * itself does not add up, "the shares sum to one" can only ever be checked to
 * about a part in ten million, and a real gap would hide under that.
 *
 * So it is integrated exactly instead. Green's theorem with L = -sin(lat) turns
 * the double integral of cos(lat) into a walk along the boundary, and each edge
 * contributes -dlon * sin(mid) * sinc(dlat/2) — written that way rather than as
 * a difference of cosines so it stays accurate as dlat goes to zero. A shared
 * edge is traversed once each way, and the two terms cancel to the bit, so
 * cutting a shape and adding the parts back up returns the number it started
 * with.
 */
const sinc = (t) => (t === 0 ? 1 : Math.sin(t) / t);

export function ringArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const x1 = ring[j][0] * RAD;
    const y1 = ring[j][1] * RAD;
    const x2 = ring[i][0] * RAD;
    const y2 = ring[i][1] * RAD;
    s -= (x2 - x1) * Math.sin((y1 + y2) / 2) * sinc((y2 - y1) / 2);
  }
  return s;
}

const triArea = (t) => Math.abs(ringArea(t));
const areaOf = (tris) => tris.reduce((s, t) => s + triArea(t), 0);
const toKm2 = (steradians) => steradians * EARTH_KM * EARTH_KM;

// ------------------------------------------------------------------- the frame
//
// Longitude is continuous inside one county but the numbers are not: the
// Aleutians step from +179 to -179 across half a kilometre of water. Everything
// a carve touches — the parent's triangles, the tracts, the stroke — is shifted
// into one frame anchored on the county, so no code downstream has to know the
// antimeridian exists. Nothing in a county spans 180 degrees, so the shift is
// unambiguous.

const inFrame = (anchor) => (lon) => lon + 360 * Math.round((anchor - lon) / 360);

export const toXyz = ([lon, lat]) => {
  const p = lat * RAD;
  const l = lon * RAD;
  const c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
};

// ------------------------------------------------------------------ the cuts
//
// Two kinds, one interface: `curves` cut geometry, `inside(x, y)` says which
// half of this cut a point is in, and `record()` is what gets written to a file.

/**
 * A cut along a drawn line.
 *
 * The points are quantized to six decimals — eleven centimetres — HERE rather
 * than on the way out to a file, and that is the difference between a piece that
 * reloads as itself and one that reloads as very nearly itself. Rounding at
 * export time moved the line by up to a tenth of a metre, which is nothing to
 * look at and still enough to move a county-sized piece's population by a few
 * people. Quantizing on arrival costs nothing real — the line was drawn with a
 * pointer at 295 m to the pixel at the deepest zoom — and makes what is in
 * memory and what is in the file the same numbers.
 */
function lineCut(rawPoints, bounds) {
  const points = quantize(rawPoints);
  const built = strokeToCut(points, bounds);
  if (!built) return null;
  const side = built.closed ? "in" : regionSide(points, built.region);
  return {
    kind: "line",
    key: `line:${points.map((p) => p.join()).join(";")}`,
    line: points,
    side,
    curves: built.curves,
    region: built.region,
    inside: (x, y) => pointInRing(built.region, x, y),
    record: (taken) => ({ line: points, side: taken ? side : flip(side) }),
  };
}

const flip = (s) => (s === "left" ? "right" : s === "right" ? "left" : s === "in" ? "out" : "in");
export const quantize = (points) =>
  points.map(([x, y]) => [Math.round(x * 1e6) / 1e6, Math.round(y * 1e6) / 1e6]);

/**
 * A cut along tract lines — what `keepTractsIntact` asks for, and what a preset
 * that names tract GEOIDs has always meant.
 *
 * The cutting curve is not the drawn stroke here but the tract boundary between
 * the two groups, read arc by arc out of the tract topology: an arc used by one
 * tract on each side separates them. Its ends are pushed past the county so it
 * behaves like any other knife, which is the whole point — the piece is still
 * the county's own polygon cut by a curve, so it still tiles the county exactly
 * and the fringe between the tract outlines and the drawn county line never
 * arises.
 */
function tractCut(shapes, arcLines, insideIds, bounds) {
  const inSet = new Set(insideIds);
  const size = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, 1e-6);

  const divider = [];
  for (const { line, users } of arcLines) {
    if (users.length < 2) continue;
    if (inSet.has(users[0]) === inSet.has(users[1])) continue;
    divider.push(line);
  }
  const curves = stitch(divider).map((chain) => {
    const closed =
      chain.length > 3 && Math.hypot(chain[0][0] - chain.at(-1)[0], chain[0][1] - chain.at(-1)[1]) < 1e-12;
    if (closed) return { pts: chain.slice(0, -1), closed: true };
    return { pts: extendEnds(chain, size * EXTEND), closed: false };
  });

  // Which side a point is on. A point inside a tract takes that tract's side;
  // the only points that are in no tract at all lie in the sliver between the
  // tract outlines and the county's drawn line, and those take the nearest
  // tract's. Both answers are exact where it matters, because the curves above
  // already put the boundary in the right place — this only labels the halves.
  const inside = (x, y) => {
    for (const s of shapes) {
      if (x < s.bbox.x0 || x > s.bbox.x1 || y < s.bbox.y0 || y > s.bbox.y1) continue;
      // Every polygon, not just the first: a coastal tract can be a mainland
      // shape plus its islands, and testing only the mainland would read the
      // islands as fringe.
      for (const rings of s.polys) if (containsPoint(rings, x, y)) return inSet.has(s.id);
    }
    let best = null;
    let bestD = Infinity;
    for (const s of shapes) {
      const d = (s.centroid[0] - x) ** 2 + (s.centroid[1] - y) ** 2;
      if (d < bestD) {
        bestD = d;
        best = s;
      }
    }
    return best ? inSet.has(best.id) : false;
  };

  const ids = [...inSet].sort();
  return {
    kind: "tracts",
    key: `tracts:${ids.join(",")}`,
    tracts: ids,
    curves,
    inside,
    record: (taken) => ({ tracts: ids, side: taken ? "in" : "out" }),
  };
}

/** Point in a polygon given as `[outer, ...holes]`. */
function containsPoint(rings, x, y) {
  if (!pointInRing(rings[0], x, y)) return false;
  for (let i = 1; i < rings.length; i++) if (pointInRing(rings[i], x, y)) return false;
  return true;
}

// Join lines into maximal chains at shared endpoints. The coordinates come from
// one topology, so the ends of two arcs that meet are the same numbers and an
// exact key is the right key.
function stitch(lines) {
  const key = (p) => `${p[0]},${p[1]}`;
  const ends = new Map();
  lines.forEach((line, i) => {
    for (const p of [line[0], line.at(-1)]) {
      const k = key(p);
      if (!ends.has(k)) ends.set(k, []);
      ends.get(k).push(i);
    }
  });
  const used = new Array(lines.length).fill(false);
  const chains = [];
  for (let i = 0; i < lines.length; i++) {
    if (used[i]) continue;
    used[i] = true;
    let chain = lines[i].slice();
    // Grow at both ends while exactly one unused line continues the chain. A
    // junction where three arcs meet stops the walk, which is right: the two
    // stretches beyond it are separate curves.
    for (const atEnd of [true, false]) {
      for (;;) {
        const tip = atEnd ? chain.at(-1) : chain[0];
        const cand = (ends.get(key(tip)) ?? []).filter((j) => !used[j]);
        if (cand.length !== 1) break;
        const j = cand[0];
        used[j] = true;
        let next = lines[j];
        if (key(next.at(-1)) === key(tip)) next = next.slice().reverse();
        if (key(next[0]) !== key(tip)) break;
        // `next` now runs away from the tip. Appending drops its first point
        // (the shared tip); prepending drops the same point and reverses what is
        // left, so the tip stays where it was and the chain grows past it.
        chain = atEnd ? [...chain, ...next.slice(1)] : [...next.slice(1).reverse(), ...chain];
      }
    }
    if (chain.length >= 2) chains.push(chain);
  }
  return chains;
}

// Push both ends of a chain out along their own direction, far enough that they
// clear the county however concave it is.
function extendEnds(chain, reach) {
  const dir = (from, to) => {
    const d = Math.hypot(to[0] - from[0], to[1] - from[1]) || 1;
    return [(to[0] - from[0]) / d, (to[1] - from[1]) / d];
  };
  const look = Math.min(4, chain.length - 1);
  const d0 = dir(chain[look], chain[0]);
  const d1 = dir(chain.at(-1 - look), chain.at(-1));
  return [
    [chain[0][0] + d0[0] * reach, chain[0][1] + d0[1] * reach],
    ...chain,
    [chain.at(-1)[0] + d1[0] * reach, chain.at(-1)[1] + d1[1] * reach],
  ];
}

// -------------------------------------------------------------- the piece tree
//
// A node is either a leaf — one piece — or a cut with the two halves under it.
// A piece's identity is the path that reaches it, so recutting one piece leaves
// every other piece's id, colour and state exactly where they were, and the path
// is also what an export writes down.

const isLeaf = (n) => !n.cut;

function leafAt(node, x, y) {
  let n = node;
  while (n.cut) n = n.cut.inside(x, y) ? n.in : n.out;
  return n;
}

function leaves(node, out = []) {
  if (isLeaf(node)) out.push(node);
  else {
    leaves(node.in, out);
    leaves(node.out, out);
  }
  return out;
}

function allCuts(node, out = []) {
  if (!isLeaf(node)) {
    out.push(node.cut);
    allCuts(node.in, out);
    allCuts(node.out, out);
  }
  return out;
}

/** The cuts and sides from the root down to a leaf. */
function pathTo(node, leaf, trail = []) {
  if (node === leaf) return trail;
  if (isLeaf(node)) return null;
  return (
    pathTo(node.in, leaf, [...trail, { cut: node.cut, taken: true }]) ??
    pathTo(node.out, leaf, [...trail, { cut: node.cut, taken: false }])
  );
}

// ----------------------------------------------------------------- the carver

/**
 * @param units      the source rings, in manifest order (src/globe/source.js)
 * @param unitIndex  the lon/lat pick index over them (src/globe/pick.js)
 * @param unitTris   (unitIndex) -> the unit's compiled fill triangles, lon/lat
 * @param countyRows the published county rows, keyed by id
 * @param fetchTracts async (fips) -> { topo, rows } or null
 */
export function createCarver({ units, unitIndex, unitTris, countyRows, fetchTracts }) {
  const carves = new Map(); // static unit index -> carve

  // ------------------------------------------------------------ preparation

  // A unit with no tract file of its own — a Canadian division, a Mexican
  // state, a Caribbean country — carves as ONE tract covering the whole of it,
  // asked for by `{ whole: true }` from fetchTracts. The synthetic tract's
  // triangles ARE the unit's compiled triangles, so a piece's weight is its
  // share of the unit's area to the bit, and everything downstream — the
  // apportionment, the export, the reload — runs unchanged on a one-entry
  // weights map. What that means for the numbers is the caller's decision to
  // make: with nothing finer than the unit published, land share is the only
  // split there is. (Medians and life expectancy pass through whole either
  // way, since a median does not divide.)
  async function prepare(unit) {
    if (carves.has(unit)) return carves.get(unit);
    const u = units[unit];
    const payload = await fetchTracts(u.id);
    if (!payload) return null;
    const whole = payload.whole === true;

    const anchor = u.polygons[0][0][0][0];
    const wrap = inFrame(anchor);
    const framed = (ring) => ring.map(([x, y]) => [wrap(x), y]);

    const tris = unitTris(unit).map((t) => t.map(([x, y]) => [wrap(x), y]));
    const outline = u.polygons.flatMap((p) => framed(p[0]));
    const bounds = bboxOf([...outline, ...tris.flat()]);
    const area = areaOf(tris);

    const carve = {
      unit,
      fips: u.id,
      name: u.name,
      anchor,
      wrap,
      tris,
      area,
      bounds,
      whole,
      // The synthetic tract row carries only what a single tract can inform:
      // with one tract, every field's share IS the land share, so population
      // stands in for all of them, and the median is scaled 1:1 through.
      payload: whole
        ? { rows: { [u.id]: { pop: countyRows[u.id]?.pop || 0, mhi: countyRows[u.id]?.mhi ?? null } } }
        : payload,
      shapes: whole ? [wholeShape(u, framed, tris, area, bounds)] : tractShapes(payload, wrap),
      arcLines: whole ? [] : arcUsers(payload.topo, wrap),
      root: null,
      pieces: [],
      dividers: [],
    };
    carves.set(unit, carve);
    return carve;
  }

  // The whole unit as one tract shape, wearing exactly the fields tractShapes
  // gives a real one — except that its triangles are the unit's own compiled
  // fill triangles, so cutting them for weights reproduces the piece partition
  // itself and the shares agree with the drawn pieces exactly.
  function wholeShape(u, framed, tris, area, bounds) {
    let cx = 0;
    let cy = 0;
    let w = 0;
    for (const t of tris) {
      const a = triArea(t);
      cx += ((t[0][0] + t[1][0] + t[2][0]) / 3) * a;
      cy += ((t[0][1] + t[1][1] + t[2][1]) / 3) * a;
      w += a;
    }
    const polys = u.polygons.map((rings) => rings.map(framed));
    return {
      id: u.id,
      rings: polys[0] ?? [],
      polys,
      tris,
      area,
      bbox: bounds,
      centroid: w ? [cx / w, cy / w] : [0, 0],
    };
  }

  // --------------------------------------------------------------- rebuilding

  // Everything derived, from the tree down. Cheap enough (a county is a few
  // hundred triangles) that no carve ever has to patch anything incrementally,
  // which is what keeps the pieces guaranteed consistent with the cuts.
  function rebuild(carve) {
    const curves = allCuts(carve.root).flatMap((c) => c.curves);
    const at = (x, y) => leafAt(carve.root, x, y).id;

    const { byKey, dividers } = cutTriangles(carve.tris, curves, at);
    const list = leaves(carve.root);
    for (const leaf of list) {
      leaf.tris = byKey.get(leaf.id) ?? [];
      leaf.area = areaOf(leaf.tris);
    }

    // How much of each tract each piece holds. A tract is cut by the same curves
    // as the county, so a straddling one lands in two pieces at once and its
    // share of each is the share of its own land that fell there.
    for (const leaf of list) leaf.weights = new Map();
    for (const s of carve.shapes) {
      if (!s.area) continue;
      const parts = cutTriangles(s.tris, curves, at).byKey;
      const raw = new Map();
      for (const [id, tris] of parts) raw.set(id, areaOf(tris) / s.area);
      snapSlivers(raw);
      for (const leaf of list) {
        const w = raw.get(leaf.id);
        if (w > 0) leaf.weights.set(s.id, w);
      }
    }

    carve.dividers = dividers;
    carve.pieces = list;
    allocate(carve);
    nameByCompass(carve);
  }

  // A tract that clips a piece by a hair is noise: the cut ran along its edge,
  // or the two source outlines disagree there. Below half a percent the share
  // rounds to nothing and goes to the piece that holds the rest of the tract,
  // which keeps a piece from inheriting a population of four from a county it
  // barely touches.
  function snapSlivers(raw) {
    let moved = 0;
    let bestId = null;
    let best = -1;
    for (const [id, w] of raw) {
      if (w > best) {
        best = w;
        bestId = id;
      }
    }
    for (const [id, w] of raw) {
      if (id !== bestId && w < TRACT_SNAP) {
        moved += w;
        raw.set(id, 0);
      }
    }
    if (moved && bestId != null) raw.set(bestId, best + moved);
  }

  function allocate(carve) {
    const row = countyRows[carve.fips];
    if (!row) return;
    const total = carve.pieces.reduce((s, p) => s + p.area, 0) || 1;
    const shares = new Map(carve.pieces.map((p) => [p.id, p.area / total]));
    const rows = allocatePieces(row, carve.payload.rows, carve.pieces, shares);
    for (const p of carve.pieces) p.row = rows.get(p.id);
  }

  // Name each piece by where it sits among its siblings: eight compass points
  // around the unweighted mean of the piece centroids, "central" for one sitting
  // on it, numbers only when two land on the same word.
  function nameByCompass(carve) {
    const centers = carve.pieces.map((p) => {
      let x = 0;
      let y = 0;
      let a = 0;
      for (const t of p.tris) {
        const w = triArea(t);
        x += ((t[0][0] + t[1][0] + t[2][0]) / 3) * w;
        y += ((t[0][1] + t[1][1] + t[2][1]) / 3) * w;
        a += w;
      }
      return a ? [x / a, y / a] : [0, 0];
    });
    const mean = [
      centers.reduce((s, c) => s + c[0], 0) / centers.length,
      centers.reduce((s, c) => s + c[1], 0) / centers.length,
    ];
    const spread = Math.max(1e-12, ...centers.map((c) => Math.hypot(c[0] - mean[0], c[1] - mean[1])));
    const COMPASS = ["east", "northeast", "north", "northwest", "west", "southwest", "south", "southeast"];
    const used = new Map();
    carve.pieces.forEach((p, i) => {
      const dx = centers[i][0] - mean[0];
      const dy = centers[i][1] - mean[1];
      let word = "central";
      if (Math.hypot(dx, dy) > 0.2 * spread) {
        word = COMPASS[((Math.round(Math.atan2(dy, dx) / (Math.PI / 4)) % 8) + 8) % 8];
      }
      const n = (used.get(word) ?? 0) + 1;
      used.set(word, n);
      p.center = centers[i];
      p.name = `${carve.name} (${word}${n > 1 ? ` ${n}` : ""})`;
      if (p.row) p.row.name = p.name;
    });
  }

  // ------------------------------------------------------------ applying a cut

  // Which pieces a line cut is allowed to divide. The rule is candidates' own,
  // applied piece by piece: a stroke has to pass fully THROUGH a piece to slice
  // it, so a piece the stroke never enters stays whole even where the cut's
  // extended ends happen to cross it, and a piece holding a stroke endpoint is
  // where the knife stopped, not something it cut. Loops are exempt exactly as
  // they are in candidates. Tract cuts are not gated at all — their record is
  // the tract set alone, so a replay could not rebuild the gate — and neither
  // is the first cut into a whole county, where candidates has already ruled.
  // Null means "divide anything". The gate is derived from the cut's own line,
  // which is also what gets written to a file, so replaying an export passes
  // through this same judgement and reproduces the same pieces.
  function pieceGate(carve, cut) {
    if (!carve.root || cut.kind !== "line" || isLoop(cut.line)) return null;
    const step = 0.01; // the sampling step candidates uses, for the same reason
    const points = cut.line; // already in the county's frame, like the leaves
    const leafOf = ([x, y]) => (unitIndex.at(x, y) === carve.unit ? leafAt(carve.root, x, y) : null);
    const touched = new Set();
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
      for (let j = 0; j < n; j++) {
        const leaf = leafOf([x1 + ((x2 - x1) * j) / n, y1 + ((y2 - y1) * j) / n]);
        if (leaf) touched.add(leaf);
      }
    }
    for (const p of [points[0], points.at(-1)]) touched.delete(leafOf(p));
    return (leaf) => touched.has(leaf);
  }

  // Refine the partition by one cut. Every leaf the cut divides splits in two;
  // leaves wholly on one side, and leaves the gate rules out, keep their id,
  // their colour and their state. A leaf that comes out under the graze
  // threshold was never really divided, so its node collapses back to whichever
  // half survived.
  function applyCut(carve, cut) {
    const before = carve.root;
    const may = pieceGate(carve, cut);
    const grow = (node) =>
      isLeaf(node)
        ? may && !may(node)
          ? node
          : { cut, in: mkLeaf(node.id + "i", node), out: mkLeaf(node.id + "o", node) }
        : { cut: node.cut, in: grow(node.in), out: grow(node.out) };
    const mkLeaf = (id, from) => ({ id, state: from?.state, tris: [], weights: new Map() });

    carve.root = before
      ? grow(before)
      : { cut, in: mkLeaf(`${carve.fips}:i`), out: mkLeaf(`${carve.fips}:o`) };
    rebuild(carve);

    // Collapse the halves the cut did not really produce.
    const floor = MIN_PIECE_SHARE * carve.area;
    const prune = (node) => {
      if (isLeaf(node)) return node;
      const a = prune(node.in);
      const b = prune(node.out);
      const areaUnder = (n) => leaves(n).reduce((s, l) => s + l.area, 0);
      if (areaUnder(a) < floor) return b;
      if (areaUnder(b) < floor) return a;
      return { cut: node.cut, in: a, out: b };
    };
    carve.root = prune(carve.root);
    // A collapsed branch leaves the surviving child wearing a longer id than its
    // depth; re-derive every id from the tree so the path and the id agree, which
    // is what an export relies on.
    relabel(carve);

    const divided = leaves(carve.root).length > (before ? leaves(before).length : 1);
    if (!divided) {
      carve.root = before;
      if (before) rebuild(carve);
      else {
        // Nothing was ever cut here. Leave no half-built partition behind for a
        // caller that keeps the carve around.
        carve.pieces = [];
        carve.dividers = [];
      }
      return false;
    }
    rebuild(carve);
    return true;
  }

  function relabel(carve) {
    const walk = (node, id) => {
      if (isLeaf(node)) {
        node.id = id;
        return;
      }
      walk(node.in, id + "i");
      walk(node.out, id + "o");
    };
    walk(carve.root, `${carve.fips}:`);
  }

  // ------------------------------------------------------------- the interface

  /**
   * Which counties a stroke fully crosses. A cut that ENDS inside one has not
   * sliced it, so the units holding the two endpoints are dropped — unless the
   * stroke is a loop, where both ends sit inside the county on purpose and
   * dropping them would throw away the only county the cut applies to.
   *
   * A county already carved is the other exception, when the caller asks for
   * it: its unit of account is the piece, not the county, so a stroke ending
   * inside it only says the PIECE holding that endpoint was not sliced. The
   * county stays a candidate and pieceGate judges each piece by this same rule.
   */
  function candidates(points, pieceAware = false) {
    // A tenth of a degree is 1.1 km, finer than the smallest unit on the map —
    // Falls Church, Virginia, is about two km across — so nothing can slip
    // between two samples. A fixed step rather than one scaled to the stroke:
    // scaling it made a perfectly horizontal stroke sample fifty thousand times.
    const step = 0.01;
    const touched = new Set();
    const visit = ([x, y]) => {
      const u = unitIndex.at(x, y);
      if (u >= 0) touched.add(u);
      return u;
    };
    for (let i = 0; i < points.length - 1; i++) {
      const [x1, y1] = points[i];
      const [x2, y2] = points[i + 1];
      const n = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / step));
      for (let j = 0; j < n; j++) visit([x1 + ((x2 - x1) * j) / n, y1 + ((y2 - y1) * j) / n]);
    }
    if (!isLoop(points)) {
      for (const p of [points[0], points.at(-1)]) {
        const u = visit(p);
        if (u >= 0 && !(pieceAware && carves.get(u)?.root)) touched.delete(u);
      }
    }
    return [...touched];
  }

  /**
   * Apply a drawn stroke. `points` are lon/lat, as `camera.unproject` returns
   * them. Returns what happened, in words the caller can put on screen.
   */
  async function carve(points, { keepTractsIntact = false } = {}) {
    const raw = points.filter((p) => p && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (raw.length < 2) return { carved: [], noData: [], rejected: "the line has no length" };
    // Made continuous in longitude before anything reads it. `unproject` returns
    // [-180, 180], so a stroke drawn across the Aleutians steps from +179 to
    // -179 — half a kilometre on the ground and 358 degrees in the numbers — and
    // the county sampler below would walk the long way round the world between
    // those two points. Accumulating the short way puts the whole stroke in one
    // frame, which may sit outside [-180, 180]; the pick index already offers a
    // query in all three frames, and each county shifts it into its own.
    const clean = [raw[0]];
    for (let i = 1; i < raw.length; i++) {
      let d = raw[i][0] - raw[i - 1][0];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      clean.push([clean[i - 1][0] + d, raw[i][1]]);
    }
    // A stroke that crosses itself has chords that separate each other's ends
    // around a ring, which is the one assumption the chord walk in cut.js makes.
    // Refusing it is a better answer than a tangled partition. Circling an area
    // to cut it out as an enclave still works — a loop closes at its own start
    // rather than crossing it, provided the end does not run past the beginning.
    if (selfCrossing(clean)) {
      return {
        carved: [],
        noData: [],
        rejected: "the line crosses itself — to cut out an enclave, close the loop without overshooting",
      };
    }

    const carved = [];
    const noData = [];
    const full = [];
    // A tract cut keeps the county-level rule: pieceGate cannot gate it, so
    // letting an ending-inside stroke through would cut what was not drawn.
    for (const unit of candidates(clean, !keepTractsIntact)) {
      const c = await prepare(unit);
      if (!c) {
        noData.push(units[unit].name);
        continue;
      }
      if (c.root && leaves(c.root).length >= MAX_PIECES) {
        full.push(c.name);
        continue;
      }
      const framed = quantize(clean.map(([x, y]) => [c.wrap(x), y]));
      const bounds = bboxOf([
        [c.bounds.x0, c.bounds.y0],
        [c.bounds.x1, c.bounds.y1],
        ...framed,
      ]);
      // "Keep tracts intact" means nothing on a unit whose only tract is
      // itself — there is no tract line to follow but its own boundary — so
      // the drawn line cuts either way.
      const cut =
        keepTractsIntact && !c.whole
          ? tractCut(c.shapes, c.arcLines, tractsInside(c, framed, bounds), bounds)
          : lineCut(framed, bounds);
      if (!cut || !cut.curves.length) continue;
      if (applyCut(c, cut)) carved.push(c.name);
      else if (!c.root) carves.delete(unit);
    }
    return { carved, noData, full };
  }

  // Whole-tract assignment, for `keepTractsIntact`: each tract joins the side its
  // own centroid falls on, which is what the deck.gl knife has always done.
  function tractsInside(carve, points, bounds) {
    const built = strokeToCut(points, bounds);
    if (!built) return [];
    return carve.shapes.filter((s) => pointInRing(built.region, s.centroid[0], s.centroid[1])).map((s) => s.id);
  }

  /** Undo every cut everywhere. */
  function reset() {
    carves.clear();
  }

  /** Undo every cut on the county a piece belongs to. */
  function rejoin(pieceId) {
    for (const [unit, c] of carves) {
      if (c.pieces.some((p) => p.id === pieceId)) {
        carves.delete(unit);
        return c.fips;
      }
    }
    return null;
  }

  /** The piece at a lon/lat, or null when that unit is not carved. */
  function pieceAt(unit, lon, lat) {
    const c = carves.get(unit);
    if (!c || !c.root) return null;
    return leafAt(c.root, c.wrap(lon), lat);
  }

  // ------------------------------------------------------------ the file format
  //
  // A piece is written as the county it came from, the cuts that reach it, and
  // which side of each it is on. The tract list beside them is derived and is
  // there to be read by a person — except in the one case where there are no
  // cuts to write, which is a piece that follows tract lines and nothing else.
  // That case is exactly the `{ fips, tracts }` entry the app has always
  // exported and every hand-written preset uses, so those files keep working
  // and keep meaning what they meant.

  function serialize(pieceId) {
    for (const c of carves.values()) {
      const leaf = c.pieces.find((p) => p.id === pieceId);
      if (!leaf) continue;
      const path = pathTo(c.root, leaf) ?? [];
      const tracts = [...leaf.weights.keys()].sort();
      const cuts = path.map(({ cut, taken }) => cut.record(taken));
      // One tract cut taken whole is the legacy shape, and it says everything
      // this piece is.
      if (cuts.length === 1 && cuts[0].tracts && cuts[0].side === "in") {
        return { fips: c.fips, tracts: cuts[0].tracts };
      }
      return { fips: c.fips, tracts, cuts };
    }
    return null;
  }

  /**
   * Replay one exported entry. Returns the ids of the pieces it names — plural,
   * because another entry may have cut the same county finer since, and "that
   * side of these cuts" then covers more than one piece.
   */
  async function apply(entry) {
    const unit = unitIndex.ids.indexOf(entry.fips);
    if (unit < 0) return [];
    const c = await prepare(unit);
    if (!c) return [];

    const steps = entry.cuts ?? (entry.tracts ? [{ tracts: entry.tracts, side: "in" }] : []);
    const taken = [];
    for (const step of steps) {
      const want = buildCut(c, step);
      if (!want) return [];
      // A cut already standing at this point in the tree is walked into rather
      // than made again, so two entries naming the same county converge on one
      // partition instead of each carving their own.
      if (!standingAt(c, taken, want)) {
        if (!applyCut(c, want)) break;
        if (!standingAt(c, taken, want)) break;
      }
      taken.push(step.side);
    }
    // Whatever the path reaches. Plural, because another entry may have cut this
    // county finer since, and "that side of these cuts" then covers more than one
    // piece — and it stops early when a cut divided nothing, in which case the
    // branch is already what the entry was asking for.
    const node = descend(c.root, taken);
    return node ? leaves(node).map((l) => l.id) : [];
  }

  function buildCut(c, step) {
    if (step.line) {
      const line = quantize(step.line.map(([x, y]) => [c.wrap(x), y]));
      return lineCut(line, bboxOf([[c.bounds.x0, c.bounds.y0], [c.bounds.x1, c.bounds.y1], ...line]));
    }
    if (step.tracts) return tractCut(c.shapes, c.arcLines, step.tracts, c.bounds);
    return null;
  }

  const standingAt = (c, taken, want) => {
    const node = descend(c.root, taken);
    return node != null && !isLeaf(node) && node.cut.key === want.key;
  };

  const sideOf = (node, cut, side) => {
    const wantsIn = cut.kind === "tracts" ? side !== "out" : side === cut.side;
    return wantsIn ? node.in : node.out;
  };

  function descend(root, sides) {
    let node = root;
    for (const s of sides) {
      if (!node || isLeaf(node)) return null;
      node = sideOf(node, node.cut, s);
    }
    return node;
  }

  return {
    carve,
    apply,
    serialize,
    rejoin,
    reset,
    pieceAt,
    carves,
    /** Every piece across every carved county, with its geometry on the sphere. */
    pieces: () =>
      [...carves.values()].flatMap((c) =>
        c.pieces.map((p) => ({
          ...p,
          parent: c.unit,
          fips: c.fips,
          xyz: p.tris.map((t) => t.map(toXyz)),
          km2: toKm2(p.area),
        }))
      ),
    /** The piece-to-piece boundaries, as segments on the sphere. */
    dividers: () =>
      [...carves.values()].flatMap((c) =>
        c.dividers.map((d) => ({ a: d.a, b: d.b, xyz: d.seg.map(toXyz) }))
      ),
  };
}

// ------------------------------------------------------------- tract geometry

// The tract shapes, once per county: rings for containment, triangles for area,
// a centroid for whole-tract assignment.
function tractShapes(payload, wrap) {
  const topo = payload.topo;
  const arcs = decodeArcs(topo, wrap);
  const out = [];
  for (const g of topo.objects.tracts.geometries) {
    const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
    const rings = [];
    for (const poly of polys) for (const ring of poly) rings.push(ringOf(arcs, ring));
    const outers = g.type === "Polygon" ? [g.arcs.map((r) => ringOf(arcs, r))] : g.arcs.map((p) => p.map((r) => ringOf(arcs, r)));
    const tris = outers.flatMap((p) => triangulatePolygon(p));
    const area = areaOf(tris);
    let cx = 0;
    let cy = 0;
    let w = 0;
    for (const t of tris) {
      const a = triArea(t);
      cx += ((t[0][0] + t[1][0] + t[2][0]) / 3) * a;
      cy += ((t[0][1] + t[1][1] + t[2][1]) / 3) * a;
      w += a;
    }
    out.push({
      id: g.id,
      rings: outers[0] ?? rings,
      polys: outers,
      tris,
      area,
      bbox: bboxOf(rings.flat()),
      centroid: w ? [cx / w, cy / w] : [0, 0],
    });
  }
  return out;
}

function decodeArcs(topo, wrap) {
  const t = topo.transform;
  return topo.arcs.map((arc) => {
    if (!t) return arc.map(([x, y]) => [wrap(x), y]);
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [wrap(x * t.scale[0] + t.translate[0]), y * t.scale[1] + t.translate[1]];
    });
  });
}

function ringOf(arcs, indices) {
  const out = [];
  for (const i of indices) {
    const arc = i < 0 ? arcs[~i].slice().reverse() : arcs[i];
    for (let k = out.length ? 1 : 0; k < arc.length; k++) out.push(arc[k]);
  }
  if (out.length > 1 && out[0][0] === out.at(-1)[0] && out[0][1] === out.at(-1)[1]) out.pop();
  return out;
}

// Every arc with the tracts on either side of it — the same first-and-last-user
// pairing the map's own arc walk uses. This is what tells a tract cut where the
// boundary between two groups actually runs.
function arcUsers(topo, wrap) {
  const arcs = decodeArcs(topo, wrap);
  const sides = [];
  for (const g of topo.objects.tracts.geometries) {
    const rings = g.type === "Polygon" ? g.arcs : g.arcs.flat();
    for (const ring of rings) {
      for (const a of ring) {
        const i = a < 0 ? ~a : a;
        (sides[i] ??= []).push(g.id);
      }
    }
  }
  return arcs.map((line, i) => ({
    line,
    users: sides[i] ? [sides[i][0], sides[i].at(-1)] : [],
  }));
}
