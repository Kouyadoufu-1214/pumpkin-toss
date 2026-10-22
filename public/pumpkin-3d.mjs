import * as THREE from './vendor/three/three.module.js';
import { GLTFLoader } from './vendor/three/GLTFLoader.js';
import { createFrontDepth, createCutWalls, createInnerShell } from './carving-walls.mjs';

export function faceQuaternion(matrix, mirrored = true) {
  const values = matrix?.data;
  if (values?.length !== 16 || !Array.from(values).every(Number.isFinite)) return null;
  // MediaPipe's MatrixData is column-major, just like Three.js. Discard its
  // translation and scale: screen landmarks determine position and size.
  const rotation = new THREE.Matrix4().extractRotation(new THREE.Matrix4().fromArray(values));
  const mirror = new THREE.Matrix4().makeScale(-1, 1, 1);
  if (mirrored) rotation.premultiply(mirror).multiply(mirror);
  return new THREE.Quaternion().setFromRotationMatrix(rotation).normalize().toArray();
}

export function blendOrientation(from, to, amount = .35) {
  if (!to) return from;
  if (!from) return [...to];
  return new THREE.Quaternion().fromArray(from).slerp(new THREE.Quaternion().fromArray(to), amount).toArray();
}

export function createPumpkinGeometry() {
  const geometry = new THREE.SphereGeometry(1, 112, 72);
  const vertices = geometry.attributes.position;
  for (let i = 0; i < vertices.count; i++) {
    const x = vertices.getX(i), y = vertices.getY(i), z = vertices.getZ(i);
    const longitude = Math.atan2(x, z);
    const rib = .93 + .07 * Math.cos(longitude * 10);
    const bulge = 1 + .06 * (1 - y * y);
    vertices.setXYZ(i, x * rib * bulge, y * .91 * (1 - .10 * Math.abs(y) ** 8), z * rib * bulge);
  }
  geometry.computeVertexNormals(); geometry.computeBoundingSphere();
  return geometry;
}

export function projectedCarvingPoint(point) {
  return { x: (.5 + point.x / 2.45) * 512, y: (.56 - point.y / 2.35) * 512 };
}

function shellMaterial(mask, { inner = false, source = null } = {}) {
  const material = source ? source.clone() : new THREE.MeshStandardMaterial({
    color: inner ? 0x602403 : 0xe77918, roughness: inner ? .95 : .7, metalness: 0,
    side: inner ? THREE.BackSide : THREE.DoubleSide,
    emissive: inner ? 0xff950e : 0x000000, emissiveIntensity: inner ? 1.05 : 0,
  });
  material.onBeforeCompile = shader => {
    shader.uniforms.carvingMask = { value: mask };
    shader.vertexShader = `varying vec3 pumpkinPosition;\n${shader.vertexShader}`.replace('#include <begin_vertex>', '#include <begin_vertex>\npumpkinPosition = position;');
    shader.fragmentShader = `uniform sampler2D carvingMask;\nvarying vec3 pumpkinPosition;\n${shader.fragmentShader}`.replace('#include <color_fragment>', `
      #include <color_fragment>
      vec2 carvingUV = vec2(0.5 + pumpkinPosition.x / 2.45, 0.44 + pumpkinPosition.y / 2.35);
      if (pumpkinPosition.z > 0.05 && carvingUV.x > 0.0 && carvingUV.x < 1.0 && carvingUV.y > 0.0 && carvingUV.y < 1.0) {
        float cut = texture2D(carvingMask, carvingUV).a;
        if (cut > 0.5) discard;
        ${inner ? '' : 'diffuseColor.rgb = mix(diffuseColor.rgb, vec3(1.0, 0.63, 0.22), min(cut * 1.8, 0.9));'}
      }
    `);
    if (inner) shader.fragmentShader = shader.fragmentShader.replace('#include <emissivemap_fragment>', `
      #include <emissivemap_fragment>
      vec2 glowOffset = pumpkinPosition.xy - vec2(0.0, -0.28);
      totalEmissiveRadiance *= 0.28 + 0.85 * exp(-2.6 * dot(glowOffset, glowOffset));
    `);
  };
  material.customProgramCacheKey = () => `pumpkin-cut-v3-${inner}`;
  return material;
}

export class Pumpkin3D {
  constructor(maskCanvas, width, height) {
    this.width = width; this.height = height; this.disposed = false;
    this.maskContext = maskCanvas.getContext('2d');
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderError = null;
    this.renderer.debug.onShaderError = () => {
      if (!this.renderError) console.warn('Pumpkin shader unavailable; using the canvas fallback.');
      this.renderError = new Error('The pumpkin shader could not be compiled.');
    };
    this.renderer.setSize(width, height, false); this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.15;
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(40, width / height, 1, 5000);
    this.camera.position.z = height / (2 * Math.tan(THREE.MathUtils.degToRad(20)));
    this.camera.updateMatrixWorld();
    this.root = new THREE.Group(); this.scene.add(this.root);
    this.mask = new THREE.CanvasTexture(maskCanvas);
    this.mask.colorSpace = THREE.NoColorSpace; this.mask.generateMipmaps = false;
    this.mask.minFilter = this.mask.magFilter = THREE.LinearFilter;
    this.geometry = createPumpkinGeometry();
    this.shell = new THREE.Mesh(this.geometry, shellMaterial(this.mask));
    this.root.add(this.shell);
    this.inside = new THREE.Mesh(createInnerShell(this.geometry), shellMaterial(this.mask, { inner: true }));
    this.root.add(this.inside);
    this.cutWalls = new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial({
      vertexColors: true, roughness: .9, side: THREE.DoubleSide, emissive: 0xd35a08, emissiveIntensity: .18,
    }));
    this.root.add(this.cutWalls);
    this.surface = createFrontDepth(this.geometry); this.wallsDirty = true; this.lastWallsAt = -Infinity;
    // The cavity itself carries the candle glow, with no bright primitive
    // intersecting the user's eyes or mouth when viewed from the side.
    this.details = new THREE.Group(); this.root.add(this.details);
    const stemPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, .76, 0), new THREE.Vector3(.02, .97, -.02),
      new THREE.Vector3(.10, 1.15, -.03), new THREE.Vector3(.19, 1.22, .01),
    ]);
    const stem = new THREE.Mesh(new THREE.TubeGeometry(stemPath, 16, .075, 7, false), new THREE.MeshStandardMaterial({ color: 0x4a6828, roughness: .9 }));
    this.details.add(stem);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshStandardMaterial({ color: 0x6a8a32, roughness: .75 }));
    leaf.scale.set(.23, .025, .10); leaf.position.set(-.12, .95, .02); leaf.rotation.z = -.3; this.details.add(leaf);
    this.scene.add(new THREE.HemisphereLight(0xffe8cc, 0x30243c, 1.25));
    const key = new THREE.DirectionalLight(0xffe5c5, 3.8); key.position.set(-360, 450, 550); this.scene.add(key);
    const fill = new THREE.DirectionalLight(0xc4d5ff, .7); fill.position.set(400, 60, 350); this.scene.add(fill);
    const rim = new THREE.DirectionalLight(0xb1c8ff, 2.4); rim.position.set(400, 220, -400); this.scene.add(rim);
    this.raycaster = new THREE.Raycaster(); this.localPoint = new THREE.Vector3();
    this.assetStatus = 'loading';
    this.ready = this.loadAsset().catch(error => {
      this.assetStatus = 'fallback'; console.warn('Pumpkin asset unavailable; using the local fallback.', error); return false;
    });
  }

  async loadAsset() {
    const gltf = await new GLTFLoader().loadAsync(new URL('./pumpkin-higgsfield.glb', import.meta.url).href);
    if (this.disposed) { disposeObject(gltf.scene); return false; }
    gltf.scene.updateMatrixWorld(true);
    const parts = {};
    gltf.scene.traverse(object => { if (object.isMesh && /^pumpkin-(shell|stem|leaf)$/.test(object.name)) parts[object.name] = object; });
    if (!parts['pumpkin-shell'] || !parts['pumpkin-stem'] || !parts['pumpkin-leaf']) {
      disposeObject(gltf.scene); throw new Error('The pumpkin asset is missing a required part.');
    }
    // Bake exported node transforms once; carving and face poses share the
    // same Y-up, +Z-front coordinates regardless of the Blender hierarchy.
    for (const object of Object.values(parts)) object.geometry.applyMatrix4(object.matrixWorld);
    this.shell.geometry.dispose(); this.shell.material.dispose(); this.inside.geometry.dispose();
    disposeObject(this.details); this.details.clear();
    this.geometry = parts['pumpkin-shell'].geometry; this.shell.geometry = this.geometry;
    this.shell.material = shellMaterial(this.mask, { source: parts['pumpkin-shell'].material });
    parts['pumpkin-shell'].material.dispose();
    this.inside.geometry = createInnerShell(this.geometry);
    for (const name of ['pumpkin-stem', 'pumpkin-leaf']) {
      const source = parts[name];
      source.material.side = THREE.DoubleSide;
      this.details.add(new THREE.Mesh(source.geometry, source.material));
    }
    this.surface = createFrontDepth(this.geometry); this.wallsDirty = true;
    this.assetStatus = 'higgsfield'; return true;
  }

  updateMask() { this.mask.needsUpdate = true; this.wallsDirty = true; }

  place(pose) {
    const depth = pose.depth ?? 1;
    this.root.position.set((pose.x - this.width / 2) * depth, (this.height / 2 - pose.y) * depth, this.camera.position.z * (1 - depth));
    // Pose size is in screen pixels, including estimated hand distance.
    this.root.scale.set(pose.w * .37 * depth, pose.h * .43 * depth, Math.min(pose.w, pose.h) * .34 * depth);
    if (pose.quaternion) this.root.quaternion.fromArray(pose.quaternion);
    else this.root.rotation.set(pose.pitch || 0, pose.yaw || 0, -(pose.roll || 0), 'YXZ');
    this.root.updateMatrixWorld(true);
  }

  draw(context, pose) {
    // A lost WebGL context renders a transparent buffer without throwing.
    // Let the caller draw the canvas fallback until Three.js restores it.
    if (this.disposed || this.renderError || this.renderer.getContext().isContextLost()) return false;
    const now = performance.now();
    if (this.wallsDirty && now - this.lastWallsAt >= 80) {
      const next = createCutWalls(this.maskContext.getImageData(0, 0, 512, 512), this.surface);
      this.cutWalls.geometry.dispose(); this.cutWalls.geometry = next;
      this.wallsDirty = false; this.lastWallsAt = now;
    }
    this.inside.material.emissiveIntensity = 1.05 + .035 * Math.sin(now * .004) + .018 * Math.sin(now * .009);
    this.place(pose); this.renderer.render(this.scene, this.camera);
    if (this.renderError || this.renderer.getContext().isContextLost()) return false;
    context.drawImage(this.renderer.domElement, 0, 0);
    return true;
  }

  hit(point, pose, requireFront = false) {
    this.place(pose);
    this.raycaster.setFromCamera({ x: point.x / this.width * 2 - 1, y: 1 - point.y / this.height * 2 }, this.camera);
    const hit = this.raycaster.intersectObject(this.shell, false)[0];
    if (!hit) return null;
    this.localPoint.copy(hit.point); this.shell.worldToLocal(this.localPoint);
    if (requireFront && this.localPoint.z < .08) return null;
    return projectedCarvingPoint(this.localPoint);
  }

  dispose() {
    this.disposed = true; disposeObject(this.root);
    this.mask.dispose(); this.renderer.dispose();
  }
}

function disposeObject(root) {
  const textures = new Set();
  root.traverse(object => {
    if (!object.isMesh) return;
    object.geometry.dispose();
    for (const material of Array.isArray(object.material) ? object.material : [object.material]) {
      for (const value of Object.values(material)) if (value?.isTexture) textures.add(value);
      material.dispose();
    }
  });
  for (const texture of textures) { texture.dispose(); texture.source?.data?.close?.(); }
}
