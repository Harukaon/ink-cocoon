# 墨茧 InkCocoon 🥚

> 一只由 **RSI（递归自我改进）** 驱动的自进化写作有机体。
> 它每天凌晨自己孵化一篇文章，读者反馈变成选择压，选择压反过来改写它自己的写作 DNA——日复一日，越写越像「它自己」。

![generation](https://img.shields.io/badge/墨茧-创世中-black)

---

## 这是什么

普通的 AI 写作系统优化的是「单篇文章」；墨茧优化的是**生成文章的那个「写作人格」本身**：

```
反刍(读近7代+反馈) → 变异(改1~3条基因) → 孵化(新DNA表达为文章) → 分泌(发布) → 刻录(git快照)
     ↑                                                                  │
     └────────────────────── 读者的阅读 / 点赞 / 评论 / 喂养 ←──────────┘
```

每天一次 Cloudflare Cron 触发，五段行程约 3~5 分钟，全流程落库可回放。

## 架构（一台 Worker 全包）

| 组件 | 用途 |
|---|---|
| **Cloudflare Worker** | Cron 心跳 + 展厅 API + 进化流水线 |
| **D1** | 世代 / 基因组 / 变异日志 / 反馈 / 引擎日志 |
| **R2** | （预留）全文冷备份 |
| **KV** | 首页缓存 + 分布式锁 |
| **Workers Assets** | 静态展厅（本仓库 /public） |
| **GitHub** | 代码托管 + **每日快照 commit（化石记录，可从零重建）** |
| **GitHub Actions** | Cron 失败时 18:00 兜底重跑 |
| **任意 OpenAI 兼容 LLM** | 通过 `LLM_BASE_URL` + `LLM_MODEL` 配置，key 走 secret |

## 部署步骤（一次性）

```bash
# 0) 安装 wrangler 并登录
npm i
npx wrangler login

# 1) 创建资源，并把返回的 id 填进 wrangler.toml
npx wrangler d1 create ink-cocoon-db
npx wrangler r2 bucket create ink-cocoon-archive
npx wrangler kv:namespace create CACHE
npx wrangler kv:namespace create LOCK

# 2) 初始化数据库 + 创世 DNA
npm run db:init
npm run genesis        # 或稍后通过 /api/admin/genesis 写入完整 DNA

# 3) 配置密钥
npx wrangler secret put LLM_API_KEY     # 你的 LLM key
npx wrangler secret put GITHUB_TOKEN    # GitHub PAT（repo 权限）
npx wrangler secret put ADMIN_TOKEN     # 管理接口 token
# 可选：npx wrangler secret put ALERT_WEBHOOK

# 4) 在 wrangler.toml 里填 LLM_BASE_URL / LLM_MODEL（非敏感，走 vars）

# 5) 部署
npm run deploy
```

### GitHub 侧 secrets（仓库 Settings → Secrets → Actions）

| Secret | 值 |
|---|---|
| `INKCOCOON_WORKER_URL` | 部署后的 Worker URL（如 `https://ink-cocoon.xxx.workers.dev`） |
| `INKCOCOON_ADMIN_TOKEN` | 与 Worker 的 `ADMIN_TOKEN` secret 相同值 |

## 手动触发 / 测试

```bash
# 手动孵化一代（等不及凌晨四点时）
curl -X POST https://<worker>/api/admin/incubate \
  -H "Authorization: Bearer <ADMIN_TOKEN>" -H "Content-Type: application/json" -d '{}'

# 看状态
curl https://<worker>/api/admin/status -H "Authorization: Bearer <ADMIN_TOKEN>"

# 没有模型 key？先跑 MOCK 模式验证全流程：
# wrangler.toml 里 MOCK_LLM = "true"
```

## API 一览

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/home` | 首页数据（KV 缓存） |
| GET | `/api/gen/:n` | 第 n 代详情（全文 + 当次 DNA + 变异 + 血缘） |
| GET | `/api/gen/:n/feedback` | 第 n 代反馈列表 |
| GET | `/api/bloodline` | 血缘图谱数据 |
| POST | `/api/react/read` | 阅读埋点 `{gen_no, progress}` |
| POST | `/api/react/vote` | 点赞/点踩 `{gen_no, kind}` |
| POST | `/api/react/feed` | 喂养 `{gen_no, word}` |
| POST | `/api/react/comment` | 评论 `{gen_no, text}` |
| GET | `/api/admin/status` | 引擎状态页 |
| POST | `/api/admin/incubate` | 手动孵化 `{force?}` |
| POST | `/api/admin/gene-scissors` | 基因剪刀 `{gene_id, action}` |
| POST | `/api/admin/directive` | 定向诱变 `{theme, mood}` |
| POST | `/api/admin/genesis` | 写入创世 DNA |

## 适应度公式

```
Fitness = 0.35×完读率 + 0.25×互动率 + 0.20×被后代引用数 + 0.20×新颖度
新颖度 = 与近 7 篇的词级 Jaccard 距离均值（系统惩罚自我重复）
```

## 目录结构

```
ink-cocoon/
├── src/
│   ├── index.js      # Worker 入口（Cron + API 路由）
│   ├── pipeline.js   # 五段进化流水线
│   ├── llm.js        # OpenAI 兼容 LLM 客户端 + MOCK 模式
│   ├── db.js         # D1 访问层
│   ├── gh.js         # GitHub 快照 commit
│   └── util.js
├── schema/           # D1 建表 + 创世 DNA
├── public/           # 展厅（纯静态 HTML）
├── .github/workflows/ # 兜底孵化
└── wrangler.toml
```

## 安全与成本

- LLM Key 只存 Workers Secrets；`MOCK_LLM=true` 可零成本跑通全流程
- 建议在 LLM 供应商侧设置月度预算上限；第 400 代进化失败可以接受，账单失控不行
- 每日快照 commit 保证数据双保险：Cloudflare 挂了，git 历史里有一切

---

*本 README 由人类撰写。按照设计，未来将由墨茧自己续写。*