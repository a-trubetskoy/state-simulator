// C6 — cutting a polygon with a drawn curve.
//
// One primitive does the whole of carving's geometry: given a SIMPLE ring and a
// set of curves that do not cross each other, split the ring into simple
// sub-rings along those curves. Everything else in C6 is that call plus
// bookkeeping.
//
// Three decisions make it small enough to hand-roll, and they are worth stating
// because a general polygon boolean is the obvious alternative and is an order
// of magnitude more code:
//
//   It cuts TRIANGLES, not counties. The parent's fill triangles already exist,
//   compiled: refined to 120 km so the horizon cut stays sub-pixel, wound
//   correctly, holes already resolved by the triangulation, the antimeridian
//   already unwrapped. Feeding those in means this file never sees a hole and
//   never sees a multipolygon, which is exactly the two cases that make a
//   boolean hard. The 31 units that have holes and the 247 with islands need no
//   special case at all.
//
//   A curve always CROSSES the ring it cuts — it never ends inside one and never
//   sits wholly inside one. Open curves get their ends extended past the county
//   before they arrive here, so both ends are outside every triangle. A closed
//   curve (the user circling an enclave) can sit inside a triangle, and that one
//   case is handled by splitting the triangle first with a straight auxiliary
//   line, which is the same call again. So the invariant holds by construction
//   and the chord walk below never has to reconstruct a hole.
//
//   Crossings are transversal. Coordinates are lon/lat degrees; the county rings
//   are quantized to about 1e-5 and the curve is drawn by hand, so an exact
//   touch is measure-zero rather than merely unlikely. It is still checked for,
//   and the answer is to nudge the curve rather than to write the degenerate
//   case, because a nudged answer is right and a degenerate one is a coin toss.
//
// Everything here is planar in lon/lat. C4 measured what that costs against
// spherical containment — 0.036% of points disputed, every one within 22 m of an
// edge — and this is the same trade at the same scale.

import earcut from "earcut";

const EPS = 1e-12;

const cross = (ox, oy, ax, ay, bx, by) => (ax - ox) * (by - oy) - (ay - oy) * (bx - ox);

/** Signed area of a ring, positive when counterclockwise. */
export function signedArea(ring) {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return s / 2;
}

/** Ray casting, half-open in y so a vertex is counted once. */
export function pointInRing(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0];
    const yi = ring[i][1];
    const xj = ring[j][0];
    const yj = ring[j][1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

export const bboxOf = (pts) => {
  let x0 = Infinity;
  let y0 = Infinity;
  let x1 = -Infinity;
  let y1 = -Infinity;
  for (const [x, y] of pts) {
    if (x < x0) x0 = x;
    if (x > x1) x1 = x;
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  return { x0, y0, x1, y1 };
};

const bboxHit = (a, b, pad = 0) =>
  a.x0 - pad <= b.x1 && b.x0 - pad <= a.x1 && a.y0 - pad <= b.y1 && b.y0 - pad <= a.y1;

// ---------------------------------------------------------------- self-crossing
//
// The chord walk assumes two chords of the same curve never separate each
// other's endpoints around the ring, which is another way of saying the curve
// does not cross itself. A scribble does, so it is rejected at the door with a
// message rather than quietly producing tangled pieces.

/** The first pair of non-adjacent segments of `pts` that cross, or null. */
export function selfCrossing(pts, closed = false) {
  const n = closed ? pts.length : pts.length - 1;
  const seg = (i) => [pts[i], pts[(i + 1) % pts.length]];
  for (let i = 0; i < n; i++) {
    const [a, b] = seg(i);
    for (let j = i + 2; j < n; j++) {
      if (closed && i === 0 && j === n - 1) continue; // the closing joint
      const [c, d] = seg(j);
      const d1 = cross(a[0], a[1], b[0], b[1], c[0], c[1]);
      const d2 = cross(a[0], a[1], b[0], b[1], d[0], d[1]);
      const d3 = cross(c[0], c[1], d[0], d[1], a[0], a[1]);
      const d4 = cross(c[0], c[1], d[0], d[1], b[0], b[1]);
      if (d1 * d2 < 0 && d3 * d4 < 0) return [i, j];
    }
  }
  return null;
}

// ------------------------------------------------------------------- crossings

// Where one curve meets one ring. `t` walks the ring edge, `u` the curve edge,
// both half-open at 1 so a shared vertex is reported once.
function crossings(ring, curve) {
  const pts = curve.pts;
  const n = curve.closed ? pts.length : pts.length - 1;
  const out = [];
  let fragile = false;
  for (let k = 0; k < n; k++) {
    const c = pts[k];
    const d = pts[(k + 1) % pts.length];
    const dx = d[0] - c[0];
    const dy = d[1] - c[1];
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      const a = ring[j];
      const b = ring[i];
      const ax = b[0] - a[0];
      const ay = b[1] - a[1];
      const den = ax * dy - ay * dx;
      if (Math.abs(den) < EPS) continue; // parallel; a true overlap is caught below
      const ox = c[0] - a[0];
      const oy = c[1] - a[1];
      const t = (ox * dy - oy * dx) / den;
      const u = (ox * ay - oy * ax) / den;
      if (t < 0 || t >= 1 || u < 0 || u >= 1) continue;
      // Landing on a vertex is the case the nudge exists for: parity along the
      // curve stops alternating when a crossing is really a touch.
      if (t < 1e-9 || t > 1 - 1e-9 || u < 1e-9 || u > 1 - 1e-9) fragile = true;
      out.push({ edge: j, t, seg: k, u, pt: [c[0] + dx * u, c[1] + dy * u] });
    }
  }
  out.sort((p, q) => p.seg - q.seg || p.u - q.u);
  return { list: out, fragile };
}

// A curve nudged off every vertex it happened to land on. The offset is 1e-9
// degrees — a tenth of a millimetre, four orders below the county data's own
// quantization — so it moves the answer by nothing and moves the arithmetic off
// the tie.
function nudge(curve, round) {
  const d = 1e-9 * (round + 1);
  return {
    ...curve,
    pts: curve.pts.map(([x, y], i) => [x + d * Math.cos(i * 2.399), y + d * Math.sin(i * 2.399)]),
  };
}

// --------------------------------------------------------------------- chords
//
// The crossings along a curve alternate outside, inside, outside... because each
// transversal crossing toggles. So one reliable anchor fixes the parity of the
// whole list, and the spans that lie inside the ring are the chords that cut it.

function chordsOf(ring, curve, all) {
  const pts = curve.pts;
  // A transversal crossing toggles, so the count is even. An odd one means a
  // touch survived the nudge; dropping the last keeps the parity argument sound
  // and costs at most one chord.
  const list = all.length % 2 ? all.slice(0, -1) : all;
  const n = list.length;
  if (n < 2) return [];

  // The stretch of curve between two consecutive crossings, as points.
  const spanPts = (a, b) => {
    const out = [a.pt];
    let k = a.seg;
    // Walk forward along the curve from a's segment to b's, cyclically for a
    // closed curve.
    while (k !== b.seg) {
      k = (k + 1) % pts.length;
      out.push(pts[k]);
    }
    return [...out, b.pt];
  };
  const spans = [];
  for (let i = 0; i < (curve.closed ? n : n - 1); i++) {
    spans.push(spanPts(list[i], list[(i + 1) % n]));
  }

  // The anchor. An open curve starts outside every ring it is handed (its ends
  // are extended past the county), so span 0 is inside. A closed curve has no
  // outside end, so the longest span is measured instead — the longest is the
  // one whose midpoint is furthest from the ambiguity at either end.
  let firstInside = true;
  if (curve.closed) {
    let best = 0;
    let bestLen = -1;
    spans.forEach((s, i) => {
      let len = 0;
      for (let k = 1; k < s.length; k++) len += Math.hypot(s[k][0] - s[k - 1][0], s[k][1] - s[k - 1][1]);
      if (len > bestLen) {
        bestLen = len;
        best = i;
      }
    });
    const s = spans[best];
    const m = s[s.length >> 1];
    firstInside = pointInRing(ring, m[0], m[1]) === (best % 2 === 0);
  }

  const out = [];
  for (let i = 0; i < spans.length; i++) {
    if ((i % 2 === 0) !== firstInside) continue;
    out.push({ a: list[i], b: list[(i + 1) % n], pts: spans[i] });
  }
  return out;
}

// ------------------------------------------------------------- the ring walk

// Split one ring along one curve. Returns the sub-rings, or [ring] when the
// curve misses it.
function cutRingByCurve(ring, curve, depth = 0) {
  const rb = bboxOf(ring);
  if (!bboxHit(rb, bboxOf(curve.pts))) return [ring];

  let c = curve;
  let found = crossings(ring, c);
  for (let round = 0; found.fragile && round < 3; round++) {
    c = nudge(curve, round);
    found = crossings(ring, c);
  }
  const list = found.list;

  if (list.length < 2) {
    // A closed curve wholly inside the ring would cut a hole, and a hole is the
    // one shape the walk below cannot produce. Split the ring with a straight
    // auxiliary line through the curve first — the same call again — and the
    // curve then crosses both halves.
    if (curve.closed && list.length === 0 && depth < 4) {
      const cb = bboxOf(curve.pts);
      const my = (cb.y0 + cb.y1) / 2;
      if (pointInRing(ring, (cb.x0 + cb.x1) / 2, my)) {
        const pad = (rb.x1 - rb.x0 + rb.y1 - rb.y0 + 1) * 4;
        const aux = { pts: [[rb.x0 - pad, my], [rb.x1 + pad, my]], closed: false };
        return cutRingByCurve(ring, aux, 9).flatMap((r) => cutRingByCurve(r, curve, depth + 1));
      }
    }
    return [ring];
  }

  const chords = chordsOf(ring, c, list);
  if (!chords.length) return [ring];

  // Insert every chord endpoint into the ring as a tagged vertex, so a split is
  // a matter of finding two tags and walking between them. Tags survive into the
  // sub-rings, which is what lets the remaining chords find their own half.
  const marks = new Map(); // "edge:t" -> tag id
  const byEdge = new Map();
  for (const ch of chords) {
    for (const end of [ch.a, ch.b]) {
      const key = `${end.edge}:${end.t}`;
      if (!marks.has(key)) {
        marks.set(key, marks.size);
        if (!byEdge.has(end.edge)) byEdge.set(end.edge, []);
        byEdge.get(end.edge).push(end);
      }
      end.tag = marks.get(key);
    }
  }

  let walk = [];
  for (let i = 0; i < ring.length; i++) {
    walk.push({ pt: ring[i], tag: -1 });
    const on = (byEdge.get(i) ?? []).slice().sort((p, q) => p.t - q.t);
    for (const e of on) walk.push({ pt: e.pt, tag: e.tag });
  }

  const pending = chords.map((_, i) => i);
  const out = [];
  const queue = [{ walk, chords: pending }];

  while (queue.length) {
    const job = queue.pop();
    const w = job.walk;
    const at = new Map();
    w.forEach((v, i) => v.tag >= 0 && at.set(v.tag, i));

    // The first chord with both ends on this ring. A chord with one end here and
    // one elsewhere means the curve crossed itself; it is dropped, which leaves
    // the ring uncut rather than tangled.
    let use = -1;
    const keep = [];
    for (const ci of job.chords) {
      const ch = chords[ci];
      const ok = at.has(ch.a.tag) && at.has(ch.b.tag);
      if (ok && use < 0) use = ci;
      else if (ok) keep.push(ci);
    }
    if (use < 0) {
      out.push(w.map((v) => v.pt));
      continue;
    }

    const ch = chords[use];
    const ia = at.get(ch.a.tag);
    const ib = at.get(ch.b.tag);
    const bridge = ch.pts.slice(1, -1); // a's and b's points are already in the walk
    const arc = (from, to) => {
      const seg = [];
      for (let i = from; ; i = (i + 1) % w.length) {
        seg.push(w[i]);
        if (i === to) break;
      }
      return seg;
    };
    // a -> b the long way round the ring, closed by the chord run backwards;
    // and b -> a the other way, closed by the chord forwards.
    const half1 = [...arc(ia, ib), ...bridge.slice().reverse().map((pt) => ({ pt, tag: -1 }))];
    const half2 = [...arc(ib, ia), ...bridge.map((pt) => ({ pt, tag: -1 }))];
    for (const h of [half1, half2]) {
      if (h.length >= 3) queue.push({ walk: h, chords: keep });
    }
  }
  return out;
}

/**
 * Split a simple ring along a set of curves that do not cross one another.
 *
 * `ring` is `[[x, y], ...]`, not closed (no repeated last point), and must have
 * no holes. `curves` are `{ pts, closed }`; open ones must start and end outside
 * the ring. Returns the sub-rings, which tile the input exactly.
 */
export function cutRing(ring, curves) {
  let rings = [ring];
  for (const curve of curves) {
    if (curve.pts.length < 2) continue;
    const next = [];
    for (const r of rings) next.push(...cutRingByCurve(r, curve));
    rings = next;
  }
  return rings;
}

// ------------------------------------------------------------- triangle cutting

/** Earcut a ring, returning flat triangles as `[[x,y],[x,y],[x,y]]`. */
export function triangulate(ring) {
  if (ring.length < 3) return [];
  if (ring.length === 3) return [ring];
  const flat = new Float64Array(ring.length * 2);
  for (let i = 0; i < ring.length; i++) {
    flat[i * 2] = ring[i][0];
    flat[i * 2 + 1] = ring[i][1];
  }
  const idx = earcut(flat);
  const out = [];
  for (let i = 0; i < idx.length; i += 3) {
    out.push([ring[idx[i]], ring[idx[i + 1]], ring[idx[i + 2]]]);
  }
  return out;
}

/**
 * Earcut a polygon given as `[outer, ...holes]`. Only the tract shapes need
 * this — the parent's triangles arrive already triangulated by the C1 compiler.
 */
export function triangulatePolygon(rings) {
  if (!rings.length || rings[0].length < 3) return [];
  const pts = [];
  const holes = [];
  for (const ring of rings) {
    if (pts.length) holes.push(pts.length);
    for (const p of ring) pts.push(p);
  }
  const flat = new Float64Array(pts.length * 2);
  for (let i = 0; i < pts.length; i++) {
    flat[i * 2] = pts[i][0];
    flat[i * 2 + 1] = pts[i][1];
  }
  const idx = earcut(flat, holes);
  const out = [];
  for (let i = 0; i < idx.length; i += 3) out.push([pts[idx[i]], pts[idx[i + 1]], pts[idx[i + 2]]]);
  return out;
}

/**
 * A point guaranteed to be inside a simple ring: the centroid of its largest
 * triangle. A ring's own centroid can fall outside it, and every side test in
 * C6 rides on this being interior.
 */
export function interiorPoint(ring) {
  let best = null;
  let bestArea = -1;
  for (const t of triangulate(ring)) {
    const a = Math.abs(signedArea(t));
    if (a > bestArea) {
      bestArea = a;
      best = t;
    }
  }
  if (!best) return ring.length ? ring[0] : null;
  return [(best[0][0] + best[1][0] + best[2][0]) / 3, (best[0][1] + best[1][1] + best[2][1]) / 3];
}

/**
 * Cut a list of triangles by a set of curves and sort the results into buckets.
 *
 * `sideAt(x, y)` names the bucket a point belongs to — a region test in the
 * default mode, a tract lookup when tracts are kept whole. Triangles the curves
 * miss are classified whole, which is almost all of them.
 *
 * Returns `{ byKey: Map(key -> triangles), dividers: [{ a, b, seg }] }`.
 *
 * The dividers are exact rather than sampled, and they come out of the walk for
 * free. Two sub-rings of the same triangle that share an edge are separated by
 * that edge, and both got it from the same chord — the same two numbers, not two
 * roundings of one number — so an edge seen twice with two different bucket keys
 * IS the boundary between those buckets there. Edges seen once are the parent's
 * own outline, which some other layer already draws. That also settles the case
 * a probe at the middle of a chord would get wrong: where two cuts cross inside
 * one triangle, each stretch of each chord is a separate edge and is labelled on
 * its own.
 */
export function cutTriangles(tris, curves, sideAt) {
  const byKey = new Map();
  const dividers = [];
  const put = (key, tri) => {
    const list = byKey.get(key);
    if (list) list.push(tri);
    else byKey.set(key, [tri]);
  };
  const boxes = curves.map((c) => bboxOf(c.pts));

  for (const tri of tris) {
    const tb = bboxOf(tri);
    const hit = curves.filter((c, i) => bboxHit(tb, boxes[i]));
    if (!hit.length) {
      const p = [(tri[0][0] + tri[1][0] + tri[2][0]) / 3, (tri[0][1] + tri[1][1] + tri[2][1]) / 3];
      put(sideAt(p[0], p[1]), tri);
      continue;
    }
    const edges = new Map();
    for (const ring of cutRing(tri, hit)) {
      if (ring.length < 3) continue;
      const p = interiorPoint(ring);
      if (!p) continue;
      const key = sideAt(p[0], p[1]);
      for (const t of triangulate(ring)) put(key, t);
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const u = ring[j];
        const v = ring[i];
        const uk = `${u[0]},${u[1]}`;
        const vk = `${v[0]},${v[1]}`;
        const k = uk < vk ? `${uk}|${vk}` : `${vk}|${uk}`;
        const seen = edges.get(k);
        if (!seen) edges.set(k, { key, seg: [u, v] });
        else if (seen.key !== key) dividers.push({ a: seen.key, b: key, seg: seen.seg });
      }
    }
  }
  return { byKey, dividers };
}

// ------------------------------------------------------------------- the region
//
// A drawn stroke names a region the same way it does in the deck.gl app: both
// ends run far past everything along their own closing direction, and the two
// far ends are joined by an arc swung well outside, which turns "one side of an
// open line" into an ordinary closed polygon a point test can answer. The arc
// can run either way round — every point of it is far outside the county, so it
// never decides anything, it only closes the region.
//
// Two differences from split.js's version, and they are the whole reason this is
// not that function. The points are lon/lat rather than projected map units, so
// a cut survives a turn of the globe and can be written to a file. And the open
// polyline is kept alongside the closed region, because the region answers "which
// side" while the polyline is what actually cuts the triangles.

const CLOSURE_STEPS = 48;

/**
 * Whether a stroke closes on itself, and so encloses rather than divides.
 *
 * Measured against the stroke's OWN length rather than the county's size: a
 * small circle drawn inside a big county still closes, and a short scratch
 * across a big one still does not.
 */
export function isLoop(points) {
  if (points.length < 4) return false;
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1]);
  }
  const span = Math.hypot(points[0][0] - points.at(-1)[0], points[0][1] - points.at(-1)[1]);
  return span < Math.max(total * 0.08, 1e-7);
}

/**
 * Turn a drawn stroke into a cut.
 *
 * `bounds` is the box the closure must clear — the county's own box grown to
 * include the stroke. Returns `{ curves, region, closed }`, or null when the
 * stroke has nothing in it: `curves` is what cuts, `region` is the closed ring
 * that answers which side a point is on.
 */
export function strokeToCut(points, bounds) {
  const pts = [];
  for (const p of points) {
    if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
    const q = pts[pts.length - 1];
    if (!q || Math.hypot(p[0] - q[0], p[1] - q[1]) > 1e-9) pts.push([p[0], p[1]]);
  }
  if (pts.length < 2) return null;

  const size = Math.max(bounds.x1 - bounds.x0, bounds.y1 - bounds.y0, 1e-6);

  // A stroke whose ends meet is a loop, and a loop encloses in the obvious way.
  if (isLoop(pts)) {
    const ring = pts.slice();
    if (Math.hypot(ring[0][0] - ring[ring.length - 1][0], ring[0][1] - ring[ring.length - 1][1]) < 1e-9) {
      ring.pop();
    }
    if (ring.length < 3) return null;
    return { curves: [{ pts: ring, closed: true }], region: ring, closed: true };
  }

  const O = [(bounds.x0 + bounds.x1) / 2, (bounds.y0 + bounds.y1) / 2];
  const R = 12 * size;

  // The closing direction comes from a short lookback, not the last segment
  // alone — a freehand stroke's final points wobble.
  const lookback = Math.max(size / 50, 1e-9);
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
  const push = (p, dir) => [p[0] + dir[0] * 2 * R, p[1] + dir[1] * 2 * R];
  const aFar = push(pts[0], endDir(false));
  const bFar = push(pts[pts.length - 1], endDir(true));
  const line = [aFar, ...pts, bFar];

  const angle = (p) => Math.atan2(p[1] - O[1], p[0] - O[0]);
  const radius = (p) => Math.hypot(p[0] - O[0], p[1] - O[1]);
  let a0 = angle(bFar);
  const a1raw = angle(aFar);
  const a1 = a1raw <= a0 ? a1raw + 2 * Math.PI : a1raw;
  const r0 = radius(bFar);
  const r1 = radius(aFar);
  const closure = [];
  for (let i = 1; i < CLOSURE_STEPS; i++) {
    const t = i / CLOSURE_STEPS;
    const a = a0 + (a1 - a0) * t;
    const r = r0 + (r1 - r0) * t;
    closure.push([O[0] + r * Math.cos(a), O[1] + r * Math.sin(a)]);
  }

  return { curves: [{ pts: line, closed: false }], region: [...line, ...closure], closed: false };
}

/**
 * Which side of a stroke the region encloses, as a word rather than as a fact
 * about the closure arc: "left" or "right" of the direction the stroke was
 * drawn in. That is what gets written to a file, so it has to mean something
 * without the construction above in front of you.
 */
export function regionSide(points, region) {
  const i = Math.max(0, (points.length >> 1) - 1);
  const a = points[i];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const len = Math.hypot(dx, dy) || 1;
  // Screen y grows downward but lon/lat's does not, so left of the direction of
  // travel is (-dy, dx) rotated the usual way.
  const step = Math.max(len * 1e-3, 1e-9);
  const mx = (a[0] + b[0]) / 2 - (dy / len) * step;
  const my = (a[1] + b[1]) / 2 + (dx / len) * step;
  return pointInRing(region, mx, my) ? "left" : "right";
}
