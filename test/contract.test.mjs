/**
 * 跨半侧契约测试：把**真实的** lib/client.js 装进 vm 跑起来，让它对着**真实的** lib/index.js
 * 路由发请求（中间只垫一层 fetch 桥）。
 *
 * 存在的理由：宿主和设置页是两个人分开写的，各自单测都能过，但"宿主返回的形状"与
 * "设置页读的字段"一旦错位，只有联调时才炸（本次就抓到一次：宿主把模型列表放在
 * `modelList`，设置页读的是 `models`，页面于是永远显示"没有模型"）。
 *
 * 不覆盖：真实 React 渲染、真实浏览器观感（官方禁止截图验证）、真实进程启停与真实下载
 * （那两条会碰真机上的 wb2api 进程与外网，见 core.test.mjs / install.test.mjs）。
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createContext, runInContext } from 'node:vm';

import { apply } from '../lib/index.js';
import { detectTarget, exeNameFor } from '../lib/core/platform.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = join(HERE, '..');
const PORT = 7870; // 与 host.test.mjs 的 7869 错开：node --test 会并行跑不同文件
const KEY = 'contract-key';
const BASE = `http://127.0.0.1:${PORT}`;
const ROUTE_PREFIX = '/api/dsh-wb2api';
const ORIGIN = 'http://127.0.0.1:19387';

let stub;
let installDir;
let states;
let record;
let handle;
let api;
let controller;
let requestLog;

// ---------------------------------------------------------------- 宿主侧 mock

function makeCtx() {
  const rec = {
    routes: [],
    routeDisposed: 0,
    tool: null,
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
      rec.settingsUpdates.push({ ns, patch, revision });
      if (revision !== undefined && revision !== states.revision) {
        throw new Error(
          `settings namespace "${ns}" changed since it was read (expected revision ${revision}, now ${states.revision})`,
        );
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
      rec.credentialSets.push({ ref, value });
    },
  };
  const webServer = {
    register(route) {
      rec.routes.push(route);
      return () => {
        rec.routeDisposed += 1;
        const i = rec.routes.indexOf(route);
        if (i >= 0) rec.routes.splice(i, 1);
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
        rec.tool = definition;
        return () => {
          rec.tool = null;
        };
      },
    },
    effect(fn) {
      rec.effects.push('lifecycle');
      return fn();
    },
    logger: { warn() {}, info() {}, debug() {} },
  };
  return { context, record: rec };
}

function makeReq({ method = 'GET', path = '/status', body = null, headers = {} } = {}) {
  const chunks = body === null ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8')];
  return {
    method,
    url: `${ROUTE_PREFIX}${path}`,
    headers: { host: '127.0.0.1:19387', origin: ORIGIN, 'sec-fetch-site': 'same-origin', ...headers },
    socket: { remoteAddress: '127.0.0.1' },
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
    writeHead(code, headers) {
      res.status = code;
      res.headers = headers ?? null;
      res.headersSent = true;
    },
    end(text) {
      res.body = text ?? '';
    },
    destroy() {},
  };
  return res;
}

async function waitForStub(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${BASE}/healthz`);
      if (res.ok) return;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error('stub 服务没起来');
}

/** 把设置页的 fetch 原样接到宿主路由上：这是本文件的核心机关。 */
function makeFetchBridge(route, log) {
  return async (path, init) => {
    const method = String(init?.method ?? 'GET').toUpperCase();
    const body = init?.body === undefined || init.body === null ? null : JSON.parse(String(init.body));
    log.push({ path: String(path), method, body });

    const url = new URL(String(path), `${ORIGIN}/`);
    const res = makeRes();
    await route.handler(makeReq({ method, path: `${url.pathname.slice(ROUTE_PREFIX.length)}${url.search}`, body }), res);
    let json = null;
    try {
      json = res.body === '' ? null : JSON.parse(res.body);
    } catch {
      json = null;
    }
    return {
      ok: res.status >= 200 && res.status < 300,
      status: res.status,
      headers: { get: () => null },
      json: async () => json,
    };
  };
}

// ---------------------------------------------------------------- 客户端侧装载

/** 在 vm 里执行真正的 lib/client.js，取出它的 api 对象与 controller。 */
function loadClient(bridgeFetch) {
  const text = readFileSync(join(REPO, 'lib', 'client.js'), 'utf8');
  let registration = null;

  const React = {
    createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props ?? {}), children } }),
    memo: (component) => component,
    Component: class {
      constructor(props) {
        this.props = props ?? {};
      }
      render() {
        return null;
      }
    },
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useRef: (initial) => ({ current: initial }),
    useMemo: (factory) => factory(),
    useEffect: () => {},
    useSyncExternalStore: (_subscribe, getSnapshot) => getSnapshot(),
  };

  const styles = [];
  const sandbox = {
    console,
    React,
    fetch: bridgeFetch,
    URL,
    URLSearchParams,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    document: {
      head: { appendChild: (el) => styles.push(el) },
      getElementById: () => null,
      createElement: () => ({ id: '', textContent: '', dataset: {}, setAttribute() {}, appendChild() {} }),
    },
    navigator: { clipboard: { writeText: async () => {} } },
    window: {
      __ModuleLoader__: {
        load(reg) {
          registration = reg;
        },
      },
    },
  };
  createContext(sandbox);
  runInContext(text, sandbox, { filename: 'lib/client.js' });

  assert.ok(registration, 'client.js 应当调用 window.__ModuleLoader__.load');
  const require = (id) => {
    if (id === 'react') return React;
    if (id === 'react/jsx-runtime') return { jsx: React.createElement, jsxs: React.createElement };
    throw new Error(`客户端 require 了白名单外的模块：${id}`);
  };
  const plugin = registration.factory(require);

  const captured = { section: null };
  const ctx = {
    effect: (fn) => fn(),
    locale: {
      register: () => () => {},
      bind: () => (key) => key,
    },
    slots: {
      inject: (_name, fn) => fn(),
      register: (options, render) => {
        captured.section = { options, render };
        return () => {};
      },
    },
  };
  plugin.apply(ctx);
  assert.ok(captured.section, '应当注册 settings.section');

  const element = captured.section.render();
  return {
    id: registration.id,
    plugin,
    section: captured.section,
    styles,
    api: element.props.api,
    controller: element.props.controller,
  };
}

// ---------------------------------------------------------------- 生命周期

before(async () => {
  installDir = mkdtempSync(join(tmpdir(), 'dsh-wb2api-contract-'));
  const statePath = join(installDir, 'stub-state.json');
  const accounts = [1, 2].map((n) => ({
    uid: `stub-uid-${n}`,
    nickname: `契约账号${n}`,
    realm: n === 1 ? 'cn' : 'global',
    credits: 400,
    credits_total: 400,
    credits_earliest_expiry: new Date(Date.now() + 14 * 86400000).toISOString(),
    credits_earliest_remaining: 400,
    disabled: false,
    cooling: false,
    in_flight: 0,
    token_usage: { last_model: 'alpha', total_tokens: 100, request_count: 2, last_latency_ms: 900 },
  }));
  writeFileSync(statePath, JSON.stringify({ accounts }, null, 2));
  writeFileSync(join(installDir, exeNameFor(detectTarget().os)), '');
  writeFileSync(join(installDir, 'config.json'), JSON.stringify({ listen: `127.0.0.1:${PORT}`, api_key: KEY }, null, 2));

  stub = spawn(
    process.execPath,
    [join(REPO, 'tools', 'stub-service.mjs'), '--port', String(PORT), '--state', statePath, '--key', KEY, '--models', '6'],
    { cwd: REPO, stdio: 'ignore', windowsHide: true },
  );
  await waitForStub();

  delete globalThis[Symbol.for('dsh.wb2api.mounted')];
  states = {
    revision: 3,
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
  record = made.record;
  handle = apply(made.context, {
    installDir,
    host: '127.0.0.1',
    port: PORT,
    autoStart: false,
    autoInstall: false,
    autoOpenPanelWhenEmpty: false,
    killOnExit: false,
  });
  assert.ok(handle, '宿主插件应当挂载成功');
  assert.equal(record.routes.length, 1);

  requestLog = [];
  const bridge = makeFetchBridge(record.routes[0], requestLog);
  const client = loadClient(bridge);
  api = client.api;
  controller = client.controller;
  globalThis.__client = client;
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

// ---------------------------------------------------------------- 用例

test('设置页注册的席位与注入列表符合客户端契约', () => {
  const client = globalThis.__client;
  assert.equal(client.id, 'dsh-wb2api', 'ModuleLoader.load 的 id 必须等于包名');
  assert.deepEqual([...client.plugin.inject], ['slots', 'locale']);
  assert.equal(client.section.options.name, 'settings.section');
  assert.equal(client.section.options.id, 'wb2api');
  assert.equal(typeof client.section.options.label, 'function');
  assert.equal(client.styles.length, 1, '样式只注入一次');
});

test('设置页请求路径不带前导斜杠（GUI 用 <base href="./">）', async () => {
  requestLog.length = 0;
  await api.status();
  assert.equal(requestLog.length, 1);
  assert.equal(requestLog[0].path, 'api/dsh-wb2api/status');
  assert.ok(!requestLog[0].path.startsWith('/'), '带前导斜杠在 GUI 里会静默 404');
});

test('controller.refresh 经真实宿主拿到状态、账号与模型列表', async () => {
  await controller.refresh({ refreshModels: true });
  const snap = controller.getSnapshot();
  assert.equal(snap.error, null, `不该有错误：${snap.error}`);
  assert.equal(snap.loaded, true);
  assert.equal(snap.status.service.installed, true);
  assert.equal(snap.status.accounts.length, 2);
  assert.equal(snap.status.accounts[0].nickname, '契约账号1');
  // 这条断言就是本次联调抓到的那个错位：宿主若把数组放在别的键上，这里会退回空数组
  assert.ok(Array.isArray(snap.models), 'models 必须是数组');
  assert.equal(snap.models.length, 6, '设置页应看到 6 个模型');
  assert.deepEqual(snap.keepSaved, ['cn:alpha']);
  const alpha = snap.models.find((m) => m.id === 'cn:alpha');
  assert.equal(alpha.kept, true, '已保留的模型要打勾');
  assert.equal(snap.models.filter((m) => m.kept).length, 1);
});

test('模型接口带 refresh=1，返回扁平数组与 keep/realm', async () => {
  requestLog.length = 0;
  const res = await api.models('1');
  assert.match(requestLog[0].path, /\?refresh=1$/);
  assert.equal(res.ok, true);
  assert.equal(Array.isArray(res.models), true);
  assert.equal(res.models.length, 6);
  assert.deepEqual(res.keep, ['cn:alpha']);
  assert.equal(res.realm, 'all');
  assert.equal(res.available, 6);
  const beta = res.models.find((m) => m.id === 'cn:beta');
  assert.equal(beta.realm, 'cn');
  assert.equal(beta.supportsImages, true);
  assert.equal(beta.kept, false);
});

test('保存模型清单：设置页调用后宿主真的写进设置，刷新后同步', async () => {
  requestLog.length = 0;
  const res = await api.keep(['cn:alpha', 'global:delta']);
  assert.equal(res.ok, true);
  assert.deepEqual(res.keep, ['cn:alpha', 'global:delta']);
  assert.equal(requestLog[0].method, 'POST');
  assert.deepEqual(requestLog[0].body, { keep: ['cn:alpha', 'global:delta'], all: false });

  const written = states.settingsValue.providers.wb2api.models;
  assert.deepEqual(written.map((m) => m.id), ['cn:alpha', 'global:delta']);
  assert.equal(written[0].name, 'Alpha 自定义', '已存在的 id 要保留用户改过的 name');

  await controller.refresh();
  assert.deepEqual(controller.getSnapshot().keepSaved, ['cn:alpha', 'global:delta']);

  // 空清单 = 全部保留：设置页必须显式带 all:true（宿主对没带的空清单返回 400）
  const all = await api.keep([]);
  assert.equal(all.ok, true);
  assert.equal(all.all, true);
  assert.equal(all.keep.length, 6);
  assert.deepEqual(requestLog.at(-1).body, { keep: [], all: true });
  await controller.refresh();
  assert.equal(controller.getSnapshot().keepSaved.length, 6);
});

test('加账号：登录链接与轮询结果的形状与设置页一致', async () => {
  const started = await api.loginStart('global');
  assert.equal(typeof started.url, 'string');
  assert.match(started.url, /^https:/);
  assert.ok(started.state);

  const first = await api.loginPoll(started.state);
  assert.equal(first.done, false);
  const second = await api.loginPoll(started.state);
  assert.equal(second.done, false);
  const third = await api.loginPoll(started.state);
  assert.equal(third.done, true);
  // 假服务在第三次 poll 时把昵称写死为「测试账号3」（见 tools/stub-service.mjs）
  assert.equal(third.nickname, '测试账号3');
  assert.equal(third.realm, 'global');
  assert.equal(third.creditsTotal, 500);

  await controller.refresh();
  assert.equal(controller.getSnapshot().status.accounts.length, 3, '新账号应出现在设置页列表里');
});

test('高级配置：写回 config.json 且不吞掉原有 api_key', async () => {
  const res = await api.config(`127.0.0.1:${PORT}`, '');
  assert.equal(res.ok, true);
  const saved = JSON.parse(readFileSync(join(installDir, 'config.json'), 'utf8'));
  assert.equal(saved.listen, `127.0.0.1:${PORT}`);
  assert.equal(saved.api_key, KEY);

  await assert.rejects(() => api.config('not a server', ''), /host:port/);
});

test('宿主的错误响应被设置页转成可读错误，不静默', async () => {
  await assert.rejects(() => api.job('nope'), /没有这个任务/);
  await assert.rejects(() => api.service('explode'), /不认识的动作/);
  await assert.rejects(() => api.request('api/dsh-wb2api/does-not-exist'), /未知路由/);
});

test('卸载时撤销路由与工具，客户端 dispose 不残留定时器', () => {
  assert.doesNotThrow(() => controller.dispose());
  assert.equal(typeof handle.dispose, 'function');
  handle.dispose();
  assert.equal(record.routeDisposed, 1);
  assert.equal(record.tool, null);
  assert.equal(globalThis[Symbol.for('dsh.wb2api.mounted')], undefined);
});
