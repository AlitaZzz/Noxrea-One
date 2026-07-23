import * as THREE from "three";
import { Entity } from "./Entity";

const PRIM_COLORS = [0x7ee787, 0xbc8cff, 0xffb066, 0x68d6c8, 0x4f8ef7, 0xf07b6b];
let _colorIdx = 0;

function stdMat(c: number) {
  return new THREE.MeshStandardMaterial({
    color: c,
    roughness: 0.52,
    metalness: 0.04,
  });
}

function buildMannequin(mat: THREE.MeshStandardMaterial): THREE.Group {
  const g = new THREE.Group();
  const add = (geo: THREE.BufferGeometry, x: number, y: number, z: number, rz?: number) => {
    const me = new THREE.Mesh(geo, mat);
    me.position.set(x, y, z);
    if (rz) me.rotation.z = rz;
    me.castShadow = true;
    g.add(me);
    return me;
  };
  const head = add(new THREE.SphereGeometry(0.135, 28, 28), 0, 1.64, 0);
  head.scale.set(0.92, 1.12, 1);
  add(new THREE.CylinderGeometry(0.052, 0.062, 0.1, 16), 0, 1.52, 0);
  add(new THREE.CylinderGeometry(0.2, 0.155, 0.4, 22), 0, 1.27, 0);
  add(new THREE.SphereGeometry(0.155, 22, 22), 0, 1.05, 0);
  add(new THREE.SphereGeometry(0.175, 22, 22), 0, 0.87, 0);
  add(new THREE.SphereGeometry(0.09, 16, 16), 0.23, 1.4, 0);
  add(new THREE.SphereGeometry(0.09, 16, 16), -0.23, 1.4, 0);
  for (const s of [1, -1]) {
    add(new THREE.CapsuleGeometry(0.05, 0.3, 6, 12), s * 0.29, 1.22, 0, s * 0.13);
    add(new THREE.CapsuleGeometry(0.044, 0.3, 6, 12), s * 0.355, 0.85, 0, s * 0.05);
    add(new THREE.SphereGeometry(0.052, 12, 12), s * 0.36, 0.66, 0);
    add(new THREE.SphereGeometry(0.105, 16, 16), s * 0.105, 0.8, 0);
    add(new THREE.CapsuleGeometry(0.07, 0.34, 6, 12), s * 0.115, 0.55, 0);
    add(new THREE.CapsuleGeometry(0.055, 0.34, 6, 12), s * 0.115, 0.16, 0);
    add(new THREE.BoxGeometry(0.1, 0.06, 0.24), s * 0.115, 0.0, 0.05);
  }
  return g;
}

function buildPrimitive(kind: string, mat: THREE.MeshStandardMaterial): THREE.Mesh {
  let geo: THREE.BufferGeometry, y: number;
  if (kind === "box") {
    geo = new THREE.BoxGeometry(0.8, 0.8, 0.8);
    y = 0.4;
  } else if (kind === "cylinder") {
    geo = new THREE.CylinderGeometry(0.4, 0.4, 1.2, 40);
    y = 0.6;
  } else {
    geo = new THREE.SphereGeometry(0.5, 40, 40);
    y = 0.5;
  }
  const me = new THREE.Mesh(geo, mat);
  me.position.y = y;
  me.castShadow = true;
  return me;
}

export class Prop extends Entity {
  kind: string;
  color: number;
  material: THREE.MeshStandardMaterial;
  mesh: THREE.Object3D;

  constructor(kind: "box" | "cylinder" | "sphere" | "mannequin", name: string) {
    const color = PRIM_COLORS[_colorIdx++ % PRIM_COLORS.length];
    const mat = stdMat(color);
    const root = new THREE.Group();
    const mesh = kind === "mannequin" ? buildMannequin(mat) : buildPrimitive(kind, mat);
    root.add(mesh);
    super("prop", name, root);
    this.kind = kind;
    this.color = color;
    this.material = mat;
    this.mesh = mesh;
  }

  setColor(hex: number) {
    const c = new THREE.Color(hex);
    this.root.traverse((n: any) => {
      if (n.isMesh) n.material.color.copy(c);
    });
    this.color = c.getHex();
  }
}
