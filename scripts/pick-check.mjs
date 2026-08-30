// C4 — checks for the analytic picker.
//
// Both halves of C4 are pure maths over data the app already has, so both can
// be checked here rather than by moving a mouse over the harness:
//
//   1. camera.unproject against d3.geoOrthographic's own invert. The renderer
//      only agrees with the rest of the app because the forward matrix
//      reproduces d3 to 1e-16 (build-geometry.mjs checks that on every build);
//      the inverse has to earn the same.
//   2. the grid index against a brute-force sweep of every unit. The grid, the
//      antimeridian frames and the painter's-order tie-break are the three
//      places this can go wrong, and brute force has none of them.
//   3. the planar lon/lat containment test against d3.geoContains, which is
//      spherical. They are not the same test; this measures how far apart they
//      land, so "close enough at this data density" is a number rather than an
//      assumption.
//
// Run: node scripts/pick-check.mjs

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { feature } from "topojson-client";
import * as d3 from "d3-geo";
import { createCamera } from "../src/globe/camera.js";
import { createUnitIndex } from "../src/globe/pick.js";

const DATA = join(dirname(fileURLToPath(import.meta.url)), "..", "public", "data");
const readJson = (name) => JSON.parse(readFileSync(join(DATA, name), "utf8"));

// A fixed stream, so a failure is the same failure next run.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

let failures = 0;
const fail = (msg) => {
  console.error(`  FAIL  ${msg}`);
  failures++;
};

// ------------------------------------------------------- 1. the camera inverse

{
  const manifest = readJson("globe-geometry.json");
  const { globeScale, globeTranslate, designBox, homeRotation } = manifest.camera;
  const camera = createCamera(manifest.camera);
  // The design box at dpr 1 makes fit 1 and the letterbox offsets 0, so the
  // camera's device pixels ARE d3's projected pixels and the two are directly
  // comparable.
  camera.resize(designBox[0], designBox[1], 1);

  const rand = rng(20240829);
  let worstPx = 0;
  let worstGround = 0;
  let worstNearLimb = 0;
  let tested = 0;
  let rejected = 0;
  for (let trial = 0; trial < 400; trial++) {
    const rot = [rand() * 720 - 360, rand() * 180 - 90, rand() * 60 - 30];
    const k = [0.3, 1, 4, 16][trial & 3];
    camera.view.rotation = rot;
    camera.view.k = k;
    camera.view.pan = [rand() * 400 - 200, rand() * 400 - 200];
    camera.updateMatrix();

    const proj = d3
      .geoOrthographic()
      .rotate(rot)
      .scale(globeScale * k)
      .translate([
        globeTranslate[0] + camera.view.pan[0],
        globeTranslate[1] + camera.view.pan[1],
      ]);

    for (let i = 0; i < 25; i++) {
      const lon = rand() * 360 - 180;
      const lat = (Math.asin(rand() * 2 - 1) * 180) / Math.PI; // uniform on the sphere
      const xy = proj([lon, lat]);
      if (!xy) continue;
      const back = camera.unproject(xy[0], xy[1]);
      // d3 draws the whole sphere and clips the far side away itself, so a
      // point behind the horizon still projects — onto the same disc, at the
      // place its mirror image occupies. unproject always returns the near
      // root, so those are not the same point and are not a disagreement.
      const fwd = proj.rotate();
      const dist = d3.geoDistance([lon, lat], d3.geoRotation(fwd).invert([0, 0]));
      if (dist > Math.PI / 2 - 1e-6) {
        rejected++;
        continue;
      }
      if (!back) {
        fail(`unproject returned null for a point on the near hemisphere`);
        continue;
      }
      // Screen space is the honest measure. The projection is singular at the
      // limb — a whole kilometre of ground there moves the pixel by nothing —
      // so a ground-distance error blows up at the edge of the disc for
      // reasons that have nothing to do with this code being right. What the
      // pick actually owes is that the point it returns lands back under the
      // cursor.
      const round = proj(back);
      worstPx = Math.max(worstPx, Math.hypot(round[0] - xy[0], round[1] - xy[1]));
      const ground = d3.geoDistance([lon, lat], back) * 6371000;
      worstGround = Math.max(worstGround, ground);
      // Away from the limb the ground error should be small in absolute terms
      // too; "away" here is the outer 2% of the disc.
      if (dist < Math.PI / 2 - 0.2) worstNearLimb = Math.max(worstNearLimb, ground);
      tested++;
    }
  }
  console.log(
    `camera.unproject vs d3.geoOrthographic.invert: ${tested} points, ` +
      `worst ${worstPx.toExponential(1)} px round trip, ` +
      `${worstGround.toFixed(1)} m on the ground at the limb, ` +
      `${worstNearLimb.toExponential(1)} m clear of it ` +
      `(${rejected} behind the horizon, skipped)`
  );
  if (!(worstPx < 1e-6)) fail(`the inverse does not round-trip: ${worstPx} px`);
  if (!(worstNearLimb < 0.01)) fail(`the inverse disagrees with d3 by ${worstNearLimb} m`);
}

// ------------------------------------------------------------- the unit index

const topo = readJson("na-counties-topo.json");
const features = feature(topo, topo.objects.counties).features;
const units = features.map((f) => ({
  id: f.id,
  name: f.properties?.name ?? f.id,
  polygons: f.geometry.type === "Polygon" ? [f.geometry.coordinates] : f.geometry.coordinates,
}));

console.time("index build");
const index = createUnitIndex(units);
console.timeEnd("index build");
console.log(
  `  ${index.stats.units} units, ${index.stats.polygons} polygons, ` +
    `${index.stats.entries.toLocaleString()} grid entries over ${index.stats.cells.toLocaleString()} cells`
);

// ------------------------------------------------- 2. the index vs brute force

// The same containment test with no grid and no early exit: every polygon of
// every unit, latest unit wins. Deliberately the slow, obvious version.
function bruteAt(lon, lat) {
  let best = -1;
  units.forEach((unit, u) => {
    if (u <= best) return;
    for (const poly of unit.polygons) {
      // Match the index's frames: a ring is tested in whichever longitude frame
      // it unwrapped into, so the query is offered all three.
      for (const shift of [0, 360, -360]) {
        const x = lon + shift;
        if (!planarContains(poly, x, lat)) continue;
        best = u;
        return;
      }
    }
  });
  return best;
}

function planarContains(poly, x, y) {
  const ring = (r) => {
    // Unwrap as we walk, exactly as the index does.
    const lons = [r[0][0]];
    for (let i = 1; i < r.length; i++) {
      let d = r[i][0] - r[i - 1][0];
      if (d > 180) d -= 360;
      else if (d < -180) d += 360;
      lons.push(lons[i - 1] + d);
    }
    let inside = false;
    for (let i = 0, j = r.length - 1; i < r.length; j = i++) {
      const xi = lons[i];
      const yi = r[i][1];
      const xj = lons[j];
      const yj = r[j][1];
      if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  };
  if (!ring(poly[0])) return false;
  for (let h = 1; h < poly.length; h++) if (ring(poly[h])) return false;
  return true;
}

{
  // Points drawn from the units themselves — ring vertices nudged inward, and
  // bbox samples — so the sweep lands on real territory and real edges instead
  // of mostly open ocean.
  const rand = rng(77);
  const probes = [];
  for (let i = 0; i < 3000; i++) {
    const unit = units[Math.floor(rand() * units.length)];
    const poly = unit.polygons[Math.floor(rand() * unit.polygons.length)];
    const ring = poly[0];
    const a = ring[Math.floor(rand() * ring.length)];
    const b = ring[Math.floor(rand() * ring.length)];
    probes.push([a[0] + (b[0] - a[0]) * rand(), a[1] + (b[1] - a[1]) * rand()]);
  }
  // And the antimeridian specifically: the Aleutians are the one place the
  // three-frame lookup has to work, and a uniform sample would never go there.
  for (let i = 0; i < 500; i++) probes.push([172 + rand() * 16, 51 + rand() * 5]);
  for (let i = 0; i < 500; i++) probes.push([-180 + rand() * 8, 51 + rand() * 5]);

  let disagree = 0;
  let hits = 0;
  for (const [lon, lat] of probes) {
    const got = index.at(lon, lat);
    const want = bruteAt(lon, lat);
    if (got !== want) {
      if (disagree < 5)
        console.error(
          `  at ${lon.toFixed(4)},${lat.toFixed(4)}: index says ` +
            `${got < 0 ? "none" : units[got].id}, brute force ${want < 0 ? "none" : units[want].id}`
        );
      disagree++;
    }
    if (got >= 0) hits++;
  }
  console.log(
    `index vs brute force: ${probes.length} probes, ${hits} on a unit, ${disagree} disagreements`
  );
  if (disagree) fail(`${disagree} probes disagree with brute force`);
}

// -------------------------------------------- 3. planar vs spherical containment

// Metres from a point to the nearest polygon edge. Local equirectangular: at
// county scale the metric is flat to far better than the metres this is
// measuring.
function edgeDistanceM(polygons, [px, py]) {
  const kx = 111320 * Math.cos((py * Math.PI) / 180);
  const ky = 110540;
  let best = Infinity;
  for (const poly of polygons) {
    for (const ring of poly) {
      for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const ax = (ring[j][0] - px) * kx;
        const ay = (ring[j][1] - py) * ky;
        const bx = (ring[i][0] - px) * kx;
        const by = (ring[i][1] - py) * ky;
        const dx = bx - ax;
        const dy = by - ay;
        const len2 = dx * dx + dy * dy;
        const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
        best = Math.min(best, Math.hypot(ax + dx * t, ay + dy * t));
      }
    }
  }
  return best;
}

{
  // The index tests lon/lat as a plane; d3.geoContains treats every edge as a
  // great circle. At this data density the two differ only within a sliver of
  // the boundary, and this puts a number on "sliver".
  //
  // Sampling matters here in a way it did not above. These rings are heavily
  // generalized — a whole county is often 14 vertices — so "a point on the
  // chord between two ring vertices" lands exactly ON an edge about one time in
  // seven, and on an edge the two tests are a coin toss by construction. That
  // measures the sampler, not the index. Uniform points in a unit's bounding
  // box put the boundary back where it belongs, at measure zero.
  const rand = rng(4242);
  let checked = 0;
  let differ = 0;
  let worstM = 0;
  for (let i = 0; i < 20000; i++) {
    const seed = Math.floor(rand() * units.length);
    const [[x0, y0], [x1, y1]] = d3.geoBounds(features[seed].geometry);
    const pt = [x0 + (x1 - x0) * rand(), y0 + (y1 - y0) * rand()];
    // Only the direction that matters: where the index names a unit, does the
    // spherical test put the point in that same unit? (The other direction
    // would mean sweeping all 3504 units through d3.geoContains per point.)
    const u = index.at(pt[0], pt[1]);
    if (u < 0) continue;
    checked++;
    if (d3.geoContains(features[u].geometry, pt)) continue;
    differ++;
    // A disagreement far from that unit's own outline would be a real bug; one
    // on the line is the two tests reading the same edge differently. Distance
    // to the nearest EDGE, not the nearest vertex — at 14 vertices a county,
    // those are different questions by tens of kilometres.
    worstM = Math.max(worstM, edgeDistanceM(units[u].polygons, pt));
  }
  console.log(
    `planar vs d3.geoContains: ${checked} points the index placed, ${differ} the sphere disputes ` +
      `(${((differ / checked) * 100).toFixed(3)}%), furthest from that unit's outline ${worstM.toFixed(1)} m`
  );
  if (differ / checked > 0.005) fail(`${differ} of ${checked} placements disagree with the sphere`);
  // A generalized edge spans up to ~30 km here, and a great circle departs from
  // the straight lon/lat line across one by about ten metres at mid latitudes.
  // Anything much past that is not the two tests reading an edge differently.
  if (worstM > 200) fail(`a disputed point sits ${worstM.toFixed(0)} m inside its unit`);
}

// --------------------------------------------------------------------- timing

{
  const rand = rng(9);
  const pts = [];
  for (let i = 0; i < 20000; i++) {
    const unit = units[Math.floor(rand() * units.length)];
    const v = unit.polygons[0][0][0];
    pts.push([v[0] + rand() * 0.2 - 0.1, v[1] + rand() * 0.2 - 0.1]);
  }
  for (const [lon, lat] of pts.slice(0, 2000)) index.at(lon, lat); // warm
  const t0 = performance.now();
  for (const [lon, lat] of pts) index.at(lon, lat);
  const us = ((performance.now() - t0) / pts.length) * 1000;
  console.log(`pick cost: ${us.toFixed(2)} us per query`);
  // A pointer move must be able to run this every frame without thinking about
  // it; that is the whole reason picking stops pausing during gestures.
  if (us > 50) fail(`${us.toFixed(1)} us per pick is too slow to run per pointer move`);
}

console.log(failures ? `\n${failures} CHECK(S) FAILED` : "\nall picker checks passed");
process.exit(failures ? 1 : 0);
