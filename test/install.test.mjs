/**
 * 真实网络下的安装流程测试：从上游 Release 下载当前平台资产、校验 sha256、解压、定位可执行文件。
 * 默认跳过（会下载数 MB 且依赖 GitHub 连通性），需要时这样跑：
 *
 *   $env:WB2API_TEST_NETWORK='1'; node --test test/install.test.mjs
 *
 * 可选环境变量：
 *   WB2API_TEST_REPO    默认 linguo2625469/workbuddy2api-panel
 *   WB2API_TEST_TAG     默认 latest
 *   WB2API_TEST_MIRROR  下载镜像前缀，例如 https://ghfast.top/
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { installFromRelease, fetchRelease, fetchChecksums } from '../lib/core/download.js';
import { detectTarget, assetNameFor, pickAsset } from '../lib/core/platform.js';
import { ensureWorkspaceConfig, readApiKey } from '../lib/core/workspace.js';

const enabled = process.env.WB2API_TEST_NETWORK === '1';
const repo = process.env.WB2API_TEST_REPO || 'linguo2625469/workbuddy2api-panel';
const tag = process.env.WB2API_TEST_TAG || 'latest';
const mirror = process.env.WB2API_TEST_MIRROR || '';

test('真实 Release 上有当前平台的资产，且 checksums.txt 覆盖它', { skip: !enabled }, async () => {
  const target = detectTarget();
  assert.equal(target.supported, true, target.reason);
  const release = await fetchRelease({ repo, tag });
  assert.ok(release.tag, 'Release 应有 tag');
  const asset = pickAsset(release.assets, release.tag, target);
  assert.ok(asset, `Release ${release.tag} 应有 ${assetNameFor(release.tag, target)}`);
  const sums = await fetchChecksums({ repo, tag: release.tag, mirror });
  assert.ok(sums.has(asset.name), `checksums.txt 应包含 ${asset.name}`);
  assert.match(sums.get(asset.name), /^[0-9a-f]{64}$/);
});

test('完整安装：下载 → 校验 → 解压 → 找到可执行文件 → 生成 config.json', { skip: !enabled }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'wb2api-install-'));
  const lines = [];
  try {
    const r = await installFromRelease({ repo, tag, installDir: dir, mirror, log: (m) => lines.push(m) });
    assert.ok(existsSync(r.exePath), `可执行文件应存在：${r.exePath}`);
    assert.ok(statSync(r.exePath).size > 1024 * 1024, '上游二进制应有数 MB');
    assert.equal(r.sha256.length, 64);
    assert.ok(['tar', 'powershell', 'unzip'].includes(r.extractedWith));

    const ws = ensureWorkspaceConfig(dir, { listen: '127.0.0.1:7863' });
    assert.equal(ws.created, true);
    assert.equal(readApiKey(dir), ws.apiKey);

    console.log(`安装结果：${r.exePath}（${r.tag} / ${r.asset} / sha256 ${r.sha256.slice(0, 12)}… / 解压用 ${r.extractedWith}）`);
    console.log(lines.map((l) => `  ${l}`).join('\n'));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
