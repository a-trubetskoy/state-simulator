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
const paired = new Set(BAND_GROUPS.concat(["countyArcs", "seams", "coast", "lakeshore", "border"]));
const unpaired = layers
  .filter((l) => l.mode && l.mode !== MODE.plain)
  .flatMap((l) => groupsOf(l).filter((g) => !paired.has(g)));
ok("no mode reads unit sides off a group that has none", unpaired.length === 0, unpaired.join(", "));

// Every fill and line group the compiler emits should be drawn by something, or
// it is 20 MB of buffer nobody reads.
const drawn = new Set(layers.flatMap(groupsOf));
const orphans = [...Object.keys(manifest.fills), ...Object.keys(manifest.lines)].filter(
  (g) => !drawn.has(g)
);
ok("no compiled group goes undrawn", orphans.length === 0, orphans.join(", "));

console.log(failed ? `\n${failed} check(s) failed` : "\nall layer checks passed");
process.exit(failed ? 1 : 0);
