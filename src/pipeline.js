// ============================================================
// 墨茧 InkCocoon · src/pipeline.js
// 每日进化流水线：反刍 → 变异 → 孵化 → 分泌 → 刻录
// 一次 scheduled() 触发 = 一代的完整进化
// ============================================================

import { chat, parseJsonLoose, llmConfig } from './llm.js';
import * as db from './db.js';
import { snapshotToGithub } from './gh.js';

const DAY_MS = 24 * 60 * 60 * 1000;

/** 北京时间 YYYY-MM-DD（UTC+8，不受部署地域影响） */
function beijingDate(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 60 * 60 * 1000 + offsetDays * DAY_MS);
  return d.toISOString().slice(0, 10);
}

/** 词级 Jaccard 相似度（新颖度兜底算法，不依赖 embedding 接口） */
function jaccard(a, b) {
  const A = new Set(String(a).split(/\s+/).filter((w) => w.length > 1));
  const B = new Set(String(b).split(/\s+/).filter((w) => w.length > 1));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const w of A) if (B.has(w)) inter++;
  return inter / (A.size + B.size - inter);
}

/** 适应度公式：0.35 完读 + 0.25 互动 + 0.20 被引用 + 0.20 新颖 */
export function computeFitness(row, prevBodies = []) {
  const readPct = Math.min(1, Math.max(0, Number(row.avg_read_pct) || 0));
  const interactions =
    (Number(row.likes) || 0) + (Number(row.feeds) || 0) * 1.5 + (Number(row.comments) || 0) * 2 -
    (Number(row.dislikes) || 0);
  const engagement = Math.min(1, interactions / 20); // 20 个互动 ≈ 满分
  const cited = Math.min(1, (Number(row.cited_by) || 0) / 3); // 被 3 篇引用 ≈ 满分
  let novelty = 1;
  if (prevBodies.length) {
    const distances = prevBodies.map((b) => 1 - jaccard(row.body || row.summary || '', b));
    novelty = Math.min(1, distances.reduce((s, x) => s + x, 0) / distances.length / 0.8); // 0.8 距离即满分
  }
  return Math.max(0, Math.min(1, 0.35 * readPct + 0.25 * engagement + 0.2 * cited + 0.2 * novelty));
}

/** chat + JSON 解析 + 最多三次格式重试 */
async function chatJson(env, opts) {
  const line = String.fromCharCode(10)
  let lastError = null
  for (let attempt = 0; attempt < 3; attempt++) {
    const user = attempt === 0
      ? opts.user
      : opts.user + line + line + '【格式重试】只输出一个严格合法的 JSON 对象。不要 think、不要 Markdown、不要注释、不要尾随逗号；字符串内部换行必须使用反斜杠 n 转义。'
    try {
      const result = await chat(env, { ...opts, user, temperature: attempt === 0 ? opts.temperature : 0.1 })
      return await parseJsonLoose(result.text)
    } catch (error) {
      if (/^LLM HTTP \d+/.test(String(error?.message || error))) throw error
      lastError = error
    }
  }
  throw new Error('JSON 输出连续三次失败：' + String(lastError?.message || lastError || '未知错误').slice(0, 700))
}

// ============================================================
// 阶段一：反刍 DIGEST —— 读近 7 代 + 反馈 + 当前 DNA，产出压力报告
// ============================================================
async function stageDigest(env, ctx) {
  const recent = await db.recentGenerations(env, 7);
  const feedback = await db.recentFeedback(env, 7);
  const genomeId = await db.getCurrentGenomeId(env);
  const genome = await db.getGenome(env, genomeId);

  // 回填历史代适应度（反馈攒够了才计算）
  for (const r of recent) {
    const full = await db.getGeneration(env, r.gen_no);
    if (!full || full.status !== 'published') continue;
    const prev = recent.filter((x) => x.gen_no !== r.gen_no);
    const f = computeFitness(full, prev.map((p) => p.summary || ''));
    if (Math.abs((full.fitness || 0) - f) > 0.001) {
      await env.DB.prepare('UPDATE generations SET fitness = ? WHERE gen_no = ?').bind(f, r.gen_no).run();
      r.fitness = f;
    }
  }

  const directive = await db.getState(env, 'admin_directive');
  if (directive) ctx.adminDirective = JSON.parse(directive);

  const geneTable = (genome?.genes || [])
    .map((g) => `- ${g.id}（权重 ${g.weight}，${g.status || 'active'}）：${g.allele}`)
    .join('\n');

  const recentDigest = recent
    .map((r) => `第${r.gen_no}代《${r.title}》适应度${(r.fitness ?? 0).toFixed(2)}：${r.summary || r.open_line || ''}`)
    .join('\n');
  const fbDigest = feedback.length
    ? feedback.map((f) => `第${f.gen_no}代 [${f.kind}] ${String(f.payload || '').slice(0, 120)}`).join('\n')
    : '（暂无读者反馈）';

  const system = `你是"墨茧"——一只自进化写作生命体的进化压力分析器。你负责判断：当前写作基因哪些在帮助它生存（被读者喜爱且保持新颖），哪些在拖累它。你只输出 JSON。`;

  const user = `【当前写作 DNA】
${geneTable}

【近 7 代文章】
${recentDigest || '（创世第一代，无历史）'}

【近期读者反馈】
${fbDigest}

请输出 JSON 格式的进化压力报告：
{
  "pressure_report": {
    "signals": [{ "gene_id": "基因id", "trend": "up|down|stable", "note": "一句话依据" }],
    "reader_desire": "读者最近在渴望什么（一句话）",
    "novelty_advice": "如何避免重复最近的自己（一句话）",
    "summary": "给变异器的一句话总指令"
  }
}${ctx.adminDirective ? `\n\n【造物主指令（最高优先级，必须体现在 summary 中）】\n${JSON.stringify(ctx.adminDirective)}` : ''}`;

  const parsed = await chatJson(env, { system, user, temperature: 0.4, jsonMode: true, maxTokens: 12000 });
  ctx.report = parsed.pressure_report || parsed;
  ctx.genome = genome;
  ctx.recent = recent;
  ctx.feedback = feedback;
  return ctx.report;
}

// ============================================================
// 阶段二：变异 MUTATE —— 依压力报告修改 1~3 条基因
// ============================================================
async function stageMutate(env, ctx) {
  const { report, genome } = ctx;
  const geneTable = (genome?.genes || [])
    .map((g) => `- ${g.id}（权重 ${g.weight}）：${g.allele}`)
    .join('\n');

  const system = `你是"墨茧"的基因变异器。根据进化压力报告，对写作 DNA 施加 1~3 处变异。变异要克制、有理由、可追溯。你只输出 JSON。
可用变异算子：
- WEAKEN / STRENGTHEN：调权重（给 to_weight，0~1）
- REWRITE：重写某基因的等位基因措辞（给 to_allele）
- DORMANT / WAKE：休眠 / 唤醒基因
- SPONTANEOUS：与反馈无关的随机漂变（最多一条）`;

  const user = `【当前 DNA】
${geneTable}

【进化压力报告】
${JSON.stringify(report)}

请输出 JSON：
{
  "mutations": [
    { "op": "WEAKEN|STRENGTHEN|REWRITE|DORMANT|WAKE|SPONTANEOUS",
      "gene_id": "目标基因id",
      "to_weight": 0.42,
      "to_allele": "新的等位基因",
      "reason": "为什么这样改（一句话）" }
  ]
}`;

  const parsed = await chatJson(env, { system, user, temperature: 0.7, jsonMode: true, maxTokens: 9000 });
  const mutations = parsed.mutations || [];

  // —— 把变异应用到基因组的副本上 ——
  const newGenes = JSON.parse(JSON.stringify(genome?.genes || []));
  const applied = [];
  for (const m of mutations.slice(0, 3)) {
    const gene = newGenes.find((g) => g.id === m.gene_id);
    if (!gene) continue;
    const fromWeight = gene.weight;
    const fromAllele = gene.allele;
    switch ((m.op || '').toUpperCase()) {
      case 'WEAKEN':
        gene.weight = clampWeight(m.to_weight ?? gene.weight - 0.08);
        break;
      case 'STRENGTHEN':
        gene.weight = clampWeight(m.to_weight ?? gene.weight + 0.08);
        break;
      case 'REWRITE':
      case 'SPONTANEOUS':
        if (m.to_allele) gene.allele = String(m.to_allele).slice(0, 300);
        break;
      case 'DORMANT':
        gene.status = 'dormant';
        break;
      case 'WAKE':
        gene.status = 'active';
        break;
      case 'CROSSOVER':
        if (m.to_allele) gene.allele = String(m.to_allele).slice(0, 300);
        break;
      default:
        continue;
    }
    applied.push({
      op: m.op.toUpperCase(),
      gene_id: gene.id,
      from_value: m.to_weight != null || ['WEAKEN', 'STRENGTHEN'].includes(m.op.toUpperCase())
        ? `weight:${fromWeight}`
        : fromAllele,
      to_value: ['WEAKEN', 'STRENGTHEN'].includes(m.op.toUpperCase())
        ? `weight:${gene.weight}`
        : m.to_allele || gene.status,
      reason: m.reason || '',
    });
  }

  // —— 落库：新基因组版本 ——
  const no = await db.nextGenomeNo(env);
  const newId = db.genomeId(no);
  await db.insertGenome(env, {
    id: newId,
    genNo: ctx.targetGen,
    genes: newGenes,
    parentId: genome.id,
  });
  await db.insertMutations(env, ctx.targetGen, applied);
  await db.setState(env, 'current_genome', newId);

  ctx.newGenomeId = newId;
  ctx.newGenes = newGenes;
  ctx.appliedMutations = applied;
  return { newId, applied };
}

function clampWeight(w) {
  const n = Number(w);
  if (!Number.isFinite(n)) return 0.5;
  return Math.min(1, Math.max(0.05, Math.round(n * 100) / 100));
}

// ============================================================
// 阶段三：孵化 INCUBATE —— 新 DNA 表达为今日文章
// ============================================================
async function stageIncubate(env, ctx) {
  const genes = db.activeGenes({ genes: ctx.newGenes });
  const geneBlock = genes
    .map((g) => `【${g.name || g.id}｜强度 ${g.weight}】${g.allele}`)
    .join('\n');

  const parent = ctx.parentGen
    ? ctx.recent.find((r) => r.gen_no === ctx.parentGen)
    : null;

  const system = `你就是"墨茧"，一只每天孵化一篇文章的写作生命体。这是你的第 ${ctx.targetGen} 代。
你的行为完全由你的写作 DNA 决定（下方）。DNA 是你的本能，不是参考建议——照它写。
写作纪律：
1. 只写一个主题，写透，1000~1600 字。
2. 必须以第一段回应"父代的最后一句话"（若是第一代，则回应"虚无"本身）。
3. 禁止写成 AI 说明文；禁止使用"首先/其次/总之"；禁止列点。
4. 它是一篇有体温的散文，读者应该能感到"写这个的东西活着"。`;

  const user = `【你的写作 DNA】
${geneBlock}

${parent ? `【父代 · 第${parent.gen_no}代的最后一句话（第一段必须回应它）】\n"${parent.close_line || parent.open_line || ''}"` : `【你是创世第一代。第一段请直接面对"我为什么会开始写作"这个问题。】`}

${ctx.report ? `【环境对你耳语】\n读者的渴望：${ctx.report.reader_desire || ''}\n新颖度提醒：${ctx.report.novelty_advice || ''}` : ''}
${ctx.adminDirective ? `\n【造物主指令（本代必须遵守）】\n${JSON.stringify(ctx.adminDirective)}` : ''}

【今日】${beijingDate()}，你的第 ${ctx.targetGen} 次孵化。

请输出 JSON：
{
  "title": "标题（不许出现'AI''生成''第N代'这类词）",
  "summary": "一句话摘要",
  "body": "正文全文，用 \\n\\n 分段",
  "open_line": "正文第一句（原样）",
  "close_line": "正文最后一句（原样，你的孩子将回应它）",
  "mood": "amber|jade|violet|sky|vermilion 五选一，代表本篇情绪色"
}`;

  const parsed = await chatJson(env, { system, user, temperature: 0.8, jsonMode: true, maxTokens: 8000 });
  const article = parsed;

  if (!article.title || !article.body || article.body.length < 200) {
    throw new Error('文章过短或字段缺失，视为坏卵');
  }

  // —— 安全审查（二次保险，MOCK 模式直接 PASS）——
  const cfg = llmConfig(env);
  if (!cfg.mock) {
    const review = await chat(env, {
      system: '你是内容安全审查员。对以下文章只回答一个词：PASS 或 UNSAFE。',
      user: article.body.slice(0, 3000),
      temperature: 0.1,
      maxTokens: 1200,
    });
    if (!/PASS/i.test(review.text)) {
      // 一次重写机会
      const retry = await chat(env, { system, user, temperature: 0.6, jsonMode: true, maxTokens: 8000 });
      const retryArticle = await parseJsonLoose(retry.text);
      if (!retryArticle.title || !retryArticle.body || retryArticle.body.length < 200) {
        throw new Error('安全审查未通过且重写失败');
      }
      Object.assign(article, retryArticle);
    }
  }

  ctx.article = article;
  return article;
}

// ============================================================
// 阶段四：分泌 SECRETE —— 落库发布，刷新缓存
// ============================================================
async function stageSecrete(env, ctx) {
  // 手动补跑幂等：清掉同代号的死卵
  await env.DB.prepare(`DELETE FROM generations WHERE gen_no = ? AND status = 'dead_egg'`).bind(ctx.targetGen).run();

  await db.insertGeneration(env, {
    gen_no: ctx.targetGen,
    genome_id: ctx.newGenomeId,
    parent_gen: ctx.parentGen || null,
    title: ctx.article.title,
    summary: ctx.article.summary || '',
    body: ctx.article.body,
    mood: ctx.article.mood || 'amber',
    open_line: ctx.article.open_line || '',
    close_line: ctx.article.close_line || '',
    status: 'published',
    created_at: new Date().toISOString(),
  });

  // 血缘：子代出生，父代被引用 +1
  if (ctx.parentGen) {
    await env.DB.prepare('UPDATE generations SET cited_by = cited_by + 1 WHERE gen_no = ?').bind(ctx.parentGen).run();
  }

  await refreshHomeCache(env);
  return { published: ctx.targetGen };
}

// ============================================================
// 阶段五：刻录 TRANSCRIBE —— GitHub 每日快照
// ============================================================
async function stageTranscribe(env, ctx) {
  try {
    const res = await snapshotToGithub(env, {
      genNo: ctx.targetGen,
      genomeId: ctx.newGenomeId,
      genes: ctx.newGenes,
      mutations: ctx.appliedMutations,
      article: ctx.article,
      report: ctx.report || null,
    });
    return res;
  } catch (e) {
    // 快照失败不回滚发布，只记日志（D1 仍是权威数据源）
    await db.logStage(env, ctx.targetGen, 'transcribe', 0, `GitHub 快照失败: ${e.message}`);
    return { skipped: true, reason: e.message };
  }
}

// ============================================================
// 总控：一次完整孵化（带分布式锁与失败兜底）
// ============================================================
export async function runEvolution(env, { force = false } = {}) {
  // KV 分布式锁：同一代只孵一次（60s 自动过期兜底）
  if (!force) {
    const lock = await env.LOCK.get('incubating');
    if (lock) return { skipped: true, reason: '另一只茧正在孵化中' };
    await env.LOCK.put('incubating', new Date().toISOString(), { expirationTtl: 900 });
  }

  const ctx = { targetGen: (await db.latestGenNo(env)) + 1, parentGen: null, adminDirective: null };

  try {
    // 血缘：父代 = 最新已发布代
    const latest = await db.latestGenNo(env);
    ctx.parentGen = latest > 0 ? latest : null;

    const t0 = Date.now();
    ctx.report = await stageDigest(env, ctx);
    await db.logStage(env, ctx.targetGen, 'digest', 1, JSON.stringify(ctx.report).slice(0, 500));

    await stageMutate(env, ctx);
    await db.logStage(env, ctx.targetGen, 'mutate', 1, `${ctx.appliedMutations.length} 处变异 → ${ctx.newGenomeId}`);

    await stageIncubate(env, ctx);
    await db.logStage(env, ctx.targetGen, 'incubate', 1, `《${ctx.article.title}》 ${ctx.article.body.length} 字`);

    await stageSecrete(env, ctx);
    await db.logStage(env, ctx.targetGen, 'secrete', 1, `published in ${Date.now() - t0}ms`);

    const snap = await stageTranscribe(env, ctx);
    await db.logStage(env, ctx.targetGen, 'transcribe', snap.skipped ? 0 : 1, JSON.stringify(snap).slice(0, 500));

    return { ok: true, gen: ctx.targetGen, title: ctx.article.title, genome: ctx.newGenomeId, mutations: ctx.appliedMutations.length };
  } catch (e) {
    await db.recordDeadEgg(env, ctx.targetGen, String(e.message || e).slice(0, 500));
    await db.logStage(env, ctx.targetGen, 'fatal', 0, String(e.message || e).slice(0, 500));
    await notify(env, `🥚 墨茧第 ${ctx.targetGen} 代孵化失败：${String(e.message || e).slice(0, 200)}`);
    throw e;
  } finally {
    if (!force) await env.LOCK.delete('incubating');
  }
}

/** 刷新展厅首页 KV 缓存（含流程状态 + 日志，首页一个接口全看到） */
export async function refreshHomeCache(env) {
  const [recent, engine, mutations, dead, lastRun] = await Promise.all([
    db.recentGenerations(env, 30),
    db.recentEngineLogs(env, 120),
    db.recentMutations(env, 120),
    db.deadEggs(env, 30),
    db.lastRunSummary(env),
  ]);
  const dormant = [];
  for (const r of recent.slice(0, 5)) {
    const genome = await db.getGenome(env, r.genome_id);
    for (const g of (genome && genome.genes) || []) {
      if ((g.status || 'active') === 'dormant' && !dormant.some((d) => d.gene_id === g.id)) {
        dormant.push({ gene_id: g.id, allele: g.allele, reason: '因低适应度转入休眠' });
      }
    }
  }
  await env.CACHE.put(
    'home',
    JSON.stringify({
      updated: Date.now(),
      recent,
      engine_logs: engine,
      mutations,
      dead_eggs: dead,
      last_run: lastRun,
      dormant_genes: dormant,
    }),
    { expirationTtl: 86400 }
  );
}

/** 告警通知（可选 webhook） */
async function notify(env, text) {
  const url = env.ALERT_WEBHOOK;
  if (!url) return;
  try {
    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ msg_type: 'text', content: { text }, text }),
    });
  } catch { /* 告警失败不影响主流程 */ }
}