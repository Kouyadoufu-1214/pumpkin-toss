import * as THREE from './vendor/three/three.module.js';

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

function shellMaterial(mask, { inner = false } = {}) {
  const material = new THREE.MeshStandardMaterial({
    color: inner ? 0xf4a443 : 0xe77918, roughness: inner ? .95 : .48, metalness: 0,
    side: inner ? THREE.BackSide : THREE.DoubleSide,
    emissive: inner ? 0xad3505 : 0x000000, emissiveIntensity: inner ? .65 : 0,
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
        float edge = max(max(texture2D(carvingMask, carvingUV + vec2(0.004, 0.0)).a,
                            texture2D(carvingMask, carvingUV - vec2(0.004, 0.0)).a),
                        max(texture2D(carvingMask, carvingUV + vec2(0.0, 0.004)).a,
                            texture2D(carvingMask, carvingUV - vec2(0.0, 0.004)).a));
        diffuseColor.rgb = mix(diffuseColor.rgb, vec3(0.95, 0.47, 0.08), edge * 0.7);
      }
    `);
  };
  material.customProgramCacheKey = () => `pumpkin-cut-v1-${inner}`;
  return material;
}

export class Pumpkin3D {
  constructor(maskCanvas, width, height) {
    this.width = width; this.height = height;
    this.renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    this.renderer.setSize(width, height, false); this.renderer.setPixelRatio(1);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping; this.renderer.toneMappingExposure = 1.1;
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
    const inside = new THREE.Mesh(this.geometry, shellMaterial(this.mask, { inner: true }));
    inside.scale.setScalar(.90); this.root.add(inside);
    // A small light at the center is visible through the actual discarded
    // shell fragments. Back/sides remain solid when the pumpkin turns.
    const ember = new THREE.Mesh(new THREE.SphereGeometry(.48, 32, 24), new THREE.MeshBasicMaterial({ color: 0xffd87b }));
    ember.position.y = -.09; this.root.add(ember);
    const stemPath = new THREE.CatmullRomCurve3([
      new THREE.Vector3(0, .76, 0), new THREE.Vector3(.02, .97, -.02),
      new THREE.Vector3(.10, 1.15, -.03), new THREE.Vector3(.19, 1.22, .01),
    ]);
    const stem = new THREE.Mesh(new THREE.TubeGeometry(stemPath, 16, .075, 7, false), new THREE.MeshStandardMaterial({ color: 0x4a6828, roughness: .9 }));
    this.root.add(stem);
    const leaf = new THREE.Mesh(new THREE.SphereGeometry(1, 16, 10), new THREE.MeshStandardMaterial({ color: 0x6a8a32, roughness: .75 }));
    leaf.scale.set(.23, .025, .10); leaf.position.set(-.12, .95, .02); leaf.rotation.z = -.3; this.root.add(leaf);
    this.scene.add(new THREE.HemisphereLight(0xfff1dd, 0x38223f, 2.1));
    const key = new THREE.DirectionalLight(0xffe4bf, 3.2); key.position.set(-300, 500, 650); this.scene.add(key);
    const rim = new THREE.DirectionalLight(0xc4b2ff, 1.8); rim.position.set(400, 170, -400); this.scene.add(rim);
    this.raycaster = new THREE.Raycaster(); this.localPoint = new THREE.Vector3();
  }

  updateMask() { this.mask.needsUpdate = true; }

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
    this.place(pose); this.renderer.render(this.scene, this.camera);
    context.drawImage(this.renderer.domElement, 0, 0);
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
    this.root.traverse(object => { if (object.isMesh) { object.geometry.dispose(); object.material.dispose(); } });
    this.mask.dispose(); this.renderer.dispose();
  }
}
