/**
 * 测试用的假 wb2api 服务：只实现插件真正用到的那几个接口。
 *
 * 用法：
 *   node tools/stub-service.mjs --port 7869 --state ./stub-state.json --key test-key [--models 6]
 *
 * 放在 tools/ 而不是 test/：`node --test` 不带参数会把 test/ 目录下的每个文件都当测试跑，
 * 这个常驻服务会让测试进程永远不退出。
 *
 * 账号数量由 state 文件里的 accounts 数组决定；插件「加账号」流程会往里追加。
 */
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const PORT = Number(arg('port', '7869'));
const STATE_PATH = arg('state', './stub-state.json');
const KEY = arg('key', 'test-key');
const MODEL_COUNT = Number(arg('models', '6'));

const MODELS = [
  { id: 'cn:alpha', name: 'Alpha', context_length: 1000000, max_output_tokens: 65536, credits: 'x0.06', supports_images: false, supports_reasoning: true, supports_tool_call: true },
  { id: 'cn:beta', name: 'Beta', context_length: 200000, max_output_tokens: 32768, credits: 'x0.1', supports_images: true, supports_reasoning: true, supports_tool_call: true },
  { id: 'cn:gamma', name: 'Gamma', context_length: 128000, max_output_tokens: 16384, credits: 'x0.02', supports_images: false, supports_reasoning: false, supports_tool_call: true },
  { id: 'global:delta', name: 'Delta', context_length: 400000, max_output_tokens: 64000, credits: 'x0.3', supports_images: true, supports_reasoning: true, supports_tool_call: true },
  { id: 'global:epsilon', name: 'Epsilon', context_length: 1000000, max_output_tokens: 128000, credits: 'x0.5', supports_images: true, supports_reasoning: true, supports_tool_call: true },
  { id: 'global:zeta', name: 'Zeta', context_length: 64000, max_output_tokens: 8192, credits: 'x0.01', supports_images: false, supports_reasoning: false, supports_tool_call: false },
].slice(0, MODEL_COUNT);

function loadState() {
  if (!existsSync(STATE_PATH)) return { accounts: [] };
  try {
    return JSON.parse(readFileSync(STATE_PATH, 'utf8'));
  } catch {
    return { accounts: [] };
  }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** 每个登录会话的轮询计数：第 3 次 poll 才 done，模拟真实授权需要时间。 */
const pending = new Map();
let seq = 0;

function json(res, code, body) {
  const text = JSON.stringify(body);
  res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://127.0.0.1:${PORT}`);
  const state = loadState();
  const auth = req.headers.authorization ?? '';

  if (url.pathname === '/healthz') {
    return json(res, 200, {
      healthy: state.accounts.length,
      realm_servable: { cn: true, global: true },
      service: 'workbuddy2api-stub',
      total: state.accounts.length,
    });
  }
  if (auth !== `Bearer ${KEY}`) return json(res, 401, { error: 'unauthorized' });

  if (url.pathname === '/v1/models') {
    return json(res, 200, { object: 'list', data: MODELS });
  }
  if (url.pathname === '/panel/api/overview') {
    return json(res, 200, {
      accounts: state.accounts,
      auth_required: true,
      cooling: 0,
      disabled: 0,
      healthy: state.accounts.length,
      in_flight_full: 0,
      redis_mode: 'noop',
      sticky_sessions: 0,
      total: state.accounts.length,
      uptime_sec: Math.round(process.uptime()),
      version: 'stub-0.0.1',
    });
  }
  if (url.pathname === '/panel/api/login/start' && req.method === 'POST') {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      let realm = 'cn';
      try {
        realm = JSON.parse(body || '{}').realm ?? 'cn';
      } catch {
        /* 用默认值 */
      }
      seq += 1;
      const loginState = `stub-${seq}`;
      pending.set(loginState, { realm, polls: 0 });
      json(res, 200, { state: loginState, url: `https://example.invalid/auth?state=${loginState}` });
    });
    return undefined;
  }
  if (url.pathname === '/panel/api/login/poll') {
    const loginState = url.searchParams.get('state');
    const entry = pending.get(loginState);
    if (!entry) return json(res, 404, { error: 'unknown state' });
    entry.polls += 1;
    if (entry.polls < 3) return json(res, 200, { done: false });
    pending.delete(loginState);
    const next = loadState();
    const account = {
      uid: `stub-uid-${next.accounts.length + 1}`,
      nickname: `测试账号${next.accounts.length + 1}`,
      realm: entry.realm,
      credits: 500,
      credits_total: 500,
      credits_earliest_expiry: new Date(Date.now() + 14 * 86400000).toISOString(),
      credits_earliest_remaining: 500,
      disabled: false,
      cooling: false,
      in_flight: 0,
      token_usage: {
        last_model: 'alpha',
        total_tokens: 12345,
        request_count: 7,
        last_latency_ms: 1200,
        usage_count: 7,
        prompt_tokens: 11000,
        completion_tokens: 1345,
        last_tokens_per_second: 88.5,
        last_used_at: new Date().toISOString(),
      },
    };
    next.accounts.push(account);
    saveState(next);
    return json(res, 200, { done: true, nickname: account.nickname, uid: account.uid, realm: account.realm, credits: 500, credits_total: 500 });
  }
  return json(res, 404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`stub wb2api on http://127.0.0.1:${PORT}（models=${MODELS.length}，state=${STATE_PATH}）`);
});
