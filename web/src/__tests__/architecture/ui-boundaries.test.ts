import { fileURLToPath } from "node:url";

import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const eslint = new ESLint({ cwd: fileURLToPath(new URL("../../../", import.meta.url)) });
const canvasFile = "src/features/canvas/nodes/NodeToolbar.tsx";

async function violations(code: string, filePath = canvasFile) {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.filter((message) => message.ruleId === "no-restricted-syntax" || message.ruleId === "boundaries/dependencies");
}

describe("UI architecture constraints", () => {
  it.each([
    'import { Button } from "antd"; export default Button;',
    'import { App as AntApp } from "antd"; export default AntApp;',
    'import Ant from "antd"; export default Ant;',
    'import * as Ant from "antd"; export default Ant.Button;',
    'import Button from "antd/es/button"; export default Button;',
    'import type { MenuProps } from "antd"; export type Props = MenuProps;',
    'import { DeleteOutlined } from "@ant-design/icons"; export default DeleteOutlined;',
    'import { Trash2 } from "lucide-react"; export default Trash2;',
    'import { GroupIcon } from "@/components/ui/icons/canvas/GroupIcon"; export default GroupIcon;',
    'export { Button } from "antd";',
    'export * from "antd/es/button";',
    'export { Trash2 } from "lucide-react";',
    'const ui = import("antd"); export default ui;',
    'const icon = import("lucide-react"); export default icon;',
    'const ui = require("antd/lib/button"); export default ui;',
    'const icon = require("@ant-design/icons"); export default icon;',
    'const icon = require("lucide-react"); export default icon;',
    'const icon = require("@/components/ui/icons/canvas/GroupIcon"); export default icon;',
    'const icon = require("./icon.svg"); export default icon;',
    'export type Props = import("antd").MenuProps;',
    'export default function View() { return <div className="ant-input" />; }',
    'export default function View() { return <div className={"field ant-input"} />; }',
  ])("rejects a core UI implementation dependency: %s", async (code) => {
    expect(await violations(code)).not.toHaveLength(0);
  });

  it.each([
    'import { useAppFeedback } from "@/components/ui/use-app-feedback"; export default useAppFeedback;',
    'import { Button } from "@/components/ui/button"; export default Button;',
    'import { DeleteIcon } from "@/components/ui/AppIcon"; export default DeleteIcon;',
  ])("allows project feedback and controls: %s", async (code) => {
    expect(await violations(code)).toHaveLength(0);
  });

  it("allows third-party UI inside its implementation layer", async () => {
    const code = 'import { Button } from "antd"; export default Button;';
    expect(await violations(code, "src/components/ui/Button.tsx")).toHaveLength(0);
  });

  it("allows icon implementations inside the UI layer", async () => {
    const code = 'import { Trash2 } from "lucide-react"; export default Trash2;';
    expect(await violations(code, "src/components/ui/AppIcon.tsx")).toHaveLength(0);
  });

  it.each(["src/features/settings/ApiSettingsModels.tsx", "src/features/auth/store.ts", "src/app/page.tsx", "src/hooks/use-feedback.ts", "src/lib/feedback.ts", "src/providers/AppProviders.tsx"])("protects all business directories: %s", async (filePath) => {
    expect(await violations('import { App } from "antd"; export default App;', filePath)).not.toHaveLength(0);
  });

  it.each(["src/lib/model-store.ts", "src/components/ui/dialog.tsx"])("rejects reverse dependencies from %s", async (filePath) => {
    expect(await violations('import { useAuthStore } from "@/features/auth/store"; export default useAuthStore;', filePath))
      .toEqual(expect.arrayContaining([expect.objectContaining({ ruleId: "boundaries/dependencies" })]));
  });
});
