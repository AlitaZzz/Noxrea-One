/**
 * 字段映射引擎。
 * 提供嵌套路径移动、数组赋值、数组展开与字段删除四种映射语法。
 */

/**
 * 通用映射引擎，支持四种语法：
 *   - "source": "target.dot.path" — 嵌套路径移动
 *   - "source": "arr[]" — 数组直接赋值（key 保持原名）
 *   - "source": "xxx[].nested" — 数组展开（每个元素包装为 {nested: elem}，路径中 xxx 为任意数组名）
 *   - "source": null — 删除字段
 *
 * @param body 输入参数
 * @param mapping 映射规则表（{ fromKey: toPath | null }）
 */
export function applyMapping(
  body: Record<string, unknown>,
  mapping: Record<string, unknown> | null | undefined
): Record<string, unknown> {
  if (!mapping) return body;

  const result: Record<string, unknown> = {};
  const moved = new Set<string>();

  for (const [fromKey, toSpec] of Object.entries(mapping)) {
    // null → 删除
    if (toSpec === null || toSpec === undefined) {
      moved.add(fromKey);
      continue;
    }

    const toPath = String(toSpec);
    const value = body[fromKey];

    if (value === undefined) {
      moved.add(fromKey);
      continue;
    }

    // arr[] — 数组直接赋值（如 "ref_images": "arr[]" 表示保持原名，直接赋值数组）
    if (toPath === "arr[]") {
      result[fromKey] = value;
      moved.add(fromKey);
      continue;
    }

    // xxx[].nested — 数组展开（如 "ref_images": "images[].image_url"）
    // 匹配 "xxx[].yyy" 模式
    const arrExpandMatch = toPath.match(/^(\w+)\[\]\.(.+)$/);
    if (arrExpandMatch) {
      const arrName = arrExpandMatch[1]; // "images"
      const nestedPath = arrExpandMatch[2]; // "image_url"
      if (Array.isArray(value)) {
        setNested(result, `${arrName}`, value.map((item) => ({ [nestedPath]: item })));
      }
      moved.add(fromKey);
      continue;
    }

    // target.dot.path — 嵌套路径移动
    setNested(result, toPath, value);
    moved.add(fromKey);
  }

  // 保留未映射的字段
  for (const [key, val] of Object.entries(body)) {
    if (!moved.has(key)) {
      result[key] = val;
    }
  }

  return result;
}

function setNested(d: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split(".");
  let current: Record<string, unknown> = d;
  for (let i = 0; i < parts.length - 1; i++) {
    const part = parts[i];
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }
    current = current[part] as Record<string, unknown>;
  }
  current[parts[parts.length - 1]] = value;
}
