// C6 — the buffers a carve writes.
//
// Everything the C1 compiler emits is uploaded once and never touched again.
// Carved pieces are the one thing on the map that changes shape at runtime, so
// they live here instead: a second fill buffer and a second line buffer, both
// small, both rewritten wholesale whenever a cut lands.
//
// Wholesale rather than patched, and that is worth defending. The plan's
// original sketch had a carve patching the parent's own sub-range of the static
// fill buffer, which is possible — the compiler emits per-unit ranges for
// exactly that — and it forces two hard problems that this side-steps entirely:
// a piece has MORE triangles than the parent did, so the range no longer fits,
// and freeing the space a recut abandons is buffer defragmentation. A separate
// buffer has neither. The whole of every carve on the map is a few thousand
// triangles, which is a hundredth of what one frame already draws, so there is
// nothing to save by being clever.
//
// The parent is switched off rather than removed: its fill palette entry goes to
// zero alpha, which draws nothing. No shader knows about carving.

import { ATTRIB } from "./shaders.js";

/** The piece fills: triangles on the unit sphere, one unit id per vertex. */
export function createDynamicFills(gl) {
  const A = ATTRIB;
  const fill = {
    pos: gl.createBuffer(),
    unit: gl.createBuffer(),
    vao: gl.createVertexArray(),
    count: 0,
    ranges: new Map(), // piece unit id -> [firstVertex, vertexCount]
  };
  gl.bindVertexArray(fill.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, fill.pos);
  gl.enableVertexAttribArray(A.aPos);
  gl.vertexAttribPointer(A.aPos, 3, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, fill.unit);
  gl.enableVertexAttribArray(A.aUnit);
  gl.vertexAttribIPointer(A.aUnit, 1, gl.UNSIGNED_SHORT, 0, 0);
  gl.bindVertexArray(null);

  /**
   * Replace every carved piece on the map.
   *
   * `pieces` is `[{ unit, xyz }]` — `xyz` a list of triangles on the unit
   * sphere, as `carve.js` hands them over. Ranges come back out per piece
   * because the hover tint draws one piece on its own.
   */
  function set(pieces) {
    let n = 0;
    for (const p of pieces) n += p.xyz.length * 3;
    const pos = new Float32Array(n * 3);
    const unit = new Uint16Array(n);
    fill.ranges.clear();
    let v = 0;
    for (const p of pieces) {
      const first = v;
      for (const t of p.xyz) {
        for (const q of t) {
          pos[v * 3] = q[0];
          pos[v * 3 + 1] = q[1];
          pos[v * 3 + 2] = q[2];
          unit[v] = p.unit;
          v++;
        }
      }
      fill.ranges.set(p.unit, [first, v - first]);
    }
    fill.count = v;
    gl.bindBuffer(gl.ARRAY_BUFFER, fill.pos);
    gl.bufferData(gl.ARRAY_BUFFER, pos, gl.DYNAMIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, fill.unit);
    gl.bufferData(gl.ARRAY_BUFFER, unit, gl.DYNAMIC_DRAW);
  }

  return {
    vao: fill.vao,
    set,
    get count() {
      return fill.count;
    },
    rangeOf: (unit) => fill.ranges.get(unit) ?? null,
  };
}

/**
 * A dynamic line group, drawn by the same instanced shader as every compiled
 * one. Two of these exist: the piece-to-piece boundaries, which belong inside
 * the cached scene because they move when the map moves, and the knife line
 * being drawn, which belongs outside it because it moves when the POINTER does.
 * That is the one question C4's framebuffer asks of every new overlay.
 */
export function createDynamicLines(gl, cornerBuffer) {
  const A = ATTRIB;
  const line = {
    start: gl.createBuffer(),
    end: gl.createBuffer(),
    left: gl.createBuffer(),
    right: gl.createBuffer(),
    vao: gl.createVertexArray(),
    count: 0,
  };
  gl.bindVertexArray(line.vao);
  gl.bindBuffer(gl.ARRAY_BUFFER, cornerBuffer);
  gl.enableVertexAttribArray(A.aCorner);
  gl.vertexAttribPointer(A.aCorner, 2, gl.FLOAT, false, 0, 0);
  for (const [loc, buf] of [
    [A.aStart, line.start],
    [A.aEnd, line.end],
  ]) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
    gl.vertexAttribDivisor(loc, 1);
  }
  for (const [loc, buf] of [
    [A.aLeft, line.left],
    [A.aRight, line.right],
  ]) {
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribIPointer(loc, 1, gl.UNSIGNED_SHORT, 0, 0);
    gl.vertexAttribDivisor(loc, 1);
  }
  gl.bindVertexArray(null);

  /**
   * `segments` is `[{ xyz: [a, b], left, right }]`. The two unit ids are what
   * tell the line shader this is a border rather than a seam inside one piece,
   * exactly as they do for every compiled segment.
   */
  function set(segments) {
    const n = segments.length;
    const start = new Float32Array(n * 3);
    const end = new Float32Array(n * 3);
    const left = new Uint16Array(n);
    const right = new Uint16Array(n);
    segments.forEach((s, i) => {
      for (let k = 0; k < 3; k++) {
        start[i * 3 + k] = s.xyz[0][k];
        end[i * 3 + k] = s.xyz[1][k];
      }
      left[i] = s.left;
      right[i] = s.right;
    });
    line.count = n;
    for (const [buf, data] of [
      [line.start, start],
      [line.end, end],
      [line.left, left],
      [line.right, right],
    ]) {
      gl.bindBuffer(gl.ARRAY_BUFFER, buf);
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    }
  }

  return {
    vao: line.vao,
    set,
    get count() {
      return line.count;
    },
  };
}

/**
 * Unit ids for pieces, above the compiled units and below the sentinels.
 *
 * Ids are recycled, which matters more than it looks: recutting a county
 * abandons the pieces it had, and without a free list a session of tinkering
 * would walk the id space up until the palette ran out. With one, the ceiling is
 * how many pieces exist at once rather than how many have ever existed.
 */
export function createUnitPool(first, capacity) {
  const byId = new Map(); // piece id -> unit
  const free = [];
  let next = first;
  return {
    /** Assign units to exactly this set of piece ids, freeing the rest. */
    sync(ids) {
      const want = new Set(ids);
      for (const [id, unit] of byId) {
        if (!want.has(id)) {
          byId.delete(id);
          free.push(unit);
        }
      }
      for (const id of ids) {
        if (byId.has(id)) continue;
        const unit = free.length ? free.pop() : next++;
        if (unit >= first + capacity) throw new Error("out of piece unit ids");
        byId.set(id, unit);
      }
      return byId;
    },
    unitOf: (id) => byId.get(id),
    idOf: (unit) => {
      for (const [id, u] of byId) if (u === unit) return id;
      return null;
    },
    get size() {
      return byId.size;
    },
  };
}
