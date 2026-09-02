// Every color the map draws, and the two transforms that derive one color
// from another. BOTH renderers read this file — the deck.gl stack takes the
// byte arrays as they are, and the WebGL globe divides them down to 0-1
// floats (see COLORS in globe/layers.js) — so a question about what shade
// something is on screen is answered by this file alone, whichever renderer
// is up. Nothing here reads the model or the DOM, and the only import is
// d3's color math, so the node check scripts can load it too.
//
// Colors are deck.gl's [r, g, b, a] byte arrays; the two entry points that
// take CSS (rgba, and the transforms, which return d3 color objects) are
// marked as such.

import { rgb, hsl } from "d3";

// CSS in, byte array out. A color that carries its own opacity — an 8-digit
// hex, or an rgba() string — folds it into the alpha byte, so "#b4b4b485"
// means what it says instead of silently dropping the 85.
export const rgba = (css, alpha = 255) => {
  const c = rgb(css);
  return [Math.round(c.r), Math.round(c.g), Math.round(c.b), Math.round(c.opacity * alpha)];
};

// Foreign units all share one near-white wash of the classic atlas tan: the
// convention for "on the map, but not in the union", kept faint enough to
// read as unpainted. Painting their territory into a state is what gives it
// a real color. Kept as CSS because a state's fill is a CSS string.
export const FOREIGN_FILL = "#faf7f1";

// The state fills: a small palette of clearly distinct soft colors. States
// are colored map-style (four-color-theorem spirit): a greedy graph coloring
// in main.js guarantees no two bordering states share a fill. The palette is
// hand-picked to look good in any arrangement, so avoiding an exact repeat is
// the only constraint. Custom and admitted states draw from the same palette
// so the map stays uniform.
//
// Each entry pairs the fill with its band color: `light` is the state's
// ground, `deep` the band inside its border. The deeps are literal rather
// than derived so each pair can be tuned on its own; deepOf below is how a
// fill finds its partner. CSS strings, like FOREIGN_FILL above.
export const BASE_COLORS = [
  { name: "yellow", light: "#f8eba4", deep: "#f9e000" },
  { name: "green", light: "#d1ecb3", deep: "#a6e261" },
  { name: "red", light: "#f8ccc9", deep: "#f5a6a0" },
  { name: "purple", light: "#e1d2ec", deep: "#cbabe4" },
  { name: "orange", light: "#f7d7ad", deep: "#ffb759" },
  { name: "teal", light: "#c8f3e6", deep: "#a2dfcc" },
];
// Reserve fills in the same soft style, drawn on only when a state's
// neighbors wear every base color. They stay out of BASE_COLORS so the
// original map's coloring doesn't change.
export const BACKUP_COLORS = [
  { name: "blue", light: "#c2d9f0", deep: "#7caedb" },
  { name: "pink", light: "#f7cce0", deep: "#f5a0c9" },
  { name: "spring green", light: "#abd9ad", deep: "#6ed073" },
];
// The band a fill wears is its deep partner. A color from outside the
// palette keeps itself — a flat band rather than a crash.
const DEEP = new Map([...BASE_COLORS, ...BACKUP_COLORS].map((c) => [c.light, c.deep]));
export const deepOf = (light) => DEEP.get(light) ?? light;

// One water blue and one shoreline blue for every lake, carved or drawn on
// top, so the two render paths are indistinguishable on the map.
export const LAKE = rgba("#d5e8f4");
export const HALO = rgba("#cde4f2");
export const WHITE = rgba("#ffffff");
// A light grey hairline. Opaque, so it is the same line over every fill
// rather than a tint of whatever ground it crosses.
export const COUNTY_LINE = rgba("#9996964f");
export const STATE_LINE = rgba("#999999");
// Fully transparent: what the merged line layer paints for a segment that
// currently draws nothing (a county hairline while the data view is up).
export const TRANSPARENT = [0, 0, 0, 0];
export const COAST = rgba("#8ab8d6");
export const LAND = rgba("#5b6472");
export const HOVER = [0, 0, 0, 18]; // the old fill-opacity: 0.07
export const GREY_LAND = rgba("#e4e4e4"); // data view: the ground itself carries no color
export const NO_DATA = rgba("#cccccc");
// Non-union units in data view: the atlas tan's hue, washed well toward the
// page white. The full tan sits at the same lightness as GREY_LAND, so the
// union wouldn't separate from its context; the pale wash lets the context
// recede while the warm hue still says "on the map, not in the union" — and
// keeps it apart from NO_DATA's grey, which means a state missing data.
export const FOREIGN_LAND = rgba("#f4f0e9");
// Globe mode only: the sea the sphere shows where no unit covers it, and the
// graticule over it. Both stay paler than the coast blue so the continent
// keeps reading as the subject and the sphere as its ground.
export const OCEAN = rgba("#e8f1f7");
export const GRATICULE_LINE = rgba("#b9cfdf", 150);
// The scenery land beyond the map's units wears exactly what a non-union unit
// wears: the same tan, the same blue shoreline and halo, the same water blue in
// its lakes. There is no second style for "not the map" — what marks the map
// out is that its ground carries state colors, hover, labels and paint, and
// none of that reaches here. A tan of its own only put a seam across the
// Panama border.
export const WORLD_LAND = rgba(FOREIGN_FILL);
// The one exception, and the reason it is an exception: a line between two
// foreign countries used to wear COUNTY_LINE, a half-alpha white, which over
// the tan is all but invisible — the scenery read as one undivided landmass.
// A county hairline can afford to be that faint because the band, the labels
// and the state colors already say where a unit ends; out here the line is the
// only thing saying it, so it takes the same grey a state border wears.
export const COUNTRY_LINE = rgba("#999999");
// The carve stroke in flight, drawn over the presented scene while the user
// draws a cut across a county.
export const KNIFE = rgba("#e53e3e", 235);
// The selection outline when a state's own color can't supply one: before a
// state is picked, and in data view, where a state's fill means nothing. The
// live outline is the selected fill pushed darker, computed per refresh.
export const OUTLINE_FALLBACK = rgba("#333333");

// Unselected states grey out while painting: the fill keeps its lightness but
// loses nearly all its saturation. Because the ground stays as dark as ever,
// the county and state hairlines read exactly as they do outside paint
// mode, while the selected state's full color pops against the grey.
export const dimmed = (color) => {
  const c = hsl(color);
  c.s *= 0.12;
  return c;
};
// The selected state's fill takes a small step toward its band color — a bit
// more saturated, a shade darker — so the whole state reads as active, not
// just the ground near its outline.
export const highlight = (color) => {
  const c = hsl(color);
  c.s = Math.min(1, c.s * 1.25);
  c.l *= 0.955;
  return c;
};

export const BAND_WIDTH = 10; // css px across the border, so five to a side
