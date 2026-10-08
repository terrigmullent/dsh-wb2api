/**
 * 安装目录的准备：config.json、auths/、data/。
 *
 * 上游的 config.example.json 里 `listen` 是 `":7863"`（监听所有网卡）。
 * 本插件默认把它改成 `127.0.0.1:7863`：面板本身带 api_key，但没有必要暴露到局域网。
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';

/** 找不到 config.example.json 时使用的兜底模板（与上游 v1.11/v1.12 的示例一致）。 */
export const FALLBACK_EXAMPLE = {
  listen: '127.0.0.1:7863',
  api_key: 'test_key',
  auth_dir: './auths',
  state_file: './data/state.json',
  panel: { package_detail_limit: 5 },
  logging: {
    request_archive_enabled: true,
    request_retention_days: 7,
    request_archive_max_mb: 100,
    request_client_info: true,
  },
  cooldown: { soft_rate: '600s', soft_rate_max: '2h' },
  schedule: {
    checkin_hours: [9, 21],
    growth_hours: [1],
    travel_hours: [9, 21],
    activity_hours: [10],
    keepalive_hours: [22],
    blackcat_hours: [23],
    checkin_enabled: true,
    growth_enabled: true,
    travel_enabled: true,
    activity_enabled: true,
    keepalive_enabled: true,
    blackcat_enabled: true,
    balance_refresh_enabled: true,
    balance_refresh_minutes: 5,
  },
  global: { enabled: true, chat_base: '', billing_base: '' },
  upstream: {
    timeout_seconds: 120,
    header_timeout_seconds: 120,
    idle_timeout_seconds: 300,
    user_agent: '',
    client_version: '',
    cli_version: '',
    client_name: '',
    device_token: '',
    device_token_file: '',
    passthrough_ip: false,
  },
  features: { sanitize_blacklist_fingerprints: true },
  prompt: { mode: 'passthrough', file: '' },
  upstash: { url: '', token: '' },
  pool: {
    max_in_flight: 3,
    max_in_flight_global: 2,
    breaker_threshold: 3,
    breaker_cooldown: '30m',
    breaker_cooldown_max: '6h',
    degrade_threshold: 5,
    degrade_cooldown: '10m',
    degrade_cooldown_max: '2h',
    idle_weight_per_hour: 0.5,
    idle_weight_max: 5,
    prefer_expiring: true,
    expiring_soon: '168h',
    cost_explore_interval: '30m',
    credit_floor: 100,
  },
  session_sticky: { enabled: true, ttl: '30m', gc_interval: '5m' },
};

/** 生成一个 43 字符的随机 api_key（与上游示例长度一致，URL 安全）。 */
export function generateApiKey() {
  return randomBytes(48).toString('base64url').replace(/[-_]/g, '').slice(0, 43);
}

/** 读 config.json 里的 api_key；不存在或读不出就回退到环境变量。 */
export function readApiKey(installDir) {
  try {
    const json = JSON.parse(readFileSync(join(installDir, 'config.json'), 'utf8'));
    if (typeof json.api_key === 'string' && json.api_key.trim()) return json.api_key.trim();
  } catch {
    /* 下一步回退 */
  }
  return process.env.WB2API_KEY?.trim() || null;
}

/**
 * 确保安装目录可用：必要时生成 config.json，并建好 auths/ 与 data/。
 *
 * @param {string} installDir
 * @param {object} [opts]
 * @param {string} [opts.listen]     默认 127.0.0.1:7863
 * @param {string} [opts.apiKey]     指定 api_key；不给就生成随机值
 * @param {boolean} [opts.force]     已存在时是否覆盖
 * @param {(msg: string) => void} [opts.log]
 * @returns {{created: boolean, apiKey: string, listen: string, configPath: string}}
 */
export function ensureWorkspaceConfig(installDir, opts = {}) {
  const { listen = '127.0.0.1:7863', apiKey, force = false, log = () => {} } = opts;
  const configPath = join(installDir, 'config.json');
  mkdirSync(join(installDir, 'auths'), { recursive: true });
  mkdirSync(join(installDir, 'data'), { recursive: true });

  if (existsSync(configPath) && !force) {
    const existing = readApiKey(installDir);
    let parsed = {};
    try {
      parsed = JSON.parse(readFileSync(configPath, 'utf8'));
    } catch {
      /* 交给上游处理 */
    }
    let changed = false;
    if (!existing) {
      parsed.api_key = apiKey ?? generateApiKey();
      changed = true;
      log('config.json 里没有 api_key，已生成一个');
    }
    // 只在本机监听：上游示例默认 ":7863" 会监听所有网卡。
    if (typeof parsed.listen === 'string' && /^:\d+$/.test(parsed.listen)) {
      log(`把 listen 从 "${parsed.listen}" 收紧为 "${listen}"`);
      parsed.listen = listen;
      changed = true;
    }
    if (changed) writeFileSync(configPath, `${JSON.stringify(parsed, null, 2)}\n`);
    return { created: false, apiKey: parsed.api_key ?? existing, listen: parsed.listen ?? listen, configPath };
  }

  const examplePath = join(installDir, 'config.example.json');
  let base = FALLBACK_EXAMPLE;
  if (existsSync(examplePath)) {
    try {
      base = JSON.parse(readFileSync(examplePath, 'utf8'));
      log('用归档里的 config.example.json 作为模板');
    } catch (err) {
      log(`config.example.json 解析失败（${err.message}），改用内置模板`);
    }
  }
  const merged = { ...base, listen, api_key: apiKey ?? generateApiKey() };
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(merged, null, 2)}\n`);
  log(`已生成 ${configPath}（listen=${listen}）`);
  return { created: true, apiKey: merged.api_key, listen, configPath };
}
