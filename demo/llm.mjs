/**
 * 大模型调用层（可插拔后端，DESIGN §4.11 LLMBackend）
 *
 * 「判断/对话类」调用（主Agent 对话、愿力打分等）可在两种后端间切换：
 *   1. claude-code —— 走本机 Claude Code CLI，按你的【订阅】计费（默认，无需 API Key）
 *   2. api         —— 走 Anthropic Messages API，按【API Key】计费（可换模型/自建网关）
 *
 * 选择方式（优先级：settings.json > 环境变量 > 默认）：
 *   settings.json: { "llm": { "backend": "api", "model": "claude-opus-4-8", "apiKey": "sk-...", "baseURL": "..." } }
 *   环境变量:       VW_LLM_BACKEND / VW_LLM_MODEL / ANTHROPIC_API_KEY / ANTHROPIC_BASE_URL
 *
 * 注意：本层只管【判断/对话】。执行器（agent.mjs runAgent，需要读写文件/跑命令的
 * 智能体循环）目前固定走 Claude Code；纯 API Key 模式下执行器不可用，详见 docs/DEPLOY.md。
 */
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { callClaudeText, callClaudeJson } from './agent.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SETTINGS_PATH = join(__dirname, 'settings.json');

/** 读取当前后端配置：settings.json 的 llm 段 覆盖 环境变量 覆盖 默认。 */
export function llmConfig() {
  let s = {};
  try { if (existsSync(SETTINGS_PATH)) s = JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')); } catch { /* 配置坏了就用默认 */ }
  const llm = s.llm || {};
  const backend = (llm.backend || process.env.VW_LLM_BACKEND || 'claude-code').toLowerCase();
  const apiKey = llm.apiKey || process.env.ANTHROPIC_API_KEY || '';
  const baseURL = (llm.baseURL || process.env.ANTHROPIC_BASE_URL || 'https://api.anthropic.com').replace(/\/$/, '');
  // 默认模型：API 用 Opus 4.8；Claude Code 用 sonnet（更省订阅额度）
  const model = llm.model || process.env.VW_LLM_MODEL || (backend === 'api' ? 'claude-opus-4-8' : 'sonnet');
  return { backend, apiKey, baseURL, model };
}

/** 直接调 Anthropic Messages API，返回最终文本 + 花费。 */
async function apiText(prompt, { model, apiKey, baseURL }) {
  if (!apiKey) throw new Error('LLM backend=api 但没有 API Key（在 settings.json.llm.apiKey 或环境变量 ANTHROPIC_API_KEY 里配）');
  const resp = await fetch(`${baseURL}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: 4096, messages: [{ role: 'user', content: prompt }] }),
  });
  if (!resp.ok) throw new Error(`Anthropic API ${resp.status}: ${(await resp.text()).slice(0, 300)}`);
  const data = await resp.json();
  const text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  // 粗略花费：按 Opus 4.8 价（输入 $5/M、输出 $25/M）估算，仅供参考
  const u = data.usage || {};
  const cost = ((u.input_tokens || 0) * 5 + (u.output_tokens || 0) * 25) / 1e6;
  return { text, cost };
}

/** 判断/对话类：拿模型最终【文本】（标签格式由调用方解析）。按当前后端分派。 */
export async function callText(prompt) {
  const cfg = llmConfig();
  if (cfg.backend === 'api') return apiText(prompt, cfg);
  return callClaudeText(prompt, { model: cfg.model }); // 订阅：复用 Claude Code CLI
}

/** 判断类：要求模型只输出 JSON，解析成对象（附 _cost）。按当前后端分派。 */
export async function callJson(prompt) {
  const cfg = llmConfig();
  if (cfg.backend !== 'api') return callClaudeJson(prompt, { model: cfg.model });
  const { text, cost } = await apiText(prompt, cfg);
  const m = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const parsed = JSON.parse((m ? m[1] : text).trim());
  parsed._cost = cost;
  return parsed;
}
