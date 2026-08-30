// C0 spike — geometry compiler (THROWAWAY).
//
// Turns the shipped JSON into one binary buffer of line segments on the unit
// sphere, so the spike page can answer the only question C0 asks: does a
// mat3-rotated, GPU-drawn hairline stack hold 60fps at max zoom?
//
// This is deliberately not C1. It emits lines only (no fills, no ribbons, no
// unit ids), it does not care about draw order, and it is meant to be deleted.
// What it does establish, and what C1 should reuse, is the lon/lat -> unit
// sphere convention and the d3-parity rotation matrix at the bottom.
//
//   node spike/build-geometry.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as d3 from "d3-geo";
import { feature } from "topojson-client";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DATA = path.join(ROOT, "public", "data");
const OUT = path.join(ROOT, "public", "spike-data");

const readJson = (f) => JSON.parse(fs.readFileSync(path.join(DATA, f), "utf8"));

// ------------------------------------------------------------------ geometry

const RAD = Math.PI / 180;
// One chord may sag no more than half a pixel from its arc. Sag is L^2/8R, so
// at the spike's worst case (zoom 16, ~295 m/px) the limit is ~120 km. Only the
// graticule and a few long straight runs are ever this coarse; county arcs and
// the 6 km world data are far denser and pass through untouched.
const MAX_EDGE_RAD = 120 / 6371;

// Right-handed, z through the north pole, x through (0N, 0E). d3's orthographic
// looks down +x, which is why the projection below reads (y, -z).
function toXyz(lon, lat) {
  const p = lat * RAD;
  const l = lon * RAD;
  const c = Math.cos(p);
  return [c * Math.cos(l), c * Math.sin(l), Math.sin(p)];
}

// Great-circle interpolation, so a subdivided edge lands ON the sphere rather
// than on the chord under it.
function slerp(a, b, t, omega, sinOmega) {
  const wa = Math.sin((1 - t) * omega) / sinOmega;
  const wb = Math.sin(t * omega) / sinOmega;
  return [a[0] * wa + b[0] * wb, a[1] * wa + b[1] * wb, a[2] * wa + b[2] * wb];
}

// Every line source funnels through here: lon/lat polyline in, segment
// endpoints on the unit sphere out, subdivided where an edge is too long to
// pass for a great circle.
function pushPolyline(line, starts, ends, stats) {
  let prev = null;
  for (const [lon, lat] of line) {
    const cur = toXyz(lon, lat);
    if (prev) {
      const dot = Math.min(1, Math.max(-1, prev[0] * cur[0] + prev[1] * cur[1] + prev[2] * cur[2]));
      const omega = Math.acos(dot);
      const n = omega > MAX_EDGE_RAD ? Math.ceil(omega / MAX_EDGE_RAD) : 1;
      if (n === 1) {
        starts.push(prev[0], prev[1], prev[2]);
        ends.push(cur[0], cur[1], cur[2]);
      } else {
        const sinOmega = Math.sin(omega);
        stats.subdivided++;
        let a = prev;
        for (let i = 1; i <= n; i++) {
          const b = i === n ? cur : slerp(prev, cur, i / n, omega, sinOmega);
          starts.push(a[0], a[1], a[2]);
          ends.push(b[0], b[1], b[2]);
          a = b;
        }
        stats.extra += n - 1;
      }
    }
    prev = cur;
  }
}

// ------------------------------------------------------------------- sources

// topojson delta-decoding. topojson-client only hands back whole geometries;
// the arcs themselves are what we want, because a shared county boundary is one
// arc and drawing it once instead of once per neighbour halves the work.
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

const ringsOf = (geometry) => {
  if (!geometry) return [];
  if (geometry.type === "Polygon") return geometry.coordinates;
  if (geometry.type === "MultiPolygon") return geometry.coordinates.flat();
  if (geometry.type === "LineString") return [geometry.coordinates];
  if (geometry.type === "MultiLineString") return geometry.coordinates;
  return [];
};

console.log("reading source data...");
const countiesTopo = readJson("na-counties-topo.json");
const overlays = readJson("na-map-overlays.json");
const worldTopo = readJson("world-land.json");

// The groups the spike can toggle independently, so a "no" can be traced to a
// layer rather than to the stack as a whole.
const sources = [
  {
    name: "counties",
    label: "county hairlines",
    lines: () => decodeArcs(countiesTopo),
  },
  {
    name: "boundary",
    label: "coast + lakeshore + border runs",
    // Region "main" only. The AK/HI runs are inset duplicates, and the insets
    // keep the current CPU path (they never turn).
    lines: () => overlays.boundary.filter((b) => b.region === "main").map((b) => b.line),
  },
  {
    name: "world",
    label: "world coast, borders, lakes",
    lines: () => [
      ...ringsOf(feature(worldTopo, worldTopo.objects.coast).geometry),
      ...ringsOf(feature(worldTopo, worldTopo.objects.borders).geometry),
      ...feature(worldTopo, worldTopo.objects.lakes).features.flatMap((f) => ringsOf(f.geometry)),
    ],
  },
  {
    name: "graticule",
    label: "graticule",
    // The one source that genuinely needs the subdivision above: d3 emits
    // meridians at 2.5-degree steps, ~280 km near the equator.
    lines: () => ringsOf(d3.geoGraticule10()),
  },
];

const starts = [];
const ends = [];
const groups = [];

for (const src of sources) {
  const stats = { subdivided: 0, extra: 0 };
  const first = starts.length / 3;
  const lines = src.lines();
  for (const line of lines) pushPolyline(line, starts, ends, stats);
  const count = starts.length / 3 - first;
  groups.push({ name: src.name, label: src.label, first, count });
  console.log(
    `  ${src.name.padEnd(10)} ${String(lines.length).padStart(6)} lines  ` +
      `${String(count).padStart(7)} segments` +
      (stats.extra ? `  (+${stats.extra} from ${stats.subdivided} long edges)` : "")
  );
}

// -------------------------------------------------------------------- camera

// Reproduced from src/main.js so the spike measures the real view, not a
// plausible one: the same sphere radius in the same 975x610 design box, fitted
// once at the home rotation to the lower 48.
const counties = feature(countiesTopo, countiesTopo.objects.counties).features;
const isForeign = (id) => !/^\d/.test(id);
const conus = counties.filter(
  (f) => !isForeign(f.id) && f.properties.st !== "02" && f.properties.st !== "15"
);
const HOME_ROTATION = [96, -45];
const HOME_FIT = d3
  .geoOrthographic()
  .rotate(HOME_ROTATION)
  .fitSize([975, 610], { type: "FeatureCollection", features: conus });

// --------------------------------------------------------------- rotation R

// d3.geoRotation as a 3x3, which is the whole point of the rewrite: this
// becomes a uniform and the CPU stops touching vertices.
//
// d3 composes rotate([l, p, g]) as lambda-shift, then a rotation in the xz
// plane, then one in the yz plane. Column-major, ready for uniformMatrix3fv.
function rotationMatrix([lambda, phi, gamma = 0]) {
  const [cl, sl] = [Math.cos(lambda * RAD), Math.sin(lambda * RAD)];
  const [cp, sp] = [Math.cos(phi * RAD), Math.sin(phi * RAD)];
  const [cg, sg] = [Math.cos(gamma * RAD), Math.sin(gamma * RAD)];
  // Rz(lambda): rotate longitudes by +lambda.
  const rz = [[cl, -sl, 0], [sl, cl, 0], [0, 0, 1]];
  // Rxz(phi).
  const rx = [[cp, 0, -sp], [0, 1, 0], [sp, 0, cp]];
  // Ryz(gamma).
  const rg = [[1, 0, 0], [0, cg, -sg], [0, sg, cg]];
  const mul = (a, b) =>
    a.map((row) => b[0].map((_, j) => row.reduce((s, v, k) => s + v * b[k][j], 0)));
  const m = mul(rg, mul(rx, rz));
  const out = [];
  for (let c = 0; c < 3; c++) for (let r = 0; r < 3; r++) out.push(m[r][c]);
  return out;
}

// Parity check. If the matrix and d3 ever disagree the spike is measuring the
// wrong picture, so this is worth failing the build over.
{
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

// --------------------------------------------------------------------- write

const total = starts.length / 3;
const bin = Buffer.alloc(total * 3 * 4 * 2);
Buffer.from(Float32Array.from(starts).buffer).copy(bin, 0);
Buffer.from(Float32Array.from(ends).buffer).copy(bin, total * 3 * 4);

fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, "geometry.bin"), bin);
fs.writeFileSync(
  path.join(OUT, "geometry.json"),
  JSON.stringify(
    {
      segments: total,
      startsOffset: 0,
      endsOffset: total * 3 * 4,
      groups,
      homeRotation: HOME_ROTATION,
      globeScale: HOME_FIT.scale(),
      globeTranslate: HOME_FIT.translate(),
      designBox: [975, 610],
      maxZoom: 16,
    },
    null,
    2
  )
);

console.log(
  `\nwrote public/spike-data/geometry.bin  ${total} segments, ` +
    `${(bin.length / 1048576).toFixed(1)} MB (JSON source was ~5 MB)`
);
console.log(`      globeScale ${HOME_FIT.scale().toFixed(1)} px`);
