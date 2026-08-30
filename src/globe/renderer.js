// C2 — the renderer core.
//
// One draw call per layer, in painter's order, with no depth buffer. Raw WebGL2
// rather than a scene graph: the scene is a short flat list and everything
// interesting is in the two shaders that expand geometry.
//
// Two things go wrong where a stroked path turns a corner. They are separate,
// and only one of them was worth machinery.
//
//   Overlap along a run. Segments are independent instances whose caps extend
//   half a stroke width past each endpoint, so consecutive quads overlap
//   however short the segment is: the county arcs average 1.59 px at the home
//   view against a 1 px stroke, so each pixel of border is painted about 1.63
//   times. At the 50% alpha the hairlines use, every overlap composites again
//   and the line reads 68% rather than 50% — and by 16x the segments have
//   spread out and the same line reads 51%, so it fades as you zoom.
//
//   C2 built a coverage pass for that: draw the group into an R8 buffer with
//   blendEquation(MAX), which unions the quads instead of accumulating them,
//   then composite once at the group's real colour. It is gone. Side by side on
//   an integrated GPU it was both slower and worse to look at, which is what
//   the plan said to do with it if it did not earn its place. The swing is real
//   and the fade is the price; it is a shade of white on a hairline, and the
//   shipped deck.gl map carries the same hairlines at the same alpha. If it
//   ever does matter, the fix is a shared point strip with adjacency, not a
//   second buffer — C1 already wants one to save 2.9 MB.
//
//   The shape of the corner itself. A square cap reaches sqrt(2) half widths
//   from the vertex instead of one, so it juts out by 41% of the half width at
//   every turn. That is sub-pixel on a 1 px hairline, which is what C2's first
//   pass measured and why it called joins settled — but it is 3.3 px on the
//   16 px coast halo, and the world coastline turns by more than 90 degrees at
//   a quarter of its vertices. It drew a spiky, ragged shoreline.
//
//   LINE_FS now measures to the segment rather than to its centreline, which
//   rounds the caps and rounds the joins with them, since two capsules sharing
//   an endpoint union into a round-jointed stroke. deck.gl's PathLayer draws
//   every one of these paths with jointRounded and capRounded, so this is also
//   what parity needs. Half a feather of quad length, and no adjacency at all.

import * as S from "./shaders.js";
import { compile } from "./shaders.js";
import { buildLayers, BAND_GROUPS, COLORS, MODE } from "./layers.js";
import { createDynamicFills, createDynamicLines } from "./dynamic.js";

// Unit ids a carve may hand out, above the compiled units. The sentinels sit at
// 65534, so this is a policy rather than a limit of the format; ids are recycled
// when a county is recut, so it bounds how many pieces exist at once.
const PIECE_UNITS = 4096;

export function createRenderer(gl, geometry, camera) {
  const prog = {
    disc: compile(gl, S.DISC_VS, S.DISC_FS),
    fill: compile(gl, S.FILL_VS, S.FILL_FS),
    line: compile(gl, S.LINE_VS, S.LINE_FS),
    present: compile(gl, S.PRESENT_VS, S.PRESENT_FS),
  };

  // Two masks share the stencil buffer, so they take a bit each rather than a
  // value each. They do not overlap in time today — the aprons consume the
  // nation's mask before the band writes its own — but a bit apiece costs
  // nothing and means neither pass depends on that staying true.
  const NATION_BIT = 0x01;
  const BAND_BIT = 0x02;

  const A = S.ATTRIB;
  const { offsets } = geometry;

  // What the scene texture below currently holds. Anything that changes the map
  // — the view, a colour, a layer's visibility or its place in the order —
  // invalidates it; the pointer does not. Declared here because the palette
  // writers further down call invalidate().
  let sceneCamera = -1;
  let sceneStale = true;
  function invalidate() {
    sceneStale = true;
  }

  // The unit quad every segment is stamped from. y is 0|1; the line shader
  // remaps it to -1|+1, the band shader uses it as-is.
  const cornerBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

  const discCorners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, discCorners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);

  const discVao = gl.createVertexArray();
  gl.bindVertexArray(discVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, discCorners);
  gl.enableVertexAttribArray(A.aCorner);
  gl.vertexAttribPointer(A.aCorner, 2, gl.FLOAT, false, 0, 0);

  // The 0|1 unit quad again, this time covering the whole canvas.
  const presentVao = gl.createVertexArray();
  gl.bindVertexArray(presentVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.enableVertexAttribArray(A.aCorner);
  gl.vertexAttribPointer(A.aCorner, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  // Fills all share one VAO: the indices are absolute vertex numbers, so a
  // group is just a byte range into the element buffer.
  const fillVao = gl.createVertexArray();
  gl.bindVertexArray(fillVao);
  gl.bindBuffer(gl.ARRAY_BUFFER, geometry.attribBuffer);
  gl.enableVertexAttribArray(A.aPos);
  gl.vertexAttribPointer(A.aPos, 3, gl.FLOAT, false, 12, offsets.fillPosition);
  gl.enableVertexAttribArray(A.aUnit);
  gl.vertexAttribIPointer(A.aUnit, 1, gl.UNSIGNED_SHORT, 2, offsets.fillUnit);
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, geometry.indexBuffer);

  // WebGL2 has no baseInstance, so a line group's slice of the buffer is
  // expressed as an attribute offset — which needs a VAO of its own.
  const lineVaos = new Map();
  function lineVao(name) {
    if (lineVaos.has(name)) return lineVaos.get(name);
    const g = geometry.lines[name];
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);

    gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
    gl.enableVertexAttribArray(A.aCorner);
    gl.vertexAttribPointer(A.aCorner, 2, gl.FLOAT, false, 0, 0);

    gl.bindBuffer(gl.ARRAY_BUFFER, geometry.attribBuffer);
    for (const [loc, base] of [
      [A.aStart, offsets.lineStart],
      [A.aEnd, offsets.lineEnd],
    ]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 12, base + g.first * 12);
      gl.vertexAttribDivisor(loc, 1);
    }
    for (const [loc, base] of [
      [A.aLeft, offsets.lineLeft],
      [A.aRight, offsets.lineRight],
    ]) {
      gl.enableVertexAttribArray(loc);
      gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_SHORT, 2, base + g.first * 2);
      gl.vertexAttribDivisor(loc, 1);
    }
    gl.bindVertexArray(null);
    lineVaos.set(name, vao);
    return vao;
  }

  // ------------------------------------------------------------- palettes
  //
  // unit id -> RGBA. C3 drives colouring through these; a repaint is one texel.
  // Two of them, same shape: the fill a unit wears, and the deeper colour its
  // band wears. The band pass is the same fill program reading the second one,
  // which is why they have to agree on layout.

  const PAL_W = 128;
  // Sized for the compiled units plus room for carved pieces, which are units
  // like any other from here down: they carry a unit id per vertex, they read
  // the same two palettes, and switching a carved PARENT off is nothing more
  // than writing zero alpha into its fill entry.
  const paletteUnits = geometry.unitCount + PIECE_UNITS;
  const palHeight = Math.max(1, Math.ceil(paletteUnits / PAL_W));

  function createPalette(byte = 255) {
    const data = new Uint8Array(PAL_W * palHeight * 4).fill(byte);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, PAL_W, palHeight, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { data, texture, dirty: false };
  }
  const fillPalette = createPalette();
  const bandPalette = createPalette();
  // C7. Not a colour: which state holds each unit, and two flags about that
  // state. The line shader reads it to tell a state border from a county
  // hairline, to decide where the band runs, and to pick the selected state's
  // outline out of the same strokes. Zeroed rather than whitened, so a unit
  // nothing has written yet reads as state 0 and no flags instead of state
  // 65535 with every flag set.
  const attrTable = createPalette(0);

  const setColor = (pal) => (unit, [r, g, b, a = 255]) => {
    const i = unit * 4;
    if (pal.data[i] === r && pal.data[i + 1] === g && pal.data[i + 2] === b && pal.data[i + 3] === a)
      return;
    pal.data[i] = r;
    pal.data[i + 1] = g;
    pal.data[i + 2] = b;
    pal.data[i + 3] = a;
    pal.dirty = true;
    invalidate();
  };

  // state index (16 bits) and the flags, laid out to match ownerOf() in
  // shaders.js. Alpha is unused and stays opaque so the texel is easy to read
  // back in a debugger.
  const setUnitOwner = setColor(attrTable);
  const ATTR_ALIEN = 1;
  const ATTR_CHOSEN = 2;

  function uploadPalettes() {
    // Explicit, because the attribute table is read on texture unit 1 and
    // whichever unit was left active would otherwise take these binds.
    gl.activeTexture(gl.TEXTURE0);
    for (const pal of [fillPalette, bandPalette, attrTable]) {
      if (!pal.dirty) continue;
      gl.bindTexture(gl.TEXTURE_2D, pal.texture);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, PAL_W, palHeight, gl.RGBA, gl.UNSIGNED_BYTE, pal.data);
      pal.dirty = false;
    }
  }

  // ------------------------------------------------------------ carved pieces
  //
  // Three buffers that are not compiled. The piece fills and the piece-to-piece
  // boundaries draw inside the scene, beside the groups they belong with; the
  // knife draws outside it, over the presented scene, because it follows the
  // pointer and a stroke must not cost a redraw of the map.

  const carvedFills = createDynamicFills(gl);
  const carvedLines = createDynamicLines(gl, cornerBuffer);
  const knifeLines = createDynamicLines(gl, cornerBuffer);

  // --------------------------------------------------------------- state

  // The flag lives on the layer rather than in a map keyed by position, so
  // reordering the list cannot detach a layer from its own visibility.
  const layers = buildLayers();
  for (const l of layers) l.enabled = true;

  // C7. The two switches the app throws at the whole stack, and the one colour
  // that follows the selection. Everything else a layer needs to know is either
  // in the table or in the per-unit attributes.
  const view = { dataView: false, selected: false };
  let selectionColor = COLORS.outline;

  // What a layer draws right now.
  const hidden = (layer) =>
    !layer.enabled ||
    (layer.hideInData && view.dataView) ||
    (layer.mode === MODE.outline && !view.selected);
  const colorOf = (layer) =>
    layer.role === "selection"
      ? selectionColor
      : (view.dataView && layer.dataColor) || layer.color;
  // Counted over the SCENE pass, so they hold steady on a hover-only frame
  // instead of ticking up. Presenting and tinting are two more draw calls, and
  // always exactly two.
  const stats = { instances: 0, triangles: 0, drawCalls: 0, redrew: false };

  // ---------------------------------------------------- the scene buffer
  //
  // The map is drawn into a texture rather than straight to the canvas, and a
  // frame that moved only the POINTER blits that texture and draws the hover
  // tint over it.
  //
  // Without this a hover costs a full redraw, and a redraw costs whatever is on
  // screen — trivial zoomed into a few counties, and at the North America view
  // every one of the 300k line quads. So the tint trailed the cursor, and only
  // when zoomed out.
  //
  // The deck.gl app never had that: its hover tint is a layer on a second
  // canvas over the map, so a hover redraws one small overlay and the map is
  // untouched (main.js, refreshHoverOnly). This is the same arrangement inside
  // one context — and it has to be one context, because a second one could not
  // share these 28 MB of buffers.
  let target = null;
  function ensureTarget(w, h) {
    if (target && target.w === w && target.h === h) return target;
    if (target) {
      gl.deleteFramebuffer(target.fbo);
      gl.deleteTexture(target.texture);
      gl.deleteRenderbuffer(target.stencil);
    }
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    // Stencil only — the band and the seam aprons need it, nothing needs depth.
    const stencil = gl.createRenderbuffer();
    gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.DEPTH24_STENCIL8, w, h);
    const fbo = gl.createFramebuffer();
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
    gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.DEPTH_STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
    const ok = gl.checkFramebufferStatus(gl.FRAMEBUFFER);
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    if (ok !== gl.FRAMEBUFFER_COMPLETE) throw new Error(`scene framebuffer incomplete: 0x${ok.toString(16)}`);
    target = { fbo, texture, stencil, w, h };
    return target;
  }


  // C4's hover. Not a palette write: the tint goes on TOP of the finished map
  // rather than replacing a unit's colour, which is the arrangement the deck.gl
  // version settled on (one overlay compositing over the map, rather than a
  // sandwich that keeps the tint under the map's lines). Drawing one unit's own
  // slice of the county fills is also the first use of the per-unit index
  // ranges C6 needs.
  //
  // C7 made it a SET of units, because the data view tints the whole state
  // under the pointer rather than the county — and a state is up to 254 units.
  // Consecutive unit ids are consecutive ranges of the same element buffer, and
  // a state's counties are usually consecutive (they share a fips prefix), so
  // merging turns those 254 draw calls back into a handful.
  let hoverStatic = []; // [firstIndex, indexCount] into the county fills
  let hoverPieces = []; //  carved piece unit ids, looked up in the other buffer

  function setHover(units) {
    const list = units == null ? [] : Array.isArray(units) ? units : [units];
    hoverStatic = [];
    hoverPieces = [];
    const stat = [];
    for (const u of list) {
      if (u == null || u < 0) continue;
      if (u >= geometry.unitCount) hoverPieces.push(u);
      else stat.push(u);
    }
    stat.sort((a, b) => a - b);
    for (const u of stat) {
      const first = geometry.unitIndexRange[u * 2];
      const count = geometry.unitIndexRange[u * 2 + 1];
      if (!count) continue;
      const last = hoverStatic[hoverStatic.length - 1];
      if (last && last[0] + last[1] === first) last[1] += count;
      else hoverStatic.push([first, count]);
    }
  }

  function setCommon(p, scale, center, vw, vh) {
    if (p.u.uRot) gl.uniformMatrix3fv(p.u.uRot, false, camera.matrix);
    gl.uniform1f(p.u.uScale, scale);
    gl.uniform2fv(p.u.uCenter, center);
    gl.uniform2f(p.u.uViewport, vw, vh);
  }

  function bindPalette(p, pal) {
    if (!p.u.uPalette) return;
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, pal.texture);
    gl.uniform1i(p.u.uPalette, 0);
    gl.uniform1i(p.u.uPaletteWidth, PAL_W);
  }

  // Texture unit 1, so a program can read a colour and an owner at once. Only
  // the line program does today.
  function bindAttrs(p) {
    if (!p.u.uAttr) return;
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, attrTable.texture);
    gl.uniform1i(p.u.uAttr, 1);
    gl.uniform1i(p.u.uAttrWidth, PAL_W);
  }

  const groupsOf = (layer) => (Array.isArray(layer.group) ? layer.group : [layer.group]);

  // One fill group, in a flat colour or through a palette. The band draws the
  // county group a second time this way, which is the whole of its geometry.
  function drawFill(group, color, palette, scale, center, vw, vh) {
    const g = geometry.fills[group];
    const p = prog.fill;
    gl.useProgram(p.program);
    setCommon(p, scale, center, vw, vh);
    bindPalette(p, palette ?? fillPalette);
    gl.uniform4fv(p.u.uColor, color);
    gl.uniform1i(p.u.uUseUnit, palette ? 1 : 0);
    gl.bindVertexArray(fillVao);
    gl.drawElements(gl.TRIANGLES, g.indexCount, gl.UNSIGNED_INT, g.firstIndex * 4);
    stats.triangles += g.indexCount / 3;
    stats.drawCalls++;
  }

  // The carved pieces, wherever the county fills are drawn — the fill pass and
  // the band pass both, since a piece is a unit and wears both palettes.
  function drawCarvedFill(palette, scale, center, vw, vh) {
    if (!carvedFills.count) return;
    const p = prog.fill;
    gl.useProgram(p.program);
    setCommon(p, scale, center, vw, vh);
    bindPalette(p, palette);
    gl.uniform4fv(p.u.uColor, [0, 0, 0, 0]);
    gl.uniform1i(p.u.uUseUnit, 1);
    gl.bindVertexArray(carvedFills.vao);
    gl.drawArrays(gl.TRIANGLES, 0, carvedFills.count);
    stats.triangles += carvedFills.count / 3;
    stats.drawCalls++;
  }

  // One dynamic line group, with the line program already set up by the caller.
  function drawDynamicLines(group) {
    if (!group.count) return;
    gl.bindVertexArray(group.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, group.count);
    stats.instances += group.count;
    stats.drawCalls++;
  }

  function drawLineGroups(layer, color, scale, center, vw, vh, dpr) {
    const p = prog.line;
    gl.useProgram(p.program);
    setCommon(p, scale, center, vw, vh);
    bindAttrs(p);
    // The antialiasing ramp is ONE DEVICE pixel. Scaling it by dpr makes every
    // quad six device px wide to draw a two px stroke.
    gl.uniform1f(p.u.uFeather, 1.0);
    gl.uniform1f(p.u.uHalfWidth, Math.max(0.35, (layer.width * dpr) / 2));
    gl.uniform1i(p.u.uSkipEqual, layer.skipEqual ? 1 : 0);
    gl.uniform1i(p.u.uMode, layer.mode ?? MODE.plain);
    gl.uniform4fv(p.u.uColorB, layer.colorB ?? color);
    gl.uniform4fv(p.u.uColor, color);
    for (const name of groupsOf(layer)) {
      const g = geometry.lines[name];
      gl.bindVertexArray(lineVao(name));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
      stats.instances += g.count;
      stats.drawCalls++;
    }
    // A boundary between two pieces is a county line and wears one: same
    // colour, same width, same skipEqual test on the unit pair.
    if (layer.carved) drawDynamicLines(carvedLines);
  }

  // Everything the map is made of, into the scene texture. `extras` draws
  // inside this pass, so anything that moves only when the map moves — C5's
  // labels — is cached with it rather than re-laid on every hover frame.
  function drawScene(extras) {
    const scale = camera.radiusPx();
    const center = camera.center();
    const vw = camera.view.width;
    const vh = camera.view.height;
    const dpr = camera.view.dpr;

    uploadPalettes();

    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.DEPTH_TEST);
    gl.disable(gl.STENCIL_TEST);
    gl.enable(gl.BLEND);
    // Straight "over", and it never changes: every layer paints onto what the
    // ones below it left, which is the whole of the compositing model here.
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.clearColor(1, 1, 1, 1);
    gl.clearStencil(0);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);

    stats.instances = 0;
    stats.triangles = 0;
    stats.drawCalls = 0;

    layers.forEach((layer) => {
      if (hidden(layer)) return;
      const color = colorOf(layer);

      if (layer.kind === "disc") {
        const p = prog.disc;
        gl.useProgram(p.program);
        gl.uniform1f(p.u.uScale, scale);
        gl.uniform2fv(p.u.uCenter, center);
        gl.uniform2f(p.u.uViewport, vw, vh);
        gl.uniform4fv(p.u.uColor, color);
        gl.bindVertexArray(discVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        stats.drawCalls++;
        return;
      }

      if (layer.kind === "fill") {
        if (layer.stencil === "write") {
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.ALWAYS, NATION_BIT, 0xff);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
          gl.stencilMask(NATION_BIT);
        } else if (layer.stencil === "test") {
          // Only where the nation mesh drew. Cheaper and more exact than
          // clipping the aprons at build time.
          gl.enable(gl.STENCIL_TEST);
          gl.stencilFunc(gl.EQUAL, NATION_BIT, NATION_BIT);
          gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
          gl.stencilMask(0x00);
        }

        drawFill(layer.group, color, layer.useUnit ? fillPalette : null, scale, center, vw, vh);
        if (layer.carved) drawCarvedFill(fillPalette, scale, center, vw, vh);

        if (layer.stencil) {
          gl.disable(gl.STENCIL_TEST);
          gl.stencilMask(0xff);
        }
        return;
      }

      if (layer.kind === "band") {
        // Two passes, and the point of the pair is that neither one can put
        // colour outside a unit. First the borders are stroked into a stencil
        // bit with no colour written, then the county fills are drawn again
        // through it in their band colours. The strip is therefore the unit's
        // own ground intersected with a fixed-width stroke — main.js's
        // construction, and the only one that survives a border that bends.
        const p = prog.line;
        gl.useProgram(p.program);
        setCommon(p, scale, center, vw, vh);
        bindAttrs(p);
        gl.uniform1f(p.u.uFeather, 1.0);
        gl.uniform1f(p.u.uHalfWidth, (layer.width * dpr) / 2);
        // A single-user county arc is the nation's own outline, which the
        // classified coast and border runs carry instead; stroking it here
        // would put a band along it twice.
        gl.uniform1i(p.u.uSkipEqual, 1);
        // Only along a border of the union: between two different states, or
        // along a map edge whose owner is in the union. Without this the band
        // would run down every county line, which is what it does in the C2
        // harness because every unit there is its own state.
        gl.uniform1i(p.u.uMode, MODE.band);
        gl.uniform4fv(p.u.uColor, [1, 1, 1, 1]);
        gl.uniform4fv(p.u.uColorB, [1, 1, 1, 1]);

        gl.colorMask(false, false, false, false);
        gl.enable(gl.STENCIL_TEST);
        gl.stencilFunc(gl.ALWAYS, BAND_BIT, 0xff);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
        gl.stencilMask(BAND_BIT);
        for (const name of BAND_GROUPS) {
          const g = geometry.lines[name];
          if (!g) continue;
          gl.bindVertexArray(lineVao(name));
          gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, g.count);
          stats.instances += g.count;
          stats.drawCalls++;
        }
        // A piece boundary is a border like any other, so it strokes the mask
        // too — without this a carved county wears a band along its outside and
        // nothing down the middle.
        drawDynamicLines(carvedLines);
        gl.colorMask(true, true, true, true);

        gl.stencilFunc(gl.EQUAL, BAND_BIT, BAND_BIT);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.stencilMask(0x00);
        drawFill(layer.group, [0, 0, 0, 0], bandPalette, scale, center, vw, vh);
        drawCarvedFill(bandPalette, scale, center, vw, vh);
        gl.disable(gl.STENCIL_TEST);
        gl.stencilMask(0xff);
        return;
      }

      if (layer.kind === "line") drawLineGroups(layer, color, scale, center, vw, vh, dpr);
    });

    extras?.();
    gl.bindVertexArray(null);
  }

  // The hover tint, straight onto the canvas over the blitted scene. One unit's
  // own slice of the county fills — a few hundred triangles — which is why this
  // half of the frame costs nothing whatever the zoom.
  //
  // A carved piece is hovered the same way out of the other buffer. That is the
  // whole of what "a piece is a unit" buys: the id decides which buffer, and
  // nothing else here changes.
  function drawHover() {
    if (!hoverStatic.length && !hoverPieces.length) return;
    const p = prog.fill;
    gl.useProgram(p.program);
    setCommon(p, camera.radiusPx(), camera.center(), camera.view.width, camera.view.height);
    bindPalette(p, fillPalette);
    gl.uniform4fv(p.u.uColor, COLORS.hover);
    gl.uniform1i(p.u.uUseUnit, 0);
    if (hoverStatic.length) {
      gl.bindVertexArray(fillVao);
      for (const [first, count] of hoverStatic)
        gl.drawElements(gl.TRIANGLES, count, gl.UNSIGNED_INT, first * 4);
    }
    if (hoverPieces.length) {
      gl.bindVertexArray(carvedFills.vao);
      for (const u of hoverPieces) {
        const piece = carvedFills.rangeOf(u);
        if (piece) gl.drawArrays(gl.TRIANGLES, piece[0], piece[1]);
      }
    }
    gl.bindVertexArray(null);
  }

  // The stroke being drawn, over the presented scene. Outside the cached pass on
  // purpose: it changes on every pointer move and the map does not, which is the
  // arrangement C4's framebuffer exists to make cheap.
  function drawKnife() {
    if (!knifeLines.count) return;
    const p = prog.line;
    gl.useProgram(p.program);
    setCommon(p, camera.radiusPx(), camera.center(), camera.view.width, camera.view.height);
    bindAttrs(p);
    gl.uniform1f(p.u.uFeather, 1.0);
    gl.uniform1f(p.u.uHalfWidth, Math.max(0.6, (2 * camera.view.dpr) / 2));
    gl.uniform1i(p.u.uSkipEqual, 0);
    gl.uniform1i(p.u.uMode, MODE.plain);
    gl.uniform4fv(p.u.uColor, COLORS.knife);
    gl.uniform4fv(p.u.uColorB, COLORS.knife);
    gl.bindVertexArray(knifeLines.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, knifeLines.count);
    gl.bindVertexArray(null);
  }

  function draw(extras) {
    const vw = camera.view.width;
    const vh = camera.view.height;
    const t = ensureTarget(vw, vh);

    stats.redrew = sceneStale || camera.view.version !== sceneCamera;
    if (stats.redrew) {
      sceneStale = false;
      sceneCamera = camera.view.version;
      gl.bindFramebuffer(gl.FRAMEBUFFER, t.fbo);
      drawScene(extras);
      gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    }

    // The scene onto the canvas. A straight overwrite, so blending is off for
    // it — the scene is opaque and compositing it over last frame's contents
    // would be both wrong and slower.
    gl.viewport(0, 0, vw, vh);
    gl.disable(gl.STENCIL_TEST);
    gl.disable(gl.BLEND);
    const p = prog.present;
    gl.useProgram(p.program);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, t.texture);
    gl.uniform1i(p.u.uScene, 0);
    gl.bindVertexArray(presentVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendEquation(gl.FUNC_ADD);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    drawHover();
    drawKnife();
  }

  return {
    draw,
    layers,
    stats,
    setUnitColor: setColor(fillPalette),
    setBandColor: setColor(bandPalette),
    // Which state holds a unit, and whether that state is outside the union or
    // is the selected one. Drives the band, the state borders and the selection
    // outline, all in the vertex shader.
    setUnitOwner: (unit, stateIndex, { alien = false, chosen = false } = {}) =>
      setUnitOwner(unit, [
        stateIndex & 0xff,
        (stateIndex >> 8) & 0xff,
        (alien ? ATTR_ALIEN : 0) | (chosen ? ATTR_CHOSEN : 0),
        255,
      ]),
    // The one thing that deliberately does NOT invalidate the scene. That is
    // the whole point: a hover redraws a county, not a continent.
    setHover,
    // Atlas or data view, and whether anything is selected — the two
    // switches the layer table reads.
    setView: (next) => {
      let moved = false;
      for (const k of ["dataView", "selected"]) {
        if (next[k] === undefined || view[k] === !!next[k]) continue;
        view[k] = !!next[k];
        moved = true;
      }
      if (next.selectionColor && next.selectionColor !== selectionColor) {
        selectionColor = next.selectionColor;
        moved = true;
      }
      if (moved) invalidate();
    },
    // C6. The pieces and the lines between them, replaced wholesale — a carve
    // changes the map, so unlike a hover it does invalidate the scene.
    setCarved: (pieces, dividers) => {
      carvedFills.set(pieces);
      carvedLines.set(dividers);
      invalidate();
    },
    // The stroke in flight. Deliberately NOT an invalidate: it draws over the
    // presented scene, so a drag costs one quad and not a continent.
    setKnife: (segments) => knifeLines.set(segments),
    pieceUnits: PIECE_UNITS,
    firstPieceUnit: geometry.unitCount,
    // Anything a consumer changes that the scene texture cannot know about —
    // C5's layout, once painting can move territory.
    invalidate,
    setLayerEnabled: (i, on) => {
      layers[i].enabled = on;
      invalidate();
    },
    isLayerEnabled: (i) => layers[i].enabled,
    // Painter's order is the whole of what covers what, so rearranging this
    // array is the only thing a "move this layer" gesture has to do. Splices in
    // place: the draw loop holds the same array.
    moveLayer: (from, to) => {
      if (from === to || from < 0 || from >= layers.length) return;
      const [l] = layers.splice(from, 1);
      layers.splice(Math.max(0, Math.min(layers.length, to)), 0, l);
      invalidate();
    },
    paletteSize: [PAL_W, palHeight],
    COLORS,
  };
}
