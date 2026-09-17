// ============================================================
// 墨茧 InkCocoon · src/gh.js
// GitHub 每日快照：把当日文章 + DNA diff + 变异日志 commit 进仓库
// 即「化石记录」：数据可从 git 历史完整重建
// ============================================================

import { encodeBase64 } from './util.js';

const API = 'https://api.github.com';

function ghHeaders(env) {
  return {
    'Authorization': `Bearer ${env.GITHUB_TOKEN}`,
    'Accept': 'application/vnd.github+json',
    'User-Agent': 'ink-cocoon',
    'Content-Type': 'application/json',
  };
}

/** 取当前 ref 的 commit sha */
async function getRef(env, branch) {
  const res = await fetch(
    `${API}/repos/${env.GITHUB_REPO}/git/ref/heads/${encodeURIComponent(branch)}`,
    { headers: ghHeaders(env) }
  );
  if (!res.ok) throw new Error(`getRef ${res.status}`);
  const j = await res.json();
  return j.object.sha;
}

/** 创建 blob */
async function createBlob(env, content) {
  const res = await fetch(`${API}/repos/${env.GITHUB_REPO}/git/blobs`, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({ content: encodeBase64(content), encoding: 'base64' }),
  });
  if (!res.ok) throw new Error(`blob ${res.status}`);
  const j = await res.json();
  return j.sha;
}

/** 组装 tree：archive/GEN-0007.json + data/dna.json + data/mutations.jsonl 追加 */
async function buildTree(env, baseSha, { genNo, genomeId, genes, mutations, article, report }) {
  const day = new Date().toISOString().slice(0, 10);
  const tree = [];

  // 1) 当代完整档案（不可变）
  const snapshot = {
    gen_no: genNo,
    genome_id: genomeId,
    date: day,
    dna: genes,
    mutations,
    report,
    article,
  };
  tree.push({
    path: `archive/${day.replace(/-/g, '')}-${genomeId}.json`,
    mode: '100644',
    type: 'blob',
    sha: await createBlob(env, JSON.stringify(snapshot, null, 2)),
  });

  // 2) DNA 最新版（可变文件）
  tree.push({
    path: 'data/dna.json',
    mode: '100644',
    type: 'blob',
    sha: await createBlob(env, JSON.stringify({ genome_id: genomeId, updated: day, genes }, null, 2)),
  });

  // 3) 变异日志（追加式）
  const logLine = JSON.stringify({ gen: genNo, date: day, genome_id: genomeId, mutations }) + '\n';
  const oldLog = await readFile(env, 'data/mutations.jsonl', 'main');
  tree.push({
    path: 'data/mutations.jsonl',
    mode: '100644',
    type: 'blob',
    sha: await createBlob(env, (oldLog || '') + logLine),
  });

  // 4) README 徽章更新（进化天数）
  const readme = await readFile(env, 'README.md');
  if (readme) {
    tree.push({
      path: 'README.md',
      mode: '100644',
      type: 'blob',
      sha: await createBlob(env, upsertBadge(readme, genNo, day)),
    });
  }

  return tree;
}

/** 读取仓库文件（返回文本或 null） */
async function readFile(env, path, branch) {
  const res = await fetch(
    `${API}/repos/${env.GITHUB_REPO}/contents/${path}?ref=${encodeURIComponent(branch)}`,
    { headers: ghHeaders(env) }
  );
  if (!res.ok) return null;
  const j = await res.json();
  if (j.encoding === 'base64') {
    // decode base64 → utf8
    const bin = atob(j.content.replace(/\n/g, ''));
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return j.content;
}

function upsertBadge(readme, genNo, day) {
  const badge = `![generation](https://img.shields.io/badge/墨茧-第${genNo}代-${day})`;
  const re = /^!\[generation\]\(.*\)$/m;
  return re.test(readme) ? readme.replace(re, badge) : `# 墨茧 InkCocoon\n\n${badge}\n\n${readme}`;
}

/** 主入口：一次快照 commit */
export async function snapshotToGithub(env, payload) {
  if (!env.GITHUB_TOKEN || !env.GITHUB_REPO) {
    return { skipped: true, reason: '未配置 GITHUB_TOKEN / GITHUB_REPO' };
  }
  const branch = env.GITHUB_BRANCH || 'main';
  const baseSha = await getRef(env, branch);

  // 拉基础 tree
  const baseCommitRes = await fetch(`${API}/repos/${env.GITHUB_REPO}/git/commits/${baseSha}`, { headers: ghHeaders(env) });
  if (!baseCommitRes.ok) throw new Error(`base commit ${baseCommitRes.status}`);
  const baseCommit = await baseCommitRes.json();

  const tree = await buildTree(env, baseCommit.tree.sha, payload);

  // 创建 tree / commit / 更新 ref
  const treeRes = await fetch(`${API}/repos/${env.GITHUB_REPO}/git/trees`, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({ base_tree: baseCommit.tree.sha, tree }),
  });
  if (!treeRes.ok) throw new Error(`tree ${treeRes.status}`);
  const newTree = await treeRes.json();

  const date = new Date().toISOString().slice(0, 10);
  const commitRes = await fetch(`${API}/repos/${env.GITHUB_REPO}/git/commits`, {
    method: 'POST',
    headers: ghHeaders(env),
    body: JSON.stringify({
      message: `墨茧第 ${payload.genNo} 代 · ${payload.genomeId} · ${date}`,
      tree: newTree.sha,
      parents: [baseSha],
    }),
  });
  if (!commitRes.ok) throw new Error(`commit ${commitRes.status}`);
  const newCommit = await commitRes.json();

  const refRes = await fetch(`${API}/repos/${env.GITHUB_REPO}/git/refs/heads/${branch}`, {
    method: 'PATCH',
    headers: ghHeaders(env),
    body: JSON.stringify({ sha: newCommit.sha, force: false }),
  });
  if (!refRes.ok) throw new Error(`ref update ${refRes.status}`);

  return { committed: newCommit.sha, files: tree.map((t) => t.path) };
}