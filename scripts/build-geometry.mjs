// C1 of the globe rewrite: the geometry compiler.
//
//   node scripts/build-geometry.mjs        (npm run data:geometry)
//
// Reads the four shipped JSON files and writes one binary blob plus a small
// JSON manifest. Everything comes out as positions on the UNIT SPHERE, so the
// renderer uploads it once and a turn of the globe is a mat3 uniform rather
// than a CPU re-projection of every coordinate (see globe-rewrite-plan.txt).
//
// Nothing here decides what the map shows. The layer list, the palette and the
// draw order stay in the renderer; this script only supplies the vertices.
//
// Three ideas carry most of the file:
//
//   - a chord may sag no more than half a pixel from the arc it stands in for.
//     Sag is L^2/8R, so at the deepest zoom (295 m/px) the limit is ~120 km.
//     Every source edge longer than that is subdivided along its great circle,
//     lines and fill rings alike, so the two agree vertex for vertex.
//
//   - a triangulation's interior diagonals are invisible: two triangles that
//     share a chord tile exactly the quad that chord cuts, so only a polygon's
//     OUTLINE edges have to be short. Interior edges still get refined, but for
//     one narrower reason — a triangle straddling the horizon is clipped along
//     the plane through the sphere's centre, and a long chord puts that cut
//     visibly inside the true limb.
//
//   - the antimeridian stops existing. Rings are unwrapped in longitude before
//     they are triangulated, so a country that straddles 180 is an ordinary
//     ring in a shifted frame. Only a ring that wraps a full 360 is special:
//     it encircles a pole, and gets closed with a cap. Antarctica is the one.
//
// Line orientation is the other thing worth knowing about. Every line instance
// carries the unit on its LEFT and the unit on its RIGHT, which is what tells
// the renderer whether a border is a border at all, and which unit's colour
// belongs on which side of it. The atlas band is NOT a ribbon extruded off
// that pair, which is what this comment used to say: a quad thrown off one
// segment covers ground the unit does not own wherever the border bends away,
// and on the coastline that put white into the sea. The band is the unit's own
// fill drawn through a stencil stroked along these lines. Two sentinels stand
// in for "not a unit":
//
//   UNIT_OUTSIDE  beyond the map's own units — open sea, or land it doesn't
//                 cover. Exactly one side outside means a map-edge run.
//   UNIT_NONE     not a unit boundary at all: scenery, graticule, lake edges.
//
// A single-user county arc keeps the same unit on both sides, which is how the
// old ARC_RECORDS marked the nation's edge: no grey state line, no band. The
// band there comes from the classified boundary runs, as it does today.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d3 from "d3-geo";
import { feature, merge } from "topojson-client";
import earcut from "earcut";
import { gzipSync } from "fflate";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// ------------------------------------------------------------------ constants

const RAD = Math.PI / 180;
const DEG = 180 / Math.PI;
const EARTH_KM = 6371;

// Half a pixel of chord sag at the deepest zoom. See the header.
const MAX_EDGE_KM = 120;
const MAX_EDGE_RAD = MAX_EDGE_KM / EARTH_KM;
// Comparing chord lengths avoids an acos per edge; this is the chord that
// subtends MAX_EDGE_RAD on the unit sphere.
const MAX_CHORD = 2 * Math.sin(MAX_EDGE_RAD / 2);

const UNIT_NONE = 0xfffe;
const UNIT_OUTSIDE = 0xffff;

// The design box the home fit puts the lower 48 into, unchanged from main.js.
const DESIGN_BOX = [975, 610];
const HOME_ROTATION = [96, -45];

// ------------------------------------------------------------- vector helpers

// Right-handed, z through the north pole, x through (0N, 0E). d3's orthographic
// looks down +x, which is why the parity check below reads (y, -z).
const toXyz = (lon, lat) => {
  const p = lat * RAD;
  const l = lon * RAD;
  const c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
};
const toLonLat = ([x, y, z]) => [
  Math.atan2(y, x) * DEG,
  Math.atan2(z, Math.hypot(x, y)) * DEG,
];
const chord = (a, b) => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

// Great-circle interpolation, so a subdivided edge lands ON the sphere rather
// than on the chord under it.
const slerp = (a, b, t) => {
  const dot = Math.min(1, Math.max(-1, a[0] * b[0] + a[1] * b[1] + a[2] * b[2]));
  const omega = Math.acos(dot);
  if (omega < 1e-12) return [...a];
  const s = Math.sin(omega);
  const wa = Math.sin((1 - t) * omega) / s;
  const wb = Math.sin(t * omega) / s;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
};

// How many equal pieces an edge has to be cut into to stay under the sag limit.
const piecesFor = (a, b) => {
  const c = chord(a, b);
  if (c <= MAX_CHORD) return 1;
  const omega = 2 * Math.asin(Math.min(1, c / 2));
  return Math.ceil(omega / MAX_EDGE_RAD);
};

const stats = { subdividedEdges: 0, insertedPoints: 0, emptySegments: 0, emptyRuns: 0 };

// Rounding the overlay files to four decimals collapses the odd short step, and
// a handful of whole boundary runs with it. A zero-length segment is a
// degenerate quad in the renderer and a coin toss for the orientation probe, so
// it is dropped here rather than defended against downstream.
const hasLength = (line) => {
  for (let i = 1; i < line.length; i++) {
    if (line[i][0] !== line[i - 1][0] || line[i][1] !== line[i - 1][1]) return true;
  }
  return false;
};

// ---------------------------------------------------------------- polylines
//
// Every line source funnels through here. Points go in as lon/lat, segment
// endpoints come out on the unit sphere, subdivided where an edge is too long
// to pass for a great circle.

function densifyPolyline(lonLat, closed = false) {
  const src = lonLat.map(([lon, lat]) => toXyz(lon, lat));
  if (closed && src.length > 1 && chord(src[0], src[src.length - 1]) < 1e-12) src.pop();
  const out = [];
  const last = closed ? src.length : src.length - 1;
  for (let i = 0; i < last; i++) {
    const a = src[i];
    const b = src[(i + 1) % src.length];
    out.push(a);
    const n = piecesFor(a, b);
    if (n === 1) continue;
    stats.subdividedEdges++;
    stats.insertedPoints += n - 1;
    for (let k = 1; k < n; k++) out.push(slerp(a, b, k / n));
  }
  if (!closed && src.length) out.push(src[src.length - 1]);
  return out;
}

// ------------------------------------------------------------------- buffers

// One shared position/index pair for every fill mesh, one shared segment list
// for every line group. A "group" is just a contiguous range in them, which is
// what makes the whole scene a handful of draw calls over a single upload.
const fill = { pos: [], unit: [], idx: [] };
const lines = { start: [], end: [], left: [], right: [] };

const fillVertexCount = () => fill.unit.length;
const lineCount = () => lines.left.length;

function pushSegments(points, left, right) {
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    if (a[0] === b[0] && a[1] === b[1] && a[2] === b[2]) {
      stats.emptySegments++;
      continue;
    }
    lines.start.push(a[0], a[1], a[2]);
    lines.end.push(b[0], b[1], b[2]);
    lines.left.push(left);
    lines.right.push(right);
  }
}

const addPolyline = (lonLat, left = UNIT_NONE, right = UNIT_NONE) => {
  if (lonLat.length >= 2) pushSegments(densifyPolyline(lonLat), left, right);
};
const addRingOutline = (lonLat, left = UNIT_NONE, right = UNIT_NONE) => {
  if (lonLat.length < 3) return;
  const pts = densifyPolyline(lonLat, true);
  pts.push(pts[0]);
  pushSegments(pts, left, right);
};

// ------------------------------------------------------- rings and the poles

// Longitudes made continuous: a ring that steps from 179 to -179 has not moved
// 358 degrees, and saying so is what lets earcut work in a plain lon/lat plane
// with no antimeridian special case anywhere.
function unwrapLon(ring) {
  const out = [[ring[0][0], ring[0][1]]];
  let lon = ring[0][0];
  for (let i = 1; i < ring.length; i++) {
    let d = ring[i][0] - ring[i - 1][0];
    if (d > 180) d -= 360;
    else if (d < -180) d += 360;
    lon += d;
    out.push([lon, ring[i][1]]);
  }
  return out;
}

const signedArea = (ring) => {
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    a += (ring[j][0] - ring[i][0]) * (ring[j][1] + ring[i][1]);
  }
  return a / 2;
};

// Which way this file winds its exterior rings, measured rather than assumed:
// it decides both which pole a wrapping ring encircles and which side of a
// shared arc each of its two counties lies on.
function exteriorsAreCcw(features, label) {
  let ccw = 0;
  let cw = 0;
  for (const f of features) {
    for (const rings of polygonsOf(f.geometry)) {
      const a = signedArea(unwrapLon(rings[0]));
      if (a > 0) ccw++;
      else if (a < 0) cw++;
    }
  }
  if (!ccw || !cw) console.log(`  ${label}: exterior rings all ${ccw ? "CCW" : "CW"} (${ccw + cw})`);
  else console.log(`  ${label}: ${ccw} CCW / ${cw} CW exterior rings`);
  return ccw > cw;
}

const polygonsOf = (geometry) =>
  !geometry ? [] : geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;

let polarRings = 0;

// A ring ready for earcut: longitudes unwrapped, a pole cap added if it wraps
// the world, and every edge short enough that the outline it draws is the
// outline the sphere would draw. Returns matched lon/lat and xyz lists — the
// first is what earcut triangulates in, the second is what ships.
function prepRing(ring, ccwExterior, shiftNear = null) {
  let un = unwrapLon(ring);
  const net = un[un.length - 1][0] - un[0][0];

  if (Math.abs(Math.abs(net) - 360) < 1) {
    // The ring circles the globe, so it encloses a pole and there is no way to
    // close it in the plane without saying which. Walking east with the
    // interior on the left keeps the interior to the north; the winding
    // convention measured above says which side the interior is on.
    const interiorNorth = ccwExterior === net > 0;
    const poleLat = interiorNorth ? 90 : -90;
    const meanLat = un.reduce((s, p) => s + p[1], 0) / un.length;
    if (Math.sign(meanLat) !== Math.sign(poleLat)) {
      throw new Error(
        `ring wraps ${net.toFixed(0)} degrees and reads as a ${poleLat > 0 ? "north" : "south"} ` +
          `polar ring, but its mean latitude is ${meanLat.toFixed(1)}`
      );
    }
    polarRings++;
    // The unwrapped ring is an open path from (L, lat0) to (L+-360, lat0).
    // Closing it down the two meridians and along the pole makes it an
    // ordinary simple polygon in the plane; on the sphere the two meridians
    // coincide and the pole edge has no length, so the cap is a triangle fan
    // and the sliver between the meridians has no area.
    un = [...un, [un[un.length - 1][0], poleLat], [un[0][0], poleLat]];
  } else if (un.length > 1) {
    // Ordinary ring: drop the repeated closing point, which earcut supplies.
    const first = un[0];
    const last = un[un.length - 1];
    if (Math.abs(first[0] - last[0]) < 1e-9 && Math.abs(first[1] - last[1]) < 1e-9) un.pop();
  }

  // A hole is unwrapped on its own, so it can land a full turn away from the
  // exterior it belongs to. Put it back in the exterior's frame.
  if (shiftNear !== null) {
    const k = Math.round((shiftNear - un[0][0]) / 360);
    if (k) for (const p of un) p[0] += k * 360;
  }

  // Subdivide, keeping the plane and the sphere in step. Longitude is carried
  // forward rather than re-derived from the point, so the ring stays
  // continuous across the antimeridian and across the pole cap.
  const lonLat = [];
  const xyz = [];
  const n = un.length;
  for (let i = 0; i < n; i++) {
    const p = un[i];
    const q = un[(i + 1) % n];
    const a = toXyz(p[0], p[1]);
    const b = toXyz(q[0], q[1]);
    lonLat.push(p);
    xyz.push(a);
    const steps = piecesFor(a, b);
    if (steps === 1) continue;
    stats.subdividedEdges++;
    stats.insertedPoints += steps - 1;
    for (let k = 1; k < steps; k++) {
      const m = slerp(a, b, k / steps);
      const [lon, lat] = toLonLat(m);
      // Same frame as the edge's own endpoints, whatever branch atan2 picked.
      const shifted = lon + 360 * Math.round((p[0] - lon) / 360);
      lonLat.push([shifted, lat]);
      xyz.push(m);
    }
  }
  return { lonLat, xyz };
}

// ------------------------------------------------------------- triangulation

// Sub-pixel refinement of interior edges. A long chord is invisible where two
// triangles share it, but at the horizon the renderer cuts a triangle along
// the plane through the sphere's centre, and that cut follows the chord — so a
// long one puts the limb visibly inside where it belongs. Splitting long edges
// at their midpoints, with the midpoints shared between neighbours, keeps the
// mesh conformal: no T-junctions, no hairline cracks.
//
// Only each triangle's LONGEST edge is marked per round (Rivara's longest-edge
// bisection), not every edge over the limit. earcut fills a polygon with long
// thin slivers, and splitting all three of a sliver's edges quadruples it to
// chase one long side: on the world's coastlines that came out at four times
// the triangles this does, for the same limit.
const refineStats = { rounds: 0, added: 0 };

function refine(verts, tris) {
  const key = (u, v) => (u < v ? u * 4294967296 + v : v * 4294967296 + u);
  const at = (i) => [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
  for (let round = 0; round < 64; round++) {
    const mid = new Map();
    for (const t of tris) {
      let longest = 0;
      let pick = -1;
      for (let e = 0; e < 3; e++) {
        const c = chord(at(t[e]), at(t[(e + 1) % 3]));
        if (c > longest) {
          longest = c;
          pick = e;
        }
      }
      if (longest > MAX_CHORD) mid.set(key(t[pick], t[(pick + 1) % 3]), -1);
    }
    if (!mid.size) return tris;
    refineStats.rounds = Math.max(refineStats.rounds, round + 1);
    for (const k of [...mid.keys()]) {
      const u = Math.floor(k / 4294967296);
      const v = k % 4294967296;
      const m = slerp(at(u), at(v), 0.5);
      const len = Math.hypot(m[0], m[1], m[2]);
      mid.set(k, verts.length / 3);
      verts.push(m[0] / len, m[1] / len, m[2] / len);
    }
    // A neighbour can have a second edge marked from its own side, so the
    // one-, two- and three-edge patterns all still have to be handled.
    const next = [];
    for (const t of tris) splitTriangle(t, mid, key, next);
    refineStats.added += next.length - tris.length;
    tris = next;
  }
  throw new Error("triangle refinement did not converge");
}

// Red-green refinement of one triangle: which of its edges were split decides
// the pattern, and every pattern keeps the parent's winding.
function splitTriangle(t, mid, key, out) {
  let [a, b, c] = t;
  const m = (u, v) => mid.get(key(u, v)) ?? -1;
  let ab = m(a, b);
  let bc = m(b, c);
  let ca = m(c, a);
  const n = (ab >= 0) + (bc >= 0) + (ca >= 0);
  if (n === 0) {
    out.push(t);
  } else if (n === 3) {
    out.push([a, ab, ca], [ab, b, bc], [ca, bc, c], [ab, bc, ca]);
  } else if (n === 1) {
    // Rotate until the split edge is (a, b).
    if (bc >= 0) [a, b, c, ab] = [b, c, a, bc];
    else if (ca >= 0) [a, b, c, ab] = [c, a, b, ca];
    out.push([a, ab, c], [ab, b, c]);
  } else {
    // Rotate until the split edges are (a, b) and (b, c).
    if (!(ab >= 0 && bc >= 0)) {
      if (bc >= 0 && ca >= 0) [a, b, c, ab, bc] = [b, c, a, bc, ca];
      else [a, b, c, ab, bc] = [c, a, b, ca, ab];
    }
    out.push([b, bc, ab], [a, ab, bc], [a, bc, c]);
  }
}

// Signed spherical area of a triangulated shape (Van Oosterom & Strackee), for
// the coverage check at the bottom: it catches a dropped hole, a failed
// triangulation or a ring that came out inside out, none of which a vertex
// count would show.
function meshArea(verts, tris) {
  let sum = 0;
  for (const [i, j, k] of tris) {
    const a = [verts[i * 3], verts[i * 3 + 1], verts[i * 3 + 2]];
    const b = [verts[j * 3], verts[j * 3 + 1], verts[j * 3 + 2]];
    const c = [verts[k * 3], verts[k * 3 + 1], verts[k * 3 + 2]];
    const triple =
      a[0] * (b[1] * c[2] - b[2] * c[1]) +
      a[1] * (b[2] * c[0] - b[0] * c[2]) +
      a[2] * (b[0] * c[1] - b[1] * c[0]);
    const dot =
      1 +
      (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) +
      (b[0] * c[0] + b[1] * c[1] + b[2] * c[2]) +
      (c[0] * a[0] + c[1] * a[1] + c[2] * a[2]);
    sum += 2 * Math.atan2(triple, dot);
  }
  return sum;
}

// One GeoJSON geometry into the shared fill mesh. Returns the spherical area it
// covered, so the caller can check it against the source.
//
// refineInterior is off for one shape, the white nation backing: the county
// fills are drawn over it and cover it exactly, so where an unrefined chord
// pulls the backing in from the limb there is a county fill standing in its
// place. Its outline is still subdivided like everything else — that is what
// the seam aprons are stencilled against.
function addFill(geometry, unitId, ccwExterior, refineInterior = true) {
  let area = 0;
  for (const rings of polygonsOf(geometry)) {
    if (!rings.length || rings[0].length < 4) continue;
    const outer = prepRing(rings[0], ccwExterior);
    const near = outer.lonLat[0][0];
    const coords = [];
    const holes = [];
    const verts = [];
    const push = (r) => {
      for (const p of r.lonLat) coords.push(p[0], p[1]);
      for (const p of r.xyz) verts.push(p[0], p[1], p[2]);
    };
    push(outer);
    for (let h = 1; h < rings.length; h++) {
      if (rings[h].length < 4) continue;
      holes.push(coords.length / 2);
      push(prepRing(rings[h], ccwExterior, near));
    }
    const flat = earcut(coords, holes, 2);
    if (!flat.length) continue;
    let tris = [];
    for (let i = 0; i < flat.length; i += 3) tris.push([flat[i], flat[i + 1], flat[i + 2]]);
    if (refineInterior) tris = refine(verts, tris);
    area += Math.abs(meshArea(verts, tris));

    const base = fillVertexCount();
    for (let i = 0; i < verts.length; i++) fill.pos.push(verts[i]);
    for (let i = 0; i < verts.length / 3; i++) fill.unit.push(unitId);
    for (const [i, j, k] of tris) fill.idx.push(base + i, base + j, base + k);
  }
  return area;
}

// --------------------------------------------------------------- source data

console.log("reading source data...");
const countiesTopo = readJson("na-counties-topo.json");
const overlays = readJson("na-map-overlays.json");
const worldTopo = readJson("world-land.json");

const counties = feature(countiesTopo, countiesTopo.objects.counties).features;
const worldLand = feature(worldTopo, worldTopo.objects.land).features;
// The lake tiers, largest first, and their shorelines. Same contract the river
// tiers keep: build-world.mjs decides what falls in each and its order is read
// off the file rather than repeated here, so a tier is never drawn without
// every larger tier under it. A tier's water and its shore carry the same
// number, and the renderer fades the pair together.
const LAKE_TIERS = Object.keys(worldTopo.objects).filter((n) => /^lakes\d+$/.test(n));
if (!LAKE_TIERS.length) throw new Error("world-land.json carries no lake tiers");
const worldLakes = LAKE_TIERS.map((name) => ({
  name,
  edges: name.replace(/^lakes/, "lakeEdges"),
  features: feature(worldTopo, worldTopo.objects[name]).features,
}));
for (const t of worldLakes) {
  if (!worldTopo.objects[t.edges]) throw new Error(`${t.name} has no ${t.edges} to go with it`);
}
const worldCoast = feature(worldTopo, worldTopo.objects.coast).geometry;
const worldBorders = feature(worldTopo, worldTopo.objects.borders).geometry;
for (const t of worldLakes) t.edgeGeometry = feature(worldTopo, worldTopo.objects[t.edges]).geometry;
// The river tiers, coarsest first. build-world.mjs decides what falls in each
// and its order is the contract: a tier is never drawn without every coarser
// tier under it, so the names are read in the order they appear there rather
// than being listed again here.
const RIVER_TIERS = Object.keys(worldTopo.objects).filter((n) => /^rivers\d+$/.test(n));
if (!RIVER_TIERS.length) throw new Error("world-land.json carries no river tiers");
const worldRivers = RIVER_TIERS.map((name) => ({
  name,
  geometry: feature(worldTopo, worldTopo.objects[name]).geometry,
}));
const lakeFeatures = overlays.lakes.features;

// Unit ids in source order, which is the order the map draws them in: the
// foreign units lead, so the Census county shapes paint over any overlap along
// the seam. The index is what every vertex and every line instance carries,
// and what the palette texture will be keyed by.
const unitIds = counties.map((f) => f.id);
const unitIndex = new Map(unitIds.map((id, i) => [id, i]));
if (unitIds.length > 0xfffe) throw new Error(`${unitIds.length} units will not fit a uint16 id`);

console.log("measuring ring winding...");
const COUNTY_CCW = exteriorsAreCcw(counties, "counties");
const WORLD_CCW = exteriorsAreCcw(worldLand, "world land");

// ------------------------------------------------------- which side is which

// topojson keeps one copy of a shared boundary, so a county's ring walks some
// arcs forward and some backward. With the interior on a known side of the
// walk, that direction is exactly the arc's left/right pair — no geometry test
// needed. The probe below checks the answer rather than deriving it.
const arcForward = new Uint16Array(countiesTopo.arcs.length).fill(UNIT_OUTSIDE);
const arcBackward = new Uint16Array(countiesTopo.arcs.length).fill(UNIT_OUTSIDE);
const arcUsers = new Uint8Array(countiesTopo.arcs.length);
for (const g of countiesTopo.objects.counties.geometries) {
  const u = unitIndex.get(g.id);
  const rings = g.type === "Polygon" ? g.arcs : g.arcs.flat();
  for (const ring of rings) {
    for (const a of ring) {
      if (a >= 0) arcForward[a] = u;
      else arcBackward[~a] = u;
      arcUsers[a < 0 ? ~a : a]++;
    }
  }
}
// Interior on the left of the walk when exteriors run counterclockwise.
const arcLeft = COUNTY_CCW ? arcForward : arcBackward;
const arcRight = COUNTY_CCW ? arcBackward : arcForward;

function decodeArcs(topo) {
  const [sx, sy] = topo.transform.scale;
  const [tx, ty] = topo.transform.translate;
  return topo.arcs.map((arc) => {
    let x = 0;
    let y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * sx + tx, y * sy + ty];
    });
  });
}
const arcs = decodeArcs(countiesTopo);

// Ray-casting point-in-polygon against a unit's own lon/lat rings, for the
// orientation probe and the boundary-run fallback below.
const unitRings = new Map(counties.map((f) => [f.id, polygonsOf(f.geometry)]));
function ringContains(ring, x, y) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const [xi, yi] = ring[i];
    const [xj, yj] = ring[j];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}
function unitContains(id, x, y) {
  for (const rings of unitRings.get(id) ?? []) {
    if (!ringContains(rings[0], x, y)) continue;
    let hole = false;
    for (let h = 1; h < rings.length && !hole; h++) hole = ringContains(rings[h], x, y);
    if (!hole) return true;
  }
  return false;
}

// A point just off the left of a polyline's longest segment. Small enough to
// stay inside whatever the segment bounds, big enough to clear the 4-decimal
// rounding the overlay files ship in.
function leftProbe(pts) {
  let best = -1;
  let bestLen = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const len = Math.hypot(pts[i + 1][0] - pts[i][0], pts[i + 1][1] - pts[i][1]);
    if (len > bestLen) {
      bestLen = len;
      best = i;
    }
  }
  if (best < 0 || !bestLen) return null;
  const [ax, ay] = pts[best];
  const [bx, by] = pts[best + 1];
  const lat = (ay + by) / 2;
  const cos = Math.max(0.05, Math.cos(lat * RAD));
  // Work in locally equal units so "left" is left on the ground, not in a
  // stretched lon/lat plane.
  const dx = (bx - ax) * cos;
  const dy = by - ay;
  const len = Math.hypot(dx, dy);
  const step = Math.min(0.002, len / 3);
  return [(ax + bx) / 2 + (-dy / len) * step / cos, lat + (dx / len) * step];
}

{
  // Check the derivation, don't trust it: probe a sample of two-sided arcs and
  // insist every clean vote agrees that arcLeft's unit is the one on the left.
  let agree = 0;
  let disagree = 0;
  const step = Math.max(1, Math.floor(arcs.length / 400));
  for (let i = 0; i < arcs.length; i += step) {
    if (arcUsers[i] !== 2 || arcLeft[i] === UNIT_OUTSIDE || arcRight[i] === UNIT_OUTSIDE) continue;
    if (arcLeft[i] === arcRight[i]) continue;
    const probe = leftProbe(arcs[i]);
    if (!probe) continue;
    const inLeft = unitContains(unitIds[arcLeft[i]], probe[0], probe[1]);
    const inRight = unitContains(unitIds[arcRight[i]], probe[0], probe[1]);
    if (inLeft === inRight) continue; // the probe missed; no vote either way
    if (inLeft) agree++;
    else disagree++;
  }
  if (disagree || agree < 50) {
    throw new Error(`arc orientation probe: ${agree} agree, ${disagree} disagree`);
  }
  console.log(`  arc left/right confirmed by ${agree} probes, 0 against`);
}

// The classified boundary runs and the seam pieces are contiguous slices of
// these same arcs, rounded to four decimals on the way out. Matching a run's
// first step back to the arc it was cut from recovers its orientation exactly;
// the probe stands by for anything the match misses.
const round4 = (v) => Math.round(v * 1e4) / 1e4;
const stepKey = (a, b) => `${round4(a[0])},${round4(a[1])}|${round4(b[0])},${round4(b[1])}`;
const stepToArc = new Map();
for (let i = 0; i < arcs.length; i++) {
  const pts = arcs[i];
  for (let k = 0; k < pts.length - 1; k++) stepToArc.set(stepKey(pts[k], pts[k + 1]), i);
}
const runMatch = { matched: 0, probed: 0, unresolved: 0 };

// Whether the run's owning unit lies to the left of the run as stored.
function ownerOnLeft(line, ownerId) {
  for (let k = 0; k < line.length - 1; k++) {
    const arc = stepToArc.get(stepKey(line[k], line[k + 1]));
    if (arc === undefined) continue;
    const owner = unitIndex.get(ownerId);
    if (arcLeft[arc] === owner) {
      runMatch.matched++;
      return true;
    }
    if (arcRight[arc] === owner) {
      runMatch.matched++;
      return false;
    }
  }
  const probe = leftProbe(line);
  if (probe) {
    runMatch.probed++;
    return unitContains(ownerId, probe[0], probe[1]);
  }
  runMatch.unresolved++;
  return true;
}

// ---------------------------------------------------------------- fill mesh
//
// Draw order, bottom to top, mirroring the current layer stack: the scenery,
// then the map's water and its white backing, then the seam aprons and the
// county fills. The border band is not here — it is a screen-space ribbon
// extruded from the line instances below, which is what lets it keep a
// constant pixel width without a mask.

console.log("triangulating fills...");
const fillGroups = {};
const beginFill = () => ({ v0: fillVertexCount(), i0: fill.idx.length });
const endFill = (name, m, extra = {}) => {
  fillGroups[name] = {
    firstVertex: m.v0,
    vertexCount: fillVertexCount() - m.v0,
    firstIndex: m.i0,
    indexCount: fill.idx.length - m.i0,
    ...extra,
  };
};

// Triangulated area against the source geometry, shape by shape. A dropped
// hole, a ring that came out inside out or a triangulation that quietly gave
// up all show here and nowhere else — a vertex count would not move.
//
// A handful of shapes miss by a few percent all the same, and those are the
// source's own: simplification can leave a ring crossing itself, and earcut
// then fills the knot rather than the shape. deck.gl's SolidPolygonLayer runs
// the same earcut on the same rings today, so this is what the map already
// draws. The aggregate is what catches a compiler bug, so that is what fails
// the build; the individual worst cases are printed to be looked at.
const areaCheck = { got: 0, want: 0, worst: [] };
function checkArea(label, got, want) {
  if (!want) return;
  areaCheck.got += got;
  areaCheck.want += want;
  const rel = (got - want) / want;
  if (Math.abs(rel) > 0.01) areaCheck.worst.push({ label, rel });
}

{
  const m = beginFill();
  for (const f of worldLand) {
    checkArea(
      `world land ${f.properties.name}`,
      addFill(f.geometry, UNIT_NONE, WORLD_CCW),
      d3.geoArea(f.geometry)
    );
  }
  endFill("worldLand", m);
}
for (const tier of worldLakes) {
  const m = beginFill();
  for (const f of tier.features) addFill(f.geometry, UNIT_NONE, WORLD_CCW);
  endFill(tier.name.replace(/^lakes/, "worldLakes"), m);
}
// The map's own lakes split two ways, exactly as the layer stack does: the
// ones the Census file carves out of the land go under the white backing, the
// ones sitting inside a unit go over the fills. So do these two groups — the
// over lakes come last in the buffer, after the counties.
const addLakes = (name, onland) => {
  const m = beginFill();
  for (const f of lakeFeatures) {
    if (!!f.properties.onland === onland) addFill(f.geometry, UNIT_NONE, WORLD_CCW);
  }
  endFill(name, m);
};
addLakes("lakesUnder", false);
{
  // The merged land: the white backing under the fills, and the shape the
  // renderer stencils the seam aprons against so they cannot paint into the
  // sea. It is the union of the county rings, so it needs no unit id.
  const m = beginFill();
  const nation = merge(countiesTopo, countiesTopo.objects.counties.geometries);
  addFill(nation, UNIT_NONE, COUNTY_CCW, false);
  endFill("nation", m);
}

// Under-fill along the international seam. The Natural Earth and Census lines
// disagree by up to a few km, so each foreign border unit gets a ribbon of
// dumb quads straddling the seam, wearing that unit's own fill. Built in
// lon/lat at a fixed 6 km, so unlike the band it is a fact about the ground
// and stays real geometry on the sphere.
{
  const m = beginFill();
  const APRON_KM = 6;
  const KM_PER_DEG = 111.32;
  for (const s of overlays.seams ?? []) {
    const pts = s.line;
    const unit = unitIndex.get(s.f) ?? UNIT_OUTSIDE;
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
      // ends stay tight so the ribbon barely pokes past where the border meets
      // the sea.
      const e0 = i === 0 ? 0.5 : APRON_KM;
      const e1 = i === pts.length - 2 ? 0.5 : APRON_KM;
      const ring = [
        [ax + (-ux * e0 + nx * APRON_KM) / kx, ay + (-uy * e0 + ny * APRON_KM) / KM_PER_DEG],
        [bx + (ux * e1 + nx * APRON_KM) / kx, by + (uy * e1 + ny * APRON_KM) / KM_PER_DEG],
        [bx + (ux * e1 - nx * APRON_KM) / kx, by + (uy * e1 - ny * APRON_KM) / KM_PER_DEG],
        [ax + (-ux * e0 - nx * APRON_KM) / kx, ay + (-uy * e0 - ny * APRON_KM) / KM_PER_DEG],
      ];
      ring.push(ring[0]);
      addFill({ type: "Polygon", coordinates: [ring] }, unit, COUNTY_CCW);
    }
  }
  endFill("aprons", m);
}

// The counties themselves, each unit's triangles kept as a contiguous run so a
// carve can patch one unit's range without touching the rest of the buffer.
const unitVertexRange = new Uint32Array(unitIds.length * 2);
const unitIndexRange = new Uint32Array(unitIds.length * 2);
{
  const m = beginFill();
  for (let u = 0; u < counties.length; u++) {
    const f = counties[u];
    const v0 = fillVertexCount();
    const i0 = fill.idx.length;
    checkArea(`county ${f.id}`, addFill(f.geometry, u, COUNTY_CCW), d3.geoArea(f.geometry));
    unitVertexRange[u * 2] = v0;
    unitVertexRange[u * 2 + 1] = fillVertexCount() - v0;
    unitIndexRange[u * 2] = i0;
    unitIndexRange[u * 2 + 1] = fill.idx.length - i0;
  }
  endFill("counties", m);
}

// ------------------------------------------------------------ line instances
//
// Same story, bottom to top. Several groups are drawn more than once by the
// renderer — the coast carries both its wide halo and its thin blue line, and
// the county arcs carry the hairline, the grey state border and the band — so
// a group is a geometry, not a style.

console.log("building line instances...");
const lineGroups = {};
const beginLines = () => lineCount();
const endLines = (name, first, extra = {}) => {
  lineGroups[name] = { first, count: lineCount() - first, ...extra };
};

const ringsOf = (geometry) =>
  geometry.type === "LineString"
    ? [geometry.coordinates]
    : geometry.type === "MultiLineString"
      ? geometry.coordinates
      : [];

{
  const first = beginLines();
  for (const line of ringsOf(d3.geoGraticule10())) addPolyline(line);
  endLines("graticule", first, { unitBoundary: false });
}
{
  const first = beginLines();
  for (const line of ringsOf(worldCoast)) addPolyline(line);
  endLines("worldCoast", first, { unitBoundary: false });
}
{
  const first = beginLines();
  for (const line of ringsOf(worldBorders)) addPolyline(line);
  endLines("worldBorders", first, { unitBoundary: false });
}
for (const tier of worldLakes) {
  const first = beginLines();
  for (const line of ringsOf(tier.edgeGeometry)) addPolyline(line);
  endLines(tier.edges.replace(/^lakeEdges/, "worldLakeEdges"), first, { unitBoundary: false });
}
// The world's rivers, which unlike the three groups above are not scenery:
// they run over the map's own counties as much as over the land behind it.
// They sit here all the same, next to the other water lines out of the same
// source file — buffer order is not draw order, and the renderer puts them
// where they belong.
//
// One group per tier, in tier order, so the renderer can draw the coarse
// rivers alone at a wide view and add the finer ones as it zooms in. Each is
// an ordinary line group and nothing downstream needs to know they are a
// series: a group is a range in the buffer, so drawing three of the four is
// three draw calls over one contiguous stretch of it.
for (const tier of worldRivers) {
  const first = beginLines();
  for (const line of ringsOf(tier.geometry)) addPolyline(line);
  endLines(tier.name, first, { unitBoundary: false });
}
const addLakeEdges = (name, onland) => {
  const first = beginLines();
  for (const f of lakeFeatures) {
    if (!!f.properties.onland !== onland) continue;
    for (const rings of polygonsOf(f.geometry)) for (const ring of rings) addRingOutline(ring);
  }
  endLines(name, first, { unitBoundary: false });
};
addLakeEdges("lakeEdgesUnder", false);

// The map's outer boundary as classified runs: coast (blue, with a halo),
// lakeshore (blue, no halo — the lake fill already reads as water) and border
// (a fixed dark line where the far side is land beyond the map's units). Each
// run has land on one side and nothing of the map's on the other, which is
// what makes the band show along it once its unit joins the union.
for (const cls of ["coast", "lakeshore", "border"]) {
  const first = beginLines();
  for (const r of overlays.boundary) {
    if (r.cls !== cls) continue;
    if (!hasLength(r.line)) {
      stats.emptyRuns++;
      continue;
    }
    const unit = unitIndex.get(r.unit) ?? UNIT_OUTSIDE;
    const left = ownerOnLeft(r.line, r.unit);
    addPolyline(r.line, left ? unit : UNIT_OUTSIDE, left ? UNIT_OUTSIDE : unit);
  }
  endLines(cls, first, { unitBoundary: true });
}

// Every shared county boundary, once. An arc only one county uses is the
// nation's own edge: it keeps that county on both sides, which is how the old
// records marked it — no grey state line there, and no band (the classified
// runs above carry the band along the map's edge instead).
{
  const first = beginLines();
  for (let i = 0; i < arcs.length; i++) {
    if (!arcUsers[i]) continue;
    let left = arcLeft[i];
    let right = arcRight[i];
    if (left === UNIT_OUTSIDE) left = right;
    else if (right === UNIT_OUTSIDE) right = left;
    addPolyline(arcs[i], left, right);
  }
  endLines("countyArcs", first, { unitBoundary: true });
}

// The US-Canada/Mexico seam. The two sides come from different sources and
// share no arc, so the build ships the Census side annotated with the county
// and the foreign unit that flank it; with those as left and right, a seam
// segment renders and filters exactly like a shared-arc state border.
{
  const first = beginLines();
  for (const s of overlays.seams ?? []) {
    if (!hasLength(s.line)) {
      stats.emptyRuns++;
      continue;
    }
    const county = unitIndex.get(s.c) ?? UNIT_OUTSIDE;
    const foreign = unitIndex.get(s.f) ?? UNIT_OUTSIDE;
    const left = ownerOnLeft(s.line, s.c);
    addPolyline(s.line, left ? county : foreign, left ? foreign : county);
  }
  endLines("seams", first, { unitBoundary: true });
}

if (runMatch.unresolved) {
  throw new Error(`${runMatch.unresolved} boundary runs have no side: neither arc nor probe placed them`);
}
console.log(
  `  boundary orientation: ${runMatch.matched} runs from their arc, ${runMatch.probed} probed, ` +
    `${stats.emptyRuns} zero-length runs and ${stats.emptySegments} zero-length segments dropped`
);

// --------------------------------------------------------------- the camera
//
// Reproduced from main.js so the renderer inherits the same frame: the sphere
// radius and centre come from one fit of the lower 48 into the design box at
// the home rotation, and neither is ever recomputed — turning the globe has to
// spin it under the viewer, not re-frame whatever swings into view.

const isForeign = (id) => !/^\d/.test(id);
const conus = counties.filter(
  (f) => !isForeign(f.id) && f.properties.st !== "02" && f.properties.st !== "15"
);
const HOME_FIT = d3
  .geoOrthographic()
  .rotate(HOME_ROTATION)
  .fitSize(DESIGN_BOX, { type: "FeatureCollection", features: conus });

// d3.geoRotation as a 3x3, which is the whole point of the rewrite: this
// becomes a uniform and the CPU stops touching vertices. d3 composes
// rotate([l, p, g]) as a lambda shift, then a rotation in the xz plane, then
// one in the yz plane. Column-major, ready for uniformMatrix3fv.
function rotationMatrix([lambda, phi, gamma = 0]) {
  const [cl, sl] = [Math.cos(lambda * RAD), Math.sin(lambda * RAD)];
  const [cp, sp] = [Math.cos(phi * RAD), Math.sin(phi * RAD)];
  const [cg, sg] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)];
  const rz = [[cl, -sl, 0], [sl, cl, 0], [0, 0, 1]];
  const rx = [[cp, 0, -sp], [0, 1, 0], [sp, 0, cp]];
  const rg = [[1, 0, 0], [0, cg, -sg], [0, sg, cg]];
  const mul = (a, b) =>
    a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
  const m = mul(rg, mul(rx, rz));
  const out = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out.push(m[r][c]);
  return out;
}

// ------------------------------------------------------------------- checks

{
  // If the matrix and d3 ever disagree, the renderer draws a different globe
  // from the one every other part of the app computes against.
  const rot = [96, -45, 12];
  const m = rotationMatrix(rot);
  const proj = d3.geoOrthographic().rotate(rot).scale(1).translate([0, 0]);
  let worst = 0;
  for (const [lon, lat] of [[-100, 40], [-52, 47], [10, 60], [-160, 65], [0, 0], [-75, 9]]) {
    const p = toXyz(lon, lat);
    const r = [0, 1, 2].map((i) => m[i] * p[0] + m[3 + i] * p[1] + m[6 + i] * p[2]);
    if (r[0] <= 0) continue; // back of the sphere; d3 clips it away
    const [dx, dy] = proj([lon, lat]);
    worst = Math.max(worst, Math.abs(r[1] - dx), Math.abs(-r[2] - dy));
  }
  if (!(worst < 1e-12)) throw new Error(`rotation matrix disagrees with d3 by ${worst}`);
  console.log(`\nrotation matrix matches d3.geoOrthographic (max error ${worst.toExponential(1)})`);
}
{
  // Nothing may sit off the sphere: a vertex that drifts is a projection bug
  // that would only show as a wobble at the limb.
  let worst = 0;
  for (let i = 0; i < fill.pos.length; i += 3) {
    const r = Math.hypot(fill.pos[i], fill.pos[i + 1], fill.pos[i + 2]);
    worst = Math.max(worst, Math.abs(r - 1));
  }
  for (let i = 0; i < lines.start.length; i += 3) {
    const r = Math.hypot(lines.start[i], lines.start[i + 1], lines.start[i + 2]);
    worst = Math.max(worst, Math.abs(r - 1));
  }
  if (!(worst < 1e-9)) throw new Error(`a vertex sits ${worst} off the unit sphere`);
  console.log(`every vertex on the unit sphere (max radius error ${worst.toExponential(1)})`);
}
{
  const rel = (areaCheck.got - areaCheck.want) / areaCheck.want;
  if (Math.abs(rel) > 1e-3) {
    throw new Error(`triangulated area is off by ${(rel * 100).toFixed(3)}% overall`);
  }
  areaCheck.worst.sort((a, b) => Math.abs(b.rel) - Math.abs(a.rel));
  console.log(
    `triangulated area within ${(Math.abs(rel) * 100).toExponential(1)}% of the source overall; ` +
      `${areaCheck.worst.length} of ${counties.length + worldLand.length} shapes over 1% ` +
      `(self-crossing source rings)`
  );
  for (const w of areaCheck.worst.slice(0, 5)) {
    console.log(`  ${w.label.padEnd(24)} ${(w.rel * 100).toFixed(1)}%`);
  }
}
{
  // Groups are drawn as ranges, so a triangle that reaches across a group
  // boundary would pick up another layer's vertices the moment either moves.
  for (const [name, g] of Object.entries(fillGroups)) {
    for (let i = g.firstIndex; i < g.firstIndex + g.indexCount; i++) {
      const v = fill.idx[i];
      if (v < g.firstVertex || v >= g.firstVertex + g.vertexCount) {
        throw new Error(`a triangle in ${name} indexes vertex ${v}, outside the group`);
      }
    }
  }
  // The per-unit ranges are what a carve patches, and the per-vertex ids are
  // what the palette reads. They have to describe the same vertices.
  let v = fillGroups.counties.firstVertex;
  let i = fillGroups.counties.firstIndex;
  for (let u = 0; u < unitIds.length; u++) {
    if (unitVertexRange[u * 2] !== v || unitIndexRange[u * 2] !== i) {
      throw new Error(`unit ${unitIds[u]}'s range is out of step with the counties group`);
    }
    if (!unitVertexRange[u * 2 + 1]) throw new Error(`unit ${unitIds[u]} has no fill geometry`);
    for (let k = v; k < v + unitVertexRange[u * 2 + 1]; k++) {
      if (fill.unit[k] !== u) throw new Error(`vertex ${k} is in ${unitIds[u]}'s range as ${fill.unit[k]}`);
    }
    v += unitVertexRange[u * 2 + 1];
    i += unitIndexRange[u * 2 + 1];
  }
  if (v !== fillGroups.counties.firstVertex + fillGroups.counties.vertexCount) {
    throw new Error("the per-unit ranges do not fill the counties group");
  }
  console.log(`all ${unitIds.length} units have fill geometry, in ranges that tile the group`);
}
{
  // Every longest edge, once the subdivision and the refinement have run.
  let worstLine = 0;
  for (let i = 0; i < lines.left.length; i++) {
    const j = i * 3;
    const c = Math.hypot(
      lines.start[j] - lines.end[j],
      lines.start[j + 1] - lines.end[j + 1],
      lines.start[j + 2] - lines.end[j + 2]
    );
    worstLine = Math.max(worstLine, c);
  }
  let worstTri = 0;
  let worstBacking = 0;
  const backing = fillGroups.nation;
  for (let t = 0; t < fill.idx.length; t += 3) {
    const inBacking = t >= backing.firstIndex && t < backing.firstIndex + backing.indexCount;
    for (let e = 0; e < 3; e++) {
      const a = fill.idx[t + e] * 3;
      const b = fill.idx[t + ((e + 1) % 3)] * 3;
      const c = Math.hypot(
        fill.pos[a] - fill.pos[b],
        fill.pos[a + 1] - fill.pos[b + 1],
        fill.pos[a + 2] - fill.pos[b + 2]
      );
      if (inBacking) worstBacking = Math.max(worstBacking, c);
      else worstTri = Math.max(worstTri, c);
    }
  }
  const km = (c) => 2 * Math.asin(Math.min(1, c / 2)) * EARTH_KM;
  if (worstLine > MAX_CHORD * 1.001 || worstTri > MAX_CHORD * 1.001) {
    throw new Error(
      `an edge survived at ${km(Math.max(worstLine, worstTri)).toFixed(0)} km, over the ` +
        `${MAX_EDGE_KM} km limit`
    );
  }
  console.log(
    `longest edge ${km(worstLine).toFixed(0)} km (lines) / ${km(worstTri).toFixed(0)} km ` +
      `(triangles), limit ${MAX_EDGE_KM} km; the unrefined backing reaches ` +
      `${km(worstBacking).toFixed(0)} km`
  );
}

// -------------------------------------------------------------------- write

const arrays = [
  ["fillPosition", Float32Array.from(fill.pos), 3],
  ["fillUnit", Uint16Array.from(fill.unit), 1],
  ["fillIndex", Uint32Array.from(fill.idx), 1],
  ["lineStart", Float32Array.from(lines.start), 3],
  ["lineEnd", Float32Array.from(lines.end), 3],
  ["lineLeft", Uint16Array.from(lines.left), 1],
  ["lineRight", Uint16Array.from(lines.right), 1],
  ["unitVertexRange", unitVertexRange, 2],
  ["unitIndexRange", unitIndexRange, 2],
];
const TYPE = { Float32Array: "float32", Uint32Array: "uint32", Uint16Array: "uint16" };

let offset = 0;
const chunks = [];
const buffers = {};
for (const [name, array, components] of arrays) {
  const pad = (4 - (offset % 4)) % 4;
  if (pad) {
    chunks.push(Buffer.alloc(pad));
    offset += pad;
  }
  const buf = Buffer.from(array.buffer, array.byteOffset, array.byteLength);
  buffers[name] = {
    type: TYPE[array.constructor.name],
    components,
    byteOffset: offset,
    byteLength: buf.length,
    count: array.length / components,
  };
  chunks.push(buf);
  offset += buf.length;
}
const bin = Buffer.concat(chunks);

const manifest = {
  version: 1,
  generated: new Date().toISOString().slice(0, 10),
  binary: "globe-geometry.bin",
  sources: ["na-counties-topo.json", "na-map-overlays.json", "world-land.json"],
  // What "no unit" means in fillUnit, lineLeft and lineRight.
  sentinels: { none: UNIT_NONE, outside: UNIT_OUTSIDE },
  maxEdgeKm: MAX_EDGE_KM,
  camera: {
    homeRotation: HOME_ROTATION,
    globeScale: HOME_FIT.scale(),
    globeTranslate: HOME_FIT.translate(),
    designBox: DESIGN_BOX,
  },
  buffers,
  // Every group, in buffer order, which is laid out roughly bottom to top so a
  // consumer can walk the list. It is not the draw order and does not try to
  // be: several groups are drawn more than once (the coast carries both its
  // wide halo and its thin blue line) and the county arcs carry three
  // treatments between them. What goes over what is the renderer's, along with
  // every colour and width.
  fillOrder: [
    "worldLand",
    ...worldLakes.map((t) => t.name.replace(/^lakes/, "worldLakes")),
    "lakesUnder",
    "nation",
    "aprons",
    "counties",
  ],
  fills: fillGroups,
  lineOrder: [
    "graticule",
    "worldCoast",
    "worldBorders",
    ...worldLakes.map((t) => t.edges.replace(/^lakeEdges/, "worldLakeEdges")),
    ...RIVER_TIERS,
    "lakeEdgesUnder",
    "coast",
    "lakeshore",
    "border",
    "countyArcs",
    "seams",
  ],
  lines: lineGroups,
  units: unitIds,
};

{
  // The order lists have to name every group exactly once and in buffer order,
  // or a consumer walking them silently skips geometry — which is how a fill
  // group went missing the first time this ran.
  const tile = (order, groups, first, count, total, what) => {
    let cursor = 0;
    for (const name of order) {
      const g = groups[name];
      if (!g) throw new Error(`${what} order names ${name}, which is not a group`);
      if (first(g) !== cursor) {
        throw new Error(`${what} group ${name} starts at ${first(g)}, not ${cursor}`);
      }
      cursor = first(g) + count(g);
    }
    const missing = Object.keys(groups).filter((n) => !order.includes(n));
    if (missing.length) throw new Error(`${what} groups left out of the order: ${missing}`);
    if (cursor !== total) throw new Error(`${what} order covers ${cursor} of ${total}`);
  };
  tile(manifest.fillOrder, fillGroups, (g) => g.firstIndex, (g) => g.indexCount, fill.idx.length, "fill");
  tile(manifest.fillOrder, fillGroups, (g) => g.firstVertex, (g) => g.vertexCount, fillVertexCount(), "fill vertex");
  tile(manifest.lineOrder, lineGroups, (g) => g.first, (g) => g.count, lineCount(), "line");
}

fs.writeFileSync(path.join(DATA, "globe-geometry.bin"), bin);
fs.writeFileSync(path.join(DATA, "globe-geometry.json"), JSON.stringify(manifest, null, 2));

// ------------------------------------------------------------------- report

const mb = (n) => (n / 1048576).toFixed(2) + " MB";
console.log(`\nfills   ${fillVertexCount().toLocaleString()} vertices, ${(fill.idx.length / 3).toLocaleString()} triangles`);
for (const name of manifest.fillOrder) {
  const g = fillGroups[name];
  console.log(
    `  ${name.padEnd(12)} ${String(g.vertexCount).padStart(8)} verts  ` +
      `${String(g.indexCount / 3).padStart(8)} tris`
  );
}
console.log(`lines   ${lineCount().toLocaleString()} segments`);
for (const name of manifest.lineOrder) {
  console.log(`  ${name.padEnd(16)} ${String(lineGroups[name].count).padStart(8)} segments`);
}
console.log(
  `\n${stats.subdividedEdges.toLocaleString()} source edges subdivided ` +
    `(+${stats.insertedPoints.toLocaleString()} points), ` +
    `${refineStats.added.toLocaleString()} triangles added by refinement ` +
    `in up to ${refineStats.rounds} rounds, ${polarRings} polar ring(s) capped`
);
for (const [name, info] of Object.entries(buffers)) {
  console.log(`  ${name.padEnd(16)} ${mb(info.byteLength).padStart(9)}  ${info.count.toLocaleString()} x ${info.components}`);
}
console.log(
  `\nwrote public/data/globe-geometry.bin  ${mb(bin.length)} ` +
    `(${mb(gzipSync(bin).length)} gzipped)`
);
console.log(`      public/data/globe-geometry.json  ${(JSON.stringify(manifest).length / 1024).toFixed(0)} KB`);
console.log(`      globeScale ${HOME_FIT.scale().toFixed(1)} px, ${unitIds.length} units`);
