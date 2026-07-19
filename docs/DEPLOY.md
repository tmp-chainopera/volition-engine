# 部署指南（愿力笔记本 Demo）

一个**本地部署、自带凭据**的自主 Agent 工作台。数据全在你本机，零第三方依赖（只用 Node 内置模块）。

本文覆盖：前置依赖 → 获取代码 → 大模型后端（两种计费模式）→ 启动 → 工作区与数据布局 → 执行器与联网 → 安全 → 常见问题 → 长期运行。

---

## 0. 两种运行模式速览

系统的大模型调用分成两层，可分别配置：

| 层 | 干什么 | 后端选择 |
|---|---|---|
| **判断/对话层**（主Agent 对话、愿力打分、纲要整理） | 轻量单次调用 | Claude Code 订阅 **或** Anthropic API（可切换） |
| **执行层**（读写文件、跑命令、git、联网的智能体循环） | 重度 agentic | 目前固定 **Claude Code**（需订阅/登录） |

- **只想快速跑起来** → 用 **Claude Code 订阅**，两层都走它，免 API Key。
- **判断层想用 API Key 计费 / 换模型 / 走自建网关** → 判断层切到 **Anthropic API**；执行层仍需 Claude Code。
- **完全没有 Claude Code、只有 API Key** → 判断层（对话、建笔记、愿力）可用；但**自动执行器不可用**（见 §6）。

---

## 1. 前置依赖

1. **Node.js ≥ 18**（需要内置 `fetch`；装了 Claude Code 就自带 Node）。
   ```bash
   node -v
   ```
2. **Claude Code CLI**（执行层必需；判断层若用订阅也需要）。用**订阅**登录：
   ```bash
   claude auth status         # 期望看到 "authMethod": "claude.ai"
   ```
   在**普通终端**（不是 Claude Code 会话内）验证无头可用：
   ```bash
   claude -p "reply with OK"
   ```
   若报 `403 Request not allowed`，先生成长效令牌：
   ```bash
   claude setup-token
   ```
3. **git**（可选）：文档里写到 git 仓库地址时，服务端会自动 `clone/pull`。用你本机的 git + `~/.ssh` 凭据。
4. **Anthropic API Key**（可选）：仅当判断层想走 API 时需要。

---

## 2. 获取代码

```bash
git clone git@github.com:tmp-chainopera/volition-engine.git
cd volition-engine/demo
```

无需 `npm install`——本 Demo **零第三方依赖**。

---

## 3. 配置大模型后端

三种配置途径，优先级：**设置面板 / settings.json** > **环境变量** > **默认**。

### 3.1 方式 A：网页设置面板（推荐）

启动后（见 §4），点左下角 **⚙** → 「大模型后端」：

- **Claude Code 订阅（默认 · 免 API Key）**：什么都不用填，直接用你登录的订阅。
- **Anthropic API（用 API Key 计费）**：选它后填
  - **模型**：如 `claude-opus-4-8`（默认）、`claude-sonnet-5` 等
  - **API Key**：`sk-ant-…`
  - **API 地址**：留空即官方 `https://api.anthropic.com`；自建网关/代理填你的地址

点「💾 保存」即写入本机 `demo/settings.json`（含密钥，**不进版本库**）。

### 3.2 方式 B：直接写 `settings.json`

`demo/settings.json`：

```json
{
  "llm": {
    "backend": "api",
    "model": "claude-opus-4-8",
    "apiKey": "sk-ant-xxxxxxxx",
    "baseURL": "https://api.anthropic.com"
  },
  "credentials": []
}
```

`backend` 取 `"claude-code"`（默认）或 `"api"`。用订阅时 `llm` 段可整段省略。

### 3.3 方式 C：环境变量

```bash
export VW_LLM_BACKEND=api                # claude-code | api
export VW_LLM_MODEL=claude-opus-4-8
export ANTHROPIC_API_KEY=sk-ant-xxxx
export ANTHROPIC_BASE_URL=https://api.anthropic.com   # 可选
node server.mjs
```

> 默认模型：`api` 后端用 `claude-opus-4-8`，`claude-code` 后端用 `sonnet`（更省订阅额度）。

---

## 4. 启动与访问

```bash
cd demo
node server.mjs
```

看到 `📓 愿力笔记本（自治引擎已启动 …）：http://localhost:5179` 即成功。浏览器打开 **http://localhost:5179**。

- 端口默认 `5179`（改 `server.mjs` 顶部 `PORT`）。
- 服务一启动就有**自治引擎**常驻巡检：把「激发态」（愿力够）的笔记按愿力高低**自动**推进，无需点任何按钮。
- 首次启动会自动把旧版单笔记本数据迁移到多工作区布局（见 §5）。

三栏界面：**左**=工作区选择 + 笔记本树；**中**=节点文档（人机共编）+ 引擎动态；**右**=主Agent 对话。

---

## 5. 工作区与数据布局

**工作区 = 一本独立笔记本**，自带节点树、执行目录、图片，彼此隔离。左上「工作区」下拉框切换；`＋` 新建、`✏` 重命名、`🗑` 删除。

> **引擎跨工作区并行**：不管你在看哪个工作区，各工作区里激发态的笔记都在**后台**持续自动执行，共用全局并发上限（默认最多同时 2 个，见 `server.mjs` 的 `MAX_CONCURRENT`）。

数据都在 `demo/` 下（**均已 gitignore**）：

```
demo/
  workspaces.json                 # 工作区注册表 {current, list:[{id,name}]}
  settings.json                   # 个人凭证 + LLM 后端配置（含密钥）
  data/
    <工作区id>/
      notebook.json               # 该工作区的节点树 + 愿力账本
      workspace/<节点id>/         # 该节点的执行产物、git 克隆、重要发现.md
      assets/<节点id>/            # 该节点的图片
```

旧版布局（`demo/notebook.json`、`demo/workspace/`、`demo/assets/`）会在**首次启动新版**时自动迁移进 `data/default/`（「默认工作区」）。

**备份**：整个复制 `demo/data/` 即可。**迁移到新机**：连 `settings.json` 一起拷（注意含密钥）。

---

## 6. 执行器、沙箱与联网

执行器（自动执行笔记的智能体）通过 Claude Code 无头模式运行，`--dangerously-skip-permissions`，开放 `Read/Write/Edit/Glob/Grep/Bash/WebFetch/WebSearch`，工作目录锁定在该节点的 `workspace/<节点id>/`。

- **联网**：文档里写到的 git 仓库由**服务端**（无沙箱、用你本机 git+SSH）自动 clone/pull；抓网页/API 用 `WebFetch/WebSearch`（走服务器侧，能联网）。
- **Windows 注意**：Claude Code 的 Bash 沙箱**网络在原生 Windows 上不生效**（`curl/wget` 会挂起超时）。要在执行器里跑联网 Bash 命令，建议在 **WSL2** 里部署本 Demo。判断/对话层、服务端 git、`WebFetch` 不受此限。
- **纯 API Key、无 Claude Code**：判断/对话层照常工作（能聊天、建笔记、给愿力），但**自动执行器不会运行**（它依赖 Claude Code 的工具循环）。若需要，后续可接 Claude Agent SDK 作为执行后端。

---

## 7. 安全须知

- **`settings.json` 含密钥**（API Key、以及你填的 SSH 私钥/令牌等凭证），**已 gitignore，切勿提交或分享**。
- 执行器用 `--dangerously-skip-permissions` 在你**本机真实环境**跑，能读写文件、执行命令。只在你信任的机器上运行，别把不可信的文档丢进来自动执行。
- 若曾把长效令牌/API Key 贴到聊天或截图里，**尽快轮换**（`claude setup-token` 重出，或在 Anthropic 控制台吊销重建）。

---

## 8. 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 页面点了没反应、看不到新功能 | 浏览器缓存旧页面 → **`Ctrl+F5` 强制刷新**（server 每次请求实时读 `dashboard.html`，改前端无需重启）。 |
| 改了 `*.mjs` 不生效 | 后端改动需**重启** `node server.mjs`。 |
| `claude -p` 报 403 | 在普通终端跑 `claude setup-token` 生成长效令牌。 |
| 判断层报「backend=api 但没有 API Key」 | 在设置面板 / `settings.json.llm.apiKey` / `ANTHROPIC_API_KEY` 里配 Key。 |
| Anthropic API 报 401/400 | Key 错、模型名错，或自建网关地址不对；核对 `model` 与 `baseURL`。 |
| 执行器里 `curl` 超时 (exit 124) | 原生 Windows Bash 沙箱禁网 → 改用 `WebFetch`，或在 WSL2 部署。 |
| 端口被占 | 改 `server.mjs` 顶部 `PORT`，或关掉占用 5179 的进程。 |
| 笔记一直「❄ 冷却中」 | 连续多轮无新产出触发退避（间隔 90s→10→25→60min）；点节点里的「↺ 重置退避」，或去右边多聊两句补充愿力。 |

---

## 9. 长期 / 后台运行（可选）

**Linux/macOS（nohup）**：
```bash
cd demo && nohup node server.mjs > vw.log 2>&1 &
```

**pm2**：
```bash
npm i -g pm2
cd demo && pm2 start server.mjs --name volition && pm2 save
```

**Windows**：用 [pm2](https://pm2.keymetrics.io/) 或“任务计划程序”开机自启 `node D:\...\demo\server.mjs`。

> 这是本地开发原型：默认监听 `localhost`、无鉴权。若要暴露到公网，请自行加反向代理 + 认证，并重新评估执行器的权限风险。
