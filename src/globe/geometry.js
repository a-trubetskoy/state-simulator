// C2 — loading what the C1 compiler emits.
//
// One fetch, one upload, and nothing in these buffers is written again. C6 does
// not write to them either: a carve draws its pieces from a second, dynamic
// buffer and switches the parent off. What it does need from here is the county
// fills on the CPU, because a piece is the parent's own triangles cut by a
// curve, and those triangles are only otherwise on the GPU.
//
// Keeping them costs about 5 MB against the 20 MB already downloaded, and it is
// deliberately the COMPILED triangles rather than a fresh triangulation of the
// source rings. They come with the 120 km interior refinement the horizon needs,
// the antimeridian already unwrapped, the holes already resolved and the winding
// already fixed — so a piece is guaranteed to tile exactly what the parent was
// drawing, rather than nearly.

// WebGL forbids binding one buffer to both ARRAY_BUFFER and ELEMENT_ARRAY_BUFFER,
// so the single .bin is split in two on upload. The index block sits in the
// middle of the file, so everything after it shifts down by its length.
export async function loadGeometry(gl, { manifestUrl, signal } = {}) {
  const base = manifestUrl ?? "/data/globe-geometry.json";
  const manifest = await (await fetch(base, { signal })).json();
  const binUrl = new URL(manifest.binary, new URL(base, location.href)).pathname;
  const raw = await (await fetch(binUrl, { signal })).arrayBuffer();

  const B = manifest.buffers;
  const idx = B.fillIndex;
  const shift = (byteOffset) => (byteOffset > idx.byteOffset ? byteOffset - idx.byteLength : byteOffset);

  const attribBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, attribBuffer);
  gl.bufferData(gl.ARRAY_BUFFER, raw.byteLength - idx.byteLength, gl.STATIC_DRAW);
  gl.bufferSubData(gl.ARRAY_BUFFER, 0, new Uint8Array(raw, 0, idx.byteOffset));
  gl.bufferSubData(
    gl.ARRAY_BUFFER,
    idx.byteOffset,
    new Uint8Array(raw, idx.byteOffset + idx.byteLength)
  );

  const indexBuffer = gl.createBuffer();
  gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, indexBuffer);
  gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, new Uint8Array(raw, idx.byteOffset, idx.byteLength), gl.STATIC_DRAW);

  // Kept on the CPU for C6: which slice of the county fills belongs to a unit.
  const unitVertexRange = new Uint32Array(
    raw,
    B.unitVertexRange.byteOffset,
    B.unitVertexRange.count * 2
  );
  const unitIndexRange = new Uint32Array(
    raw,
    B.unitIndexRange.byteOffset,
    B.unitIndexRange.count * 2
  );

  // The county fills, copied out so the 20 MB source can be released. `slice`
  // rather than a view for exactly that reason, and it also lands both arrays at
  // offset zero, which is what their element alignment wants.
  const cg = manifest.fills.counties;
  const posAt = B.fillPosition.byteOffset + cg.firstVertex * 12;
  const idxAt = idx.byteOffset + cg.firstIndex * 4;
  const countyPositions = new Float32Array(raw.slice(posAt, posAt + cg.vertexCount * 12));
  const countyIndices = new Uint32Array(raw.slice(idxAt, idxAt + cg.indexCount * 4));

  return {
    manifest,
    attribBuffer,
    indexBuffer,
    unitCount: B.unitVertexRange.count,
    unitVertexRange,
    unitIndexRange,
    countyPositions,
    countyIndices,
    countyFirstVertex: cg.firstVertex,
    countyFirstIndex: cg.firstIndex,
    byteLength: raw.byteLength,
    offsets: {
      fillPosition: shift(B.fillPosition.byteOffset),
      fillUnit: shift(B.fillUnit.byteOffset),
      lineStart: shift(B.lineStart.byteOffset),
      lineEnd: shift(B.lineEnd.byteOffset),
      lineLeft: shift(B.lineLeft.byteOffset),
      lineRight: shift(B.lineRight.byteOffset),
    },
    fills: manifest.fills,
    lines: manifest.lines,
    sentinels: manifest.sentinels,
    camera: manifest.camera,
    stats: {
      fillVertices: B.fillPosition.count,
      triangles: idx.count / 3,
      segments: B.lineStart.count,
    },
  };
}

const DEG = 180 / Math.PI;

/**
 * One unit's compiled fill triangles, as lon/lat. This is what C6 cuts.
 *
 * The round trip through xyz is exact to the last bit or two, and the alternative
 * — carrying a second copy in lon/lat — would be 2.4 MB to save an atan2 per
 * vertex on the handful of counties anyone ever carves.
 */
export function unitTriangles(geometry, unit) {
  const P = geometry.countyPositions;
  const I = geometry.countyIndices;
  const first = geometry.unitIndexRange[unit * 2] - geometry.countyFirstIndex;
  const count = geometry.unitIndexRange[unit * 2 + 1];
  const base = geometry.countyFirstVertex;
  const at = (k) => {
    const v = (I[k] - base) * 3;
    const x = P[v];
    const y = P[v + 1];
    const z = P[v + 2];
    return [Math.atan2(y, x) * DEG, Math.atan2(z, Math.hypot(x, y)) * DEG];
  };
  const out = [];
  for (let k = first; k < first + count; k += 3) out.push([at(k), at(k + 1), at(k + 2)]);
  return out;
}
