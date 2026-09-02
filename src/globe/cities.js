// City dots and their names, drawn over everything else on the map, with the
// state capital's name underlined.
//
// These were once a raster sheet from a tile server, and no free one is cities
// alone: every version is either names with no dot marking the city, or names
// and dots welded into a single image with state labels and country boundaries
// the map already draws itself. Drawing them here, from Natural Earth by way of
// scripts/build-cities.mjs, is what makes them cities and nothing else — and it
// is also the only reason the capital can be marked at all, since which city is
// a capital depends on who owns the county it stands in, which is the app's
// answer to give and not a tile server's.
//
// Four decisions worth writing down:
//
//   - a dot is sized in DEVICE PX, not in ground units, and so is its name.
//     The state labels above are the other case: they are lettering painted on
//     territory and grow with it. A city dot means "a town is here", which is
//     as true at one zoom as another, so it stays the size a symbol wants to
//     be. This is also why nothing here foreshortens near the limb.
//
//   - which cities show is decided TWICE, and the two answers do different
//     jobs. `rankAt` cuts by zoom, so a continental view cannot sprinkle
//     villages across empty ocean; collision then drops whatever will not fit,
//     in rank order, so the cities that survive a crowd are the ones worth
//     keeping. Neither alone is enough — the cut without collision piles
//     Newark onto New York, and collision without the cut labels whichever
//     hamlet happens to own an empty corner. The cut is not one number: the
//     SELECTED state gets a deeper one (SELECTED_DEEPER), so asking about a
//     state fills that state in and leaves the rest of the map alone. The INK
//     is two numbers for the same reason: the selected state's cities carry
//     the layer's fade suspended, everyone else's carry it as it is, and the
//     two are two draws — see prepare() and draw().
//
//   - placement is re-run every scene frame rather than cached. It is a few
//     hundred candidates against a few hundred rectangles, which is nothing
//     next to the map it draws over, and it is what makes the label set answer
//     to the view: rotate the globe and a name yields to one that outranks it
//     instead of holding a spot it won on the way past.
//
//   - the CAPITAL is recomputed from the assignment, not baked. A state here
//     is whatever counties the user has put in it, so its capital cannot be a
//     property of the city: each city knows the county it stands in (found
//     once, through the picking index), and the capital of a state is the best
//     city among the counties that state currently holds. Redraw a state's
//     borders and its capital moves on its own. Every state's capital is
//     underlined wherever one is drawn; the SELECTED state's is also
//     guaranteed — placed before anything else and exempt from the zoom cut.
//
// The glyph atlas is the state labels', passed in rather than built again —
// one 2.6 MB field texture, and one place where a missing character shows up.

import { TEXT_VS, TEXT_FS, DOT_VS, DOT_FS, ATTRIB, compile } from "./shaders.js";
import { advances } from "./label-layout.js";
import { toXyz } from "./carve.js";

/**
 * The compiled city list. Parallel arrays in priority order — rank, then
 * population — so a lower index is a more prominent city; see build-cities.mjs.
 */
export async function loadCities(signal) {
  const d = await (await fetch("/data/cities.json", { signal })).json();
  const n = d.count;
  const xyz = new Float64Array(n * 3);
  for (let i = 0; i < n; i++) {
    const p = toXyz([d.lon[i], d.lat[i]]);
    xyz[i * 3] = p[0];
    xyz[i * 3 + 1] = p[1];
    xyz[i * 3 + 2] = p[2];
  }
  return {
    count: n,
    name: d.name,
    rank: Uint8Array.from(d.rank),
    /** 1 where Natural Earth calls the place an admin capital. */
    cap: Uint8Array.from(d.cap),
    lon: d.lon,
    lat: d.lat,
    xyz,
  };
}

// Type and symbol sizes, in CSS px. Everything is multiplied by dpr on the way
// to the shader, the way the line widths in the layer table are.
const SIZE = 12.5; // cap height sits a little under this; see BASELINE
const GAP = 4.5; // dot edge to the first letter, and it tracks SIZE
// Where the baseline goes relative to the dot's centre, as a fraction of SIZE.
// Verdana's cap height is about 0.73 em, so half of it below the top puts the
// optical middle of a word of capitals level with the dot it belongs to.
const BASELINE = 0.36;
// A rank 0 city is not four times the town a rank 8 one is, and its dot should
// not be four times the size. The taper is small on purpose — it says "these
// two are not the same" and stops there. Scaled with SIZE, so a dot stays the
// weight its name is set at.
const DOT_R = [3.4, 3.3, 3.1, 2.9, 2.7, 2.5, 2.4, 2.3, 2.2];
// The capital's underline, as fractions of SIZE: how far below the baseline the
// rule sits, and how thick it is. The drop clears the descenders — Verdana's
// reach about 0.21 em, and Springfield, Lansing and Augusta all have one, so a
// tighter rule would strike through the very names it marks.
const UNDERLINE_DROP = 0.26;
const UNDERLINE_WEIGHT = 0.075;

// Padding around a label's box when it is tested against the ones already
// placed. Names that merely clear each other still read as crowded.
const PAD = 3;
// Off-screen margin a city may sit in and still be laid out, so a name whose
// dot is just past the edge does not pop in as the map moves.
const MARGIN = 40;
// A cap on placed labels, not a target. It bounds the collision work at the
// zooms where thousands of candidates are in view, and it is well above what
// any view actually fits.
const MAX_LABELS = 200;

// Which ranks are worth drawing at a given zoom: the deepest Natural Earth rank
// a view of this scale should reach for. Read off d3.zoom's own scale factor,
// so it is the same number the layer table's fadeIn speaks.
//
// This is the half of the density question that collision cannot answer. A
// crowd sorts itself out — the important cities are tried first and the rest
// fail to fit — but empty space does not: with no cut, a whole-continent view
// would find room for whichever hamlet happened to own an empty stretch of
// Nevada and label that instead of nothing. The cut is what makes the wide
// views show a dozen landmarks rather than a scatter.
//
// The steps follow where Natural Earth's own counts step. Rank 1 is 68 cities
// worldwide, which is the right number for a globe; 4 is the 156 US and
// Canadian places an atlas prints at state scale; 6, 7 and 8 add 184, 400 and
// 284 more as the view closes.
const RANK_STEPS = [
  [2, 1],
  [3.5, 2],
  [5, 3],
  [7, 4],
  [9.5, 6],
  [11.5, 7],
  [13.5, 8],
];
const rankAt = (k) => {
  let r = RANK_STEPS[0][1];
  for (const [k0, deepest] of RANK_STEPS) if (k >= k0) r = deepest;
  return r;
};

// How much further down the ladder the cut goes INSIDE the selected state.
// Selecting a state is the app's "look at this one", and the map answers by
// filling that state in: three steps past whatever the rest of the map is
// showing, while everywhere else keeps the density the zoom asked for. Bumping
// the cut everywhere instead would answer a question about one state by
// crowding the other fifty.
//
// A rank offset rather than a second ladder because the ladder's own steps are
// already the shape of the data — going down three of them means "several times
// as many places" at every zoom, which is the thing being asked for.
const SELECTED_DEEPER = 3;

const COLOR = {
  // The state labels' ink, one step lighter: a city name is reference and
  // should not compete with the name of the state it sits in.
  fill: [0x5a / 255, 0x5a / 255, 0x55 / 255, 1],
  halo: [1, 1, 1, 0.8],
  // Darker than the name. The dot is the thing being pointed at, and it is
  // three pixels wide against a word of thirty.
  dot: [0x3a / 255, 0x3a / 255, 0x36 / 255, 1],
};

const FLOATS = 12; // aPen, aQuad, aRect — the state labels' instance format
const STRIDE = FLOATS * 4;
const PARTS = [
  [ATTRIB.aPen, 0],
  [ATTRIB.aQuad, 16],
  [ATTRIB.aRect, 32],
];

export function createCities(gl, { camera, atlas, cities, unitIndex }) {
  const text = compile(gl, TEXT_VS, TEXT_FS);
  const dots = compile(gl, DOT_VS, DOT_FS);

  // ------------------------------------------------------------- capitals
  //
  // Which county each city stands in. Found once, here, through the same index
  // the pointer picks with: counties do not move, so this never has to run
  // again. It is done at construction rather than on the first assignment
  // because it does not depend on one, and the first assignment arrives inside
  // a render — where a few thousand point-in-polygon tests do not belong.
  // `null` for a city outside the map's units, which is most of the world's;
  // those reject on the grid cell without touching a ring.
  const county = new Array(cities.count);
  for (let i = 0; i < cities.count; i++) county[i] = unitIndex.idAt(cities.lon[i], cities.lat[i]);
  // 1 where the city is the capital of the state that currently owns its
  // county. Recomputed whenever the assignment changes.
  const isCapital = new Uint8Array(cities.count);
  // 1 where the city stands in the SELECTED state, which is what the deeper cut
  // in prepare() tests. An array rather than a lookup through the assignment
  // because prepare() runs per frame and this changes only when the model does.
  const inSelected = new Uint8Array(cities.count);
  let selectedState = null;
  /** The selected state's capital, or -1. Placed first and exempt from the cut. */
  let selectedCapital = -1;
  let computedFor = null;

  /**
   * Re-pick every state's capital from the current assignment, and mark the
   * cities the selected state holds. Cheap enough to run on any change: one
   * pass over the city list, and the list is already in priority order.
   *
   * The rule is one rule for real states and invented ones alike. A state's
   * capital is the most prominent city it holds — lowest Natural Earth rank,
   * then largest — EXCEPT that a city Natural Earth marks as an admin capital
   * beats prominence. So Illinois gets Springfield rather than Chicago, and a
   * state drawn from counties that contain no real capital gets its biggest
   * city, which is what an invented state's capital would be.
   *
   * A carved county still works, and not by accident: main.js's
   * globeLabelAssign hands a carved parent's fips to the state of its largest
   * piece before the assignment gets here, so a city in a split county belongs
   * to the bigger half. That is the same coarse rule the state labels are laid
   * out under, which is what keeps a capital and its state name agreeing.
   */
  function recompute(assign, selected) {
    isCapital.fill(0);
    inSelected.fill(0);
    selectedCapital = -1;
    const best = new Map(); // state id -> city index
    for (let i = 0; i < cities.count; i++) {
      const unit = county[i];
      if (unit == null) continue;
      const state = assign.get(unit);
      if (state == null) continue;
      if (state === selected) inSelected[i] = 1;
      const held = best.get(state);
      // Ascending i, so the incumbent is always the more prominent of the two.
      // Only an admin capital can displace it.
      if (held === undefined || (cities.cap[i] && !cities.cap[held])) best.set(state, i);
    }
    for (const i of best.values()) isCapital[i] = 1;
    if (selected != null) selectedCapital = best.get(selected) ?? -1;
  }

  /**
   * Called by map.js on the same signal the state labels re-lay out on. The
   * SELECTION is keyed in alongside the assignment because it changes the same
   * two answers — which state's capital is the one to guarantee, and which
   * cities are inside it — and it arrives on the same refresh.
   */
  function update({ assign, assignVersion, selected = null }) {
    if (!assign) return;
    const key = assignVersion == null ? null : `${assignVersion}:${selected}`;
    if (key != null && key === computedFor) return;
    computedFor = key;
    selectedState = selected;
    recompute(assign, selected);
  }

  const corners = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, 0, 0, 1, 1, 0, 1, 1]), gl.STATIC_DRAW);

  // Every stream draws the same unit quad, instanced, and they differ only in
  // what one instance carries — `bind` is that part. The fill count lives with
  // the buffer rather than beside it, which is what lets a batch below be
  // filled and drawn without a parallel set of counters.
  const stream = (capacity, floats, bind) => {
    const buffer = gl.createBuffer();
    const vao = gl.createVertexArray();
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, corners);
    gl.enableVertexAttribArray(ATTRIB.aCorner);
    gl.vertexAttribPointer(ATTRIB.aCorner, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    bind();
    gl.bindVertexArray(null);
    return { buffer, vao, floats, data: new Float32Array(capacity * floats), n: 0 };
  };
  // Glyphs and underlines share the TEXT program and its instance format, and
  // differ only in uSolid — a rule is a plain quad that samples no atlas, the
  // way the state labels' leader lines are. Two buffers rather than two ranges
  // of one, because they are filled in the same loop and a single buffer would
  // have to be laid out in two passes to keep each draw contiguous.
  const textStream = (capacity) =>
    stream(capacity, FLOATS, () => {
      for (const [loc, off] of PARTS) {
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 4, gl.FLOAT, false, STRIDE, off);
        gl.vertexAttribDivisor(loc, 1);
      }
    });
  // One instance per placed dot: xyz on the sphere, radius in device px.
  const dotStream = () =>
    stream(MAX_LABELS, 4, () => {
      gl.enableVertexAttribArray(ATTRIB.aPos);
      gl.vertexAttribPointer(ATTRIB.aPos, 4, gl.FLOAT, false, 16, 0);
      gl.vertexAttribDivisor(ATTRIB.aPos, 1);
    });

  // A batch is one alpha's worth of cities — its dots, its letters, its
  // underlines. There are two of them, and the split is not by anything on the
  // page: the selected state's cities and everyone else's fade in on different
  // schedules, a fade is a uniform, so two schedules mean two draws. See
  // prepare() for what the two alphas are and why.
  const batch = () => ({
    dots: dotStream(),
    glyphs: textStream(4096),
    // One instance per underline, so it cannot need more than the label cap.
    rules: textStream(MAX_LABELS),
  });
  const rest = batch();
  const sel = batch();
  const streams = [rest, sel].flatMap((b) => [b.dots, b.glyphs, b.rules]);
  let restAlpha = 1;
  let selAlpha = 1;

  // Placed boxes: x0 y0 x1 y1 per label, tested against by the next candidate.
  // ONE set across both batches: the two differ in ink, not in where they are,
  // and a name may not be laid over a name whichever batch each is in.
  const boxes = new Float64Array(MAX_LABELS * 4);
  let boxCount = 0;

  // One instance into one of the text streams. The tangent is always (1, 0):
  // a city name is set on the page, not painted on the ground, so it neither
  // follows a great circle nor foreshortens the way a state name does.
  function push(s, px, py, qx, qy, qw, qh, u0, v0, u1, v1) {
    if ((s.n + 1) * FLOATS > s.data.length) {
      const grown = new Float32Array(s.data.length * 2);
      grown.set(s.data);
      s.data = grown;
    }
    let i = s.n++ * FLOATS;
    s.data[i++] = px;
    s.data[i++] = py;
    s.data[i++] = 1;
    s.data[i++] = 0;
    s.data[i++] = qx;
    s.data[i++] = qy;
    s.data[i++] = qw;
    s.data[i++] = qh;
    s.data[i++] = u0;
    s.data[i++] = v0;
    s.data[i++] = u1;
    s.data[i++] = v1;
  }

  const free = (x0, y0, x1, y1) => {
    for (let i = 0; i < boxCount; i++) {
      const j = i * 4;
      if (x0 < boxes[j + 2] && x1 > boxes[j] && y0 < boxes[j + 3] && y1 > boxes[j + 1]) return false;
    }
    return true;
  };

  /**
   * Project, cut by rank, place what fits, and fill the instance buffers.
   * Call it inside the pass that draws them: the set answers to the camera and
   * to nothing else, so whatever decides to redraw the map decides this too.
   *
   * @param alpha the city layer's fade, which is the ink for the map at large.
   * @param selectedAlpha the ink for the SELECTED state's own cities. The layer
   *   table holds this at full while a state is selected (showWhenSelected),
   *   because a state picked at the home view has to show its capital at a zoom
   *   where the layer itself has not faded in. It is a second alpha rather than
   *   a lift on the layer's own for the same reason SELECTED_DEEPER is a second
   *   cut: the question was about one state, and answering it by bringing every
   *   city in the world up out of the paper answers something else.
   */
  function prepare(alpha, selectedAlpha = alpha) {
    restAlpha = alpha;
    selAlpha = selectedAlpha;
    for (const s of streams) s.n = 0;
    boxCount = 0;
    const scale = camera.radiusPx();
    const center = camera.center();
    const m = camera.matrix64;
    const dpr = camera.view.dpr;
    const vw = camera.view.width;
    const vh = camera.view.height;
    const maxRank = rankAt(camera.view.k);
    // What the map at large will draw. A batch at alpha zero is not merely
    // invisible, it is absent: a name nobody can see must not be the reason a
    // visible one moved, and with the layer faded out under a selection the
    // whole page belongs to the selected state.
    const restRank = restAlpha === 0 ? -1 : maxRank;
    // The selected state's own cut, deeper than the map's. Equal to it when
    // nothing is selected, which is what keeps the walk below stopping exactly
    // where it always did.
    const selectedRank = selectedState == null ? restRank : maxRank + SELECTED_DEEPER;
    const size = SIZE * dpr;
    const gap = GAP * dpr;
    const pad = PAD * dpr;
    const margin = MARGIN * dpr;

    // One candidate: project it, drop it if it faces away, falls off the screen
    // or lands under a name already placed, and otherwise write its dot, its
    // letters and — if it is a capital — its rule.
    const place = (i) => {
      const rank = cities.rank[i];
      const x = cities.xyz[i * 3];
      const y = cities.xyz[i * 3 + 1];
      const z = cities.xyz[i * 3 + 2];
      // The near hemisphere only. A dot on the far side would otherwise be
      // drawn through the globe.
      if (m[0] * x + m[3] * y + m[6] * z <= 0) return;
      const sx = center[0] + (m[1] * x + m[4] * y + m[7] * z) * scale;
      const sy = center[1] - (m[2] * x + m[5] * y + m[8] * z) * scale;
      if (sx < -margin || sy < -margin || sx > vw + margin || sy > vh + margin) return;

      const name = cities.name[i];
      const r = DOT_R[rank] * dpr;
      const adv = advances(name);
      const width = (adv[name.length] / 100) * size;
      const x0 = sx - r;
      const x1 = sx + r + gap + width;
      const y0 = sy - size * 0.6;
      const y1 = sy + size * 0.4;
      if (!free(x0 - pad, y0 - pad, x1 + pad, y1 + pad)) return;

      const j = boxCount * 4;
      boxes[j] = x0;
      boxes[j + 1] = y0;
      boxes[j + 2] = x1;
      boxes[j + 3] = y1;
      boxCount++;

      // Which ink this one is drawn in, and the only thing the split decides.
      const b = inSelected[i] ? sel : rest;
      const d = b.dots.n++ * 4;
      b.dots.data[d] = x;
      b.dots.data[d + 1] = y;
      b.dots.data[d + 2] = z;
      b.dots.data[d + 3] = r;

      const penX = sx + r + gap;
      const penY = sy + BASELINE * size;
      for (let c = 0; c < name.length; c++) {
        const g = atlas.get(name[c]);
        if (!g || g.blank) continue;
        push(
          b.glyphs,
          penX + (adv[c] / 100) * size,
          penY,
          g.qx * size,
          g.qy * size,
          g.qw * size,
          g.qh * size,
          g.u0,
          g.v0,
          g.u1,
          g.v1,
        );
      }

      // The capital's rule, under the name only and not under its dot. qy of
      // half the weight centres the quad on the pen, so the rule thickens
      // about its own line rather than drifting down as it grows.
      if (isCapital[i]) {
        const w = Math.max(dpr, UNDERLINE_WEIGHT * size);
        push(b.rules, penX, penY + UNDERLINE_DROP * size, 0, w / 2, width, w, 0, 0, 0, 0);
      }
    };

    // The selected state's capital goes down FIRST and answers to no cut at
    // all. "Show me this state" has to include the seat of it whatever the zoom
    // and whatever rank Natural Earth gave the town — a state drawn out of
    // three rural counties has a capital too. Going first is the other half of
    // the guarantee: a name tried before every other cannot be the one that
    // loses a collision.
    if (selectedCapital >= 0) place(selectedCapital);

    // The list is sorted by rank, so this walks in priority order and stops at
    // the first city no cut on the map wants — no scan of the tail. Between the
    // two cuts only the selected state's own cities pass, and they are still
    // tried in rank order, so a town that came in on the deeper cut takes
    // whatever room the map's landmarks have left rather than displacing one.
    for (let i = 0; i < cities.count && boxCount < MAX_LABELS; i++) {
      const rank = cities.rank[i];
      if (rank > selectedRank) break;
      if (rank > restRank && !inSelected[i]) continue;
      if (i === selectedCapital) continue; // placed above
      place(i);
    }

    for (const s of streams) {
      if (!s.n) continue;
      gl.bindBuffer(gl.ARRAY_BUFFER, s.buffer);
      gl.bufferData(gl.ARRAY_BUFFER, s.data.subarray(0, s.n * s.floats), gl.DYNAMIC_DRAW);
    }
  }

  /** One batch, at its own alpha. */
  function drawBatch(b, alpha) {
    if (!b.dots.n || alpha <= 0) return 0;
    const a = (c) => [c[0], c[1], c[2], c[3] * alpha];

    gl.useProgram(dots.program);
    gl.uniformMatrix3fv(dots.u.uRot, false, camera.matrix);
    gl.uniform1f(dots.u.uScale, camera.radiusPx());
    gl.uniform2fv(dots.u.uCenter, camera.center());
    gl.uniform2f(dots.u.uViewport, camera.view.width, camera.view.height);
    gl.uniform4fv(dots.u.uColor, a(COLOR.dot));
    gl.bindVertexArray(b.dots.vao);
    gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.dots.n);

    let calls = 1;
    if (b.glyphs.n) {
      gl.useProgram(text.program);
      gl.uniform2f(text.u.uViewport, camera.view.width, camera.view.height);
      gl.uniform1f(text.u.uHalo, atlas.haloUnits);
      gl.uniform1i(text.u.uSolid, 0);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, atlas.texture);
      gl.uniform1i(text.u.uAtlas, 0);
      gl.bindVertexArray(b.glyphs.vao);
      // Every halo, then every fill — `paint-order: stroke` across the whole
      // set rather than per glyph, exactly as the state labels do it, so one
      // letter's halo cannot land on top of its neighbour.
      gl.uniform1i(text.u.uHaloPass, 1);
      gl.uniform4fv(text.u.uColor, a(COLOR.halo));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.glyphs.n);
      gl.uniform1i(text.u.uHaloPass, 0);
      gl.uniform4fv(text.u.uColor, a(COLOR.fill));
      gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.glyphs.n);
      calls += 2;

      // The capitals' rules last, in the same ink as the names and over them.
      // uSolid short-circuits the atlas, so this is the same program drawing a
      // plain quad — no second shader for a two-pixel line.
      if (b.rules.n) {
        gl.uniform1i(text.u.uSolid, 1);
        gl.bindVertexArray(b.rules.vao);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, b.rules.n);
        calls++;
      }
    }
    gl.bindVertexArray(null);
    return calls;
  }

  /**
   * The map at large first and the selected state over it. Halos are per batch
   * rather than across both, which is only visible where a name of one batch
   * abuts a name of the other — and the collision pass has already put a
   * gutter between any two names there are.
   *
   * @returns how many draw calls it made, for the renderer's stats.
   */
  const draw = () => drawBatch(rest, restAlpha) + drawBatch(sel, selAlpha);

  return {
    prepare,
    draw,
    update,
    get stats() {
      return {
        candidates: cities.count,
        placed: boxCount,
        glyphs: rest.glyphs.n + sel.glyphs.n,
        capitals: rest.rules.n + sel.rules.n,
      };
    },
  };
}
