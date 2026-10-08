/**
 * 纯函数部分的离线测试：平台映射、checksums 解析、模型挑选、设置写入的前置计算、config.json 生成。
 * 运行：node --test test/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { detectTarget, assetNameFor, exeNameFor, pickAsset } from '../lib/core/platform.js';
import { parseChecksums, applyMirror, findExecutable } from '../lib/core/download.js';
import { resolveKeep, buildProfiles, diffProfiles, realmOf, formatModelTable } from '../lib/core/models.js';
import { ensureWorkspaceConfig, readApiKey, generateApiKey, FALLBACK_EXAMPLE } from '../lib/core/workspace.js';
import { toModelProfile } from '../lib/core/wb2api.js';

const MODELS = [
  { id: 'cn:alpha', name: 'Alpha', context_length: 1000000, max_output_tokens: 65536, supports_images: false },
  { id: 'cn:beta', name: 'Beta', context_length: 200000, max_output_tokens: 32768, supports_images: true },
  { id: 'global:delta', name: 'Delta', context_length: 400000, max_output_tokens: 64000, supports_images: true },
];

test('平台识别：Windows/macOS/Linux 三种，以及不支持的情况', () => {
  assert.deepEqual(detectTarget('win32', 'x64'), { os: 'windows', arch: 'amd64', supported: true });
  assert.deepEqual(detectTarget('darwin', 'arm64'), { os: 'darwin', arch: 'arm64', supported: true });
  assert.equal(detectTarget('linux', 'x64').os, 'linux');
  assert.equal(detectTarget('freebsd', 'x64').supported, false);
  assert.equal(detectTarget('win32', 'ia32').supported, false);
  assert.equal(assetNameFor('v1.12.0', { os: 'windows', arch: 'amd64' }), 'wb2api-panel-v1.12.0-windows-amd64.zip');
  assert.equal(assetNameFor('v1.12.0', { os: 'linux', arch: 'arm64' }), 'wb2api-panel-v1.12.0-linux-arm64.tar.gz');
  assert.equal(exeNameFor('windows'), 'wb2api.exe');
  assert.equal(exeNameFor('linux'), 'wb2api');
});

test('资产挑选：优先精确命名，其次按 os+arch 模糊匹配', () => {
  const assets = [
    { name: 'checksums.txt', browser_download_url: 'u0' },
    { name: 'wb2api-panel-v1.2.0-windows-amd64.zip', browser_download_url: 'u1' },
    { name: 'wb2api-panel-v1.2.0-linux-amd64.tar.gz', browser_download_url: 'u2' },
  ];
  assert.equal(pickAsset(assets, 'v1.2.0', { os: 'windows', arch: 'amd64' }).browser_download_url, 'u1');
  assert.equal(pickAsset(assets, 'v1.2.0', { os: 'linux', arch: 'amd64' }).browser_download_url, 'u2');
  // 上游改了命名规则时的兜底
  const renamed = [{ name: 'wb2api-panel-1.2.0-windows-amd64.zip', browser_download_url: 'u3' }];
  assert.equal(pickAsset(renamed, 'v9.9.9', { os: 'windows', arch: 'amd64' }).browser_download_url, 'u3');
  assert.equal(pickAsset(assets, 'v1.2.0', { os: 'darwin', arch: 'arm64' }), null);
});

test('checksums.txt 解析：带星号、带路径、带注释都能处理', () => {
  const text = [
    '3f2a' + '0'.repeat(60) + '  wb2api-panel-v1.0.0-windows-amd64.zip',
    'ab12' + '1'.repeat(60) + ' *wb2api-panel-v1.0.0-linux-amd64.tar.gz',
    '# 这是注释',
    '',
    'not-a-hash  x.zip',
  ].join('\n');
  const map = parseChecksums(text);
  assert.equal(map.size, 2);
  assert.equal(map.get('wb2api-panel-v1.0.0-windows-amd64.zip'), '3f2a' + '0'.repeat(60));
  assert.equal(map.get('wb2api-panel-v1.0.0-linux-amd64.tar.gz'), 'ab12' + '1'.repeat(60));
});

test('镜像前缀拼接', () => {
  const url = 'https://github.com/a/b/releases/download/v1/x.zip';
  assert.equal(applyMirror(url, ''), url);
  assert.equal(applyMirror(url, 'https://ghfast.top/'), `https://ghfast.top/${url}`);
  assert.equal(applyMirror(url, 'https://ghfast.top'), `https://ghfast.top/${url}`);
});

test('realm 前缀与模型保留语义', () => {
  assert.equal(realmOf('cn:alpha'), 'cn');
  assert.equal(realmOf('global:delta'), 'global');
  assert.equal(realmOf('alpha'), null);

  // keep 为空 = 全部保留
  assert.deepEqual(resolveKeep(MODELS, []).ids, ['cn:alpha', 'cn:beta', 'global:delta']);
  // 指定子集
  assert.deepEqual(resolveKeep(MODELS, ['cn:beta']).ids, ['cn:beta']);
  // 不存在的 id 放进 missing，而不是静默消失
  const r = resolveKeep(MODELS, ['cn:beta', 'cn:nope']);
  assert.deepEqual(r.ids, ['cn:beta']);
  assert.deepEqual(r.missing, ['cn:nope']);
  // realm 过滤
  assert.deepEqual(resolveKeep(MODELS, [], { realm: 'global' }).all, ['global:delta']);
  // 去掉空白项
  assert.deepEqual(resolveKeep(MODELS, ['  ', 'cn:alpha']).ids, ['cn:alpha']);
});

test('生成 models 数组：旧条目字段保留，新条目补元数据', () => {
  const existing = [{ id: 'cn:alpha', name: 'Alpha 手工改名', contextWindow: 12345, reasoningEfforts: { off: null, low: 'low' } }];
  const next = buildProfiles(MODELS, ['cn:alpha', 'cn:beta', 'cn:unknown'], existing);
  assert.equal(next.length, 3);
  // 复用旧条目：用户改过的 name/contextWindow 与自定义字段都还在
  assert.equal(next[0].name, 'Alpha 手工改名');
  assert.equal(next[0].contextWindow, 12345);
  assert.deepEqual(next[0].reasoningEfforts, { off: null, low: 'low' });
  // 新条目从服务端元数据补齐
  assert.equal(next[1].id, 'cn:beta');
  assert.equal(next[1].contextWindow, 200000);
  assert.deepEqual(next[1].input, ['text', 'image']);
  // 服务端没有的 id 也要保留（用户明确要求保留它）
  assert.deepEqual(next[2], { id: 'cn:unknown' });
});

test('模型档案映射：只写 pi-ai 认识的字段，空值不写', () => {
  assert.deepEqual(toModelProfile({ id: 'cn:x', name: 'X', context_length: 1000, max_output_tokens: 100, supports_images: true }), {
    id: 'cn:x',
    name: 'X',
    contextWindow: 1000,
    maxTokens: 100,
    input: ['text', 'image'],
  });
  assert.deepEqual(toModelProfile({ id: 'cn:y' }), { id: 'cn:y', input: ['text'] });
});

test('清单差异摘要', () => {
  const before = [{ id: 'a' }, { id: 'b' }];
  const after = [{ id: 'b' }, { id: 'c' }];
  const d = diffProfiles(before, after);
  assert.equal(d.changed, true);
  assert.deepEqual(d.added, ['c']);
  assert.deepEqual(d.removed, ['a']);
  assert.equal(diffProfiles(before, [{ id: 'b' }, { id: 'a' }]).changed, false);
});

test('清单表格：保留态标记', () => {
  const all = formatModelTable(MODELS, []);
  assert.match(all, /全部保留/);
  const some = formatModelTable(MODELS, ['cn:alpha']);
  assert.match(some, /★ cn:alpha/);
  assert.match(some, /^ {2}cn:beta/m);
});

test('config.json 生成：随机 key、只监听本机、已存在时不覆盖', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-ws-'));
  try {
    const first = ensureWorkspaceConfig(dir, { listen: '127.0.0.1:7863' });
    assert.equal(first.created, true);
    assert.equal(first.apiKey.length, 43);
    assert.equal(readApiKey(dir), first.apiKey);
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(written.listen, '127.0.0.1:7863');
    assert.equal(written.api_key, first.apiKey);
    assert.ok(existsSync(join(dir, 'auths')));
    assert.ok(existsSync(join(dir, 'data')));
    // 关键默认值与上游示例一致，避免生成一份上游不认识的配置
    assert.equal(written.schedule.checkin_hours.join(','), '9,21');
    assert.equal(written.pool.credit_floor, FALLBACK_EXAMPLE.pool.credit_floor);

    // 第二次调用不应重写
    const second = ensureWorkspaceConfig(dir, { listen: '127.0.0.1:7863' });
    assert.equal(second.created, false);
    assert.equal(second.apiKey, first.apiKey);
    assert.equal(JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8')).api_key, first.apiKey);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('config.json 修补：补 api_key，并把 ":7863" 收紧为回环地址', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-ws2-'));
  try {
    writeFileSync(join(dir, 'config.json'), JSON.stringify({ listen: ':7863', auth_dir: './auths' }));
    const r = ensureWorkspaceConfig(dir, { listen: '127.0.0.1:7863' });
    assert.equal(r.created, false);
    const written = JSON.parse(readFileSync(join(dir, 'config.json'), 'utf8'));
    assert.equal(written.listen, '127.0.0.1:7863');
    assert.equal(written.api_key.length, 43);
    // 用户已有的其它字段不能被碰掉
    assert.equal(written.auth_dir, './auths');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('随机 api_key 不重复且是 URL 安全字符', () => {
  const keys = new Set(Array.from({ length: 32 }, () => generateApiKey()));
  assert.equal(keys.size, 32);
  for (const k of keys) assert.match(k, /^[A-Za-z0-9]{43}$/);
});

test('在解压结果里定位可执行文件：跳过 __MACOSX', () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-find-'));
  try {
    const sub = join(dir, 'wb2api-panel-v1.0.0-windows-amd64');
    mkdirSync(sub, { recursive: true });
    mkdirSync(join(dir, '__MACOSX'), { recursive: true });
    writeFileSync(join(sub, 'wb2api.exe'), 'x');
    assert.equal(findExecutable(dir, 'wb2api.exe'), join(sub, 'wb2api.exe'));
    assert.equal(findExecutable(dir, 'nope.exe'), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
