// C4 — which unit is at a lon/lat.
//
// Two things in main.js answer that question today, in two different ways, and
// this replaces both:
//
//   pickCounty draws the county layer into a picking buffer and reads one pixel
//     back. The readback is a CPU-GPU sync, so picking has to PAUSE during a
//     pan or a wheel gesture (src/main.js, `gesturing`) — a stall injected
//     exactly when frames are most expensive. The hover tint then freezes to
//     its county and catches up when the gesture ends.
//   carveIndex is a bbox-then-exact index over the county shapes, but in
//     PROJECTED coordinates, so every turn of the globe invalidates it along
//     with everything else the bake produces.
//
// On the sphere neither problem exists. camera.unproject() inverts the
// projection in closed form, and the index below is built from the SOURCE
// rings in lon/lat — facts about the data, not about the facing — so it is
// built once and no rotation touches it.
//
// The result is a pick that costs a few microseconds and can run on every
// pointer move, gesture or not.

// Where a ring's longitudes are made continuous. A ring that crosses the
// antimeridian arrives as a jump from +179 to -179, which is a 358-degree step
// in the numbers and a half-degree step on the ground; accumulating the short
// way instead puts the whole ring in one frame, which may sit outside
// [-180, 180]. The Aleutians are the case that matters here. Queries are
// shifted into a polygon's own frame at lookup time.
function unwrapRing(ring) {
  const out = new Float64Array(ring.length * 2);
  let lon = ring[0][0];
  out[0] = lon;
  out[1] = ring[0][1];
  for (let i = 1; i < ring.length; i++) {
    let d = ring[i][0] - ring[i - 1][0];
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    lon += d;
    out[i * 2] = lon;
    out[i * 2 + 1] = ring[i][1];
  }
  return out;
}

// Ray casting over a flat lon,lat array. Same test build-geometry.mjs runs for
// its orientation probes, on the same rings.
function ringContains(flat, x, y) {
  let inside = false;
  const n = flat.length / 2;
  for (let i = 0, j = n - 1; i < n; j = i++) {
    const xi = flat[i * 2];
    const yi = flat[i * 2 + 1];
    const xj = flat[j * 2];
    const yj = flat[j * 2 + 1];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

// One degree of latitude is 111 km, so a half-degree cell is roughly 55 km
// across — a few counties in the dense east, and small enough that a big
// foreign unit's bbox does not carpet the continent. Finer than this costs
// more in cells than it saves in candidates.
const CELL_DEG = 0.5;

/**
 * A lon/lat index over the map's units.
 *
 * `units` is `[{ id, polygons }]` in the manifest's own order, since that order
 * IS the unit id every vertex and every palette texel carries. Each polygon is
 * `[outerRing, ...holes]` of `[lon, lat]` pairs.
 *
 * Overlap resolves the way the map draws: the compiler puts the foreign units
 * first "so the Census county shapes paint over any overlap along the seam", so
 * where two units both claim a point the LATER one wins, exactly as it would on
 * screen.
 */
export function createUnitIndex(units, { cellDeg = CELL_DEG } = {}) {
  const cols = Math.round(360 / cellDeg);
  const rows = Math.round(180 / cellDeg);

  // Flattened polygons, one entry per record, in unit order.
  const rings = []; //  Float64Array[][] — outer first, then holes
  const unitOf = []; // Int32Array-worth of unit indices
  const lon0 = [];
  const lon1 = [];
  const lat0 = [];
  const lat1 = [];

  units.forEach((unit, u) => {
    for (const poly of unit.polygons) {
      const flat = poly.map(unwrapRing).filter((r) => r.length >= 6);
      if (!flat.length) continue;
      const outer = flat[0];
      let x0 = Infinity;
      let x1 = -Infinity;
      let y0 = Infinity;
      let y1 = -Infinity;
      for (let i = 0; i < outer.length; i += 2) {
        if (outer[i] < x0) x0 = outer[i];
        if (outer[i] > x1) x1 = outer[i];
        if (outer[i + 1] < y0) y0 = outer[i + 1];
        if (outer[i + 1] > y1) y1 = outer[i + 1];
      }
      rings.push(flat);
      unitOf.push(u);
      lon0.push(x0);
      lon1.push(x1);
      lat0.push(y0);
      lat1.push(y1);
    }
  });

  // The grid, CSR-style: a count pass, a prefix sum, then a fill pass, so the
  // whole thing lands in two typed arrays instead of 260k Array objects.
  const cellOf = (lon, lat) => {
    let c = Math.floor(lon / cellDeg) % cols;
    if (c < 0) c += cols;
    const r = Math.max(0, Math.min(rows - 1, Math.floor((lat + 90) / cellDeg)));
    return r * cols + c;
  };

  const starts = new Int32Array(cols * rows + 1);
  const spanOf = (p) => {
    const c0 = Math.floor(lon0[p] / cellDeg);
    const c1 = Math.floor(lon1[p] / cellDeg);
    const r0 = Math.max(0, Math.floor((lat0[p] + 90) / cellDeg));
    const r1 = Math.min(rows - 1, Math.floor((lat1[p] + 90) / cellDeg));
    // A polygon wider than the world would wrap onto itself; nothing here is,
    // and clamping keeps the fill pass finite if that ever changes.
    return { c0, c1: Math.min(c1, c0 + cols - 1), r0, r1 };
  };

  for (let p = 0; p < rings.length; p++) {
    const { c0, c1, r0, r1 } = spanOf(p);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let cc = c % cols;
        if (cc < 0) cc += cols;
        starts[r * cols + cc + 1]++;
      }
    }
  }
  for (let i = 0; i < starts.length - 1; i++) starts[i + 1] += starts[i];

  const items = new Int32Array(starts[starts.length - 1]);
  const cursor = starts.slice(0, -1);
  for (let p = 0; p < rings.length; p++) {
    const { c0, c1, r0, r1 } = spanOf(p);
    for (let r = r0; r <= r1; r++) {
      for (let c = c0; c <= c1; c++) {
        let cc = c % cols;
        if (cc < 0) cc += cols;
        items[cursor[r * cols + cc]++] = p;
      }
    }
  }

  // A polygon lives in whatever longitude frame its own ring unwrapped into, so
  // a query near the antimeridian has to be offered in all three frames before
  // it can be called a miss.
  function polygonContains(p, lon, lat) {
    if (lat < lat0[p] || lat > lat1[p]) return false;
    let x = lon;
    if (x < lon0[p] || x > lon1[p]) {
      x = lon + 360;
      if (x < lon0[p] || x > lon1[p]) {
        x = lon - 360;
        if (x < lon0[p] || x > lon1[p]) return false;
      }
    }
    const flat = rings[p];
    if (!ringContains(flat[0], x, lat)) return false;
    for (let h = 1; h < flat.length; h++) if (ringContains(flat[h], x, lat)) return false;
    return true;
  }

  /** The unit index at a lon/lat, or -1. Painter's order breaks ties. */
  function at(lon, lat) {
    const cell = cellOf(lon, lat);
    let best = -1;
    for (let i = starts[cell]; i < starts[cell + 1]; i++) {
      const p = items[i];
      if (unitOf[p] <= best) continue; // a later unit already won this point
      if (polygonContains(p, lon, lat)) best = unitOf[p];
    }
    return best;
  }

  return {
    at,
    /** The unit id at a lon/lat, or null — what pickCounty returns today. */
    idAt: (lon, lat) => {
      const u = at(lon, lat);
      return u < 0 ? null : units[u].id;
    },
    ids: units.map((u) => u.id),
    stats: {
      units: units.length,
      polygons: rings.length,
      cells: cols * rows,
      entries: items.length,
    },
  };
}
