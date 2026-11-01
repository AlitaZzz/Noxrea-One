/**
 * 画布选中态写入。
 *
 * 选中态存放在节点/边自身（`selected`）上，与画布文档同源，任何选中变更都要
 * 写回 store。受控 React Flow 只有在节点对象引用未变时才复用内部实例
 * （@xyflow/system adoptUserNodes 的 checkEquality）：整表 map 克隆会把一次
 * 点选放大成整画布节点的内部重建，节点越多越慢，工具条只能等整轮提交完成。
 *
 * 因此所有选中写入统一走本模块：updateSelection 只克隆选中态真正变化的条目，
 * 无变化时返回入参数组本身；applySelection 在其上完成「有变化才写入」，
 * 选区未变（例如重复点击已选中的唯一节点）不产生任何重渲染。
 */

/**
 * 只克隆选中态发生变化的条目；无变化时返回入参数组本身（引用相等），
 * 调用方据此跳过 store 写入。
 */
export function updateSelection<T extends { selected?: boolean }>(
  items: T[],
  isSelected: (item: T) => boolean,
): T[] {
  let changed = false;
  const next = items.map((item) => {
    const selected = isSelected(item);
    if ((item.selected === true) === selected) return item;
    changed = true;
    return { ...item, selected } as T;
  });
  return changed ? next : items;
}

/**
 * 写入选中态：确有变化时才调用 write，并返回是否写入。
 * 「先比较、再写回」是所有选中入口共用的规则，调用方不再各自复制判空。
 */
export function applySelection<T extends { selected?: boolean }>(
  items: T[],
  isSelected: (item: T) => boolean,
  write: (next: T[]) => void,
): boolean {
  const next = updateSelection(items, isSelected);
  if (next === items) return false;
  write(next);
  return true;
}
