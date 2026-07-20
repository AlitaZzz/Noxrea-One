import * as THREE from "three";

// 场景 / 渲染器 / 光照 / 地面 / 网格 / 渲染循环 / resize
export class Stage {
  viewport: HTMLElement;
  scene: THREE.Scene;
  renderer: THREE.WebGLRenderer;
  camera: THREE.PerspectiveCamera;
  activeCamera: THREE.PerspectiveCamera | null = null;
  world: THREE.Group;
  clock: THREE.Timer;
  private _tick: ((dt: number) => void) | null = null;
  private _panoTex: THREE.Texture | null = null;
  private _panoRotDeg: number = 0;
  private _panoRadius: number = 60;
  private _fogSaved?: { near: number; far: number };

  groundGroup: THREE.Group;
  ground: THREE.Mesh;
  grid: THREE.GridHelper;
  panoSphere: THREE.Mesh | null = null;

  constructor(viewportEl: HTMLElement) {
    this.viewport = viewportEl;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x060608);
    this.scene.fog = new THREE.Fog(0x060608, 18, 46);

    this.renderer = new THREE.WebGLRenderer({
      antialias: true,
      preserveDrawingBuffer: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
    viewportEl.appendChild(this.renderer.domElement);

    this.camera = new THREE.PerspectiveCamera(40, 1, 0.05, 1000);
    this.camera.position.set(0, 1.6, 6.2);

    this.world = new THREE.Group();
    this.scene.add(this.world);

    this._buildLights();
    const built = this._buildGround();
    this.groundGroup = built.groundGroup;
    this.ground = built.ground;
    this.grid = built.grid;

    this.clock = new THREE.Timer();

    this.onResize = this.onResize.bind(this);
    window.addEventListener("resize", this.onResize);
    this.onResize();
  }

  _buildLights() {
    const s = this.scene;
    s.add(new THREE.AmbientLight(0xffffff, 0.42));
    s.add(new THREE.HemisphereLight(0xbcd2ff, 0x14181f, 0.7));

    const key = new THREE.DirectionalLight(0xffffff, 1.35);
    key.position.set(4, 10, 6);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    key.shadow.camera.near = 0.5;
    key.shadow.camera.far = 40;
    key.shadow.camera.left = -10;
    key.shadow.camera.right = 10;
    key.shadow.camera.top = 10;
    key.shadow.camera.bottom = -10;
    key.shadow.bias = -0.0004;
    key.shadow.radius = 4;
    s.add(key);

    const fill = new THREE.DirectionalLight(0x9bb8ff, 0.4);
    fill.position.set(-6, 4, -2);
    s.add(fill);
    const rim = new THREE.DirectionalLight(0xbfd3ff, 0.5);
    rim.position.set(-3, 6, -8);
    s.add(rim);
  }

  _buildGround() {
    const groundGroup = new THREE.Group();
    this.scene.add(groundGroup);

    const mat = new THREE.MeshStandardMaterial({
      color: 0x0c0e12,
      roughness: 1,
      metalness: 0,
      transparent: true,
      opacity: 0.4,
    });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(60, 60), mat);
    ground.rotation.x = -Math.PI / 2;
    ground.receiveShadow = true;
    groundGroup.add(ground);

    const grid = new THREE.GridHelper(40, 40, 0x2a3a5c, 0x1b2540);
    (grid.material as any).transparent = true;
    (grid.material as any).opacity = 0.55;
    grid.position.y = 0.002;
    groundGroup.add(grid);

    const axisMat = (c: number) =>
      new THREE.LineBasicMaterial({ color: c, transparent: true, opacity: 0.5 });
    const xg = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(-20, 0.004, 0),
      new THREE.Vector3(20, 0.004, 0),
    ]);
    const zg = new THREE.BufferGeometry().setFromPoints([
      new THREE.Vector3(0, 0.004, -20),
      new THREE.Vector3(0, 0.004, 20),
    ]);
    groundGroup.add(new THREE.Line(xg, axisMat(0x8a3a3a)));
    groundGroup.add(new THREE.Line(zg, axisMat(0x3a4a8a)));

    return { groundGroup, ground, grid };
  }

  // ---- 全景背景 ----
  setPanorama(texture: THREE.Texture) {
    texture.mapping = THREE.EquirectangularReflectionMapping;
    if (this._panoTex && this._panoTex !== texture) this._panoTex.dispose();
    this._panoTex = texture;
    if (!this.panoSphere) {
      const geo = new THREE.SphereGeometry(1, 60, 40);
      const mat = new THREE.MeshBasicMaterial({
        side: THREE.BackSide,
        toneMapped: false,
        depthWrite: false,
      });
      this.panoSphere = new THREE.Mesh(geo, mat);
      this.panoSphere.renderOrder = -1;
      this.panoSphere.rotation.y = THREE.MathUtils.degToRad(this._panoRotDeg || 0);
      this.panoSphere.scale.setScalar(this._panoRadius || 60);
      this.scene.add(this.panoSphere);
    }
    (this.panoSphere.material as THREE.MeshBasicMaterial).map = texture;
    (this.panoSphere.material as THREE.MeshBasicMaterial).needsUpdate = true;
    this.panoSphere.visible = true;
    if (this.scene.fog && this._fogSaved === undefined) {
      const fog = this.scene.fog as THREE.Fog;
      this._fogSaved = { near: fog.near, far: fog.far };
      fog.near = 1000;
      fog.far = 2000;
    }
  }

  clearPanorama(skyHex?: number) {
    if (this.panoSphere) {
      this.panoSphere.visible = false;
      (this.panoSphere.material as THREE.MeshBasicMaterial).map = null;
    }
    if (this._panoTex) {
      this._panoTex.dispose();
      this._panoTex = null;
    }
    if (this.scene.fog && this._fogSaved) {
      const fog = this.scene.fog as THREE.Fog;
      fog.near = this._fogSaved.near;
      fog.far = this._fogSaved.far;
      this._fogSaved = undefined;
    }
    if (skyHex != null) this.setSkyColor(skyHex);
  }

  hasPanorama(): boolean {
    return !!(this.panoSphere && this.panoSphere.visible);
  }

  setPanoramaRotation(deg: number) {
    this._panoRotDeg = deg;
    if (this.panoSphere) this.panoSphere.rotation.y = THREE.MathUtils.degToRad(deg);
  }

  setPanoramaRadius(r: number) {
    this._panoRadius = r;
    if (this.panoSphere) this.panoSphere.scale.setScalar(r);
  }

  // ---- scene-level controls ----
  setSkyColor(hex: number | string) {
    this.scene.background = new THREE.Color(hex);
    if (this.scene.fog) this.scene.fog.color = new THREE.Color(hex);
  }
  setGroundVisible(v: boolean) {
    this.groundGroup.visible = v;
  }
  setGroundOpacity(v: number) {
    (this.ground.material as THREE.MeshStandardMaterial).opacity = v;
  }
  setGroundHeight(y: number) {
    this.groundGroup.position.y = y;
  }

  setWorldScale(s: number) {
    this.world.scale.setScalar(s);
  }
  setWorldPos(x: number, y: number, z: number) {
    this.world.position.set(x, y, z);
  }
  setWorldRot(x: number, y: number, z: number) {
    this.world.rotation.set(x, y, z);
  }

  add(obj: THREE.Object3D) {
    this.world.add(obj);
  }
  remove(obj: THREE.Object3D) {
    this.world.remove(obj);
  }

  onResize() {
    const W = this.viewport.clientWidth;
    const H = this.viewport.clientHeight;
    this.renderer.setSize(W, H);
    const aspect = W / Math.max(1, H);
    this.camera.aspect = aspect;
    this.camera.updateProjectionMatrix();
    if (this.activeCamera) {
      this.activeCamera.aspect = aspect;
      this.activeCamera.updateProjectionMatrix();
    }
  }

  render() {
    this.renderer.render(this.scene, this.activeCamera || this.camera);
  }

  startLoop(tick: (dt: number) => void) {
    this._tick = tick;
    const loop = () => {
      requestAnimationFrame(loop);
      const dt = this.clock.getDelta();
      try {
        this._tick && this._tick(dt);
      } catch (e) {
        console.error(e);
      }
      this.render();
    };
    loop();
  }

  dispose() {
    window.removeEventListener("resize", this.onResize);
    this.renderer.dispose();
    if (this.renderer.domElement.parentElement) {
      this.renderer.domElement.parentElement.removeChild(this.renderer.domElement);
    }
  }
}
