import * as THREE from './vendor/three/three.module.js';

const SIZE = 512;
const innerDepth = .84;
const toWorld = (x, y) => [(x / SIZE - .5) * 2.45, (.56 - y / SIZE) * 2.35];

// Rasterize the actual exported surface once. No per-frame mesh booleans or
// thousands of ray casts: the cut walls can follow any convex pumpkin shape.
export function createFrontDepth(geometry, cells = 256) {
  const stride = cells + 1, depth = new Float32Array(stride * stride);
  depth.fill(NaN);
  const p = geometry.attributes.position, index = geometry.index;
  const count = index ? index.count : p.count;
  const vertex = i => {
    const n = index ? index.getX(i) : i;
    return [(.5 + p.getX(n) / 2.45) * cells, (.56 - p.getY(n) / 2.35) * cells, p.getZ(n)];
  };
  for (let t = 0; t < count; t += 3) {
    const a = vertex(t), b = vertex(t + 1), c = vertex(t + 2);
    if (Math.max(a[2], b[2], c[2]) <= .05) continue;
    const d = (b[1] - c[1]) * (a[0] - c[0]) + (c[0] - b[0]) * (a[1] - c[1]);
    if (Math.abs(d) < 1e-9) continue;
    const x0 = Math.max(0, Math.ceil(Math.min(a[0], b[0], c[0])));
    const x1 = Math.min(cells, Math.floor(Math.max(a[0], b[0], c[0])));
    const y0 = Math.max(0, Math.ceil(Math.min(a[1], b[1], c[1])));
    const y1 = Math.min(cells, Math.floor(Math.max(a[1], b[1], c[1])));
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const u = ((b[1] - c[1]) * (x - c[0]) + (c[0] - b[0]) * (y - c[1])) / d;
      const v = ((c[1] - a[1]) * (x - c[0]) + (a[0] - c[0]) * (y - c[1])) / d;
      if (u < -1e-5 || v < -1e-5 || u + v > 1.00001) continue;
      const z = a[2] * u + b[2] * v + c[2] * (1 - u - v), at = y * stride + x;
      if (z > .05 && (!Number.isFinite(depth[at]) || z > depth[at])) depth[at] = z;
    }
  }
  return { cells, stride, depth };
}

export function createCutWalls(image, surface) {
  const { cells, stride, depth } = surface, step = SIZE / cells;
  const alpha = new Float32Array(stride * stride), positions = [], colors = [];
  for (let y = 0; y <= cells; y++) for (let x = 0; x <= cells; x++) {
    const px = Math.min(SIZE - 1, Math.floor(x * step)), py = Math.min(SIZE - 1, Math.floor(y * step));
    alpha[y * stride + x] = image.data[(py * SIZE + px) * 4 + 3] / 255;
  }
  function surfaceZ(x, y) {
    const ix = Math.min(cells - 1, Math.floor(x)), iy = Math.min(cells - 1, Math.floor(y));
    const u = x - ix, v = y - iy, at = iy * stride + ix;
    const zs = [depth[at], depth[at + 1], depth[at + stride], depth[at + stride + 1]];
    if (!zs.every(Number.isFinite)) return NaN;
    return zs[0] * (1 - u) * (1 - v) + zs[1] * u * (1 - v) + zs[2] * (1 - u) * v + zs[3] * u * v;
  }
  function wall(x1, y1, x2, y2) {
    const z1 = surfaceZ(x1, y1), z2 = surfaceZ(x2, y2);
    if (!(z1 > .08 && z2 > .08)) return;
    const a = toWorld(x1 * step, y1 * step), b = toWorld(x2 * step, y2 * step);
    const points = [[...a, z1], [...b, z2], [...b, z2 * innerDepth], [...a, z1 * innerDepth]];
    for (const i of [0, 1, 2, 0, 2, 3]) {
      positions.push(...points[i]);
      // Pale flesh at the lip grades to warm amber inside the lantern.
      colors.push(...(i < 2 ? [1, .63, .22] : [.75, .32, .045]));
    }
  }
  // Interpolate the contour across cells instead of building a staircase
  // along pixel edges. Antialiased freehand diagonals stay smooth in 3D.
  const segments = [[], [3, 0], [0, 1], [3, 1], [1, 2], [3, 0, 1, 2], [0, 2], [3, 2], [2, 3], [0, 2], [0, 1, 2, 3], [1, 2], [1, 3], [0, 1], [3, 0], []];
  const corners = [[0, 0], [1, 0], [1, 1], [0, 1]];
  for (let y = 0; y < cells; y++) for (let x = 0; x < cells; x++) {
    const at = y * stride + x, values = [alpha[at], alpha[at + 1], alpha[at + stride + 1], alpha[at + stride]];
    const code = values.reduce((bits, a, i) => bits | (a > .5 ? 1 << i : 0), 0);
    const edges = segments[code];
    const crossing = edge => {
      const next = (edge + 1) % 4, a = corners[edge], b = corners[next];
      const t = (.5 - values[edge]) / (values[next] - values[edge]);
      return [x + a[0] + (b[0] - a[0]) * t + .5 / step, y + a[1] + (b[1] - a[1]) * t + .5 / step];
    };
    for (let i = 0; i < edges.length; i += 2) wall(...crossing(edges[i]), ...crossing(edges[i + 1]));
  }
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 3));
  geometry.computeVertexNormals();
  return geometry;
}

// Preserve the same x/y projection on both surfaces so carvings align even
// near the cheek. Scaling all three axes would leave orange patches in holes.
export function createInnerShell(geometry) {
  return geometry.clone().scale(1, 1, innerDepth);
}
