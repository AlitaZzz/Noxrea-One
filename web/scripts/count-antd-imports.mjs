#!/usr/bin/env node
/**
 * 统计各层对 antd 的直连情况，用于分层治理的进度基线。
 *
 * 用法：
 *   node scripts/count-antd-imports.mjs          输出汇总
 *   node scripts/count-antd-imports.mjs --list   附带文件清单
 *
 * 判定口径：文件中出现 `from 'antd'` 或 `from 'antd/...'` 即计为一次直连。
 * 核心领域（规范第九章）：canvas、agent、workflow、generation、node system、task state，
 * 当前代码里这些能力都落在 features/canvas 子树下，故以 features/canvas 作为核心口径。
 */

import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC_DIR = fileURLToPath(new URL('../src', import.meta.url));
const IMPORT_ANTD = /(?:^|[\s;])(?:import|export)[\s\S]*?from\s*['"]antd(?:\/[^'"]*)?['"]/m;

const CORE_PREFIXES = ['features/canvas'];

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...walk(full));
    } else if (/\.(ts|tsx)$/.test(entry)) {
      out.push(full);
    }
  }
  return out;
}

function isCore(relPath) {
  const normalized = relPath.split(sep).join('/');
  return CORE_PREFIXES.some((prefix) => normalized.startsWith(prefix));
}

function groupOf(relPath) {
  const normalized = relPath.split(sep).join('/');
  const [layer, module_] = normalized.split('/');
  if (layer === 'features') return `features/${module_ ?? '?'}`;
  return layer;
}

const files = walk(SRC_DIR)
  .map((full) => {
    const relPath = relative(SRC_DIR, full).split(sep).join('/');
    return { relPath, source: readFileSync(full, 'utf8') };
  })
  .filter(({ source }) => IMPORT_ANTD.test(source));

const groups = new Map();
for (const { relPath } of files) {
  const group = groupOf(relPath);
  const bucket = groups.get(group) ?? { total: 0, core: 0, files: [] };
  bucket.total += 1;
  if (isCore(relPath)) bucket.core += 1;
  bucket.files.push(relPath);
  groups.set(group, bucket);
}

const sorted = [...groups.entries()].sort((a, b) => b[1].total - a[1].total);
const total = files.length;
const core = files.filter(({ relPath }) => isCore(relPath)).length;
const showList = process.argv.includes('--list');

console.log('antd 直连统计');
console.log('='.repeat(48));
const featuresTotal = files.filter(({ relPath }) => relPath.startsWith('features/')).length;

console.log(`总计: ${total} 个文件    核心领域(features/canvas): ${core}`);
console.log(`业务层(features) 合计: ${featuresTotal}`);
console.log('-'.repeat(48));
for (const [group, bucket] of sorted) {
  console.log(`${group.padEnd(24)} ${String(bucket.total).padStart(3)}  核心 ${bucket.core}`);
}
console.log('-'.repeat(48));

if (showList) {
  for (const [group, bucket] of sorted) {
    console.log(`\n[${group}]`);
    for (const file of bucket.files.sort()) {
      console.log(`  ${isCore(file) ? '*' : ' '} ${file}`);
    }
  }
}
