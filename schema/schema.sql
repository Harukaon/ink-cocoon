-- ============================================================
-- 墨茧 InkCocoon · D1 数据库结构
-- 执行: npm run db:init
-- ============================================================

-- ---------- 世代（每天孵化出的一代） ----------
CREATE TABLE IF NOT EXISTS generations (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_no        INTEGER NOT NULL UNIQUE,          -- 第几代（第 1 篇文章 = 第 1 代）
  genome_id     TEXT NOT NULL,                    -- 本次孵化使用的基因组 id（GEN-xxxx）
  parent_gen    INTEGER,                          -- 父代 gen_no（第 1 代为 NULL）
  title         TEXT NOT NULL,
  summary       TEXT,
  body          TEXT NOT NULL,
  mood          TEXT,                             -- 情绪色（展厅节点染色用）
  open_line     TEXT,                             -- 文章开头句（给子代"回应"用）
  close_line    TEXT,                             -- 文章结尾句（传给子代"回应"用）
  fitness       REAL DEFAULT 0,                   -- 适应度 0~1
  reads         INTEGER DEFAULT 0,               -- 阅读数
  likes         INTEGER DEFAULT 0,               -- 点赞数
  dislikes      INTEGER DEFAULT 0,               -- 点踩数
  comments      INTEGER DEFAULT 0,               -- 评论数
  feeds         INTEGER DEFAULT 0,               -- 喂养次数
  avg_read_pct  REAL DEFAULT 0,                   -- 平均阅读进度 0~1
  cited_by      INTEGER DEFAULT 0,               -- 被后代引用次数
  status        TEXT NOT NULL DEFAULT 'published',-- published|dead_egg|hidden
  dead_reason   TEXT,                             -- 死卵原因
  created_at    TEXT NOT NULL,
  UNIQUE(created_at)
);

-- ---------- 基因组版本（每一次变异产生新版本） ----------
CREATE TABLE IF NOT EXISTS genomes (
  id          TEXT PRIMARY KEY,                   -- GEN-0001
  gen_no      INTEGER NOT NULL,                   -- 在第几代诞生
  genes_json  TEXT NOT NULL,                      -- 基因数组 JSON
  parent_id   TEXT,                               -- 父基因组 id
  created_at  TEXT NOT NULL
);

-- ---------- 变异日志 ----------
CREATE TABLE IF NOT EXISTS mutations (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_no      INTEGER NOT NULL,
  op          TEXT NOT NULL,                      -- WEAKEN|STRENGTHEN|REWRITE|CROSSOVER|SPONTANEOUS|DORMANT|WAKE
  gene_id     TEXT NOT NULL,
  from_value  TEXT,                               -- 原等位基因 / 权重
  to_value    TEXT,                               -- 新等位基因 / 权重
  reason      TEXT,                               -- 变异理由（LLM 给出或规则给出）
  created_at  TEXT NOT NULL
);

-- ---------- 反馈流（阅读行为 + 显式反馈 + 喂养） ----------
CREATE TABLE IF NOT EXISTS feedback (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_no      INTEGER NOT NULL,
  kind        TEXT NOT NULL,                      -- read|like|dislike|comment|feed|virtual
  payload     TEXT,                               -- 内容（评论原文 / 喂养的词 / 阅读进度）
  reader      TEXT,                               -- 匿名读者 id
  created_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_feedback_gen ON feedback(gen_no);

-- ---------- 引擎运行日志（孵化过程审计） ----------
CREATE TABLE IF NOT EXISTS engine_logs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  gen_no      INTEGER,
  stage       TEXT NOT NULL,                      -- digest|mutate|incubate|secrete|transcribe
  ok          INTEGER NOT NULL,                   -- 1 成功 0 失败
  detail      TEXT,
  created_at  TEXT NOT NULL
);

-- ---------- 系统状态（单行 KV 表） ----------
CREATE TABLE IF NOT EXISTS system_state (
  key         TEXT PRIMARY KEY,
  value       TEXT
);