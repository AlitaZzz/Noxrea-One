// 技能加载器：扫描 server/resources/skills/<name>/skill.md，解析 frontmatter。
// 每个技能是一个目录，目录内含 skill.md。模块加载时扫描一次并缓存（进程级）。

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { resolveFromRoot } from "../../../../core/paths";

export interface SkillMeta {
  /** 技能标识符：英文小写 + 连字符，用于调用与持久化 */
  name: string;
  /** 展示名：面向用户的中文名称 */
  displayTitle: string;
  description: string;
  category: string;
  appliesTo?: string[];
}

export interface Skill {
  meta: SkillMeta;
  content: string;
}

const SKILLS_DIR = resolveFromRoot("server/resources/skills");

let cache: Skill[] | null = null;

function scanSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`[skills] 技能目录不存在: ${SKILLS_DIR}`);
    return [];
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillFile = path.join(SKILLS_DIR, entry.name, "skill.md");
    if (!fs.existsSync(skillFile)) continue;

    try {
      const raw = fs.readFileSync(skillFile, "utf-8");
      const { data, content } = matter(raw);
      const name = (data.name as string) || entry.name;
      const meta: SkillMeta = {
        name,
        displayTitle: (data.display_title as string) || name,
        description: (data.description as string) || "",
        category: (data.category as string) || "未分类",
        appliesTo: Array.isArray(data.appliesTo) ? data.appliesTo : undefined,
      };
      skills.push({ meta, content: content.trim() });
    } catch (err) {
      console.error(`[skills] 读取技能失败: ${skillFile}`, err);
    }
  }

  return skills;
}

function getAll(): Skill[] {
  if (cache === null) cache = scanSkills();
  return cache;
}

/** 返回技能目录（不含正文），供前端 / 面板使用 */
export function listSkills(): SkillMeta[] {
  return getAll().map((s) => s.meta);
}

/** 按 name 取技能全文；找不到返回 null */
export function getSkill(name: string): Skill | null {
  return getAll().find((s) => s.meta.name === name) ?? null;
}
