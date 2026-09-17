// ============================================================
// 墨茧 InkCocoon · src/index.js
// Worker 入口：scheduled（Cron 进化心跳）+ fetch（展厅 API + 管理接口）
// ============================================================

import { runEvolution, refreshHomeCache } from './pipeline.js';
import * as db from './db.js';
import { parseJsonLoose } from './llm.js';

// ---------- 小工具 ----------
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*' },
  });
}

function corsPreflight() {
  return new Response(null, {
    status: 204,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type,Authorization',
    },
  });
}

async function readJson(req) {
  try {
    return await req.json();
  } catch {
    return {};
  }
}

function isAdmin(req, env) {
  const auth = req.headers.get('Authorization') || '';
  const token = env.ADMIN_TOKEN || '';
  // 未设置 ADMIN_TOKEN 时，仅允许本地 dev
  if (!token) return env.ENV !== 'production';
  return auth === `Bearer ${token}`;
}

function beijingToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10);
}

// ============================================================
// CRON：每日进化心跳（04:00 北京时间）
// ============================================================
export default {
  async scheduled(event, env, ctx) {
    ctx.waitUntil(
      (async () => {
        try {
          const r = await runEvolution(env, {});
          console.log('[墨茧] 孵化完成', JSON.stringify(r));
        } catch (e) {
          // 失败已记录死卵 + 告警；18:00 GitHub Actions 兜底
          console.error('[墨茧] 孵化失败', e.message);
        }
      })()
    );
  },

  // ============================================================
  // HTTP API
  // ============================================================
  async fetch(req, env, ctx) {
    if (req.method === 'OPTIONS') return corsPreflight();
    const url = new URL(req.url);
    const path = url.pathname;

    // ---------- 静态展厅 ----------
    if (req.method === 'GET' && !path.startsWith('/api/')) {
      return env.ASSETS.fetch(req);
    }

    // ---------- 公开 API ----------

    // 首页数据（KV 缓存，含流程状态与日志）
    if (path === '/api/home' && req.method === 'GET') {
      const cached = await env.CACHE.get('home');
      if (cached) return json(JSON.parse(cached));
      await refreshHomeCache(env);
      const fresh = await env.CACHE.get('home');
      return json(fresh ? JSON.parse(fresh) : { updated: Date.now(), recent: [] });
    }

    // 日志流（引擎日志 + 变异日志 + 死卵）：供首页实时查看，不进缓存
    if (path === '/api/logs' && req.method === 'GET') {
      const [engine, mutations, dead] = await Promise.all([
        db.recentEngineLogs(env, 120),
        db.recentMutations(env, 120),
        db.deadEggs(env, 30),
      ]);
      return json({
        engine_logs: engine,
        mutations,
        dead_eggs: dead,
        last_run: await db.lastRunSummary(env),
        fetched_at: new Date().toISOString(),
      });
    }

    // 某一代详情（含全文与当次 DNA 快照）
    if (path.match(/^\/api\/gen\/\d+$/) && req.method === 'GET') {
      const genNo = Number(path.split('/').pop());
      const gen = await db.getGeneration(env, genNo);
      if (!gen) return json({ error: '不存在的世代' }, 404);

      const genome = gen.status === 'published' ? await db.getGenome(env, gen.genome_id) : null;
      const mutations = await env.DB
        .prepare('SELECT * FROM mutations WHERE gen_no = ? ORDER BY id')
        .bind(genNo)
        .all();
      const parent = gen.parent_gen ? await db.getGeneration(env, gen.parent_gen) : null;
      const children = await env.DB
        .prepare(`SELECT gen_no, title, mood FROM generations WHERE parent_gen = ? AND status='published'`)
        .bind(genNo)
        .all();

      return json({ gen, genome: genome ? { id: genome.id, parent_id: genome.parent_id, genes: genome.genes } : null, mutations: mutations.results || [], parent, children: children.results || [] });
    }

    // 血缘图谱（全部世代 + 基因组血缘）
    if (path === '/api/bloodline' && req.method === 'GET') {
      const gens = await env.DB
        .prepare(`SELECT gen_no, parent_gen, title, mood, fitness, status, created_at FROM generations ORDER BY gen_no`)
        .all();
      const genomes = await env.DB
        .prepare(`SELECT id, parent_id, gen_no FROM genomes ORDER BY gen_no`)
        .all();
      return json({ generations: gens.results || [], genomes: genomes.results || [] });
    }

    // 互动：阅读（带阅读进度）
    if (path === '/api/react/read' && req.method === 'POST') {
      const b = await readJson(req);
      const genNo = Number(b.gen_no);
      if (!genNo) return json({ error: 'gen_no 必填' }, 400);
      const pct = Math.min(1, Math.max(0, Number(b.progress) || 0));

      await db.bumpGenerationCounters(env, genNo, { reads: 1 });
      // 滚动进度合并到 avg_read_pct（EMA）
      await env.DB
        .prepare(`UPDATE generations SET avg_read_pct = avg_read_pct * 0.7 + ? * 0.3 WHERE gen_no = ?`)
        .bind(pct, genNo)
        .run();
      await env.DB
        .prepare('INSERT INTO feedback (gen_no, kind, payload, reader, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(genNo, 'read', String(pct), b.reader || null, db.nowISO())
        .run();
      return json({ ok: true });
    }

    // 互动：点赞 / 点踩
    if (path === '/api/react/vote' && req.method === 'POST') {
      const b = await readJson(req);
      const genNo = Number(b.gen_no);
      const kind = b.kind === 'dislike' ? 'dislike' : 'like';
      if (!genNo) return json({ error: 'gen_no 必填' }, 400);
      await db.bumpGenerationCounters(env, genNo, kind === 'like' ? { likes: 1 } : { dislikes: 1 });
      await env.DB
        .prepare('INSERT INTO feedback (gen_no, kind, payload, reader, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(genNo, kind, '', b.reader || null, db.nowISO())
        .run();
      return json({ ok: true });
    }

    // 互动：喂养（投喂一个词/一句话，进入明日变异素材池）
    if (path === '/api/react/feed' && req.method === 'POST') {
      const b = await readJson(req);
      const genNo = Number(b.gen_no);
      const word = String(b.word || '').slice(0, 60).trim();
      if (!genNo || !word) return json({ error: 'gen_no 与 word 必填' }, 400);
      await db.bumpGenerationCounters(env, genNo, { feeds: 1 });
      await env.DB
        .prepare('INSERT INTO feedback (gen_no, kind, payload, reader, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(genNo, 'feed', word, b.reader || null, db.nowISO())
        .run();
      return json({ ok: true, note: '已投入培养皿，可能影响下一次变异' });
    }

    // 互动：评论
    if (path === '/api/react/comment' && req.method === 'POST') {
      const b = await readJson(req);
      const genNo = Number(b.gen_no);
      const text = String(b.text || '').slice(0, 500).trim();
      if (!genNo || !text) return json({ error: 'gen_no 与 text 必填' }, 400);
      await db.bumpGenerationCounters(env, genNo, { comments: 1 });
      await env.DB
        .prepare('INSERT INTO feedback (gen_no, kind, payload, reader, created_at) VALUES (?, ?, ?, ?, ?)')
        .bind(genNo, 'comment', text, b.reader || null, db.nowISO())
        .run();
      return json({ ok: true });
    }

    // 某代反馈列表（文章页展示）
    if (path.match(/^\/api\/gen\/\d+\/feedback$/) && req.method === 'GET') {
      const genNo = Number(path.split('/')[3]);
      const rs = await env.DB
        .prepare(`SELECT kind, payload, created_at FROM feedback WHERE gen_no = ? ORDER BY id DESC LIMIT 100`)
        .bind(genNo)
        .all();
      return json({ feedback: rs.results || [] });
    }

    // ---------- 管理接口（Bearer ADMIN_TOKEN）----------

    // 状态页
    if (path === '/api/admin/status' && req.method === 'GET') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      const counts = {};
      for (const row of (await env.DB.prepare(
        `SELECT status, COUNT(*) AS n FROM generations GROUP BY status`
      ).all()).results || []) counts[row.status] = row.n;
      const last = (await env.DB.prepare(
        `SELECT gen_no, title, status, dead_reason, created_at FROM generations ORDER BY gen_no DESC LIMIT 10`
      ).all()).results || [];
      const logs = (await env.DB.prepare(
        `SELECT gen_no, stage, ok, detail, created_at FROM engine_logs ORDER BY id DESC LIMIT 20`
      ).all()).results || [];
      const currentGenome = await db.getCurrentGenomeId(env);
      return json({ today: beijingToday(), counts, recent_gens: last, engine_logs: logs, current_genome: currentGenome });
    }

    // 强制刷新首页缓存（部署/修复后用于把历史实时日志重新汇总到首页）
    if (path === '/api/admin/refresh' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      await refreshHomeCache(env);
      return json({ ok: true, refreshed_at: new Date().toISOString() });
    }

    // 手动孵化（补跑 / 测试）
    if (path === '/api/admin/incubate' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      const b = await readJson(req);
      try {
        const r = await runEvolution(env, { force: !!b.force });
        return json(r);
      } catch (e) {
        return json({ error: e.message }, 500);
      }
    }

    // 管理员基因剪刀：激活/休眠某基因
    if (path === '/api/admin/gene-scissors' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      const b = await readJson(req);
      const genomeId = await db.getCurrentGenomeId(env);
      const genome = await db.getGenome(env, genomeId);
      if (!genome) return json({ error: '无基因组' }, 404);
      const gene = (genome.genes || []).find((g) => g.id === b.gene_id);
      if (!gene) return json({ error: '基因不存在' }, 404);
      gene.status = b.action === 'dormant' ? 'dormant' : 'active';
      await db.insertGenome(env, {
        id: db.genomeId(await db.nextGenomeNo(env)),
        genNo: (await db.latestGenNo(env)) + 1,
        genes: genome.genes,
        parentId: genome.id,
      });
      // 指针指向新版本
      const rows = await env.DB.prepare(`SELECT id FROM genomes ORDER BY gen_no DESC, id DESC LIMIT 1`).all();
      await db.setState(env, 'current_genome', rows.results[0].id);
      return json({ ok: true, gene_id: b.gene_id, status: gene.status });
    }

    // 管理员定向诱变：给下一代注入主题/情绪指令
    if (path === '/api/admin/directive' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      const b = await readJson(req);
      const directive = { theme: String(b.theme || '').slice(0, 200), mood: String(b.mood || ''), at: new Date().toISOString() };
      await db.setState(env, 'admin_directive', JSON.stringify(directive));
      return json({ ok: true, directive });
    }

    // 读取指令（孵化时消耗）
    if (path === '/api/admin/directive' && req.method === 'GET') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      return json({ directive: await db.getState(env, 'admin_directive') });
    }

    // 初始化创世（写入 genesis.json 的 DNA）
    if (path === '/api/admin/genesis' && req.method === 'POST') {
      if (!isAdmin(req, env)) return json({ error: 'unauthorized' }, 401);
      const b = await readJson(req);
      const dna = b.dna || null;
      if (!dna || !Array.isArray(dna.genes)) return json({ error: '需要 { id, genes: [...] }' }, 400);
      await db.insertGenome(env, { id: dna.id, genNo: 0, genes: dna.genes, parentId: null });
      await db.setState(env, 'current_genome', dna.id);
      return json({ ok: true, genome: dna.id, genes: dna.genes.length });
    }

    return json({ error: 'not found', path }, 404);
  },
};