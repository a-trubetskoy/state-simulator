// C7 — the scene table and the shaders, checked against each other and against
// the compiled geometry.
//
// Everything else under src/globe has a check that runs its arithmetic. This
// one runs no arithmetic at all; it exists because of one failure mode that
// nothing else can see. gl.getUniformLocation returns null for a name the
// program does not declare — or declares and never uses, so the compiler drops
// it — and gl.uniform*(null, …) is a SILENT no-op. No exception, no GL error,
// no console line. The layer simply draws with whatever the last program left
// in that slot, which on this stack means a plausible-looking map with one
// thing quietly wrong.
//
// So: every uniform the renderer writes must be declared in some shader, every
// group the layer table names must exist in the manifest, and the mode numbers
// on both sides of the JS/GLSL boundary must agree.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const read = (p) => readFileSync(join(root, p), "utf8");

const { buildLayers, BAND_GROUPS, MODE } = await import("../src/globe/layers.js");
const { MAX_ZOOM, MIN_ZOOM } = await import("../src/globe/camera.js");
const S = await import("../src/globe/shaders.js");

let failed = 0;
const ok = (label, cond, detail = "") => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}${detail ? `   ${detail}` : ""}`);
  if (!cond) failed++;
};

// ------------------------------------------------------------------ uniforms

const glsl = Object.values(S).filter((v) => typeof v === "string");
const allSource = glsl.join("\n");

const declared = new Set();
for (const m of allSource.matchAll(/\buniform\s+\w+\s+(\w+)\s*;/g)) declared.add(m[1]);

const rendererSrc = read("src/globe/renderer.js") + read("src/globe/labels.js");
const used = new Set();
for (const m of rendererSrc.matchAll(/\.u\.(\w+)/g)) used.add(m[1]);

const missing = [...used].filter((n) => !declared.has(n));
console.log("\nuniforms");
console.log(`  ${declared.size} declared across ${glsl.length} shader sources, ${used.size} written`);
ok("every uniform the renderer writes is declared", missing.length === 0, missing.join(", "));

// The other direction is a warning rather than a failure: a shader may declare
// a uniform that only one caller sets.
const unused = [...declared].filter((n) => !used.has(n));
if (unused.length) console.log(`  note: declared but never written here: ${unused.join(", ")}`);

// -------------------------------------------------------------------- modes

console.log("\nline modes");
for (const [name, value] of Object.entries(MODE)) {
  const glslName = `MODE_${name.toUpperCase()}`;
  const m = S.LINE_VS.match(new RegExp(`const int ${glslName} = (\\d+);`));
  ok(`${glslName} agrees with MODE.${name}`, m && +m[1] === value, m ? `= ${m[1]}` : "not in LINE_VS");
}

// -------------------------------------------------------------- layer groups

const manifest = JSON.parse(read("public/data/globe-geometry.json"));
const layers = buildLayers();
console.log(`\nlayer table — ${layers.length} layers`);

const groupsOf = (l) => (Array.isArray(l.group) ? l.group : l.group ? [l.group] : []);
const badGroups = [];
for (const l of layers) {
  const bag = l.kind === "line" ? manifest.lines : manifest.fills;
  for (const g of groupsOf(l)) if (!bag[g]) badGroups.push(`${l.name ?? g} -> ${l.kind}.${g}`);
}
ok("every group the table names is in the manifest", badGroups.length === 0, badGroups.join(", "));
ok("every band group is a line group", BAND_GROUPS.every((g) => manifest.lines[g]));

// Anything that reads the two sides of a segment has to be drawn from a group
// that carries a unit pair. Every compiled line group does; the check is here
// so a new group without one cannot quietly join a mode that needs it.
const paired = new Set(
  BAND_GROUPS.concat([
    "countyArcs",
    "seams",
    "countyArcsCoarse",
    "seamsCoarse",
    "coast",
    "lakeshore",
    "border",
  ])
);
const unpaired = layers
  .filter((l) => l.mode && l.mode !== MODE.plain)
  .flatMap((l) => groupsOf(l).filter((g) => !paired.has(g)));
ok("no mode reads unit sides off a group that has none", unpaired.length === 0, unpaired.join(", "));

// ---------------------------------------------------------------- zoom fades

// A layer with a zoom range is absent below it and ordinary above it, so a
// range written backwards makes a layer that never draws — and nothing else
// would say so, because a layer that never draws looks exactly like a layer
// that is simply not there yet.
console.log("\nzoom fades");
const faded = layers.filter((l) => l.fadeIn);
const badRange = faded.filter(
  (l) => !Array.isArray(l.fadeIn) || l.fadeIn.length !== 2 || !(l.fadeIn[0] < l.fadeIn[1])
);
ok(
  `every fadeIn is a range, low end first (${faded.length} layers)`,
  badRange.length === 0,
  badRange.map((l) => l.name).join(", ")
);

// A tier series — the rivers, the lake fills, the lake shores — is an ordered
// thing: each tier holds what only matters once you are closer in than the tier
// before it. Two ways that can go wrong, and neither shows on screen as an
// error. Named out of step with the compiler, a tier draws the wrong geometry.
// Faded out of order, or with two ranges overlapping, tiers arrive together or
// backwards — a tier of tributaries drawing with the river they join still
// missing, or two half-drawn tiers reading as a wash.
const series = (bag, pattern, what) => {
  const tiers = layers.filter((l) => groupsOf(l).some((g) => pattern.test(g)));
  const named = tiers.flatMap(groupsOf).filter((g) => pattern.test(g));
  const compiled = Object.keys(bag).filter((g) => pattern.test(g));
  ok(
    `the table draws every compiled ${what} tier (${compiled.length})`,
    compiled.length > 0 && named.join() === compiled.join(),
    `table ${named.join(", ")} vs manifest ${compiled.join(", ")}`
  );

  let reach = 0;
  const outOfOrder = [];
  for (const l of tiers) {
    const [k0, k1] = l.fadeIn ?? [0, 0];
    if (k0 < reach) outOfOrder.push(l.name ?? groupsOf(l).join());
    reach = Math.max(reach, k1);
  }
  ok(`the ${what} tiers fade in in order, no two at once`, outOfOrder.length === 0, outOfOrder.join(", "));
  return tiers;
};

series(manifest.lines, /^rivers\d+$/, "river");
const lakeFills = series(manifest.fills, /^worldLakes\d+$/, "lake");
const lakeShores = series(manifest.lines, /^worldLakeEdges\d+$/, "lake shore");

// A tier's water and its shore have to arrive together. Split, one of them is an
// outline around nothing or a slab of blue with no edge, for however many zoom
// steps separate the two ranges.
const fadeKey = (l) => (l.fadeIn ? l.fadeIn.join("-") : "always");
const mismatched = lakeFills
  .map((f, i) => [f, lakeShores[i]])
  .filter(([f, e]) => !e || fadeKey(f) !== fadeKey(e))
  .map(([f, e]) => `${f.name} ${fadeKey(f)} vs ${e ? `${e.name} ${fadeKey(e)}` : "no shore"}`);
ok(
  "each lake tier's water and shore fade together",
  lakeFills.length === lakeShores.length && mismatched.length === 0,
  mismatched.join("; ")
);

// ------------------------------------------------------------- detail tiers

// A `tier` is one layer written as several, each drawing the same thing at a
// different level of detail over its own stretch of the zoom. The renderer
// switches between them on a hard edge, so the stretches have to tile the whole
// zoom range: a gap is a zoom at which the layer is simply missing, and an
// overlap draws two copies of one line over each other — which for a
// half-alpha hairline is the doubled weight the tiers exist to remove. Neither
// looks like an error on screen, so it is checked here.
//
// The style has to match too. Two tiers that differ in colour or width turn
// what should be an invisible swap into a flash at the crossover.
console.log("\ndetail tiers");
const tiers = new Map();
for (const l of layers) {
  if (!l.tier) continue;
  if (!tiers.has(l.tier)) tiers.set(l.tier, []);
  tiers.get(l.tier).push(l);
}
ok("at least one layer is written as detail tiers", tiers.size > 0);
for (const [name, group] of tiers) {
  const ranges = group
    .map((l) => [l.zoom?.[0] ?? MIN_ZOOM, l.zoom?.[1] ?? MAX_ZOOM])
    .sort((a, b) => a[0] - b[0]);
  ok(
    `every "${name}" tier has a zoom range (${group.length} tiers)`,
    group.every((l) => Array.isArray(l.zoom) && l.zoom.length === 2)
  );
  let cursor = MIN_ZOOM;
  const breaks = [];
  for (const [k0, k1] of ranges) {
    if (k0 !== cursor) breaks.push(`${cursor} -> ${k0}`);
    if (!(k1 > k0)) breaks.push(`empty range at ${k0}`);
    cursor = k1;
  }
  if (cursor !== MAX_ZOOM) breaks.push(`stops at ${cursor}, not ${MAX_ZOOM}`);
  ok(
    `the "${name}" tiers tile ${MIN_ZOOM} to ${MAX_ZOOM} with no gap or overlap`,
    breaks.length === 0,
    breaks.join("; ")
  );

  const styles = new Set(
    group.map((l) => JSON.stringify([l.kind, l.color, l.colorB ?? null, l.width ?? null, l.mode ?? 0]))
  );
  ok(`the "${name}" tiers are the same line at every zoom`, styles.size === 1, [...styles].join(" vs "));

  // Two tiers naming the same geometry would draw the same detail on both sides
  // of the crossover, which is a tier that quietly does nothing.
  const named = group.flatMap(groupsOf);
  ok(`no group serves two "${name}" tiers`, new Set(named).size === named.length, named.join(", "));
}

// ------------------------------------------------------------- zoom growth

// A width that ramps with the zoom has two ways to be quietly wrong. A range
// topping out past MAX_ZOOM is a width the camera can never reach, so the layer
// draws thinner than it was written to at the closest view the map has. A factor
// under 1 thins a line as you close in, which is the opposite of the point.
console.log("\nzoom growth");
const growing = layers.filter((l) => l.grow);
const badGrow = growing.filter((l) => {
  if (!Array.isArray(l.grow) || l.grow.length !== 3) return true;
  const [k0, k1, factor] = l.grow;
  return !(k0 < k1) || k1 > MAX_ZOOM || !(factor >= 1);
});
ok(
  `every grow is a range up to MAX_ZOOM (${MAX_ZOOM}) with a factor of 1 or more (${growing.length} layers)`,
  badGrow.length === 0,
  badGrow.map((l) => `${l.name} ${JSON.stringify(l.grow)}`).join(", ")
);

// The river tiers taper against each other by width, so they have to grow by
// the same range and the same factor or the taper closes up at one end of the
// zoom and the tiers stop reading as a hierarchy.
const riverGrows = new Set(
  layers
    .filter((l) => groupsOf(l).some((g) => /^rivers\d+$/.test(g)))
    .map((l) => JSON.stringify(l.grow ?? null))
);
ok(
  "the river tiers all grow by the same range and factor",
  riverGrows.size === 1,
  [...riverGrows].join(" vs ")
);

// Water that is a HOLE in the land can never fade, and this is the one check
// that says so. Natural Earth carves its largest lakes out of the countries it
// draws and the Census file carves the Great Lakes out of the counties, so
// those lakes are holes: drawn empty they show the ocean through the middle of
// a continent, and the coast halo hiding under the land rings them in sea blue.
// build-world.mjs pins every carved lake to the first tier; this holds that tier
// and the two carved-lake layers to no fade at all.
const unfadable = ["worldLakes1", "worldLakeEdges1", "lakesUnder", "lakeEdgesUnder"];
const faders = layers.filter((l) => l.fadeIn && groupsOf(l).some((g) => unfadable.includes(g)));
ok(
  "the lakes carved out of the land never fade",
  faders.length === 0,
  faders.map((l) => `${l.name} fades in at ${l.fadeIn[0]}`).join(", ")
);

// Every fill and line group the compiler emits should be drawn by something, or
// it is 20 MB of buffer nobody reads.
const drawn = new Set(layers.flatMap(groupsOf));
const orphans = [...Object.keys(manifest.fills), ...Object.keys(manifest.lines)].filter(
  (g) => !drawn.has(g)
);
ok("no compiled group goes undrawn", orphans.length === 0, orphans.join(", "));

console.log(failed ? `\n${failed} check(s) failed` : "\nall layer checks passed");
process.exit(failed ? 1 : 0);
