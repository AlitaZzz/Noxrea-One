/**
 * 群众实体（角色阵列）。
 * 以行列排布批量管理多个角色成员，整体作为单个实体参与选择与变换。
 */
import * as THREE from "three";

import type { Character } from "./character";

let _seq = 0;

export class Crowd {
  id: string;
  type = "crowd" as const;
  name: string;
  root: THREE.Group;
  members: Character[];
  visible = true;
  baseScale = 1;
  rows?: number;
  cols?: number;

  constructor(
    name: string,
    root: THREE.Group,
    members: Character[],
    meta: { rows?: number; cols?: number; spacing?: number } = {}
  ) {
    this.id = "crowd" + ++_seq;
    this.name = name;
    this.root = root;
    this.members = members;
    this.rows = meta.rows;
    this.cols = meta.cols;
    root.userData.entityId = this.id;
  }

  get color(): number { return this.members[0]?.color ?? 0x4f8ef7; }
  setColor(hex: number) { this.members.forEach((m) => { if (m.type !== "camera") m.setColor(hex); }); }

  setVisible(v: boolean) {
    this.visible = v;
    this.root.visible = v;
    this.members.forEach((m) => { m.visible = v; });
  }

  dispose() { this.members.forEach((m) => m.dispose()); }
}
