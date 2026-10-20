// A quiet, hand-drawn moonlit workshop. Keep the middle clear for the artwork.
const scenes = new Map();
const SCENE_WIDTH = 1280, SCENE_HEIGHT = 720;

function moon(context, camera) {
  const glow = context.createRadialGradient(150, 172, 20, 150, 172, 112);
  glow.addColorStop(0, camera ? '#f8e5b820' : '#f8e5b82c');
  glow.addColorStop(1, '#f8e5b800');
  context.fillStyle = glow;
  context.fillRect(38, 60, 224, 224);
  context.fillStyle = camera ? '#f6e8c17a' : '#f6e8c1b8';
  context.beginPath(); context.arc(150, 172, 43, 0, Math.PI * 2); context.fill();
  context.fillStyle = camera ? '#625b6412' : '#625b6420';
  for (const [x, y, radius] of [[132, 157, 9], [163, 186, 12], [145, 192, 4]]) {
    context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.fill();
  }
}

function bat(context, x, y, scale, rotation, camera) {
  context.save();
  context.translate(x, y); context.rotate(rotation); context.scale(scale, scale);
  context.fillStyle = camera ? '#11132394' : '#0c1023b8';
  context.beginPath(); context.moveTo(-4, 0);
  context.bezierCurveTo(-17, -16, -34, -20, -49, -13);
  context.bezierCurveTo(-36, -7, -35, 1, -32, 8);
  context.quadraticCurveTo(-23, 1, -17, 8);
  context.quadraticCurveTo(-12, 4, -6, 10);
  context.quadraticCurveTo(0, 19, 6, 10);
  context.quadraticCurveTo(12, 4, 17, 8);
  context.quadraticCurveTo(23, 1, 32, 8);
  context.bezierCurveTo(35, 1, 36, -7, 49, -13);
  context.bezierCurveTo(34, -20, 17, -16, 4, 0);
  context.lineTo(5, -8); context.lineTo(1, -5);
  context.lineTo(-1, -5); context.lineTo(-5, -8);
  context.closePath(); context.fill();
  context.restore();
}

function fence(context, right, camera) {
  context.save();
  if (right) { context.translate(SCENE_WIDTH, 0); context.scale(-1, 1); }
  context.strokeStyle = context.fillStyle = camera ? '#1313227d' : '#0d1223cf';
  context.lineWidth = 8; context.lineCap = 'round';
  for (const y of [690, 712]) {
    context.beginPath(); context.moveTo(-8, y); context.lineTo(290, y + 7); context.stroke();
  }
  for (const [x, y] of [[9, 653], [73, 661], [137, 670], [201, 675], [265, 682]]) {
    context.beginPath(); context.moveTo(x - 5, 725); context.lineTo(x - 5, y + 5);
    context.quadraticCurveTo(x, y - 2, x + 5, y + 5);
    context.lineTo(x + 5, 725); context.closePath(); context.fill();
  }
  context.restore();
}

function leaf(context, x, y, scale, rotation, color) {
  context.save(); context.translate(x, y); context.rotate(rotation); context.scale(scale, scale);
  context.fillStyle = color;
  context.beginPath(); context.moveTo(-16, 0);
  context.bezierCurveTo(-7, -12, 8, -13, 20, 0);
  context.bezierCurveTo(7, 11, -6, 10, -16, 0); context.fill();
  context.strokeStyle = '#18172470'; context.lineWidth = 1.2;
  context.beginPath(); context.moveTo(-21, 1); context.lineTo(14, 0); context.stroke();
  context.restore();
}

function paintScene(context, width, height, camera) {
  context.save(); context.scale(width / SCENE_WIDTH, height / SCENE_HEIGHT);
  if (camera) {
    // Translucent throughout: the camera and the user's hands remain visible.
    context.fillStyle = '#10132659';
  } else {
    const night = context.createLinearGradient(0, 0, 900, SCENE_HEIGHT);
    night.addColorStop(0, '#11172b'); night.addColorStop(.52, '#1c1931'); night.addColorStop(1, '#221b2d');
    context.fillStyle = night;
  }
  context.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);

  const warmth = context.createRadialGradient(640, 454, 30, 640, 454, 395);
  warmth.addColorStop(0, camera ? '#f3a4550e' : '#f3a45529');
  warmth.addColorStop(.58, camera ? '#d47c3b08' : '#d47c3b12');
  warmth.addColorStop(1, '#d47c3b00');
  context.fillStyle = warmth; context.fillRect(0, 0, SCENE_WIDTH, SCENE_HEIGHT);

  moon(context, camera);
  bat(context, 282, 249, .65, -.16, camera);
  bat(context, 1047, 203, .72, .13, camera);
  bat(context, 1121, 271, .47, -.18, camera);
  fence(context, false, camera); fence(context, true, camera);
  const amber = camera ? '#a06b3e70' : '#a06b3e9c';
  const rust = camera ? '#89504870' : '#8950488f';
  leaf(context, 55, 643, .85, -.5, amber);
  leaf(context, 222, 680, .65, .4, rust);
  leaf(context, 304, 703, .85, -.3, amber);
  leaf(context, 991, 699, .72, .6, rust);
  leaf(context, 1118, 661, .8, -.7, amber);
  leaf(context, 1228, 694, .6, .2, rust);
  context.restore();
}

function cachedScene(width, height, camera) {
  const key = `${width}:${height}:${camera}`;
  if (scenes.has(key)) return scenes.get(key);
  const canvas = typeof OffscreenCanvas !== 'undefined'
    ? new OffscreenCanvas(width, height)
    : document.createElement('canvas');
  canvas.width = width; canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The workshop background requires a 2D canvas');
  paintScene(context, width, height, camera);
  // Bound retained buffers if the viewport changes repeatedly.
  if (scenes.size >= 4) scenes.delete(scenes.keys().next().value);
  scenes.set(key, canvas);
  return canvas;
}

export function drawWorkshopScene(context, { width = 1280, height = 720, camera = false } = {}) {
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return;
  const scene = cachedScene(Math.max(1, Math.round(width)), Math.max(1, Math.round(height)), Boolean(camera));
  context.save();
  try {
    context.globalAlpha = 1;
    context.globalCompositeOperation = 'source-over';
    context.drawImage(scene, 0, 0, width, height);
  } finally { context.restore(); }
}
