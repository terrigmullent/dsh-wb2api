/**
 * 「保留哪些模型」的核心逻辑：把活的模型清单 + 用户的保留列表，算成要写进 DSH 设置的那份 models 数组。
 * 纯函数，不碰 IO，便于离线测试。
 */
import { toModelProfile } from './wb2api.js';

/** 取模型 id 的 realm 前缀（cn / global），没有前缀返回 null。 */
export function realmOf(id) {
  const i = String(id).indexOf(':');
  return i > 0 ? String(id).slice(0, i) : null;
}

/**
 * 过滤出某个 realm 的模型；realm 为 null/undefined 表示不过滤。
 * @param {any[]} models /v1/models 的 data
 * @param {string|null} [realm]
 */
export function listModels(models, realm = null) {
  const all = Array.isArray(models) ? models : [];
  return realm ? all.filter((m) => realmOf(m.id) === realm) : all;
}

/**
 * 算出最终要保留的模型 id 列表。
 * keep 为空数组时表示"全部保留"。
 *
 * @param {any[]} models 服务实际提供的模型
 * @param {string[]} [keep] 用户指定的 id
 * @param {{realm?: string|null}} [opts]
 * @returns {{ids: string[], missing: string[], all: string[]}}
 */
export function resolveKeep(models, keep = [], opts = {}) {
  const available = listModels(models, opts.realm ?? null);
  const all = available.map((m) => m.id);
  const wanted = (keep ?? []).map((s) => String(s).trim()).filter(Boolean);
  if (wanted.length === 0) return { ids: all, missing: [], all };
  const set = new Set(all);
  const ids = wanted.filter((id) => set.has(id));
  const missing = wanted.filter((id) => !set.has(id));
  return { ids, missing, all };
}

/**
 * 生成要写进 pi-ai 设置 `providers.<id>.models` 的数组。
 * 已经在设置里存在的 id 保留它原有的字段（用户可能手工调过 contextWindow 等），
 * 新出现的 id 用服务端元数据补齐。
 *
 * @param {any[]} models /v1/models 的 data
 * @param {string[]} ids 最终要保留的 id
 * @param {Array<{id: string}>} [existing] 设置里现有的 models
 * @returns {Array<object>}
 */
export function buildProfiles(models, ids, existing = []) {
  const byId = new Map((models ?? []).map((m) => [m.id, m]));
  const prev = new Map((existing ?? []).map((e) => [e?.id, e]).filter(([id]) => id));
  return ids.map((id) => {
    const kept = prev.get(id);
    if (kept) {
      // 复用旧条目：保留用户改过的字段，只补上缺失的 id
      return { ...kept, id };
    }
    const info = byId.get(id);
    return info ? toModelProfile(info) : { id };
  });
}

/**
 * 对比新旧 models 数组，给出一行摘要与增删列表。
 */
export function diffProfiles(before = [], after = []) {
  const b = new Set((before ?? []).map((m) => m?.id).filter(Boolean));
  const a = new Set((after ?? []).map((m) => m?.id).filter(Boolean));
  const added = [...a].filter((id) => !b.has(id));
  const removed = [...b].filter((id) => !a.has(id));
  const unchanged = added.length === 0 && removed.length === 0;
  return {
    changed: !unchanged,
    added,
    removed,
    summary: unchanged
      ? `模型清单无变化（${a.size} 个）`
      : `模型清单更新：${a.size} 个${added.length ? `，新增 ${added.join(', ')}` : ''}${removed.length ? `，移除 ${removed.join(', ')}` : ''}`,
  };
}

/**
 * 把模型清单渲染成给模型/用户看的表格文本。
 * @param {any[]} models
 * @param {string[]} keep
 * @param {{realm?: string|null, limit?: number}} [opts]
 */
export function formatModelTable(models, keep = [], opts = {}) {
  const { realm = null, limit = 200 } = opts;
  const rows = listModels(models, realm).slice(0, limit);
  const kept = new Set(keep ?? []);
  const keepAll = !keep || keep.length === 0;
  const lines = rows.map((m) => {
    const mark = keepAll || kept.has(m.id) ? '★' : ' ';
    const detail = [];
    if (m.credits) detail.push(String(m.credits));
    if (Number.isFinite(m.context_length)) detail.push(`${Math.round(m.context_length / 1000)}k`);
    if (m.supports_images) detail.push('图像');
    if (m.supports_reasoning) detail.push('推理');
    return `${mark} ${m.id}  ${m.name ?? ''}  ${detail.join(' ')}`.trimEnd();
  });
  const header = keepAll ? `共 ${rows.length} 个模型（当前：全部保留）` : `共 ${rows.length} 个模型（★ = 已保留）`;
  return [header, '', ...lines].join('\n');
}
