/**
 * CanvasRoot 公共契约的类型层校验。
 *
 * 该文件由 `tsc --noEmit` 检查，不进入 Vitest 运行：验证 ports/slots
 * 全部必填，缺失成员或整个 prop 缺失都必须在类型层失败。
 */
import type { CanvasPorts, CanvasRootProps, CanvasSlots } from "@/features/canvas";
import { CanvasRoot } from "@/features/canvas";

const ports: CanvasPorts = {
  onOpenAssets() {},
  onOpenSettings() {},
  onOpenShortcuts() {},
  onOpenDirector() {},
};

const slots: CanvasSlots = {
  userMenu: () => null,
  assetBrowser: () => null,
  assetsDialog: () => null,
};

const valid: CanvasRootProps = { projectId: "p1", ports, slots };
const validElement = <CanvasRoot projectId="p1" ports={ports} slots={slots} />;

// @ts-expect-error ports 必填
const missingPorts: CanvasRootProps = { projectId: "p1", slots };

// @ts-expect-error slots 必填
const missingSlots: CanvasRootProps = { projectId: "p1", ports };

// @ts-expect-error CanvasPorts 成员全部必填
const incompletePorts: CanvasPorts = { onOpenAssets() {} };

// @ts-expect-error CanvasSlots 成员全部必填
const incompleteSlots: CanvasSlots = { userMenu: () => null };

// @ts-expect-error CanvasRoot 必填 ports
const missingPortsElement = <CanvasRoot projectId="p1" slots={slots} />;

// @ts-expect-error CanvasRoot 必填 slots
const missingSlotsElement = <CanvasRoot projectId="p1" ports={ports} />;

void valid;
void validElement;
void missingPorts;
void missingSlots;
void incompletePorts;
void incompleteSlots;
void missingPortsElement;
void missingSlotsElement;
