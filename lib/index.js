/**
 * dsh-wb2api —— 宿主半侧。
 *
 * 把本机 workbuddy2api 网关（上游 Release 里的单文件二进制）变成 DSH 的一部分：
 *   1. 首次使用自动从 GitHub Release 下载 → sha256 校验 → 解压 → 生成 config.json
 *   2. DSH 启动时拉起服务、健康看护、退出时结束（可选保留）
 *   3. 代转发 wb2api 的面板接口，让浏览器侧（设置页）不必面对 7863 的 CORS/CSP 限制
 *   4. 把选中的模型写进 `llm-pi-ai` 的 provider 设置，让 DSH 模型选择器认识它们
 *   5. 把 config.json 里的 api_key 写进 DSH 凭据服务（provider 的 apiKeyEnv 引用它）
 *
 * 约束（来自官方插件规范）：
 *   - 插件的 apply 抛错会让整个 web 壳启动失败 → 全程 try/catch，只 warn。
 *   - 一切资源注册在 ctx.effect 内并返回清理函数。
 *   - 不 import 任何 @deepseek-ai/* 包（profile 的 node_modules 解析不到），只用 node 内置 + 同包相对路径。
 */

import { existsSync, appendFileSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { ServiceManager } from './core/service.js';
import { Wb2apiClient } from './core/wb2api.js';
import { detectTarget, exeNameFor } from './core/platform.js';
import { installFromRelease } from './core/download.js';
import { ensureWorkspaceConfig, readApiKey } from './core/workspace.js';
import { realmOf, resolveKeep, buildProfiles, formatModelTable } from './core/models.js';

export const name = 'dsh-wb2api';
/** 只需要工具服务；webServer 用 ctx.inject 等它就绪，纯 CLI 组合里插件仍可用。 */
export const inject = ['tools'];

/** 上游仓库与默认安装位置。 */
const DEFAULT_REPO = 'linguo2625469/workbuddy2api-panel';
const ROUTE_PREFIX = '/api/dsh-wb2api';
const MOUNT_KEY = Symbol.for('dsh.wb2api.mounted');

const DEFAULTS = {
  repo: DEFAULT_REPO,
  tag: 'latest',
  installDir: join(homedir(), '.dsh-wb2api'),
  host: '127.0.0.1',
  port: 7863,
  mirror: '',
  token: '',
  autoStart: true,
  autoInstall: true,
  killOnExit: true,
  adoptExisting: true,
  autoOpenPanelWhenEmpty: true,
  watchdogSeconds: 30,
  restartDelayMs: 4000,
  startTimeoutMs: 90000,
  requestTimeoutMs: 15000,
  installTimeoutMs: 600000,
  keepModels: [],
  settingsNs: 'llm-pi-ai',
  providerId: 'wb2api',
  providerDisplayName: 'WorkBuddy2API (本机)',
  credentialRef: 'WB2API_KEY',
  panelPath: '/panel/#accounts',
  verbose: false,
};

/** 一次长任务（下载/安装）的进度记录。 */
function createJob(name) {
  const job = {
    id: `job_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
    name,
    state: 'running',
    message: '开始',
    progress: null,
    log: [],
    result: null,
    error: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  };
  job.push = (msg) => {
    job.message = String(msg);
    job.log.push(`${new Date().toISOString().slice(11, 19)} ${msg}`);
    if (job.log.length > 200) job.log.splice(0, job.log.length - 200);
  };
  return job;
}

/** loopback 范围内的 IPv4 字面量。 */
function isIPv4Loopback(address) {
  const parts = String(address).split('.');
  return parts.length === 4 && parts[0] === '127' && parts.every((p) => /^\d{1,3}$/.test(p) && Number(p) <= 255);
}
function isLoopbackAddress(address) {
  if (address === undefined || address === null) return false;
  const normalized = String(address).toLowerCase();
  if (normalized === '::1') return true;
  if (normalized.startsWith('::ffff:')) return isIPv4Loopback(normalized.slice(7));
  return isIPv4Loopback(normalized);
}
function isLoopbackHostname(hostname) {
  if (hostname === 'localhost' || hostname === '[::1]') return true;
  return isIPv4Loopback(hostname);
}
/**
 * 请求级信任围栏：socket 地址必须是回环，Host 头必须是回环 authority，
 * 且不能带跨站标记；带 Origin 时必须是同源。X-Forwarded-For 一律不信任。
 */
function isLoopbackRequest(request) {
  if (!isLoopbackAddress(request?.socket?.remoteAddress)) return false;
  const host = request?.headers?.host;
  if (typeof host !== 'string') return false;
  let hostUrl;
  try {
    hostUrl = new URL(`http://${host}`);
  } catch {
    return false;
  }
  if (!isLoopbackHostname(hostUrl.hostname)) return false;
  if (request.headers['sec-fetch-site'] === 'cross-site') return false;
  const origin = request.headers.origin;
  if (origin === undefined) return true;
  try {
    return new URL(origin).host === hostUrl.host;
  } catch {
    return false;
  }
}

function isJsonObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 读一份 JSON 请求体；超限或非法返回 null。 */
async function readJsonBody(req, { maxBytes = 256 * 1024, objectOnly = true } = {}) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > maxBytes) {
      req.destroy();
      return null;
    }
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return null;
  try {
    const parsed = JSON.parse(text);
    if (objectOnly && !isJsonObject(parsed)) return null;
    return parsed;
  } catch {
    return null;
  }
}

const JSON_HEADERS = { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' };

function writeJson(res, status, body) {
  res.writeHead(status, JSON_HEADERS);
  res.end(JSON.stringify(body));
}

/**
 * 装载插件。
 * @param {any} ctx 宿主插件上下文
 * @param {any} userConfig profile patch 里的 config 段（可省略）
 */
export function apply(ctx, userConfig = {}) {
  const cfg = { ...DEFAULTS, ...(isJsonObject(userConfig) ? userConfig : {}) };
  cfg.installDir = String(cfg.installDir);
  cfg.baseURL = `http://${cfg.host}:${cfg.port}`;

  if (globalThis[MOUNT_KEY]) {
    // 同一进程里被挂两次（聚合包 + 单独安装）时不要重复注册路由与工具。
    try {
      ctx.logger?.warn?.('dsh-wb2api: 已装载过一次，跳过重复挂载');
    } catch {
      /* ignore */
    }
    return;
  }
  globalThis[MOUNT_KEY] = true;

  const jobs = new Map();
  const stateFile = () => join(cfg.installDir, 'dsh-wb2api.log');
  /** 日志滚动阈值：长期挂着 DSH 时这条日志会一直涨。 */
  const LOG_MAX_BYTES = 1024 * 1024;

  const log = (msg) => {
    const line = `${new Date().toISOString()} ${msg}`;
    try {
      mkdirSync(cfg.installDir, { recursive: true });
      const file = stateFile();
      try {
        // 超过 1 MB 就滚成 .1（只留一代），避免无限增长；失败就继续追加。
        if (statSync(file).size > LOG_MAX_BYTES) renameSync(file, `${file}.1`);
      } catch {
        /* 文件不存在/被占用都无妨 */
      }
      appendFileSync(file, `${line}\n`);
    } catch {
      /* 日志写不进去不能拖垮插件 */
    }
    try {
      if (cfg.verbose) ctx.logger?.info?.(`dsh-wb2api: ${msg}`);
      else ctx.logger?.debug?.(`dsh-wb2api: ${msg}`);
    } catch {
      /* ignore */
    }
  };

  /** 网关自身日志的末尾若干行：启动失败时最有用（端口占用、config.json 非法都会写在这里）。 */
  function gatewayLogTail(lines = 6) {
    try {
      const rows = readFileSync(join(cfg.installDir, 'wb2api.log'), 'utf8')
        .split(/\r?\n/)
        .filter((l) => l.trim() !== '');
      return rows.slice(-lines).join('\n');
    } catch {
      return '';
    }
  }

  /** 给失败信息附上网关日志末尾，省得用户去翻文件。 */
  function withGatewayTail(message) {
    const tail = gatewayLogTail();
    return tail ? `${message}\n--- 网关日志末尾 ---\n${tail}` : String(message);
  }

  const exePathCache = new Map();
  /** 归档解压出的可执行文件：优先用缓存（安装成功时写回），否则按平台名推断。 */
  function exePathForTarget() {
    const cached = exePathCache.get(cfg.installDir);
    if (cached && existsSync(cached)) return cached;
    const guess = join(cfg.installDir, exeNameFor(detectTarget().os));
    exePathCache.set(cfg.installDir, guess);
    return guess;
  }

  const service = new ServiceManager({
    exePath: exePathForTarget(),
    args: ['-config', 'config.json'],
    cwd: cfg.installDir,
    imageName: exeNameFor(detectTarget().os),
    baseURL: cfg.baseURL,
    stateDir: cfg.installDir,
    startTimeoutMs: cfg.startTimeoutMs,
    watchdogSeconds: cfg.watchdogSeconds,
    restartDelayMs: cfg.restartDelayMs,
    keepAlive: true,
    killOnExit: cfg.killOnExit,
    adoptExisting: cfg.adoptExisting,
    log,
  });

  /** 每次操作都重新读 config.json 里的 api_key，用户改完立即可用。 */
  const client = () =>
    new Wb2apiClient({
      baseURL: cfg.baseURL,
      apiKey: readApiKey(cfg.installDir) ?? process.env[cfg.credentialRef],
      timeoutMs: cfg.requestTimeoutMs,
    });

  const isInstalled = () => existsSync(exePathForTarget());

  /** settings 服务（可能不存在）。 */
  const settingsService = () => {
    try {
      return ctx.get('settings', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** 凭据服务（可能不存在，如非 web 组合）。 */
  const credentialsService = () => {
    try {
      return ctx.get('credentials', false) ?? undefined;
    } catch {
      return undefined;
    }
  };

  /** settings 里 provider 的模型档案行（可能没有）。 */
  function providerRow() {
    const settings = settingsService();
    if (!settings || typeof settings.describe !== 'function') return null;
    try {
      const rows = settings.describe();
      const row = Array.isArray(rows) ? rows.find((r) => r?.ns === cfg.settingsNs) : null;
      if (!row) return null;
      const provider = row.value?.providers?.[cfg.providerId];
      return { row, provider: provider ?? null };
    } catch (err) {
      log(`读取设置失败：${err?.message ?? err}`);
      return null;
    }
  }

  /** 当前"保留哪些模型"：以设置里的 provider 为准，退回插件配置。 */
  function currentKeep() {
    const found = providerRow();
    const models = found?.provider?.models;
    if (Array.isArray(models) && models.length > 0) return models.map((m) => m?.id).filter(Boolean);
    return Array.isArray(cfg.keepModels) ? [...cfg.keepModels] : [];
  }

  /**
   * 把选中模型写进 llm-pi-ai 的 provider 设置。
   * models 是整体替换语义，所以先读出旧的并按 id 复用用户改过的字段。
   */
  async function applyKeep(ids, { log: jobLog } = {}) {
    const settings = settingsService();
    if (!settings || typeof settings.update !== 'function') {
      throw new Error('当前组合没有 settings 服务，无法写入模型清单（请从 DSH 设置页的「模型」分区操作）');
    }
    const api = client();
    const models = await api.models();
    if (models.length === 0) throw new Error('服务没有返回任何模型，请确认网关已就绪且 api_key 正确');

    const target = (ids ?? []).filter(Boolean);
    // 空清单 = 全部保留：写入全部模型，否则 DSH 里会一个模型都没有。
    const wanted = target.length > 0 ? target : models.map((m) => m.id);
    const { ids: valid, missing } = resolveKeep(models, wanted);
    if (missing.length > 0) jobLog?.(`以下模型服务端已不提供，已跳过：${missing.join(', ')}`);

    const found = providerRow();
    const existing = Array.isArray(found?.provider?.models) ? found.provider.models : [];
    const next = buildProfiles(models, valid, existing);
    const patch = {
      providers: {
        [cfg.providerId]: {
          displayName: found?.provider?.displayName ?? cfg.providerDisplayName,
          api: found?.provider?.api ?? 'openai-completions',
          baseURL: found?.provider?.baseURL ?? `${cfg.baseURL}/v1`,
          apiKeyEnv: found?.provider?.apiKeyEnv ?? cfg.credentialRef,
          models: next,
        },
      },
    };

    try {
      await settings.update(cfg.settingsNs, patch, found?.row?.revision);
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/changed since it was read|SettingsConflict/i.test(message)) {
        // 修订号冲突：重读一次再写。
        const again = providerRow();
        await settings.update(cfg.settingsNs, patch, again?.row?.revision);
      } else if (/No configurable plugin entry/i.test(message)) {
        throw new Error(`当前 profile 里没有 "${cfg.settingsNs}" 这条插件条目，请在 DSH 设置 → 模型里先配置一次模型提供商`);
      } else {
        throw err;
      }
    }
    jobLog?.(`已保留 ${valid.length} 个模型（DSH 里下一个请求生效）`);
    return { keep: valid, missing, total: models.length };
  }

  /** 把 config.json 的 api_key 交给 DSH 凭据服务，供 provider 的 apiKeyEnv 解析。 */
  async function ensureCredential({ log: jobLog } = {}) {
    const key = readApiKey(cfg.installDir);
    if (!key) {
      jobLog?.('config.json 里没有 api_key，跳过凭据写入');
      return { ok: false, reason: 'no-key' };
    }
    const credentials = credentialsService();
    if (!credentials || typeof credentials.describe !== 'function') {
      // 没有凭据服务时退回进程环境，provider 的 apiKeyEnv 仍能解析。
      process.env[cfg.credentialRef] = key;
      jobLog?.(`没有凭据服务，已把密钥放进进程环境 ${cfg.credentialRef}`);
      return { ok: true, via: 'env' };
    }
    try {
      const current = await credentials.describe(cfg.credentialRef);
      if (current?.configured) {
        const resolved = typeof credentials.resolve === 'function' ? await credentials.resolve(cfg.credentialRef) : null;
        if (resolved?.value === key) {
          jobLog?.(`凭据 ${cfg.credentialRef} 已是最新`);
          return { ok: true, via: 'stored' };
        }
      }
      if (current?.writable === false) {
        jobLog?.(`凭据 ${cfg.credentialRef} 由启动环境提供，插件不能覆盖；请保证它与 config.json 的 api_key 一致`);
        return { ok: false, reason: 'read-only' };
      }
      await credentials.set(cfg.credentialRef, key);
      jobLog?.(`已把 api_key 写入 DSH 凭据服务（${cfg.credentialRef}）`);
      return { ok: true, via: 'stored' };
    } catch (err) {
      const message = String(err?.message ?? err);
      if (/read-only|shadowed/i.test(message)) {
        jobLog?.(`凭据 ${cfg.credentialRef} 由启动环境提供，插件不能覆盖（${message}）`);
        return { ok: false, reason: 'read-only' };
      }
      jobLog?.(`写凭据失败：${message}`);
      return { ok: false, reason: message };
    }
  }

  /** 安装/更新之后的对齐动作：生成 config.json、写凭据、按需对齐模型。 */
  async function provision({ log: jobLog } = {}) {
    const created = ensureWorkspaceConfig(cfg.installDir, {
      listen: `${cfg.host}:${cfg.port}`,
      log: (m) => jobLog?.(m),
    });
    jobLog?.(created.created ? '已生成 config.json' : 'config.json 已存在，沿用');
    await ensureCredential({ log: jobLog });
    if (created.apiKey) process.env[cfg.credentialRef] = created.apiKey;
    return { configPath: created.configPath };
  }

  /** 一键安装/更新：跑在 job 里，因为下载可能要几分钟。 */
  function startInstallJob({ force = false, mirror = '', version = '' } = {}) {
    const job = createJob('install');
    jobs.set(job.id, job);
    const run = async () => {
      const target = detectTarget();
      if (!target.supported) throw new Error(target.reason);
      job.push(`平台 ${target.os}-${target.arch}`);
      const result = await installFromRelease({
        repo: cfg.repo,
        tag: version || cfg.tag,
        installDir: cfg.installDir,
        mirror: mirror || cfg.mirror,
        token: cfg.token,
        force,
        target,
        log: (m) => job.push(m),
      });
      exePathCache.set(cfg.installDir, result.exePath);
      service.opts.exePath = result.exePath;
      await provision({ log: (m) => job.push(m) });
      job.result = { ...result, baseURL: cfg.baseURL };
      return result;
    };
    job.done = run()
      .then((result) => {
        job.state = 'done';
        job.finishedAt = new Date().toISOString();
        job.push(`安装完成：${result.exePath}`);
        return result;
      })
      .catch((err) => {
        job.state = 'error';
        job.error = String(err?.message ?? err);
        job.finishedAt = new Date().toISOString();
        job.push(`安装失败：${job.error}`);
        return null;
      });
    return job;
  }

  /** 启动服务（必要时先确认已安装）。 */
  async function startService(reason) {
    if (!isInstalled()) {
      const job = startInstallJob({});
      const result = await job.done;
      if (!result) throw new Error(job.error ?? '安装失败');
    }
    await provision({ log: () => {} });
    service.opts.exePath = exePathForTarget();
    return service.ensureService(reason);
  }

  /** 打开官方面板（浏览器里用它自己的 localStorage 鉴权，天然绕开 CORS）。 */
  function openPanel(page = 'accounts') {
    const path = page === 'panel' ? '/panel/' : '/panel/#accounts';
    const url = `${cfg.baseURL}${path}`;
    const platform = process.platform;
    const cmd = platform === 'win32' ? 'cmd' : platform === 'darwin' ? 'open' : 'xdg-open';
    const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
    try {
      const child = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: true });
      child.on('error', (err) => log(`打开浏览器失败：${err.message}`));
      child.unref();
      log(`已请求打开 ${url}`);
      return { ok: true, url };
    } catch (err) {
      log(`打开浏览器失败：${err?.message ?? err}`);
      return { ok: false, url, error: String(err?.message ?? err) };
    }
  }

  /** 服务状态 + 账号 + 模型，合成一份给 UI 与工具共用的快照。 */
  async function snapshot({ withAccounts = true, withModels = false } = {}) {
    const installed = isInstalled();
    const health = await service.health();
    const pids = service.listPids();
    let accounts = [];
    let version = null;
    let accountError = null;
    if (installed && health.ok && withAccounts) {
      try {
        const api = client();
        accounts = await api.accounts();
        version = await api.version();
      } catch (err) {
        accountError = String(err?.message ?? err);
      }
    }
    const keep = currentKeep();
    // 服务就绪时顺手列一次模型，供设置页显示"可用 N 个"；失败不算致命。
    let modelList = null;
    if (installed && health.ok) {
      try {
        modelList = await client().models();
      } catch (err) {
        if (!accountError) accountError = String(err?.message ?? err);
      }
    }
    const payload = {
      ok: true,
      service: {
        installed,
        running: pids.length > 0,
        healthy: Boolean(health.ok),
        pid: pids[0] ?? null,
        pids,
        version,
        uptimeSec: health.body?.uptime_sec ?? null,
        baseURL: cfg.baseURL,
        installDir: cfg.installDir,
        exePath: exePathForTarget(),
        lastEvent: service.lastEvent,
        lastError: service.lastError,
      },
      accounts: accounts.map((a) => ({
        uid: a.uid,
        nickname: a.nickname,
        realm: a.realm,
        credits: a.credits,
        creditsTotal: a.creditsTotal,
        disabled: a.disabled,
        cooling: a.cooling,
        expiry: a.expiringAt ?? null,
        expiringSoon: a.expiringSoon ?? null,
        lastModel: a.lastModel ?? null,
        totalTokens: a.totalTokens ?? null,
        // 用量统计（网关持久化在 state_file 里）
        requestCount: a.requestCount ?? null,
        usageCount: a.usageCount ?? null,
        promptTokens: a.promptTokens ?? null,
        completionTokens: a.completionTokens ?? null,
        lastLatencyMs: a.lastLatencyMs ?? null,
        lastTokensPerSecond: a.lastTokensPerSecond ?? null,
        lastUsedAt: a.lastUsedAt ?? null,
        successCount: a.successCount ?? null,
        modelCosts: a.modelCosts ?? [],
      })),
      models: { available: modelList ? modelList.length : null, keep, realm: cfg.realm ?? 'all' },
      install: { busy: [...jobs.values()].some((j) => j.state === 'running'), jobId: [...jobs.values()].find((j) => j.state === 'running')?.id ?? null },
      accountError,
    };
    if (withModels) {
      if (modelList === null) throw new Error(accountError ?? '服务未就绪，无法列出模型（请先启动服务）');
      const models = modelList;
      // 设置页按「models 是扁平数组」解析（见 lib/client.js 的 refresh()：modelList.models），
      // 所以这条路由把 models 覆盖成数组，另在顶层给出 keep / realm / available。
      payload.models = models.map((m) => ({
        id: m.id,
        name: m.name ?? m.id,
        realm: realmOf(m.id),
        credits: m.credits ?? null,
        contextLength: m.context_length ?? null,
        maxOutputTokens: m.max_output_tokens ?? null,
        supportsImages: Boolean(m.supports_images),
        supportsReasoning: Boolean(m.supports_reasoning),
        vendor: m.vendor ?? null,
        description: m.description ?? null,
        kept: keep.length === 0 ? true : keep.includes(m.id),
      }));
      payload.keep = keep;
      payload.realm = cfg.realm ?? 'all';
      payload.available = models.length;
    }
    return payload;
  }

  /** 大数字紧凑显示：197831916 → 197.8M。 */
  function compactNumber(value) {
    const n = Number(value);
    if (!Number.isFinite(n)) return null;
    if (Math.abs(n) >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
    if (Math.abs(n) >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
    if (Math.abs(n) >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
    return String(Math.round(n));
  }

  /** 工具用的纯文本摘要。 */
  function statusText(snap) {
    const s = snap.service;
    const lines = [];
    lines.push(`服务：${s.installed ? '已安装' : '未安装'} / ${s.running ? '运行中' : '未运行'}${s.healthy ? '（健康）' : '（不健康）'}${s.pid ? ` pid=${s.pid}` : ''}`);
    lines.push(`地址：${s.baseURL}  版本：${s.version ?? '未知'}  目录：${s.installDir}`);
    if (!s.installed) lines.push('下一步：workbuddy action=install（从官方 Release 下载并校验 sha256）');
    if (snap.accountError) lines.push(`账号读取失败：${snap.accountError}`);
    if (snap.accounts.length === 0 && s.healthy) lines.push('账号池为空：workbuddy action=login realm=cn（在浏览器打开授权链接）');
    for (const a of snap.accounts) {
      lines.push(`  账号 ${a.nickname}（${a.uid.slice(0, 8)}）${a.realm} 积分 ${a.credits}/${a.creditsTotal}${a.expiry ? ` 最早到期 ${a.expiry}` : ''}${a.disabled ? ' 已禁用' : ''}`);
      const tokens = compactNumber(a.totalTokens);
      if (a.requestCount != null || tokens) {
        const rate = a.lastTokensPerSecond != null ? `，最近 ${Number(a.lastTokensPerSecond).toFixed(1)} tok/s` : '';
        lines.push(`    用量：${a.requestCount ?? 0} 次请求${a.successCount != null ? `（成功 ${a.successCount}）` : ''}${tokens ? `，累计 ${tokens} tokens` : ''}${a.lastModel ? `，最近模型 ${a.lastModel}` : ''}${rate}`);
      }
    }
    const keep = snap.models.keep;
    lines.push(`模型：保留 ${keep.length === 0 ? '全部' : `${keep.length} 个`}（服务端可用 ${snap.models.available ?? '未知'} 个）`);
    return lines.join('\n');
  }

  /** 组装工具定义。 */
  function registerTool() {
    const definition = {
      name: 'workbuddy',
      description:
        '管理本机的 workbuddy2api 网关（DSH 插件 dsh-wb2api）：查看服务与账号状态、下载安装、添加账号、挑选保留哪些模型、启停与重启。' +
        'action: status=状态总览；install=从 GitHub Release 下载并校验安装；login=添加账号（realm=cn|global，返回授权链接，可带 state 查询完成情况）；' +
        'models=列出服务端模型并标记保留项；keep=写入要保留的模型 id；start/stop/restart=服务控制；open_panel=在浏览器打开官方面板。',
      parameters: {
        type: 'object',
        additionalProperties: false,
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['status', 'install', 'login', 'models', 'keep', 'start', 'stop', 'restart', 'open_panel'],
            description: '要执行的动作',
          },
          realm: { type: 'string', enum: ['cn', 'global'], description: 'login 用：账号类型（默认 cn）' },
          state: { type: 'string', description: 'login 用：查询某次授权流程是否完成' },
          keep: { type: 'array', items: { type: 'string' }, description: 'keep 用：要保留的模型 id 列表；空数组表示全部保留' },
          query: { type: 'string', description: 'models 用：按关键词过滤' },
          mirror: { type: 'string', description: 'install 用：下载镜像前缀，例如 https://ghproxy.net/' },
          version: { type: 'string', description: 'install 用：指定 Release tag，默认 latest' },
          force: { type: 'boolean', description: 'install 用：已安装时强制重新下载' },
        },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          required: ['text'],
          properties: { text: { type: 'string' } },
        },
        render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
      },
      async execute(args) {
        const action = String(args?.action ?? 'status');
        try {
          switch (action) {
            case 'status':
              return { text: statusText(await snapshot()) };
            case 'install': {
              const job = startInstallJob({ force: Boolean(args?.force), mirror: String(args?.mirror ?? ''), version: String(args?.version ?? '') });
              const result = await job.done;
              const tail = job.log.slice(-8).join('\n');
              return {
                text: result
                  ? `安装完成：${result.exePath}\nRelease ${result.tag} / 资产 ${result.asset}\nsha256 ${result.sha256}\n解压工具 ${result.extractedWith}\n--- 过程日志 ---\n${tail}`
                  : `安装失败：${job.error}\n--- 过程日志 ---\n${tail}`,
              };
            }
            case 'login': {
              const api = client();
              if (args?.state) {
                const r = await api.loginPoll(String(args.state));
                return { text: r?.done ? `授权完成：${r.nickname ?? ''} ${r.uid ?? ''} ${r.realm ?? ''} 积分 ${r.credits ?? '?'}/${r.credits_total ?? '?'}` : '尚未完成授权，请在浏览器里打开授权链接完成登录后再查询' };
              }
              const started = await api.loginStart(args?.realm === 'global' ? 'global' : 'cn');
              return {
                text: `请在浏览器打开下面的链接完成登录（${args?.realm === 'global' ? '国际' : '国内'}账号）：\n${started?.url ?? '(服务未返回链接)'}\n\n登录完成后用 workbuddy action=login state=${started?.state ?? ''} 查询结果。`,
              };
            }
            case 'models': {
              const api = client();
              let models = await api.models();
              const query = String(args?.query ?? '').trim().toLowerCase();
              if (query) models = models.filter((m) => `${m.id} ${m.name ?? ''}`.toLowerCase().includes(query));
              const keep = currentKeep();
              const table = formatModelTable(models, keep, { realm: args?.realm ?? null, limit: 60 });
              return { text: query ? `匹配 "${query}"：\n${table}` : table };
            }
            case 'keep': {
              const ids = Array.isArray(args?.keep) ? args.keep.map(String) : [];
              const r = await applyKeep(ids);
              const scope = ids.length === 0 ? `（清单为空 = 全部保留）` : '';
              return { text: `已保留 ${r.keep.length} 个模型${scope}（服务端共 ${r.total} 个）${r.missing.length ? `；跳过 ${r.missing.join(', ')}` : ''}\nDSH 里下一个请求生效。` };
            }
            case 'start': {
              const r = await startService('工具调用');
              return { text: r?.ok ? `服务已就绪：${JSON.stringify(r.health?.body ?? {})}` : `启动失败：${withGatewayTail(r?.error ?? '未知原因')}` };
            }
            case 'stop': {
              const r = await service.stopService('工具调用');
              return { text: r?.ok ? '服务已停止' : `停止后仍有残留进程：${(r?.left ?? []).join(', ')}` };
            }
            case 'restart': {
              const r = await service.restartService('工具调用');
              return { text: r?.ok ? `服务已重启（pid ${r.pid ?? '?'}）` : `重启失败：${withGatewayTail(r?.error ?? '未知原因')}` };
            }
            case 'open_panel': {
              const r = openPanel(args?.page === 'panel' ? 'panel' : 'accounts');
              return { text: r.ok ? `已请求浏览器打开 ${r.url}` : `打开失败：${r.error}（也可以手动访问 ${r.url}）` };
            }
            default:
              return { text: `不认识的动作：${action}` };
          }
        } catch (err) {
          return { text: `${action} 失败：${String(err?.message ?? err)}` };
        }
      },
    };
    const dispose = ctx.tools.register(definition);
    return dispose;
  }

  /** 设置页用的 HTTP 路由（自己校验回环，因为 webServer 层不做认证）。 */
  function registerRoutes(webServer) {
    if (!webServer || typeof webServer.register !== 'function') {
      log('webServer 不可用，跳过设置页路由（工具仍然可用）');
      return () => {};
    }
    const handler = async (req, res) => {
      try {
        if (!isLoopbackRequest(req)) {
          writeJson(res, 403, { ok: false, error: 'forbidden: loopback-only' });
          return;
        }
        const url = new URL(req.url ?? '/', 'http://x');
        const sub = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
        const method = (req.method ?? 'GET').toUpperCase();
        const need = (m) => {
          if (method === m) return true;
          res.writeHead(405, { ...JSON_HEADERS, allow: m });
          res.end(JSON.stringify({ ok: false, error: `method ${method} not allowed` }));
          return false;
        };

        if (sub === 'status') {
          if (!need('GET')) return;
          writeJson(res, 200, await snapshot());
          return;
        }
        if (sub === 'models') {
          if (!need('GET')) return;
          writeJson(res, 200, await snapshot({ withAccounts: false, withModels: true }));
          return;
        }
        if (sub === 'job') {
          if (!need('GET')) return;
          const id = url.searchParams.get('id') ?? '';
          const job = jobs.get(id);
          if (!job) {
            writeJson(res, 404, { ok: false, error: `没有这个任务：${id}` });
            return;
          }
          writeJson(res, 200, { ok: true, job: { id: job.id, name: job.name, state: job.state, message: job.message, progress: job.progress, log: job.log.slice(-40), result: job.result, error: job.error } });
          return;
        }
        if (sub === 'login/start') {
          if (!need('POST')) return;
          const body = await readJsonBody(req);
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          const started = await client().loginStart(body.realm === 'global' ? 'global' : 'cn');
          writeJson(res, 200, { ok: true, state: started?.state ?? '', url: started?.url ?? '' });
          return;
        }
        if (sub === 'login/poll') {
          if (!need('GET')) return;
          const state = url.searchParams.get('state') ?? '';
          if (!state) {
            writeJson(res, 400, { ok: false, error: '缺少 state 参数' });
            return;
          }
          const r = await client().loginPoll(state);
          writeJson(res, 200, {
            ok: true,
            done: Boolean(r?.done),
            nickname: r?.nickname ?? null,
            uid: r?.uid ?? null,
            realm: r?.realm ?? null,
            credits: r?.credits ?? null,
            creditsTotal: r?.credits_total ?? null,
            error: r?.error ?? null,
          });
          return;
        }
        if (sub === 'keep') {
          if (!need('POST')) return;
          const body = await readJsonBody(req);
          if (body === null || !Array.isArray(body.keep)) {
            writeJson(res, 400, { ok: false, error: '需要 {"keep": string[]}' });
            return;
          }
          const ids = body.keep.map(String);
          // 空清单 = 「全部保留」，会把服务端当前所有模型写进 profile，覆盖用户原本精挑的清单。
          // 这个后果太大，不能靠"没传参数"默认触发，必须显式带 all:true。
          if (ids.length === 0 && body.all !== true) {
            writeJson(res, 400, {
              ok: false,
              error: '空的模型清单表示「全部保留」，会把服务端当前所有模型都写进设置；确认要这样请带 "all": true',
            });
            return;
          }
          const r = await applyKeep(ids);
          writeJson(res, 200, { ok: true, keep: r.keep, missing: r.missing, total: r.total, all: ids.length === 0 });
          return;
        }
        if (sub === 'service') {
          if (!need('POST')) return;
          const body = await readJsonBody(req);
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          const action = String(body.action ?? '');
          // 失败必须让设置页看见（客户端把 {ok:false,error} 转成可读错误），
          // 否则点了"启动"没反应，用户不知道是端口占用还是配置不对。
          let failure = null;
          if (action === 'start') {
            const r = await startService('设置页');
            if (!r?.ok) failure = r?.error ?? '启动失败';
          } else if (action === 'stop') {
            const r = await service.stopService('设置页');
            if (!r?.ok) failure = `停止后仍有残留进程：${(r?.left ?? []).join(', ')}`;
          } else if (action === 'restart') {
            const r = await service.restartService('设置页');
            if (!r?.ok) failure = r?.error ?? '重启失败';
          } else {
            writeJson(res, 400, { ok: false, error: `不认识的动作：${action}` });
            return;
          }
          const snap = await snapshot({ withAccounts: false });
          if (failure) {
            writeJson(res, 200, { ok: false, error: withGatewayTail(failure), service: snap.service });
            return;
          }
          writeJson(res, 200, { ok: true, service: snap.service });
          return;
        }
        if (sub === 'install') {
          if (!need('POST')) return;
          const body = await readJsonBody(req);
          if (body === null) {
            // 不把"请求体坏了"当成"用默认参数装一次"，否则一次手滑就会触发几 MB 下载。
            writeJson(res, 400, { ok: false, error: '请求体不是合法 JSON；请发送 {} 或省略 force/mirror/version' });
            return;
          }
          const running = [...jobs.values()].find((j) => j.state === 'running');
          if (running) {
            writeJson(res, 200, { ok: true, jobId: running.id });
            return;
          }
          const job = startInstallJob({ force: Boolean(body.force), mirror: String(body.mirror ?? ''), version: String(body.version ?? '') });
          writeJson(res, 200, { ok: true, jobId: job.id });
          return;
        }
        if (sub === 'open-panel') {
          if (!need('POST')) return;
          const body = (await readJsonBody(req)) ?? {};
          const r = openPanel(body.page === 'panel' ? 'panel' : 'accounts');
          writeJson(res, 200, r.ok ? { ok: true, url: r.url } : { ok: false, error: r.error, url: r.url });
          return;
        }
        if (sub === 'config') {
          if (!need('POST')) return;
          const body = await readJsonBody(req);
          if (body === null) {
            writeJson(res, 400, { ok: false, error: 'invalid JSON body' });
            return;
          }
          const configPath = join(cfg.installDir, 'config.json');
          let parsed = {};
          try {
            parsed = JSON.parse(readFileSync(configPath, 'utf8'));
          } catch {
            parsed = {};
          }
          if (typeof body.server === 'string' && body.server.trim() !== '') {
            const server = body.server.trim();
            const fixed = `${cfg.host}:${cfg.port}`;
            if (!/^[A-Za-z0-9.:[\]-]+:\d{1,5}$/.test(server)) {
              writeJson(res, 400, { ok: false, error: '监听地址格式应为 host:port，例如 127.0.0.1:7863' });
              return;
            }
            // 监听地址不是"运行时随便改"的旋钮：插件自己的健康检查与 DSH 里 provider 的 baseURL
            // 都写死为 cfg.host:cfg.port。这里偷偷改掉，插件就会一直在错误的端口上探测
            // （表现是"已安装但一直未运行"），DSH 的模型请求也会指向不存在的端口。
            const m = /^(.*):(\d{1,5})$/.exec(server);
            const host = (m?.[1] ?? '').toLowerCase();
            const port = Number(m?.[2] ?? '0');
            const hostOk = ['', '127.0.0.1', 'localhost', '::1', '[::1]', '0.0.0.0'].includes(host);
            if (!m || !hostOk || port !== cfg.port) {
              writeJson(res, 400, {
                ok: false,
                error:
                  `监听地址只能是端口 ${cfg.port} 的本机地址（127.0.0.1 / localhost / ::1 / 0.0.0.0），` +
                  `插件固定按 http://${fixed} 访问它。要换端口请改插件配置里的 host/port（cordis.patch.yml 的 config）并重启 DSH。`,
              });
              return;
            }
            parsed.listen = server;
          }
          if (typeof body.apiKey === 'string' && body.apiKey.trim() !== '') parsed.api_key = body.apiKey.trim();
          try {
            mkdirSync(cfg.installDir, { recursive: true });
            writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
          } catch (err) {
            writeJson(res, 500, { ok: false, error: `写入 config.json 失败：${String(err?.message ?? err)}` });
            return;
          }
          log('已更新 config.json（重启服务后生效）');
          const created = ensureWorkspaceConfig(cfg.installDir, { listen: `${cfg.host}:${cfg.port}` });
          await ensureCredential({});
          writeJson(res, 200, { ok: true, configPath, listen: created.listen, restartRequired: true });
          return;
        }
        writeJson(res, 404, { ok: false, error: `未知路由：${ROUTE_PREFIX}/${sub}` });
      } catch (err) {
        log(`路由异常：${String(err?.stack ?? err)}`);
        if (res.headersSent) {
          res.destroy();
          return;
        }
        writeJson(res, 500, { ok: false, error: String(err?.message ?? err) });
      }
    };
    return webServer.register({ kind: 'prefix', path: ROUTE_PREFIX, handler });
  }

  // ---- 装载 ---------------------------------------------------------------
  try {
    log(`装载：installDir=${cfg.installDir} baseURL=${cfg.baseURL} autoStart=${cfg.autoStart} killOnExit=${cfg.killOnExit}`);
  } catch {
    /* ignore */
  }

  let disposeTool = null;
  let disposeRoutes = null;
  try {
    disposeTool = registerTool();
  } catch (err) {
    log(`注册 workbuddy 工具失败：${String(err?.message ?? err)}`);
  }

  /** 从某个上下文（优先注入出来的子作用域）拿到 webServer 服务。 */
  const resolveWebServer = (from) => {
    for (const source of [from, ctx]) {
      if (!source) continue;
      const direct = source.webServer;
      if (direct && typeof direct.register === 'function') return direct;
      try {
        const got = source.get?.('webServer', false);
        if (got && typeof got.register === 'function') return got;
      } catch {
        /* ignore */
      }
    }
    return undefined;
  };

  const mountRoutes = (from = ctx) => {
    if (disposeRoutes) return;
    const ws = resolveWebServer(from);
    if (!ws) {
      log('没有 webServer 服务，跳过设置页路由（工具仍然可用）');
      return;
    }
    try {
      disposeRoutes = registerRoutes(ws);
      log('已注册设置页路由 /api/dsh-wb2api');
    } catch (err) {
      log(`注册设置页路由失败：${String(err?.message ?? err)}`);
    }
  };

  // 冷启动时 webServer 往往比本插件晚就绪（实测：apply 时 ctx.get 拿不到，
  // 于是设置页路由没注册、整个设置页 401）。用 ctx.inject 等它出现；
  // 纯 CLI 组合里永远不会触发，工具照旧可用。
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (scoped) => {
        scoped.effect(() => {
          mountRoutes(scoped);
          return () => {
            try {
              disposeRoutes?.();
            } catch {
              /* ignore */
            }
            disposeRoutes = null;
          };
        }, 'dsh-wb2api: routes');
      });
    } catch (err) {
      log(`等待 webServer 失败，改为立即注册：${String(err?.message ?? err)}`);
      mountRoutes();
    }
  } else {
    mountRoutes();
  }

  const cancelBoot = { cancelled: false };
  const boot = async () => {
    try {
      if (!isInstalled()) {
        if (!cfg.autoInstall) {
          log('未安装且 autoInstall=false，等待用户在设置页点击下载');
          return;
        }
        log('首次使用：开始下载安装（可能要几分钟，取决于网络）');
        const job = startInstallJob({});
        const result = await job.done;
        if (cancelBoot.cancelled) return;
        if (!result) {
          log(`自动安装失败：${job.error}`);
          return;
        }
      } else {
        await provision({});
      }
      if (cancelBoot.cancelled || !cfg.autoStart) return;
      const r = await service.ensureService('DSH 启动');
      if (cancelBoot.cancelled) return;
      if (!r?.ok) {
        log(`服务未就绪：${r?.error ?? '未知原因'}`);
        return;
      }
      service.startWatchdog();
      const snap = await snapshot();
      if (snap.accounts.length === 0 && cfg.autoOpenPanelWhenEmpty) {
        log('账号池为空，打开官方面板以便添加账号');
        openPanel('accounts');
      }
      if (Array.isArray(cfg.keepModels) && cfg.keepModels.length > 0) {
        try {
          await applyKeep(cfg.keepModels);
        } catch (err) {
          log(`对齐 keepModels 失败：${String(err?.message ?? err)}`);
        }
      }
    } catch (err) {
      log(`启动流程异常：${String(err?.message ?? err)}`);
    }
  };

  const disposeAll = ctx.effect(() => {
    void boot();
    return () => {
      cancelBoot.cancelled = true;
      try {
        disposeRoutes?.();
      } catch {
        /* ignore */
      }
      try {
        disposeTool?.();
      } catch {
        /* ignore */
      }
      try {
        service.dispose({ kill: cfg.killOnExit });
      } catch {
        /* ignore */
      }
      try {
        delete globalThis[MOUNT_KEY];
      } catch {
        /* ignore */
      }
      log('已卸载');
    };
  }, 'dsh-wb2api: lifecycle');

  return { service, cfg, jobs, dispose: disposeAll };
}
