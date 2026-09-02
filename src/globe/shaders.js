// C2 — GLSL for the globe renderer.
//
// Three programs draw the whole scene:
//
//   disc   the ocean. Analytic, because an orthographic sphere is always a
//          circle of radius `scale` about the centre. It does not move when the
//          globe turns.
//   fill   indexed triangles on the unit sphere.
//   line   instanced screen-space quads, one per segment.
//
// The atlas band uses two of them rather than a program of its own: the line
// program strokes the borders into the stencil, and the fill program redraws
// the county fills through that stencil. See the band note below.
//
// All of them share one camera: rotate the unit-sphere position by a mat3, then
// take (y, -z) and scale. d3.geoOrthographic looks down +x, so that pair is the
// picture and x is depth toward the viewer. The matrix reproduces
// d3.geoOrthographic to 1e-16 — the C1 compiler checks it on every build.

// Shared by every program that touches geometry.
const CAMERA = `
uniform mat3 uRot;        // the rotation. The whole camera change, per frame.
uniform float uScale;     // sphere radius in device px
uniform vec2 uCenter;     // device px where the sub-viewer point lands
uniform vec2 uViewport;

vec2 project(vec3 p) { return uCenter + vec2(p.y, -p.z) * uScale; }

vec4 toClip(vec2 pos) {
  vec2 c = pos / uViewport * 2.0 - 1.0;
  return vec4(c.x, -c.y, 0.0, 1.0);
}
`;

// unit id -> RGBA. Repainting a county is one texel write instead of a buffer
// re-upload; C3 hangs the whole palette, hover tint and selection off this.
const PALETTE = `
uniform sampler2D uPalette;
uniform int uPaletteWidth;

vec4 unitColor(uint unit) {
  int i = int(unit);
  return texelFetch(uPalette, ivec2(i % uPaletteWidth, i / uPaletteWidth), 0);
}
`;

// Sentinels, mirrored from the manifest. UNIT_NONE means "not a unit boundary
// at all"; UNIT_OUTSIDE means "beyond the map's units".
const SENTINELS = `
const uint UNIT_NONE = 65534u;
const uint UNIT_OUTSIDE = 65535u;
bool isUnit(uint u) { return u < UNIT_NONE; }
`;

// C7. The second per-unit table, beside the palette: not what a unit is
// PAINTED, but what it BELONGS TO. Same layout, one texel per unit.
//
//   r, g   the state's index, low byte first
//   b      flags: 1 outside the union, 2 in the selected state
//   a      the state's country, as a dense index (paintGlobe assigns them)
//
// The line shader needs this and the fill shader does not, and the reason is
// the whole point of the table. A fill asks one question about one unit and the
// palette already answers it. Every interesting line asks a question about the
// TWO units it separates — is this a state border or a county hairline, does
// the band run along it, is it part of the selected state's outline — and those
// answers change when territory does, without any vertex moving. main.js
// answers them on the CPU and re-uploads a colour per segment (getColor,
// getFilterValue); here they are three texel reads in the vertex shader.
const UNIT_ATTR = `
uniform sampler2D uAttr;
uniform int uAttrWidth;

struct Owner {
  bool unit;   // a real unit, rather than a sentinel
  int state;   // which state holds it
  bool alien;  // that state is outside the union
  bool chosen; // that state is the selected one
  int country; // which country that state flies the flag of
};

Owner ownerOf(uint unit) {
  Owner o = Owner(false, -1, false, false, -1);
  if (!isUnit(unit)) return o;
  int i = int(unit);
  vec4 t = texelFetch(uAttr, ivec2(i % uAttrWidth, i / uAttrWidth), 0);
  uint r = uint(t.r * 255.0 + 0.5);
  uint g = uint(t.g * 255.0 + 0.5);
  uint b = uint(t.b * 255.0 + 0.5);
  o.unit = true;
  o.state = int(r | (g << 8u));
  o.alien = (b & 1u) != 0u;
  o.chosen = (b & 2u) != 0u;
  o.country = int(t.a * 255.0 + 0.5);
  return o;
}
`;

// --------------------------------------------------------------------- disc

export const DISC_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
uniform float uScale;
uniform vec2 uCenter;
uniform vec2 uViewport;
out vec2 vLocal;
void main() {
  vLocal = aCorner;
  vec2 pos = uCenter + aCorner * (uScale + 2.0);
  vec2 c = pos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

export const DISC_FS = `#version 300 es
precision highp float;
in vec2 vLocal;
uniform float uScale;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  float r = length(vLocal) * (uScale + 2.0);
  float a = clamp(uScale + 0.5 - r, 0.0, 1.0);
  if (a <= 0.0) discard;
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

// --------------------------------------------------------------------- fill

export const FILL_VS = `#version 300 es
precision highp float;
${CAMERA}
${PALETTE}
${SENTINELS}

in vec3 aPos;
in uint aUnit;

uniform vec4 uColor;      // used when the group carries no unit ids
uniform bool uUseUnit;

out float vFront;
out vec4 vColor;

void main() {
  vec3 p = uRot * aPos;
  vFront = p.x;
  vColor = (uUseUnit && isUnit(aUnit)) ? unitColor(aUnit) : uColor;
  gl_Position = toClip(project(p));
}`;

export const FILL_FS = `#version 300 es
precision highp float;
in float vFront;
in vec4 vColor;
out vec4 fragColor;
void main() {
  // The horizon, antialiased. vFront is the rotated x, which is the signed
  // distance to the plane through the sphere's centre, so dividing by its
  // screen-space derivative turns it into a distance in pixels. One line here
  // replaces d3-geo's CPU clipping entirely.
  //
  // It cuts along the chord of each triangle rather than the true great
  // circle, which is why the C1 compiler refines interior edges to 120 km:
  // the sag of that chord stays under a pixel even at max zoom.
  float fw = max(fwidth(vFront), 1e-12);
  float a = clamp(vFront / fw + 0.5, 0.0, 1.0);
  if (a <= 0.0) discard;
  fragColor = vec4(vColor.rgb, vColor.a * a);
}`;

// --------------------------------------------------------------------- line

// Screen-space quad expansion, lifted from the C0 spike with the unit pair
// added. Both endpoints are rotated and projected here, so the CPU never
// touches a vertex — that is the entire thesis of the rewrite.
export const LINE_VS = `#version 300 es
precision highp float;
${CAMERA}
${SENTINELS}
${UNIT_ATTR}

in vec2 aCorner;          // x: 0|1 along the segment, y: 0|1 across it
in vec3 aStart;
in vec3 aEnd;
in uint aLeft;
in uint aRight;

uniform float uHalfWidth; // device px, half the stroke
uniform float uFeather;   // device px of antialiasing skirt
uniform bool uSkipEqual;  // drop instances whose two sides carry the same unit
uniform vec4 uColor;      // the stroke, or in mode 1 the hairline
uniform vec4 uColorB;     // mode 1 only: what a state border wears instead
uniform int uMode;        // see below

// What the two sides of a segment decide, and it is one of four things:
//
//   0 PLAIN     nothing. Scenery, graticules, lake edges — one colour, and the
//               unit pair only ever culls a duplicate (uSkipEqual).
//   1 ARCS      whether this is a state border (uColorB) or a county hairline
//               (uColor). One layer covers both, so the continent's arcs make a
//               single pass, which is what main.js's merged map-lines layer
//               does with a per-segment colour attribute.
//   2 BAND      whether the border band runs along here at all. This pass
//               writes the stencil the band is drawn through and no colour.
//   3 OUTLINE   whether this segment is on the selected state's edge.
//
// Modes 1-3 all ask the same two questions in the same order — are both sides
// units, and do their states differ — because a map-EDGE run (exactly one side
// a unit) is a real border of the union wherever its owner is in the union, and
// an interior arc is one wherever its two sides disagree. Two units that are
// both outside the union agree for this purpose however different they are:
// unpainted territory wears one tan and reads as context, not as states.
const int MODE_PLAIN = 0;
const int MODE_ARCS = 1;
const int MODE_BAND = 2;
const int MODE_OUTLINE = 3;

out float vFront;         // > 0 on the near hemisphere
out float vAcross;        // device px from the centreline
out float vAlong;         // device px from the start, measured along the segment
out float vLen;           // the segment's own length in device px
flat out vec4 vColor;

void main() {
  vec3 a = uRot * aStart;
  vec3 b = uRot * aEnd;
  vFront = mix(a.x, b.x, aCorner.x);
  vAcross = 0.0;
  vAlong = 0.0;
  vLen = 0.0;
  vColor = uColor;

  // Roughly half the sphere faces away at any moment, and a single-user county
  // arc — same unit on both sides — is the nation's own edge, drawn by the
  // coast and border groups instead. Collapse both here rather than discarding
  // in the fragment stage, which still pays to rasterize the quad first.
  bool cull = (a.x < 0.0 && b.x < 0.0) || (uSkipEqual && aLeft == aRight);

  if (!cull && uMode != MODE_PLAIN) {
    Owner l = ownerOf(aLeft);
    Owner r = ownerOf(aRight);
    bool interior = l.unit && r.unit;
    bool edge = l.unit != r.unit;
    // The owner of a map-edge run, read field by field rather than as a struct
    // ternary: ES 3.00 allows one, and there is no reason to find out which
    // driver disagrees.
    bool ownAlien = l.unit ? l.alien : r.alien;
    bool ownChosen = l.unit ? l.chosen : r.chosen;
    bool split = interior && l.state != r.state && !(l.alien && r.alien);
    // The one thing two units outside the union do NOT agree about. They wear
    // one tan and read as context rather than as states, so no band and no
    // outline runs between them — but where they belong to different
    // COUNTRIES, the line between them is an international border, and the
    // world scenery behind the map draws its own in this same grey. Without
    // this, Mexico and Guatemala are divided by the same faint hairline that
    // separates two Mexican states, while France and Spain are not.
    bool foreignBorder = interior && l.alien && r.alien && l.country != r.country;
    if (uMode == MODE_ARCS) {
      vColor = (split || foreignBorder) ? uColorB : uColor;
    } else if (uMode == MODE_BAND) {
      cull = !(interior ? split : edge && !ownAlien);
    } else {
      cull = !(interior ? l.chosen != r.chosen : edge && ownChosen);
    }
  }
  // Nothing to paint is nothing to rasterize. This is how the data view drops
  // the county hairlines: their colour goes to zero alpha and the quad never
  // reaches the fragment stage, rather than being blended away one pixel at a
  // time.
  if (vColor.a <= 0.0) cull = true;

  if (cull) {
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vec2 pa = project(a);
  vec2 pb = project(b);

  vec2 d = pb - pa;
  float len = length(d);
  vec2 dir = len > 1e-6 ? d / len : vec2(1.0, 0.0);
  vec2 nrm = vec2(-dir.y, dir.x);

  // Across the segment: the stroke plus the antialiasing ramp. Along it: the
  // stroke's own half width and HALF THE RAMP, and no more — just enough for
  // the round cap the fragment shader carves out of this quad to keep its
  // antialiasing at the tip. Extending by a whole feather instead drew an 8 px
  // quad for a 2 px line and cost 5 ms of the C0 budget on its own; that is
  // easy to reintroduce by accident, so the half is deliberate.
  // aCorner.y arrives as 0|1 so that the band program can share this VAO; the
  // stroke wants it as -1|+1.
  float side = aCorner.y * 2.0 - 1.0;
  float across = uHalfWidth + uFeather;
  float ext = uHalfWidth + uFeather * 0.5;
  vec2 along = dir * ext * (aCorner.x * 2.0 - 1.0);
  vec2 pos = mix(pa, pb, aCorner.x) + along + nrm * side * across;

  vAcross = side * across;
  vAlong = aCorner.x * len + ext * (aCorner.x * 2.0 - 1.0);
  vLen = len;
  gl_Position = toClip(pos);
}`;

export const LINE_FS = `#version 300 es
precision highp float;
in float vFront;
in float vAcross;
in float vAlong;
in float vLen;
flat in vec4 vColor;
uniform float uHalfWidth;
uniform float uFeather;
out vec4 fragColor;
void main() {
  if (vFront < 0.0) discard;
  // Distance to the SEGMENT, not to its centreline: past either end the
  // fragment is measured from the endpoint, which rounds the cap. That is also
  // what rounds the joins — two capsules sharing an endpoint union into the
  // stroke with a round join at it — so the buffers still need no adjacency.
  //
  // Square caps looked fine on the county hairlines and wrong on everything
  // wider. A square cap's corner reaches halfWidth * sqrt(2) from the vertex
  // instead of halfWidth, so it juts out by 41% of the half width at every
  // turn: 3.3 px on the 16 px coast halo, and the world coastline turns by
  // more than 90 degrees at a quarter of its vertices.
  float over = max(0.0, max(-vAlong, vAlong - vLen));
  float d = length(vec2(over, vAcross));
  float a = clamp((uHalfWidth + uFeather * 0.5 - d) / uFeather, 0.0, 1.0);
  if (a <= 0.0) discard;
  fragColor = vec4(vColor.rgb, vColor.a * a);
}`;

// --------------------------------------------------------------------- band
//
// There is no band program. C2 had one — every line instance carries the unit
// on its left and the unit on its right, so a one-sided extrusion looked like
// the natural way to get a strip whose width is in pixels rather than on the
// ground — and it was wrong in a way that only shows on a jagged border.
//
// A quad extruded perpendicular to ONE segment knows nothing about where the
// unit actually goes. Where the border bends away by more than a right angle,
// and a quarter of the coastline's vertices do, the quad covers ground that is
// not the unit's. Measured on the coast runs at the home view: the ribbon's
// outer corner lands in the SEA at 35% of segments, and still 27% at 16x,
// because the band is a fixed pixel width and the roughness does not smooth
// out with zoom. It read as the white land bleeding past the shoreline.
//
// main.js has always built it the other way round, and says why: the band is
// "the counties over again in the deeper color, showing only where the mask
// above lets them — so the band is the state's own ground by construction and
// can't spill across a border however the line bends". So the renderer strokes
// the borders into the stencil and redraws the county fills through it, which
// keeps the pixel width and makes the spill impossible rather than rare. The
// left/right pair is still what picks which borders to stroke.

// --------------------------------------------------------------- city dots
//
// One instanced quad per city, sized in DEVICE PX rather than in ground units.
// A city dot is a map symbol and not a thing on the ground: it means "a town is
// here", which is as true and as legible at one zoom as another. The state
// names above are the opposite case and scale with their territory, because
// they are lettering painted onto the ground.
//
// aPos carries the unit-sphere position in xyz and the dot's radius in w, so a
// tier can be dotted smaller than the one above it without a second attribute.
export const DOT_VS = `#version 300 es
precision highp float;
${CAMERA}

in vec2 aCorner;          // 0..1 across the quad
in vec4 aPos;             // xyz on the unit sphere, w the radius in device px

out vec2 vOff;            // -1..1 from the centre, so length() is the circle
out float vFront;

void main() {
  vec3 p = uRot * aPos.xyz;
  vFront = p.x;
  vOff = aCorner * 2.0 - 1.0;
  gl_Position = toClip(project(p) + vOff * aPos.w);
}`;

export const DOT_FS = `#version 300 es
precision highp float;
in vec2 vOff;
in float vFront;
uniform vec4 uColor;
out vec4 fragColor;
void main() {
  // A dot is a few px across, so the horizon gets a hard cut rather than the
  // antialiased one the fills use: there is no room on a dot for a ramp, and a
  // city on the limb is either in view or it is not.
  if (vFront <= 0.0) discard;
  float d = length(vOff);
  // fwidth of a quantity that runs 0..1 over the radius IS one device pixel in
  // those units, so the rim gets the same one-pixel ramp at every dot size.
  float aa = max(fwidth(d), 1e-5);
  float a = 1.0 - smoothstep(1.0 - aa, 1.0, d);
  if (a <= 0.0) discard;
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

// ------------------------------------------------------------------ present
//
// The scene texture onto the canvas, one texel to one pixel.
//
// This is deliberately NOT gl.blitFramebuffer, which is the obvious way to copy
// a framebuffer and does not work here: the context is created with
// alpha: false, so the canvas is RGB8 while the scene texture is RGBA8, and a
// blit between incompatible formats is an INVALID_OPERATION that leaves the
// destination untouched — a black canvas with no error thrown anywhere.
//
// texelFetch sidesteps the whole question. It takes integer coordinates, so
// there is no filtering, no wrap mode and no half-texel to get wrong; both the
// texture and the default framebuffer put their origin at the bottom left, so
// gl_FragCoord indexes the source directly.
export const PRESENT_VS = `#version 300 es
precision highp float;
in vec2 aCorner;
void main() { gl_Position = vec4(aCorner * 2.0 - 1.0, 0.0, 1.0); }`;

export const PRESENT_FS = `#version 300 es
precision highp float;
uniform sampler2D uScene;
out vec4 fragColor;
void main() { fragColor = texelFetch(uScene, ivec2(gl_FragCoord.xy), 0); }`;

// --------------------------------------------------------------------- text
//
// C5. State names are laid along a baseline that lives on the sphere, so the
// curve they follow changes with every turn of the globe. The CPU projects the
// baseline and works out where each glyph's pen lands on it — a few thousand
// flops for the whole map — and hands the GPU one instance per glyph: a pen
// position, the tangent there, the quad, and a rectangle in the atlas.
//
// Everything in the instance is already in device pixels, foreshortening
// included, so this shader is nothing but a rotated quad. `n` is screen-UP:
// device y runs down, so the normal is (t.y, -t.x) rather than (-t.y, t.x).
export const TEXT_VS = `#version 300 es
precision highp float;
in vec2 aCorner;          // 0|1 along the glyph, 0|1 down it
in vec4 aPen;             // xy: pen in device px. zw: unit tangent.
in vec4 aQuad;            // xy: quad's top-left off the pen (along, up). zw: size.
in vec4 aRect;            // atlas uv: x0 y0 x1 y1

uniform vec2 uViewport;
out vec2 vUv;

void main() {
  vec2 t = aPen.zw;
  vec2 n = vec2(t.y, -t.x);
  vec2 org = aPen.xy + t * aQuad.x + n * aQuad.y;
  vec2 pos = org + t * (aCorner.x * aQuad.z) - n * (aCorner.y * aQuad.w);
  vUv = mix(aRect.xy, aRect.zw, aCorner);
  vec2 c = pos / uViewport * 2.0 - 1.0;
  gl_Position = vec4(c.x, -c.y, 0.0, 1.0);
}`;

// A signed distance field, so one atlas serves every size the zoom reaches —
// and the halo comes free. The map's labels are drawn with `paint-order:
// stroke`, which puts a white stroke UNDER the glyph, and a stroke is centred
// on the outline, so what shows is half its width standing outside the letter.
// Here that is one more threshold on the same distance: the same shader run
// twice, once at the halo's threshold and once at the outline itself.
//
// Both passes need a threshold that a device pixel can actually resolve, and
// two things used to stop the halo from being one:
//
//   the ramp   `w` was a whole fwidth either side of the threshold, so the
//              antialiasing spanned two pixels. Below 20 px of type that is
//              wider than the halo, and the fill's ramp reached the halo's
//              threshold before the halo had climbed to full white — at the
//              5 px cutoff the halo painted at alpha 0.09 instead of 0.55.
//              Half an fwidth either side is a one-pixel ramp, which is the
//              usual reading of fwidth and leaves the halo its own room.
//   the reach   0.1 em is 0.5 px on a 5 px name however cleanly it is drawn.
//              The SVG rule has the same problem and answers it with a floor,
//              stroke-width max(1.4, size * 0.2); the floor here is in device
//              pixels, because that is what legibility depends on.
export const TEXT_FS = `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uAtlas;
uniform vec4 uColor;      // the glyph, or the halo colour on the halo pass
uniform float uHalo;      // halo reach, in the field's own normalized units
uniform bool uHaloPass;   // shift the threshold out by the halo's reach
uniform bool uSolid;      // leader lines: a plain quad, no atlas
out vec4 fragColor;

// The floor on the halo's reach, in device pixels. One of them is the
// antialiasing ramp, so the rest is solid white standing outside the letter.
const float MIN_HALO_PX = 2.0;

void main() {
  if (uSolid) {
    fragColor = uColor;
    return;
  }
  float d = texture(uAtlas, vUv).r;
  // fwidth of the sampled field is one device pixel in the field's own units,
  // which is what both the ramp and the pixel floor are measured against.
  float px = max(fwidth(d), 1e-5);
  float w = 0.5 * px;
  // The field is only measured SPREAD texels either side of the outline — half
  // a unit — and reads flat 0 past that, so it cannot describe a halo wider
  // than SPREAD however small the type gets, and asking for one would turn the
  // whole padded cell white. Below about 12 px it is this cap, not
  // MIN_HALO_PX, that decides what the halo is worth; buying more there means
  // a wider SPREAD in atlas.js, paid for in field precision at maximum zoom.
  float reach = uHaloPass ? min(max(uHalo, MIN_HALO_PX * px), 0.5 - w) : 0.0;
  float a = smoothstep(0.5 - reach - w, 0.5 - reach + w, d);
  if (a <= 0.0) discard;
  fragColor = vec4(uColor.rgb, uColor.a * a);
}`;

// Attribute locations are bound explicitly so that one VAO per line group
// serves both the stroke and the stencil pass that masks the band.
export const ATTRIB = {
  aCorner: 0,
  aStart: 1,
  aEnd: 2,
  aLeft: 3,
  aRight: 4,
  aPos: 1,
  aUnit: 2,
  aPen: 5,
  aQuad: 6,
  aRect: 7,
};

export function compile(gl, vsSrc, fsSrc) {
  const make = (type, src) => {
    const s = gl.createShader(type);
    gl.shaderSource(s, src);
    gl.compileShader(s);
    if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
      const log = gl.getShaderInfoLog(s);
      const numbered = src
        .split("\n")
        .map((l, i) => `${String(i + 1).padStart(3)}| ${l}`)
        .join("\n");
      throw new Error(`${log}\n${numbered}`);
    }
    return s;
  };
  const p = gl.createProgram();
  gl.attachShader(p, make(gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, make(gl.FRAGMENT_SHADER, fsSrc));
  // Bound before linking so every program agrees, and one VAO can serve more
  // than one of them.
  for (const [name, loc] of Object.entries(ATTRIB)) gl.bindAttribLocation(p, loc, name);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p));
  const u = {};
  for (let i = 0; i < gl.getProgramParameter(p, gl.ACTIVE_UNIFORMS); i++) {
    const { name } = gl.getActiveUniform(p, i);
    u[name] = gl.getUniformLocation(p, name);
  }
  return { program: p, u };
}
