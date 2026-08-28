// Builds the per-county census-tract files behind county carving:
//
//   public/data/tracts/<county GEOID>.json — { county, topo, rows }
//     topo:  TopoJSON of the county's 2020 census tracts (objects.tracts,
//            ids are 11-digit GEOIDs), simplified and quantized like the
//            main map but at tract-appropriate tolerance
//     rows:  per-tract ACS 2019–23 5-year counts, used by the app only as
//            SHARES to divide the county's published row — so a carve never
//            moves any state or national total
//
// One file per county for every US county (50 states + DC), fetched by the
// app lazily and only for a county actually carved. Sources (keyless public
// downloads, cached in .cache/; set CENSUS_API_KEY to use a key):
//
//   Geometry: Census cartographic boundary files cb_2023_<state>_tract_500k
//   Data:     ACS 2023 5-year API (api.census.gov), one call per state
//
// This is a separate, heavier step than the county build (51 shapefiles,
// ~85,000 tracts), so it runs on its own:
//
//   npm run data:tracts
//
// It reads public/data/na-county-data.json for the county list it must
// cover, so run `npm run data` first. Every county in that file must end up
// with a tract file — a state whose tract county codes don't match the map's
// (the Connecticut planning-region worry) fails loudly here instead of 404ing
// in the app.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { feature, quantize } from "topojson-client";
import {
  filter,
  filterAttachedWeight,
  presimplify,
  sphericalRingArea,
  sphericalTriangleArea,
} from "topojson-simplify";
import { geoArea } from "d3-geo";
import { makeDownloader, simplifyArcs, rewindRings } from "./geo-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache");
const dataDir = join(root, "public", "data");
const outDir = join(dataDir, "tracts");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const download = makeDownloader(cacheDir);

// The counties the tract files must cover — the map's own list, so the
// Connecticut planning regions and every other county-equivalent choice the
// county build made are matched exactly.
const countyData = JSON.parse(readFileSync(join(dataDir, "na-county-data.json"), "utf8"));
const usCounties = Object.keys(countyData.counties).filter((id) => /^\d{5}$/.test(id));
const states = [...new Set(usCounties.map((id) => id.slice(0, 2)))].sort();

// ---------------------------------------------------------------- geometry

// Tract outlines ship at 1:500k, far finer than any zoom can show. 100 m
// keeps a carved seam crisp at the map's 16x maximum (one pixel there is
// about 290 m of ground) while keeping the files lazy-loadable.
const SIMPLIFY_METRES = 100;
const EARTH_RADIUS_KM = 6371;
const MIN_WEIGHT = (SIMPLIFY_METRES / 1000) ** 2 / 2 / EARTH_RADIUS_KM ** 2;
const MIN_RING_KM2 = 0.05;
const MIN_RING_WEIGHT = MIN_RING_KM2 / EARTH_RADIUS_KM ** 2;

// One county's tracts as a topology of their own: files are per county, so
// arcs only need to be shared within one. Quiet on success — 3,222 of these
// run per full build — and loud when a county's geometry comes out broken.
function buildTractTopo(countyId, features) {
  const raw = topology({ tracts: { type: "FeatureCollection", features } });
  const pre = presimplify(raw, sphericalTriangleArea);
  const kept = filter(pre, filterAttachedWeight(pre, MIN_RING_WEIGHT, sphericalRingArea));
  const { topo: thinned } = simplifyArcs(kept, MIN_WEIGHT);
  const topo = quantize(thinned, 1e5);
  rewindRings(topo, "tracts");

  const feats = feature(topo, topo.objects.tracts).features;
  const empty = feats.filter((f) => !f.geometry || !f.geometry.coordinates?.length);
  if (empty.length)
    throw new Error(`${countyId}: ${empty.length} tracts lost their geometry (${empty.map((f) => f.id).join(", ")})`);
  const inverted = feats.filter((f) => geoArea(f) > Math.PI);
  if (inverted.length)
    throw new Error(`${countyId}: backwards ring winding in ${inverted.map((f) => f.id).join(", ")}`);
  return topo;
}

async function loadStateTracts(st) {
  const url = `https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_${st}_tract_500k.zip`;
  const zip = unzipSync(new Uint8Array(await download(url, `cb_2023_${st}_tract_500k.zip`)));
  const shpName = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbfName = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  const fc = await shapefile.read(Buffer.from(zip[shpName]), Buffer.from(zip[dbfName]));
  const byCounty = new Map(); // 5-digit county GEOID -> features
  const aland = new Map(); // tract GEOID -> land area, for vintage reconciliation
  for (const f of fc.features) {
    const county = f.properties.STATEFP + f.properties.COUNTYFP;
    if (!byCounty.has(county)) byCounty.set(county, []);
    byCounty.get(county).push({
      type: "Feature",
      id: f.properties.GEOID,
      properties: { name: f.properties.NAMELSAD },
      geometry: f.geometry,
    });
    aland.set(f.properties.GEOID, +f.properties.ALAND || 0);
  }
  return { byCounty, aland };
}

// -------------------------------------------------------------------- data

// The variables that back the county row's tract-divisible fields, matched to
// the app's categories: B01003 population, B19013 median household income,
// B15003 education (25+, bachelor's+ = _022..._025), B03002 race/ethnicity
// (not-Hispanic white/Black/Native/Asian alone, Hispanic of any race — the
// same cuts the ASRH county file feeds the app).
const ACS_VARS = {
  pop: ["B01003_001E"],
  mhi: ["B19013_001E"],
  eduT: ["B15003_001E"],
  eduB: ["B15003_022E", "B15003_023E", "B15003_024E", "B15003_025E"],
  rT: ["B03002_001E"],
  rW: ["B03002_003E"],
  rB: ["B03002_004E"],
  rN: ["B03002_005E"],
  rA: ["B03002_006E"],
  rH: ["B03002_012E"],
};

async function loadStateData(st) {
  const vars = [...new Set(Object.values(ACS_VARS).flat())];
  const key = process.env.CENSUS_API_KEY ? `&key=${process.env.CENSUS_API_KEY}` : "";
  const url =
    `https://api.census.gov/data/2023/acs/acs5?get=${vars.join(",")}` +
    `&for=tract:*&in=state:${st}&in=county:*${key}`;
  const table = JSON.parse(new TextDecoder().decode(await download(url, `acs-tract-2023-${st}.json`)));
  const col = Object.fromEntries(table[0].map((h, i) => [h, i]));
  const byCounty = new Map(); // 5-digit county GEOID -> { tract GEOID -> row }
  for (const line of table.slice(1)) {
    const county = line[col.state] + line[col.county];
    const geoid = county + line[col.tract];
    const row = {};
    for (const [field, sources] of Object.entries(ACS_VARS)) {
      // ACS marks a suppressed or absent estimate with a large negative
      // sentinel; a count clamps to 0 and the median goes null so the app's
      // share math never sees it.
      const v = sources.reduce((sum, s) => sum + +line[col[s]], 0);
      row[field] = Number.isFinite(v) && v >= 0 ? v : field === "mhi" ? null : 0;
    }
    if (row.mhi === 0) row.mhi = null;
    if (!byCounty.has(county)) byCounty.set(county, {});
    byCounty.get(county)[geoid] = row;
  }
  return byCounty;
}

// --------------------------------------------------------------- reconcile

// The boundary file and the ACS tabulation are different vintages of the
// same 2020 tracts, and Census corrects a handful of tract numbers between
// them (a renumbered tract, a late split). Within a county the mismatch is
// closed by pooling: ACS rows with no matching shape are summed and dealt
// out across the shapes with no matching row, by each shape's share of
// their land area. The county's tract totals are preserved — which is all
// the app needs, since it reads these rows only as shares — and the water
// tracts the shoreline-clipped shapes rightly omit just drop.
let waterDropped = 0;
let reconciled = 0;

function reconcileVintages(countyId, features, rows, aland) {
  const geoIds = new Set(features.map((f) => f.id));
  const funded = [];
  for (const id of Object.keys(rows)) {
    if (geoIds.has(id)) continue;
    if (rows[id].pop > 0) funded.push(rows[id]);
    else waterDropped++;
    delete rows[id];
  }
  const orphanShapes = features.filter((f) => !rows[f.id]);
  if (!orphanShapes.length) {
    if (funded.length)
      throw new Error(
        `${countyId}: ${funded.length} populated ACS row(s) with no shape and no renumbered shape to carry them`
      );
    return;
  }
  reconciled++;
  const pool = {};
  for (const field of Object.keys(ACS_VARS)) {
    if (field !== "mhi") pool[field] = funded.reduce((t, r) => t + (r[field] || 0), 0);
  }
  let ws = 0;
  let w = 0;
  for (const r of funded) {
    if (r.mhi != null && r.pop > 0) {
      ws += r.mhi * r.pop;
      w += r.pop;
    }
  }
  const pooledMhi = w > 0 ? Math.round(ws / w) : null;
  const areas = orphanShapes.map((f) => aland.get(f.id) || 1);
  const total = areas.reduce((a, b) => a + b, 0);
  const shares = areas.map((a) => a / total);
  const biggest = shares.indexOf(Math.max(...shares));
  for (const f of orphanShapes) rows[f.id] = { mhi: pooledMhi };
  for (const [field, v] of Object.entries(pool)) {
    const values = shares.map((s) => Math.round(v * s));
    values[biggest] += v - values.reduce((a, b) => a + b, 0);
    orphanShapes.forEach((f, i) => (rows[f.id][field] = values[i]));
  }
}

// ------------------------------------------------------------------- build

let files = 0;
let tracts = 0;
let bytes = 0;

for (const st of states) {
  const { byCounty: tractsByCounty, aland } = await loadStateTracts(st);
  const dataByCounty = await loadStateData(st);
  const wanted = usCounties.filter((id) => id.startsWith(st));

  // Every county the map draws must have tract shapes under the same code —
  // this is where a county-equivalent mismatch (old CT counties vs planning
  // regions, a renamed county) surfaces as an error instead of an app 404.
  const missing = wanted.filter((id) => !tractsByCounty.has(id));
  if (missing.length)
    throw new Error(
      `state ${st}: no tract shapes for ${missing.join(", ")} — county codes disagree between the map and the tract file`
    );

  for (const countyId of wanted) {
    const features = tractsByCounty.get(countyId);
    const rows = dataByCounty.get(countyId) ?? {};
    reconcileVintages(countyId, features, rows, aland);
    for (const f of features) rows[f.id].name = f.properties.name;
    const topo = buildTractTopo(countyId, features);
    const out = JSON.stringify({ county: countyId, topo, rows });
    writeFileSync(join(outDir, `${countyId}.json`), out);
    files++;
    tracts += features.length;
    bytes += out.length;
  }
  console.log(`state ${st}: ${wanted.length} counties, ${[...tractsByCounty.values()].reduce((n, f) => n + f.length, 0)} tracts`);
}

console.log(
  `wrote ${files} county tract files (${tracts.toLocaleString("en-US")} tracts, ` +
    `${(bytes / 1e6).toFixed(0)} MB; ${waterDropped} unpopulated water tracts dropped, ` +
    `${reconciled} counties reconciled across tract vintages)`
);
