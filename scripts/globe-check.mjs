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
  // Keep in step with the spin preview in src/main.js: one merged, thinned
  // outline per state, which is what lets a drag keep the map's colors.
  const STEP = 8;
  const MIN_DEG = 0.25;
  const ringSpan = (ring) => {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [x, y] of ring) {
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
    return Math.max(x1 - x0, y1 - y0);
  };
  const inverted = (ring) => d3geo.geoArea({ type: "Polygon", coordinates: [ring] }) > 2 * Math.PI;
  const thin = (ring) => {
    if (ring.length <= STEP + 2) return ring;
    const out = [];
    for (let i = 0; i < ring.length; i += STEP) out.push(ring[i]);
    if (out[out.length - 1] !== ring[ring.length - 1]) out.push(ring[ring.length - 1]);
    return out.length >= 4 && inverted(out) === inverted(ring) ? out : ring;
  };
  const coarsen = (geometry) => {
    const polys = geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates;
    const coarsePoly = (rings) =>
      [rings[0], ...rings.slice(1).filter((r) => ringSpan(r) >= MIN_DEG)].map(thin);
    const kept = [];
    for (const rings of polys) if (ringSpan(rings[0]) >= MIN_DEG) kept.push(coarsePoly(rings));
    if (!kept.length && polys.length)
      kept.push(coarsePoly(polys.reduce((a, b) => (ringSpan(b[0]) > ringSpan(a[0]) ? b : a))));
    return { type: "MultiPolygon", coordinates: kept };
  };

  // The app groups by `assign`, which starts as each unit's own state.
  const groups = new Map();
  for (const g of topo.objects.counties.geometries) {
    const sid = g.properties.st;
    if (!groups.has(sid)) groups.set(sid, []);
    groups.get(sid).push(g);
  }
  const shapes = [...groups].map(([sid, gs]) => ({ sid, geometry: coarsen(merge(topo, gs)) }));

  const countVerts = (g) => {
    let n = 0;
    for (const rings of g.coordinates) for (const r of rings) n += r.length;
    return n;
  };
  const full = countVerts(nation.type === "Polygon" ? { coordinates: [nation.coordinates] } : nation);
  const cut = shapes.reduce((n, s) => n + countVerts(s.geometry), 0);
  check(
    cut < full / 2,
    `spin outlines are much lighter than the full land (${cut.toLocaleString()} vs ${full.toLocaleString()} points, ${shapes.length} states)`
  );
  // Every state has to draw. A state whose shapes all fell to the speck filter
  // would leave a hole in the land where it belongs — DC is the one that
  // actually tests this, at 0.15 degrees across.
  const missing = shapes.filter((s) => !s.geometry.coordinates.length).map((s) => s.sid);
  check(missing.length === 0, `every state still draws in the preview (missing: ${missing.join(" ") || "none"})`);
  check(
    shapes.every((s) => s.geometry.coordinates.every((rings) => rings.every((r) => r.length >= 4))),
    "no spin ring was thinned below four points"
  );
  // A ring that thinning turned inside out means everything-but-the-ring, and
  // clipped to the hemisphere it paints the whole globe in one state's color.
  check(
    shapes.every((s) => s.geometry.coordinates.every((rings) => !inverted(rings[0]))),
    "no spin ring turns inside out"
  );

  // And they must re-project inside a frame, since a drag re-bakes them on
  // every animation frame. It measures about 4 ms; the budget leaves room for
  // a slower machine but would still catch the outlines growing back.
  const project = (rotate) => {
    const trace = makeTracer(mainProjection(rotate));
    for (const s of shapes) {
      const polys = s.geometry.coordinates;
      for (const rings of polys) trace({ type: "Polygon", coordinates: rings });
    }
  };
  project(HOME_ROTATION);
  const t0 = performance.now();
  const N = 10;
  for (let i = 0; i < N; i++) project([96 + i, -45]);
  const per = (performance.now() - t0) / N;
  check(per < 12, `spin outlines re-project in ${per.toFixed(1)} ms per frame`);
}

// ------------------------------------ 5. the scenery land is drawable and cheap
// world-land.json is Natural Earth's land minus the countries the map draws
// itself, plus its lakes and the two line meshes — coastlines and country
// borders — the build cuts from the same arcs. It is background, but it is
// projected through the same globe as everything else, so it faces the same
// hazards: a country that straddles the antimeridian (Russia, Fiji), one that
// reaches the pole (Antarctica), and the horizon clip at every facing.
{
  const world = read("world-land.json");
  const land = feature(world, world.objects.land).features;
  // The lakes go out in tiers the renderer fades in with the zoom, and the
  // rivers do too. Which tier a lake is in is a question for layer-check; here
  // they are one pile of water to project, so the tiers are read off the file
  // rather than named, and a tier added or renamed cannot slip past this check.
  const lakeTiers = Object.keys(world.objects).filter((n) => /^lakes\d+$/.test(n));
  if (!lakeTiers.length) bad("world-land.json carries no lake tiers");
  const lakes = lakeTiers.flatMap((n) => feature(world, world.objects[n]).features);
  const riverTiers = Object.keys(world.objects).filter((n) => /^rivers\d+$/.test(n));
  if (!riverTiers.length) bad("world-land.json carries no river tiers");
  const rivers = riverTiers.map((n) => feature(world, world.objects[n]).geometry);
  const coast = feature(world, world.objects.coast).geometry;
  const borders = feature(world, world.objects.borders).geometry;
  const DISC_AREA = Math.PI * RADIUS ** 2;
  const ringArea = (ring) => {
    let twice = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
      twice += ring[j][0] * ring[i][1] - ring[i][0] * ring[j][1];
    }
    return Math.abs(twice) / 2;
  };

  check(land.length > 150, `${land.length} countries of scenery land`);
  check(
    !land.some((f) => ["USA", "CAN", "MEX"].includes(f.id)),
    "the countries the map draws itself are left out"
  );
  for (const id of ["RUS", "ATA", "GRL", "AUS", "BRA", "CHN", "FJI"]) {
    if (!land.some((f) => f.id === id)) bad(`scenery land is missing ${id}`);
  }
  // The scenery wears the map's own furniture, so all four pieces have to be
  // there — a missing mesh is a world with no coastline or no country lines,
  // which reads as the old flat tan rather than as an error.
  check(coast.coordinates.length > 1000, `${coast.coordinates.length} scenery coastlines`);
  check(borders.coordinates.length > 100, `${borders.coordinates.length} scenery country lines`);
  check(lakes.length > 100, `${lakes.length} scenery lakes in ${lakeTiers.length} tiers`);
  const riverLines = rivers.reduce((n, g) => n + g.coordinates.length, 0);
  check(riverLines > 1000, `${riverLines} river lines in ${riverTiers.length} tiers`);
  // Every lake Natural Earth cuts out of the land has to be drawn back in, or
  // the continent shows a bare hole where the water belongs. The cut-out ones
  // are the big ones, so a floor well above them is the check that matters.
  const R_KM = 6371;
  const biggestLake = Math.max(...lakes.map((f) => d3geo.geoArea(f) * R_KM ** 2));
  check(biggestLake > 60000, `the largest scenery lake is ${Math.round(biggestLake)} km²`);
  // The Panama seam is the one stretch where the scenery meets the map on
  // land. It belongs to neither mesh: the map draws its own border there, and
  // a second line a few km off it would read as a doubled border.
  const nearPanama = (p) => p[0] > -78.1 && p[0] < -77.1 && p[1] > 7 && p[1] < 8.8;
  const seamLines = coast.coordinates.filter((l) => l.every(nearPanama)).length;
  check(seamLines === 0, "the Panama seam is left out of the scenery's coastline");
  // Natural Earth's own seam, where it cuts Russia and Fiji in half. Drawn, it
  // is a straight blue line down the middle of the Chukotka Peninsula.
  const onAnti = (p) => Math.abs(Math.abs(p[0]) - 180) < 0.01;
  const antiSegments = coast.coordinates.reduce(
    (n, l) => n + l.filter((p, i) => i > 0 && onAnti(p) && onAnti(l[i - 1])).length,
    0
  );
  check(antiSegments === 0, "the antimeridian cut is left out of the scenery's coastline");

  // Everything the bake projects, in the order it projects it. The lines go
  // through the same tracer the shapes do, so a mesh that clipped badly at
  // some facing would show up here exactly as a bad ring would.
  const everything = [
    ...land,
    ...lakes,
    { geometry: coast },
    { geometry: borders },
    ...rivers.map((geometry) => ({ geometry })),
  ];

  let worstShare = 0;
  let worstAt = "";
  for (const [name, rot] of [
    ["home", HOME_ROTATION],
    ["turned to the Atlantic", [30, -40]],
    ["facing Asia", [-100, -20]],
    ["over the pole", [96, -85]],
    ["over the south pole", [96, 85]],
  ]) {
    const trace = makeTracer(mainProjection(rot));
    let nonFinite = 0;
    let outside = 0;
    let pts = 0;
    for (const f of everything) {
      const closed = f.geometry.type.endsWith("Polygon");
      for (const ring of trace(f.geometry)) {
        if (ring.length < (closed ? 3 : 2)) continue;
        for (const p of ring) {
          pts++;
          if (!Number.isFinite(p[0]) || !Number.isFinite(p[1])) nonFinite++;
          else if (!inDisc(p)) outside++;
        }
        // A ring the projection turned inside out covers the hemisphere rather
        // than the country. Nothing here is a quarter of the visible disc:
        // Asia, the largest landmass, is about a sixth of it face-on.
        if (!closed) continue;
        const share = ringArea(ring) / DISC_AREA;
        if (share > worstShare) (worstShare = share), (worstAt = `${f.id ?? f.properties?.name} at [${rot}]`);
      }
    }
    const label = `scenery ${name} [${rot}]`;
    check(nonFinite === 0, `${label}: every projected coordinate is finite (${pts.toLocaleString()} points)`);
    check(outside === 0, `${label}: nothing projects outside the sphere's disc`);
  }
  check(worstShare < 0.25, `no scenery ring floods the disc (biggest is ${(100 * worstShare).toFixed(1)}%, ${worstAt})`);

  // It is re-projected with everything else on every settle, so its share of
  // that ~130 ms bake has to stay small. The coast and border meshes roughly
  // double what there is to project: they retrace the same edges the land
  // rings do, once as lines.
  //
  // What is timed is what bakeMain() in main.js actually re-projects, which is
  // the first lake tier and the first river tier and none of the finer ones:
  // the flat map draws those two, and the rest belong to the globe, which bakes
  // its geometry once at build time and re-projects nothing per frame. Timing
  // every tier here would budget the flat map for work it never does. The
  // passes above still walk them all — a line that projected badly would be
  // just as wrong on the globe, and it costs nothing to look.
  const firstLakes = feature(world, world.objects[lakeTiers[0]]).features;
  const firstLakeEdges = feature(world, world.objects[lakeTiers[0].replace(/^lakes/, "lakeEdges")]).geometry;
  const baked = [
    ...land,
    ...firstLakes,
    { geometry: coast },
    { geometry: borders },
    { geometry: firstLakeEdges },
    { geometry: rivers[0] },
  ];
  const trace = makeTracer(mainProjection(HOME_ROTATION));
  for (const f of baked) trace(f.geometry);
  const t0 = performance.now();
  const N = 5;
  for (let i = 0; i < N; i++) {
    const t = makeTracer(mainProjection([96 + i, -45]));
    for (const f of baked) t(f.geometry);
  }
  const per = (performance.now() - t0) / N;
  // 60 ms was the budget when the scenery was land, coast, borders and the
  // lakes above a 1,000 km² floor. Dropping that floor and adding the rivers
  // put it at about 61: land 22, the first lake tier and its shore 15, the
  // coast 7, the borders 2, the first river tier 4. This is a guard against
  // runaway growth rather than a claim that the cost is small — it is already
  // about half the bake — so it sits a little above what the scenery costs
  // today. Anything that pushes it past this wants the bake made cheaper, not
  // the number raised: the first lake tier is projected twice, once as water
  // and once as shore, which is where the next saving is.
  check(per < 75, `the scenery re-projects in ${per.toFixed(1)} ms per bake`);
}

console.log(failed ? `\n${failed} check(s) failed` : "\nall checks passed");
process.exit(failed ? 1 : 0);
