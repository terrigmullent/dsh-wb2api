/**
 * dsh-wb2api 客户端（lib/client.js）契约与行为测试。
 *
 * 验证边界（先读）：
 * 本机没有 React / react-dom / jsdom（各层 node_modules 与 app.asar 内都没有），
 * 因此本文件内置一个「最小 React 桩」驱动组件函数。桩实现了本次测试依赖的语义：
 * 元素描述（type/props/children）、useState / useEffect / useRef / useMemo / memo /
 * useSyncExternalStore；**不实现** React 的调度、批处理、并发渲染与真实 DOM 提交，
 * 因此不能替代真实浏览器渲染验证（这一条记在测试报告里）。
 * 不依赖浏览器、不截图、不引第三方库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLIENT_PATH = path.resolve(HERE, '..', 'lib', 'client.js');
const CLIENT_SRC = fs.readFileSync(CLIENT_PATH, 'utf8');

const ALLOWED_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
];

const ELEMENT = Symbol('wb2.test.element');
const MEMO = Symbol('wb2.test.memo');
const FRAGMENT = Symbol('wb2.test.fragment');

// ---------------------------------------------------------------- DOM 桩

function makeNode(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    id: '',
    style: {},
    dataset: {},
    attributes: {},
    listeners: {},
    children: [],
    className: '',
    textContent: '',
    value: '',
    checked: false,
    disabled: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    removeChild(child) {
      const i = this.children.indexOf(child);
      if (i >= 0) this.children.splice(i, 1);
      return child;
    },
    setAttribute(k, v) {
      this.attributes[k] = String(v);
    },
    getAttribute(k) {
      return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null;
    },
    removeAttribute(k) {
      delete this.attributes[k];
    },
    addEventListener(type, fn) {
      (this.listeners[type] || (this.listeners[type] = [])).push(fn);
    },
    removeEventListener(type, fn) {
      const list = this.listeners[type] || [];
      const i = list.indexOf(fn);
      if (i >= 0) list.splice(i, 1);
    },
    focus() {},
    remove() {},
    querySelector() {
      return null;
    },
  };
}

function textOf(node) {
  if (node === null || node === undefined) return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  if (!node || typeof node !== 'object') return '';
  let text = typeof node.textContent === 'string' ? node.textContent : '';
  if (Array.isArray(node.children)) {
    for (const child of node.children) text += textOf(child);
  }
  return text;
}

function findAll(root, predicate, out = []) {
  if (root === null || root === undefined || typeof root !== 'object') return out;
  if (Array.isArray(root)) {
    for (const item of root) findAll(item, predicate, out);
    return out;
  }
  if (predicate(root)) out.push(root);
  if (Array.isArray(root.children)) {
    for (const child of root.children) findAll(child, predicate, out);
  }
  return out;
}

// ------------------------------------------------------------- React 桩

function createReactStub() {
  const instances = new Map();
  const offscreen = [];
  let current = null;

  function cell(kind) {
    const frame = current;
    if (!frame) throw new Error('hook ' + kind + ' 在组件渲染之外被调用');
    const index = frame.index++;
    const slot = frame.entry.hooks[index] || (frame.entry.hooks[index] = { kind });
    if (slot.kind !== kind) throw new Error('hook 顺序在 index ' + index + ' 处发生变化');
    return slot;
  }

  function renderWith(Component, props) {
    let entry = instances.get(Component);
    if (!entry) {
      entry = { hooks: [], component: Component };
      instances.set(Component, entry);
    }
    const previous = current;
    current = { entry, index: 0 };
    try {
      return Component(props);
    } finally {
      current = previous;
    }
  }

  /** 类组件基类：只实现错误边界需要的 setState。 */
  class Component {
    constructor(props) {
      this.props = props || {};
      this.state = {};
    }
    setState(patch) {
      const next = typeof patch === 'function' ? patch(this.state) : patch;
      this.state = Object.assign({}, this.state, next);
    }
  }
  Component.prototype.isReactComponent = {};

  const React = {
    Fragment: FRAGMENT,
    Component: Component,
    version: '19.0.0-stub',
    __isStub: true,
    createElement(type, props, ...children) {
      const flat = [];
      const push = (c) => {
        if (c === null || c === undefined || typeof c === 'boolean') return;
        if (Array.isArray(c)) {
          c.forEach(push);
          return;
        }
        flat.push(c);
      };
      children.forEach(push);
      const merged = Object.assign({}, props);
      merged.children = flat.length <= 1 ? flat[0] : flat;
      return { $$typeof: ELEMENT, type, props: merged, key: (props && props.key) || null };
    },
    memo(fn) {
      return { $$typeof: MEMO, render: fn };
    },
    createRef() {
      return { current: null };
    },
    useState(initial) {
      const slot = cell('state');
      if (!('value' in slot)) slot.value = typeof initial === 'function' ? initial() : initial;
      return [
        slot.value,
        (next) => {
          const value = typeof next === 'function' ? next(slot.value) : next;
          if (!Object.is(value, slot.value)) slot.value = value;
        },
      ];
    },
    useEffect(fn, deps) {
      const slot = cell('effect');
      const changed =
        !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]));
      if (!slot.installed || changed) {
        slot.deps = deps ? deps.slice() : null;
        slot.installed = true;
        offscreen.push(fn);
      }
    },
    useMemo(fn, deps) {
      const slot = cell('memo');
      const changed =
        !slot.deps || !deps || deps.length !== slot.deps.length || deps.some((d, i) => !Object.is(d, slot.deps[i]));
      if (!('value' in slot) || changed) {
        slot.value = fn();
        slot.deps = deps ? deps.slice() : null;
      }
      return slot.value;
    },
    useRef(initial) {
      const slot = cell('ref');
      if (!('current' in slot)) slot.current = initial;
      return slot;
    },
    useCallback(fn) {
      cell('callback');
      return fn;
    },
    useLayoutEffect(fn, deps) {
      React.useEffect(fn, deps);
    },
    useSyncExternalStore(subscribe, getSnapshot) {
      cell('store');
      if (typeof subscribe !== 'function') throw new Error('useSyncExternalStore 需要 subscribe 函数');
      if (typeof getSnapshot !== 'function') throw new Error('useSyncExternalStore 需要 getSnapshot 函数');
      return getSnapshot();
    },
  };

  function elementToDom(node, doc) {
    if (node === null || node === undefined || typeof node === 'boolean') return null;
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) {
      const out = [];
      for (const child of node) {
        const rendered = elementToDom(child, doc);
        if (rendered === null) continue;
        if (Array.isArray(rendered)) out.push(...rendered);
        else out.push(rendered);
      }
      return out;
    }
    if (!node || node.$$typeof !== ELEMENT) return null;
    let type = node.type;
    if (type && type.$$typeof === MEMO) type = type.render;
    const props = Object.assign({}, node.props, { key: node.key });
    if (typeof type === 'function' && type.prototype && type.prototype.isReactComponent) {
      // 类组件：支持错误边界（getDerivedStateFromError / componentDidCatch）
      const instance = new type(props);
      instance.props = props;
      if (!instance.state) instance.state = {};
      try {
        return elementToDom(instance.render(), doc);
      } catch (error) {
        if (typeof type.getDerivedStateFromError !== 'function') throw error;
        instance.state = Object.assign({}, instance.state, type.getDerivedStateFromError(error));
        if (typeof instance.componentDidCatch === 'function') instance.componentDidCatch(error, { componentStack: '' });
        return elementToDom(instance.render(), doc);
      }
    }
    if (typeof type === 'function') return elementToDom(renderWith(type, props), doc);

    const dom = makeNode(type);
    for (const key of Object.keys(props)) {
      const value = props[key];
      if (key === 'children' || key === 'key') continue;
      if (key === 'className') dom.className = value;
      else if (key === 'id') {
        dom.id = value;
        doc.byId.set(value, dom);
      } else if (key === 'style' && value && typeof value === 'object') dom.style = Object.assign({}, value);
      else if (/^on[A-Z]/.test(key)) dom.listeners[key.slice(2).toLowerCase()] = value;
      else if (key === 'value' || key === 'checked' || key === 'disabled') dom[key] = value;
      else if (key === 'ref') {
        if (value && typeof value === 'object') value.current = dom;
        else if (typeof value === 'function') value(dom);
      } else if (
        key.startsWith('data-') ||
        key.startsWith('aria-') ||
        key === 'href' ||
        key === 'target' ||
        key === 'rel' ||
        key === 'type' ||
        key === 'placeholder' ||
        key === 'title'
      ) {
        dom.attributes[key] = value === null || value === undefined ? '' : String(value);
      } else {
        dom.attributes[key] = String(value);
      }
    }
    const children = props.children;
    const list = Array.isArray(children) ? children : children === undefined ? [] : [children];
    for (const child of list) {
      const rendered = elementToDom(child, doc);
      if (rendered === null) continue;
      if (Array.isArray(rendered)) dom.children.push(...rendered);
      else dom.children.push(rendered);
    }
    return dom;
  }

  return {
    React,
    elementToDom,
    runOffscreen() {
      const queue = offscreen.splice(0);
      for (const fn of queue) {
        try {
          fn();
        } catch (error) {
          // eslint-disable-next-line no-console
          console.warn('[test] effect 抛错:', error);
        }
      }
      return queue.length;
    },
    pendingEffects: () => offscreen.length,
  };
}

// ------------------------------------------------------------------ harness

function createHarness(options = {}) {
  const doc = {
    byId: new Map(),
    head: makeNode('head'),
    body: makeNode('body'),
    createElement: (tag) => makeNode(tag),
    createElementNS: (_ns, tag) => makeNode(tag),
    createTextNode: (text) => ({ nodeType: 3, textContent: String(text) }),
    getElementById: (id) => doc.byId.get(id) || null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: () => {},
    removeEventListener: () => {},
  };
  doc.head.appendChild = function append(child) {
    this.children.push(child);
    if (child && child.id) doc.byId.set(child.id, child);
    return child;
  };
  doc.body.appendChild = function append(child) {
    this.children.push(child);
    return child;
  };

  const stub = createReactStub();
  const react = {
    React: stub.React,
    render: (element) => stub.elementToDom(element, doc),
    runOffscreen: stub.runOffscreen,
    pendingEffects: stub.pendingEffects,
  };

  const timers = [];
  const calls = [];
  const warnings = [];
  const errors = [];
  const opened = [];
  const clipboardWrites = [];
  let clipboardMode = options.clipboardMode || 'resolve';
  let clock = options.startTime || 1_700_000_000_000;
  let seq = 0;
  let routeHandler = options.onRequest || null;
  const harness = { clipboardWrites, clipboardMode };

  const sandbox = {
    console: {
      log: (...a) => warnings.push(a.map(String).join(' ')),
      info: (...a) => warnings.push(a.map(String).join(' ')),
      warn: (...a) => warnings.push(a.map(String).join(' ')),
      error: (...a) => errors.push(a.map(String).join(' ')),
      debug: () => {},
    },
    setTimeout(fn, ms, ...rest) {
      seq += 1;
      const handle = { id: seq, at: clock + (Number(ms) || 0), fn, args: rest, cleared: false, done: false };
      timers.push(handle);
      return handle.id;
    },
    clearTimeout(id) {
      const found = timers.find((t) => t.id === id);
      if (found) found.cleared = true;
    },
    setInterval(fn, ms, ...rest) {
      return sandbox.setTimeout(fn, ms, ...rest);
    },
    clearInterval(id) {
      sandbox.clearTimeout(id);
    },
    Promise,
    JSON,
    Math,
    Date: new Proxy(Date, {
      get(target, prop) {
        if (prop === 'now') return () => clock;
        return Reflect.get(target, prop);
      },
    }),
    URL,
    URLSearchParams,
    AbortController,
    navigator: {
      userAgent: 'node-test',
      clipboard: {
        writeText(value) {
          harness.clipboardWrites.push(String(value));
          if (harness.clipboardMode === 'reject') return Promise.reject(new Error('clipboard denied'));
          return Promise.resolve();
        },
      },
    },
    fetch(input, init) {
      const url = String((input && input.url) || input || '');
      const method = String((init && init.method) || 'GET').toUpperCase();
      const headers = normalizeHeaders((init && init.headers) || null);
      const raw = (init && init.body) || null;
      const body = raw === null || raw === undefined ? null : typeof raw === 'string' ? JSON.parse(raw) : raw;
      const record = { index: calls.length, url, method, body, headers, raw };
      calls.push(record);
      let result;
      if (routeHandler) result = routeHandler(record);
      if (result === undefined) throw new Error('测试未覆盖的请求: ' + method + ' ' + url);
      const value = typeof result === 'function' ? result(record) : result;
      if (value instanceof Error) return Promise.reject(value);
      const payload = value === undefined ? { ok: true } : value;
      const text = JSON.stringify(payload);
      return Promise.resolve({
        ok: true,
        status: 200,
        statusText: 'OK',
        headers: { get: () => 'application/json' },
        text: () => Promise.resolve(text),
        json: () => Promise.resolve(JSON.parse(text)),
        clone() {
          return this;
        },
      });
    },
  };

  function normalizeHeaders(headers) {
    if (!headers) return null;
    if (typeof headers.forEach === 'function' && typeof headers.get === 'function') {
      const out = {};
      headers.forEach((value, key) => {
        out[String(key).toLowerCase()] = value;
      });
      return out;
    }
    const out = {};
    for (const key of Object.keys(headers)) out[key.toLowerCase()] = headers[key];
    return out;
  }

  const registration = { count: 0, value: null };
  sandbox.window = sandbox;
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  sandbox.document = doc;
  sandbox.window.document = doc;
  sandbox.window.open = (...args) => {
    // 真实浏览器返回一个 window 句柄：既可能是空白占位窗（随后写 location.href），
    // 也可能是弹窗被拦截时返回的 null。桩给出带 location/close 的句柄，才验得了这两条路。
    const handle = {
      args,
      closed: false,
      location: { href: '' },
      close() {
        this.closed = true;
      },
    };
    opened.push(handle);
    return handle;
  };
  sandbox.window.__ModuleLoader__ = {
    load(reg) {
      registration.count += 1;
      registration.value = reg;
    },
  };

  const requiredModules = [];
  const unknownModules = [];
  const fakeRequire = (name) => {
    requiredModules.push(name);
    if (!ALLOWED_MODULES.includes(name)) {
      unknownModules.push(name);
      throw new Error('模块不在白名单内: ' + name);
    }
    if (name === 'react') return react.React;
    if (name === 'react/jsx-runtime') {
      return { jsx: react.React.createElement, jsxs: react.React.createElement, Fragment: FRAGMENT };
    }
    throw new Error('本测试未提供该模块: ' + name);
  };

  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SRC, sandbox, { filename: 'dsh-wb2api/lib/client.js' });
  assert.equal(registration.count, 1, 'client.js 必须恰好调用一次 window.__ModuleLoader__.load');
  assert.equal(registration.value.id, 'dsh-wb2api', 'registration.id 必须等于包名');

  const plugin = registration.value.factory(fakeRequire);

  return {
    doc,
    react,
    sandbox,
    timers,
    calls,
    warnings,
    errors,
    opened,
    plugin,
    registration,
    clipboardWrites,
    get clipboardMode() {
      return clipboardMode;
    },
    set clipboardMode(value) {
      clipboardMode = value;
    },
    requiredModules,
    unknownModules,
    now: () => clock,
    setRouteHandler(handler) {
      routeHandler = handler;
    },
    advance(ms) {
      const target = clock + ms;
      for (;;) {
        let next = null;
        for (const t of timers) {
          if (t.cleared || t.done || t.at > target) continue;
          if (next === null || t.at < next.at || (t.at === next.at && t.id < next.id)) next = t;
        }
        if (next === null) break;
        clock = next.at;
        next.done = true;
        try {
          next.fn(...next.args);
        } catch (error) {
          errors.push('定时器回调抛错: ' + ((error && error.message) || error));
        }
      }
      clock = target;
    },
    pendingTimers: () => timers.filter((t) => !t.cleared && !t.done).length,
    styleText() {
      return doc.head.children.map((el) => String(el.textContent || '')).join('\n');
    },
    warningsMatching(substr) {
      return warnings.filter((w) => w.includes(substr));
    },
  };
}

/** 假 cordis ctx：记录 slots / locale / effect 调用。 */
function createCtx(overrides = {}) {
  const state = { registered: [], injections: [], locales: [], binds: [], effects: [], disposers: [] };
  const slots = {
    inject(name, fn) {
      state.injections.push(name);
      return fn();
    },
    register(options, component) {
      const entry = { options, component, disposed: false };
      state.registered.push(entry);
      return () => {
        entry.disposed = true;
      };
    },
    ...(overrides.slots || {}),
  };
  const locale = {
    register(ns, dicts) {
      state.locales.push({ ns, dicts });
      return () => {};
    },
    bind(ns) {
      state.binds.push(ns);
      const found = state.locales.find((l) => l.ns === ns);
      const dict = (found && found.dicts && found.dicts.zh) || {};
      // 真实 locale 服务按 key 原文在字典里平查（dsh-client-locale README 原话：
      // “For each key, lookup walks … then displays the key itself.”），**不做点号路径解析**。
      // 这里必须同样平查，否则测试会替真实运行时"猜对"嵌套字典 —— 曾经因为桩里写了
      // 点号遍历，嵌套字典在单测里全绿、真机满屏 "service.title"。
      const lookup = (key) => (Object.prototype.hasOwnProperty.call(dict, key) ? dict[key] : undefined);
      const t = (key, params) => {
        let text = lookup(key);
        if (text === undefined || text === null || typeof text === 'object') return key;
        if (params) {
          for (const k of Object.keys(params)) text = String(text).split('{' + k + '}').join(String(params[k]));
        }
        return text;
      };
      t.ns = ns;
      return t;
    },
    ...(overrides.locale || {}),
  };
  const ctx = {
    slots,
    locale,
    effect(fn, label) {
      state.effects.push({ label, fn });
      const disposer = fn();
      state.disposers.push(disposer);
      return () => {
        if (typeof disposer === 'function') disposer();
      };
    },
    get(name) {
      if (name === 'slots') return slots;
      if (name === 'locale') return locale;
      return undefined;
    },
    ...(overrides.ctx || {}),
  };
  return { ctx, state };
}

/** 启动一次：apply(ctx) + 渲染注册项；runEffects() 模拟提交阶段执行 effect。 */
function boot(options = {}) {
  const harness = createHarness(options);
  const { ctx, state } = createCtx(options.overrides);
  let applyError = null;
  try {
    harness.plugin.apply(ctx);
  } catch (error) {
    applyError = error;
  }
  const entry = state.registered[0] || null;
  let element = null;
  let tree = null;
  let controller = null;
  let api = null;
  let renderError = null;
  /** 重新渲染注册项组件（模拟 store 变化触发的重渲染），返回最新 DOM 树。 */
  function draw() {
    if (!entry) return null;
    try {
      element = entry.component();
      tree = harness.react.render(element);
      const walk = (node) => {
        if (!node || typeof node !== 'object') return;
        if (Array.isArray(node)) {
          node.forEach(walk);
          return;
        }
        if (node.props) {
          if (!controller && node.props.controller) controller = node.props.controller;
          if (!api && node.props.api) api = node.props.api;
        }
        if (node.$$typeof === ELEMENT) {
          let type = node.type;
          if (type && type.$$typeof === MEMO) type = type.render;
          if (typeof type === 'function') {
            try {
              walk(harness.react.render(node));
            } catch {
              /* 已由 renderError 记录 */
            }
          }
        }
        if (Array.isArray(node.children)) node.children.forEach(walk);
      };
      walk(element);
    } catch (error) {
      renderError = error;
    }
    return tree;
  }
  draw();
  return {
    harness,
    ctx,
    state,
    entry,
    render: draw,
    get element() {
      return element;
    },
    get tree() {
      return tree;
    },
    controller,
    api,
    applyError,
    renderError,
    pendingEffects: () => harness.react.pendingEffects(),
    runEffects: () => harness.react.runOffscreen(),
    text: () => textOf(tree),
    buttons: () => findAll(tree, (n) => n.tagName === 'BUTTON'),
    findByText: (label) => findAll(tree, (n) => textOf(n).includes(label)),
    warnings: () => harness.warnings,
    errors: () => harness.errors,
    calls: harness.calls,
  };
}

function buttonByText(booted, label) {
  for (const button of booted.buttons()) {
    const text =
      (textOf(button) || '') + ' ' + (button.attributes['aria-label'] || '') + ' ' + (button.attributes.title || '');
    if (text.includes(label)) return button;
  }
  return null;
}

function waitTicks(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i += 1) p = p.then(() => undefined);
  return p;
}

// ------------------------------------------------------------------- 数据

const STATUS_OK = {
  ok: true,
  service: {
    installed: true,
    running: true,
    healthy: true,
    pid: 4242,
    version: '1.2.3',
    uptimeSec: 3725,
    baseURL: 'http://127.0.0.1:7863',
    installDir: 'C:\\WorkBuddy2API',
    exeVersion: '1.2.3',
  },
  accounts: [
    {
      uid: 'u-1',
      nickname: '主账号',
      realm: 'cn',
      credits: 120.5,
      creditsTotal: 500,
      disabled: false,
      expiry: '2026-12-31T00:00:00.000Z',
    },
    { uid: 'u-2', nickname: 'Global One', realm: 'global', credits: 8, creditsTotal: 20, disabled: true, expiry: null },
  ],
  models: { available: 2, keep: ['cn:deepseek-v4.1-flash'], realm: 'cn' },
  install: { busy: false, jobId: null },
};

const MODELS_OK = {
  ok: true,
  models: [
    {
      id: 'cn:deepseek-v4.1-flash',
      name: 'DeepSeek V4.1 Flash',
      realm: 'cn',
      credits: 1,
      contextLength: 128000,
      maxOutputTokens: 8192,
      supportsImages: false,
      supportsReasoning: true,
      vendor: 'deepseek',
      description: '快',
      kept: true,
    },
    {
      id: 'global:gpt-5.1',
      name: 'GPT 5.1',
      realm: 'global',
      credits: 3,
      contextLength: 200000,
      maxOutputTokens: 16384,
      supportsImages: true,
      supportsReasoning: false,
      vendor: 'openai',
      description: '强',
      kept: false,
    },
  ],
  keep: ['cn:deepseek-v4.1-flash'],
  realm: 'cn',
};

function defaultRoutes(record, extra = {}) {
  if (record.url.endsWith('api/dsh-wb2api/status')) return extra.status || STATUS_OK;
  if (record.url.includes('api/dsh-wb2api/models')) return extra.models || MODELS_OK;
  if (record.url.endsWith('api/dsh-wb2api/keep')) return { ok: true, keep: (record.body && record.body.keep) || [] };
  if (record.url.endsWith('api/dsh-wb2api/service')) return { ok: true, service: STATUS_OK.service };
  if (record.url.endsWith('api/dsh-wb2api/config')) return { ok: true };
  if (record.url.endsWith('api/dsh-wb2api/open-panel')) return { ok: true, url: 'http://127.0.0.1:7863/panel' };
  throw new Error('测试未覆盖的请求: ' + record.method + ' ' + record.url);
}

/** 源码里所有 t('…') / tr('…') 的字面 key（动态调用由测试单独禁止）。 */
function literalTKeys(source) {
  const keys = new Set();
  for (const m of source.matchAll(/\b(?:t|tr)\(\s*'([^']+)'/g)) keys.add(m[1]);
  for (const m of source.matchAll(/\b(?:t|tr)\(\s*"([^"]+)"/g)) keys.add(m[1]);
  return [...keys].sort();
}

// ------------------------------------------------------------------- 测试

test('模块契约：load 一次、id=dsh-wb2api、factory 返回 {apply, inject}、只 require 白名单模块', () => {
  const harness = createHarness();
  assert.equal(harness.registration.count, 1);
  assert.equal(harness.registration.value.id, 'dsh-wb2api');
  assert.equal(typeof harness.registration.value.factory, 'function');
  assert.deepEqual(harness.unknownModules, [], '不得 require 白名单之外的模块');
  assert.deepEqual(harness.requiredModules, ['react'], '当前只 require react');
  assert.equal(typeof harness.plugin.apply, 'function', '插件必须有 apply');
  assert.ok(Array.isArray(harness.plugin.inject), '插件必须有 inject 数组');
  assert.deepEqual(Array.from(harness.plugin.inject), ['slots', 'locale']);

  // 源码级硬约束：不用 iframe、不碰 document.body / 根节点、不引用禁用的 primitives 包
  const src = CLIENT_SRC;
  assert.ok(!/dsh-client-ui-primitives/.test(src), '不得引用 dsh-client-ui-primitives');
  assert.ok(!/<iframe/i.test(src) && !/createElement\(\s*['"]iframe/i.test(src), '不得使用 iframe');
  assert.ok(!/document\.body\s*\./.test(src), '不得操作 document.body');
  assert.ok(!/replaceChild/.test(src), '不得替换根节点');
});

test('apply 契约：注册 settings.section(id=wb2api)、locale 双语对齐、effect 都返回清理函数', () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  assert.equal(booted.applyError, null, 'apply 不得抛错: ' + (booted.applyError && booted.applyError.message));

  assert.deepEqual(booted.state.injections, ['settings.section'], '必须用 ctx.slots.inject 包裹注册');
  assert.equal(booted.state.registered.length, 1, '必须恰好注册一个设置分区');

  const options = booted.state.registered[0].options;
  assert.equal(options.name, 'settings.section');
  assert.equal(options.id, 'wb2api');
  assert.equal(options.order, 60);
  assert.equal(typeof options.label, 'function', 'label 必须是 thunk');
  assert.equal(options.label(), 'WorkBuddy2API');
  assert.equal(typeof booted.state.registered[0].component, 'function');

  assert.equal(booted.state.locales.length, 1, '必须注册一次 locale 字典');
  const { ns, dicts } = booted.state.locales[0];
  assert.equal(ns, 'dsh-wb2api');
  assert.ok(dicts.zh && dicts.en, 'zh/en 必须齐全');
  const zhKeys = Object.keys(dicts.zh);
  const enKeys = Object.keys(dicts.en);
  assert.deepEqual(enKeys.slice().sort(), zhKeys.slice().sort(), 'zh/en 的译文键必须一一对应');
  assert.ok(zhKeys.length >= 60, '文案键数量应与页面规模相称，实际 ' + zhKeys.length);
  // key 必须是带点号的**扁平字面量**，值必须是字符串：嵌套对象在真实 locale 里查不到，
  // 页面会直接显示成 key 本身（见 client.js 文案区注释与 locale.test.mjs）。
  for (const [label, dict] of [['zh', dicts.zh], ['en', dicts.en]]) {
    const nested = Object.keys(dict).filter((k) => typeof dict[k] !== 'string');
    assert.deepEqual(nested, [], label + ' 字典不能有嵌套对象（key 要写成扁平点号字面量），实际: ' + nested.join(', '));
  }
  assert.ok(/[\u4e00-\u9fff]/.test(Object.values(dicts.zh).join('\n')), '中文文案必须存在');
  assert.ok(!/[\u4e00-\u9fff]/.test(Object.values(dicts.en).join('\n')), '英文文案不应混入中文');
  assert.deepEqual(booted.state.binds, ['dsh-wb2api'], '必须用 locale.bind 取 t');

  assert.ok(booted.state.effects.length >= 2, '至少有 locale 与生命周期两个 effect，实际 ' + booted.state.effects.length);
  for (const effect of booted.state.effects) {
    assert.equal(typeof effect.fn, 'function', 'effect 回调必须是函数: ' + effect.label);
  }
  const disposers = booted.state.disposers.filter((d) => typeof d === 'function');
  assert.ok(disposers.length >= 2, 'effect 必须返回清理函数，实际 ' + disposers.length);
});

test('文案：源码里 t() 用到的每个 key 都必须在 zh/en 字典里存在（漏一个就满屏 key）', () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  const { dicts } = booted.state.locales[0];
  const used = literalTKeys(CLIENT_SRC);
  assert.ok(used.length >= 60, 't() 字面 key 数量应与页面规模相称，实际 ' + used.length);

  const missingZh = used.filter((k) => !Object.prototype.hasOwnProperty.call(dicts.zh, k));
  const missingEn = used.filter((k) => !Object.prototype.hasOwnProperty.call(dicts.en, k));
  assert.deepEqual(missingZh, [], 'zh 缺失这些 t() key（页面会显示 key 原文）: ' + missingZh.join(', '));
  assert.deepEqual(missingEn, [], 'en 缺失这些 t() key（页面会显示 key 原文）: ' + missingEn.join(', '));

  // 真机页面直接显示 t() 的第一个参数，所以 t() 只允许传字面量：
  // 动态拼 key 会让本测试失效，也会让漏 key 变得不可静态发现。
  // 例外：控制器里的 tr(key) 包装（它内部用别名 translate 调 t，源码里看不见 t(变量)）。
  const dynamic = [...CLIENT_SRC.matchAll(/\bt\(\s*([^'"\s)])/g)].map((m) => m[1]);
  assert.deepEqual([...new Set(dynamic)], [], 't() 只允许传字符串字面量，发现动态调用首字符: ' + dynamic.join(', '));

  // 反向：字典里有、但源码没用到的 key 只提示，不作为失败（保留给后续文案）
  const unused = Object.keys(dicts.zh).filter((k) => !used.includes(k));
  if (unused.length) console.log('（提示）字典里暂未使用的 key: ' + unused.join(', '));
});

test('样式：单个 <style> 注入 head、不碰 body、二次 apply 幂等、只用 --dsw-* token', () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  const styles = booted.harness.doc.head.children.filter((el) => el.tagName === 'STYLE');
  assert.equal(styles.length, 1, '必须恰好注入一个 style 元素');
  assert.ok(styles[0].id, 'style 必须有 id 供幂等判断');
  assert.equal(booted.harness.doc.body.children.length, 0, '不得往 document.body 追加节点');

  const css = booted.harness.styleText();
  assert.ok(css.includes('.wb2-'), 'class 名前缀必须是 wb2-');
  assert.ok(!/#[0-9a-fA-F]{3,8}\b/.test(css), 'CSS 不得出现十六进制字面颜色');
  assert.ok(!/\b(rgb|rgba|hsl|hsla)\s*\(/.test(css), 'CSS 不得出现 rgb()/hsl() 字面颜色');
  const withoutTokens = css.replace(/--dsw-[a-z0-9-]+/g, '');
  assert.ok(
    !/:\s*(?:#|white\b|black\b|red\b|blue\b|green\b|gray\b|grey\b|silver\b)/.test(withoutTokens),
    'CSS 不得出现颜色关键字/字面颜色',
  );

  const second = createCtx();
  booted.harness.plugin.apply(second.ctx);
  assert.equal(booted.harness.doc.head.children.filter((el) => el.tagName === 'STYLE').length, 1, '样式注入必须幂等');
});

test('渲染契约：注册项组件不抛错，四块内容都在，controller/api 注入到位，effect 触发首屏加载', async () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  assert.equal(booted.renderError, null, '组件渲染不得抛错: ' + (booted.renderError && booted.renderError.message));
  assert.ok(booted.tree, '组件必须返回可渲染的元素树');
  assert.ok(booted.controller, 'controller 必须通过 props 注入页面组件');
  assert.ok(booted.api, 'api 必须通过 props 注入页面组件');
  assert.equal(typeof booted.controller.getSnapshot, 'function');
  assert.equal(typeof booted.controller.subscribe, 'function');
  assert.equal(typeof booted.controller.dispose, 'function');
  assert.equal(booted.text().includes('WorkBuddy2API'), true, '页面必须渲染标题');

  assert.equal(booted.pendingEffects() >= 1, true, '页面必须注册 effect');
  booted.runEffects();
  await waitTicks(10);
  const snapshot = booted.controller.getSnapshot();
  assert.ok(snapshot.status, 'effect 必须触发首次 status 加载');
  assert.equal(snapshot.status.service.installed, true);
  assert.equal(snapshot.error, null, '首屏加载不该报错: ' + snapshot.error);

  const text = booted.text();
  assert.ok(text.includes('服务'), '服务卡片应有可读文案');
  assert.ok(text.includes('账号'), '账号卡片应有可读文案');
  assert.ok(text.includes('模型'), '模型卡片应有可读文案');
  assert.ok(text.includes('高级'), '高级卡片应有可读文案');
  booted.controller.dispose();
});

test('controller 契约：getSnapshot 引用稳定、subscribe 返回 unsubscribe 且能真的退订', async () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  const controller = booted.controller;
  const a = controller.getSnapshot();
  const b = controller.getSnapshot();
  assert.equal(a, b, '无变化时 getSnapshot 必须返回同一引用');

  let hits = 0;
  const unsubscribe = controller.subscribe(() => {
    hits += 1;
  });
  assert.equal(typeof unsubscribe, 'function');
  await controller.refresh();
  assert.ok(hits >= 1, 'refresh 后必须通知订阅者');
  assert.notEqual(controller.getSnapshot(), a, '变化后必须是新引用');

  unsubscribe();
  hits = 0;
  await controller.refresh();
  assert.equal(hits, 0, 'unsubscribe 之后不应再收到通知');
  controller.dispose();
});

test('HTTP 契约：路径无前导斜杠，service/keep/config/open-panel 的请求体与头部正确', async () => {
  const seen = [];
  const booted = boot({
    onRequest(record) {
      seen.push(record);
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.refresh();

  const status = seen.find((c) => c.url.endsWith('api/dsh-wb2api/status'));
  assert.ok(status, '必须请求 status');
  assert.equal(status.method, 'GET');
  assert.ok(!status.url.startsWith('/'), '浏览器侧路径不得带前导斜杠，实际: ' + status.url);
  const models = seen.find((c) => c.url.includes('api/dsh-wb2api/models'));
  assert.ok(models, '必须请求 models');
  assert.ok(!models.url.startsWith('/'));

  seen.length = 0;
  await controller.serviceAction('restart');
  const service = seen.find((c) => c.url.endsWith('api/dsh-wb2api/service'));
  assert.ok(service, '必须 POST service');
  assert.equal(service.method, 'POST');
  assert.deepEqual(service.body, { action: 'restart' });
  assert.ok(
    service.headers && String(service.headers['content-type'] || '').includes('application/json'),
    'POST 必须带 content-type: application/json，实际: ' + JSON.stringify(service.headers),
  );

  seen.length = 0;
  await controller.saveKeep(['cn:deepseek-v4.1-flash', 'global:gpt-5.1']);
  const keep = seen.find((c) => c.url.endsWith('api/dsh-wb2api/keep'));
  assert.ok(keep, '必须 POST keep');
  assert.deepEqual(keep.body, { keep: ['cn:deepseek-v4.1-flash', 'global:gpt-5.1'], all: false });

  // 控制器的提示文案必须走当前语言的字典：字典若写成嵌套对象（真实 locale 只按 key 原文平查），
  // 这里会退化成裸 key "models.saved"，正是设置页满屏英文 key 的那次事故。
  const savedNotice = controller.getSnapshot().notice;
  assert.ok(savedNotice, '保存模型后必须有提示');
  assert.ok(
    String(savedNotice.text).includes('已保留 2 个模型'),
    '提示必须来自字典（裸 key 说明字典形状/键名不对），实际: ' + String(savedNotice.text),
  );
  assert.ok(
    !String(savedNotice.text).includes('models.saved'),
    '提示不得是裸 key，实际: ' + String(savedNotice.text),
  );

  seen.length = 0;
  await controller.saveKeep([]);
  const keepAll = seen.find((c) => c.url.endsWith('api/dsh-wb2api/keep'));
  assert.ok(keepAll, '空清单也必须 POST keep');
  assert.deepEqual(keepAll.body, { keep: [], all: true }, '空清单要显式带 all:true，宿主才认');

  seen.length = 0;
  await controller.saveConfig('127.0.0.1:7863', '');
  const config = seen.find((c) => c.url.endsWith('api/dsh-wb2api/config'));
  assert.ok(config, '必须 POST config');
  assert.deepEqual(config.body, { server: '127.0.0.1:7863', apiKey: '' });

  seen.length = 0;
  await controller.openPanel('accounts');
  const panel = seen.find((c) => c.url.endsWith('api/dsh-wb2api/open-panel'));
  assert.ok(panel, '必须 POST open-panel');
  assert.deepEqual(panel.body, { page: 'accounts' });
  // B7：await 之后用户手势已失效，必须先用空白窗口占位、拿到地址再写 location.href，
  // 否则浏览器会拦掉弹窗（早期实现是 await 之后才 window.open，直接被拦）。
  assert.equal(booted.harness.opened.length, 1, '只应开一个窗口（占位窗），地址靠 location.href 写进去');
  assert.equal(booted.harness.opened[0].args[0], '', '第一个窗口必须是空白占位窗');
  assert.equal(
    booted.harness.opened[0].location.href,
    'http://127.0.0.1:7863/panel',
    '占位窗要导航到宿主返回的地址',
  );
  assert.equal(booted.harness.opened[0].closed, false, '成功时不能把窗口关掉');
  controller.dispose();
});

test('刷新模型：refreshModels 必须带 refresh=1 查询串', async () => {
  const seen = [];
  const booted = boot({
    onRequest(record) {
      seen.push(record);
      return defaultRoutes(record);
    },
  });
  await booted.controller.refresh({ refreshModels: true });
  const models = seen.find((c) => c.url.includes('api/dsh-wb2api/models'));
  assert.ok(models, '必须请求 models');
  assert.ok(models.url.includes('refresh=1'), '强制刷新必须带 refresh=1，实际: ' + models.url);
  booted.controller.dispose();
});

test('安装流程：POST install 后每 1.5s 轮询 job，done 后停表并刷新 status', async () => {
  let jobPolls = 0;
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/install')) {
        assert.deepEqual(record.body, { force: true, mirror: 'https://mirror.example', version: '1.2.3' });
        return { ok: true, jobId: 'job-1' };
      }
      if (record.url.includes('api/dsh-wb2api/job')) {
        jobPolls += 1;
        if (jobPolls === 1) {
          return {
            ok: true,
            job: { id: 'job-1', state: 'running', message: '下载中', progress: 0.4, log: ['line-1'], result: null, error: null },
          };
        }
        return {
          ok: true,
          job: { id: 'job-1', state: 'done', message: '完成', progress: 1, log: ['line-1', 'line-2'], result: { version: '1.2.3' }, error: null },
        };
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;

  await controller.install({ force: true, mirror: 'https://mirror.example', version: '1.2.3' });
  assert.equal(controller.getSnapshot().job.id, 'job-1', 'install 后必须记录 jobId');
  assert.equal(controller.getSnapshot().job.state, 'running');
  assert.equal(booted.harness.pendingTimers() >= 1, true, 'install 后必须挂上轮询定时器');

  booted.harness.advance(1500);
  await waitTicks(8);
  assert.equal(jobPolls >= 2, true, '1.5s 后必须再轮询 job，实际 ' + jobPolls);
  assert.equal(controller.getSnapshot().job.state, 'done', 'done 后 job 状态必须更新');
  assert.equal(booted.harness.pendingTimers(), 0, '结束后不得留下轮询定时器');
  controller.dispose();
});

test('登录流程：POST login/start 拿到链接，轮询 done 后收尾并刷新账号', async () => {
  let polls = 0;
  const seen = [];
  const booted = boot({
    onRequest(record) {
      seen.push(record);
      if (record.url.endsWith('api/dsh-wb2api/login/start')) {
        assert.deepEqual(record.body, { realm: 'cn' });
        return { ok: true, state: 'st-1', url: 'https://example.invalid/auth?st=1' };
      }
      if (record.url.includes('api/dsh-wb2api/login/poll')) {
        polls += 1;
        if (polls === 1) return { ok: true, done: false };
        return { ok: true, done: true, nickname: '新账号', uid: 'u-3', realm: 'cn', credits: 1, creditsTotal: 2, error: null };
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;

  await controller.loginStart('cn');
  const login = controller.getSnapshot().login;
  assert.ok(login, 'loginStart 后必须有待登录状态');
  assert.equal(login.url, 'https://example.invalid/auth?st=1');
  await waitTicks(8);
  assert.equal(polls >= 1, true, 'start 之后必须发起轮询');

  const before = seen.filter((c) => c.url.endsWith('api/dsh-wb2api/status')).length;
  booted.harness.advance(3000);
  await waitTicks(12);
  assert.equal(polls >= 2, true, '应继续轮询直到 done');
  assert.equal(controller.getSnapshot().login, null, 'done 后应清掉待登录状态');
  const after = seen.filter((c) => c.url.endsWith('api/dsh-wb2api/status')).length;
  assert.ok(after > before, 'done 后必须刷新 status');
  assert.equal(booted.harness.pendingTimers(), 0, 'done 后不得留下轮询定时器');
  controller.dispose();
});

test('登录超时：5 分钟仍未 done 必须停止轮询并结束登录态', async () => {
  let polls = 0;
  const booted = boot({
    onRequest(record) {
      if (record.url.includes('api/dsh-wb2api/login/poll')) {
        polls += 1;
        return { ok: true, done: false };
      }
      if (record.url.endsWith('api/dsh-wb2api/login/start')) {
        return { ok: true, state: 'st-2', url: 'https://example.invalid/auth?st=2' };
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.loginStart('global');
  await waitTicks(6);
  const afterStart = polls;
  booted.harness.advance(5 * 60 * 1000 + 3000);
  await waitTicks(12);
  assert.ok(polls > afterStart, '超时前应持续轮询');
  assert.equal(booted.harness.pendingTimers(), 0, '超时后必须清掉定时器');
  assert.equal(controller.getSnapshot().login, null, '超时后应结束登录态');
  controller.dispose();
});

test('错误处理：{ok:false,error} 必须转成可读 error，不静默', async () => {
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/status')) return { ok: false, error: '服务未响应' };
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.refresh();
  const snapshot = controller.getSnapshot();
  assert.ok(snapshot.error, '失败必须写入 error');
  assert.ok(String(snapshot.error).includes('服务未响应'), 'error 文案必须来自宿主，实际: ' + snapshot.error);
  assert.equal(snapshot.loading, false, '失败后必须复位 loading');
  controller.dispose();
});

test('防御性：slots 抛错时 apply 必须吞掉，只留下带 [wb2api] 前缀的警告', () => {
  const booted = boot({
    onRequest: (r) => defaultRoutes(r),
    overrides: {
      slots: {
        inject() {
          throw new Error('slot gone');
        },
      },
    },
  });
  assert.equal(booted.applyError, null, 'slots 抛错也必须被 apply 吞掉');
  assert.equal(booted.state.registered.length, 0);
  assert.equal(
    booted.warnings().some((w) => w.includes('[wb2api]')),
    true,
    '必须留下 [wb2api] 前缀的警告',
  );
});

test('登录链接：可点击 a[target=_blank][rel=noreferrer] + 复制按钮写入剪贴板并提示成功', async () => {
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/login/start')) {
        return { ok: true, state: 'st-3', url: 'https://example.invalid/auth?st=3' };
      }
      if (record.url.includes('api/dsh-wb2api/login/poll')) return { ok: true, done: false };
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.loginStart('cn');
  await waitTicks(6);
  booted.render();
  assert.equal(booted.renderError, null, '待登录状态渲染不得抛错: ' + booted.renderError);

  const anchors = findAll(booted.tree, (n) => n.tagName === 'A');
  assert.equal(anchors.length, 1, '待登录时必须有 1 个授权链接，实际 ' + anchors.length);
  const link = anchors[0];
  assert.equal(link.attributes.href, 'https://example.invalid/auth?st=3');
  assert.equal(link.attributes.target, '_blank');
  assert.equal(link.attributes.rel, 'noreferrer');
  assert.ok(textOf(booted.tree).includes('在浏览器打开链接完成登录'), '文案必须提示在浏览器打开链接');

  const copy = findAll(booted.tree, (n) => n.tagName === 'BUTTON' && textOf(n).includes('复制'));
  assert.equal(copy.length, 1, '必须有一个复制链接按钮，实际 ' + copy.length);
  copy[0].listeners.click();
  await waitTicks(4);
  assert.deepEqual(booted.harness.clipboardWrites, ['https://example.invalid/auth?st=3'], '必须把链接写入剪贴板');
  const notice = controller.getSnapshot().notice;
  assert.ok(notice && notice.tone === 'success', '复制成功必须给出成功提示，实际 ' + JSON.stringify(notice));
  controller.dispose();
});

test('登录链接：剪贴板失败必须给出可读提示，不静默', async () => {
  const booted = boot({
    clipboardMode: 'reject',
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/login/start')) {
        return { ok: true, state: 'st-4', url: 'https://example.invalid/auth?st=4' };
      }
      if (record.url.includes('api/dsh-wb2api/login/poll')) return { ok: true, done: false };
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.loginStart('cn');
  await waitTicks(6);
  booted.render();
  const copy = findAll(booted.tree, (n) => n.tagName === 'BUTTON' && textOf(n).includes('复制'));
  assert.equal(copy.length, 1);
  copy[0].listeners.click();
  await waitTicks(6);
  const notice = controller.getSnapshot().notice;
  assert.ok(notice, '剪贴板失败必须有提示');
  assert.equal(notice.tone, 'warn', '剪贴板失败应给 warn，实际 ' + notice.tone);
  assert.ok(String(notice.text).includes('手动'), '提示应引导手动复制，实际: ' + notice.text);
  controller.dispose();
});

test('分区隔离：单个分区渲染抛错只降级那一块，其余照常渲染', async () => {
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/status')) {
        return Object.assign({}, STATUS_OK, { accounts: 'not-an-array' });
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.refresh();
  booted.render();

  const text = textOf(booted.tree);
  assert.ok(text.includes('这一块渲染失败'), '抛错分区必须显示降级文案，实际: ' + text.slice(0, 200));
  assert.ok(text.includes(STATUS_OK.service.version), '服务分区必须照常渲染版本号');
  assert.ok(!text.includes('服务未安装'), '服务分区不应显示未安装');
  assert.equal(
    booted.warnings().some((w) => w.includes('[wb2api] section crashed')),
    true,
    '必须留下 [wb2api] section crashed 警告',
  );
  controller.dispose();
});

test('控制器释放：dispose 之后不得残留定时器', async () => {
  const booted = boot({ onRequest: (r) => defaultRoutes(r) });
  await booted.controller.refresh();
  booted.harness.advance(1);
  booted.controller.dispose();
  assert.equal(booted.harness.pendingTimers(), 0, 'dispose 后不得有残留定时器');
});

test('账号列举失败：宿主写在 accountError 里的原因必须浮现，不能装作"没有账号"', async () => {
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/status')) {
        return Object.assign({}, STATUS_OK, { accountError: '连不上 127.0.0.1:7863' });
      }
      return defaultRoutes(record);
    },
  });
  await booted.controller.refresh();
  const error = String(booted.controller.getSnapshot().error || '');
  assert.ok(error.includes('连不上 127.0.0.1:7863'), 'accountError 必须显示在错误条里，实际: ' + error);
  assert.ok(!error.includes('error.loadFailed'), '前缀必须走字典而不是裸 key，实际: ' + error);
  booted.controller.dispose();
});

test('取消登录：取消之后 login/poll 必须停止（以前取消完还会继续轮询 5 分钟）', async () => {
  let polls = 0;
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/login/start')) {
        return { ok: true, state: 'st-cancel', url: 'https://example.invalid/auth?st=cancel' };
      }
      if (record.url.includes('api/dsh-wb2api/login/poll')) {
        polls += 1;
        return { ok: true, done: false };
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.loginStart('cn');
  await waitTicks(4);
  booted.harness.advance(3000);
  await waitTicks(4);
  assert.ok(polls >= 1, '轮询应该已经开始，实际 ' + polls);

  controller.cancelLogin();
  const before = polls;
  booted.harness.advance(60 * 60 * 1000); // 快进一小时
  await waitTicks(6);
  assert.equal(polls, before, '取消之后不得再发起 login/poll，实际多发了 ' + (polls - before));
  assert.equal(booted.harness.pendingTimers(), 0, '取消之后不得残留轮询定时器');
  controller.dispose();
});

test('安装轮询：任务不结束时必须有总时长上限，不能无限轮询', async () => {
  let jobPolls = 0;
  const booted = boot({
    onRequest(record) {
      if (record.url.endsWith('api/dsh-wb2api/install')) return { ok: true, jobId: 'job-slow' };
      if (record.url.includes('api/dsh-wb2api/job')) {
        jobPolls += 1;
        return { ok: true, job: { id: 'job-slow', state: 'running', progress: null, message: '下载中', log: [] } };
      }
      return defaultRoutes(record);
    },
  });
  const controller = booted.controller;
  await controller.install({ force: false });
  await waitTicks(4);
  assert.ok(jobPolls >= 1, '安装后应立刻轮询一次，实际 ' + jobPolls);

  // 快进 31 分钟（JOB_TIMEOUT_MS = 30 分钟），期间按轮询间隔推进假时钟
  for (let i = 0; i < 32; i += 1) {
    booted.harness.advance(60 * 1000);
    await waitTicks(4);
  }
  const job = controller.getSnapshot().job;
  assert.ok(job, '应仍保留任务状态');
  assert.equal(job.state, 'error', '超时后必须停在 error 而不是永远 running');
  assert.ok(String(job.error).includes('超时'), '超时文案要说清原因，实际: ' + String(job.error));
  const after = jobPolls;
  booted.harness.advance(10 * 60 * 1000);
  await waitTicks(4);
  assert.equal(jobPolls, after, '超时之后不得再轮询');
  controller.dispose();
});

