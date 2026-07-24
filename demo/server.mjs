#!/usr/bin/env node
/**
 * 愿力引擎 · 笔记本看板（零依赖）
 *
 * 自治引擎：服务一启动就常驻巡检——把「激发态」的笔记按愿力高低【自动】推进、
 * 按运行时长燃烧其愿力，烧到停机线自动停。用户无需点任何按钮，只管跟主Agent 聊。
 * 对应 DESIGN R7（Agent 即定时任务引擎）+ R8（能耗自动停机）+ R4（愿力越强越优先）。
 *
 * 计费走本机 Claude Code 订阅。运行：node server.mjs → http://localhost:5179
 */
import http from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, readdirSync, statSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { runAgent } from './agent.mjs';
import { CFG, will, refreshState, charge, tickGate, effectiveCooldownMs, isStuck, stuckCount } from './ledger.mjs';
import * as NB from './notebook.mjs';
import { converse } from './brain.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const dataRoot = join(__dirname, 'data');            // 每个工作区一个子目录：data/<wsId>/{notebook.json,workspace/,assets/}
const REG_PATH = join(__dirname, 'workspaces.json'); // 工作区注册表：{current, list:[{id,name,created}]}
const SETTINGS_PATH = join(__dirname, 'settings.json');
const PORT = 5179;
const FINDINGS = '重要发现.md';
const MIME = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml' };
const extOf = (name) => (name.match(/\.\w+$/) || [''])[0].toLowerCase();

// ================= 工作区（多笔记本）=================
// 每个工作区 = 一本独立笔记本，自带 notebook.json + 执行目录 + 图片，互不干扰。
// 切换工作区 = 打开另一本笔记本；引擎同时巡检【所有】工作区（激发态笔记后台并行推进，共用全局并发上限）。
let REG = null;
const wsDir = (ws) => join(dataRoot, ws);
const newWsId = () => 'ws_' + Date.now().toString(36) + Math.floor(Math.random() * 1e4).toString(36);
function saveReg(r) { REG = r; const tmp = REG_PATH + '.tmp'; writeFileSync(tmp, JSON.stringify(r, null, 2)); renameSync(tmp, REG_PATH); }
function ensureWorkspaces() {
  if (existsSync(REG_PATH)) return JSON.parse(readFileSync(REG_PATH, 'utf8'));
  mkdirSync(dataRoot, { recursive: true });
  const id = 'default';
  mkdirSync(wsDir(id), { recursive: true });
  // 迁移旧版单笔记本数据（demo/notebook.json、workspace/、assets/）到 data/default/
  const mv = (from, to) => { try { if (existsSync(from) && !existsSync(to)) renameSync(from, to); } catch { /* 跨盘或占用时忽略 */ } };
  mv(join(__dirname, 'notebook.json'), join(wsDir(id), 'notebook.json'));
  mv(join(__dirname, 'workspace'), join(wsDir(id), 'workspace'));
  mv(join(__dirname, 'assets'), join(wsDir(id), 'assets'));
  const reg = { current: id, list: [{ id, name: '默认工作区', created: Date.now() }] };
  saveReg(reg);
  return reg;
}
function getReg() { return REG || (REG = ensureWorkspaces()); }
function curWs() {
  const r = getReg();
  if (!r.list.some((w) => w.id === r.current)) { r.current = (r.list[0] || {}).id; saveReg(r); } // current 被删 → 兜底
  return r.current;
}
function nbPath(ws = curWs()) { return join(wsDir(ws), 'notebook.json'); }
function nodeWs(id, ws = curWs()) { return join(wsDir(ws), 'workspace', id); }
function assetDir(id, ws = curWs()) { return join(wsDir(ws), 'assets', id); }
const rk = (ws, id) => ws + '::' + id; // running 集合的复合键（避免跨工作区同名 id 撞车）

function createWorkspace(name) {
  const reg = getReg();
  const id = newWsId();
  mkdirSync(wsDir(id), { recursive: true });
  NB.resetNotebook(nbPath(id));                 // 新工作区 = 全新空笔记本
  reg.list.push({ id, name: (name || '新工作区').trim() || '新工作区', created: Date.now() });
  reg.current = id; saveReg(reg);
  return id;
}
function switchWorkspace(id) { const reg = getReg(); if (!reg.list.some((w) => w.id === id)) return false; reg.current = id; saveReg(reg); return true; }
function renameWorkspace(id, name) { const reg = getReg(); const w = reg.list.find((x) => x.id === id); if (w) { w.name = (name || w.name).trim() || w.name; saveReg(reg); } }
function deleteWorkspace(id) {
  const reg = getReg();
  if (reg.list.length <= 1) return false;       // 至少保留一个工作区
  reg.list = reg.list.filter((w) => w.id !== id);
  if (reg.current === id) reg.current = reg.list[0].id;
  saveReg(reg);
  try { rmSync(wsDir(id), { recursive: true, force: true }); } catch { /* 有进程占用时下次启动再清理 */ }
  return true;
}

// —— 个人凭证/配置（本地存储，含密钥，不进版本库）——
const loadSettings = () => existsSync(SETTINGS_PATH) ? JSON.parse(readFileSync(SETTINGS_PATH, 'utf8')) : { credentials: [] };
const saveSettings = (s) => { const tmp = SETTINGS_PATH + '.tmp'; writeFileSync(tmp, JSON.stringify(s, null, 2)); renameSync(tmp, SETTINGS_PATH); };
const ENGINE_INTERVAL_MS = 6000; // 引擎巡检间隔
const running = new Map();        // 正在执行：rk(ws,id) → AbortController（用于手动暂停/停止）
const MAX_CONCURRENT = 2;        // 最多同时跑几个笔记（订阅额度考虑；可调）

const json = (res, code, obj) => { res.writeHead(code, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(obj)); };
const text = (res, code, body, type = 'text/plain; charset=utf-8') => { res.writeHead(code, { 'Content-Type': type }); res.end(body); };
const readBody = (req) => new Promise((r) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => r(b)); });
const brief = (i) => { if (!i) return ''; const s = JSON.stringify(i); return s.length > 100 ? s.slice(0, 97) + '…' : s; };
const asText = (c) => Array.isArray(c) ? c.map((x) => x.text ?? '').join(' ') : (typeof c === 'string' ? c : JSON.stringify(c));

// —— 全局事件广播：引擎动态 → 所有打开的看板 ——
const clients = new Set();
function broadcast(obj) {
  const line = `data: ${JSON.stringify(obj)}\n\n`;
  for (const c of clients) { try { c.write(line); } catch { /* 断开的连接稍后清理 */ } }
}

function listFiles(id, wsId = curWs()) {
  const ws = nodeWs(id, wsId);
  // 递归展平：把子文件夹里的文件也列出来（相对路径），避免"打不开的文件夹"
  const walk = (sub) => {
    const dir = join(ws, sub);
    if (!existsSync(dir)) return [];
    let out = [];
    for (const f of readdirSync(dir)) {
      if (f === '.gitkeep') continue;
      const rel = sub ? sub + '/' + f : f;
      const s = statSync(join(dir, f));
      if (s.isDirectory()) out = out.concat(walk(rel));
      else out.push({ name: rel, size: s.size });
    }
    return out;
  };
  return existsSync(ws) ? walk('') : [];
}

// 服务端 git clone/pull（无沙箱、用本机真实 git + ~/.ssh），进节点工作目录
async function gitCloneOrPull(id, repoUrl, wsId = curWs()) {
  const ws = nodeWs(id, wsId); mkdirSync(ws, { recursive: true });
  const repoName = (String(repoUrl).replace(/\.git$/, '').split(/[\/:]/).pop() || 'repo').replace(/[^\w.\-]/g, '_');
  const dest = join(ws, repoName);
  const exists = existsSync(dest);
  const args = exists ? ['-C', dest, 'pull', '--ff-only'] : ['clone', '--depth', '1', repoUrl, dest];
  broadcast({ type: 'say', id, ws: wsId, text: `📥 ${exists ? 'git pull' : 'git clone'} ${repoName} …（服务端执行）` });
  const git = spawn('git', args, { env: process.env, shell: process.platform === 'win32' });
  let out = '';
  const killer = setTimeout(() => git.kill('SIGKILL'), 180000);
  git.stdout.on('data', (d) => (out += d)); git.stderr.on('data', (d) => (out += d));
  const code = await new Promise((r) => { git.on('close', r); git.on('error', () => r(-1)); });
  clearTimeout(killer);
  broadcast({ type: code === 0 ? 'say' : 'error', id, ws: wsId, text: `📥 ${repoName}: ${code === 0 ? '完成' : '失败(code ' + code + ')'}` });
  return { ok: code === 0, code, repoName, output: out.slice(-3000) };
}
// 交付物指纹：排除会一直增长的发现文件、.git、.claude —— 连续几次不变=没进展(或已完成)
function workspaceManifest(id, wsId = curWs()) {
  return listFiles(id, wsId)
    .filter((f) => !f.name.startsWith('重要发现') && !f.name.includes('.git/') && !f.name.includes('.claude/'))
    .map((f) => `${f.name}:${f.size}`).sort().join('|');
}
// 从文档里抽取 git 仓库地址（ssh 或 https .git）
function extractRepoUrls(textDoc) {
  const ssh = textDoc.match(/git@[\w.\-]+:[\w.\-/]+/g) || [];
  const https = textDoc.match(/https?:\/\/[\w.\-]+\/[\w.\-/]+\.git/g) || [];
  return [...new Set([...ssh, ...https])];
}
// 从文档里抽取【本地目录】路径（Windows 盘符 或 POSIX 绝对路径），只保留【真实存在的目录】
// → 执行时用 --add-dir 挂给执行器只读（原地读本地代码库，不复制、不 clone）
function extractLocalDirs(textDoc) {
  const win = textDoc.match(/[A-Za-z]:[\\/][^\s"'`<>|?*\n]+/g) || [];
  const posix = textDoc.match(/(?:^|\s)(\/(?:Users|home|mnt|opt|srv)\/[^\s"'`<>|?*\n]+)/g) || [];
  const cands = [...win, ...posix.map((s) => s.trim())];
  const out = [];
  for (let p of new Set(cands)) {
    p = p.replace(/[.,;:)\]}】，。、）]+$/, ''); // 去掉句末标点
    try { if (existsSync(p) && statSync(p).isDirectory()) out.push(p); } catch { /* 无效路径忽略 */ }
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  try {
    if (p === '/') return text(res, 200, readFileSync(join(__dirname, 'dashboard.html'), 'utf8'), 'text/html; charset=utf-8');
    if (p === '/api/cfg') return json(res, 200, { ...CFG, engineIntervalMs: ENGINE_INTERVAL_MS });
    if (p === '/api/settings') {
      if (req.method === 'POST') { saveSettings(JSON.parse((await readBody(req)) || '{}')); return json(res, 200, { ok: true }); }
      return json(res, 200, loadSettings());
    }
    if (p === '/api/tree') return json(res, 200, NB.treeView(NB.load(nbPath())));

    // —— 工作区（多笔记本）——
    if (p === '/api/workspaces') return json(res, 200, getReg());
    if (p === '/api/workspace/new' && req.method === 'POST') {
      const { name } = JSON.parse((await readBody(req)) || '{}');
      const id = createWorkspace(name);
      return json(res, 200, { id, reg: getReg(), tree: NB.treeView(NB.load(nbPath())) });
    }
    if (p === '/api/workspace/switch' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      if (!switchWorkspace(id)) return json(res, 400, { error: 'no such workspace' });
      return json(res, 200, { ok: true, reg: getReg(), tree: NB.treeView(NB.load(nbPath())) });
    }
    if (p === '/api/workspace/rename' && req.method === 'POST') {
      const { id, name } = JSON.parse((await readBody(req)) || '{}');
      renameWorkspace(id, name);
      return json(res, 200, { reg: getReg() });
    }
    if (p === '/api/workspace/delete' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      if (!deleteWorkspace(id)) return json(res, 400, { error: 'cannot delete the last workspace' });
      return json(res, 200, { reg: getReg(), tree: NB.treeView(NB.load(nbPath())) });
    }

    if (p === '/api/events') { // 全局引擎动态流
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
      res.write(': connected\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }

    if (p === '/api/node') {
      const nb = NB.load(nbPath());
      if (req.method === 'POST') {
        const { id, content, userNote, title } = JSON.parse((await readBody(req)) || '{}');
        const node = NB.getNode(nb, id);
        if (!node) return json(res, 404, { error: 'no node' });
        if (userNote != null) node.userNote = userNote; // 用户私人笔记：只有这条路径能写
        if (content != null) node.content = content;
        if (title) node.title = title;
        NB.save(nb, nbPath());
        return json(res, 200, { ok: true });
      }
      const node = NB.getNode(nb, url.searchParams.get('id'));
      if (!node) return json(res, 404, { error: 'no node' });
      refreshState(node.ledger);
      return json(res, 200, {
        id: node.id, title: node.title, kind: node.kind, content: node.content, userNote: node.userNote || '',
        will: +will(node.ledger).toFixed(1), state: node.ledger.state,
        stuck: isStuck(node.ledger), stuckCount: stuckCount(node.ledger), // 退避
        paused: !!node.paused,          // 手动暂停中
        running: running.has(rk(curWs(), node.id)), // 当前是否正在执行
        impulses: node.ledger.impulses.map((im) => ({ a: +im.a.toFixed(1), text: im.text || '', goal: im.goal || '' })).reverse(),
        chat: node.chat || [],          // 本笔记的对话线程
        runs: node.runs || [],          // 最近执行记录（时间正序）
      });
    }

    if (p === '/api/node/new' && req.method === 'POST') {
      const { parentId, title, kind } = JSON.parse((await readBody(req)) || '{}');
      const nb = NB.load(nbPath());
      const pid = parentId && NB.getNode(nb, parentId) ? parentId : 'root';
      const node = NB.addNode(nb, { parentId: pid, title: (title || '新笔记').trim() || '新笔记', kind: kind === 'folder' ? 'folder' : 'exec' });
      NB.save(nb, nbPath());
      return json(res, 200, { id: node.id, tree: NB.treeView(nb) });
    }
    if (p === '/api/node/delete' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      if (!id || id === 'root') return json(res, 400, { error: 'cannot delete' });
      const nb = NB.load(nbPath());
      const toDel = new Set();
      const collect = (x) => { toDel.add(x); NB.children(nb, x).forEach((c) => collect(c.id)); };
      collect(id);
      nb.nodes = nb.nodes.filter((n) => !toDel.has(n.id));
      NB.save(nb, nbPath());
      for (const d of toDel) { const ws = nodeWs(d); if (existsSync(ws)) rmSync(ws, { recursive: true, force: true }); }
      return json(res, 200, { tree: NB.treeView(nb) });
    }

    if (p === '/api/node/move' && req.method === 'POST') {
      const { id, newParentId } = JSON.parse((await readBody(req)) || '{}');
      const nb = NB.load(nbPath());
      const node = NB.getNode(nb, id);
      if (!node || id === 'root') return json(res, 400, { error: 'bad node' });
      const target = newParentId || 'root';
      if (!NB.getNode(nb, target)) return json(res, 400, { error: 'no target' });
      if (target === id) return json(res, 400, { error: 'self' });
      // 防环：target 不能是 id 自己的后代
      let cur = NB.getNode(nb, target);
      while (cur) { if (cur.id === id) return json(res, 400, { error: 'cycle' }); cur = cur.parentId ? NB.getNode(nb, cur.parentId) : null; }
      node.parentId = target;
      NB.save(nb, nbPath());
      return json(res, 200, { tree: NB.treeView(nb) });
    }

    if (p === '/api/node/reorder' && req.method === 'POST') {
      const { id, targetId, position } = JSON.parse((await readBody(req)) || '{}'); // position: before|after
      const nb = NB.load(nbPath());
      const node = NB.getNode(nb, id), target = NB.getNode(nb, targetId);
      if (!node || !target || id === 'root' || id === targetId) return json(res, 400, { error: 'bad' });
      // 防环：target 不能是 node 的后代
      let cur = target;
      while (cur) { if (cur.id === id) return json(res, 400, { error: 'cycle' }); cur = cur.parentId ? NB.getNode(nb, cur.parentId) : null; }
      node.parentId = target.parentId;                      // 与目标同级
      nb.nodes = nb.nodes.filter((n) => n.id !== id);       // 先摘出
      const ti = nb.nodes.findIndex((n) => n.id === targetId);
      nb.nodes.splice(position === 'after' ? ti + 1 : ti, 0, node); // 插到目标前/后
      NB.save(nb, nbPath());
      return json(res, 200, { tree: NB.treeView(nb) });
    }

    if (p === '/api/files') {
      const id = url.searchParams.get('id');
      const nb = NB.load(nbPath()); const favs = new Set(nb.favorites || []);
      const files = listFiles(id)
        .filter((f) => f.name !== FINDINGS && f.name !== '重要发现_已归档.md') // 发现单独展示
        .map((f) => ({ ...f, fav: favs.has(id + '::' + f.name) }));
      files.sort((a, b) => (b.fav - a.fav) || a.name.localeCompare(b.name)); // 收藏的排前面
      return json(res, 200, files);
    }
    if (p === '/api/file') {
      const id = url.searchParams.get('id'), name = url.searchParams.get('name') || '';
      const fp = join(nodeWs(id), name);
      if (!fp.startsWith(nodeWs(id)) || !existsSync(fp) || statSync(fp).isDirectory()) return json(res, 404, { error: 'not found' });
      return text(res, 200, readFileSync(fp, 'utf8'));
    }
    if (p === '/api/favorite' && req.method === 'POST') {
      const { id, name } = JSON.parse((await readBody(req)) || '{}');
      const nb = NB.load(nbPath()); nb.favorites = nb.favorites || [];
      const key = id + '::' + name;
      const i = nb.favorites.indexOf(key);
      if (i >= 0) nb.favorites.splice(i, 1); else nb.favorites.push(key);
      NB.save(nb, nbPath());
      return json(res, 200, { fav: i < 0 });
    }
    // —— 重要发现（Agent 执行中写入的单独文档；用户负责归档）——
    if (p === '/api/findings') {
      const fid = url.searchParams.get('id');
      stampFindings(fid); // 读取时也补戳：功能上线前写入的旧发现，一打开就补上时间（补当前时刻）
      const ws = nodeWs(fid);
      const fp = join(ws, FINDINGS), arc = join(ws, '重要发现_已归档.md');
      return json(res, 200, {
        content: existsSync(fp) ? readFileSync(fp, 'utf8') : '',
        archived: existsSync(arc) ? readFileSync(arc, 'utf8') : '',
      });
    }
    if (p === '/api/findings/archive' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      const fp = join(nodeWs(id), FINDINGS);
      if (existsSync(fp)) {
        const cur = readFileSync(fp, 'utf8');
        const arc = join(nodeWs(id), '重要发现_已归档.md');
        writeFileSync(arc, (existsSync(arc) ? readFileSync(arc, 'utf8') + '\n\n' : '') + `---\n${cur}`);
        writeFileSync(fp, ''); // 清空活跃发现
      }
      return json(res, 200, { ok: true });
    }
    // —— 笔记图片：上传 / 读取 / 列表 ——
    if (p === '/api/upload' && req.method === 'POST') {
      const { id, name, dataUrl } = JSON.parse((await readBody(req)) || '{}');
      const m = /^data:[^;]+;base64,(.+)$/s.exec(dataUrl || '');
      if (!id || !name || !m) return json(res, 400, { error: 'bad upload' });
      const safe = String(name).replace(/[^\w.\-]/g, '_') || ('img' + extOf(name));
      mkdirSync(assetDir(id), { recursive: true });
      writeFileSync(join(assetDir(id), safe), Buffer.from(m[1], 'base64'));
      return json(res, 200, { name: safe, url: `/api/asset?id=${encodeURIComponent(id)}&name=${encodeURIComponent(safe)}` });
    }
    if (p === '/api/asset') {
      const id = url.searchParams.get('id'), name = url.searchParams.get('name') || '';
      const fp = join(assetDir(id), name);
      if (!fp.startsWith(assetDir(id)) || !existsSync(fp)) return json(res, 404, { error: 'not found' });
      res.writeHead(200, { 'Content-Type': MIME[extOf(name)] || 'application/octet-stream' });
      return res.end(readFileSync(fp));
    }
    if (p === '/api/assets') {
      const id = url.searchParams.get('id'), dir = assetDir(id);
      const list = existsSync(dir) ? readdirSync(dir).filter((f) => MIME[extOf(f)]) : [];
      return json(res, 200, list.map((name) => ({ name, url: `/api/asset?id=${encodeURIComponent(id)}&name=${encodeURIComponent(name)}` })));
    }

    // —— 服务端 git clone/pull（不受执行器 Bash 沙箱限制，用你本机真实 git + ~/.ssh）——
    if (p === '/api/node/clone' && req.method === 'POST') {
      const { id, repoUrl } = JSON.parse((await readBody(req)) || '{}');
      if (!id || !repoUrl || !/^[\w@:.\/\-~]+$/.test(repoUrl)) return json(res, 400, { error: 'bad repo url' });
      return json(res, 200, await gitCloneOrPull(id, repoUrl));
    }
    if (p === '/api/node/unfreeze' && req.method === 'POST') { // 重置退避（立即可再跑）
      const { id } = JSON.parse((await readBody(req)) || '{}');
      const nb = NB.load(nbPath()); const node = NB.getNode(nb, id);
      if (!node) return json(res, 404, { error: 'no node' });
      node.ledger.stuck = { sig: '', count: 0 }; node.ledger.lastRun = 0;
      NB.save(nb, nbPath());
      return json(res, 200, { ok: true });
    }
    // 暂停 / 继续某条笔记：暂停=停手且引擎不再自动触发；继续=解除暂停
    if (p === '/api/node/pause' && req.method === 'POST') {
      const { id, paused } = JSON.parse((await readBody(req)) || '{}');
      const ws = curWs(); const nb = NB.load(nbPath(ws)); const node = NB.getNode(nb, id);
      if (!node) return json(res, 404, { error: 'no node' });
      node.paused = (paused === undefined) ? !node.paused : !!paused; // 不传则切换
      NB.save(nb, nbPath(ws));
      if (node.paused) {                              // 暂停：中止正在跑的执行
        const ctl = running.get(rk(ws, id));
        if (ctl) { try { ctl.abort(); } catch {} }
      }
      broadcast({ type: node.paused ? 'paused' : 'resumed', id, ws, title: node.title });
      return json(res, 200, { ok: true, paused: node.paused });
    }

    // 归档表达记录(L1)：把当前所有表达条目写成带时间戳的文档，清空列表，但【保留当前愿力】
    if (p === '/api/node/archive-l1' && req.method === 'POST') {
      const { id } = JSON.parse((await readBody(req)) || '{}');
      const ws = curWs(); const np = nbPath(ws); const nb = NB.load(np); const node = NB.getNode(nb, id);
      if (!node) return json(res, 404, { error: 'no node' });
      const imps = node.ledger.impulses || [];
      if (!imps.length) return json(res, 200, { ok: true, archived: 0 });
      // 生成带时间戳的归档文档（追加到笔记工作区的「表达记录_已归档.md」）
      const rows = imps.map((im) => {
        const when = im.t ? fmtStamp(new Date(im.t)) : '?';
        const goal = im.goal ? `　（目标：${im.goal}）` : '';
        return `- [${when}] +${(+im.a || 0).toFixed(1)}　${(im.text || '').replace(/\n/g, ' ')}${goal}`;
      });
      const section = `\n## 归档于 [${fmtStamp(new Date())}]（${imps.length} 条表达）\n${rows.join('\n')}\n`;
      const dir = nodeWs(id, ws); mkdirSync(dir, { recursive: true });
      const fp = join(dir, '表达记录_已归档.md');
      writeFileSync(fp, (existsSync(fp) ? readFileSync(fp, 'utf8') : `# 表达记录归档 · ${node.title}\n`) + section);
      // 保留当前愿力：把多条合并成一条 carry-over（不动 stuck/退避、不改状态）
      const W = will(node.ledger);
      node.ledger.impulses = W > 0
        ? [{ t: Date.now(), a: +W.toFixed(2), text: `（已归档 ${imps.length} 条表达，合并保留当前愿力 ${W.toFixed(1)}）`, archived: true }]
        : [];
      NB.save(nb, np);
      return json(res, 200, { ok: true, archived: imps.length, will: +W.toFixed(1) });
    }

    if (p === '/api/chat' && req.method === 'POST') return chat(res, await readBody(req));
    if (p === '/api/reset' && req.method === 'POST') { NB.resetNotebook(nbPath()); return json(res, 200, { ok: true, tree: NB.treeView(NB.load(nbPath())) }); }
    // 手动"催一下"（可选）：立刻触发某节点一次；效果与自治引擎相同，动态走全局事件流
    if (p === '/api/run') { runTick(curWs(), url.searchParams.get('id')); return json(res, 200, { ok: true }); }

    json(res, 404, { error: 'not found' });
  } catch (e) { json(res, 500, { error: String(e) }); }
});

// —— 主Agent 对话：每条笔记独立线程；有 id 就围绕该笔记，没 id 就新建一条 ——
async function chat(res, body) {
  const { id, message } = JSON.parse(body || '{}');
  if (!message || !message.trim()) return json(res, 400, { error: 'empty' });
  const msg = message.trim();
  const snapshot = NB.load(nbPath());
  const snapNode = id ? NB.getNode(snapshot, id) : null;
  let a;
  try { a = await converse({ message: msg, node: snapNode }); }
  catch (e) { return json(res, 500, { error: String(e) }); }

  const nb = NB.load(nbPath()); // 大模型思考期间用户可能改了笔记 → 重新加载，避免覆盖
  let node = id ? NB.getNode(nb, id) : null;
  if (!node) node = NB.addNode(nb, { parentId: 'root', title: (a.title || msg.slice(0, 24)).trim() || '新笔记', content: a.content || '', kind: 'exec' });
  else if (a.content && a.content.trim()) node.content = a.content; // 只更新主Agent 纲要(content)，绝不碰 userNote

  node.chat = node.chat || [];
  node.chat.push({ role: 'user', text: msg, ts: Date.now() });
  node.chat.push({ role: 'assistant', text: a.reply || '（已记下）', ts: Date.now() });
  const amt = Math.max(0, Math.round(Number(a.amplitude) || 0));
  if (amt > 0) charge(node.ledger, amt, { text: msg, goal: a.goal || '' });
  NB.save(nb, nbPath());

  json(res, 200, { reply: a.reply || '（已记下）', amplitude: amt, nodeId: node.id, tree: NB.treeView(nb), cost: a._cost || 0 });
}

// —— 给新增的重要发现打时间戳 ——
// Agent 每轮把新发现「每条一行」追加进 重要发现.md。执行结束后由 server 给还没有时间戳的行
// 打上【带时区偏移的 ISO 时刻】（如 2026-07-20T14:00:00+08:00）；已打过的行保持不变。
// 记录的是绝对时刻 → 前端按【浏览器本地时区】显示，即使 server 跑在 UTC(WSL/容器) 也对齐你的表。
function fmtStamp(d) {
  const p = (n) => String(n).padStart(2, '0');
  const off = -d.getTimezoneOffset(), abs = Math.abs(off);          // 本机时区偏移（分钟）
  const tz = `${off >= 0 ? '+' : '-'}${p(Math.floor(abs / 60))}:${p(abs % 60)}`;
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}${tz}`;
}
// 行首是否已有时间戳（兼容带时区 ISO 与旧「日期 空格 时间」两种格式，避免重复打戳）
const STAMP_RE = /^\s*\[\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/;
function stampFindings(id, wsId = curWs()) {
  const fp = join(nodeWs(id, wsId), FINDINGS);
  if (!existsSync(fp)) return;
  const raw = readFileSync(fp, 'utf8');
  const stamp = fmtStamp(new Date());
  const out = raw.split('\n').map((line) => {
    if (!line.trim()) return line;          // 空行不动
    if (STAMP_RE.test(line)) return line;   // 已有时间戳 → 保持原样（保留首次记录时间）
    return `[${stamp}] ${line}`;
  }).join('\n');
  if (out !== raw) { try { writeFileSync(fp, out); } catch { /* 写不了就算了 */ } }
}

// —— 单节点执行：按该节点愿力做功、按时间燃烧；动态广播给所有看板 ——
// wsId = 该节点所属工作区；所有路径/账本读写都限定在这个工作区内。
async function runTick(wsId, id) {
  const key = rk(wsId, id);
  if (running.has(key) || running.size >= MAX_CONCURRENT) return; // 同节点不重入；总并发有上限（跨工作区共用）
  const np = nbPath(wsId);
  const nb = NB.load(np);
  const node = NB.getNode(nb, id);
  if (!node) return;
  if (node.paused) { NB.save(nb, np); broadcast({ type: 'refused', id, ws: wsId, title: node.title, reason: 'paused' }); return; } // 手动暂停中，不执行
  const gate = tickGate(node.ledger);
  if (!gate.allowed) { NB.save(nb, np); broadcast({ type: 'refused', id, ws: wsId, title: node.title, reason: gate.reason, will: +gate.will.toFixed(1) }); return; }
  // 执行文档 = 本节点内容 + 所有子笔记（子笔记是对这件事的补充/细化）
  const docText = NB.subtreeDoc(nb, id);
  if (!docText.trim()) { NB.save(nb, np); broadcast({ type: 'refused', id, ws: wsId, title: node.title, reason: 'empty_doc' }); return; }

  const controller = new AbortController();
  running.set(key, controller);      // 存控制器，供手动暂停时中止
  node.ledger.lastRun = Date.now(); // 冷却起点：执行不扣愿力，用冷却间隔防止连轰
  NB.save(nb, np);
  broadcast({ type: 'start', id, ws: wsId, title: node.title, will: +gate.will.toFixed(1) });
  const ws = nodeWs(id, wsId);
  mkdirSync(ws, { recursive: true });
  try {
    // 执行前：文档里写到的 git 仓库，自动 clone/pull 到工作目录（server 无沙箱、能联网）
    for (const u of extractRepoUrls(docText)) { try { await gitCloneOrPull(id, u, wsId); } catch { /* 单个失败不阻断 */ } }
    // 文档里写到的【本地目录】挂给执行器只读（原地读本地代码库）
    const addDirs = extractLocalDirs(docText);
    if (addDirs.length) broadcast({ type: 'say', id, ws: wsId, text: `📂 已挂载本地目录(只读)：${addDirs.join(' , ')}` });
    const r = await runAgent({
      docText, workspace: ws, addDirs, signal: controller.signal,
      onEvent: (ev) => {
        if (ev.type === 'system' && ev.subtype === 'init') broadcast({ type: 'init', id, ws: wsId, model: ev.model });
        else if (ev.type === 'assistant') for (const b of ev.message?.content ?? []) {
          if (b.type === 'text' && b.text?.trim()) broadcast({ type: 'say', id, ws: wsId, text: b.text.trim() });
          else if (b.type === 'tool_use') broadcast({ type: 'tool', id, ws: wsId, name: b.name, input: brief(b.input) });
        } else if (ev.type === 'user') for (const b of ev.message?.content ?? []) {
          if (b.type === 'tool_result' && b.is_error) broadcast({ type: 'error', id, ws: wsId, text: asText(b.content) });
        }
      },
    });
    stampFindings(id, wsId); // 给本轮新写入的重要发现补时间戳（发现文件不参与放呆指纹，不影响退避）
    if (r.aborted) { // 手动暂停中止：不算卡住、不记这次执行
      broadcast({ type: 'paused', id, ws: wsId, title: node.title });
      return;
    }
    // 放呆：交付物指纹连续几次没变 → 卡住计数++，冷却指数退避（不硬停，让愿力自然衰减）
    const nb2 = NB.load(np); const node2 = NB.getNode(nb2, id);
    let becameStuck = false;
    if (node2) {
      const sig = workspaceManifest(id, wsId);
      const st = node2.ledger.stuck || { sig: '', count: 0 };
      node2.ledger.stuck = (sig === st.sig) ? { sig, count: st.count + 1 } : { sig, count: 1 };
      becameStuck = node2.ledger.stuck.count === CFG.stuckAfter; // 刚跨过阈值
      // 存执行记录（持久化，切回笔记也能看到）
      node2.runs = node2.runs || [];
      node2.runs.push({ ts: Date.now(), seconds: +(r.elapsedMs / 1000).toFixed(1), summary: (r.summary || '').slice(0, 400) });
      if (node2.runs.length > 20) node2.runs = node2.runs.slice(-20);
      NB.save(nb2, np);
    }
    broadcast({
      type: 'result', id, ws: wsId, title: node.title,
      seconds: +(r.elapsedMs / 1000).toFixed(1),
      will: node2 ? +will(node2.ledger).toFixed(1) : 0,
      summary: r.summary,
    });
    if (becameStuck) broadcast({ type: 'stuck', id, ws: wsId, title: node.title });
  } catch (e) {
    broadcast({ type: 'error', id, ws: wsId, text: String(e) });
  } finally {
    running.delete(key);
  }
}

// —— 自治引擎：常驻巡检【所有工作区】，并发推进激发态的笔记（愿力越高越优先，R4）——
// 不管你在看哪个工作区，各工作区里激发态的笔记都在后台并行推进，共用全局并发上限。
function engineCycle() {
  const slots = MAX_CONCURRENT - running.size;
  if (slots <= 0) return;
  const now = Date.now();
  const candidates = [];
  for (const w of getReg().list) {
    const np = nbPath(w.id);
    let nb; try { nb = NB.load(np); } catch { continue; } // 工作区可能刚被删
    let changed = false;
    for (const n of nb.nodes) {
      if (n.kind !== 'exec' || n.paused || !n.content || !n.content.trim() || running.has(rk(w.id, n.id))) continue;
      const before = n.ledger.state; refreshState(n.ledger); if (n.ledger.state !== before) changed = true;
      // 激发态 且 距上次执行已过【退避后的】冷却间隔（卡住越久间隔越长，愿力照常衰减）
      if (n.ledger.state === 'IGNITED' && (now - (n.ledger.lastRun || 0) >= effectiveCooldownMs(n.ledger)))
        candidates.push({ ws: w.id, id: n.id, w: will(n.ledger) });
    }
    if (changed) NB.save(nb, np); // 落盘刚才 refreshState 触发的熄火/激发变化
  }
  candidates.sort((a, b) => b.w - a.w);
  for (const c of candidates.slice(0, slots)) runTick(c.ws, c.id); // 一次填满空闲并发位（跨工作区按愿力择优）
}
getReg(); // 启动即初始化工作区注册表（首次运行会把旧版单笔记本迁移到 data/default/）
setInterval(engineCycle, ENGINE_INTERVAL_MS);
setInterval(() => broadcast({ type: 'ping' }), 20000); // 保活 SSE

server.listen(PORT, () => console.log(`\n📓 愿力笔记本（自治引擎已启动，每 ${ENGINE_INTERVAL_MS / 1000}s 巡检）：http://localhost:${PORT}\n   (Ctrl+C 退出)\n`));
