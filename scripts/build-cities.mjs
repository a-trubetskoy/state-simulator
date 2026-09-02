// Builds public/data/cities.json: the cities the globe draws as a dot and a
// name, over the reference basemap and everything else on the map.
//
// This file exists because no free tile server publishes what the map wants.
// Esri's reference sheets are the ones the basemap is drawn from, and they come
// two ways: city names with no dot marking the city, or dots welded into a
// single fused image with state names and country boundaries the map already
// draws for itself. Drawing the cities here instead is what buys the third
// option — cities and nothing else — and it buys two more things with it: the
// dots and the names come from ONE source, so every dot has its name and every
// name its dot, and both wear the map's own type and colour rather than
// Esri's.
//
// Source: Natural Earth 10m populated places, 7,342 of them, of which 1,024 are
// in the US and Canada.
//
// Two fields decide what ships:
//
//   FEATURECLA  drops what is not a town. The file carries scientific stations,
//               meteorological stations and historic places alongside the
//               populated ones, and a dot on Amundsen-Scott is not what this
//               layer is for.
//   SCALERANK   Natural Earth's own editorial ordering of how much a place
//               matters, 0 (Tokyo, New York) to 10. It ships as `rank` and the
//               renderer uses it twice: as the zoom at which a city is worth
//               drawing at all, and as the priority when two labels collide.
//               Ranks 9 and 10 are dropped here — 572 places, none of them in
//               North America, and nothing an atlas prints.
//
// Names come from NAMEASCII rather than NAME, which costs Montréal its accent.
// The glyph atlas is a fixed 196-cell texture shared with the state labels
// (src/globe/atlas.js), and a world's worth of Latin-extended diacritics is
// how it silently overflows and stops rasterizing. ASCII is the character set
// the atlas is already known to hold.
//
// Run: node scripts/build-cities.mjs
import { mkdirSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { unzipSync } from "fflate";
import * as shapefile from "shapefile";
import { makeDownloader } from "./geo-lib.mjs";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cacheDir = join(root, ".cache");
const outDir = join(root, "public", "data");
mkdirSync(cacheDir, { recursive: true });
mkdirSync(outDir, { recursive: true });
const download = makeDownloader(cacheDir);

const PLACES = "https://naturalearth.s3.amazonaws.com/10m_cultural/ne_10m_populated_places.zip";
const PLACES_CACHE = "ne_10m_populated_places.zip";

// Above this a place is either not in North America at all or too small for any
// zoom the map reaches. See the header.
const MAX_RANK = 8;

// What counts as a town. Matched case-insensitively because the file spells it
// both "Populated place" and "Populated Place".
const KEEP = new Set([
  "populated place",
  "admin-0 capital",
  "admin-0 capital alt",
  "admin-0 region capital",
  "admin-1 capital",
  "admin-1 region capital",
]);

// Natural Earth DBFs are UTF-8 with NUL padding on every string field.
const neClean = (v) => (typeof v === "string" ? v.replace(/\0/g, "").trim() : v);

// ~11 m, which is finer than the dot is wide at any zoom the map reaches and
// keeps four digits off every number in the file.
const round = (v) => Math.round(v * 1e4) / 1e4;

const zip = unzipSync(new Uint8Array(await download(PLACES, PLACES_CACHE)));
const shp = Object.keys(zip).find((n) => n.endsWith(".shp"));
const dbf = Object.keys(zip).find((n) => n.endsWith(".dbf"));
const fc = await shapefile.read(Buffer.from(zip[shp]), Buffer.from(zip[dbf]), {
  encoding: "utf-8",
});

const dropped = { class: 0, rank: 0, name: 0 };
const rows = [];
for (const f of fc.features) {
  const p = f.properties;
  const cls = String(neClean(p.FEATURECLA) ?? "").toLowerCase();
  if (!KEEP.has(cls)) {
    dropped.class++;
    continue;
  }
  const rank = p.SCALERANK;
  if (!(rank <= MAX_RANK)) {
    dropped.rank++;
    continue;
  }
  const name = neClean(p.NAMEASCII) || neClean(p.NAME);
  // The atlas holds ASCII; anything a transliteration left behind would draw as
  // a hole in the word, so the place goes rather than its name half-drawn.
  if (!name || /[^\x20-\x7e]/.test(name)) {
    dropped.name++;
    continue;
  }
  const [lon, lat] = f.geometry.coordinates;
  // Every kind of capital, national and provincial alike: Washington and Ottawa
  // are capitals of units the map draws as states, the same as Springfield is.
  // The renderer lets this beat sheer size when it picks a state's capital.
  rows.push({
    name,
    lon: round(lon),
    lat: round(lat),
    rank,
    cap: cls.includes("capital") ? 1 : 0,
    // Sorted on, never shipped — see the sort below.
    pop: p.POP_MAX ?? 0,
  });
}

// Priority order, and the file's whole contract with the renderer: rank first,
// then population. cities.js reads it two ways — it walks the list until the
// zoom's rank cut is passed, and it takes the lowest index in a state as that
// state's most prominent city. Shipping the order instead of the population is
// what keeps POP_MAX out of the file. Ties by name, only so the build is
// reproducible.
rows.sort(
  (a, b) =>
    a.rank - b.rank || b.pop - a.pop || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
);

// Parallel arrays rather than a list of objects: the same numbers without
// 6,700 copies of four field names, and the shape the renderer wants anyway,
// since it reads them straight into typed arrays.
const out = {
  generated: new Date().toISOString().slice(0, 10),
  source: "Natural Earth 10m populated places",
  count: rows.length,
  name: rows.map((r) => r.name),
  lon: rows.map((r) => r.lon),
  lat: rows.map((r) => r.lat),
  rank: rows.map((r) => r.rank),
  cap: rows.map((r) => r.cap),
};
const json = JSON.stringify(out);
writeFileSync(join(outDir, "cities.json"), json);

const byRank = new Map();
for (const r of rows) byRank.set(r.rank, (byRank.get(r.rank) ?? 0) + 1);
console.log(`read     ${fc.features.length} populated places`);
console.log(
  `dropped  ${dropped.class} not a town, ${dropped.rank} above rank ${MAX_RANK}, ` +
    `${dropped.name} with a name the atlas cannot set`,
);
console.log(`kept     ${rows.length}, of which ${rows.filter((r) => r.cap).length} are capitals`);
for (const k of [...byRank.keys()].sort((a, b) => a - b)) {
  console.log(`  rank ${k}: ${byRank.get(k)}`);
}
console.log(`wrote    public/data/cities.json (${(json.length / 1e3).toFixed(0)} kB)`);
