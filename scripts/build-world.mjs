// Builds public/data/world-land.json: the land beyond the map's own units —
// South America, Eurasia, Africa, Oceania, Antarctica, Greenland and the
// islands — drawn behind the map wearing the same furniture North America
// does: a coastline with its halo, a hairline between neighbours, and the
// larger lakes in water blue. It is still scenery and nothing else: no unit
// belongs to it, nothing hovers, nothing paints.
//
// Four objects come out, all sharing one set of arcs, so the lines land
// exactly on the edges of the shapes they belong to:
//   land    — the country polygons, filled the same tan a non-union unit wears
//   lakes   — every lake Natural Earth draws except the Great Lakes (the map
//             draws those itself), plus the few lakes only the Census has,
//             over that land in water blue
//   coast   — the outer edge of the land: blue line, blue halo
//   borders — the line between two of those countries: white hairline
//
// Source: Natural Earth 10m admin-0 and 10m lakes (the same two downloads
// build-data.mjs already caches), plus TIGER area hydrography for the water
// Natural Earth files as coastal (CENSUS_LAKES in geo-lib.mjs). Simplified far
// harder than the map is, since it is only ever read at continental zoom.
//
// The countries the map draws itself are left out of `land` rather than
// covered over. The US and Canada come from the Census and StatCan
// cartographic files, whose coastlines disagree with Natural Earth's by a few
// km, so a Natural Earth copy underneath would show as a tan fringe outside
// the drawn shore wherever it ran wider. Dropping those countries outright is
// exact: what is left abuts the map's units along Natural Earth's own
// edge-matched borders.
//
// They are dropped at the end rather than at the start, though. They go into
// the topology alongside everything else so that the one stretch where the
// scenery meets the map on land — Colombia's border with Panama — can be told
// apart from a coastline by what lies on its far side, and left out of both
// meshes. The map draws that seam itself, in its own dark border line.
//
// Run: node scripts/build-world.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { feature, mesh, quantize } from "topojson-client";
import {
  filter,
  filterAttachedWeight,
  presimplify,
  sphericalRingArea,
  sphericalTriangleArea,
} from "topojson-simplify";
import { geoArea } from "d3-geo";
import {
  makeDownloader,
  simplifyArcs,
  rewindRings,
  loadCensusLakes,
} from "./geo-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache");
const outDir = join(root, "public", "data");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const download = makeDownloader(cacheDir);

const ADMIN0 = "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries_lakes.zip";
const ADMIN0_CACHE = "ne_10m_admin_0_countries_lakes.zip";
const LAKES = "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip";
const LAKES_CACHE = "ne_10m_lakes.zip";

const EARTH_RADIUS_KM = 6371;
// The map itself is generalized at 1.6 km. This is background: 6 km is under a
// pixel until the view is zoomed several times past the whole-continent frame,
// and it is what keeps the file to a fraction of the map's own.
const SIMPLIFY_METRES = 6000;
const MIN_WEIGHT = (SIMPLIFY_METRES / 1000) ** 2 / 2 / EARTH_RADIUS_KM ** 2;
// A speck 3 km across. Natural Earth draws thousands of them; none is a pixel
// at any zoom this layer is looked at. This is a floor on the LAND only — see
// the ring filter below, which spares every lake.
const MIN_RING_KM2 = 10;
const MIN_RING_WEIGHT = MIN_RING_KM2 / EARTH_RADIUS_KM ** 2;

// Natural Earth DBFs are UTF-8 with NUL padding on every string field.
const neClean = (v) => (typeof v === "string" ? v.replace(/\0/g, "").trim() : v);

// What the map already draws, and so what this file must not: the US and
// Canada (Census / StatCan county geometry), Mexico (Natural Earth admin-1),
// and every Caribbean and Central American country (Natural Earth admin-0,
// one unit each) — the same coverage loadNaForeignFeatures builds.
const OWN_UNITS = new Set(["USA", "CAN", "MEX"]);
const OWN_SUBREGIONS = new Set(["Caribbean", "Central America"]);

const readShapefile = async (url, cache) => {
  const zip = unzipSync(new Uint8Array(await download(url, cache)));
  const shp = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbf = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  return shapefile.read(Buffer.from(zip[shp]), Buffer.from(zip[dbf]), { encoding: "utf-8" });
};

const countryFc = await readShapefile(ADMIN0, ADMIN0_CACHE);
const lakeFc = await readShapefile(LAKES, LAKES_CACHE);

// Every country, the map's own included and flagged as such. The id is carried
// for whatever comes later (country outlines, names); the layers that draw this
// today read nothing but the shapes.
const countries = [];
for (const f of countryFc.features) {
  if (!f.geometry?.coordinates?.length) continue;
  const a3 = neClean(f.properties.ADM0_A3);
  const own = OWN_UNITS.has(a3) || OWN_SUBREGIONS.has(neClean(f.properties.SUBREGION));
  countries.push({
    type: "Feature",
    id: a3,
    properties: { name: neClean(f.properties.ADMIN), own },
    geometry: f.geometry,
  });
}
const ownCount = countries.filter((f) => f.properties.own).length;
console.log(
  `world land: ${countries.length - ownCount} countries kept, ${ownCount} left to the map`
);

// Every lake Natural Earth draws, with no floor on area. There used to be one,
// at 1,000 km², when this layer was scenery hiding behind the map and the only
// bar it had to clear was "the reader expects to see it on a world map". It is
// the map's own water now — the renderer draws this group over the county
// fills — so the file's own contents are the right answer, and 10m is the
// finest tier Natural Earth publishes. It is not much data either: the whole
// file is 1,355 lakes and 163k points, against 201 lakes and 93k points at the
// old floor.
// The Great Lakes and their named sub-bodies are the one place Natural Earth
// draws a single body of water as several touching polygons rather than one
// shape per lake (Michigan and Huron meeting at the Straits of Mackinac;
// Huron meeting Saginaw Bay, the North Channel and Georgian Bay; Superior
// meeting Whitefish Bay; Erie meeting Lake Saint Clair). Whether the arc where
// two of them meet is real shore or a synthetic closing line differs case by
// case — Saginaw Bay's ring reuses Huron's own shore for most of its length
// and adds a synthetic chord only across its mouth — and that made every
// dissolve rule tried here either draw the mouths as stray lines or drop real
// coastline along with them. All five lakes and every sub-body sit entirely
// inside the map's own USA/Canada territory, where the map already draws its
// own shoreline — Census hydrography, one continuous line around the whole
// system with no sub-body seams to dissolve in the first place, since it was
// never cut into named pieces. So this file leaves the Great Lakes to the map
// and does not draw them a second time.
const GREAT_LAKES = new Set([
  "Lake Superior",
  "Lake Michigan",
  "Lake Huron",
  "Lake Erie",
  "Lake Ontario",
  "Saginaw Bay",
  "Whitefish Bay",
  "Georgian Bay",
  "North Channel",
  "Lake Saint Clair",
]);
const lakes = [];
let greatLakesDropped = 0;
for (const f of lakeFc.features) {
  if (!f.geometry?.coordinates?.length) continue;
  const name = neClean(f.properties.name);
  if (GREAT_LAKES.has(name)) {
    greatLakesDropped++;
    continue;
  }
  lakes.push({ type: "Feature", properties: { name }, geometry: f.geometry });
}
console.log(`world lakes: ${greatLakesDropped} Great Lakes features left to the map's own shoreline`);
const neLakeCount = lakes.length;

// The renderer draws this group over the county fills, so it is this file —
// not na-map-overlays.json — that decides whether a lake the map's own units
// cover shows up at all. Natural Earth's set has a hole in it: water it files
// as coastal is in no lake layer, and Lake Pontchartrain is 1,600 km² of it.
// Those lakes come from the Census instead. They are free-standing rings here,
// sharing no arc with the land, which is exactly right — the countries they
// sit in are the ones dropped from `land` below.
lakes.push(...(await loadCensusLakes(readShapefile)));
console.log(
  `world lakes: ${neLakeCount} from Natural Earth 10m, ` +
    `${lakes.length - neLakeCount} from Census hydrography`
);

// Land and lakes go through as one topology. Natural Earth cuts the big lakes
// out of the countries it draws, and draws the same water again in the lakes
// file; sharing arcs is what makes those two agree after simplification, so a
// lake sits in the hole the land left rather than a few km beside it.
//
// Same pipeline the map's own topology runs: build unquantized so
// simplification measures true ground distances, drop free-standing specks,
// thin, quantize, then put every ring the right way round.
const raw = topology({
  all: { type: "FeatureCollection", features: countries },
  lakes: { type: "FeatureCollection", features: lakes },
});
const countPoints = (t) => t.arcs.reduce((n, a) => n + a.length, 0);
const before = countPoints(raw);

// Every arc a given object's rings walk. Read twice, because filter() prunes
// the unused arcs and renumbers what is left, so the indices differ either
// side of it.
const arcSet = (object) => {
  const set = new Set();
  for (const g of object.geometries) {
    const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
    for (const rings of polys ?? []) for (const ring of rings) {
      for (const i of ring) set.add(i < 0 ? ~i : i);
    }
  }
  return set;
};

// Despeckling is aimed at the land. Dropping the rocks and islets is what makes
// the coastline cheap, but a lake is a lake at any size: 52 of them are under
// the 10 km² floor, and dropping one would be this build deciding what the file
// says. So a ring the lakes walk is kept whatever its area, and only the land
// faces the floor.
const pre = presimplify(raw, sphericalTriangleArea);
const preLakeArcs = arcSet(pre.objects.lakes);
const bigEnough = filterAttachedWeight(pre, MIN_RING_WEIGHT, sphericalRingArea);
const kept = filter(
  pre,
  (ring, interior) =>
    ring.some((i) => preLakeArcs.has(i < 0 ? ~i : i)) || bigEnough(ring, interior)
);
const dropped = pre.arcs.length - kept.arcs.length;

// The lakes keep every point Natural Earth gave them. They are no longer
// scenery hiding behind the map: the renderer draws them over the county fills,
// where they cover the nation mesh's own shoreline — which is the Census
// outline generalized at 1.6 km, and visibly faceted past about 4x zoom. A
// layer that exists to hide someone else's generalization cannot be
// generalized itself. The land around them still thins at SIMPLIFY_METRES;
// only the arcs the lakes actually walk are spared, and because a lake and the
// hole the land leaves for it share those arcs, the two still agree exactly.
const lakeArcs = arcSet(kept.objects.lakes);
const { topo: thinned, collapsed } = simplifyArcs(kept, (i) => (lakeArcs.has(i) ? 0 : MIN_WEIGHT));

// The two line meshes, cut from the same arcs the land is built from. An arc
// the map's own units touch is neither: it is the Panama seam, or an edge
// inside the map's own territory, and the map draws both itself.
const isOwn = (g) => g.properties.own;
const coast = mesh(thinned, thinned.objects.all, (a, b) => a === b && !isOwn(a));
const borders = mesh(thinned, thinned.objects.all, (a, b) => a !== b && !isOwn(a) && !isOwn(b));

// Natural Earth often splits one contiguous body of water into several named
// lake features — Lake Michigan and Lake Huron at the Straits of Mackinac,
// Huron again against Georgian Bay, the North Channel and Saginaw Bay,
// Superior against Whitefish Bay, Erie against Lake Saint Clair, and more
// outside North America. Two different things happen at these splits, and
// they need opposite treatment:
//
//   - most pairs (Michigan/Huron) are two independent shapes that only touch
//     at a synthetic chord Natural Earth drew to close each one off — a
//     straight line across open water where there is no shore. That chord
//     belongs to neither shape's real edge and has to go.
//   - a named bay (Saginaw Bay, Whitefish Bay) is instead built by RE-USING
//     its parent lake's own detailed shore for most of its ring and adding
//     one short synthetic chord across its mouth to close itself off. Here
//     the shared arc IS the real shore — Huron's own ring uses that exact
//     arc too — and it is the bay's OWN unshared arc (the mouth chord) that
//     is the seam.
//
// An arc used by only one lake ring is never a synthetic chord (nothing
// closes a second shape with it), so it is always real shore. An arc shared
// between two lake rings is a synthetic chord UNLESS it is also a real
// land/water edge — which the land topology already knows, since a lake and
// the hole the land leaves for it share arcs wherever they run together.
// Checking against the land, not just against arc-sharing among the lakes,
// is what tells the Michigan/Huron case from the Saginaw Bay case.
const lakeRingOwners = new Map();
for (const g of thinned.objects.lakes.geometries) {
  const polys = g.type === "Polygon" ? [g.arcs] : g.arcs;
  for (const rings of polys ?? []) for (const ring of rings) for (const i of ring) {
    const j = i < 0 ? ~i : i;
    const owners = lakeRingOwners.get(j) ?? lakeRingOwners.set(j, new Set()).get(j);
    owners.add(g);
  }
}
const landArcs = arcSet(thinned.objects.all);
const lakeEdgeArcs = [...lakeRingOwners]
  .filter(([i, owners]) => owners.size === 1 || landArcs.has(i))
  .map(([i]) => i);
const lakeEdges = { type: "MultiLineString", coordinates: lakeEdgeArcs.map((i) => thinned.arcs[i]) };

// Natural Earth cuts the two countries that straddle the antimeridian in half
// and closes each half along it — Russia across Chukotka, Fiji across its
// eastern islands. That closing edge is not a shore, it is where the file was
// cut, and it has to stay in the land, which needs closed rings. Drawing it
// would run a straight blue line and its halo 700 km down the middle of the
// Chukotka Peninsula, so the coastline is broken wherever it meets one: the
// real shore on either side of the cut is untouched, and the join between
// them simply goes undrawn.
const onAntimeridian = (p) => Math.abs(Math.abs(p[0]) - 180) < 1e-6;
let cuts = 0;
coast.coordinates = coast.coordinates.flatMap((line) => {
  const runs = [];
  let run = [line[0]];
  for (let i = 1; i < line.length; i++) {
    if (onAntimeridian(line[i - 1]) && onAntimeridian(line[i])) {
      cuts++;
      if (run.length > 1) runs.push(run);
      run = [line[i]];
    } else run.push(line[i]);
  }
  if (run.length > 1) runs.push(run);
  return runs;
});
console.log(`${cuts} antimeridian seam segments left out of the coastline`);

const land = feature(thinned, {
  type: "GeometryCollection",
  geometries: thinned.objects.all.geometries.filter((g) => !isOwn(g)),
});
for (const f of land.features) f.properties = { name: f.properties.name };

// Rebuilding the topology is what drops the map's own countries: the arcs that
// only they used are simply never offered to it. Everything here is already
// simplified, and topology() never moves a coordinate, so the shapes that come
// out are the shapes that went in — with the land, the lakes and the two
// meshes sharing an arc wherever they run along the same line.
const topo = quantize(
  topology({ land, lakes: feature(thinned, thinned.objects.lakes), coast, borders, lakeEdges }),
  1e5
);
const rewound = rewindRings(topo, "land") + rewindRings(topo, "lakes");
const after = countPoints(topo);
console.log(
  `simplified at ${SIMPLIFY_METRES} m — ${before} → ${after} points ` +
    `(${((100 * after) / before).toFixed(1)}%), ${dropped} rings under ${MIN_RING_KM2} km² ` +
    `dropped, ${collapsed} small rings held at 4 points, ${rewound} rings rewound`
);

// A backwards ring means everything-but-the-ring, which on a globe floods the
// hemisphere with land. Antarctica is the largest thing here and covers about
// 2.7% of the sphere, so anything past a quarter of it is a winding failure.
for (const name of ["land", "lakes"]) {
  const feats = feature(topo, topo.objects[name]).features;
  const empty = feats.filter((f) => !f.geometry?.coordinates?.length);
  if (empty.length) throw new Error(`${empty.length} ${name} shapes lost their geometry`);
  const inverted = feats.filter((f) => geoArea(f) > Math.PI);
  if (inverted.length)
    throw new Error(
      `backwards ring winding in ${name}: ${inverted.map((f) => f.id ?? f.properties.name).join(", ")}`
    );
}
const lineCount = (name) => feature(topo, topo.objects[name]).geometry.coordinates.length;
if (!lineCount("coast") || !lineCount("borders") || !lineCount("lakeEdges"))
  throw new Error("the coast, border, or lake edge mesh came out empty");
console.log(
  `${lineCount("coast")} coast lines, ${lineCount("borders")} border lines, ` +
    `${lineCount("lakeEdges")} lake edge lines, ` +
    `${feature(topo, topo.objects.lakes).features.length} lakes`
);

const out = JSON.stringify(topo);
writeFileSync(join(outDir, "world-land.json"), out);
console.log(`wrote world-land.json (${(out.length / 1e6).toFixed(2)} MB)`);
