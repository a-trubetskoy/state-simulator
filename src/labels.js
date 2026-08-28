// Atlas-style state name labels, placed the way strategy-game maps do it.
// Every rebuild runs this pipeline over the current county assignment:
// steps 1–2 and the baselines of 3–4 depend only on territory, so they are
// cached against the caller's assignVersion, and a rebuild whose territory
// hasn't moved (a rename, an admitted unit) reruns only the text fitting.
//
//  1. Scanline-rasterize every county into a 975x610 grid of state indices —
//     exact even-odd fill, no canvas antialiasing to corrupt the ids.
//  2. Per state, union every connected component of its cells — one piece
//     for a solid state, all of them for an archipelago like the Bahamas,
//     which has no single dominant island — anchored on the largest piece.
//     Pieces smaller than 2% of that largest one stay out of the shape, so a
//     lone offshore speck doesn't drag it across open water toward itself —
//     though they remain the state's own ground, walkable by its label.
//     That shape is then filled out to its convex hull, minus other states'
//     land. Water two hulls both reach goes to whichever unit is smaller (so
//     Ontario's hull doesn't swallow every Great Lakes bay before Michigan or
//     Wisconsin gets a claim), which keeps every water cell assigned to at
//     most one unit — so Puget Sound or the sea between two Bahamian islands
//     counts as ground the label may measure across, but no state's label
//     can wander onto a neighbor or collide with a neighbor's over shared
//     water.
//  3. PCA over the component's cells gives the long axis; a least-squares
//     quadratic in that frame gives a baseline that bends with the shape
//     (California's arc, Florida's crook).
//  4. Walk the baseline, measuring at each step how much room there is to
//     either side before the border. Search font sizes downward until the
//     name fits the usable arc; stretch letter-spacing to fill it. A slanted
//     axis must beat level text decisively: when the name also fits a
//     horizontal baseline at a comfortable size, the level label wins. A
//     multi-word name may also stack into two level lines — UPSTATE over
//     NEW YORK — when the stack fits decisively larger than one line.
//  5. No room for the name -> retry with the abbreviation. Still no room ->
//     draw a 45° leader line out of the state and set the abbreviation where
//     it lands clear of land and of every label already placed.
//
// All coordinates are the map's own 975x610 viewBox units, so the labels ride
// d3.zoom's transform and scale with the territory like printed type.

// Grid cell size in map units. One cell per unit matches the original
// 975x610 US map exactly; the grid's extent now comes from the caller, since
// the continent stretches well past the design box on every side.

// FIPS -> postal code. Custom states, and any real state the user has
// renamed, derive an abbreviation from their current name instead.
const POSTAL = {
  "01": "AL", "02": "AK", "04": "AZ", "05": "AR", "06": "CA", "08": "CO",
  "09": "CT", 10: "DE", 11: "DC", 12: "FL", 13: "GA", 15: "HI", 16: "ID",
  17: "IL", 18: "IN", 19: "IA", 20: "KS", 21: "KY", 22: "LA", 23: "ME",
  24: "MD", 25: "MA", 26: "MI", 27: "MN", 28: "MS", 29: "MO", 30: "MT",
  31: "NE", 32: "NV", 33: "NH", 34: "NJ", 35: "NM", 36: "NY", 37: "NC",
  38: "ND", 39: "OH", 40: "OK", 41: "OR", 42: "PA", 44: "RI", 45: "SC",
  46: "SD", 47: "TN", 48: "TX", 49: "UT", 50: "VT", 51: "VA", 53: "WA",
  54: "WV", 55: "WI", 56: "WY",
};
// Reserved so a derived abbreviation never shadows a real postal code, even
// one that isn't on the map right now (its state may have been renamed).
const POSTAL_CODES = new Set(Object.values(POSTAL));

// A state's outlying piece shapes the union hull only if it is at least this
// share of the state's largest landmass. A speck far offshore would otherwise
// stretch the hull across open water toward itself, and the label would follow
// the stretched shape instead of the state people actually see. A piece under
// the bar is still the state's own ground — it just doesn't pull on the shape.
const ISLAND_MIN_SHARE = 0.02;

// Sizes are viewBox units (the map is 975 wide). Tracking is in em. The caps
// keep big states from shouting: the largest name sits below 2x the 9-unit
// data labels, and an abbreviation never outsizes a full name.
const NAME_MAX = 15;
const NAME_MIN = 7;
const ABBR_MAX = 12;
const ABBR_MIN = 5.5;
const LEADER_SIZE = 8;
const NAME_TRACK = 0.15;
const ABBR_TRACK = 0.08;
const SIZE_STEP = 0.93; // size search shrinks by 7% per try
// A label needs this much clear ground either side of its baseline, so text
// stays off the borders; the march that measures it gives up at CLEAR_MAX.
const CLEAR_K = 0.55;
const CLEAR_MAX = 30;
const STEP = 2; // baseline sample spacing
// Text may claim this share of the usable arc; the stretch target is lower so
// the browser never runs a glyph off the end of the path (letter-spacing
// trails after the last glyph too, which is why widths count `len` gaps).
const FIT_FILL = 0.94;
const STRETCH_FILL = 0.88;
const EXTRA_TRACK_MAX = 0.9;
// Horizontal bias: level text is easier to read than slanted or climbing
// text, so a PCA-slanted label survives only when horizontal can't do the
// name justice — UTAH along a latitude line beats UTAH climbing the state.
// Horizontal wins whenever it fits at least as large, and even a bit smaller
// once it reaches a comfortable reading size (clearly above the data labels,
// with headroom below NAME_MAX so the rule still has room to trigger).
const HORIZ_COMFORT = 11;
const HORIZ_RATIO = 0.8;
// Stacked two-line names: the distance between line centers, and how
// decisively the stack must out-size the one-line fit to win — a stack is
// busier than a single line, so a marginal gain isn't worth it. Stacks only
// read level, so they always fit on the horizontal profile.
const STACK_LINE_H = 1.15; // em
const STACK_GAIN = 1.25;
// Leader lines march diagonally up to LEAD_MAX px; crossing another state's
// land is allowed but costs, so a watery landing wins when one is near.
const LEAD_MAX = 130;
const LEAD_LAND_COST = 3;
const THROTTLE_MS = 150; // during a brush stroke, rebuild at most this often

const mctx = document.createElement("canvas").getContext("2d");
mctx.font = "100px Verdana, Geneva, Tahoma, sans-serif";
const measureCache = new Map();
// Advance width at 100px, no tracking; scales linearly with font size.
function measure(text) {
  let w = measureCache.get(text);
  if (w === undefined) {
    w = mctx.measureText(text).width;
    measureCache.set(text, w);
  }
  return w;
}

// Connective words a hand-written abbreviation would skip over.
const FILLER = new Set(["of", "the", "and", "de", "la", "el", "at", "in", "on", "for", "a"]);

function significantWords(name) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length < 2) return words;
  const kept = words.filter((w) => !FILLER.has(w.toLowerCase()));
  return kept.length >= 2 ? kept : words; // never filter a name down to one word
}

// Candidate abbreviations for a name, most natural first: the first
// significant word's initial paired with each later one's, then every letter
// of the squashed-together name paired with its first letter, then a
// guaranteed-fresh numbered tail. abbrevFor stops at the first free one.
function* abbrevCandidates(name) {
  const words = significantWords(name);
  for (let i = 1; i < words.length; i++) yield (words[0][0] + words[i][0]).toUpperCase();
  const letters = words.join("").toUpperCase();
  for (let i = 1; i < letters.length; i++) yield letters[0] + letters[i];
  for (let n = 1; ; n++) yield letters.slice(0, 1) + n;
}

// A real, unrenamed state keeps its postal code. Everything else — a custom
// state, or a real one the user renamed — gets the first name-derived
// candidate not already claimed by another label on this map.
function abbrevFor(sid, info, used) {
  if (info.name === info.origName && POSTAL[sid]) {
    used.add(POSTAL[sid]);
    return POSTAL[sid];
  }
  for (const candidate of abbrevCandidates(info.name)) {
    if (used.has(candidate)) continue;
    used.add(candidate);
    return candidate;
  }
}

// Gaussian elimination with partial pivoting for the 3x3 normal equations.
function solve3(m, r) {
  const A = [m[0].slice(), m[1].slice(), m[2].slice()];
  const b = r.slice();
  const scale = Math.max(1, ...A.flat().map(Math.abs));
  for (let col = 0; col < 3; col++) {
    let p = col;
    for (let i = col + 1; i < 3; i++) if (Math.abs(A[i][col]) > Math.abs(A[p][col])) p = i;
    if (Math.abs(A[p][col]) < 1e-10 * scale) return null;
    [A[col], A[p]] = [A[p], A[col]];
    [b[col], b[p]] = [b[p], b[col]];
    for (let i = col + 1; i < 3; i++) {
      const f = A[i][col] / A[col][col];
      for (let j = col; j < 3; j++) A[i][j] -= f * A[col][j];
      b[i] -= f * b[col];
    }
  }
  const x = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = b[i];
    for (let j = i + 1; j < 3; j++) s -= A[i][j] * x[j];
    x[i] = s / A[i][i];
  }
  return x;
}

const esc = (s) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

const boxesOverlap = (a, b) => a.x0 < b.x1 && a.x1 > b.x0 && a.y0 < b.y1 && a.y1 > b.y0;

// `name` namespaces the textPath ids: several labelers (the globe map and
// each inset box) share one SVG document, and an id collision would make a
// label's <textPath> ride another labeler's path.
export function createStateLabeler({ group, countyParts, bounds, name }) {
  // The raster covers `bounds` (map units) at one cell per unit. All the
  // internal math runs in grid coordinates — map coordinates shifted by the
  // grid origin — and an inner group translates the finished labels back, so
  // none of the sizing constants above needed re-deriving.
  const gx = Math.floor(bounds.x0);
  const gy = Math.floor(bounds.y0);
  const W = Math.ceil(bounds.x1) - gx;
  const H = Math.ceil(bounds.y1) - gy;
  const N = W * H;
  const layer = group.append("g").attr("transform", `translate(${gx},${gy})`);

  // One grid of state indices, one of connected-component ids, and a BFS
  // queue, all allocated once and reused every rebuild.
  const stateGrid = new Int16Array(N);
  const compGrid = new Int32Array(N);
  const queue = new Int32Array(N);
  let sids = []; // state index -> sid, rebuilt with the raster

  // ---- 1. rasterize -------------------------------------------------------

  // Even-odd scanline fill of one county part (outer ring plus holes) at cell
  // centers, via per-row crossing buckets. Exact and antialias-free, which
  // canvas fills are not — a blended edge pixel would decode to a wrong state.
  function fillPart(rings, idx) {
    let yLo = Infinity;
    let yHi = -Infinity;
    for (const ring of rings)
      for (const p of ring) {
        const py = p[1] - gy;
        if (py < yLo) yLo = py;
        if (py > yHi) yHi = py;
      }
    const r0 = Math.max(0, Math.floor(yLo));
    const r1 = Math.min(H - 1, Math.ceil(yHi));
    if (r1 < r0) return;
    const buckets = new Array(r1 - r0 + 1).fill(null);
    for (const ring of rings) {
      for (let i = 0; i < ring.length; i++) {
        const ax = ring[i][0] - gx;
        const ay = ring[i][1] - gy;
        const bx = ring[(i + 1) % ring.length][0] - gx;
        const by = ring[(i + 1) % ring.length][1] - gy;
        if (ay === by) continue;
        const lo = Math.min(ay, by);
        const hi = Math.max(ay, by);
        // Rows whose center yc = r + 0.5 lies in the half-open [lo, hi) — the
        // half-open rule is what keeps shared vertices from double-counting.
        let r = Math.max(r0, Math.ceil(lo - 0.5));
        const rEnd = Math.min(r1, Math.ceil(hi - 0.5) - 1);
        for (; r <= rEnd; r++) {
          const yc = r + 0.5;
          (buckets[r - r0] ??= []).push(ax + ((yc - ay) * (bx - ax)) / (by - ay));
        }
      }
    }
    for (let r = r0; r <= r1; r++) {
      const xs = buckets[r - r0];
      if (!xs) continue;
      xs.sort((a, b) => a - b);
      const base = r * W;
      for (let k = 0; k + 1 < xs.length; k += 2) {
        const c0 = Math.max(0, Math.ceil(xs[k] - 0.5));
        const c1 = Math.min(W - 1, Math.ceil(xs[k + 1] - 0.5) - 1);
        for (let c = c0; c <= c1; c++) stateGrid[base + c] = idx;
      }
    }
  }

  function rasterize(assign) {
    stateGrid.fill(-1);
    sids = [];
    const index = new Map();
    for (const part of countyParts) {
      const sid = assign.get(part.fips);
      let idx = index.get(sid);
      if (idx === undefined) {
        idx = sids.length;
        sids.push(sid);
        index.set(sid, idx);
      }
      fillPart(part.rings, idx);
    }
  }

  // ---- 2. connected components -------------------------------------------

  function findComponents() {
    compGrid.fill(-1);
    const comps = [];
    for (let i = 0; i < N; i++) {
      if (stateGrid[i] < 0 || compGrid[i] >= 0) continue;
      const id = comps.length;
      const state = stateGrid[i];
      const cells = [];
      let head = 0;
      let tail = 0;
      queue[tail++] = i;
      compGrid[i] = id;
      while (head < tail) {
        const c = queue[head++];
        cells.push(c);
        const x = c % W;
        if (x > 0 && stateGrid[c - 1] === state && compGrid[c - 1] < 0) {
          compGrid[c - 1] = id;
          queue[tail++] = c - 1;
        }
        if (x < W - 1 && stateGrid[c + 1] === state && compGrid[c + 1] < 0) {
          compGrid[c + 1] = id;
          queue[tail++] = c + 1;
        }
        if (c >= W && stateGrid[c - W] === state && compGrid[c - W] < 0) {
          compGrid[c - W] = id;
          queue[tail++] = c - W;
        }
        if (c < N - W && stateGrid[c + W] === state && compGrid[c + W] < 0) {
          compGrid[c + W] = id;
          queue[tail++] = c + W;
        }
      }
      comps.push({ id, state, cells });
    }
    return comps;
  }

  // ---- 2b. convex-hull fill ----------------------------------------------

  // Who claims each water cell during the hull fill: -1 free, -2 contested by
  // two hulls, otherwise a component id. Allocated once, like the grids above.
  const hullGrid = new Int32Array(N);
  const rowMin = new Int16Array(H);
  const rowMax = new Int16Array(H);

  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);

  // Monotone-chain convex hull of a component. Per-row extremes are enough
  // input: every hull vertex is the leftmost or rightmost cell of its row.
  function componentHull(cells) {
    rowMax.fill(-1);
    let yLo = H;
    let yHi = -1;
    for (const c of cells) {
      const x = c % W;
      const y = (c / W) | 0;
      if (rowMax[y] < 0) {
        rowMin[y] = x;
        rowMax[y] = x;
      } else {
        if (x < rowMin[y]) rowMin[y] = x;
        if (x > rowMax[y]) rowMax[y] = x;
      }
      if (y < yLo) yLo = y;
      if (y > yHi) yHi = y;
    }
    const pts = [];
    for (let y = yLo; y <= yHi; y++) {
      if (rowMax[y] < 0) continue;
      pts.push([rowMin[y], y]);
      if (rowMax[y] !== rowMin[y]) pts.push([rowMax[y], y]);
    }
    if (pts.length < 3) return { hull: pts, yLo, yHi };
    pts.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    const lower = [];
    for (const p of pts) {
      while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0)
        lower.pop();
      lower.push(p);
    }
    const upper = [];
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0)
        upper.pop();
      upper.push(p);
    }
    lower.pop();
    upper.pop();
    return { hull: lower.concat(upper), yLo, yHi };
  }

  // The hull's cell span on each row. Convexity guarantees one interval.
  function hullSpans(cells) {
    const { hull, yLo, yHi } = componentHull(cells);
    const spans = [];
    for (let y = yLo; y <= yHi; y++) {
      let xL = Infinity;
      let xR = -Infinity;
      for (let i = 0; i < hull.length; i++) {
        const [x1, y1] = hull[i];
        const [x2, y2] = hull[(i + 1) % hull.length];
        if (y < Math.min(y1, y2) || y > Math.max(y1, y2)) continue;
        if (y1 === y2) {
          xL = Math.min(xL, x1, x2);
          xR = Math.max(xR, x1, x2);
        } else {
          const x = x1 + ((y - y1) * (x2 - x1)) / (y2 - y1);
          if (x < xL) xL = x;
          if (x > xR) xR = x;
        }
      }
      if (xR >= xL) spans.push([y, Math.ceil(xL), Math.floor(xR)]);
    }
    return spans;
  }

  // Grow each chosen component to its convex hull: bays and sounds inside the
  // hull become the component's own ground for baseline and clearance
  // purposes. Land is never annexed. Water two hulls both reach goes to
  // whichever unit is smaller — otherwise a huge, crescent-shaped neighbor
  // (Ontario wrapping most of the Great Lakes) would claim every shared bay
  // before a small state like Wisconsin got a look at it, and an archipelago
  // like the Bahamas would lose the very water its union-hull exists to win.
  // Smallest-claims-first makes that automatic: once a cell is taken, a
  // larger unit's later pass just skips it, so each cell still belongs to at
  // most one unit — which is what preserves the invariant that in-territory
  // labels can't collide with each other.
  function fillHulls(comps) {
    hullGrid.fill(-1);
    const claimOrder = [...comps].sort((a, b) => a.cells.length - b.cells.length);
    for (const comp of claimOrder) {
      const cells = [];
      for (const [y, xL, xR] of hullSpans(comp.cells)) {
        const base = y * W;
        for (let x = xL; x <= xR; x++) {
          const cell = base + x;
          if (stateGrid[cell] >= 0) continue; // land is never annexed
          if (hullGrid[cell] !== -1) continue; // a smaller hull already has it
          hullGrid[cell] = comp.id;
          cells.push(cell);
        }
      }
      comp.fill = cells;
      for (const cell of cells) compGrid[cell] = comp.id;
    }
  }

  // ---- 3 & 4. baseline fit and clearance profile --------------------------

  // The point (x, y) lies on this component's ground.
  function makeInside(compId) {
    return (x, y) => {
      if (x < 0 || y < 0 || x >= W || y >= H) return false;
      return compGrid[(y | 0) * W + (x | 0)] === compId;
    };
  }

  // Fit the curved baseline and sample it: positions, and at each sample the
  // clear distance to the component's edge (the min of both sides). Stores the
  // component's centroid on the way for the leader-line fallback. The axis
  // comes from PCA unless forceTheta pins it (0 = horizontal retry).
  function traceBaseline(comp, forceTheta) {
    // The hull-filled shape: centroid, axis and clearance all read the state
    // with its bays filled in, so a sound doesn't squeeze the label.
    const cells = comp.fill?.length ? comp.cells.concat(comp.fill) : comp.cells;
    const n = cells.length;
    let sx = 0;
    let sy = 0;
    for (let i = 0; i < n; i++) {
      sx += cells[i] % W;
      sy += (cells[i] / W) | 0;
    }
    const mx = (comp.mx = sx / n + 0.5);
    const my = (comp.my = sy / n + 0.5);
    if (n < 12) return null; // nothing this small holds text; go straight to a leader

    let sxx = 0;
    let syy = 0;
    let sxy = 0;
    for (let i = 0; i < n; i++) {
      const dx = (cells[i] % W) + 0.5 - mx;
      const dy = ((cells[i] / W) | 0) + 0.5 - my;
      sxx += dx * dx;
      syy += dy * dy;
      sxy += dx * dy;
    }
    sxx /= n;
    syy /= n;
    sxy /= n;
    const mid = (sxx + syy) / 2;
    const dif = Math.hypot((sxx - syy) / 2, sxy);
    const l1 = mid + dif;
    const l2 = Math.max(1e-6, mid - dif);
    // Near-round shapes read best horizontal; only a genuinely elongated one
    // earns an angled label.
    const theta =
      forceTheta !== undefined
        ? forceTheta
        : Math.sqrt(l1 / l2) < 1.25
          ? 0
          : 0.5 * Math.atan2(2 * sxy, sxx - syy);
    let ux = Math.cos(theta);
    let uy = Math.sin(theta);
    if (ux < 0) {
      ux = -ux;
      uy = -uy;
    }
    // Near-vertical labels read upward, per the cartographic convention.
    if (ux < 0.14 && uy > 0) {
      ux = -ux;
      uy = -uy;
    }
    // Cell spread along the chosen axis; equals l1 when that axis is the PCA
    // long axis, smaller when a horizontal retry cuts across a tall shape.
    const varU = ux * ux * sxx + 2 * ux * uy * sxy + uy * uy * syy;

    // Least squares v = a + b*u + c*u² in the axis frame.
    let s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
    for (let i = 0; i < n; i++) {
      const dx = (cells[i] % W) + 0.5 - mx;
      const dy = ((cells[i] / W) | 0) + 0.5 - my;
      const u = dx * ux + dy * uy;
      const v = -dx * uy + dy * ux;
      const uu = u * u;
      s1 += u;
      s2 += uu;
      s3 += uu * u;
      s4 += uu * uu;
      t0 += v;
      t1 += u * v;
      t2 += uu * v;
    }
    const sol = solve3([[n, s1, s2], [s1, s2, s3], [s2, s3, s4]], [t0, t1, t2]);
    let [a, b, c] = sol ?? [0, 0, 0];
    // Cap the bend so the sagitta over the shape's span stays modest — a wild
    // parabola from a lopsided shape would fling the text around.
    const halfSpan = 2 * Math.sqrt(varU);
    const cMax = 0.22 / Math.max(8, halfSpan);
    if (Math.abs(c) > cMax) c = Math.sign(c) * cMax;

    const m = Math.min(600, Math.max(3, Math.round((2 * (2.6 * Math.sqrt(varU) + 4)) / STEP) + 1));
    const U = ((m - 1) * STEP) / 2;
    const xs = new Float64Array(m);
    const ys = new Float64Array(m);
    const clr = new Float64Array(m);
    const cum = new Float64Array(m);
    const inside = makeInside(comp.id);
    for (let k = 0; k < m; k++) {
      const u = -U + k * STEP;
      const v = a + b * u + c * u * u;
      const x = (xs[k] = mx + u * ux - v * uy);
      const y = (ys[k] = my + u * uy + v * ux);
      if (k > 0) cum[k] = cum[k - 1] + Math.hypot(x - xs[k - 1], y - ys[k - 1]);
      if (!inside(x, y)) continue; // clr stays 0
      const dv = b + 2 * c * u;
      const tl = Math.hypot(ux - dv * uy, uy + dv * ux);
      const nx = -(uy + dv * ux) / tl;
      const ny = (ux - dv * uy) / tl;
      let dp = 0;
      while (dp < CLEAR_MAX && inside(x + nx * (dp + 1), y + ny * (dp + 1))) dp++;
      let dm = 0;
      while (dm < CLEAR_MAX && inside(x - nx * (dm + 1), y - ny * (dm + 1))) dm++;
      clr[k] = Math.min(dp, dm) + 0.5;
    }
    return { xs, ys, clr, cum, angled: Math.abs(uy) > 0.05 };
  }

  // Longest contiguous stretch of baseline with enough headroom for a given
  // text height.
  function longestRun(prof, need) {
    const { clr, cum } = prof;
    let bi = -1, bj = -1, bl = 0;
    let i = 0;
    while (i < clr.length) {
      if (clr[i] < need) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < clr.length && clr[j + 1] >= need) j++;
      if (cum[j] - cum[i] > bl) {
        bl = cum[j] - cum[i];
        bi = i;
        bj = j;
      }
      i = j + 1;
    }
    return bi < 0 ? null : { i0: bi, i1: bj, L: bl };
  }

  // Largest size at which the text fits its state. Bigger text needs more
  // clearance, which shrinks the usable run, so scanning downward and taking
  // the first fit is sound.
  function bestFit(prof, text, track, maxSize, minSize) {
    const w100 = measure(text);
    for (let size = maxSize; size >= minSize; size *= SIZE_STEP) {
      const run = longestRun(prof, CLEAR_K * size);
      if (!run) continue;
      // Browsers add letter-spacing after every glyph (the last included),
      // hence `* text.length` — undercounting this clips the final glyph off
      // the end of the textPath.
      if ((w100 / 100) * size + track * size * text.length <= FIT_FILL * run.L)
        return { size, run };
    }
    return null;
  }

  function curvedLabel(prof, fit, text, track, idNum) {
    const { i0, i1, L } = fit.run;
    const size = fit.size;
    const raw = (measure(text) / 100) * size;
    // The EU look: letter-spacing stretches toward filling the run, within
    // taste (EXTRA_TRACK_MAX) and within the path (STRETCH_FILL < FIT_FILL).
    const extra = Math.min(
      EXTRA_TRACK_MAX * size,
      Math.max(0, (STRETCH_FILL * L - raw) / text.length - track * size)
    );
    let d = "";
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let k = i0; k <= i1; k++) {
      d += (k === i0 ? "M" : "L") + prof.xs[k].toFixed(1) + " " + prof.ys[k].toFixed(1);
      if (prof.xs[k] < x0) x0 = prof.xs[k];
      if (prof.xs[k] > x1) x1 = prof.xs[k];
      if (prof.ys[k] < y0) y0 = prof.ys[k];
      if (prof.ys[k] > y1) y1 = prof.ys[k];
    }
    const pad = CLEAR_K * size;
    return {
      kind: "path",
      id: `slb-${name}-${idNum}`,
      d,
      text,
      size,
      spacing: track * size + extra,
      box: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad },
    };
  }

  // Size-independent width factor: multiply by the font size for the width.
  const widthFactor = (text, track) => measure(text) / 100 + track * text.length;

  // Best two-line break of a multi-word name: the split whose longer line is
  // shortest fits at the largest size. A line starting on a filler word
  // ("OF MEXICO") loses to any break that avoids one.
  function bestSplit(name, track) {
    const words = name.split(/\s+/).filter(Boolean);
    if (words.length < 2) return null;
    let best = null;
    for (let i = 1; i < words.length; i++) {
      const bad = FILLER.has(words[i].toLowerCase());
      const lines = [words.slice(0, i).join(" "), words.slice(i).join(" ")];
      const w = Math.max(...lines.map((t) => widthFactor(t, track)));
      if (!best || (best.bad && !bad) || (best.bad === bad && w < best.w))
        best = { lines, w, bad };
    }
    return best.lines;
  }

  // Largest size at which the stacked lines fit: the block needs the
  // single-line headroom plus half a line pitch per extra line, and the
  // widest line must fit the run.
  function bestFitLines(prof, lines, track, maxSize, minSize) {
    const wMax = Math.max(...lines.map((t) => widthFactor(t, track)));
    const clearK = CLEAR_K + ((lines.length - 1) * STACK_LINE_H) / 2;
    for (let size = maxSize; size >= minSize; size *= SIZE_STEP) {
      const run = longestRun(prof, clearK * size);
      if (!run) continue;
      if (wMax * size <= FIT_FILL * run.L) return { size, run };
    }
    return null;
  }

  // The stacked block: each line rides its own copy of the baseline, offset
  // along the normal by a line pitch, and stretches its tracking toward the
  // shared run — so a short line over a long one comes out block-justified.
  function stackedLabel(prof, fit, lines, track, idNum) {
    const { i0, i1, L } = fit.run;
    const size = fit.size;
    const parts = [];
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    lines.forEach((text, li) => {
      const off = (li - (lines.length - 1) / 2) * STACK_LINE_H * size;
      let d = "";
      for (let k = i0; k <= i1; k++) {
        const kp = Math.min(i1, k + 1);
        const km = Math.max(i0, k - 1);
        const tx = prof.xs[kp] - prof.xs[km];
        const ty = prof.ys[kp] - prof.ys[km];
        const tl = Math.hypot(tx, ty) || 1;
        const x = prof.xs[k] - (ty / tl) * off;
        const y = prof.ys[k] + (tx / tl) * off;
        d += (k === i0 ? "M" : "L") + x.toFixed(1) + " " + y.toFixed(1);
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
      const raw = (measure(text) / 100) * size;
      const extra = Math.min(
        EXTRA_TRACK_MAX * size,
        Math.max(0, (STRETCH_FILL * L - raw) / text.length - track * size)
      );
      parts.push({ id: `slb-${name}-${idNum}-${li}`, d, text, spacing: track * size + extra });
    });
    const pad = CLEAR_K * size;
    return {
      kind: "lines",
      lines: parts,
      size,
      box: { x0: x0 - pad, y0: y0 - pad, x1: x1 + pad, y1: y1 + pad },
    };
  }

  // ---- 5. leader lines ----------------------------------------------------

  // Every grid cell under the box is water (or, when land is allowed, at least
  // not this state's own ground), and no placed label is overlapped.
  function boxOk(box, waterOnly, compId, placed) {
    if (box.x0 < 1 || box.y0 < 1 || box.x1 > W - 1 || box.y1 > H - 1) return false;
    for (const p of placed) if (boxesOverlap(box, p)) return false;
    for (let y = Math.floor(box.y0); y <= Math.ceil(box.y1); y += 2) {
      for (let x = Math.floor(box.x0); x <= Math.ceil(box.x1); x += 2) {
        const cell = y * W + x;
        if (waterOnly ? stateGrid[cell] >= 0 : compGrid[cell] === compId) return false;
      }
    }
    return true;
  }

  function lineHits(x1, y1, x2, y2, placed) {
    const steps = Math.max(1, Math.ceil(Math.hypot(x2 - x1, y2 - y1) / 4));
    for (let i = 0; i <= steps; i++) {
      const x = x1 + ((x2 - x1) * i) / steps;
      const y = y1 + ((y2 - y1) * i) / steps;
      for (const p of placed) if (x > p.x0 && x < p.x1 && y > p.y0 && y < p.y1) return true;
    }
    return false;
  }

  // March 45° out of the state in each diagonal; land the abbreviation at the
  // first safe spot. A watery landing is preferred (pass one); failing that,
  // any spot clear of labels will do (pass two); failing even that, the
  // abbreviation sits on the state with no line at all.
  function leaderLabel(comp, abbr, placed) {
    // Anchor on comp.cells, not the hull fill: the centroid may sit in a
    // filled bay, but the line itself must start on the state's actual land.
    let bc = comp.cells[0];
    let bd = Infinity;
    for (const c of comp.cells) {
      const dx = (c % W) + 0.5 - comp.mx;
      const dy = ((c / W) | 0) + 0.5 - comp.my;
      if (dx * dx + dy * dy < bd) {
        bd = dx * dx + dy * dy;
        bc = c;
      }
    }
    const ax = (bc % W) + 0.5;
    const ay = ((bc / W) | 0) + 0.5;
    const spacing = ABBR_TRACK * LEADER_SIZE;
    const w = (measure(abbr) / 100) * LEADER_SIZE + spacing * abbr.length;
    const h = LEADER_SIZE * 1.15;
    const D = Math.SQRT1_2;
    let best = null;
    for (const waterOnly of [true, false]) {
      for (const [dx, dy] of [[D, D], [D, -D], [-D, D], [-D, -D]]) {
        let landCost = 0;
        let exitD = 0;
        for (let d = 2; d <= LEAD_MAX; d++) {
          const x = ax + dx * d;
          const y = ay + dy * d;
          if (x < 1 || y < 1 || x >= W - 1 || y >= H - 1) break;
          const cell = (y | 0) * W + (x | 0);
          if (!exitD) {
            if (compGrid[cell] === comp.id) continue;
            exitD = d;
          }
          if (stateGrid[cell] >= 0) {
            landCost++;
            if (waterOnly) continue;
          }
          if (d < exitD + 3) continue;
          const cx = x + Math.sign(dx) * (w / 2 + 1.5);
          const cy = y + Math.sign(dy) * (h / 2 + 1.5);
          const box = { x0: cx - w / 2 - 1.5, y0: cy - h / 2 - 1.5, x1: cx + w / 2 + 1.5, y1: cy + h / 2 + 1.5 };
          if (!boxOk(box, waterOnly, comp.id, placed)) continue;
          if (lineHits(ax, ay, x, y, placed)) break;
          const score = d + LEAD_LAND_COST * landCost;
          if (!best || score < best.score) best = { score, ex: x, ey: y, cx, cy, box };
          break; // first viable landing is this direction's best
        }
      }
      if (best) break;
    }
    if (!best)
      return { kind: "leader", text: abbr, size: LEADER_SIZE, spacing, cx: ax, cy: ay };
    return {
      kind: "leader",
      text: abbr,
      size: LEADER_SIZE,
      spacing,
      x1: ax,
      y1: ay,
      x2: best.ex,
      y2: best.ey,
      cx: best.cx,
      cy: best.cy,
      box: best.box,
      lineBox: {
        x0: Math.min(ax, best.ex) - 1,
        y0: Math.min(ay, best.ey) - 1,
        x1: Math.max(ax, best.ex) + 1,
        y1: Math.max(ay, best.ey) + 1,
      },
    };
  }

  // ---- assembly -----------------------------------------------------------

  // The geometry stage: everything that depends only on which unit belongs to
  // which state — the raster, the connected components, the hull fill. Its
  // result (and the baseline profiles lazily traced from it, cached on each
  // component) is reused across rebuilds until territory actually changes
  // hands, so a rename refits text in a few milliseconds instead of
  // re-rastering the continent per keystroke.
  function buildGeometry(assign) {
    rasterize(assign);
    const byState = new Map();
    for (const comp of findComponents()) {
      const arr = byState.get(comp.state);
      if (arr) arr.push(comp);
      else byState.set(comp.state, [comp]);
    }
    // Union every component of a state onto its largest piece, so an
    // archipelago's hull grows from all its islands together instead of just
    // the biggest one. Two separate things happen here, and a speck is treated
    // differently by each:
    //
    //   compGrid — may the label stand on this cell? Every piece of the state
    //     answers yes, specks included. A speck the hull already covers would
    //     otherwise read like a neighbor's land and stop the clearance march
    //     dead, which is worst for an archipelago: its label runs across the
    //     water between its islands, and that is just where the specks are.
    //   comp.cells — what shape do the hull, the centroid and the axis read?
    //     Only pieces at least ISLAND_MIN_SHARE of the largest, so one lone
    //     offshore speck can't stretch the hull across open water toward
    //     itself and drag the label out with it.
    //
    // The largest piece keeps its flood-fill id (and so its cells' compGrid
    // tags); every other piece's cells need retagging.
    const ordered = [];
    for (const comps of byState.values()) {
      comps.sort((a, b) => b.cells.length - a.cells.length);
      const [biggest, ...rest] = comps;
      const cut = biggest.cells.length * ISLAND_MIN_SHARE;
      for (const c of rest) for (const cell of c.cells) compGrid[cell] = biggest.id;
      const joining = rest.filter((c) => c.cells.length >= cut);
      if (joining.length) biggest.cells = biggest.cells.concat(...joining.map((c) => c.cells));
      ordered.push(biggest);
    }
    // In-territory labels can't collide with each other (each stays inside its
    // own hull-filled state, and hulls share no ground), so only the leader
    // labels — placed last, big states first — have to dodge what's already
    // on the map.
    ordered.sort((a, b) => b.cells.length - a.cells.length);
    fillHulls(ordered);
    return ordered;
  }

  let builtGeom = -1; // assignVersion of the cached geometry
  let ordered = []; // hull-filled components, biggest first

  // The text stage: fit each union state's current name (or abbreviation, or
  // leader label) into the cached geometry.
  function build({ assign, stateInfo, assignVersion }) {
    if (assignVersion !== builtGeom) {
      builtGeom = assignVersion;
      ordered = buildGeometry(assign);
    }
    const placed = [];
    const labels = [];
    const needLeader = [];
    const usedAbbrevs = new Set(POSTAL_CODES);
    let idNum = 0;
    for (const comp of ordered) {
      const info = stateInfo.get(sids[comp.state]);
      if (!info) continue;
      // Units outside the union stay unlabeled (for now): the tan ground
      // reads as context, and ~80 extra names would crowd the map.
      if (info.foreign) continue;
      const name = info.name.toUpperCase();
      const abbr = abbrevFor(sids[comp.state], info, usedAbbrevs);
      // Baselines depend on shape alone, so a component traced once keeps
      // its profiles for every refit of the same geometry.
      if (!("profA" in comp)) comp.profA = traceBaseline(comp);
      const profA = comp.profA;
      let label = null;
      if (profA) {
        // When PCA slants the axis, also try a level baseline; the slant only
        // keeps the label if horizontal text can't reach a comfortable size.
        const profH = profA.angled
          ? ("profH" in comp ? comp.profH : (comp.profH = traceBaseline(comp, 0)))
          : null;
        const pick = (text, track, maxSize, minSize) => {
          const fitA = bestFit(profA, text, track, maxSize, minSize);
          const fitH = profH ? bestFit(profH, text, track, maxSize, minSize) : null;
          if (
            fitH &&
            (!fitA ||
              fitH.size >= fitA.size ||
              (fitH.size >= HORIZ_COMFORT && fitH.size >= HORIZ_RATIO * fitA.size))
          )
            return { prof: profH, fit: fitH };
          return fitA ? { prof: profA, fit: fitA } : null;
        };
        const namePick = pick(name, NAME_TRACK, NAME_MAX, NAME_MIN);
        // Two stacked level lines beat the one-line label only decisively —
        // and rescue names where one line doesn't fit at all.
        const level = profA.angled ? profH : profA;
        const split = bestSplit(name, NAME_TRACK);
        const stackFit = split && bestFitLines(level, split, NAME_TRACK, NAME_MAX, NAME_MIN);
        if (stackFit && (!namePick || stackFit.size >= STACK_GAIN * namePick.fit.size))
          label = stackedLabel(level, stackFit, split, NAME_TRACK, idNum++);
        else if (namePick)
          label = curvedLabel(namePick.prof, namePick.fit, name, NAME_TRACK, idNum++);
        else {
          const abbrPick = pick(abbr, ABBR_TRACK, ABBR_MAX, ABBR_MIN);
          if (abbrPick) label = curvedLabel(abbrPick.prof, abbrPick.fit, abbr, ABBR_TRACK, idNum++);
        }
      }
      if (label) {
        labels.push(label);
        placed.push(label.box);
      } else needLeader.push({ comp, abbr });
    }
    for (const { comp, abbr } of needLeader) {
      const label = leaderLabel(comp, abbr, placed);
      labels.push(label);
      if (label.box) placed.push(label.box);
      if (label.lineBox) placed.push(label.lineBox);
    }
    return labels;
  }

  function toSvg(label) {
    const halo = Math.max(0.9, label.size * 0.13).toFixed(2);
    const attrs = (spacing) =>
      `font-size="${label.size.toFixed(2)}" letter-spacing="${spacing.toFixed(2)}" stroke-width="${halo}"`;
    const onPath = (id, d, spacing, text) =>
      `<path id="${id}" d="${d}" fill="none"/>` +
      `<text ${attrs(spacing)} dominant-baseline="central">` +
      `<textPath href="#${id}" startOffset="50%" text-anchor="middle">${esc(text)}</textPath></text>`;
    if (label.kind === "lines")
      return label.lines.map((ln) => onPath(ln.id, ln.d, ln.spacing, ln.text)).join("");
    if (label.kind === "path") return onPath(label.id, label.d, label.spacing, label.text);
    const common = attrs(label.spacing);
    const line =
      label.x1 !== undefined
        ? `<line x1="${label.x1.toFixed(1)}" y1="${label.y1.toFixed(1)}" x2="${label.x2.toFixed(1)}" y2="${label.y2.toFixed(1)}"/>`
        : "";
    return (
      line +
      `<text ${common} x="${label.cx.toFixed(1)}" y="${label.cy.toFixed(1)}" text-anchor="middle" dominant-baseline="central">${esc(label.text)}</text>`
    );
  }

  let builtLabels = -1;
  let lastBuild = -Infinity;
  let pending = null;
  let timer = 0;

  // Rebuild when the labels' own inputs moved (territory, a name, a foreign
  // flag — not selection or color), throttled so a brush stroke (one refresh
  // per pointer move) rebuilds a few times a second, with a trailing run that
  // settles on the final borders.
  function update(args) {
    group.attr("display", args.visible ? null : "none");
    if (!args.visible || args.labelsVersion === builtLabels) return;
    // (labels are written into `layer`, which carries the grid-origin shift)
    const now = performance.now();
    if (now - lastBuild < THROTTLE_MS) {
      pending = args;
      if (!timer)
        timer = setTimeout(() => {
          timer = 0;
          const p = pending;
          pending = null;
          update(p);
        }, THROTTLE_MS);
      return;
    }
    lastBuild = now;
    builtLabels = args.labelsVersion;
    layer.html(build(args).map(toSvg).join(""));
  }

  return { update };
}
