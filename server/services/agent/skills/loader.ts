/**
 * 技能加载器。
 * 扫描 server/resources/skills/<name>/skill.md 并解析 frontmatter，
 * 模块加载时扫描一次并缓存为进程级技能元数据。
 *
 * 本文件属于 agent 模块，与 capabilities/llm（前端 text 节点纯文本能力）完全解耦。
 */

import fs from "fs";
import path from "path";
import matter from "gray-matter";
import { resolveFromRoot } from "../../../core/paths";

export interface SkillMeta {
  /** 技能标识符：英文小写 + 连字符，用于调用与持久化 */
  name: string;
  /** 展示名：面向用户的中文名称 */
  displayTitle: string;
  description: string;
  category: string;
  appliesTo?: string[];
  /**
   * 该技能需要注入给 LLM 的工具白名单（引用已注册 tool 名，非内联 schema）。
   * 为空或省略表示注入全部已注册工具（兜底行为）。
   */
  tools?: string[];
}

export interface Skill {
  meta: SkillMeta;
  content: string;
}

const SKILLS_DIR = resolveFromRoot("server/resources/skills");

let cache: Skill[] | null = null;

/**
 * 扫描技能目录下的 references/ 子目录，将所有 .md 文件内容内联拼接到正文末尾。
 *
 * 这样 skill.md 可以通过 `references/xxx.md` 引用拆分文件，
 * loader 会在加载时自动合并，LLM 收到的是完整的单段 system prompt。
 *
 * 支持嵌套子目录（如 references/camera/abc.md），按相对路径排序保证确定性。
 */
function loadReferences(skillDir: string): string {
  const refDir = path.join(skillDir, "references");
  if (!fs.existsSync(refDir)) return "";

  const files = collectMarkdownFiles(refDir);
  if (files.length === 0) return "";

  const parts: string[] = [];
  for (const absPath of files) {
    const relPath = path.relative(skillDir, absPath).replace(/\\/g, "/");
    try {
      const body = fs.readFileSync(absPath, "utf-8").trim();
      parts.push(`\n\n---\n<!-- references/${relPath} -->\n${body}`);
    } catch {
      // 单个文件读取失败不阻断其余文件
    }
  }
  return parts.join("");
}

/** 递归收集目录下所有 .md 文件路径（排序保证确定性） */
function collectMarkdownFiles(dir: string): string[] {
  const results: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  // 先文件后目录，各自按名称排序
  const files = entries.filter((e) => e.isFile() && e.name.endsWith(".md")).sort((a, b) => a.name.localeCompare(b.name));
  const subdirs = entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name));

  for (const f of files) {
    results.push(path.join(dir, f.name));
  }
  for (const d of subdirs) {
    results.push(...collectMarkdownFiles(path.join(dir, d.name)));
  }
  return results;
}

function scanSkills(): Skill[] {
  if (!fs.existsSync(SKILLS_DIR)) {
    console.error(`[skills] 技能目录不存在: ${SKILLS_DIR}`);
    return [];
  }

  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true });
  const skills: Skill[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillDir = path.join(SKILLS_DIR, entry.name);
    const skillFile = path.join(skillDir, "skill.md");
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
        tools: Array.isArray(data.tools) ? data.tools : undefined,
      };

      // 自动内联 references/ 子目录下的所有 .md 文件
      const fullContent = content.trim() + loadReferences(skillDir);

      skills.push({ meta, content: fullContent });
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
