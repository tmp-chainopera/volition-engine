/**
 * 愿力账本核心逻辑（纯逻辑 + 文件读写），供 CLI(volition.mjs) 与看板(server.mjs) 共用。
 * 对应 DESIGN §2 愿力动力学、§2.3 按时间燃烧、§3 状态机、§4.2 账本。
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const LEDGER_PATH = join(__dirname, 'ledger.json');

// —— 愿力参数（可调）——
export const CFG = {
  halfLifeHours: 6,        // 衰减半衰期（愿力唯一的减少方式：随时间淡忘）
  igniteAt: 20,            // θ_hi 激发阈值（≥ 进入激发态、引擎自动执行）
  suspendAt: 5,            // θ_lo 熄火阈值（衰减跌破 → 停机；低于 θ_hi 形成迟滞）
  chargePerReinforce: 30,  // 一次「强化」默认充多少
  stuckAfter: 3,           // 连续几次无新产出算"卡住"，进入冷却
  // 冷却间隔阶梯（秒）：正常 90s；卡住后依次 10min / 25min / 60min，到顶停在 60min
  backoffSchedule: [90, 600, 1500, 3600],
};

export const loadLedger = () =>
  existsSync(LEDGER_PATH) ? JSON.parse(readFileSync(LEDGER_PATH, 'utf8')) : { impulses: [], burned: 0, state: 'DORMANT' };
export const saveLedger = (l) => writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2));

// 愿力 = Σ 脉冲(半衰期衰减)。执行【不】扣愿力；愿力只随时间衰减。
export function will(l, now = Date.now()) {
  return Math.max(0, l.impulses.reduce((s, imp) => {
    const ageH = (now - imp.t) / 3.6e6;
    return s + imp.a * Math.pow(0.5, ageH / CFG.halfLifeHours);
  }, 0));
}

// 迟滞状态机：越过 θ_hi 激发、跌破 θ_lo 熄火、中间保持
export function refreshState(l) {
  const w = will(l);
  if (w >= CFG.igniteAt) l.state = 'IGNITED';
  else if (w < CFG.suspendAt) l.state = 'SUSPENDED';
  return l.state;
}

export function charge(l, amount = CFG.chargePerReinforce, meta = {}) {
  l.impulses.push({ t: Date.now(), a: amount, ...meta });
  if (l.stuck) l.stuck = { sig: '', count: 0 }; // 新表达 = 重置退避、重新起跑
  refreshState(l);
  return l;
}

// —— 放呆（退避而非硬停）——
// 连续无新产出 N 次算"卡住"；之后冷却间隔指数增长，让它跑得越来越慢，
// 愿力照常随时间衰减，最终降到停机线自然彻底停。不硬冻。
export const stuckCount = (l) => (l.stuck && l.stuck.count) || 0;
export const isStuck = (l) => stuckCount(l) >= CFG.stuckAfter;
export function effectiveCooldownMs(l) {
  const level = Math.max(0, stuckCount(l) - (CFG.stuckAfter - 1)); // 0=未卡住；1,2,3…=冷却档
  const s = CFG.backoffSchedule;
  return s[Math.min(level, s.length - 1)] * 1000;
}

// 触发闸门：这一 tick 能不能做功
export function tickGate(l) {
  const w = will(l);
  refreshState(l);
  if (l.state !== 'IGNITED') return { allowed: false, reason: 'not_ignited', will: w, state: l.state };
  return { allowed: true, will: w, state: l.state };
}
