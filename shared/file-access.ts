/**
 * 文件访问描述接口的共享契约（specs/storage-signed-direct-delivery.md 规则 2.8）。
 *
 * 批量上限只有这一份：服务端校验请求体、客户端切批都必须取同一个值。
 * 两处各写一份时，任何一次调整都会让一端先到边界、另一端仍按旧上限发批，
 * 表现为整批 400——这是契约，不是两端各自的实现细节。
 */

/** 单次 `POST /api/files/access` 的条目上限 */
export const FILE_ACCESS_BATCH_LIMIT = 50;
