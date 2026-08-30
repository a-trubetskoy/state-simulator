// C5 — drawing the labels.
//
// label-layout.js decides where every name goes and keeps the answer in lon/lat
// and radians. This file is the part that runs per frame: project each baked
// baseline through the current facing, walk it to find where each glyph's pen
// lands, and hand the GPU one instance per glyph.
//
// That is a deliberate split of the plan's "vertex shader, no CPU work". The
// glyph QUAD is the shader's — a rotated rectangle with an atlas rect, which is
// all TEXT_VS does. Finding the pen positions is not: a glyph's place on the
// baseline is an arc length along a projected polyline, so a vertex shader
// would have to walk the whole polyline once per glyph. Doing it once per RUN
// on the CPU is the same answer for a few thousand multiplies across the map,
// and it is where centring, foreshortening and the horizon test all naturally
// live anyway. What matters is what the plan was actually asking for: no
// re-layout on rotation, and no label sitting out a drag.

import { createLabelLayout, advances } from "./label-layout.js";
import { createGlyphAtlas } from "./atlas.js";
import { TEXT_VS, TEXT_FS, ATTRIB, compile } from "./shaders.js";

export { initialAssignment } from "./label-layout.js";

// Below this the text is unreadable and the glyphs are mostly halo.
const MIN_PX = 5;
// How far a label may be squashed along its baseline before it stops
// foreshortening and just stays put. Painted-on through most of the disc; no
// edge-on slivers at the rim.
const MIN_COMPRESS = 0.5;

const COLOR = {
  // #state-labels text in style.css: fill #4a4a44, a white stroke at 0.55
  // painted under the glyph (see TEXT_FS for how wide), and #1a1a1a leader
  // lines.
  fill: [0x4a / 255, 0x4a / 255, 0x44 / 255, 1],
  halo: [1, 1, 1, 0.55],
  leader: [0x1a / 255, 0x1a / 255, 0x1a / 255, 1],
};
const LEADER_WIDTH = 0.7; // map units, matching the SVG rule

const FLOATS = 12; // aPen, aQuad, aRect
const STRIDE = FLOATS * 4;
const PARTS = [
  [ATTRIB.aPen, 0],
  [ATTRIB.aQuad, 16],
  [ATTRIB.aRect, 32],
];

export function createGlobeLabels(gl, { units, camera, globeScale }) {
  const layout = createLabelLayout({ units, globeScale });
  const atlas = createGlyphAtlas(gl);
  const prog = compile(gl, TEXT_VS, TEXT_FS);

  let data32 = new Float32Array(4096 * FLOATS);
  let cursor = 0;
  let leaderCount = 0;
  let glyphCount = 0;

  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);
  const instances = gl.createBuffer();

  const vao = gl.createVertexArray();
  gl.bindVertexArray(vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.enableVertexAttribArray(ATTRIB.aCorner);
  gl.vertexAttribPointer(ATTRIB.aCorner, 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, instances);
  const pointAt = (base) => {
    for (const [loc, off] of PARTS) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE, base + off);
      gl.vertexAttribDivisor(loc, 1);
    }
  };
  pointAt(0);
  gl.bindVertexArray(null);

  function push(px, py, tx, ty, qx, qy, qw, qh, u0, v0, u1, v1) {
    if ((cursor + 1) * FLOATS > data32.length) {
      const grown = new Float32Array(data32.length * 2);
      grown.set(data32);
      data32 = grown;
    }
    let i = cursor * FLOATS;
    data32[i++] = px;
    data32[i++] = py;
    data32[i++] = tx;
    data32[i++] = ty;
    data32[i++] = qx;
    data32[i++] = qy;
    data32[i++] = qw;
    data32[i++] = qh;
    data32[i++] = u0;
    data32[i++] = v0;
    data32[i++] = u1;
    data32[i++] = v1;
    cursor++;
  }

  // Scratch for one run's projected baseline, grown as needed.
  let sx = new Float64Array(256);
  let sy = new Float64Array(256);
  let scum = new Float64Array(256);

  function layoutRun(run, sizePx, scale, center, m) {
    const n = run.xyz.length / 3;
    if (n > sx.length) {
      sx = new Float64Array(n);
      sy = new Float64Array(n);
      scum = new Float64Array(n);
    }
    for (let i = 0; i < n; i++) {
      const x = run.xyz[i * 3];
      const y = run.xyz[i * 3 + 1];
      const z = run.xyz[i * 3 + 2];
      // The horizon. A label straddling it would be drawn half onto the far
      // side of the world, so the whole run goes rather than part of it.
      if (m[0] * x + m[3] * y + m[6] * z <= 0) return;
      sx[i] = center[0] + (m[1] * x + m[4] * y + m[7] * z) * scale;
      sy[i] = center[1] - (m[2] * x + m[5] * y + m[8] * z) * scale;
      scum[i] = i ? scum[i - 1] + Math.hypot(sx[i] - sx[i - 1], sy[i] - sy[i - 1]) : 0;
    }
    const projected = scum[n - 1];
    if (projected < 1) return;

    // Foreshortening. The baseline's own great-circle length says how long it
    // would measure face-on; how much shorter it measures now is how much the
    // ground under it is turned away, which is exactly how much text painted on
    // that ground should squash. Clamped, so a label near the limb goes flat
    // rather than edge-on.
    const faceOn = run.arc * scale;
    const compress = Math.max(MIN_COMPRESS, Math.min(1, faceOn > 0 ? projected / faceOn : 1));

    const adv = advances(run.text);
    const spacingPx = run.spacing * scale;
    const width = ((adv[run.text.length] / 100) * sizePx + spacingPx * run.text.length) * compress;
    // startOffset 50% with text-anchor middle, which is what the SVG labels do.
    const start = (projected - width) / 2;

    let seg = 0;
    for (let i = 0; i < run.text.length; i++) {
      const g = atlas.get(run.text[i]);
      if (!g || g.blank) continue;
      const pen = start + ((adv[i] / 100) * sizePx + spacingPx * i) * compress;
      while (seg < n - 2 && scum[seg + 1] < pen) seg++;
      const span = scum[seg + 1] - scum[seg] || 1;
      const t = (pen - scum[seg]) / span;
      push(
        sx[seg] + (sx[seg + 1] - sx[seg]) * t,
        sy[seg] + (sy[seg + 1] - sy[seg]) * t,
        (sx[seg + 1] - sx[seg]) / span,
        (sy[seg + 1] - sy[seg]) / span,
        g.qx * sizePx * compress,
        g.qy * sizePx,
        g.qw * sizePx * compress,
        g.qh * sizePx,
        g.u0,
        g.v0,
        g.u1,
        g.v1
      );
    }
  }

  function layoutLine(line, scale, center, m) {
    const p = [];
    for (const v of [line.a, line.b]) {
      if (m[0] * v[0] + m[3] * v[1] + m[6] * v[2] <= 0) return;
      p.push([
        center[0] + (m[1] * v[0] + m[4] * v[1] + m[7] * v[2]) * scale,
        center[1] - (m[2] * v[0] + m[5] * v[1] + m[8] * v[2]) * scale,
      ]);
    }
    const dx = p[1][0] - p[0][0];
    const dy = p[1][1] - p[0][1];
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return;
    const w = (LEADER_WIDTH / globeScale) * scale;
    push(p[0][0], p[0][1], dx / len, dy / len, 0, w / 2, len, w, 0, 0, 0, 0);
  }

  /**
   * Project the baked labels through the current facing and upload the glyphs.
   * Call it inside the pass that draws them: they move only when the map does,
   * so whatever decides to redraw the map decides this too.
   */
  function prepare() {
    cursor = 0;
    const scale = camera.radiusPx();
    const center = camera.center();
    // Column-major, so row r of the forward rotation is m[r], m[r + 3], m[r + 6].
    const m = camera.matrix64;
    const labels = layout.labels;

    // Leader lines lead, so the two draws below are contiguous ranges of one
    // buffer: they differ only in colour and in whether the atlas is sampled.
    for (const label of labels) {
      if (label.line && label.size * scale >= MIN_PX) layoutLine(label.line, scale, center, m);
    }
    leaderCount = cursor;
    for (const label of labels) {
      const sizePx = label.size * scale;
      if (sizePx < MIN_PX) continue;
      for (const run of label.runs) layoutRun(run, sizePx, scale, center, m);
    }
    glyphCount = cursor - leaderCount;
    if (!cursor) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, instances);
    gl.bufferData(gl.ARRAY_BUFFER, data32.subarray(0, cursor * FLOATS), gl.DYNAMIC_DRAW);
  }

  function draw() {
    if (!cursor) return;
    gl.useProgram(prog.program);
    gl.uniform2f(prog.u.uViewport, camera.view.width, camera.view.height);
    gl.uniform1f(prog.u.uHalo, atlas.haloUnits);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
    gl.uniform1i(prog.u.uAtlas, 0);
    gl.bindVertexArray(vao);

    if (leaderCount) {
      gl.uniform1i(prog.u.uSolid, 1);
      gl.uniform4fv(prog.u.uColor, COLOR.leader);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, leaderCount);
    }
    if (glyphCount) {
      gl.uniform1i(prog.u.uSolid, 0);
      // WebGL2 has no baseInstance, so the glyph range is reached by moving the
      // attribute pointers rather than by an offset in the draw call.
      gl.bindBuffer(gl.ARRAY_BUFFER, instances);
      pointAt(leaderCount * STRIDE);
      // `paint-order: stroke` is every glyph's halo and then every glyph's
      // fill, not halo-then-fill per glyph. One pass each keeps that order:
      // the halo now reaches far enough on small type to cover a neighbour's
      // letter, and drawing it per glyph would leave it there.
      gl.uniform1i(prog.u.uHaloPass, 1);
      gl.uniform4fv(prog.u.uColor, COLOR.halo);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphCount);
      gl.uniform1i(prog.u.uHaloPass, 0);
      gl.uniform4fv(prog.u.uColor, COLOR.fill);
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, glyphCount);
      pointAt(0);
    }
    gl.bindVertexArray(null);
  }

  return {
    update: layout.update,
    prepare,
    draw,
    raster: layout.raster,
    get stats() {
      return {
        labels: layout.labels.length,
        glyphs: glyphCount,
        leaders: leaderCount,
        atlas: atlas.stats,
      };
    },
  };
}
