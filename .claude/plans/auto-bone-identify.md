# 自动识别 GLB 骨骼(L1 + L3)方案

## 目标
让任意常见 rig 的 GLB 自动接入姿势系统,不再写死 `mixamorig:` 骨名。覆盖 mixamo(含命名变体)/ Biped / UE mannequin 三类。

## 现状(已取证)
- `jointConfig.ts` 30 条关节,`bone` 字段硬编码 `mixamorig:xxx`
- `Character.ts:73-79` 构造时 `findBone(bones, j.bone)` 按 mixamorig 名查表,查不到 `if (!bone) continue` 静默跳过 -> `bonesUsed` 空 -> `applyPose` 空转 = 姿势失效(但模型能显示)
- `applyPose()`(Character.ts:122-139)读 `j.axis` / `j.sign`(按 mixamo 校准)
- `posePresets.ts` 用 `jointConfig` 的 `key`(`lArmAbd`/`headX`/`lKnee`),**与骨名无关 -> 不受影响**
- 实测骨名:
  - Xbot:`mixamorig:Head`(标准 mixamo,命中)
  - tesla_bot:`mixamorig_Head_06`(mixamo + `_<数字>` 后缀,norm 后多 06,miss)
  - ue-mannequin:`Bip001 Head_055`(3ds Max Biped,完全异构,miss)

## 架构:语义 token + 识别层 + rig 轴向覆盖

### 1. 语义 token(jointConfig.bone 改造)
`bone` 字段从 `mixamorig:Head` 改为语义 token:`hips` / `spine1` / `head` / `leftArm` / `leftForeArm` / `leftHand` / `leftUpLeg` / `leftLeg` / `leftFoot` + 右侧(共 ~15 个)。`key`/`axis`/`sign`/`min`/`max` 不变。

### 2. 识别层(新增 `director/util/boneIdentify.ts`)
```
identifyBones(model): { map: Map<token, Bone>, rig: RigType }
```
- 归一化:去非字母数字 + 转小写 + **去末尾 `_<数字>` 后缀**(`mixamorig_Head_06` -> `mixamorighead`)
- 关键词字典:每语义一组别名
  - head:[head] / neck:[neck] / spine1:[spine1] / hips:[hips, pelvis]
  - arm:[arm, upperarm] / forearm:[forearm, lowerarm] / hand:[hand]
  - upleg:[upleg, thigh] / leg:[leg, calf(注意 calf 是小腿,需和 knee 区分)] / foot:[foot]
  - 左右识别:l / left / `l`前缀 或 `_l`后缀 -> left;反之 right
- rig 类型识别:含 `mixamorig`->mixamo;含 `bip001`->biped;含 `_l/_r` 小写后缀且无前两者->ue;否则 unknown
- 冲突优先级:Spine1 优先于 Spine/Spine2;Toe/Nub/Finger 等次要骨忽略

### 3. rig 轴向覆盖(新增 `director/util/rigAxisTable.ts`)
```
RIG_AXIS: Partial<Record<RigType, Partial<Record<token, { axis, sign }>>>>
```
- mixamo:空对象(用 jointConfig 默认值 = 现有 mixamo 校准值,Xbot/tesla_bot 直接正确)
- biped:待实测校准的 axis/sign(架构就绪,值先占位继承 mixamo)
- Character.applyPose 改造:
```ts
const o = RIG_AXIS[rig]?.[j.bone];
const axis = o?.axis ?? j.axis;
const sign = o?.sign ?? j.sign ?? 1;
```

## 改动文件
| 文件 | 改动 |
|---|---|
| 新增 `director/util/boneIdentify.ts` | `identifyBones` + 关键词字典 + rig 识别 + 冲突优先级 |
| 新增 `director/util/rigAxisTable.ts` | per-rig 轴向覆盖表 + `RigType` 类型 |
| 改 `director/entities/jointConfig.ts` | `bone` 字段 `mixamorig:xxx` -> 语义 token(30 条) |
| 改 `director/entities/Character.ts` | 构造用 `identifyBones` 替代 `findBone`;存 `this.rig`;`applyPose` 接 rig 轴向覆盖 |
| 不动 `director/entities/posePresets.ts` | key 不变,预设照常 |
| 不动 `director/util/boneUtil.ts` | `norm`/`findBone` 保留(Xbot 兼容 + 识别层内部复用 norm) |

## 分阶段交付
- **阶段 1(L1)**:识别层 + 语义 token 改造。完成即可让 **tesla_bot**(同 mixamo rig)姿势预设直接可用;**Xbot** 回归不变。
- **阶段 2(L3)**:rig 轴向覆盖机制 + biped 占位表。**ue-mannequin** 骨骼能识别命中;**biped 具体 axis/sign 值需浏览器实测校准**(架构就绪,先以 mixamo 值占位,姿势会动但可能扭,再逐关节校准)。

## 风险 / 边界
- 单个骨识别失败:该关节跳过(同现状),不崩溃
- 脊柱多骨(Spine/Spine1/Spine2)冲突:字典优先级处理
- ue-mannequin 轴向未校准前姿势会扭(动但方向可能错,不是失效)
- 动画 clip(走/跑)跨 rig 仍不可用(retarget 不在本次范围,仅摆姿自动)
- 识别层对未知 rig 命中率不保证,L2(几何启发式)/L4(校准 UI)为后续扩展点

## 验证步骤
1. **Xbot 回归**:加载 + 逐个姿势预设,行为与改造前完全一致
2. **tesla_bot**:加载 + 切姿势预设,正常摆姿(阶段 1 即可验)
3. **ue-mannequin**:加载 + 切姿势预设,骨骼命中(姿势可能扭,待 L3 校准)
4. 控制台打印 `identifyBones` 结果:确认 rig 类型 + 命中关节数 / 总数
