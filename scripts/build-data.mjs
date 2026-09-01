// Builds the three static data files the app loads:
//   public/data/na-counties-topo.json  — TopoJSON of the map's units: 2023 US
//     county boundaries (50 states + DC), Canada's 2021 census divisions, and
//     every Mexican state and Caribbean / Central American country as one unit
//   public/data/na-county-data.json    — per-unit population, GDP, education
//     and income (the latter two are real survey figures for US counties and
//     Canadian divisions, rough hand-compiled estimates for Mexico and the
//     Caribbean/Central America); election, race, and life expectancy counts
//     for US counties only
//   public/data/na-map-overlays.json   — classified map boundary, the
//     US/Canada/Mexico border seam, and notable lakes
//
// The fourth file the app loads, public/data/world-land.json, is scenery
// rather than map and is built separately by build-world.mjs.
//
// Sources (all keyless public downloads):
//   Geometry:   Census cartographic boundary file cb_2023_us_county_5m;
//               Statistics Canada 2021 census division cartographic boundaries;
//               Natural Earth 10m admin-0/admin-1 (lakes variants)
//   Lakes:      Natural Earth 10m lakes, plus TIGER 2023 area hydrography for
//               the water Natural Earth files as coastal (CENSUS_LAKES in
//               geo-lib.mjs, which build-world.mjs reads too)
//   Population: Census PEP vintage-2025 county estimates (falls back to 2024)
//   GDP:        BEA CAGDP2 (county GDP, current dollars, thousands)
//   Education:  USDA ERS county educational attainment (ACS 2019-23 counts)
//   Election:   county-level 2024 presidential results (tonmcg/US_County_Level_Election_Results)
//   Life exp.:  County Health Rankings & Roadmaps analytic file (NCHS mortality
//               + Census population), 2021-23, US counties only
//   Canada:     2021 Census Profile by census division (population, household
//               income, education, employment income)
//   Non-US:     hand-compiled population/GDP/education/income table in
//               na-unit-data.mjs, which doubles as the provincial control
//               totals Canada's divisions are apportioned from
//
// Downloads are cached in .cache/ so reruns work offline. The Canadian
// boundary file carries millions of vertices, so `npm run data` raises Node's
// heap; running this script by hand wants the same.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import { csvParse, csvParseRows } from "d3-dsv";
import * as shapefile from "shapefile";
import { topology } from "topojson-server";
import { feature, merge, quantize } from "topojson-client";
import {
  filter,
  filterAttachedWeight,
  presimplify,
  sphericalRingArea,
  sphericalTriangleArea,
} from "topojson-simplify";
import { geoArea } from "d3-geo";
import proj4 from "proj4";
import { NA_UNIT_STATS } from "./na-unit-data.mjs";
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

const URLS = {
  geometry: "https://www2.census.gov/geo/tiger/GENZ2023/shp/cb_2023_us_county_5m.zip",
  pop2025: "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/totals/co-est2025-alldata.csv",
  pop2024: "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/totals/co-est2024-alldata.csv",
  gdp: "https://apps.bea.gov/regional/zip/CAGDP2.zip",
  education: "https://www.ers.usda.gov/media/5495/educational-attainment-for-adults-age-25-and-older-for-the-united-states-states-and-counties-1970-2023.csv?v=13505",
  election: "https://raw.githubusercontent.com/tonmcg/US_County_Level_Election_Results_08-24/master/2024_US_County_Level_Presidential_Results.csv",
  saipe: "https://www2.census.gov/programs-surveys/saipe/datasets/2023/2023-state-and-county/est23all.txt",
  // County Health Rankings & Roadmaps analytic file: life expectancy at birth
  // (measure v147), pooled from NCHS mortality and Census population data.
  // Bump the year/version when a newer annual release replaces this one.
  lifeExpectancy: "https://www.countyhealthrankings.org/sites/default/files/media/document/analytic_data2025_v3.csv",
  race2025: "https://www2.census.gov/programs-surveys/popest/datasets/2020-2025/counties/asrh/cc-est2025-alldata.csv",
  race2024: "https://www2.census.gov/programs-surveys/popest/datasets/2020-2024/counties/asrh/cc-est2024-alldata.csv",
  lakes: "https://naturalearth.s3.amazonaws.com/10m_physical/ne_10m_lakes.zip",
  world: "https://cdn.jsdelivr.net/npm/world-atlas@2/countries-10m.json",
  // Canada's county equivalents. The cartographic ("b") file is clipped to
  // the shoreline, the way the Census county file is, so the Great Lakes and
  // Hudson Bay stay carved out of the land instead of being filled to the
  // territorial limit.
  caGeometry:
    "https://www12.statcan.gc.ca/census-recensement/2021/geo/sip-pis/boundary-limites/files-fichiers/lcd_000b21a_e.zip",
  // 2021 Census Profile, census divisions (product 98-401-X2021004).
  caProfile:
    "https://www12.statcan.gc.ca/census-recensement/2021/dp-pd/prof/details/download-telecharger/comp/GetFile.cfm?Lang=E&FILETYPE=CSV&GEONO=004",
  // Population estimates by census division on 2021 boundaries — the same
  // boundaries as the geometry above, so the two join by division id.
  caPopulation: "https://www150.statcan.gc.ca/n1/tbl/csv/17100152-eng.zip",
  // T1 Family File: provincial income from tax records, in current dollars,
  // which is what makes it usable as a nominal growth factor (the survey-based
  // series are published in constant dollars).
  caIncome: "https://www150.statcan.gc.ca/n1/tbl/csv/11100009-eng.zip",
  // Three-year complete life tables: Canada and every province except PEI.
  caLifeProv: "https://www150.statcan.gc.ca/n1/tbl/csv/13100114-eng.zip",
  // Three-year abridged life tables: PEI, Yukon, NWT, Nunavut (StatCan
  // publishes these four separately from the rest — a small-population
  // methodology split, not a coverage gap).
  caLifeTerr: "https://www150.statcan.gc.ca/n1/tbl/csv/13100140-eng.zip",
  // BC's 89 Local Health Areas, the province's own health-reporting
  // geography, via the BC Geographic Warehouse's WFS GeoJSON output.
  bcLha:
    "https://openmaps.gov.bc.ca/geo/pub/WHSE_ADMIN_BOUNDARIES.BCHA_LOCAL_HEALTH_AREA_SP/ows" +
    "?service=WFS&version=2.0.0&request=GetFeature" +
    "&typeName=pub:WHSE_ADMIN_BOUNDARIES.BCHA_LOCAL_HEALTH_AREA_SP" +
    "&outputFormat=json&srsName=EPSG:4326",
  // The _lakes variants carve major lakes out of the land, matching how the
  // Census county polygons treat the Great Lakes — without this, Ontario's
  // polygon would run through the middle of Lake Superior.
  admin0: "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_0_countries_lakes.zip",
  admin1: "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_admin_1_states_provinces_lakes.zip",
};

const download = makeDownloader(cacheDir);

// Census/BEA CSVs are windows-1252; decode accordingly and strip any BOM.
const decodeCsv = (buf) => new TextDecoder("windows-1252").decode(buf).replace(/^﻿/, "");

// ---------------------------------------------------------------- geometry

// Vertices the screen can't resolve cost render time and show nothing. The map
// draws 975 units wide (about one CSS pixel per unit at the default size), and
// one unit is roughly 4.6 km of ground, so the raw Census outlines carry far
// more detail than any zoom level can display. Visvalingam–Whyatt drops the
// least significant points first, and because TopoJSON simplifies each shared
// arc once, neighbouring counties keep byte-identical borders — no slivers and
// no gaps.
//
// 1.6 km keeps the 99th-percentile shift under 0.2 units: a fifth of a pixel at
// the default view, about 3 px at the 16x maximum. Past roughly 3 km the worst-
// case shift and the number of collapsing rings both climb sharply.
//
// Building the topology unquantized (below) also makes junction detection
// exact, which picks up 66 county pairs that meet only at a corner. That feeds
// nothing but the map's colour choices — state-level adjacency, and so every
// state's fill, is unchanged.
const SIMPLIFY_METRES = 1600;
const EARTH_RADIUS_KM = 6371;

// presimplify stores each point's Visvalingam weight as a triangle area in
// steradians. Albers is equal-area, so one area threshold means one constant
// on-screen threshold everywhere. Use a right triangle with legs of that length.
const MIN_WEIGHT =
  (SIMPLIFY_METRES / 1000) ** 2 / 2 / EARTH_RADIUS_KM ** 2;

// Statistics Canada draws every lake islet and offshore rock, and there are
// hundreds of thousands of them: thinning alone left more four-point rings
// than the rest of the continent had points, none of them wider than the
// 150 m grid this file is quantized onto, so they survived as noise rather
// than as islands. Rings below a floor of drawable area are dropped outright
// instead, before any point thinning. filterAttachedWeight spares any ring
// that shares an arc with a neighbour whatever its size, so a unit's
// mainland can never go — only free-standing specks do.
//
// 0.5 km² is a speck about 700 m across: two pixels at the 16x maximum zoom,
// and a seventh of one at the home view.
const MIN_RING_KM2 = 0.5;
const MIN_RING_WEIGHT = MIN_RING_KM2 / EARTH_RADIUS_KM ** 2;

// simplifyArcs and rewindRings live in geo-lib.mjs, shared with the tract
// build, which runs the same repairs at its own tolerance.

// topology → presimplify → thin → quantize → verify → write. Shared by the
// US map (counties only) and the North America map (counties + foreign units
// in one object, so shared arcs among the foreign units are detected too).
function buildTopoFile(features, filename) {
  // Build unquantized so simplification measures true ground distances, then
  // quantize the simplified result for a compact file.
  const raw = topology({ counties: { type: "FeatureCollection", features } });
  const countPoints = (t) => t.arcs.reduce((n, a) => n + a.length, 0);
  const before = countPoints(raw);

  const pre = presimplify(raw, sphericalTriangleArea);
  const kept = filter(pre, filterAttachedWeight(pre, MIN_RING_WEIGHT, sphericalRingArea));
  const dropped = pre.arcs.length - kept.arcs.length;

  const { topo: thinned, collapsed } = simplifyArcs(kept, MIN_WEIGHT);
  const topo = quantize(thinned, 1e5);
  const rewound = rewindRings(topo, "counties");
  const after = countPoints(topo);
  console.log(
    `geometry: simplified at ${SIMPLIFY_METRES} m — ${before} → ${after} points ` +
      `(${((100 * after) / before).toFixed(1)}%), ${dropped} rings under ${MIN_RING_KM2} km² ` +
      `dropped, ${collapsed} small rings held at 4 points, ${rewound} rings rewound`
  );

  // Every unit must survive simplification with drawable geometry.
  const feats = feature(topo, topo.objects.counties).features;
  const empty = feats.filter((f) => !f.geometry || !f.geometry.coordinates?.length);
  if (empty.length) throw new Error(`${empty.length} units lost their geometry in ${filename}`);

  // No unit covers half the earth; one that measures as if it did has a
  // backwards ring that rewindRings failed to put right.
  const inverted = feats.filter((f) => geoArea(f) > Math.PI);
  if (inverted.length)
    throw new Error(
      `${inverted.length} units with backwards ring winding in ${filename}: ` +
        inverted.map((f) => f.id).join(", ")
    );

  const out = JSON.stringify(topo);
  writeFileSync(join(outDir, filename), out);
  console.log(`wrote ${filename} (${(out.length / 1e6).toFixed(1)} MB)`);
  return topo;
}

async function loadCountyFeatures() {
  const zip = unzipSync(new Uint8Array(await download(URLS.geometry, "cb_2023_us_county_5m.zip")));
  const shpName = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbfName = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  const fc = await shapefile.read(Buffer.from(zip[shpName]), Buffer.from(zip[dbfName]));

  // Keep the 50 states + DC (state FIPS <= 56); drop territories.
  const features = fc.features
    .filter((f) => +f.properties.STATEFP <= 56)
    .map((f) => ({
      type: "Feature",
      id: f.properties.GEOID,
      properties: { name: f.properties.NAME, st: f.properties.STATEFP },
      geometry: f.geometry,
    }));
  console.log(`geometry: ${features.length} county shapes`);
  return features;
}

// -------------------------------------------------------------- population

async function loadPopulation() {
  let buf, vintage;
  try {
    buf = await download(URLS.pop2025, "co-est2025-alldata.csv");
    vintage = 2025;
  } catch {
    buf = await download(URLS.pop2024, "co-est2024-alldata.csv");
    vintage = 2024;
  }
  const rows = csvParse(decodeCsv(buf));
  const popCol = rows.columns.filter((c) => /^POPESTIMATE\d{4}$/.test(c)).sort().at(-1);
  const year = +popCol.slice(-4);

  const counties = new Map(); // fips -> { name, st, pop }
  const stateNames = new Map(); // state fips -> name
  for (const r of rows) {
    if (r.SUMLEV === "040") stateNames.set(r.STATE, r.STNAME);
    if (r.SUMLEV !== "050") continue;
    const fips = r.STATE + r.COUNTY;
    counties.set(fips, { name: r.CTYNAME, st: r.STATE, pop: +r[popCol] });
  }
  console.log(`population: ${counties.size} counties, vintage ${vintage}, year ${year}`);
  return { counties, stateNames, year };
}

// --------------------------------------------------------------------- gdp

// BEA reports some small independent cities combined with a neighboring
// county ("Albemarle + Charlottesville, VA", GeoFIPS ending >= 900). We
// allocate those totals back to the constituent counties by population.
// Combo constituents never have a standalone BEA row, so counties that
// already have one are excluded (e.g. "Southampton + Franklin" means
// Franklin city, not Franklin County, which is reported on its own).
function matchComboCounties(geoName, stateFips, popCounties, standalone) {
  const inState = [...popCounties].filter(
    ([fips, c]) => c.st === stateFips && !standalone.has(fips)
  );
  const norm = (s) => s.toLowerCase().replace(/[^a-z ]/g, "").trim();
  const tokens = geoName
    .replace(/,\s*[A-Z]{2}\s*\*?$/, "") // trailing ", VA"
    .split(/[+,]/)
    .map((t) => t.trim())
    .filter(Boolean);

  const fips = [];
  for (const t of tokens) {
    const isCity = /\bcity\b/i.test(t);
    const base = norm(t.replace(/\bcity\b/gi, ""));
    const hit =
      (isCity && inState.find(([, c]) => norm(c.name) === base + " city")) ||
      inState.find(([, c]) => norm(c.name) === base + " county") ||
      inState.find(([, c]) => norm(c.name) === base + " city") ||
      inState.find(([, c]) => norm(c.name).startsWith(base));
    if (hit) fips.push(hit[0]);
    else console.warn(`  unmatched combo part "${t}" in "${geoName}"`);
  }
  return fips;
}

async function loadGdp(popCounties) {
  const zip = unzipSync(new Uint8Array(await download(URLS.gdp, "CAGDP2.zip")));
  const csvName = Object.keys(zip).find((n) => /ALL_AREAS/.test(n));
  const rows = csvParse(decodeCsv(Buffer.from(zip[csvName])));
  const yearCol = rows.columns.filter((c) => /^\d{4}$/.test(c)).sort().at(-1);

  const gdp = new Map(); // fips -> thousands of dollars
  const combos = [];
  for (const r of rows) {
    if (r.LineCode !== "1") continue; // all-industry total
    const fips = (r.GeoFIPS || "").replace(/[" ]/g, "");
    if (!/^\d{5}$/.test(fips) || fips.endsWith("000")) continue; // skip US/state rows
    const value = +String(r[yearCol]).replace(/,/g, "");
    if (!Number.isFinite(value)) {
      console.warn(`  no GDP value for ${fips} ${r.GeoName} (${r[yearCol]})`);
      continue;
    }
    if (+fips.slice(2) >= 900) combos.push({ fips, name: r.GeoName, st: fips.slice(0, 2), value });
    else gdp.set(fips, value);
  }

  const standalone = new Set(gdp.keys());
  for (const combo of combos) {
    const parts = matchComboCounties(combo.name, combo.st, popCounties, standalone);
    if (!parts.length) continue;
    const totalPop = parts.reduce((s, f) => s + popCounties.get(f).pop, 0);
    for (const f of parts) {
      gdp.set(f, Math.round((combo.value * popCounties.get(f).pop) / totalPop) || 0);
    }
  }
  console.log(`gdp: ${gdp.size} counties (${combos.length} combined areas allocated), year ${yearCol}`);
  return { gdp, year: +yearCol };
}

// --------------------------------------------------------------- education

async function loadEducation() {
  const buf = await download(URLS.education, "ers-education.csv");
  const rows = csvParse(decodeCsv(buf));
  // Long format: FIPS Code / Attribute / Value. Aggregate the four adult
  // attainment counts for the latest ACS window so custom states can be
  // summed exactly.
  const fipsKey = rows.columns.find((c) => /fips/i.test(c));
  const attrKey = rows.columns.find((c) => /attribute/i.test(c));
  const valKey = rows.columns.find((c) => /value/i.test(c));

  const windows = new Set();
  for (const r of rows) {
    const m = r[attrKey]?.match(/(\d{4})-(\d{2})$/);
    if (m) windows.add(m[0]);
  }
  const latest = [...windows].sort((a, b) => +a.slice(0, 4) - +b.slice(0, 4)).at(-1);

  const countAttrs = [
    `Less than high school graduate, ${latest}`,
    `High school graduate (or equivalency), ${latest}`,
    `Some college or associate degree, ${latest}`,
    `Bachelor's degree or higher, ${latest}`,
  ];
  const edu = new Map(); // fips -> { total, bach }
  for (const r of rows) {
    const attr = r[attrKey];
    const idx = countAttrs.indexOf(attr);
    if (idx === -1) continue;
    const fips = String(r[fipsKey]).padStart(5, "0");
    if (fips.endsWith("000")) continue; // state/US rows
    const value = +String(r[valKey]).replace(/,/g, "");
    if (!Number.isFinite(value)) continue;
    const e = edu.get(fips) ?? { total: 0, bach: 0 };
    e.total += value;
    if (idx === 3) e.bach += value;
    edu.set(fips, e);
  }
  console.log(`education: ${edu.size} counties, window ${latest}`);
  return { edu, window: latest };
}

// ---------------------------------------------------------------- election

// Alaska reports results by state house district under pseudo-FIPS codes
// (02001-02040) that don't match county-equivalents. We sum them to a
// statewide total and allocate it to Alaska's county-equivalents by
// population, so Alaska's state-level numbers are exact and only the
// county-level split is approximate.
async function loadElection(popCounties) {
  const buf = await download(URLS.election, "election-2024.csv");
  // This file is UTF-8, unlike the Census/BEA ones.
  const rows = csvParse(new TextDecoder("utf-8").decode(buf).replace(/^﻿/, ""));
  const votes = new Map(); // fips -> { dem, gop, tot }
  const ak = { dem: 0, gop: 0, tot: 0 };
  for (const r of rows) {
    const fips = String(r.county_fips).padStart(5, "0");
    if (!/^\d{5}$/.test(fips)) continue;
    const dem = +String(r.votes_dem).replace(/,/g, "");
    const gop = +String(r.votes_gop).replace(/,/g, "");
    const tot = +String(r.total_votes).replace(/,/g, "");
    if (!Number.isFinite(tot) || tot <= 0) continue;
    if (fips.startsWith("02")) {
      ak.dem += dem;
      ak.gop += gop;
      ak.tot += tot;
    } else {
      votes.set(fips, { dem, gop, tot });
    }
  }

  const akCounties = [...popCounties].filter(([, c]) => c.st === "02");
  const akPop = akCounties.reduce((s, [, c]) => s + c.pop, 0);
  for (const [fips, c] of akCounties) {
    const share = c.pop / akPop;
    votes.set(fips, {
      dem: Math.round(ak.dem * share),
      gop: Math.round(ak.gop * share),
      tot: Math.round(ak.tot * share),
    });
  }
  console.log(
    `election: ${votes.size} counties, 2024 presidential (Alaska allocated by population)`
  );
  return { votes, year: 2024 };
}

// ------------------------------------------------------- income & ethnicity

// SAIPE county estimates: median household income. Fixed-width file, but
// every field is whitespace-separated with "." placeholders for missing
// values, so token positions are stable; median household income is the
// 21st field. (The Census API now requires a key, so we use the flat file.)
async function loadIncome() {
  const buf = await download(URLS.saipe, "est23all.txt");
  const mhi = new Map(); // fips -> dollars
  for (const line of decodeCsv(buf).split(/\r?\n/)) {
    const t = line.trim().split(/\s+/);
    if (t.length < 24 || t[1] === "0") continue; // header noise / state / US rows
    const fips = t[0].padStart(2, "0") + t[1].padStart(3, "0");
    const value = +t[20];
    if (/^\d{5}$/.test(fips) && Number.isFinite(value) && value > 0) mhi.set(fips, value);
  }
  console.log(`income: ${mhi.size} counties, SAIPE 2023 median household income`);
  return { mhi, year: 2023 };
}

// ---------------------------------------------------------- life expectancy

// County Health Rankings & Roadmaps analytic file. Its first row is a
// human-readable label per column; the row below it is the machine key
// ("fipscode", "v147_rawvalue" for life expectancy) the data rows key off,
// so the label row is dropped before parsing it as a normal header+rows CSV.
// A county under 5,000 population-years-at-risk in the window reports no
// value. Connecticut's new planning regions are present but all blank: NCHS
// hasn't recomputed life expectancy for that geography yet, so Connecticut
// carries no life expectancy until it does.
async function loadLifeExpectancy() {
  const buf = await download(URLS.lifeExpectancy, "chr-analytic-2025.csv");
  const text = new TextDecoder("utf-8").decode(buf).replace(/^﻿/, "");
  const rows = csvParse(text.slice(text.indexOf("\n") + 1));
  const life = new Map(); // fips -> years
  for (const r of rows) {
    const fips = r.fipscode;
    if (!/^\d{5}$/.test(fips) || fips.endsWith("000")) continue; // state/US rows
    const value = +r.v147_rawvalue;
    if (Number.isFinite(value) && value > 0) life.set(fips, value);
  }
  console.log(`life expectancy: ${life.size} counties, CHR&R 2021-23 (NCHS mortality + Census population)`);
  return { life, window: "2021-23" };
}

// Census PEP county characteristics (ASRH): race/ethnicity counts. We keep
// the AGEGRP=0 (all ages) rows for the latest estimate year: not-Hispanic
// white/Black/Native/Asian alone, plus Hispanic of any race. Counts are
// additive, so custom-state shares are exact.
async function loadRace() {
  let buf, vintage;
  try {
    buf = await download(URLS.race2025, "cc-est2025-alldata.csv");
    vintage = 2025;
  } catch {
    buf = await download(URLS.race2024, "cc-est2024-alldata.csv");
    vintage = 2024;
  }
  // ~100 MB, so filter lines with a cheap split instead of parsing it all.
  const lines = decodeCsv(buf).split(/\r?\n/);
  const head = lines[0].split(",");
  const col = Object.fromEntries(head.map((h, i) => [h, i]));
  const pair = (f, name) => +f[col[name + "_MALE"]] + +f[col[name + "_FEMALE"]];
  const race = new Map(); // fips -> { year, rT, rW, rB, rN, rA, rH }
  for (let i = 1; i < lines.length; i++) {
    if (!lines[i]) continue;
    let f = lines[i].split(",");
    if (f.length !== head.length) f = csvParseRows(lines[i])[0]; // quoted comma fallback
    if (+f[col.AGEGRP] !== 0) continue;
    const fips = f[col.STATE].padStart(2, "0") + f[col.COUNTY].padStart(3, "0");
    const year = +f[col.YEAR];
    const prev = race.get(fips);
    if (prev && prev.year >= year) continue;
    race.set(fips, {
      year,
      rT: +f[col.TOT_POP],
      rW: pair(f, "NHWA"),
      rB: pair(f, "NHBA"),
      rN: pair(f, "NHIA"),
      rA: pair(f, "NHAA"),
      rH: pair(f, "H"),
    });
  }
  const raceYear = 2020 + Math.max(...[...race.values()].map((r) => r.year)) - 2;
  console.log(`race: ${race.size} counties, vintage ${vintage}, year ${raceYear}`);
  return { race, year: raceYear };
}

// ---------------------------------------------------------------- overlays

// Point-in-polygon on plain lon/lat (even-odd ray cast), with a bounding-box
// prefilter per polygon. Rings are bucketed into latitude rows so a query
// walks only the edges near its latitude instead of a whole country outline —
// the boundary classification below fires hundreds of thousands of tests at
// the 10m Canada/Mexico/US polygons. Good enough here: nothing we test
// crosses the antimeridian in a way that matters for these classifications.
const ROW_DEG = 0.05; // ring-index row height in degrees of latitude, ~5.5 km

function indexRing(ring) {
  let y0 = Infinity, y1 = -Infinity;
  for (const [, y] of ring) {
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const rows = Math.max(1, Math.ceil((y1 - y0) / ROW_DEG));
  const buckets = Array.from({ length: rows }, () => []);
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const lo = Math.max(0, Math.floor((Math.min(ring[i][1], ring[j][1]) - y0) / ROW_DEG));
    const hi = Math.min(rows - 1, Math.floor((Math.max(ring[i][1], ring[j][1]) - y0) / ROW_DEG));
    for (let r = lo; r <= hi; r++) buckets[r].push(i, j);
  }
  return { ring, y0, rows, buckets };
}

function inRing([x, y], { ring, y0, rows, buckets }) {
  const r = Math.floor((y - y0) / ROW_DEG);
  if (r < 0 || r >= rows) return false;
  const b = buckets[r];
  let inside = false;
  for (let k = 0; k < b.length; k += 2) {
    const [xi, yi] = ring[b[k]];
    const [xj, yj] = ring[b[k + 1]];
    if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

function polysOf(geometry) {
  const polys = (geometry.type === "Polygon" ? [geometry.coordinates] : geometry.coordinates).map(
    (rings) => {
      let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
      for (const [x, y] of rings[0]) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      return { rings: rings.map(indexRing), bbox: [x0, y0, x1, y1] };
    }
  );
  return polys;
}

function inPolys(pt, polys) {
  for (const { rings, bbox } of polys) {
    if (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3]) continue;
    if (inRing(pt, rings[0]) && !rings.slice(1).some((r) => inRing(pt, r))) return true;
  }
  return false;
}

// Inside a polygon's outer ring but excluded by one of its holes: water
// enclosed by land (a carved lake), as opposed to open sea outside every
// outer ring.
function inHoles(pt, polys) {
  for (const { rings, bbox } of polys) {
    if (pt[0] < bbox[0] || pt[0] > bbox[2] || pt[1] < bbox[1] || pt[1] > bbox[3]) continue;
    if (inRing(pt, rings[0]) && rings.slice(1).some((r) => inRing(pt, r))) return true;
  }
  return false;
}

const round4 = (v) => Math.round(v * 1e4) / 1e4;

const KM_PER_DEG = 111.32; // one degree of latitude, near enough

// Splits the nation's outer boundary into three classes:
//   coast     — open ocean on the far side; drawn blue with a soft water halo
//   lakeshore — a Great Lake the Census file carves out of the land; drawn
//               blue like the coast, but with no halo (the lake fill already
//               reads as water, so a halo just rings the lake in an off shade)
//   border    — Canada or Mexico on the far side; drawn dark
// Each boundary segment is classified by probing a pair of points offset
// perpendicular to either side, at a ladder of growing offsets, against
// Natural Earth 10m polygons. The 10m admin-0 countries assign every inland
// water body — border lakes and border rivers included — to its owning
// country, and leave only the open sea outside all of them, so the nearest
// verdict wins:
//   probe in Canada/Mexico       → border (works mid-river and mid-lake too)
//   probe in a carved-out lake   → lakeshore
//   probe outside every country  → coast (only the open sea is outside)
// A probe that lands in the US says nothing — Natural Earth may draw the
// boundary a few km from where the Census does — so the walk continues
// outward. The ladder starts small so that the class whose evidence really is
// adjacent wins: on an ocean shore the sea is met before Canada across a
// coastal channel (Lubec Narrows), while on a border river the neighbor's
// bank is met before any sea. It tops out at 3.5 km, past the worst
// Census-5m-vs-NE-10m disagreement along the border rivers.
const EPS_KM = [0.4, 0.9, 1.6, 2.5, 3.5];

// Probe-blind stretches (both probes inside the US at every offset: bays,
// domestic lakes too wide to cross) join a flanking class: a gap with the
// same class on both ends takes it outright — this is what carries the
// border across probe-blind gaps in the mountain-crest stretches — while at
// a class change each side reaches in this far and the rest reads as coast,
// matching how a border line peters out where the boundary leaves the
// neighbor's side for open water.
const FLANK_KM = 3;

// A short run boxed in by one class on both sides is generalization noise —
// absorb it. Genuine short features clear these floors: Point Roberts' 4 km
// land border stays (it sits between coast runs, above the 2 km border
// floor); a one-probe border blip where the coast grazes Campobello Island
// goes.
const ABSORB_KM = { coast: 8, lakeshore: 8, border: 2 };


// -------------------------------------------------- North America map units

// Natural Earth DBFs are UTF-8 with NUL padding on every string field.
const neClean = (v) => (typeof v === "string" ? v.replace(/\0/g, "").trim() : v);

async function readShapefileZip(url, filename) {
  const zip = unzipSync(new Uint8Array(await download(url, filename)));
  const shpName = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbfName = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  return shapefile.read(Buffer.from(zip[shpName]), Buffer.from(zip[dbfName]), {
    encoding: "utf-8",
  });
}

const NE_A1_CACHE = "ne_10m_admin_1_states_provinces_lakes.zip";
const NE_A0_CACHE = "ne_10m_admin_0_countries_lakes.zip";

const asPolys = (geometry) =>
  geometry.type === "MultiPolygon" ? geometry.coordinates : [geometry.coordinates];

// Water enclosed by land but too small to draw at map scale: a hole under
// this area gets no shoreline runs at all. These holes are border-water
// slivers pinched between two units' boundaries (tiny lakes and river
// widenings along the Guatemala–Chiapas–Belize lines); no overlay lake fills
// them, so a blue lakeshore ring would just circle a couple-km white speck.
const MIN_HOLE_KM2 = 150;

function ringAreaKm2(ring) {
  let twice = 0; // shoelace, in square degrees
  let latSum = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    twice += (ring[j][0] + ring[i][0]) * (ring[j][1] - ring[i][1]);
    latSum += ring[i][1];
  }
  const kx = KM_PER_DEG * Math.cos(((latSum / ring.length) * Math.PI) / 180);
  return (Math.abs(twice) / 2) * kx * KM_PER_DEG;
}

// ------------------------------------------------ Canada: census divisions

// Canada's county equivalents. Statistics Canada ships its boundary files in
// NAD83 / Statistics Canada Lambert (EPSG:3347), so every vertex is
// reprojected to lon/lat before it joins the rest of the map. This uses
// proj4 rather than d3's conic conformal because d3's is spherical: against
// the GRS80 ellipsoid the two disagree by kilometres at these latitudes,
// which is the same order as the simplification tolerance the whole map is
// built to respect.
const SC_LAMBERT =
  "+proj=lcc +lat_1=49 +lat_2=77 +lat_0=63.390675 +lon_0=-91.86666666666666 " +
  "+x_0=6200000 +y_0=3000000 +ellps=GRS80 +datum=NAD83 +units=m +no_defs";

// PRUID (Statistics Canada's province code) → the ISO 3166-2 id the map
// already used for the whole province, and its name. Keeping the ids means a
// division's `st` is the same province "state" the app, the presets and the
// stats table know; only the geometry underneath it got finer.
const CA_PROVINCES = new Map([
  ["10", ["CA-NL", "Newfoundland and Labrador"]],
  ["11", ["CA-PE", "Prince Edward Island"]],
  ["12", ["CA-NS", "Nova Scotia"]],
  ["13", ["CA-NB", "New Brunswick"]],
  ["24", ["CA-QC", "Quebec"]],
  ["35", ["CA-ON", "Ontario"]],
  ["46", ["CA-MB", "Manitoba"]],
  ["47", ["CA-SK", "Saskatchewan"]],
  ["48", ["CA-AB", "Alberta"]],
  ["59", ["CA-BC", "British Columbia"]],
  ["60", ["CA-YT", "Yukon"]],
  ["61", ["CA-NT", "Northwest Territories"]],
  ["62", ["CA-NU", "Nunavut"]],
]);

// StatCan's own CDNAME is just "Division No. N" for every division in
// Alberta, Saskatchewan and Manitoba — unlike Ontario or Quebec, the prairie
// provinces never got real division names. This overrides those three
// provinces' names with each division's largest city or town, the same de
// facto identity Wikipedia's per-province census division lists use.
// Hand-compiled from those lists (population centre data), not a StatCan
// field, so a name can drift out of date as a division's largest place
// changes between censuses. Keys are CDUID: PRUID + two-digit division no.
const CA_CD_NAME_OVERRIDES = new Map(
  Object.entries({
    // --- Alberta ---------------------------------------------------------
    "4801": "Medicine Hat",
    "4802": "Lethbridge",
    "4803": "Claresholm",
    "4804": "Hanna",
    "4805": "Strathmore",
    "4806": "Calgary",
    "4807": "Wainwright",
    "4808": "Red Deer",
    "4809": "Rocky Mountain House",
    "4810": "Lloydminster",
    "4811": "Edmonton",
    "4812": "Cold Lake",
    "4813": "Whitecourt",
    "4814": "Hinton",
    "4815": "Canmore",
    "4816": "Fort McMurray",
    "4817": "Slave Lake",
    "4818": "Grande Cache",
    "4819": "Grande Prairie",

    // --- Saskatchewan ------------------------------------------------------
    "4701": "Estevan",
    "4702": "Weyburn",
    "4703": "Assiniboia",
    "4704": "Maple Creek",
    "4705": "Melville",
    "4706": "Regina",
    "4707": "Moose Jaw",
    "4708": "Swift Current",
    "4709": "Yorkton",
    "4710": "Wynyard",
    "4711": "Saskatoon",
    "4712": "Battleford",
    "4713": "Kindersley",
    "4714": "Melfort",
    "4715": "Prince Albert",
    "4716": "North Battleford",
    "4717": "Lloydminster",
    "4718": "La Ronge",

    // --- Manitoba ------------------------------------------------------
    "4601": "Pinawa",
    "4602": "Steinbach",
    "4603": "Winkler",
    "4604": "Manitou",
    "4605": "Killarney",
    "4606": "Virden",
    "4607": "Brandon",
    "4608": "Treherne",
    "4609": "Portage la Prairie",
    "4610": "Elie",
    "4611": "Winnipeg",
    "4612": "Oakbank",
    "4613": "Selkirk",
    "4614": "Stonewall",
    "4615": "Neepawa",
    "4616": "Roblin",
    "4617": "Dauphin",
    "4618": "Gimli",
    "4619": "Peguis",
    "4620": "Swan River",
    "4621": "The Pas",
    "4622": "Thompson",
    "4623": "Gillam",
  })
);

const CA_CD_CACHE = "lcd_000b21a_e.zip";

async function loadCaDivisionFeatures() {
  const zip = unzipSync(new Uint8Array(await download(URLS.caGeometry, CA_CD_CACHE)));
  const shpName = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbfName = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  // The DBF declares the ANSI language driver (byte 0x57) and is
  // windows-1252, like the Census and BEA files: read as UTF-8 the 29
  // accented Quebec names come through as replacement characters
  // ("Montr<?>al").
  const fc = await shapefile.read(Buffer.from(zip[shpName]), Buffer.from(zip[dbfName]), {
    encoding: "windows-1252",
  });

  const toWgs = proj4(SC_LAMBERT, proj4.WGS84).forward;
  let points = 0;
  // Reprojected in place: the file carries millions of vertices and a second
  // copy of them all is not worth the memory.
  const project = (coords) => {
    if (typeof coords[0] === "number") {
      const [lon, lat] = toWgs(coords);
      coords[0] = lon;
      coords[1] = lat;
      points++;
      return;
    }
    for (const c of coords) project(c);
  };

  const features = fc.features.map((f) => {
    project(f.geometry.coordinates);
    const prov = CA_PROVINCES.get(f.properties.PRUID);
    if (!prov) throw new Error(`census division ${f.properties.CDUID}: unknown PRUID`);
    return {
      type: "Feature",
      id: "CA-" + f.properties.CDUID,
      properties: {
        // StatCan pads the numbered divisions ("Division No.  1"); the
        // prairie provinces get a real name from CA_CD_NAME_OVERRIDES instead.
        name:
          CA_CD_NAME_OVERRIDES.get(String(f.properties.CDUID)) ??
          neClean(f.properties.CDNAME).replace(/\s+/g, " "),
        st: prov[0],
      },
      geometry: f.geometry,
    };
  });
  console.log(
    `geometry: ${features.length} Canadian census divisions ` +
      `(${(points / 1e6).toFixed(1)}M vertices reprojected from EPSG:3347)`
  );
  return features;
}

// -------------------------------------------------- North America map units

// One paintable unit per Canadian census division, Mexican state, and
// Caribbean / Central American country. Mexican states and the countries are
// each their own initial "state" (st = its own id); a Canadian division's
// state is its province. Either way, painting a unit into a US state is what
// brings it into the union, and admitting a state whole still admits a whole
// province. Mexico stays at state level because its county equivalents
// (2,469 municipios) would roughly double the map for a use case — "what if
// Baja California were a state" — that only ever moves whole units.
async function loadNaForeignFeatures() {
  const features = [];
  const stateNames = new Map(); // foreign state id -> display name
  const naFeature = (id, name, geometry) => {
    stateNames.set(id, name);
    return { type: "Feature", id, properties: { name, st: id }, geometry };
  };

  // Canada at census division level; each one's state is its province.
  const divisions = await loadCaDivisionFeatures();
  features.push(...divisions);
  for (const [, [id, name]] of CA_PROVINCES) stateNames.set(id, name);

  // Mexico at admin-1 (states).
  const a1 = await readShapefileZip(URLS.admin1, NE_A1_CACHE);
  for (const f of a1.features) {
    if (neClean(f.properties.adm0_a3) !== "MEX") continue;
    const iso = neClean(f.properties.iso_3166_2);
    // Skips NE's placeholder units (e.g. "MX-X01~", uninhabited offshore
    // islands with no ISO code).
    if (!/^MX-[A-Z]{2,3}$/.test(iso)) {
      console.warn(`  skipping admin-1 unit "${iso}" (${neClean(f.properties.name)})`);
      continue;
    }
    const name = iso === "MX-DIF" ? "Ciudad de México" : neClean(f.properties.name);
    features.push(naFeature(iso, name, f.geometry));
  }

  // Caribbean + Central America at admin-0. Mexico is covered above;
  // Clipperton and two uninhabited reef banks aren't worth a unit; the
  // Guantanamo Bay naval base is folded back into Cuba so the coastline has
  // no hole.
  const NA_SKIP = new Set(["MEX", "CLP", "BJN", "SER", "USG"]);
  const a0fc = await readShapefileZip(URLS.admin0, NE_A0_CACHE);
  const byA3 = new Map(a0fc.features.map((f) => [neClean(f.properties.ADM0_A3), f]));
  for (const f of a0fc.features) {
    const sub = neClean(f.properties.SUBREGION);
    const a3 = neClean(f.properties.ADM0_A3);
    if (sub !== "Caribbean" && sub !== "Central America") continue;
    if (NA_SKIP.has(a3)) continue;
    let geometry = f.geometry;
    if (a3 === "CUB" && byA3.get("USG")) {
      geometry = {
        type: "MultiPolygon",
        coordinates: [...asPolys(geometry), ...asPolys(byA3.get("USG").geometry)],
      };
    }
    features.push(naFeature(a3, neClean(f.properties.ADMIN), geometry));
  }

  // The French and Dutch Caribbean islands live inside the France and
  // Netherlands admin-0 polygons (unlike Aruba, Curaçao etc., which are NE
  // features of their own); carve them out by bounding box so the Lesser
  // Antilles arc has no missing islands.
  const EXTRACT = [
    { from: "FRA", id: "GLP", name: "Guadeloupe", bbox: [-61.95, 15.7, -60.75, 16.65] },
    { from: "FRA", id: "MTQ", name: "Martinique", bbox: [-61.4, 14.3, -60.7, 15.0] },
    { from: "NLD", id: "BES", name: "Caribbean Netherlands", bbox: [-68.6, 11.9, -62.8, 17.8] },
  ];
  for (const ex of EXTRACT) {
    const src = byA3.get(ex.from);
    const hit = src
      ? asPolys(src.geometry).filter((rings) =>
          rings[0].every(
            ([x, y]) => x >= ex.bbox[0] && x <= ex.bbox[2] && y >= ex.bbox[1] && y <= ex.bbox[3]
          )
        )
      : [];
    if (hit.length)
      features.push(naFeature(ex.id, ex.name, { type: "MultiPolygon", coordinates: hit }));
    else console.warn(`  no ${ex.name} rings found in ${ex.from}`);
  }

  console.log(
    `na units: ${features.length} divisions/states/countries in ${stateNames.size} foreign states`
  );
  return { features, stateNames };
}

// ------------------------------------------- Canada: census division stats

// The 2021 Census Profile in long form: one row per (division,
// characteristic), 770k of them. These are the ones the map needs.
const CA_CHAR = {
  pop: 1, // Population, 2021
  earnN: 133, // Number of employment income recipients 15+ (25% sample)
  earnAvg: 134, // Average employment income in 2020 among recipients ($)
  mhi: 243, // Median total income of household in 2020 ($)
  eduT: 2014, // Total, highest certificate/diploma/degree, aged 25 to 64
  eduB: 2024, // Bachelor's degree or higher, aged 25 to 64
  // Visible minority (Employment Equity Act categories) and Indigenous
  // identity, both 25% sample data — see caRace() below for how these map
  // onto the US-shaped rW/rB/rN/rA/rH buckets.
  vmTotal: 1683, // Total - Visible minority for the population in private households
  vmSouthAsian: 1685,
  vmChinese: 1686,
  vmBlack: 1687,
  vmFilipino: 1688,
  vmArab: 1689,
  vmLatinAmerican: 1690,
  vmSoutheastAsian: 1691,
  vmWestAsian: 1692,
  vmKorean: 1693,
  vmJapanese: 1694,
  vmNotVisMin: 1697, // Not a visible minority
  indigenous: 1403, // Indigenous identity (single + multiple Indigenous responses)
};

// Canada asks two separate census questions where the US ASRH data this
// sits alongside asks one: visible minority (the Employment Equity Act's
// categories, which explicitly exclude "Aboriginal peoples") and Indigenous
// identity. Mapped onto the US-shaped rW/rB/rN/rA/rH buckets so a Canadian
// division plugs into the same race bar and rankings as a US county:
//
//   rN  Indigenous identity, taken directly — its own census question, not
//       a slice of visible minority.
//   rB  Visible minority: Black, taken directly.
//   rA  Visible minority: South Asian + Chinese + Filipino + Southeast
//       Asian + Korean + Japanese.
//   rH  Visible minority: Latin American — the closest available proxy for
//       the US's Hispanic-of-any-race question, though it's a different
//       kind of category there (an ethnicity that crosses race) than here
//       (one race-like group among several).
//   rW  Not a visible minority, minus Indigenous identity (StatCan's "not a
//       visible minority" bucket includes Indigenous respondents, since
//       Aboriginal identity isn't one of the visible-minority categories),
//       plus Arab and West Asian — matching current US Census Bureau
//       practice of classifying Middle Eastern/North African and Central
//       Asian origins as White rather than Asian.
//
// What's left over (visible minority n.i.e., multiple visible minorities)
// lands in the race bar's "Other" slice, same as the US bar's uncounted NH
// Pacific Islander/two-or-more-races/some-other-race. Unlike the foreign
// units' bachPct/mhi, this is a real headcount, not an estimate — just
// bucketed differently than the categories it sits alongside in the app.
function caRace(p) {
  if (p.vmTotal == null) return { rT: 0, rW: 0, rB: 0, rN: 0, rA: 0, rH: 0 };
  const indig = p.indigenous ?? 0;
  return {
    rT: p.vmTotal,
    rW: Math.max(0, (p.vmNotVisMin ?? 0) - indig) + (p.vmArab ?? 0) + (p.vmWestAsian ?? 0),
    rB: p.vmBlack ?? 0,
    rN: indig,
    rA:
      (p.vmSouthAsian ?? 0) +
      (p.vmChinese ?? 0) +
      (p.vmFilipino ?? 0) +
      (p.vmSoutheastAsian ?? 0) +
      (p.vmKorean ?? 0) +
      (p.vmJapanese ?? 0),
    rH: p.vmLatinAmerican ?? 0,
  };
}

const CA_PROFILE_CACHE = "ca-census-profile-cd.zip";

// Statistics Canada quotes any field that might contain a comma, and census
// division names do ("Division No. 1, Subd. V"), so the rows need a real CSV
// split rather than a slice on commas.
function splitCsvRow(line) {
  const out = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (quoted) {
      if (ch !== '"') field += ch;
      else if (line[i + 1] === '"') (field += '"'), i++;
      else quoted = false;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") (out.push(field), (field = ""));
    else field += ch;
  }
  out.push(field);
  return out;
}

async function loadCaProfile() {
  const zip = unzipSync(new Uint8Array(await download(URLS.caProfile, CA_PROFILE_CACHE)));
  const csvName = Object.keys(zip).find((n) => /_data\.csv$/i.test(n));
  const buf = Buffer.from(zip[csvName]);
  const wanted = new Map(Object.entries(CA_CHAR).map(([key, id]) => [id, key]));

  const cd = new Map(); // CDUID -> { pop, earnN, earnAvg, mhi, eduT, eduB }
  const take = (line) => {
    const row = splitCsvRow(line);
    if (row[3] !== "Census division") return;
    const key = wanted.get(+row[8]);
    if (!key) return;
    if (!cd.has(row[2])) cd.set(row[2], {});
    // Suppressed and not-applicable cells are blank or an "x"/"F" symbol.
    const v = +row[11];
    cd.get(row[2])[key] = row[11] !== "" && Number.isFinite(v) ? v : null;
  };

  // 138 MB decoded — past V8's maximum string length, so it is read in chunks
  // cut at newline bytes (cutting anywhere else would split a multi-byte
  // character and mangle the accented division names).
  for (let start = 0; start < buf.length; ) {
    let end = Math.min(start + (1 << 22), buf.length);
    if (end < buf.length) {
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl > start) end = nl + 1;
    }
    for (const line of buf.toString("utf8", start, end).split("\n")) {
      if (line) take(line);
    }
    start = end;
  }
  console.log(`ca profile: ${cd.size} census divisions`);
  return cd;
}

// Population by census division, on the same 2021 boundaries as the geometry,
// so the two join by division id. This is real per-division data rather than
// anything apportioned, and it is the same vintage as the US county estimates
// the map ranks it against.
const CA_POP_CACHE = "ca-cd-population.zip";

async function loadCaPopulation() {
  const zip = unzipSync(new Uint8Array(await download(URLS.caPopulation, CA_POP_CACHE)));
  const csvName = Object.keys(zip).find((n) => /^\d+\.csv$/i.test(n));
  const buf = Buffer.from(zip[csvName]);

  // 382 MB decoded, nearly all of it age and gender breakdowns we don't want,
  // so it is scanned by newline-aligned chunks like the census profile above
  // and only the whole-population rows are split into fields.
  const byYear = new Map(); // year -> Map(CDUID -> people)
  let header = null;
  for (let start = 0; start < buf.length; ) {
    let end = Math.min(start + (1 << 22), buf.length);
    if (end < buf.length) {
      const nl = buf.lastIndexOf(0x0a, end - 1);
      if (nl > start) end = nl + 1;
    }
    for (const line of buf.toString("utf8", start, end).split("\n")) {
      if (!line) continue;
      if (!header) {
        header = splitCsvRow(line.replace(/^﻿/, "")).map((h) => h.replace(/"/g, ""));
        continue;
      }
      if (!line.includes('"Total - gender","All ages"')) continue;
      const row = splitCsvRow(line);
      // Division DGUIDs are 2021A0003 + the four-digit division id; the
      // province and country rows carry shorter ones and drop out here.
      const m = /^2021A0003(\d{4})$/.exec(row[header.indexOf("DGUID")]);
      if (!m) continue;
      const year = row[0];
      if (!byYear.has(year)) byYear.set(year, new Map());
      byYear.get(year).set(m[1], +row[header.indexOf("VALUE")]);
    }
    start = end;
  }

  const year = [...byYear.keys()].sort().pop();
  const pop = byYear.get(year);
  console.log(`ca population: ${pop.size} census divisions, July ${year} estimates`);
  return { pop, year: +year };
}

// Provincial income from tax records, used only as a growth factor. The map
// needs a division-level household median, and the 2021 census is the only
// place that exists — but it measures income received in 2020, three years
// before the US SAIPE figures it gets ranked against, and 2020 was the CERB
// year, so Canadian household income peaked in exactly the year the census
// happened to catch.
//
// So each province's divisions are carried forward by that province's own
// change in median income from 2020 to 2023. Because the same series supplies
// both endpoints, the CERB bulge is in the denominator too and cancels; and
// because the T1 Family File is administrative data in current dollars, the
// ratio is nominal growth directly, with no separate inflation step. The
// survey-based income tables would not do here: they are published in
// constant dollars, so their ratio is real growth.
//
// Tax records group people as census families and as persons not in a census
// family, neither of which is a household. That mismatch is why this is a
// ratio and not a level: the two groups are blended by their counts into one
// household-shaped composite, and whatever the composite's level gets wrong
// about households divides out between the two years.
const CA_INCOME_CACHE = "ca-prov-taxfiler-income.zip";
const CA_INCOME_FROM = "2020"; // the census income year
const CA_INCOME_TO = "2023"; // matches the US SAIPE year

async function loadCaIncomeGrowth() {
  const zip = unzipSync(new Uint8Array(await download(URLS.caIncome, CA_INCOME_CACHE)));
  const csvName = Object.keys(zip).find((n) => /^\d+\.csv$/i.test(n));
  const rows = csvParseRows(Buffer.from(zip[csvName]).toString("utf8").replace(/^﻿/, ""));
  const head = rows[0];
  const col = { ref: 0, geo: head.indexOf("GEO"), char: head.indexOf("Family characteristics"), val: head.indexOf("VALUE") };

  const WANT = {
    famN: "All families",
    famMed: "Median total income, all families",
    singN: "Persons not in census families",
    singMed: "Median total income of persons not in census families with income",
  };
  const byName = new Map([...CA_PROVINCES.values()].map(([id, name]) => [name, id]));
  // The table writes Quebec with its accent where the map does not.
  byName.set("Québec", "CA-QC");

  const cell = new Map(); // `${province}|${year}|${key}` -> value
  for (const r of rows.slice(1)) {
    const province = byName.get(r[col.geo]);
    if (!province || (r[col.ref] !== CA_INCOME_FROM && r[col.ref] !== CA_INCOME_TO)) continue;
    const key = Object.keys(WANT).find((k) => WANT[k] === r[col.char]);
    if (key) cell.set(`${province}|${r[col.ref]}|${key}`, +r[col.val]);
  }

  const growth = new Map();
  for (const [, [province]] of CA_PROVINCES) {
    // Mean income across both unit types, weighted by how many of each there
    // are: a stand-in for "the typical household" that both years share.
    const level = (year) => {
      const g = (k) => cell.get(`${province}|${year}|${k}`);
      const n = g("famN") + g("singN");
      return n ? (g("famN") * g("famMed") + g("singN") * g("singMed")) / n : NaN;
    };
    const factor = level(CA_INCOME_TO) / level(CA_INCOME_FROM);
    if (!Number.isFinite(factor)) {
      console.warn(`  no income growth factor for ${province}; leaving its divisions at census level`);
      growth.set(province, 1);
    } else growth.set(province, factor);
  }
  console.log(
    `ca income: ${CA_INCOME_FROM}→${CA_INCOME_TO} growth ` +
      [...growth].map(([p, f]) => `${p.slice(3)} ${f.toFixed(3)}`).join(" ")
  );
  return growth;
}

// Life expectancy at birth, both sexes, per province/territory — the "for
// now" fallback every Canadian division gets unless a finer source overrides
// it below. Two StatCan tables cover disjoint geographies: 13-10-0114 (three-
// year complete life tables) covers Canada and every province but PEI;
// 13-10-0140 (three-year abridged life tables) covers exactly PEI and the
// three territories, a small-population methodology split rather than a
// coverage gap. Every province reads the same period — the newest one either
// table actually publishes a value for — rather than each hunting for its
// own latest, so a suppressed geography goes without a value instead of a
// stale one: Yukon's ex has been suppressed since the 2015/2017 window, so
// it carries none rather than a decade-old figure sitting next to everyone
// else's current one.
async function loadCaProvinceLifeExpectancy() {
  const byName = new Map([...CA_PROVINCES.values()].map(([id, name]) => [name, id]));
  byName.set("Québec", "CA-QC");

  const collect = (rows, ageKey) => {
    const out = [];
    for (const r of rows) {
      if (r[ageKey] !== "0 years" || r.Sex !== "Both sexes") continue;
      if (!r.Element.startsWith("Life expectancy")) continue;
      if (r.VALUE === "") continue;
      const value = +r.VALUE;
      if (!Number.isFinite(value)) continue;
      out.push({ geo: r.GEO, period: r.REF_DATE, value });
    }
    return out;
  };

  const readTable = async (url, cacheName) => {
    const zip = unzipSync(new Uint8Array(await download(url, cacheName)));
    const csvName = Object.keys(zip).find((n) => /^\d+\.csv$/i.test(n));
    return csvParse(Buffer.from(zip[csvName]).toString("utf8").replace(/^﻿/, ""));
  };

  const readings = [
    ...collect(await readTable(URLS.caLifeProv, "ca-life-provinces.zip"), "Age group"),
    ...collect(await readTable(URLS.caLifeTerr, "ca-life-territories.zip"), "Age interval"),
  ];
  const period = readings.reduce((a, r) => (r.period > a ? r.period : a), "");
  const byGeo = new Map(readings.filter((r) => r.period === period).map((r) => [r.geo, r.value]));

  const life = new Map(); // province id -> years
  for (const [geo, id] of byName) {
    if (byGeo.has(geo)) life.set(id, byGeo.get(geo));
  }
  for (const [, [id, name]] of CA_PROVINCES) {
    if (!life.has(id)) console.warn(`  no ${period} life expectancy value for ${name}`);
  }
  console.log(`ca province life expectancy: ${life.size}/13 provinces & territories, ${period}`);
  return life;
}

// Alberta census-subdivision-level life expectancy, refining the provincial
// fallback above for Alberta's 19 divisions. Hand-exported from Alberta
// Health's Interactive Health Data Application, which has no stable direct-
// download URL — a checked-in file rather than a live fetch, the same reason
// na-unit-data.mjs is hand-compiled instead of downloaded.
// Aggregated up to census-division level as an unweighted mean of its
// municipalities: the file carries no municipal population to weight by, and
// StatCan publishes no population estimate below census division between
// censuses to borrow one from. A division that mixes a small hamlet with a
// city weighs them equally for now — real municipal-level data at ~15
// municipalities per division all the same, against the single provincial
// figure every other division gets.
function loadAbLifeExpectancy() {
  const text = readFileSync(join(root, "scripts", "ca-ab-life-expectancy.csv"), "utf8");
  const rows = csvParse(text);

  // Coverage varies by year — the latest is still filling in — so pick the
  // most recent year with "Both" sexes rows for at least 90% of Alberta's
  // CSDs, rather than a hardcoded year, so a refreshed export just works.
  const totalCsds = new Set(rows.map((r) => r.CSDUID)).size;
  const years = [...new Set(rows.map((r) => r.Period))].sort();
  const year = [...years].reverse().find((y) => {
    const n = new Set(
      rows.filter((r) => r.Period === y && r.Gender === "Both").map((r) => r.CSDUID)
    ).size;
    return n / totalCsds >= 0.9;
  });
  if (!year) throw new Error("no Alberta life-expectancy year clears 90% CSD coverage");

  const byDivision = new Map(); // CDUID -> values[]
  for (const r of rows) {
    if (r.Period !== year || r.Gender !== "Both") continue;
    const value = +r.OriginalValue;
    if (!Number.isFinite(value)) continue;
    const cduid = r.CSDUID.slice(0, 4);
    if (!byDivision.has(cduid)) byDivision.set(cduid, []);
    byDivision.get(cduid).push(value);
  }

  const life = new Map(); // CDUID -> years
  let nCsd = 0;
  for (const [cduid, values] of byDivision) {
    life.set(cduid, values.reduce((a, b) => a + b, 0) / values.length);
    nCsd += values.length;
  }
  console.log(
    `ca-ab life expectancy: ${life.size} census divisions from ${nCsd} municipalities, ${year}`
  );
  return life;
}

// BC's 89 Local Health Areas (LHAs), the province's own health-reporting
// geography, refining the provincial fallback for BC the way Alberta's
// municipalities do for Alberta. Life expectancy by LHA is hand-downloaded
// as scripts/ca-bc-life-expectancy.csv (BC Vital Statistics has no stable
// direct-download URL either). Unlike Alberta's municipalities, though, an
// LHA carries no census code that nests inside a census division, and its
// name alone doesn't reliably say which regional district it's in (Kettle
// Valley, Snow Country) — so each LHA polygon, downloaded from the BC
// Geographic Warehouse, is matched by sampling an 8x8 grid of points across
// it against BC's own division polygons (the same trick buildNaOverlays uses
// to classify carved lakes) and taking whichever division wins the most
// samples.
const BC_LHA_DIVISION_OVERRIDE = new Map([
  // Area, not population, decides the sampled winner, which is usually right
  // but not here: Maple Ridge and Pitt Meadows are both Metro Vancouver
  // municipalities, but most of this LHA's land is Fraser Valley Regional
  // District backcountry along the upper Pitt/Alouette watersheds, which is
  // what an area-majority sample actually picks.
  ["Maple Ridge/Pitt Meadows", "CA-5915"], // Greater Vancouver
]);

async function loadBcLifeExpectancy(bcDivisionFeatures) {
  const text = readFileSync(join(root, "scripts", "ca-bc-life-expectancy.csv"), "utf8");
  const byLha = new Map(); // LHA name -> years
  for (const r of csvParse(text)) {
    const value = +r.LifeExpectancy;
    if (Number.isFinite(value)) byLha.set(r.LHA, value);
  }

  const lhaFc = JSON.parse(
    Buffer.from(await download(URLS.bcLha, "bc-local-health-areas.json")).toString("utf8")
  );

  const divisions = bcDivisionFeatures.map((f) => ({ id: f.id, polys: polysOf(f.geometry) }));
  const divisionAt = (pt) => divisions.find((d) => inPolys(pt, d.polys))?.id;

  const sampleDivision = (geometry) => {
    const polys = polysOf(geometry);
    const [x0, y0, x1, y1] = polys.reduce(
      (b, p) => [
        Math.min(b[0], p.bbox[0]), Math.min(b[1], p.bbox[1]),
        Math.max(b[2], p.bbox[2]), Math.max(b[3], p.bbox[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity]
    );
    const counts = new Map();
    for (let gx = 0; gx < 8; gx++) {
      for (let gy = 0; gy < 8; gy++) {
        const pt = [x0 + ((gx + 0.5) / 8) * (x1 - x0), y0 + ((gy + 0.5) / 8) * (y1 - y0)];
        if (!inPolys(pt, polys)) continue;
        const id = divisionAt(pt);
        if (id) counts.set(id, (counts.get(id) ?? 0) + 1);
      }
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  };

  const byDivision = new Map(); // CDUID -> values[]
  let nLha = 0;
  for (const f of lhaFc.features) {
    const name = f.properties.LOCAL_HLTH_AREA_NAME;
    const value = byLha.get(name);
    if (value === undefined) continue; // no CSV row, or suppressed ("N/A")

    const division = BC_LHA_DIVISION_OVERRIDE.get(name) ?? sampleDivision(f.geometry);
    if (!division) {
      console.warn(`  BC LHA "${name}" sampled no division`);
      continue;
    }
    const cduid = division.slice(3);
    if (!byDivision.has(cduid)) byDivision.set(cduid, []);
    byDivision.get(cduid).push(value);
    nLha++;
  }

  const matchedNames = new Set(lhaFc.features.map((f) => f.properties.LOCAL_HLTH_AREA_NAME));
  for (const name of byLha.keys()) {
    if (!matchedNames.has(name))
      console.warn(`  BC life expectancy row "${name}" matched no LHA boundary`);
  }

  const life = new Map(); // CDUID -> years
  for (const [cduid, values] of byDivision) {
    life.set(cduid, values.reduce((a, b) => a + b, 0) / values.length);
  }
  console.log(`ca-bc life expectancy: ${life.size} census divisions from ${nLha} local health areas`);
  return life;
}

// The Canadian dollar rate na-unit-data.mjs used for provincial GDP. Applied
// to household income too, so the two Canadian money stats sit on the same
// footing against the US ones. Deliberately the market rate and not purchasing
// power parity: the map's question is what a province would look like as a
// state, and joining the union would not change anybody's pay.
const CAD_USD = 0.74;

// Statistics Canada publishes no GDP below the province, so each province's
// published total is split across its divisions by their share of aggregate
// employment income (recipients x average earnings) — the finest-grained
// measure of where a province's earnings actually are. That keeps the
// provincial total exactly as it was when the whole province was one unit:
// only the split inside it is an estimate. Population needs no such trick —
// it is published per division — and income is the census median carried
// forward by the province's growth factor.
function apportionCaDivisions(divisions, profile, population, growth, provLife, abLife, bcLife) {
  const byProvince = new Map();
  for (const f of divisions) {
    if (!byProvince.has(f.properties.st)) byProvince.set(f.properties.st, []);
    byProvince.get(f.properties.st).push(f);
  }

  const rows = new Map();
  const noProfile = [];
  const noPop = [];
  for (const [province, feats] of byProvince) {
    const total = NA_UNIT_STATS.get(province);
    if (!total) console.warn(`  no provincial GDP control total for ${province}`);
    const provGdp = total?.gdp ?? 0;
    const factor = growth.get(province) ?? 1;
    const d = feats.map((f) => {
      const p = profile.get(f.id.slice(3));
      if (!p) noProfile.push(f.id);
      return p ?? {};
    });
    const pops = feats.map((f) => {
      const p = population.get(f.id.slice(3));
      if (p === undefined) noPop.push(f.id);
      return p ?? 0;
    });

    // A division whose earnings are suppressed falls back to its population
    // times the province's earnings per head, so the shares still sum to one.
    const earned = d.map((p) => (p.earnN > 0 && p.earnAvg > 0 ? p.earnN * p.earnAvg : null));
    const knownEarn = earned.reduce((a, e) => a + (e ?? 0), 0);
    const knownPop = earned.reduce((a, e, i) => a + (e === null ? 0 : pops[i]), 0);
    const perHead = knownPop ? knownEarn / knownPop : 0;
    const weights = earned.map((e, i) => e ?? pops[i] * perHead);
    const weightSum = weights.reduce((a, b) => a + b, 0);

    feats.forEach((f, i) => {
      rows.set(f.id, {
        pop: pops[i],
        gdp: weightSum ? Math.round((provGdp * weights[i]) / weightSum) : 0,
        mhi: d[i].mhi ? Math.round(d[i].mhi * factor * CAD_USD) : null,
        eduT: d[i].eduT ?? 0,
        eduB: d[i].eduB ?? 0,
        ...caRace(d[i]),
        // Alberta and BC's divisions get their own finer-grained aggregate;
        // every other division falls back to its province's StatCan figure.
        life:
          abLife.get(f.id.slice(3)) ??
          bcLife.get(f.id.slice(3)) ??
          provLife.get(province) ??
          null,
      });
    });
  }
  if (noProfile.length)
    console.warn(`  no census profile for ${noProfile.length} divisions: ${noProfile.join(", ")}`);
  if (noPop.length)
    console.warn(`  no population estimate for ${noPop.length} divisions: ${noPop.join(", ")}`);
  return rows;
}

// ------------------------------------------------------------- na overlays

// The North America map's boundary and seam data. The foreign units come
// from Statistics Canada and Natural Earth while the US counties come from
// the Census, so the two sides of the US land border don't share TopoJSON
// arcs — this is true of the Canadian side and the Mexican side alike. Rather
// than
// conflate the geometries (boolean ops, snapping — the expensive path), the
// map hides the mismatch at render time; this build emits what that takes:
//
//   boundary  — the map's outer edge as classified runs {cls, region, unit,
//               line}: coast (blue + halo), lakeshore (blue), border (dark:
//               land beyond the map's units, i.e. Panama–Colombia). Runs
//               carry the region (main/ak/hi) of the unit that owns them, so
//               the client knows which ones to duplicate into the insets,
//               and the owning unit's id, so the map-edge border band can
//               follow that unit's union status. Emitting the seam as its
//               own class (below) is what keeps these runs to the band-worthy
//               stretches of an arc that carries both seam and coast (San
//               Diego, the North Slope).
//   seams     — the US side of the Canada/Mexico land border, split per
//               (county, foreign unit) pair. The app appends these to its
//               border-segment list, so the seam renders and filters exactly
//               like an interior state border: paint Alberta into Montana's
//               state and the line disappears. The pairs double as the
//               cross-border adjacency the shared-arc walk can't see.
//
// The classification machinery (probe ladders, gap filling, run absorption)
// is the same approach as buildOverlays above, generalized to more classes.
async function buildNaOverlays(topo, foreignIds) {
  const geoms = topo.objects.counties.geometries;
  const feats = feature(topo, topo.objects.counties).features;
  const featById = new Map(feats.map((f) => [f.id, f]));
  const stOf = (g) => g.properties.st;
  const isForeign = (g) => foreignIds.has(g.id);

  // Probe sets. All are built from the simplified topology, so probes agree
  // with what the map actually draws.
  const foreignProbe = [...foreignIds].map((id) => ({
    id,
    polys: polysOf(featById.get(id).geometry),
  }));
  const foreignAt = (pt) => {
    for (const u of foreignProbe) if (inPolys(pt, u.polys)) return u.id;
    return null;
  };
  const usPolys = polysOf(merge(topo, geoms.filter((g) => !isForeign(g))));
  const mergedLand = merge(topo, geoms);
  const allLandPolys = polysOf(mergedLand);

  // The merged land's sub-MIN_HOLE_KM2 holes (see the constant above). Their
  // rings leave the boundary entirely, two ways: an arc whose every vertex
  // lies on such a ring IS the ring and is dropped before classification
  // (simplification pinches these slivers thinner than the first probe rung,
  // so probing alone can't see them), and any probe that does land inside one
  // classifies as "skip" rather than lakeshore.
  const tinyHoles = [];
  const tinyHoleVerts = new Set();
  for (const rings of mergedLand.type === "Polygon" ? [mergedLand.coordinates] : mergedLand.coordinates) {
    for (let i = 1; i < rings.length; i++) {
      if (ringAreaKm2(rings[i]) >= MIN_HOLE_KM2) continue;
      tinyHoles.push(indexRing(rings[i]));
      for (const [x, y] of rings[i]) tinyHoleVerts.add(x + "," + y);
    }
  }
  const inTinyHole = (pt) => tinyHoles.some((r) => inRing(pt, r));

  // Land beyond the map's own units: a probe landing there means a fixed
  // dark border (Panama–Colombia; Ellesmere faces Greenland across a strait
  // just wide enough that only Hans Island can trigger it).
  const world = JSON.parse((await download(URLS.world, "countries-10m.json")).toString("utf8"));
  const worldFeats = feature(world, world.objects.countries).features;
  const offMap = worldFeats
    .filter((f) => ["Colombia", "Venezuela", "Greenland"].includes(f.properties.name))
    .flatMap((f) => polysOf(f.geometry));

  // "Probe is over water" needs care along the land border: the Census line
  // and the Natural Earth line disagree by up to a few km, and a probe in
  // that hairline gap is inside neither source's land — it must keep walking
  // the ladder, not read as coast. Natural Earth's own US polygon edge-
  // matches the NE Canada/Mexico polygons, so adding it to the land test
  // closes the gap; only genuinely open water stays outside everything.
  const classifyLand = [
    ...allLandPolys,
    ...worldFeats
      .filter((f) => f.properties.name === "United States of America")
      .flatMap((f) => polysOf(f.geometry)),
  ];

  // Notable lakes, as in buildOverlays, plus the big Canadian lakes and the
  // Nicaraguan pair. Whether a lake is carved out of the map's land (drawn
  // under the fills) or sits inside unit polygons (drawn on top) is sampled
  // rather than assumed, so it adapts to how Natural Earth drew each unit.
  // A lake that's carved on one side of the border but covered on the other
  // (Lake of the Woods) draws on top, which reads correctly on both sides.
  const zip = unzipSync(new Uint8Array(await download(URLS.lakes, "ne_10m_lakes.zip")));
  const shpName = Object.keys(zip).find((n) => n.endsWith(".shp"));
  const dbfName = Object.keys(zip).find((n) => n.endsWith(".dbf"));
  const lakesFc = await shapefile.read(Buffer.from(zip[shpName]), Buffer.from(zip[dbfName]));
  // Each entry is one lake as a group of name aliases; a group left unmatched
  // at the end of the scan is warned about, so a rename on Natural Earth's
  // side can't silently drop a lake from the map. Lakes Natural Earth has no
  // feature for at all are listed separately, in CENSUS_LAKES (geo-lib.mjs).
  const WANTED_GROUPS = [
    ["lake superior"], ["lake michigan"], ["lake huron"], ["lake erie"],
    ["lake ontario"], ["lake st clair"], ["great salt lake"], ["lake champlain"],
    ["lake okeechobee"], ["salton sea"], ["lake tahoe"], ["lake of the woods"],
    ["lake winnipeg"], ["lake winnipegosis"], ["lake manitoba"],
    ["great bear lake"], ["great slave lake"], ["lake athabasca"],
    ["reindeer lake"], ["lake nipigon"],
    ["lago de nicaragua", "lake nicaragua"], ["lago de managua", "lake managua"],
  ];
  const WANTED = new Map(); // normalized alias -> group index
  WANTED_GROUPS.forEach((g, i) => g.forEach((n) => WANTED.set(n, i)));
  const matched = new Set();
  const normName = (s) =>
    (s ?? "").toLowerCase().replace(/\bsaint\b/g, "st").replace(/[^a-z ]/g, "").replace(/\s+/g, " ").trim();

  const rawLakeFeatures = [];
  const carvedLakes = [];
  // Sample the lake's own area against the map's land to decide which side of
  // the county fills it is drawn on, then keep it.
  const addLake = (name, geometry) => {
    const lakePolys = polysOf(geometry);
    const [x0, y0, x1, y1] = lakePolys.reduce(
      (b, p) => [
        Math.min(b[0], p.bbox[0]), Math.min(b[1], p.bbox[1]),
        Math.max(b[2], p.bbox[2]), Math.max(b[3], p.bbox[3]),
      ],
      [Infinity, Infinity, -Infinity, -Infinity]
    );
    let inLake = 0, onLand = 0;
    for (let gx = 0; gx < 8; gx++) {
      for (let gy = 0; gy < 8; gy++) {
        const pt = [x0 + ((gx + 0.5) / 8) * (x1 - x0), y0 + ((gy + 0.5) / 8) * (y1 - y0)];
        if (!inPolys(pt, lakePolys)) continue;
        inLake++;
        if (inPolys(pt, allLandPolys)) onLand++;
      }
    }
    const onland = inLake > 0 && onLand / inLake > 0.15;
    if (!onland) carvedLakes.push(...lakePolys);
    rawLakeFeatures.push({ type: "Feature", properties: { name, onland }, geometry });
  };

  for (const f of lakesFc.features) {
    const group = WANTED.get(normName(f.properties.name));
    if (group === undefined) continue;
    const [cx] = f.geometry.coordinates.flat(f.geometry.type === "MultiPolygon" ? 2 : 1)[0];
    if (cx > -55 || cx < -170) continue; // same-named lakes elsewhere in the world
    matched.add(group);
    addLake(f.properties.name, f.geometry);
  }
  for (let i = 0; i < WANTED_GROUPS.length; i++) {
    if (!matched.has(i))
      console.warn(`  no Natural Earth lake matched "${WANTED_GROUPS[i][0]}"`);
  }
  // The lakes Natural Earth doesn't carry (see CENSUS_LAKES). These go through
  // the same land sampling as the rest, so a Census lake the map's units cover
  // draws over the fills exactly the way Okeechobee does.
  for (const f of await loadCensusLakes(readShapefileZip))
    addLake(f.properties.name, f.geometry);

  // These used to be thinned at SIMPLIFY_METRES like the land, on the argument
  // that a full-detail lake would read as conspicuously wiggly against the
  // generalized shorelines around it. It cost half the source points (12,032 →
  // 5,925) and took the median segment from 1.5 km to 3.6 km, which is under a
  // pixel at the default view but 12 px at the 16x maximum: the lakes drawn
  // over the fills went visibly polygonal as you zoomed in. Natural Earth 10m
  // is the finest tier NE publishes, so its 1.5 km is the floor here whatever
  // we do; there is no reason to give away half of it. Full detail costs 6,107
  // points against ~309k line segments in the compiled globe geometry.
  //
  // Set LAKE_SIMPLIFY_METRES above 0 to thin them again — the pipeline is the
  // same Visvalingam pass the land runs.
  const LAKE_SIMPLIFY_METRES = 0;
  let lakeFeatures = rawLakeFeatures;
  if (rawLakeFeatures.length && LAKE_SIMPLIFY_METRES > 0) {
    const lakeTopo = topology({
      lakes: { type: "FeatureCollection", features: rawLakeFeatures },
    });
    const { topo: thinned } = simplifyArcs(
      presimplify(lakeTopo, sphericalTriangleArea),
      (LAKE_SIMPLIFY_METRES / 1000) ** 2 / 2 / EARTH_RADIUS_KM ** 2
    );
    lakeFeatures = feature(thinned, thinned.objects.lakes).features;
  }
  const roundRings = (rings) => rings.map((ring) => ring.map(([x, y]) => [round4(x), round4(y)]));
  for (const f of lakeFeatures) {
    f.geometry.coordinates =
      f.geometry.type === "MultiPolygon"
        ? f.geometry.coordinates.map(roundRings)
        : roundRings(f.geometry.coordinates);
  }
  console.log(
    `na overlays: ${lakeFeatures.length} lakes (${lakeFeatures.filter((f) => f.properties.onland).length} drawn over land)`
  );

  // Decode arcs to absolute lon/lat.
  const { scale, translate } = topo.transform;
  const decodeArc = (arc) => {
    let x = 0, y = 0;
    return arc.map(([dx, dy]) => {
      x += dx;
      y += dy;
      return [x * scale[0] + translate[0], y * scale[1] + translate[1]];
    });
  };

  // Arcs used by exactly one unit are the map's outer boundary (the two
  // sides of the US land border both count, since they don't share arcs).
  const use = new Array(topo.arcs.length).fill(0);
  const owner = new Array(topo.arcs.length).fill(-1);
  geoms.forEach((g, gi) => {
    const walk = (arcs) =>
      arcs.forEach((a) => {
        if (Array.isArray(a)) walk(a);
        else {
          const i = a < 0 ? ~a : a;
          use[i]++;
          if (owner[i] < 0) owner[i] = gi;
        }
      });
    walk(g.arcs);
  });

  // Class priority within one probe rung mirrors buildOverlays: a neighbor
  // across the line beats a lake beats open water. "seam|<unit>" is the US
  // side of the land border; "seamadj" is its foreign side (not drawn).
  const classify = (mx, my, nx, ny, kind) => {
    const kx = KM_PER_DEG * Math.cos((my * Math.PI) / 180);
    for (const eps of EPS_KM) {
      const a = [mx + (nx * eps) / kx, my + (ny * eps) / KM_PER_DEG];
      const b = [mx - (nx * eps) / kx, my - (ny * eps) / KM_PER_DEG];
      if (kind === "foreign") {
        if (inPolys(a, usPolys) || inPolys(b, usPolys)) return "seamadj";
      } else {
        const f = foreignAt(a) ?? foreignAt(b);
        if (f) return "seam|" + f;
      }
      if (inPolys(a, carvedLakes) || inPolys(b, carvedLakes)) return "lakeshore";
      if (inPolys(a, offMap) || inPolys(b, offMap)) return "border";
      const aOut = !inPolys(a, classifyLand);
      const bOut = !inPolys(b, classifyLand);
      if (aOut || bOut) {
        // A probe outside every land polygon can still be enclosed water:
        // the carved lakes are holes in the map's merged land, and the NE
        // lake polygons don't cover every fringe bay of them (the North
        // Channel archipelago, say). Water inside a hole is lakeshore, not
        // ocean — without this those slivers read as coast and wear the
        // ocean halo in the middle of a lake. A hole too small to draw is
        // "skip" instead: its ring leaves the boundary entirely.
        if ((aOut && inTinyHole(a)) || (bOut && inTinyHole(b))) return "skip";
        if ((aOut && inHoles(a, allLandPolys)) || (bOut && inHoles(b, allLandPolys)))
          return "lakeshore";
        return "coast";
      }
    }
    return null;
  };
  const absorbLimit = (cls) => (cls.startsWith("seam") ? 2 : ABSORB_KM[cls]);

  const boundary = []; // { cls, region, unit, line }
  const seams = []; // { c, f, line }
  const nSegs = { coast: 0, lakeshore: 0, border: 0, seam: 0 };
  const roundLine = (line) => line.map(([x, y]) => [round4(x), round4(y)]);

  for (let i = 0; i < topo.arcs.length; i++) {
    if (use[i] !== 1) continue;
    const g = geoms[owner[i]];
    const kind = isForeign(g) ? "foreign" : "us";
    const region = isForeign(g) ? "main" : stOf(g) === "02" ? "ak" : stOf(g) === "15" ? "hi" : "main";
    const pts = decodeArc(topo.arcs[i]);
    // An arc of a sub-scale hole ring (see tinyHoles above) is not a boundary.
    if (pts.every(([x, y]) => tinyHoleVerts.has(x + "," + y))) continue;
    const cls = [];
    const segKm = [];
    for (let s = 0; s < pts.length - 1; s++) {
      const [ax, ay] = pts[s];
      const [bx, by] = pts[s + 1];
      const sx = (bx - ax) * KM_PER_DEG * Math.cos((((ay + by) / 2) * Math.PI) / 180);
      const sy = (by - ay) * KM_PER_DEG;
      const len = Math.hypot(sx, sy);
      segKm.push(len);
      cls.push(len ? classify((ax + bx) / 2, (ay + by) / 2, -sy / len, sx / len, kind) : null);
    }

    // Fill probe-blind gaps (see FLANK_KM above).
    for (let s = 0; s < cls.length; ) {
      if (cls[s] !== null) {
        s++;
        continue;
      }
      let e = s;
      while (e < cls.length && cls[e] === null) e++;
      const left = s > 0 ? cls[s - 1] : null;
      const right = e < cls.length ? cls[e] : null;
      if (left && left === right) {
        for (let k = s; k < e; k++) cls[k] = left;
      } else {
        if (left) {
          for (let k = s, km = 0; k < e && km < FLANK_KM; km += segKm[k], k++) cls[k] = left;
        }
        if (right) {
          for (let k = e - 1, km = 0; k >= s && km < FLANK_KM && !cls[k]; km += segKm[k], k--) cls[k] = right;
        }
        for (let k = s; k < e; k++) cls[k] ??= "coast";
      }
      s = e;
    }

    // Collapse runs, then absorb sandwiched short ones.
    const runs = [];
    for (let s = 0; s < cls.length; s++) {
      const last = runs.at(-1);
      if (last && last.cls === cls[s]) {
        last.end = s;
        last.km += segKm[s];
      } else {
        runs.push({ cls: cls[s], start: s, end: s, km: segKm[s] });
      }
    }
    for (let changed = true; changed; ) {
      changed = false;
      for (let r = 1; r < runs.length - 1; r++) {
        if (runs[r - 1].cls === runs[r + 1].cls && runs[r].km < absorbLimit(runs[r].cls)) {
          runs[r - 1].end = runs[r + 1].end;
          runs[r - 1].km += runs[r].km + runs[r + 1].km;
          runs.splice(r, 2);
          changed = true;
          break;
        }
      }
    }

    // On a closed ring (an island, a carved lake) the first and last runs
    // are neighbors too, which the interior-only pass above can't see — a
    // short blip touching the ring's start point would survive however it's
    // boxed in. Absorb across the ring's seam as well; the absorber keeps
    // its own contiguous point range, so the two same-class pieces flanking
    // the seam emit as separate lines that meet at the start point.
    const closed =
      pts.length > 2 &&
      pts[0][0] === pts[pts.length - 1][0] &&
      pts[0][1] === pts[pts.length - 1][1];
    if (closed) {
      for (let changed = true; changed && runs.length > 1; ) {
        changed = false;
        const first = runs[0];
        const last = runs[runs.length - 1];
        if (first.cls === last.cls) break; // one circular run; nothing to absorb
        if (last.km < absorbLimit(last.cls) && runs[runs.length - 2].cls === first.cls) {
          runs[runs.length - 2].end = last.end;
          runs[runs.length - 2].km += last.km;
          runs.pop();
          changed = true;
        } else if (first.km < absorbLimit(first.cls) && runs[1].cls === last.cls) {
          runs[1].start = first.start;
          runs[1].km += first.km;
          runs.shift();
          changed = true;
        }
      }
    }

    for (const run of runs) {
      const line = roundLine(pts.slice(run.start, run.end + 2));
      const c = run.cls;
      if (c === "skip") continue; // sub-scale hole: no shoreline at all
      if (c === "seamadj") continue; // foreign side of the seam: not drawn
      if (c.startsWith("seam|")) {
        seams.push({ c: g.id, f: c.slice(5), line });
        nSegs.seam += run.end - run.start + 1;
        continue;
      }
      boundary.push({ cls: c, region, unit: g.id, line });
      nSegs[c] += run.end - run.start + 1;
    }
  }
  console.log(
    `na overlays: boundary split into ${nSegs.coast} coast + ${nSegs.lakeshore} lakeshore + ` +
      `${nSegs.border} border + ${nSegs.seam} seam segments ` +
      `(${boundary.length} runs, ${seams.length} seam pieces)`
  );

  const out = JSON.stringify({
    boundary,
    seams,
    lakes: { type: "FeatureCollection", features: lakeFeatures },
  });
  writeFileSync(join(outDir, "na-map-overlays.json"), out);
  console.log(`wrote na-map-overlays.json (${(out.length / 1e6).toFixed(1)} MB)`);
}

// ------------------------------------------------------------------- merge

const usFeatures = await loadCountyFeatures();
const geoIds = new Set(usFeatures.map((f) => f.id));
const { features: foreignFeatures, stateNames: foreignStateNames } =
  await loadNaForeignFeatures();
// Foreign units go first so the client, which draws fills in data order, has
// the exact Census county shapes paint over any overlap along the seam.
const topo = buildTopoFile([...foreignFeatures, ...usFeatures], "na-counties-topo.json");
await buildNaOverlays(topo, new Set(foreignFeatures.map((f) => f.id)));
const { counties: popCounties, stateNames, year: popYear } = await loadPopulation();
const { gdp, year: gdpYear } = await loadGdp(popCounties);
const { edu, window: eduWindow } = await loadEducation();
const { votes, year: electionYear } = await loadElection(popCounties);
const { mhi, year: incomeYear } = await loadIncome();
const { race, year: raceYear } = await loadRace();
const { life, window: lifeExpWindow } = await loadLifeExpectancy();

const out = { counties: {}, states: {} };
for (const [fips, name] of stateNames) if (+fips <= 56) out.states[fips] = name;

const missing = { pop: [], gdp: [], edu: [], votes: [], income: [], race: [], life: [] };
for (const fips of [...geoIds].sort()) {
  const p = popCounties.get(fips);
  const g = gdp.get(fips) ?? null;
  const e = edu.get(fips) ?? null;
  const v = votes.get(fips) ?? null;
  const inc = mhi.get(fips) ?? null;
  const r = race.get(fips) ?? null;
  const lf = life.get(fips) ?? null;
  if (!p) missing.pop.push(fips);
  if (g === null) missing.gdp.push(fips);
  if (!e) missing.edu.push(fips);
  if (!v) missing.votes.push(fips);
  if (inc === null) missing.income.push(fips);
  if (!r) missing.race.push(fips);
  if (lf === null) missing.life.push(fips);
  out.counties[fips] = {
    name: p?.name ?? fips,
    st: fips.slice(0, 2),
    pop: p?.pop ?? 0,
    gdp: g,
    eduT: e?.total ?? 0,
    eduB: e?.bach ?? 0,
    dem: v?.dem ?? null,
    gop: v?.gop ?? null,
    tot: v?.tot ?? null,
    mhi: inc,
    life: lf,
    rT: r?.rT ?? 0,
    rW: r?.rW ?? 0,
    rB: r?.rB ?? 0,
    rN: r?.rN ?? 0,
    rA: r?.rA ?? 0,
    rH: r?.rH ?? 0,
  };
}
for (const fips of popCounties.keys()) {
  if (!geoIds.has(fips)) console.warn(`  population row with no geometry: ${fips}`);
}

// One pseudo-county per unit outside the union. Canadian census divisions
// carry population, GDP, household income and education from the real
// census profile below; Mexican states and the Caribbean / Central American
// countries carry population and GDP from the same static table as their
// education and income, a much rougher hand-compiled estimate (see the
// comment in na-unit-data.mjs). Every other stat is null, which the app
// renders as "—" and keeps out of that ranking. `out.foreign` lists the
// foreign *states* — the provinces and the single-unit countries — since
// that is the level the union admits.
const caProfile = await loadCaProfile();
const { pop: caPop, year: caPopYear } = await loadCaPopulation();
const caGrowth = await loadCaIncomeGrowth();
const caProvLife = await loadCaProvinceLifeExpectancy();
const caAbLife = loadAbLifeExpectancy();
const caDivisions = foreignFeatures.filter((f) => f.id !== f.properties.st);
const caBcLife = await loadBcLifeExpectancy(caDivisions.filter((f) => f.properties.st === "CA-BC"));
const caRows = apportionCaDivisions(
  caDivisions,
  caProfile,
  caPop,
  caGrowth,
  caProvLife,
  caAbLife,
  caBcLife
);

// Turns a hand-compiled bachelor's-attainment percentage into an eduT/eduB
// pair comparable to the real US/Canada counts, which are both keyed on
// roughly the population 25 and up. Only the eduB/eduT ratio feeds any
// ranking, so the exact adult-share constant doesn't matter — it only
// matters that it's in the right ballpark when a foreign unit's counts get
// summed into a custom state alongside real US/Canada ones.
const FOREIGN_ADULT_SHARE = 0.55;

out.foreign = [...foreignStateNames.keys()];
for (const [sid, name] of foreignStateNames) out.states[sid] = name;
for (const f of foreignFeatures) {
  const ca = caRows.get(f.id);
  const d = ca ?? NA_UNIT_STATS.get(f.id);
  if (!d) console.warn(`  no static stats for ${f.id} (${f.properties.name})`);
  let eduT = ca?.eduT ?? 0;
  let eduB = ca?.eduB ?? 0;
  if (!ca && d?.bachPct != null) {
    eduT = Math.round(d.pop * FOREIGN_ADULT_SHARE);
    eduB = Math.round(eduT * (d.bachPct / 100));
  }
  out.counties[f.id] = {
    name: f.properties.name,
    st: f.properties.st,
    pop: d?.pop ?? 0,
    gdp: d?.gdp ?? null,
    eduT, eduB,
    dem: null, gop: null, tot: null,
    mhi: ca?.mhi ?? d?.mhi ?? null,
    // Real everywhere it's set: Canada (StatCan provincial life tables,
    // Alberta and BC refined to census-division level), Mexico (INEGI state
    // life tables), and the rest of Central America/the Caribbean (UN World
    // Population Prospects) — all from na-unit-data.mjs except Canada.
    life: ca?.life ?? d?.life ?? null,
    // Real for Canada (see caRace() above); every other foreign unit has no
    // race/ethnicity source at all, so it keeps the zeroes that hide the
    // race bar and drop the unit out of the race rankings.
    rT: ca?.rT ?? 0,
    rW: ca?.rW ?? 0,
    rB: ca?.rB ?? 0,
    rN: ca?.rN ?? 0,
    rA: ca?.rA ?? 0,
    rH: ca?.rH ?? 0,
  };
}

out.meta = {
  popYear,
  gdpYear,
  eduWindow,
  electionYear,
  incomeYear,
  raceYear,
  lifeExpWindow,
  built: new Date().toISOString().slice(0, 10),
  sources: {
    population: `Census Bureau population estimates, ${popYear}`,
    gdp: `Bureau of Economic Analysis county GDP (CAGDP2), ${gdpYear}`,
    education: `USDA ERS / Census ACS educational attainment, ${eduWindow}`,
    election: `County-level ${electionYear} presidential results (tonmcg/US_County_Level_Election_Results)`,
    income: `Census SAIPE median household income, ${incomeYear}`,
    race: `Census county characteristics estimates (ASRH), ${raceYear}`,
    lifeExpectancy: `County Health Rankings & Roadmaps (NCHS mortality + Census population), ${lifeExpWindow}`,
    canada:
      `Statistics Canada: population by census division, July ${caPopYear}; 2021 Census Profile ` +
      `for the ${CA_INCOME_FROM} household income and education counts, carried to ` +
      `${CA_INCOME_TO} by provincial T1 Family File income growth; GDP apportioned from ` +
      `provincial totals by employment income; life expectancy from StatCan's three-year ` +
      `provincial/territorial life tables (13-10-0114, 13-10-0140), refined to census-division ` +
      `level in Alberta from Alberta Health's Interactive Health Data Application and in BC from ` +
      `BC Vital Statistics' Local Health Areas; race/ethnicity from the same 2021 Census Profile's ` +
      `visible minority and Indigenous identity counts, not carried forward like income (see ` +
      `caRace() in build-data.mjs for how these map onto the US categories)`,
    foreign:
      "Non-US pop & GDP: national statistics agencies / World Bank, 2023–24 (static estimates); " +
      "Mexico education & income: INEGI census 2020 & ENIGH 2024; other countries' education: " +
      "national censuses/UNESCO/World Bank (years vary); other countries' income: World Bank GNI " +
      "per capita × a flat household-pooling factor (rough estimates throughout); life expectancy " +
      "is a real figure everywhere — Mexico from INEGI state life tables (2025), the rest of " +
      "Central America/the Caribbean from the UN World Population Prospects 2024 revision (2023)",
    overlays: "Natural Earth (lakes, admin polygons for boundary classification)",
  },
};

const json = JSON.stringify(out);
writeFileSync(join(outDir, "na-county-data.json"), json);
console.log(
  `wrote na-county-data.json (${(json.length / 1e6).toFixed(1)} MB, ${geoIds.size} counties + ` +
    `${foreignFeatures.length} non-US units in ${out.foreign.length} states)`
);
for (const [k, v] of Object.entries(missing)) {
  if (v.length) console.warn(`missing ${k} for ${v.length} counties: ${v.slice(0, 10).join(", ")}${v.length > 10 ? "…" : ""}`);
}
