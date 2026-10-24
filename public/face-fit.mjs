// MediaPipe FACE_LANDMARKS_FACE_OVAL, in boundary order. Measurements stay
// in displayed camera pixels; no physical centimetres or identity are inferred.
export const FACE_OVAL = Object.freeze([10, 338, 297, 332, 284, 251, 389, 356, 454, 323, 361, 288, 397, 365, 379, 378, 400, 377, 152, 148, 176, 149, 150, 136, 172, 58, 132, 93, 234, 127, 162, 21, 54, 103, 67, 109]);

export function measureFace(points, mapPoint = point => point, quaternion = null) {
  if (!points || FACE_OVAL.some(index => !Number.isFinite(points[index]?.x) || !Number.isFinite(points[index]?.y))) return null;
  const oval = FACE_OVAL.map(index => mapPoint(points[index]));
  if (oval.some(point => !Number.isFinite(point.x) || !Number.isFinite(point.y))) return null;
  const top = oval[0], chin = oval[18];
  if (Math.hypot(chin.x - top.x, chin.y - top.y) < 1) return null;
  const roll = Math.atan2(top.x - chin.x, chin.y - top.y);
  const cos = Math.cos(roll), sin = Math.sin(roll);
  const origin = { x: (top.x + chin.x) / 2, y: (top.y + chin.y) / 2 };
  const local = oval.map(point => {
    const x = point.x - origin.x, y = point.y - origin.y;
    return { x: x * cos + y * sin, y: -x * sin + y * cos };
  });
  const left = Math.min(...local.map(p => p.x)), right = Math.max(...local.map(p => p.x));
  const topEdge = Math.min(...local.map(p => p.y)), bottom = Math.max(...local.map(p => p.y));
  const w = right - left, h = bottom - topEdge;
  if (w < 1 || h < 1) return null;
  const x = (left + right) / 2, y = (topEdge + bottom) / 2;
  return { x: origin.x + x * cos - y * sin, y: origin.y + x * sin + y * cos, w, h, roll, quaternion, measured: true };
}

export function faceCoverSize(face, { scale = 1, shape = 'round' } = {}) {
  const margin = 1.10 * Math.max(.8, Math.min(1.3, Number.isFinite(scale) ? scale : 1));
  return { w: face.w * margin * (shape === 'wide' ? 1.22 : 1), h: face.h * margin * (shape === 'tall' ? 1.18 : 1) };
}

export function fallbackFacePose(face, options) {
  const cover = faceCoverSize(face, options);
  return { x: face.x, y: face.y, w: cover.w / .78, h: cover.h / .8, roll: face.roll || 0, manual: !!face.manual };
}

export function manualFaceTarget(point, faces, current) {
  const candidates = faces.map(face => {
    const cos = Math.cos(face.roll || 0), sin = Math.sin(face.roll || 0);
    const dx = point.x - face.x, dy = point.y - face.y;
    return { face, distance: Math.hypot((dx * cos + dy * sin) / (face.w / 2), (-dx * sin + dy * cos) / (face.h / 2)) };
  }).filter(item => item.distance <= 1.6).sort((a, b) => a.distance - b.distance);
  const size = candidates[0]?.face || (current?.measured ? current : { w: 110, h: 145 });
  return { ...size, x: point.x, y: point.y, sample: false, manual: true };
}

function mixAngle(from = 0, to = 0, amount) {
  const delta = Math.atan2(Math.sin(to - from), Math.cos(to - from));
  return from + delta * amount;
}

// One filter after choosing the receiver: consistent latency at 30/60/120 Hz,
// without confusing two faces when the detector changes their array order.
export function smoothFacePose(previous, target, elapsed, blendQuaternion) {
  if (!target) return null;
  // After permanent renderer failure, continue from the shell that was actually
  // visible in 2D, rather than interpolating incompatible 3D placement units.
  if (previous?.fallback && !target.fallback) previous = previous.fallback;
  if (!previous) return { ...target, fallback: target.fallback && { ...target.fallback } };
  const amount = 1 - Math.exp(-Math.max(0, elapsed) / 80);
  const result = { ...target };
  for (const key of ['x', 'y', 'w', 'h']) result[key] = previous[key] + (target[key] - previous[key]) * amount;
  result.roll = mixAngle(previous.roll, target.roll, amount);
  result.quaternion = blendQuaternion(previous.quaternion, target.quaternion, amount);
  if (target.fallback) result.fallback = smoothFacePose(previous.fallback, target.fallback, elapsed, blendQuaternion);
  return result;
}
