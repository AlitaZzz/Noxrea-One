/**
 * 业务代码依赖的 PostgreSQL 唯一索引名（定义于 prisma/migrations）。
 *
 * adapter-pg 的 P2002 只暴露索引名（见 errors.ts）。索引改名必须同步迁移、此处
 * 与所有调用方；真实库测试有意使用字面量，以锁定数据库中的实际索引名。
 */

/** users.username @unique（迁移 20261015061549_baseline） */
export const USERS_USERNAME_KEY = "users_username_key";

/** asset_folders(user_id, scope) WHERE kind = 'uncategorized'（迁移 20261015213000_uncategorized_unique） */
export const ASSET_FOLDERS_UNCATEGORIZED_KEY = "asset_folders_uncategorized_key";

/** asset_items(user_id, scope, file_key)（迁移 20261016090045_storage_reference_keys） */
export const ASSET_ITEMS_USER_SCOPE_FILE_KEY = "asset_items_user_id_scope_file_key_key";
