// C5 — the glyph atlas.
//
// Labels are sized in ground units, so a name that reads 10 px across at the
// home view reads 160 px at maximum zoom. A bitmap atlas would be soft at one
// end or the other; a signed distance field is one texture for both, and it
// hands back the halo for free — the SVG labels wear a white stroke under the
// glyph, and a stroke is one more threshold on the same distance.
//
// Nothing is baked at build time. State names are editable, so the character
// set is not knowable in advance: cells are rasterized on demand out of the
// same canvas 2D context labels.js measures with, which is also what keeps the
// advance widths the layout fitted against and the widths drawn here identical.
//
// What decides whether the type reads is where the field puts the outline, and
// two things move it:
//
//   EM        texels per em. The field's error is a fraction of a texel, so EM
//             is what that error is worth as a fraction of the glyph. At the
//             home view a name draws around 20-40 device px and at maximum zoom
//             around 600, where the atlas is magnified ten times and a fraction
//             of a texel is a visible wobble on every curve.
//   coverage  the raster's antialiasing already says where inside a texel the
//             outline falls. This file used to threshold that away at alpha
//             127, which snaps the field's zero crossing to the midpoints
//             between texel centres: the outline is then quantized to the grid,
//             it steps rather than slides, and the letters carry the staircase
//             of the bitmap they came from. Measured against a known circle,
//             thresholding costs 0.22 texels RMS and seeding from coverage
//             costs 0.03.

const FONT = "Verdana, Geneva, Tahoma, sans-serif";
// Texels per em. Everything below is a fraction of it, so this is the one
// number to turn when the labels want more or less resolution.
const EM = 64;
const PAD = Math.round(0.25 * EM); //  16, margin around a glyph's ink for the field to live in
const SPREAD = Math.round(0.2 * EM); // 13, texels the field is measured over, either side of the outline
const CELL = Math.ceil(1.8 * EM); //   116, one glyph's square of the atlas
const COLS = 14;
const ROWS = 14;
const SIZE = CELL * COLS; //           1624, a 2.6 MB R8 texture

// The halo the SVG labels wear is stroke-width max(1.4, size * 0.2) painted
// under the glyph, so half of it shows outside the outline: 0.1 em above the
// size where the floor lets go. The field is measured in em too, so this reach
// is the same number at every size — which is why the shader takes it as a
// constant rather than a per-label uniform. The floor is the shader's own, in
// device pixels rather than in em, since that is what small type needs.
export const HALO_UNITS = (0.1 * EM) / (2 * SPREAD);

// 8SSEDT, run over one cell at a time. Cells are padded and independent, so a
// glyph added later costs one cell rather than a rebuild of the whole atlas.
// Two sweeps of two passes each.
//
// It hands back the VECTOR to the nearest seed, not just its length, because
// the field below needs to ask that seed where inside itself the outline sits.
// The seed of texel (x, y) is at (x - dx, y - dy): `compare` stores the offset
// from the neighbour it propagated through, which points back the other way.
function nearestSeed(seeded, w, h) {
  const INF = 1e9;
  const dx = new Float64Array(w * h);
  const dy = new Float64Array(w * h);
  const d2 = new Float64Array(w * h);

  for (let i = 0; i < w * h; i++) {
    if (seeded(i)) {
      dx[i] = 0;
      dy[i] = 0;
      d2[i] = 0;
    } else {
      dx[i] = INF;
      dy[i] = INF;
      d2[i] = INF;
    }
  }
  const compare = (i, x, y, ox, oy) => {
    const nx = x + ox;
    const ny = y + oy;
    if (nx < 0 || ny < 0 || nx >= w || ny >= h) return;
    const j = ny * w + nx;
    const cx = dx[j] - ox;
    const cy = dy[j] - oy;
    const c = cx * cx + cy * cy;
    if (c < d2[i]) {
      d2[i] = c;
      dx[i] = cx;
      dy[i] = cy;
    }
  };
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      compare(i, x, y, -1, 0);
      compare(i, x, y, 0, -1);
      compare(i, x, y, -1, -1);
      compare(i, x, y, 1, -1);
    }
    for (let x = w - 1; x >= 0; x--) compare(y * w + x, x, y, 1, 0);
  }
  for (let y = h - 1; y >= 0; y--) {
    for (let x = w - 1; x >= 0; x--) {
      const i = y * w + x;
      compare(i, x, y, 1, 0);
      compare(i, x, y, 0, 1);
      compare(i, x, y, -1, 1);
      compare(i, x, y, 1, 1);
    }
    for (let x = 0; x < w; x++) compare(y * w + x, x, y, -1, 0);
  }
  return { dx, dy, d2 };
}

/**
 * The signed distance field of a 1-bit mask, in texels, positive inside. Exact:
 * every texel gets its true distance to the nearest texel of the other class.
 * Kept because it is what a brute-force check can be written against, and
 * because it is the fallback for a mask with no outline in it at all.
 */
export function edt(inside, w, h) {
  const toInk = nearestSeed((i) => inside[i], w, h);
  const toAir = nearestSeed((i) => !inside[i], w, h);
  const sd = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++)
    sd[i] = inside[i] ? Math.sqrt(toAir.d2[i]) : -Math.sqrt(toInk.d2[i]);
  return sd;
}

// Where inside a texel the outline falls, from that texel's own coverage and
// the direction the coverage is changing. A straight edge cuts a unit square
// into a triangle at each extreme and a trapezium in between, and inverting
// each of those three gives the offset. Gustavson and Strand, "Fast distance
// transforms of anti-aliased images", signed here to run positive inside.
function edgeOffset(gx, gy, a) {
  const len = Math.hypot(gx, gy);
  if (len < 1e-9) return a - 0.5; // no direction to speak of: take it as flat
  let nx = Math.abs(gx) / len;
  let ny = Math.abs(gy) / len;
  if (nx < ny) {
    const t = nx;
    nx = ny;
    ny = t; // the shallower axis second, so nx is never zero
  }
  const corner = 0.5 * (ny / nx); // coverage at which the cut stops being a triangle
  if (a < corner) return Math.sqrt(2 * nx * ny * a) - 0.5 * (nx + ny);
  if (a < 1 - corner) return (a - 0.5) * nx;
  return 0.5 * (nx + ny) - Math.sqrt(2 * nx * ny * (1 - a));
}

/**
 * The signed distance field of an ANTIALIASED raster, in texels, positive
 * inside. This is what the atlas draws from, and the whole of what it adds over
 * `edt` is sub-texel accuracy: coverage says where in a texel the outline is,
 * so the field's zero crossing lands there instead of on the texel grid.
 *
 * The propagation is seeded from the band of texels that straddle the outline,
 * each carrying its own offset, and every other texel reads its nearest seed's
 * offset off the end of its own distance. That is exact where the outline is
 * locally straight, which at this resolution is nearly everywhere.
 */
export function fieldFromCoverage(cov, w, h) {
  const n = w * h;
  const inside = new Uint8Array(n);
  for (let i = 0; i < n; i++) inside[i] = cov[i] > 0.5 ? 1 : 0;

  const at = (x, y) => cov[Math.min(h - 1, Math.max(0, y)) * w + Math.min(w - 1, Math.max(0, x))];

  // The seeds. Partial coverage alone would be the obvious test and it misses a
  // case: an edge landing exactly on a texel boundary antialiases to nothing,
  // and that stretch of outline would then take its offset from some unrelated
  // seed far along the glyph. Straddling the threshold catches both.
  const seed = new Uint8Array(n);
  const off = new Float64Array(n);
  let seeds = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const me = inside[i];
      if (
        !(x > 0 && inside[i - 1] !== me) &&
        !(x < w - 1 && inside[i + 1] !== me) &&
        !(y > 0 && inside[i - w] !== me) &&
        !(y < h - 1 && inside[i + w] !== me)
      )
        continue;
      seed[i] = 1;
      seeds++;
      // Sobel over the coverage, with the corners at sqrt(2) rather than 2 so
      // that a diagonal outline reports its true angle. The gradient climbs
      // into the ink, which is the direction the offset is measured along.
      const gx =
        at(x + 1, y - 1) + Math.SQRT2 * at(x + 1, y) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - Math.SQRT2 * at(x - 1, y) - at(x - 1, y + 1);
      const gy =
        at(x - 1, y + 1) + Math.SQRT2 * at(x, y + 1) + at(x + 1, y + 1) -
        at(x - 1, y - 1) - Math.SQRT2 * at(x, y - 1) - at(x + 1, y - 1);
      off[i] = edgeOffset(gx, gy, cov[i]);
    }
  }
  // All ink or all air — a space, or a cell the glyph missed. No outline to be
  // accurate about.
  if (!seeds) return edt(inside, w, h);

  const near = nearestSeed((i) => seed[i], w, h);
  const sd = new Float64Array(n);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      const j = (y - near.dy[i]) * w + (x - near.dx[i]);
      sd[i] = (inside[i] ? 1 : -1) * Math.sqrt(near.d2[i]) + off[j];
    }
  }
  return sd;
}

export function createGlyphAtlas(gl) {
  const canvas = document.createElement("canvas");
  canvas.width = CELL;
  canvas.height = CELL;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  ctx.font = `${EM}px ${FONT}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, SIZE, SIZE, 0, gl.RED, gl.UNSIGNED_BYTE, null);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);

  const glyphs = new Map();
  let next = 0;
  let overflowed = false;

  function rasterize(ch) {
    if (next >= COLS * ROWS) {
      overflowed = true;
      return null;
    }
    const slot = next++;
    const cx = (slot % COLS) * CELL;
    const cy = Math.floor(slot / COLS) * CELL;

    const m = ctx.measureText(ch);
    const left = m.actualBoundingBoxLeft ?? 0;
    const right = m.actualBoundingBoxRight ?? m.width;
    const asc = m.actualBoundingBoxAscent ?? EM * 0.75;
    const desc = m.actualBoundingBoxDescent ?? EM * 0.25;
    const w = Math.min(CELL, Math.ceil(left + right) + 2 * PAD);
    const h = Math.min(CELL, Math.ceil(asc + desc) + 2 * PAD);

    ctx.clearRect(0, 0, CELL, CELL);
    ctx.fillStyle = "#fff";
    ctx.fillText(ch, PAD + left, PAD + asc);
    // Alpha over a cleared canvas is the glyph's coverage, which is the
    // rasterizer's own answer to where the outline crosses each texel. The
    // browser may put a little contrast curve through it, so it is coverage to
    // within a few percent rather than exactly — still a great deal more than
    // the one bit this used to keep.
    const px = ctx.getImageData(0, 0, w, h).data;
    const cov = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) cov[i] = px[i * 4 + 3] / 255;
    const sd = fieldFromCoverage(cov, w, h);
    // One byte across 2 * SPREAD texels, which is 0.4 em however EM is set, so
    // a step is 0.0016 em. That is now the floor on where the outline can sit —
    // finer than the field's own error, and worth about a quarter of a device
    // pixel at maximum zoom. Raising EM does not move it; only a narrower SPREAD
    // or a wider texture format would.
    const field = new Uint8Array(w * h);
    for (let i = 0; i < w * h; i++)
      field[i] = Math.max(0, Math.min(255, Math.round(255 * (0.5 + sd[i] / (2 * SPREAD)))));

    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texSubImage2D(gl.TEXTURE_2D, 0, cx, cy, w, h, gl.RED, gl.UNSIGNED_BYTE, field);

    // Everything the placer needs, in em, measured from the pen on the
    // baseline: where the quad's top-left corner sits, and how big it is.
    const g = {
      u0: cx / SIZE,
      v0: cy / SIZE,
      u1: (cx + w) / SIZE,
      v1: (cy + h) / SIZE,
      qx: (-left - PAD) / EM,
      qy: (asc + PAD) / EM,
      qw: w / EM,
      qh: h / EM,
      blank: right + left <= 0,
    };
    glyphs.set(ch, g);
    return g;
  }

  return {
    texture,
    /** The glyph's box and atlas rect, in em. Rasterized the first time it is asked for. */
    get: (ch) => glyphs.get(ch) ?? rasterize(ch),
    haloUnits: HALO_UNITS,
    get stats() {
      return { glyphs: glyphs.size, capacity: COLS * ROWS, overflowed };
    },
  };
}
