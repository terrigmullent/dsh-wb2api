/**
 * wb2api 本地服务的 HTTP 客户端。只依赖 Node 内置 fetch。
 *
 * 实测到的接口形状（workbuddy2api-panel v1.11.11）：
 *   GET  /healthz                     → {healthy, realm_servable:{cn,global}, service, total}
 *   GET  /v1/models        (Bearer)   → {object:'list', data:[{id,name,context_length,max_output_tokens,
 *                                        supports_images,supports_reasoning,supports_tool_call,credits,description,…}]}
 *   GET  /panel/api/overview (Bearer) → {accounts:[{uid,nickname,realm,credits,credits_total,
 *                                        credits_earliest_expiry,credits_earliest_remaining,disabled,token_usage,…}],
 *                                        total,healthy,auth_required,version,uptime_sec,…}
 *   POST /panel/api/login/start       → {state, url}          body: {realm:'cn'|'global'}
 *   GET  /panel/api/login/poll?state= → {done, nickname, uid, realm, credits, credits_total}
 */

const DEFAULT_TIMEOUT = 15000;

export class Wb2apiClient {
  /**
   * @param {object} opts
   * @param {string} opts.baseURL  例如 http://127.0.0.1:7863
   * @param {string} [opts.apiKey] 管理接口用的 key（来自 config.json 的 api_key）
   * @param {number} [opts.timeoutMs]
   */
  constructor({ baseURL, apiKey, timeoutMs = DEFAULT_TIMEOUT } = {}) {
    this.baseURL = String(baseURL ?? 'http://127.0.0.1:7863').replace(/\/+$/, '');
    this.apiKey = apiKey ?? null;
    this.timeoutMs = timeoutMs;
  }

  /** 浏览器里打开的面板地址。 */
  panelURL(path = '/panel/#accounts') {
    if (/^https?:\/\//i.test(path)) return path;
    return `${this.baseURL}${path.startsWith('/') ? '' : '/'}${path}`;
  }

  async request(path, { method = 'GET', body, auth = true, timeoutMs = this.timeoutMs } = {}) {
    const headers = {};
    if (auth && this.apiKey) headers.authorization = `Bearer ${this.apiKey}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    const res = await fetch(`${this.baseURL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* 保留原文 */
    }
    if (!res.ok) {
      const detail = json ? JSON.stringify(json).slice(0, 300) : text.slice(0, 300);
      const err = new Error(`${method} ${path} → HTTP ${res.status}${detail ? ` ${detail}` : ''}`);
      err.status = res.status;
      throw err;
    }
    return json ?? text;
  }

  /** 健康检查（不需要鉴权）。 */
  async healthz(timeoutMs = 3000) {
    return this.request('/healthz', { auth: false, timeoutMs });
  }

  /** 服务提供的全部模型。 */
  async models() {
    const json = await this.request('/v1/models');
    return Array.isArray(json?.data) ? json.data : [];
  }

  /** 单个模型 id 的详情。 */
  async modelInfo(id) {
    return this.request(`/v1/models/${encodeURIComponent(id)}`);
  }

  /** 账号池总览。 */
  async overview() {
    return this.request('/panel/api/overview');
  }

  /** 规范化后的账号列表，供 UI 直接渲染。 */
  async accounts() {
    const json = await this.overview();
    return (json?.accounts ?? []).map((a) => ({
      uid: a.uid,
      nickname: a.nickname ?? a.uid?.slice(0, 8) ?? '未知',
      realm: a.realm ?? '?',
      credits: a.credits ?? 0,
      creditsTotal: a.credits_total ?? 0,
      expiringSoon: a.credits_earliest_remaining ?? null,
      expiringAt: a.credits_earliest_expiry ?? null,
      disabled: Boolean(a.disabled),
      cooling: Boolean(a.cooling),
      inFlight: a.in_flight ?? 0,
      lastSuccess: a.last_success ?? null,
      lastModel: a.token_usage?.last_model ?? null,
      totalTokens: a.token_usage?.total_tokens ?? null,
      requestCount: a.token_usage?.request_count ?? null,
      lastLatencyMs: a.token_usage?.last_latency_ms ?? null,
    }));
  }

  /**
   * 发起添加账号流程。
   * @param {'cn'|'global'} realm
   * @returns {Promise<{state: string, url: string}>}
   */
  async loginStart(realm = 'cn') {
    return this.request('/panel/api/login/start', { method: 'POST', body: { realm } });
  }

  /**
   * 查询添加账号是否完成。
   * @param {string} state
   */
  async loginPoll(state) {
    return this.request(`/panel/api/login/poll?state=${encodeURIComponent(state)}`);
  }

  /**
   * 服务端自报的版本，用于判断是否需要升级。
   */
  async version() {
    try {
      const json = await this.overview();
      return json?.version ?? null;
    } catch {
      return null;
    }
  }
}

/**
 * 把 wb2api 的模型信息映射成 DSH（pi-ai）的模型档案字段。
 * 只带确定安全的字段；空数组会被 pi-ai 视作"未声明"并回退到 provider 默认值。
 *
 * @param {any} m /v1/models 里的一项
 * @returns {{id: string, name?: string, contextWindow?: number, maxTokens?: number, input?: string[]}}
 */
export function toModelProfile(m) {
  const profile = { id: m.id };
  if (m.name) profile.name = m.name;
  if (Number.isFinite(m.context_length) && m.context_length > 0) profile.contextWindow = m.context_length;
  if (Number.isFinite(m.max_output_tokens) && m.max_output_tokens > 0) profile.maxTokens = m.max_output_tokens;
  const input = ['text'];
  if (m.supports_images) input.push('image');
  profile.input = input;
  return profile;
}

/** 一行简短的模型描述，用于 UI 列表。 */
export function describeModel(m) {
  const bits = [];
  if (m.credits) bits.push(String(m.credits));
  if (Number.isFinite(m.context_length)) bits.push(`${Math.round(m.context_length / 1000)}k 上下文`);
  if (m.supports_images) bits.push('图像');
  if (m.supports_reasoning) bits.push('推理');
  return bits.join(' · ');
}
