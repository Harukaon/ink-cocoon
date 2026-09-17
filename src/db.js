// ============================================================
// 墨茧 InkCocoon · src/db.js
// D1 数据库访问层
// ============================================================

export function nowISO() {
  return new Date().toISOString();
}

/** 生成 GEN-XXXX 编号（基于自增序号，4 位补零） */
export function genomeId(n) {
  return 'GEN-' + String(n).padStart(4, '0');
}

/** 读取系统状态 */
export async function getState(env, key, fallback = null) {
  const row = await env.DB
    .prepare('SELECT value FROM system_state WHERE key = ?')
    .bind(key)
    .first();
  return row ? row.value : fallback;
}

/** 写入系统状态 */
export async function setState(env, key, value) {
  await env.DB
    .prepare(
      `INSERT INTO system_state (key, value) VALUES (?, ?)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value`
    )
    .bind(key, String(value))
    .run();
}

/** 当前基因组指针 */
export async function getCurrentGenomeId(env) {
  return (await getState(env, 'current_genome', 'GEN-0001')) || 'GEN-0001';
}

/** 下一个可用基因组编号（按已有 GEN-XXXX 最大值递增） */
export async function nextGenomeNo(env) {
  const row = await env.DB
    .prepare(`SELECT MAX(CAST(SUBSTR(id, 5) AS INTEGER)) AS n FROM genomes WHERE id LIKE 'GEN-%'`)
    .first();
  return (Number(row?.n) || 0) + 1;
}

/** 最新已发布代号（没有则为 0） */
export async function latestGenNo(env) {
  const row = await env.DB
    .prepare(`SELECT MAX(gen_no) AS g FROM generations WHERE status = 'published'`)
    .first();
  return row?.g || 0;
}

/** 取基因组（含解析后的 genes） */
export async function getGenome(env, id) {
  const row = await env.DB
    .prepare('SELECT * FROM genomes WHERE id = ?')
    .bind(id)
    .first();
  if (!row) return null;
  return { ...row, genes: JSON.parse(row.genes_json) };
}

/** 写入新基因组 */
export async function insertGenome(env, { id, genNo, genes, parentId, createdAt }) {
  await env.DB
    .prepare('INSERT INTO genomes (id, gen_no, genes_json, parent_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(id, genNo, JSON.stringify(genes), parentId, createdAt || nowISO())
    .run();
}

/** 写入变异日志（可批量） */
export async function insertMutations(env, genNo, list) {
  if (!list || !list.length) return;
  const stmt = env.DB.prepare(
    'INSERT INTO mutations (gen_no, op, gene_id, from_value, to_value, reason, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
  );
  for (const m of list) {
    await stmt
      .bind(
        genNo,
        m.op,
        m.gene_id || m.geneId || '',
        m.from_value ?? m.from ?? '',
        m.to_value ?? m.to ?? '',
        m.reason || '',
        nowISO()
      )
      .run();
  }
}

/** 写入一篇世代文章 */
export async function insertGeneration(env, g) {
  const values = [
    g.gen_no ?? 0,
    g.genome_id ?? 'GEN-UNKNOWN',
    g.parent_gen ?? null,
    g.title ?? '',
    g.summary ?? '',
    g.body ?? '',
    g.mood ?? 'amber',
    g.open_line ?? '',
    g.close_line ?? '',
    g.status ?? 'published',
    g.dead_reason ?? null,
    g.created_at ?? nowISO(),
  ];
  await env.DB
    .prepare(
      `INSERT INTO generations
        (gen_no, genome_id, parent_gen, title, summary, body, mood, open_line, close_line,
         status, dead_reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(...values)
    .run();
}

/** 记录死卵（同一代重复失败时更新，不再触发 gen_no 唯一约束） */
export async function recordDeadEgg(env, genNo, reason) {
  const existing = await env.DB
    .prepare('SELECT status FROM generations WHERE gen_no = ?')
    .bind(genNo)
    .first();
  if (existing?.status === 'dead_egg') {
    await env.DB
      .prepare('UPDATE generations SET dead_reason = ?, created_at = ? WHERE gen_no = ?')
      .bind(String(reason || '').slice(0, 2000), nowISO(), genNo)
      .run();
    return;
  }
  if (existing) return; // 已成功发布，不用死卵覆盖
  await env.DB
    .prepare(
      `INSERT INTO generations
        (gen_no, genome_id, parent_gen, title, body, status, dead_reason, created_at)
       VALUES (?, ?, ?, ?, ?, 'dead_egg', ?, ?)`
    )
    .bind(genNo, 'GEN-DEAD', null, `第 ${genNo} 代 · 死卵`, '', String(reason || '').slice(0, 2000), nowISO())
    .run();
}

/** 记录引擎日志 */
export async function logStage(env, genNo, stage, ok, detail) {
  await env.DB
    .prepare('INSERT INTO engine_logs (gen_no, stage, ok, detail, created_at) VALUES (?, ?, ?, ?, ?)')
    .bind(genNo, stage, ok ? 1 : 0, (detail || '').slice(0, 2000), nowISO())
    .run();
}

/** 近 N 代已发布文章 */
export async function recentGenerations(env, n = 7) {
  const rs = await env.DB
    .prepare(
      `SELECT gen_no, genome_id, title, summary, open_line, close_line, mood, fitness, created_at
       FROM generations WHERE status = 'published' ORDER BY gen_no DESC LIMIT ?`
    )
    .bind(n)
    .all();
  return rs.results || [];
}

/** 取某一世代的完整数据 */
export async function getGeneration(env, genNo) {
  return await env.DB
    .prepare('SELECT * FROM generations WHERE gen_no = ?')
    .bind(genNo)
    .first();
}

/** 近 N 代反馈 */
export async function recentFeedback(env, n = 7) {
  const rs = await env.DB
    .prepare(
      `SELECT f.gen_no, f.kind, f.payload, f.created_at
       FROM feedback f
       WHERE f.gen_no IN (SELECT gen_no FROM generations WHERE status='published' ORDER BY gen_no DESC LIMIT ?)
       ORDER BY f.id DESC LIMIT 200`
    )
    .bind(n)
    .all();
  return rs.results || [];
}

/** 获取所有存活基因（含权重） */
export function activeGenes(genome) {
  return (genome?.genes || []).filter((g) => (g.status || 'active') !== 'dormant');
}

/** 更新某世代的行为计数（阅读/点赞等） */
export async function bumpGenerationCounters(env, genNo, fields) {
  const sets = [];
  const vals = [];
  for (const [k, delta] of Object.entries(fields)) {
    sets.push(`${k} = ${k} + ?`);
    vals.push(delta);
  }
  vals.push(genNo);
  await env.DB
    .prepare(`UPDATE generations SET ${sets.join(', ')} WHERE gen_no = ?`)
    .bind(...vals)
    .run();
}
/** 引擎日志（最近 N 条） */
export async function recentEngineLogs(env, n = 80) {
  const rs = await env.DB
    .prepare('SELECT gen_no, stage, ok, detail, created_at FROM engine_logs ORDER BY id DESC LIMIT ?')
    .bind(n)
    .all();
  return rs.results || [];
}

/** 变异日志（最近 N 条，跨代） */
export async function recentMutations(env, n = 80) {
  const rs = await env.DB
    .prepare('SELECT gen_no, op, gene_id, from_value, to_value, reason, created_at FROM mutations ORDER BY id DESC LIMIT ?')
    .bind(n)
    .all();
  return rs.results || [];
}

/** 死卵列表 */
export async function deadEggs(env, n = 30) {
  const rs = await env.DB
    .prepare(
      `SELECT gen_no, dead_reason, created_at FROM generations
       WHERE status = 'dead_egg' ORDER BY gen_no DESC LIMIT ?`
    )
    .bind(n)
    .all();
  return rs.results || [];
}

/** 最近一次运行的整体成败（用于首页"引擎最近一次完整行程"状态） */
export async function lastRunSummary(env) {
  const rows = (await env.DB
    .prepare(
      `SELECT gen_no, stage, ok, detail, created_at FROM engine_logs
       ORDER BY id DESC LIMIT 12`
    )
    .all()).results || [];
  if (!rows.length) return null;
  const genNo = rows[0].gen_no;
  const run = rows.filter((r) => r.gen_no === genNo);
  const fatal = run.find((r) => !r.ok);
  const ok = run.some((r) => r.stage === 'transcribe' && r.ok === 1);
  const running = run.some((r) => r.stage === 'digest')
    && !run.some((r) => ['secrete', 'fatal'].includes(r.stage));
  return {
    gen_no: genNo,
    running,
    ok,
    fatal: fatal ? { stage: fatal.stage, detail: fatal.detail } : null,
    stages: dedupeStages(run),
  };
}

function okAll(run) {
  return run.some((r) => r.stage === 'transcribe' && r.ok === 1);
}

function dedupeStages(run) {
  const seen = {};
  for (const r of run) {
    if (!seen[r.stage]) seen[r.stage] = { stage: r.stage, ok: r.ok === 1, detail: r.detail, at: r.created_at };
  }
  return ['digest', 'mutate', 'incubate', 'secrete', 'transcribe', 'fatal']
    .filter((s) => seen[s])
    .map((s) => seen[s]);
}
