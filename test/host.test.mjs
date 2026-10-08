/**
 * 宿主半侧（lib/index.js）的离线测试。
 *
 * 手法：mock 一个最小 ctx（tools/webServer/settings/credentials/effect/logger），
 * 起 tools/stub-service.mjs 当假 wb2api，然后**直接调用路由 handler**（不监听端口、
 * 不开浏览器），并用工具定义里的 execute 走同一批宿主方法。
 *
 * 不覆盖：真实下载安装（见 install.test.mjs）、真实进程启停（见 core.test.mjs）、
 * 浏览器里的渲染（官方禁止截图验证）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { apply, name as pluginName, inject as pluginInject } from '../lib/index.js';
import { detectTarget, exeNameFor } from '../lib/core/platform.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = 7869;
const KEY = 'test-key';
const BASE = `http://127.0.0.1:${PORT}`;
const MOUNT_KEY = Symbol.for('dsh.wb2api.mounted');

/**
 * 取一个当前空闲的端口。
 * 不能写死别的端口：`node --test` 会并行跑不同测试文件，contract.test.mjs 正占着 7870
 * （曾经用 PORT+1 就踩上了，导致"启动必须失败"的用例误判成健康）。
 */
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

let stub;
let installDir;
let ctx;
let states;

/** 收集一次 apply 里的所有可观察副产物。 */
function makeCtx() {
  const record = {
    routes: [],
    routeDisposed: 0,
    tool: null,
    toolDisposed: 0,
    effects: [],
    credentialSets: [],
    settingsUpdates: [],
  };
  const settings = {
    describe: () =>
      states.settingsValue === null
        ? []
        : [
            {
              ns: 'llm-pi-ai',
              schema: {},
              revision: states.revision,
              applies: 'live',
              value: states.settingsValue,
              base: {},
              user: {},
            },
          ],
    update: async (ns, patch, revision) => {
      record.settingsUpdates.push({ ns, patch, revision });
      if (revision !== undefined && revision !== states.revision) {
        throw new Error(`settings namespace "${ns}" changed since it was read (expected revision ${revision}, now ${states.revision})`);
      }
      states.revision += 1;
      const next = { ...(states.settingsValue ?? {}) };
      next.providers = { ...(next.providers ?? {}) };
      for (const [id, profile] of Object.entries(patch.providers ?? {})) {
        next.providers[id] = { ...(next.providers[id] ?? {}), ...profile };
      }
      states.settingsValue = next;
      return { revision: states.revision };
    },
  };
  const credentials = {
    describe: async (ref) => ({ ref, configured: false, writable: true }),
    resolve: async () => null,
    set: async (ref, value) => {
      record.credentialSets.push({ ref, value });
    },
  };
  const webServer = {
    register(route) {
      record.routes.push(route);
      return () => {
        record.routeDisposed += 1;
        const i = record.routes.indexOf(route);
        if (i >= 0) record.routes.splice(i, 1);
      };
    },
  };
  const context = {
    get: (service) => {
      if (service === 'webServer') return webServer;
      if (service === 'settings') return settings;
      if (service === 'credentials') return credentials;
      return undefined;
    },
    tools: {
      register(definition) {
        record.tool = definition;
        return () => {
          record.toolDisposed += 1;
          record.tool = null;
        };
      },
    },
    effect(fn, label) {
      record.effects.push(label);
      return fn();
    },
    logger: { warn() {}, info() {}, debug() {} },
  };
  return { context, record, settings, credentials };
}

function makeReq({ method = 'GET', path = '/status', body = null, remote = '127.0.0.1', headers = {} } = {}) {
  const chunks =
    body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    method,
    url: `/api/dsh-wb2api${path}`,
    headers: { host: '127.0.0.1:19387', ...headers },
    socket: { remoteAddress: remote },
    destroy() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function makeRes() {
  const res = {
    status: 0,
    headers: null,
    body: '',
    headersSent: false,
    destroyed: false,
    writeHead(code, headers) {
      res.status = code;
      res.headers = headers ?? null;
      res.headersSent = true;
    },
    end(text) {
      res.body = text ?? '';
    },
    destroy() {
      res.destroyed = true;
    },
  };
  return res;
}

async function call(route, options) {
  const res = makeRes();
  await route.handler(makeReq(options), res);
  let json = null;
  try {
    json = res.body === '' ? null : JSON.parse(res.body);
  } catch {
    json = null;
  }
  return { status: res.status, headers: res.headers, raw: res.body, json, res };
}

async function waitForStub(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('stub 服务没起来');
}

before(async () => {
  installDir = mkdtempSync(join(tmpdir(), 'dsh-wb2api-host-'));
  const statePath = join(installDir, 'stub-state.json');
  const accounts = [1, 2].map((n) => ({
    uid: `stub-uid-${n}`,
    nickname: `测试账号${n}`,
    realm: n === 1 ? 'cn' : 'global',
    credits: 500,
    credits_total: 500,
    credits_earliest_expiry: new Date(Date.now() + 14 * 86400000).toISOString(),
    credits_earliest_remaining: 500,
    disabled: false,
    cooling: false,
    in_flight: 0,
    token_usage: {
      last_model: 'alpha',
      total_tokens: 197831916,
      request_count: 2030,
      last_latency_ms: 7207,
      usage_count: 2011,
      prompt_tokens: 195810282,
      completion_tokens: 2021634,
      last_tokens_per_second: 129.596,
      last_used_at: '2026-10-08T06:31:36.530Z',
    },
    success_count: 2014,
    last_success: '2026-10-08T06:31:32.000Z',
    model_costs: [{ model: 'cn:alpha', cost_per_1k: 0.001325659805367059, last_seen: '2026-10-08T06:31:36.530Z', samples: 233 }],
  }));
  writeFileSync(statePath, JSON.stringify({ accounts }, null, 2));
  writeFileSync(join(installDir, exeNameFor(detectTarget().os)), '');
  writeFileSync(join(installDir, 'config.json'), JSON.stringify({ listen: `127.0.0.1:${PORT}`, api_key: KEY }, null, 2));

  stub = spawn(process.execPath, [join(HERE, '..', 'tools', 'stub-service.mjs'), '--port', String(PORT), '--state', statePath, '--key', KEY, '--models', '6'], {
    cwd: REPO,
    stdio: 'ignore',
    windowsHide: true,
  });
  await waitForStub();
});

after(() => {
  try {
    stub?.kill();
  } catch {
    /* ignore */
  }
  try {
    rmSync(installDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

test('插件导出形状符合宿主契约', () => {
  assert.equal(pluginName, 'dsh-wb2api');
  assert.deepEqual(pluginInject, ['tools']);
  assert.equal(typeof apply, 'function');
});

test('apply 注册工具与一条 prefix 路由', () => {
  delete globalThis[MOUNT_KEY];
  states = {
    revision: 7,
    settingsValue: {
      providers: {
        wb2api: {
          displayName: 'WorkBuddy2API (本机)',
          api: 'openai-completions',
          baseURL: `${BASE}/v1`,
          apiKeyEnv: 'WB2API_KEY',
          models: [{ id: 'cn:alpha', name: 'Alpha 自定义' }],
        },
      },
    },
  };
  const made = makeCtx();
  ctx = made.context;
  const handle = apply(ctx, {
    installDir,
    host: '127.0.0.1',
    port: PORT,
    autoStart: false,
    autoInstall: false,
    autoOpenPanelWhenEmpty: false,
    killOnExit: false,
  });
  assert.ok(handle, 'apply 应返回句柄（未被重复挂载保护挡住）');
  assert.equal(made.record.tool?.name, 'workbuddy');
  assert.equal(made.record.tool.parameters.properties.action.enum.length, 9);
  for (const action of ['status', 'install', 'login', 'models', 'keep', 'start', 'stop', 'restart', 'open_panel']) {
    assert.ok(made.record.tool.parameters.properties.action.enum.includes(action), `action ${action} 缺失`);
  }
  assert.equal(typeof made.record.tool.output.render, 'function');
  assert.equal(made.record.routes.length, 1);
  assert.equal(made.record.routes[0].kind, 'prefix');
  assert.equal(made.record.routes[0].path, '/api/dsh-wb2api');
  assert.deepEqual(made.record.effects, ['dsh-wb2api: lifecycle']);
  globalThis.__hostRecord = made.record;
  globalThis.__hostHandle = handle;
});

test('重复挂载被保护，不会再注册一遍', () => {
  const made = makeCtx();
  const again = apply(made.context, { installDir, port: PORT });
  assert.equal(again, undefined);
  assert.equal(made.record.routes.length, 0);
  assert.equal(made.record.tool, null);
});

test('非回环来源一律 403，且 CORS 预检方法不符时 405', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const denied = await call(route, { path: '/status', remote: '10.1.2.3' });
  assert.equal(denied.status, 403);
  assert.match(denied.json.error, /loopback/);

  const crossSite = await call(route, { path: '/status', headers: { 'sec-fetch-site': 'cross-site' } });
  assert.equal(crossSite.status, 403);

  const badOrigin = await call(route, { path: '/status', headers: { origin: 'http://evil.example' } });
  assert.equal(badOrigin.status, 403);

  const sameOrigin = await call(route, { path: '/status', headers: { origin: 'http://127.0.0.1:19387', 'sec-fetch-site': 'same-origin' } });
  assert.equal(sameOrigin.status, 200);

  const wrongMethod = await call(route, { method: 'POST', path: '/status', body: {} });
  assert.equal(wrongMethod.status, 405);
  assert.equal(wrongMethod.headers.allow, 'GET', 'Allow 头应带 GET');

  void ctx;
});

test('GET status 返回服务/账号/模型快照', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const res = await call(route, { path: '/status' });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.equal(res.json.service.installed, true);
  assert.equal(res.json.service.baseURL, BASE);
  assert.equal(res.json.service.installDir, installDir);
  assert.equal(res.json.accounts.length, 2);
  assert.equal(res.json.accounts[0].nickname, '测试账号1');
  assert.ok(res.json.accounts[0].expiry, '应带最早到期时间');
  // 用量统计必须透传给设置页（否则「用量」卡片永远是空的）
  assert.equal(res.json.accounts[0].requestCount, 2030);
  assert.equal(res.json.accounts[0].totalTokens, 197831916);
  assert.equal(res.json.accounts[0].promptTokens, 195810282);
  assert.equal(res.json.accounts[0].completionTokens, 2021634);
  assert.equal(res.json.accounts[0].successCount, 2014);
  assert.equal(res.json.accounts[0].lastTokensPerSecond, 129.596);
  assert.equal(res.json.accounts[0].modelCosts.length, 1);
  assert.equal(res.json.accounts[0].modelCosts[0].model, 'cn:alpha');
  assert.equal(res.json.accounts[0].lastModel, 'alpha');
  assert.equal(res.json.models.available, 6);
  assert.deepEqual(res.json.models.keep, ['cn:alpha']);
  assert.equal(res.json.install.busy, false);
});

test('GET models 列 6 个模型并标记保留项', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const res = await call(route, { path: '/models' });
  assert.equal(res.status, 200);
  // 形状必须与设置页一致：lib/client.js 的 refresh() 读的是 Array.isArray(modelList.models)
  assert.ok(Array.isArray(res.json.models), 'models 必须是扁平数组');
  assert.equal(res.json.models.length, 6);
  assert.deepEqual(res.json.keep, ['cn:alpha']);
  assert.equal(res.json.realm, 'all');
  assert.equal(res.json.available, 6);
  const alpha = res.json.models.find((m) => m.id === 'cn:alpha');
  const beta = res.json.models.find((m) => m.id === 'cn:beta');
  assert.equal(alpha.kept, true);
  assert.equal(beta.kept, false);
  assert.equal(alpha.realm, 'cn');
  assert.equal(beta.supportsImages, true);
  assert.equal(typeof beta.contextLength, 'number');
});

test('POST keep 写入设置：复用旧字段、跳过不存在的 id', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const res = await call(route, { method: 'POST', path: '/keep', body: { keep: ['cn:alpha', 'cn:gamma', 'cn:nope'] } });
  assert.equal(res.status, 200);
  assert.equal(res.json.ok, true);
  assert.deepEqual(res.json.keep, ['cn:alpha', 'cn:gamma']);
  assert.deepEqual(res.json.missing, ['cn:nope']);
  assert.equal(res.json.total, 6);

  const written = states.settingsValue.providers.wb2api.models;
  assert.deepEqual(written.map((m) => m.id), ['cn:alpha', 'cn:gamma']);
  assert.equal(written[0].name, 'Alpha 自定义', '已存在的 id 应保留用户改过的字段');
  assert.equal(written[0].apiKeyEnv, undefined, 'model 行不应被塞入 provider 级字段');
  assert.equal(states.settingsValue.providers.wb2api.apiKeyEnv, 'WB2API_KEY');
  assert.equal(states.settingsValue.providers.wb2api.baseURL, `${BASE}/v1`, 'provider 已有字段不该被覆盖');
  const last = globalThis.__hostRecord.settingsUpdates.at(-1);
  assert.equal(last.ns, 'llm-pi-ai');
  assert.equal(typeof last.revision, 'number');
});

test('keep 空清单必须显式带 all:true，否则 400', async () => {
  const route = globalThis.__hostRecord.routes[0];
  // 手滑发一个空的 keep 会让 46 个模型全写进 profile，所以必须显式确认
  const accidental = await call(route, { method: 'POST', path: '/keep', body: { keep: [] } });
  assert.equal(accidental.status, 400);
  assert.match(accidental.json.error, /全部保留/);

  const explicit = await call(route, { method: 'POST', path: '/keep', body: { keep: [], all: true } });
  assert.equal(explicit.status, 200);
  assert.equal(explicit.json.all, true);
  assert.equal(explicit.json.keep.length, 6);
  assert.equal(states.settingsValue.providers.wb2api.models.length, 6);
});

test('keep 请求体不合法时 400', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const bad = await call(route, { method: 'POST', path: '/keep', body: 'not-json' });
  assert.equal(bad.status, 400);
  const shape = await call(route, { method: 'POST', path: '/keep', body: { keep: 'cn:alpha' } });
  assert.equal(shape.status, 400);
});

test('设置冲突时重读 revision 再写一次', async () => {
  const route = globalThis.__hostRecord.routes[0];
  states.revision += 5; // 模拟别的窗口改了设置
  const res = await call(route, { method: 'POST', path: '/keep', body: { keep: ['cn:beta'] } });
  assert.equal(res.status, 200);
  assert.deepEqual(res.json.keep, ['cn:beta']);
  const attempts = globalThis.__hostRecord.settingsUpdates.slice(-2);
  assert.equal(attempts.length, 2, '应重试一次');
  assert.notEqual(attempts[0].revision, attempts[1].revision);
});

test('加账号：login/start 拿链接、login/poll 轮询到完成', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const started = await call(route, { method: 'POST', path: '/login/start', body: { realm: 'global' } });
  assert.equal(started.status, 200);
  assert.match(started.json.url, /^https:/);
  assert.ok(started.json.state);

  const first = await call(route, { path: `/login/poll?state=${encodeURIComponent(started.json.state)}` });
  assert.equal(first.json.done, false);
  const second = await call(route, { path: `/login/poll?state=${encodeURIComponent(started.json.state)}` });
  assert.equal(second.json.done, false);
  const third = await call(route, { path: `/login/poll?state=${encodeURIComponent(started.json.state)}` });
  assert.equal(third.json.done, true);
  assert.equal(third.json.nickname, '测试账号3');
  assert.equal(third.json.realm, 'global');
  assert.equal(third.json.creditsTotal, 500);

  const missing = await call(route, { path: '/login/poll' });
  assert.equal(missing.status, 400, '缺 state 参数应 400');

  const snap = await call(route, { path: '/status' });
  assert.equal(snap.json.accounts.length, 3, '新账号应出现在状态里');
});

test('未知路由 404，方法不符 405，非法 JSON 400', async () => {
  const route = globalThis.__hostRecord.routes[0];
  assert.equal((await call(route, { path: '/nope' })).status, 404);
  assert.equal((await call(route, { method: 'GET', path: '/login/start' })).status, 405);
  assert.equal((await call(route, { method: 'POST', path: '/login/start', body: '{' })).status, 400);
  assert.equal((await call(route, { method: 'POST', path: '/install', body: '{' })).status, 400);
});

test('service 路由只接受三种动作', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const bad = await call(route, { method: 'POST', path: '/service', body: { action: 'explode' } });
  assert.equal(bad.status, 400);
  assert.match(bad.json.error, /explode/);
});

test('service 路由：启动失败时返回 ok:false 与原因，而不是假成功', async () => {
  // 真机痛点：以前这个分支忽略 startService 的结果，设置页点"启动"失败也显示成功。
  const keepRecord = globalThis.__hostRecord;
  delete globalThis[MOUNT_KEY];
  const made = makeCtx();
  // 换个真的空闲端口，逼 ensureService 去 spawn；exe 是上面写的空文件（存在但不是程序）。
  const deadPort = await freePort();
  const handle = apply(made.context, {
    installDir,
    host: '127.0.0.1',
    port: deadPort,
    autoStart: false,
    autoInstall: false,
    autoOpenPanelWhenEmpty: false,
    killOnExit: false,
  });
  try {
    assert.ok(handle, '第二个实例应能挂载（已清掉单实例标记）');
    const res = await call(made.record.routes[0], { method: 'POST', path: '/service', body: { action: 'start' } });
    assert.equal(res.status, 200);
    assert.equal(res.json.ok, false, '启动失败必须是 ok:false');
    assert.match(res.json.error, /拉起失败|无法启动|可执行文件/, `要带回失败原因：${res.json.error}`);
    assert.ok(res.json.service, '失败时也要带上服务快照');
  } finally {
    handle.dispose();
    globalThis.__hostRecord = keepRecord;
  }
});

test('config 路由校验 host:port 并保留 api_key', async () => {
  const route = globalThis.__hostRecord.routes[0];
  const bad = await call(route, { method: 'POST', path: '/config', body: { server: 'not a server' } });
  assert.equal(bad.status, 400);

  // 换端口必须被挡：插件健康检查与 DSH 里 provider 的 baseURL 都写死 cfg.host:cfg.port，
  // 放行的话网关换了端口，插件会一直报"未运行"。
  const wrongPort = await call(route, { method: 'POST', path: '/config', body: { server: '127.0.0.1:9999' } });
  assert.equal(wrongPort.status, 400, '换端口必须拒绝');
  assert.match(wrongPort.json.error, /换端口/);

  const remote = await call(route, { method: 'POST', path: '/config', body: { server: `10.0.0.5:${PORT}` } });
  assert.equal(remote.status, 400, '只接受本机地址');

  const alias = await call(route, { method: 'POST', path: '/config', body: { server: `localhost:${PORT}` } });
  assert.equal(alias.status, 200, 'localhost 是等价的本机地址');

  const wildcard = await call(route, { method: 'POST', path: '/config', body: { server: `0.0.0.0:${PORT}` } });
  assert.equal(wildcard.status, 200, '监听 0.0.0.0 也合法，插件照样能经 127.0.0.1 访问');

  const good = await call(route, { method: 'POST', path: '/config', body: { server: `127.0.0.1:${PORT}` } });
  assert.equal(good.status, 200);
  assert.equal(good.json.ok, true);
  const saved = JSON.parse(readFileSync(join(installDir, 'config.json'), 'utf8'));
  assert.equal(saved.listen, `127.0.0.1:${PORT}`);
  assert.equal(saved.api_key, KEY, 'apiKey 为空时应保留原值');
});

test('workbuddy 工具复用同一批宿主方法', async () => {
  const tool = globalThis.__hostRecord.tool;
  const status = await tool.execute({ action: 'status' });
  assert.match(status.text, /服务：已安装/);
  assert.match(status.text, /测试账号1/);
  // agent 侧的 status 文本也要带用量摘要，不然问「用了多少」只能拿到一句「运行中」
  assert.match(status.text, /用量：2030 次请求（成功 2014），累计 197\.8M tokens/);
  assert.match(status.text, /129\.6 tok\/s/);

  const models = await tool.execute({ action: 'models', query: 'alpha' });
  assert.match(models.text, /cn:alpha/);
  assert.ok(!models.text.includes('cn:beta'), 'query 过滤后不该出现不匹配的模型');

  const keep = await tool.execute({ action: 'keep', keep: ['cn:alpha', 'cn:beta'] });
  assert.match(keep.text, /已保留 2 个模型/);

  const unknown = await tool.execute({ action: 'nope' });
  assert.match(unknown.text, /不认识的动作/);
});

test('凭据：config.json 的 api_key 被写进 credentials 服务', async () => {
  const sets = globalThis.__hostRecord.credentialSets;
  assert.ok(sets.length >= 1, 'provision 应写一次凭据');
  assert.deepEqual(sets[0], { ref: 'WB2API_KEY', value: KEY });
});

test('dispose 撤销路由/工具并解除挂载标记', () => {
  const record = globalThis.__hostRecord;
  const handle = globalThis.__hostHandle;
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
  assert.equal(record.toolDisposed, 1);
  assert.equal(record.routeDisposed, 1);
  assert.equal(globalThis[MOUNT_KEY], undefined, '卸载后应能重新挂载');
  assert.equal(existsSync(join(installDir, 'dsh-wb2api.log')), true, '插件日志应落在 installDir');
});

test('冷启动：webServer 晚于插件就绪时，用 ctx.inject 等到它再注册路由', async () => {
  // 真机踩过的坑：冷启动时 apply 里 ctx.get('webServer') 还是 undefined，
  // 结果设置页路由没注册，整个设置页 401。这里锁住 ctx.inject 这条等待路径。
  const made = makeCtx();
  let injected = null;
  const context = {
    ...made.context,
    get: (service) => (service === 'webServer' ? undefined : made.context.get(service)),
    inject: (deps, callback) => {
      injected = { deps, callback };
    },
  };
  delete globalThis[MOUNT_KEY];
  const handle = apply(context, { installDir, autoStart: false, autoInstall: false, killOnExit: false });
  try {
    assert.deepEqual(injected?.deps, ['webServer'], '应当用 ctx.inject 等 webServer');
    assert.equal(made.record.routes.length, 0, 'webServer 还没出现时不该注册路由');

    // cordis 在服务就绪后会运行回调，回调收到的是带该服务的子作用域
    // （真机上就是这样：父 ctx 拿不到，注入出来的 scoped 能拿到）
    const cleanups = [];
    const ws = made.context.get('webServer');
    injected.callback({ webServer: ws, effect: (fn, label) => cleanups.push([fn(), label]) });
    assert.equal(made.record.routes.length, 1, 'webServer 就绪后应注册路由');
    assert.equal(made.record.routes[0].path, '/api/dsh-wb2api');
    assert.equal(cleanups.length, 1);

    // 子作用域清理：撤销路由，dispose 时不再重复撤销
    cleanups[0][0]();
    assert.equal(made.record.routeDisposed, 1);
  } finally {
    handle.dispose();
  }
});
