// C2 — the orthographic camera.
//
// Three things move the view and they are deliberately different in kind:
//
//   rotation   a mat3 uniform. Every vertex is rotated on the GPU, so a turn
//              costs one uniform write. This is the point of the rewrite: it
//              replaces a ~130 ms CPU re-projection through d3-geo.
//   pan/zoom   a 2D screen transform, exactly as they are today. They do not
//              touch geometry at all.
//
// The rotation matrix here is the same composition the C1 compiler uses, and
// that one is checked against d3.geoOrthographic on every build.

const RAD = Math.PI / 180;

// d3.zoom's scale factor, not a tile zoom. 1 frames the lower 48; 16 is the
// app's current ceiling and lands around 295 m/px.
export const MAX_ZOOM = 16;
export const MIN_ZOOM = 0.2;

export function createCamera({ globeScale, globeTranslate, designBox, homeRotation }) {
  const [boxW, boxH] = designBox;

  const view = {
    rotation: [...homeRotation, 0], // lambda, phi, gamma, in degrees
    k: 1,
    pan: [0, 0], // device px, offset from where the design box puts the globe
    dpr: 1,
    width: 1, //  device px
    height: 1,
    cssWidth: 1,
    cssHeight: 1,
    fit: 1, //    design-box units -> css px
    // Bumped by anything that moves the view, so the renderer can tell a frame
    // that moved the map from one that only moved the pointer and keep its
    // cached scene for the second kind.
    version: 0,
  };

  // The same rotation twice. `matrix` is what the uniform wants; `matrix64` is
  // what arithmetic wants. Float32 carries ~7 digits, so unprojecting through
  // the uniform's copy lands ~1.5e-6 off — 0.03 px at maximum zoom, which is
  // invisible on screen but is a hundred times the error the forward matrix is
  // held to, and it would be the floor on everything the CPU derives from the
  // camera (C4's picks, C5's projected baselines). Two arrays cost 36 bytes.
  const matrix = new Float32Array(9);
  const matrix64 = new Float64Array(9);

  // Ryz(gamma) * Rxz(phi) * Rz(lambda), written out rather than multiplied at
  // runtime, then transposed into the column-major order uniformMatrix3fv wants.
  function updateMatrix() {
    const [l, p, g] = view.rotation;
    const cl = Math.cos(l * RAD);
    const sl = Math.sin(l * RAD);
    const cp = Math.cos(p * RAD);
    const sp = Math.sin(p * RAD);
    const cg = Math.cos(g * RAD);
    const sg = Math.sin(g * RAD);
    const m = [
      [cp * cl, -cp * sl, -sp],
      [cg * sl - sg * sp * cl, cg * cl + sg * sp * sl, -sg * cp],
      [sg * sl + cg * sp * cl, sg * cl - cg * sp * sl, cg * cp],
    ];
    for (let c = 0; c < 3; c++) {
      for (let r = 0; r < 3; r++) {
        matrix64[c * 3 + r] = m[r][c];
        matrix[c * 3 + r] = m[r][c];
      }
    }
    view.version++;
  }

  function resize(cssWidth, cssHeight, dpr) {
    view.cssWidth = Math.max(1, cssWidth);
    view.cssHeight = Math.max(1, cssHeight);
    view.dpr = dpr;
    view.width = Math.max(1, Math.round(view.cssWidth * dpr));
    view.height = Math.max(1, Math.round(view.cssHeight * dpr));
    // The app fits its design box into the canvas and letterboxes the rest.
    view.fit = Math.min(view.cssWidth / boxW, view.cssHeight / boxH);
    view.version++;
  }

  // Where the globe's centre sits with no panning, in device px.
  function homeCenter() {
    const offX = (view.cssWidth - boxW * view.fit) / 2;
    const offY = (view.cssHeight - boxH * view.fit) / 2;
    return [
      (offX + globeTranslate[0] * view.fit) * view.dpr,
      (offY + globeTranslate[1] * view.fit) * view.dpr,
    ];
  }

  const center = () => {
    const [hx, hy] = homeCenter();
    return [hx + view.pan[0], hy + view.pan[1]];
  };

  const radiusPx = () => globeScale * view.k * view.fit * view.dpr;

  // ------------------------------------------------------------- gestures

  // One sphere radius of travel is one radian of arc, at any zoom. Keeping it
  // in CSS px means the drag feels the same whatever the device pixel ratio.
  function rotateByPixels(dxCss, dyCss) {
    const perPx = 180 / Math.PI / (radiusPx() / view.dpr);
    view.rotation[0] += dxCss * perPx;
    view.rotation[1] = Math.max(-90, Math.min(90, view.rotation[1] - dyCss * perPx));
    updateMatrix();
  }

  function panByPixels(dxCss, dyCss) {
    view.pan[0] += dxCss * view.dpr;
    view.pan[1] += dyCss * view.dpr;
    view.version++;
  }

  // Zoom about a point, so whatever is under the cursor stays under it.
  function zoomAt(factor, atCssX, atCssY) {
    const next = Math.max(MIN_ZOOM, Math.min(MAX_ZOOM, view.k * factor));
    const applied = next / view.k;
    if (applied === 1) return;
    const mx = atCssX * view.dpr;
    const my = atCssY * view.dpr;
    const [cx, cy] = center();
    view.k = next;
    const [hx, hy] = homeCenter();
    view.pan[0] = mx + (cx - mx) * applied - hx;
    view.pan[1] = my + (cy - my) * applied - hy;
    view.version++;
  }

  function reset() {
    view.rotation = [...homeRotation, 0];
    view.k = 1;
    view.pan = [0, 0];
    updateMatrix();
  }

  // ------------------------------------------------------------- unproject
  //
  // The camera's own inverse, in closed form, because an orthographic sphere
  // has one: the shader's forward pass rotates a unit-sphere point and keeps
  // (y, -z), so the two screen coordinates ARE two of the three rotated
  // components and the third follows from the point being on the sphere.
  // x is depth toward the viewer, so the near hemisphere is the positive root.
  //
  // This is the whole of C4's geometry. There is no picking buffer, no
  // readback, and so no reason to stop picking during a gesture — which is
  // what the deck.gl path has to do (src/main.js, `gesturing`).
  function unproject(cssX, cssY) {
    const scale = radiusPx();
    const [cx, cy] = center();
    const y = (cssX * view.dpr - cx) / scale;
    const z = -(cssY * view.dpr - cy) / scale;
    const r2 = y * y + z * z;
    if (r2 > 1) return null; // the ray misses the sphere: off the disc
    const x = Math.sqrt(1 - r2);
    // Rotate back. The matrix is column-major — [c * 3 + r] is row r of column
    // c — so a row of the transpose is three contiguous entries.
    const m = matrix64;
    const lon = Math.atan2(m[3] * x + m[4] * y + m[5] * z, m[0] * x + m[1] * y + m[2] * z) / RAD;
    const lat = Math.asin(Math.max(-1, Math.min(1, m[6] * x + m[7] * y + m[8] * z))) / RAD;
    return [lon, lat];
  }

  updateMatrix();

  return {
    view,
    matrix,
    resize,
    center,
    radiusPx,
    rotateByPixels,
    panByPixels,
    zoomAt,
    reset,
    updateMatrix,
    unproject,
    // The float64 rotation, for the handful of things the CPU still projects.
    // C5 walks label baselines through it every frame — a few thousand points
    // for the whole map — so it reads the array directly rather than paying a
    // call per point.
    matrix64,
  };
}
