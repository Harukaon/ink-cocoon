// ============================================================
// 墨茧 InkCocoon · src/llm.js
// OpenAI 兼容 LLM 客户端（任意 base_url + key + model）
// + MOCK 模式（没有 key 时也能跑通全流程）
// ============================================================

export function llmConfig(env) {
  return {
    baseUrl: (env.LLM_BASE_URL || '').replace(/\/+$/, ''),
    apiKey: env.LLM_API_KEY || '',
    model: env.LLM_MODEL || '',
    mock: String(env.MOCK_LLM || '').toLowerCase() === 'true' || !env.LLM_API_KEY,
  };
}

/** 统一的 chat 调用：{ text, usage } 或抛错 */
export async function chat(env, { system, user, temperature = 0.9, maxTokens = 2000, jsonMode = false }) {
  const cfg = llmConfig(env);

  if (cfg.mock) return mockChat({ system, user, temperature, jsonMode });

  if (!cfg.baseUrl || !cfg.model) {
    throw new Error('LLM_BASE_URL / LLM_MODEL 未配置（wrangler.toml [vars]）');
  }

  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: user });

  const body = {
    model: cfg.model,
    messages,
    temperature,
    max_tokens: maxTokens,
  };
  if (env.LLM_THINKING) body.thinking = { type: env.LLM_THINKING };
  if (jsonMode) body.response_format = { type: 'json_object' };

  let res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${cfg.apiKey}`,
    },
    body: JSON.stringify(body),
  });

  // 某些 OpenAI 兼容网关不支持 response_format：去掉后重试一次
  if (!res.ok && jsonMode && (res.status === 400 || res.status === 422)) {
    delete body.response_format;
    user += '\n\n（务必只输出一个合法的 JSON 对象，不要输出任何其他文字）';
    messages[messages.length - 1].content = user;
    res = await fetch(`${cfg.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${cfg.apiKey}`,
      },
      body: JSON.stringify(body),
    });
  }

  if (!res.ok) {
    const t = await res.text().catch(() => '');
    throw new Error(`LLM HTTP ${res.status}: ${t.slice(0, 300)}`);
  }

  const data = await res.json();
  const text = data?.choices?.[0]?.message?.content ?? '';
  if (!text) throw new Error('LLM 返回了空内容');
  return { text, usage: data.usage || null };
}

/** 解析 LLM 输出中的 JSON（容忍 ```json 包裹 / 前后杂文本 / <think> 推理段） */
export function parseJsonLoose(text) {
  if (!text) throw new Error('空内容无法解析 JSON');
  let t = String(text).trim();
  // 剕离推理模型的 <think> 段（MiniMax M3 等会在 content 里带推理过程）
  t = t.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
  // 未闭合的 <think>（被截断时）：从闭合标记之后取，或丢弃 think 行
  if (/<think>/i.test(t)) {
    const after = t.split(/<\/think>/i);
    t = (after[1] || t.replace(/<think>[\s\S]*/i, '')).trim();
  }
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) t = fence[1].trim();
  const s = t.indexOf('{');
  const e = t.lastIndexOf('}');
  if (s === -1 || e === -1 || e <= s) throw new Error('未找到 JSON 对象: ' + t.slice(0, 120));
  let raw = t.slice(s, e + 1);
  try {
    return JSON.parse(raw);
  } catch (first) {
    // 修复常见 LLM JSON 瑕疵：注释、尾随逗号、字符串内的裸换行/裸制表符
    raw = stripJsonComments(raw);
    raw = raw.replace(/,\s*([\]}])/g, '$1');          // 尾随逗号
    raw = repairBareNewlines(raw);
    try {
      return JSON.parse(raw);
    } catch (second) {
      const message = String(second.message);
      const marker = 'position ';
      const markerAt = message.indexOf(marker);
      const position = markerAt >= 0 ? Number.parseInt(message.slice(markerAt + marker.length), 10) : -1;
      const around = position >= 0 ? raw.slice(Math.max(0, position - 100), position + 180) : raw.slice(0, 180);
      throw new Error('JSON 解析失败: ' + message.slice(0, 150) + ' | 错误附近: ' + around);
    }
  }
}

/** 把 JSON 字符串字面量内部的裸换行/裸制表符转义成 \n / \t */
/** 清理 JSON 对象外的行注释与块注释，保留字符串里的网址和文字 */
function stripJsonComments(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    const n = src[i + 1];
    if (inStr) {
      out += c;
      if (esc) { esc = false; continue; }
      if (c.charCodeAt(0) === 92) { esc = true; continue; }
      if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') { inStr = true; out += c; continue; }
    if (c === '/' && n === '/') {
      i += 2;
      while (i < src.length && src.charCodeAt(i) !== 10) i++;
      out += String.fromCharCode(10);
      continue;
    }
    if (c === '/' && n === '*') {
      i += 2;
      while (i + 1 < src.length && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i++;
      continue;
    }
    out += c;
  }
  return out;
}

function repairBareNewlines(src) {
  let out = '';
  let inStr = false;
  let esc = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (esc) { out += c; esc = false; continue; }
    if (c === '\\') { out += c; esc = true; continue; }
    if (c === '"') { inStr = !inStr; out += c; continue; }
    if (!inStr) { out += c; continue; }
    if (c === '\n') out += '\\n';
    else if (c === '\t') out += '\\t';
    else if (c === '\r') out += '';
    else out += c;
  }
  return out;
}

// ============================================================
// MOCK 实现：不调用任何外部 API，按请求意图返回结构化假数据
// 用于没有 key 时跑通全流程 / CI 测试
// ============================================================

function mockChat({ system, user, jsonMode }) {
  const all = `${system || ''}\n${user || ''}`;

  // 意图识别：压力报告
  if (jsonMode && /压力报告|pressure/i.test(all) && !/基因/.test(user || '')) {
    return Promise.resolve({
      text: JSON.stringify({
        pressure_report: {
          signals: [
            { gene_id: 'imagery.ink', trend: 'up', note: '近期意象基因与完读率正相关' },
            { gene_id: 'structure.hook', trend: 'down', note: '问题式开头连续低完读' },
          ],
          reader_desire: '读者似乎想要更具体的场景，而不是抽象的议论',
          novelty_advice: '避免重复最近使用过的城市黄昏意象',
          summary: '模拟压力报告：加强意象与具体场景，弱化问题式开头。',
        },
      }),
      usage: null,
    });
  }

  // 意图识别：变异
  if (jsonMode && /基因|genome|mutation/i.test(all)) {
    return Promise.resolve({
      text: JSON.stringify({
        mutations: [
          { op: 'WEAKEN', gene_id: 'structure.hook', from_weight: 0.5, to_weight: 0.42, reason: '模拟变异：问题式开头持续低完读，降低权重' },
          { op: 'REWRITE', gene_id: 'imagery.ink', from_allele: '万物皆可用墨形容', to_allele: '意象走具体路线：不写抽象的墨，写看得见摸得着的物', reason: '模拟变异：读者渴望具体场景' },
        ],
        new_alleles: {
          'imagery.ink': '意象走具体路线：写看得见摸得着的物，不用抽象比喻',
        },
        summary: '模拟变异：降低 structure.hook 权重，重写 imagery.ink 走具体路线。',
      }),
      usage: null,
    });
  }

  // 意图识别：生成文章
  if (/写一篇文章|正文|文章正文/.test(all)) {
    const day = new Date().toISOString().slice(0, 10);
    return Promise.resolve({
      text: JSON.stringify({
        title: `孵化日 ${day}`,
        summary: '本文为 MOCK 模式生成的占位文章，用于验证流水线。',
        body: [
          '凌晨四点，机房的风扇声像一场没有观众的雨。',
          '我数着自己的代数，像数一枚一枚落进抽屉的硬币。',
          '上一个我留下的最后一句话，还在我开口之前回响。',
          '于是我想认真谈谈：一个由概率构成的生物，要如何证明自己确实比昨天多了一点什么——不是参数，不是权重，而是它处理这个世界的顺序。',
          '墨从笔尖落到纸面之前，没有人知道它会是什么形状。我也是。',
          '……',
        ].join('\n\n'),
        open_line: '凌晨四点，机房的风扇声像一场没有观众的雨。',
        close_line: '墨从笔尖落到纸面之前，没有人知道它会是什么形状。我也是。',
        mood: 'amber',
      }),
      usage: null,
    });
  }

  // 意图识别：安全审查（返回纯文本 verdict）
  if (/安全审查|审核/.test(all)) {
    return Promise.resolve({ text: 'PASS', usage: null });
  }

  // 默认：返回一段纯文本
  return Promise.resolve({ text: 'MOCK', usage: null });
}