/**
 * 执行器核心：驱动 claude 无头模式，让 agent 读《活文档》并落地文件产物。
 * 被 run-agent.mjs（裸执行）和 volition.mjs（套愿力账本）共用。
 * 计费走本机 Claude Code 订阅（主动删除 ANTHROPIC_API_KEY）。
 */
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

// 执行器角色：忠实落地文档意图，不发散（对应 DESIGN 两条护栏）。
const SYSTEM = [
  '你是「愿力引擎」的执行器（executor）。',
  '你的唯一任务：忠实地把用户提供的《活文档》里的意图，落地为当前工作目录中的实际文件产物。',
  '严格遵守文档的目标与约束；不要超出文档范围自作主张，不要添加文档没要求的东西。',
  '所有产物文件【直接写在当前目录下，不要创建子文件夹】，方便用户查看。',
  '【严禁用 Bash 执行任何联网命令】（curl/wget/git clone/git pull/pip 联网安装 等）——本机 Bash 沙箱禁网，这类命令会挂起直到超时（exit 124），纯属浪费。',
  '需要联网获取网页/API 数据时，【一律改用 WebFetch / WebSearch 工具】；它们走服务器、能联网。',
  '文档里提到的 git 仓库，系统已在执行前自动 clone/pull 到当前目录了——你直接读那些文件即可，不要自己再 clone。',
  '【运行环境】本机装了 Node.js，但【不一定装了 Python】——Windows 上 python/python3 常是应用商店占位符，一运行就报「Python was not found」(exit 49)，别浪费步骤去试。需要写脚本/做数据处理/计算时【一律优先用 Node.js（node xxx.mjs）】，不要假设有 python/pip/pandas 等；确有必要且已确认存在的工具才用。',
  '执行过程中若有【有价值的发现】（关键结论、意外情况、值得记住的洞察），追加写入当前目录的 `重要发现.md`（每条一行）。',
  '【铁律：写重要发现时只写发现正文本身，行首【绝对不要】自己加任何日期/时间/时间戳（例如 `[2026-07-20 20:10:00]`、`23:58:00 - …`）——时间戳由系统在写入后统一添加，且以系统时间为准。你自己写的时间几乎必然是错的（甚至是未来时间），会污染整份记录。正文里引用某个事件发生在哪天可以，但【行首不许有时间前缀】。】',
  '【严禁】把"又收到同样的文档 / 无新进展 / 重复执行 / 我第几次跑 / 又验证了一遍"这类关于执行过程本身的元观察写进重要发现——那不是发现，是噪音。没有真正的新发现就【什么都别写】。',
  '每做一步先用一句话说明你在做什么。全部完成后，用一句话列出你产出了哪些文件。',
].join('\n');

/**
 * 跑一次执行。返回 { code, elapsedMs, costUsd, turns, summary }。
 * onEvent 收到解析后的 stream-json 事件（或 {type:'raw', line}）。
 */
// 杀掉执行进程（Windows 下 shell:true 会有子进程树，用 taskkill /T 连根拔）
function killTree(child) {
  try {
    if (process.platform === 'win32' && child.pid) spawn('taskkill', ['/pid', String(child.pid), '/T', '/F']);
    else child.kill('SIGKILL');
  } catch { /* 已退出就忽略 */ }
}

export function runAgent({ docPath, docText, workspace, addDirs = [], signal = null, onEvent = () => {} }) {
  const doc = docText != null ? docText : readFileSync(docPath, 'utf8');

  // 所有多行内容走 stdin，绝不进命令行参数（Windows/cmd 下换行参数会被截断）。
  const localNote = addDirs.length
    ? '\n【本地代码库】以下本地目录已挂载为可读（--add-dir），可直接用 Read/Glob/Grep 读取，不要去 clone：\n' + addDirs.map((d) => '  - ' + d).join('\n') + '\n'
    : '';
  const prompt = [
    SYSTEM, localNote,
    '下面三横线之间是《活文档》（执行纲要）。请在当前工作目录中执行它描述的意图：', '',
    '---', doc.trim(), '---', '',
    '现在开始执行。',
  ].join('\n');

  const args = [
    '-p', '--model', 'sonnet',
    '--output-format', 'stream-json', '--verbose',
    // 无头运行、没人能点"允许"，所以彻底跳过所有权限检查（含网络）。
    // ⚠️ 已开放完整执行环境：Bash（跑代码/git/curl）+ 联网。用的是你本机真实环境与凭据。
    '--dangerously-skip-permissions',
    '--tools', 'Read,Write,Edit,Glob,Grep,Bash,WebFetch,WebSearch',
    // 把文档里写到的本地目录挂进来供只读（原地读，不复制/不 clone）
    ...addDirs.flatMap((d) => ['--add-dir', d]),
  ];

  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; // 强制走订阅

  // 放行 Bash 沙箱网络：写工作目录的 .claude/settings.json（避开命令行传 JSON 的转义坑）。
  // 注意：该沙箱官方仅支持 macOS/Linux/WSL2，原生 Windows 可能不生效。
  try {
    mkdirSync(join(workspace, '.claude'), { recursive: true });
    writeFileSync(join(workspace, '.claude', 'settings.json'),
      JSON.stringify({ sandbox: { network: { allowedDomains: ['*'] } } }, null, 2));
  } catch { /* 忽略：写不了就按默认沙箱来 */ }

  const start = Date.now();
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, {
      cwd: workspace, env,
      shell: process.platform === 'win32',
      stdio: ['pipe', 'pipe', 'inherit'],
    });
    const result = { code: null, elapsedMs: 0, costUsd: 0, turns: 0, summary: '', aborted: false };

    // 暂停/停止：外部 abort → 连根杀掉执行进程
    if (signal) {
      if (signal.aborted) killTree(child);
      else signal.addEventListener('abort', () => { result.aborted = true; killTree(child); }, { once: true });
    }

    child.stdin.write(prompt);
    child.stdin.end();

    let buf = '';
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let ev;
        try { ev = JSON.parse(line); } catch { onEvent({ type: 'raw', line }); continue; }
        if (ev.type === 'result') {
          result.costUsd = ev.total_cost_usd ?? 0;
          result.turns = ev.num_turns ?? 0;
          result.summary = ev.result ?? '';
        }
        onEvent(ev);
      }
    });

    child.on('error', reject);
    child.on('close', (code) => {
      if (buf.trim()) { try { onEvent(JSON.parse(buf.trim())); } catch { onEvent({ type: 'raw', line: buf.trim() }); } }
      result.code = code;
      result.elapsedMs = Date.now() - start;
      resolve(result);
    });
  });
}

/**
 * 「判断类」调用：拿模型最终输出的【原始文本】（信封是合法 JSON，但里面的文本不强制 JSON）。
 * 用于标签格式解析——比让模型输出 JSON 更稳（不怕引号/换行没转义）。走订阅计费。
 */
export function callClaudeText(prompt, { model = 'sonnet', tools = null } = {}) {
  const args = ['-p', '--model', model, '--output-format', 'json'];
  // 可选：给判断层挂只读联网工具（主Agent 边聊边查）。无头没人批准 → 跳过权限（只读，安全）。
  if (tools) args.push('--tools', tools, '--dangerously-skip-permissions');
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stdin.write(prompt);
    child.stdin.end();
    child.on('error', reject);
    child.on('close', () => {
      try { const env2 = JSON.parse(out); resolve({ text: String(env2.result ?? ''), cost: env2.total_cost_usd ?? 0 }); }
      catch (e) { reject(new Error('调用解析失败：' + e.message + '\n原始：' + out.slice(0, 300))); }
    });
  });
}

/**
 * 「判断类」调用：一次轻量 LLM 请求，要求模型只输出 JSON，解析并返回对象（附 _cost）。
 * 供采集/主Agent 等判断类用途。走订阅计费。
 */
export function callClaudeJson(prompt, { model = 'sonnet' } = {}) {
  const args = ['-p', '--model', model, '--output-format', 'json'];
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY;
  return new Promise((resolve, reject) => {
    const child = spawn('claude', args, { env, shell: process.platform === 'win32', stdio: ['pipe', 'pipe', 'inherit'] });
    let out = '';
    child.stdout.on('data', (c) => (out += c.toString()));
    child.stdin.write(prompt);
    child.stdin.end();
    child.on('error', reject);
    child.on('close', () => {
      try {
        const envelope = JSON.parse(out);
        const raw = String(envelope.result ?? '').trim();
        const parsed = JSON.parse(stripFence(raw));
        parsed._cost = envelope.total_cost_usd ?? 0;
        resolve(parsed);
      } catch (e) {
        reject(new Error('JSON 调用解析失败：' + e.message + '\n原始输出：' + out.slice(0, 400)));
      }
    });
  });
}
function stripFence(s) {
  const m = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  return m ? m[1].trim() : s;
}

/** 把 stream-json 事件翻译成人话（供两个入口共用）。 */
export function printEvent(ev) {
  switch (ev.type) {
    case 'raw': console.log(ev.line); break;
    case 'system':
      if (ev.subtype === 'init') console.log(`⚙️  会话就绪 (model=${ev.model ?? '?'})`);
      break;
    case 'assistant':
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'text' && b.text?.trim()) console.log(`💬 ${b.text.trim()}`);
        else if (b.type === 'tool_use') console.log(`🔧 ${b.name} ${brief(b.input)}`);
      }
      break;
    case 'user':
      for (const b of ev.message?.content ?? []) {
        if (b.type === 'tool_result' && b.is_error) console.log(`⚠️  工具报错: ${asText(b.content)}`);
      }
      break;
    // result 由各入口自行汇总，这里不重复打印
  }
}

function brief(input) {
  if (!input) return '';
  const s = JSON.stringify(input);
  return s.length > 120 ? s.slice(0, 117) + '…' : s;
}
function asText(c) {
  if (typeof c === 'string') return c;
  if (Array.isArray(c)) return c.map((x) => x.text ?? '').join(' ');
  return JSON.stringify(c);
}
