-- ============================================================
-- 墨茧 InkCocoon · 创世 DNA（第 0 号基因组，GEN-0001 的种子）
-- 执行: npm run genesis
-- ============================================================

-- 创世基因组（第 0 代诞生，供第 1 代孵化使用）
INSERT INTO genomes (id, gen_no, genes_json, parent_id, created_at)
VALUES ('GEN-0001', 0, '[...]',
        NULL,
        datetime('now'))
ON CONFLICT(id) DO NOTHING;

-- 写入系统状态：当前基因组指针
INSERT INTO system_state (key, value)
VALUES ('current_genome', 'GEN-0001')
ON CONFLICT(key) DO UPDATE SET value = 'GEN-0001';

-- 说明：genes_json 中的 '[...]' 为占位符。
-- 请在部署后通过管理接口写入完整基因 JSON：
--   curl -X POST https://<worker>/api/admin/genesis \
--     -H "Authorization: Bearer <ADMIN_TOKEN>" \
--     -d @schema/genesis.json
-- genesis.json 与代码库中的 schema/genesis.json 内容一致，二选一即可。