// Browserless checks of the globe's projection, the way split-check.mjs does
// for carving. Two things matter and neither needs a browser:
//
//   1. The atlas view must be untouched. The map used to be projected by
//      geoOrthographic().rotate(HOME).fitSize(box, conus); it is now projected
//      by a rotation-parameterised builder that freezes that fit's scale and
//      translate. Those two have to agree to the last bit at the home facing,
//      or every baked coordinate in the app moved.
//   2. Turning the globe has to keep producing drawable geometry: rings that
//      still close, coordinates that stay finite, the far hemisphere clipped
//      away rather than folded onto the near one.
//
// Run: node scripts/globe-check.mjs
import { readFileSync } from "node:fs";
import * as d3geo from "d3-geo";
import { feature, merge } from "topojson-client";

const DATA = new URL("../public/data/", import.meta.url);
const read = (name) => JSON.parse(readFileSync(new URL(name, DATA), "utf8"));
const topo = read("na-counties-topo.json");
const data = read("na-county-data.json");
const counties = feature(topo, topo.objects.counties).features;

let failed = 0;
const ok = (msg) => console.log(`ok   ${msg}`);
const bad = (msg) => {
  failed++;
  console.log(`FAIL ${msg}`);
};
const check = (cond, msg) => (cond ? ok(msg) : bad(msg));

// ---------------------------------------------------------------- the setup
// Mirrors main.js: the lower 48 are what the box is fitted to.
const FOREIGN = new Set(data.foreign ?? []);
const conusFeatures = counties.filter(
  (f) => !FOREIGN.has(f.properties.st) && f.properties.st !== "02" && f.properties.st !== "15"
);
const HOME_ROTATION = [96, -45];
const BOX = [975, 610];

const HOME_FIT = d3geo
  .geoOrthographic()
  .rotate(HOME_ROTATION)
  .fitSize(BOX, { type: "FeatureCollection", features: conusFeatures });
const GLOBE_SCALE = HOME_FIT.scale();
const GLOBE_TRANSLATE = HOME_FIT.translate();
const mainProjection = (rotate) =>
  d3geo.geoOrthographic().rotate(rotate).scale(GLOBE_SCALE).translate(GLOBE_TRANSLATE);

const makeTracer = (projection) => {
  const recorded = [];
  let line = null;
  const trace = d3geo.geoPath(projection, {
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

// ------------------------------------------- 1. the home facing is unchanged
{
  const before = makeTracer(HOME_FIT);
  const after = makeTracer(mainProjection(HOME_ROTATION));
  let compared = 0;
  let mismatch = 0;
  for (const f of counties) {
    const a = before(f.geometry);
    const b = after(f.geometry);
    if (a.length !== b.length) {
      mismatch++;
      continue;
    }
    for (let i = 0; i < a.length; i++) {
      if (a[i].length !== b[i].length) {
        mismatch++;
        break;
      }
      for (let j = 0; j < a[i].length; j++) {
        compared += 2;
        if (a[i][j][0] !== b[i][j][0] || a[i][j][1] !== b[i][j][1]) mismatch++;
      }
    }
  }
  check(
    mismatch === 0 && compared > 100000,
    `home facing bit-identical to the old fitSize projection (${compared.toLocaleString()} coordinates, ${mismatch} differ)`
  );
  // The frozen pair is what makes that true, so state it directly too.
  const refit = d3geo
    .geoOrthographic()
    .rotate(HOME_ROTATION)
    .fitSize(BOX, { type: "FeatureCollection", features: conusFeatures });
  check(
    refit.scale() === GLOBE_SCALE &&
      refit.translate()[0] === GLOBE_TRANSLATE[0] &&
      refit.translate()[1] === GLOBE_TRANSLATE[1],
    "frozen scale/translate equal the fit they were taken from"
  );
}

// ------------------------------------- 2. the lower 48 still fill the design box
{
  const trace = makeTracer(mainProjection(HOME_ROTATION));
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const f of conusFeatures)
    for (const ring of trace(f.geometry))
      for (const [x, y] of ring) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
  const w = x1 - x0;
  const h = y1 - y0;
  // fitSize scales until one axis fills the box exactly and centres the other.
  const fills = Math.abs(w - BOX[0]) < 0.01 || Math.abs(h - BOX[1]) < 0.01;
  check(fills, `lower 48 fill the 975x610 box (${w.toFixed(1)} x ${h.toFixed(1)})`);
  check(
    x0 >= -0.01 && y0 >= -0.01 && x1 <= BOX[0] + 0.01 && y1 <= BOX[1] + 0.01,
    "lower 48 sit inside the box"
  );
}

// -------------------------------------------- 3. turning the globe stays sane
const RADIUS = GLOBE_SCALE;
const inDisc = ([x, y]) =>
  Math.hypot(x - GLOBE_TRANSLATE[0], y - GLOBE_TRANSLATE[1]) <= RADIUS + 0.5;

for (const [name, rot] of [
  ["home", HOME_ROTATION],
  ["turned 60 west", [156, -45]],
  ["turned to the Atlantic", [30, -40]],
  ["over the pole", [96, -85]],
  ["antipodal (North America behind the globe)", [-84, 45]],
]) {
  const trace = makeTracer(mainProjection(rot));
  let rings = 0;
  let pts = 0;
  let nonFinite = 0;
  let outside = 0;
  for (const f of counties) {
    for (const ring of trace(f.geometry)) {
      // Rings under three points are dropped by projectParts, exactly as
      // here, so they are not a defect — clipping a polygon at the horizon
      // legitimately emits stubs. Count what the app would actually keep.
      if (ring.length < 3) continue;
      rings++;
      for (const p of ring) {
        pts++;
        if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) nonFinite++;
        else if (!inDisc(p)) outside++;
      }
    }
  }
  const label = `${name} [${rot}]`;
  if (rot[0] === -84) {
    // The far hemisphere must be clipped away, not folded onto the near one.
    check(pts === 0, `${label}: North America is clipped away entirely (${pts} points)`);
    continue;
  }
  check(nonFinite === 0, `${label}: every projected coordinate is finite (${pts.toLocaleString()} points)`);
  check(outside === 0, `${label}: nothing projects outside the sphere's disc`);
  check(rings > 1000, `${label}: ${rings.toLocaleString()} drawable rings survive the horizon clip`);
}

// ---------------------------- 4. the spin preview is cheap but still drawable
{
  const nation = merge(topo, topo.objects.counties.geometries);
  // Keep in step with SPIN_LAND in src/main.js.
  const STEP = 8;
  const MIN_DEG = 0.25;
  const spans = (ring) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return Math.max(x1 - x0, y1 - y0) >= MIN_DEG;
  };
  const thin = (ring) => {
    if (ring.length <= STEP + 2) return ring;
    const out = [];
    for (let i = 0; i < ring.length; i += STEP) out.push(ring[i]);
    if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
    return out.length >= 4 ? out : ring;
  };
  const polys = nation.type === "Polygon" ? [nation.coordinates] : nation.coordinates;
  const kept = [];
  for (const rings of polys) {
    if (!spans(rings[0])) continue;
    kept.push([rings[0], ...rings.slice(1).filter(spans)].map(thin));
  }
  const spin = { type: "MultiPolygon", coordinates: kept };

  const countVerts = (g) => {
    let n = 0;
    for (const rings of g.coordinates) for (const r of rings) n += r.length;
    return n;
  };
  const full = countVerts(nation.type === "Polygon" ? { coordinates: [nation.coordinates] } : nation);
  const cut = countVerts(spin);
  check(cut < full / 2, `spin silhouette is much lighter than the full land (${cut.toLocaleString()} vs ${full.toLocaleString()} points)`);
  check(
    spin.coordinates.every((rings) => rings.every((r) => r.length >= 4)),
    "no spin ring was thinned below four points"
  );

  // And it must re-project inside a frame, since a drag re-bakes it on every
  // pointermove. It measures about 4 ms; the budget leaves room for a slower
  // machine but would still catch the silhouette growing back.
  const trace = makeTracer(mainProjection(HOME_ROTATION));
  trace(spin);
  const t0 = performance.now();
  const N = 10;
  for (let i = 0; i < N; i++) makeTracer(mainProjection([96 + i, -45]))(spin);
  const per = (performance.now() - t0) / N;
  check(per < 12, `spin silhouette re-projects in ${per.toFixed(1)} ms per frame`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
