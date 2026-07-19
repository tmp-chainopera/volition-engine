/**
 * 笔记本数据模型（文档树，DESIGN §4.9）
 * 一棵可嵌套的节点树；每个节点是一个"想做的事"，带自己的愿力账本。
 * 能量数学复用 ./ledger.mjs（对节点的 ledger 计算）。
 */
import { readFileSync, writeFileSync, existsSync, renameSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { will, refreshState, isStuck } from './ledger.mjs';

export const emptyLedger = () => ({ impulses: [], state: 'DORMANT', lastRun: 0 });

function seed() {
  return {
    nodes: [
      { id: 'root', parentId: null, title: '我的愿力笔记本', kind: 'folder', content: '', ledger: emptyLedger() },
    ],
  };
}

// nbPath = 该工作区的 notebook.json 绝对路径（由 server 传入，见 server.mjs 的 nbPath(ws)）
export const load = (nbPath) => (existsSync(nbPath) ? JSON.parse(readFileSync(nbPath, 'utf8')) : seed());

// 原子写入：先写临时文件再 rename，避免写一半崩溃损坏笔记本。
export const save = (nb, nbPath) => {
  const tmp = nbPath + '.tmp';
  writeFileSync(tmp, JSON.stringify(nb, null, 2));
  renameSync(tmp, nbPath);
};
export const resetNotebook = (nbPath) => { const nb = seed(); save(nb, nbPath); return nb; };

export const getNode = (nb, id) => nb.nodes.find((n) => n.id === id);
export const children = (nb, id) => nb.nodes.filter((n) => n.parentId === id);

let _seq = 0;
export const newId = () => 'n_' + Date.now().toString(36) + (_seq++);

export function addNode(nb, { parentId = 'root', title, content = '', kind = 'exec' }) {
  // userNote = 用户私人笔记；主Agent 永不写此字段（结构性保证：不会被覆盖）
  // chat = 本笔记独立的对话线程（与笔记绑定、持久化）
  const node = { id: newId(), parentId, title, kind, content, userNote: '', chat: [], ledger: emptyLedger() };
  nb.nodes.push(node);
  return node;
}

export function depth(nb, node) {
  let d = 0, cur = node;
  while (cur && cur.parentId) { cur = getNode(nb, cur.parentId); d++; }
  return d;
}

/** 树视图：每个节点带上实时算出的 will/state（供前端渲染） */
export function treeView(nb) {
  return nb.nodes.map((n) => {
    refreshState(n.ledger);
    return {
      id: n.id, parentId: n.parentId, title: n.title, kind: n.kind,
      will: +will(n.ledger).toFixed(1), state: n.ledger.state,
      impulses: n.ledger.impulses.length,
      stuck: isStuck(n.ledger),           // 连续无新产出 → 退避中（红标）
    };
  });
}

/**
 * 执行用文档：把「节点自身内容 + 所有有内容的子孙笔记」聚合成一份文档。
 * 因为子笔记是对父节点这件事的补充/细化——人可能在子笔记里加约束、细节。
 */
export function subtreeDoc(nb, id) {
  const node = getNode(nb, id);
  if (!node) return '';
  let out = ownDoc(node);
  const kids = children(nb, id).filter((c) => hasAnyContent(nb, c));
  if (kids.length) {
    out += '\n\n---\n以下是本条目的「子笔记」（对上面这件事的补充/细化），执行时请一并参考并遵守：\n\n';
    out += kids.map((c) => renderChild(nb, c, 1)).join('\n\n');
  }
  return out.trim();
}
// 单节点自身文档 = 主Agent 纲要 + 用户笔记（冲突以用户笔记为准）
function ownDoc(node) {
  let s = (node.content || '').trim();
  const un = (node.userNote || '').trim();
  if (un) s += (s ? '\n\n' : '') + '【我的笔记（用户亲写，如与上文冲突，以此为准）】\n' + un;
  return s;
}
function hasAnyContent(nb, node) {
  if ((node.content && node.content.trim()) || (node.userNote && node.userNote.trim())) return true;
  return children(nb, node.id).some((c) => hasAnyContent(nb, c));
}
function renderChild(nb, node, level) {
  const hashes = '#'.repeat(Math.min(6, level + 2));
  let out = `${hashes} ${node.title}`;
  const own = ownDoc(node);
  if (own) out += '\n' + own;
  for (const c of children(nb, node.id).filter((k) => hasAnyContent(nb, k))) {
    out += '\n\n' + renderChild(nb, c, level + 1);
  }
  return out;
}

/** 给主Agent 看的紧凑树文本（带 id 和缩进） */
export function treeText(nb) {
  const lines = nb.nodes
    .filter((n) => n.id !== 'root')
    .map((n) => `- [${n.id}] ${'  '.repeat(Math.max(0, depth(nb, n) - 1))}${n.title}（${n.kind}）`);
  return lines.join('\n');
}

/** 给主Agent 的笔记本快照：每个节点的 id / 标题 / 现有内容——用于合并时保留已有内容 */
export function notebookDump(nb) {
  return nb.nodes.filter((n) => n.id !== 'root').map((n) => {
    let s = `### [${n.id}] ${n.title}\n${(n.content || '').trim() || '(空)'}`;
    const un = (n.userNote || '').trim();
    if (un) s += `\n[用户私人笔记，只读——绝不要在你的 content 里改动、复述或覆盖它]:\n${un}`;
    return s;
  }).join('\n\n');
}
