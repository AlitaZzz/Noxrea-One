/**
 * 测试用系统设置替身：默认值取自真实注册表，测试按需覆盖单项。
 * 用法：vi.mock("@server/core/settings", async () => (await import("<相对路径>/helpers/settings")).settingsModuleMock());
 */
import { SETTING_DEFS, type SettingKey, type SettingValue } from "@server/core/settings/registry";

const current: Record<string, unknown> = {};

export function resetTestSettings(
  overrides: { [K in SettingKey]?: SettingValue<K> } = {},
): void {
  for (const key of Object.keys(current)) delete current[key];
  for (const [key, def] of Object.entries(SETTING_DEFS)) current[key] = def.default;
  Object.assign(current, overrides);
}

resetTestSettings();

export function settingsModuleMock() {
  return {
    getSetting: (key: SettingKey) => current[key],
  };
}
