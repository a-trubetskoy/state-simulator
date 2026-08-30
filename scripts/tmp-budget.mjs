// Splits the scenery re-projection cost between the land/meshes and the lakes,
// and shows what thinning the lakes at a few tolerances would cost them.
import { readFileSync } from "node:fs";
import * as d3geo from "d3-geo";
import { feature, quantize } from "topojson-client";
import { topology } from "topojson-server";
import { presimplify, sphericalTriangleArea } from "topojson-simplify";
import { geoArea } from "d3-geo";
import { simplifyArcs } from "./geo-lib.mjs";

const R = 6371;
const topo = JSON.parse(readFileSync("./public/data/world-land.json", "utf8"));
const land = feature(topo, topo.objects.land).features;
const lakes = feature(topo, topo.objects.lakes).features;
const coast = feature(topo, topo.objects.coast);
const borders = feature(topo, topo.objects.borders);

const HOME = [96, -45];
const BOX = [975, 610];
const conus = { type: "FeatureCollection", features: land };
const FIT = d3geo.geoOrthographic().rotate(HOME).fitSize(BOX, conus);
const projFor = (rot) =>
  d3geo.geoOrthographic().rotate(rot).scale(FIT.scale()).translate(FIT.translate());

const trace = (proj, feats) => {
  const path = d3geo.geoPath(proj);
  let n = 0;
  for (const f of feats) n += (path(f.geometry) ?? "").length;
  return n;
};

const time = (feats, label) => {
  trace(projFor(HOME), feats);
  const t0 = performance.now();
  const N = 5;
  for (let i = 0; i < N; i++) trace(projFor([96 + i, -45]), feats);
  const per = (performance.now() - t0) / N;
  console.log(`  ${label.padEnd(22)} ${per.toFixed(1)} ms`);
  return per;
};

const pts = (feats) => {
  let n = 0;
  for (const f of feats) {
    const g = f.geometry;
    const parts =
      g.type === "MultiPolygon" ? g.coordinates.flat()
      : g.type === "Polygon" ? g.coordinates
      : g.type === "MultiLineString" ? g.coordinates
      : [g.coordinates];
    for (const r of parts) n += r.length;
  }
  return n;
};

console.log("scenery re-projection, current file:");
time(land, `land (${pts(land)} pts)`);
time([coast, borders], `coast+borders`);
time(lakes, `lakes (${pts(lakes)} pts)`);
time([...land, ...lakes, coast, borders], "everything");

// What thinning the lakes would leave. Rebuilt standalone, which is enough to
// count points; the shipped file shares arcs with the land holes.
console.log("\nlakes thinned on their own:");
const raw = topology({ lakes: { type: "FeatureCollection", features: lakes } });
const pre = presimplify(raw, sphericalTriangleArea);
for (const metres of [0, 300, 600, 1200, 2500, 6000]) {
  const w = metres === 0 ? 0 : (metres / 1000) ** 2 / 2 / R ** 2;
  const { topo: thin } = simplifyArcs(pre, w);
  const q = quantize(thin, 1e5);
  const feats = feature(q, q.objects.lakes).features;
  const area = feats.reduce((a, f) => a + geoArea(f.geometry) * R * R, 0);
  const gone = feats.filter((f) => geoArea(f.geometry) * R * R <= 0.001).length;
  process.stdout.write(
    `  ${String(metres).padStart(4)} m: ${String(pts(feats)).padStart(7)} pts, ` +
      `total area ${Math.round(area).toLocaleString()} km², ${gone} with no area — `
  );
  time(feats, "");
}
