import * as THREE from "three";
import { describe, expect,it } from "vitest";

import { identifyBones } from "../director/util/bone-identify";

// 伪 model:traverse 依次吐出真正的 THREE.Bone 对象，通过 instanceof 检查。
function mockModel(names: string[]) {
  const bones = names.map((name) => {
    const bone = new THREE.Bone();
    bone.name = name;
    return bone;
  });
  return {
    traverse(cb: (o: THREE.Object3D) => void) {
      for (const bone of bones) cb(bone);
    },
  };
}

// jointConfig 需要的全部语义骨(15 个)
const EXPECTED = [
  "Hips", "Spine1", "Head",
  "LeftArm", "LeftForeArm", "LeftHand", "LeftUpLeg", "LeftLeg", "LeftFoot",
  "RightArm", "RightForeArm", "RightHand", "RightUpLeg", "RightLeg", "RightFoot",
];

// 三个真实 glb 实测骨名(含干扰骨:Spine/Spine2/手指/Toe 等应被忽略)
const XBOT = [
  "mixamorig:Hips", "mixamorig:Spine", "mixamorig:Spine1", "mixamorig:Spine2", "mixamorig:Neck", "mixamorig:Head",
  "mixamorig:LeftArm", "mixamorig:LeftForeArm", "mixamorig:LeftHand", "mixamorig:LeftHandIndex1",
  "mixamorig:LeftUpLeg", "mixamorig:LeftLeg", "mixamorig:LeftFoot", "mixamorig:LeftToeBase",
  "mixamorig:RightArm", "mixamorig:RightForeArm", "mixamorig:RightHand", "mixamorig:RightHandThumb1",
  "mixamorig:RightUpLeg", "mixamorig:RightLeg", "mixamorig:RightFoot", "mixamorig:RightToeBase",
];
const TESLA = [
  "mixamorig_Hips_01", "mixamorig_Spine_02", "mixamorig_Spine1_03", "mixamorig_Spine2_04", "mixamorig_Neck_05", "mixamorig_Head_06",
  "mixamorig_LeftArm_08", "mixamorig_LeftForeArm_09", "mixamorig_LeftHand_010", "mixamorig_LeftHandIndex1_014",
  "mixamorig_LeftUpLeg_045", "mixamorig_LeftLeg_046", "mixamorig_LeftFoot_047", "mixamorig_LeftToeBase_048",
  "mixamorig_RightArm_027", "mixamorig_RightForeArm_028", "mixamorig_RightHand_029", "mixamorig_RightHandThumb1_030",
  "mixamorig_RightUpLeg_00", "mixamorig_RightLeg_049", "mixamorig_RightFoot_050", "mixamorig_RightToeBase_051",
];
const UE = [
  "Bip001 Pelvis_03", "Bip001 Spine_04", "Bip001 Spine1_05", "Bip001 Neck_06", "Bip001 Head_055", "Bip001 HeadNub_056",
  "Bip001 L Clavicle_07", "Bip001 L UpperArm_08", "Bip001 L Forearm_09", "Bip001 L Hand_010", "Bip001 L Finger0_011",
  "Bip001 L Thigh_057", "Bip001 L Calf_058", "Bip001 L Foot_059", "Bip001 L Toe0_00",
  "Bip001 R Clavicle_031", "Bip001 R UpperArm_032", "Bip001 R Forearm_033", "Bip001 R Hand_034", "Bip001 R Finger0_035",
  "Bip001 R Thigh_061", "Bip001 R Calf_062", "Bip001 R Foot_063", "Bip001 R Toe0_064",
];

describe("identifyBones 自动识别", () => {
  it("Xbot: mixamo rig,15 语义骨全部命中,干扰骨忽略", () => {
    const { map, rig } = identifyBones(mockModel(XBOT) as unknown as Object3D);
    expect(rig).toBe("mixamo");
    for (const t of EXPECTED) expect(map.has(t), `缺失 ${t}`).toBe(true);
  });

  it("tesla_bot: mixamo 变体(带 _数字 后缀),15 语义骨全部命中", () => {
    const { map, rig } = identifyBones(mockModel(TESLA) as unknown as Object3D);
    expect(rig).toBe("mixamo");
    for (const t of EXPECTED) expect(map.has(t), `缺失 ${t}`).toBe(true);
  });

  it("ue-mannequin: biped rig(Bip001 命名),15 语义骨全部命中", () => {
    const { map, rig } = identifyBones(mockModel(UE) as unknown as Object3D);
    expect(rig).toBe("biped");
    for (const t of EXPECTED) expect(map.has(t), `缺失 ${t}`).toBe(true);
  });
});
