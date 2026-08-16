-- 删除 model_channels 表的 config 列（渠道高级配置已废弃，字段映射迁移至 provider-map.json）
ALTER TABLE "model_channels" DROP COLUMN "config";
