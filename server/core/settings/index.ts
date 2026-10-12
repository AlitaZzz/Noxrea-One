/**
 * 系统设置：启动时把注册表中缺失的键以默认值写入 system_settings，
 * 随后读成进程内不可变快照，业务侧通过同步的 getSetting() 读取。
 * 运行期不回库、不读 env；修改库值后需重启生效（specs/system-settings-db.md）。
 */
import { prisma } from "@server/core/database/client";
import { logEvent } from "@server/core/logger/utils";
import { SETTING_DEFS, type SettingKey, type SettingValue } from "./registry";

type Snapshot = { readonly [K in SettingKey]: SettingValue<K> };

let snapshot: Snapshot | null = null;

/** 幂等：补齐缺失键 → 按注册表校验并读入快照。库中值非法时启动失败并指明键名。 */
export async function initSettings(): Promise<void> {
  if (snapshot) return;

  const keys = Object.keys(SETTING_DEFS) as SettingKey[];

  const stored = new Map((await prisma.systemSetting.findMany()).map((r) => [r.key, r.value]));
  const missing = keys.filter((key) => !stored.has(key));
  if (missing.length > 0) {
    // upsert + 空 update = 「不存在才写入」，已有记录绝不覆盖
    await prisma.$transaction(
      missing.map((key) =>
        prisma.systemSetting.upsert({
          where: { key },
          update: {},
          create: { key, value: String(SETTING_DEFS[key].default) },
        }),
      ),
    );
    for (const key of missing) stored.set(key, String(SETTING_DEFS[key].default));
    logEvent("settings", { stage: "seeded", keys: missing });
  }

  const values: Record<string, unknown> = {};
  const issues: string[] = [];
  for (const key of keys) {
    const parsed = SETTING_DEFS[key].schema.safeParse(stored.get(key));
    if (parsed.success) values[key] = parsed.data;
    else issues.push(`  - ${key}: ${parsed.error.issues.map((i) => i.message).join("; ")}`);
  }
  if (issues.length > 0) {
    throw new Error(`Invalid system settings:\n${issues.join("\n")}`);
  }

  snapshot = Object.freeze(values) as Snapshot;
}

export function getSetting<K extends SettingKey>(key: K): SettingValue<K> {
  if (!snapshot) {
    throw new Error(`System settings are not initialized (reading "${key}"); call bootstrap() first`);
  }
  return snapshot[key];
}

export type { SettingKey, SettingValue };
