// 临时取证:从模型读取手臂/腿骨骼长轴(子骨 translation 主分量)=扭转轴;
// 再结合 worldQ 看前举/外展轴的世界方向,验证 jointConfig 原始 axis(y/z)是否正确。
import fs from "fs";
import path from "path";
import { Quaternion, Vector3 } from "three";
import { describe, it } from "vitest";

import { JOINTS } from "./joint-config";

const ASSETS = path.resolve(__dirname, "../../../../public/assets");
type GlbJson = { nodes: Array<{ name?: string; children?: number[]; rotation?: number[]; translation?: number[] }>; skins?: Array<{ joints: number[] }>; scenes?: Array<{ nodes: number[] }> };
function parseGlbJson(file: string): GlbJson {
  const buf = fs.readFileSync(path.join(ASSETS, file));
  const dv = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return JSON.parse(buf.toString("utf8", 20, 20 + dv.getUint32(12, true)));
}
function normBone(s: string): string {
  return (s || "").replace(/_+\d+$/i, "").replace(/[^a-z0-9]/gi, "").toLowerCase();
}
function detectSide(rl: string): "Left" | "Right" | "" {
  if (rl.includes("left")) return "Left";
  if (rl.includes("right")) return "Right";
  if (/^l[_\s.-]/.test(rl)) return "Left";
  if (/^r[_\s.-]/.test(rl)) return "Right";
  if (/(^|\s)l(\s|$)/.test(rl)) return "Left";
  if (/(^|\s)r(\s|$)/.test(rl)) return "Right";
  if (/_l($|_)/.test(rl)) return "Left";
  if (/_r($|_)/.test(rl)) return "Right";
  return "";
}
type PartBase = "Hips" | "Spine1" | "Head" | "Neck" | "Arm" | "ForeArm" | "Hand" | "UpLeg" | "Leg" | "Foot";
function detectPart(n: string): PartBase | null {
  if (n.includes("upleg") || n.includes("thigh")) return "UpLeg";
  if (n.includes("forearm") || n.includes("lowerarm")) return "ForeArm";
  if (n.includes("upperarm") || n.includes("arm")) return "Arm";
  if (n.includes("calf")) return "Leg";
  if (n.includes("leg")) return "Leg";
  if (n.includes("hand") && !/hand(index|thumb|middle|ring|pinky)/.test(n)) return "Hand";
  if (n.includes("foot") && !n.includes("ball")) return "Foot";
  if (n.includes("head") && !n.includes("headnub")) return "Head";
  if (n.includes("neck")) return "Neck";
  if (n.includes("spine1") || n.includes("spine01") || n.includes("spine02")) return "Spine1";
  if (n.includes("pelvis") || n.includes("hips")) return "Hips";
  return null;
}
function buildTokenToWorldQ(json: GlbJson): Map<string, Quaternion> {
  const nodes = json.nodes || [];
  const skins = json.skins || [];
  const rootIndices = (json.scenes?.[0]?.nodes) || [];
  const parentOf = new Map<number, number | null>();
  function walk(idx: number, parent: number | null) {
    parentOf.set(idx, parent);
    for (const c of nodes[idx]?.children || []) walk(c, idx);
  }
  for (const r of rootIndices) walk(r, null);
  const cache = new Map<number, Quaternion>();
  function worldQ(idx: number): Quaternion {
    if (cache.has(idx)) return cache.get(idx)!;
    const parent = parentOf.get(idx);
    const pw = parent != null ? worldQ(parent) : new Quaternion();
    const r = nodes[idx]?.rotation;
    const local = r ? new Quaternion(r[0], r[1], r[2], r[3]) : new Quaternion();
    const w = pw.clone().multiply(local);
    cache.set(idx, w);
    return w;
  }
  const out = new Map<string, Quaternion>();
  for (const idx of skins[0] ? skins[0].joints : []) {
    const name = nodes[idx]?.name || "";
    const side = detectSide(name.toLowerCase());
    const part = detectPart(normBone(name));
    if (!part) continue;
    const token = side + part;
    if (!out.has(token)) out.set(token, worldQ(idx));
  }
  return out;
}

describe("verify arm axes vs model", () => {
  it("Xbot LeftArm: long axis + world axes + jointConfig match", () => {
    const file = "Xbot.glb";
    const json = parseGlbJson(file);
    const mq = buildTokenToWorldQ(json);
    const q = mq.get("LeftArm")!;

    // 1. 本地轴世界方向
    const localAxes = { x: new Vector3(1,0,0).applyQuaternion(q), y: new Vector3(0,1,0).applyQuaternion(q), z: new Vector3(0,0,1).applyQuaternion(q) };
    process.stdout.write("Xbot LeftArm 本地轴世界方向:\n");
    for (const [k,v] of Object.entries(localAxes)) process.stdout.write(`  ${k}=(${v.x.toFixed(3)}, ${v.y.toFixed(3)}, ${v.z.toFixed(3)})\n`);

    // 2. 长轴(子骨 translation)
    const nodes = json.nodes;
    const foreIdx = nodes.findIndex((n) => normBone(n.name ?? "") === "mixamorigleftforearm");
    const t = nodes[foreIdx]?.translation;
    if (t) process.stdout.write(`LeftForeArm translation(相对LeftArm): [${t.map((n:number)=>n.toFixed(1))}]\n`);

    // 3. 前举(绕y)/外展(绕z)/扭转(绕x) 的世界方向 — 对比 jointConfig 原始值(y/z/x)
    const refY = new Vector3(0,1,0).applyQuaternion(q); // lArmFwd axis=y
    const refZ = new Vector3(0,0,1).applyQuaternion(q); // lArmAbd axis=z
    const refX = new Vector3(1,0,0).applyQuaternion(q); // lArmTwist axis=x
    process.stdout.write(`lArmFwd(axis=y)世界方向: (${refY.x.toFixed(3)}, ${refY.y.toFixed(3)}, ${refY.z.toFixed(3)})\n`);
    process.stdout.write(`lArmAbd(axis=z)世界方向: (${refZ.x.toFixed(3)}, ${refZ.y.toFixed(3)}, ${refZ.z.toFixed(3)})\n`);
    process.stdout.write(`lArmTwist(axis=x)世界方向: (${refX.x.toFixed(3)}, ${refX.y.toFixed(3)}, ${refX.z.toFixed(3)})\n`);

    // 判断:前举=绕世界Y(上下)使手前后摆;外展=绕世界Z(前后)使手上下摆
    // 本地y世界方向若接近 Z(前后) → 前举绕y = 手上下摆(外展语义)
    // 本地z世界方向若接近 Y(上下) → 外展绕z = 手前后摆(前举语义)
    // → 于是得交换y/z。但这需要验证 worldQ 准确。
    process.stdout.write(`\n结论:\n`);
    process.stdout.write(`  本地y世界近 Z(前后)程度: |z|=${Math.abs(Number(refY.z.toFixed(3)))}\n`);
    process.stdout.write(`  本地z世界近 Y(上下)程度: |y|=${Math.abs(Number(refZ.y.toFixed(3)))}\n`);
    process.stdout.write(`  lArmTwist(axis=x) 世界方向 = 长轴方向(子骨位移方向)\n`);
  });
});
