// ServiceManager 的进程生命周期测试。
//
// 关键约束：绝不能用真的 wb2api 镜像名（否则 listPids 会匹配到用户正在跑的网关，
// stopService/dispose 会把它杀掉），所以这里用 tools/fake-gateway.mjs 当替身，
// imageName 取一个不可能存在的名字，exePath 用 node 自己。
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { ServiceManager, registry, isAlive, killTree } from '../lib/core/service.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const FIXTURE = join(HERE, '..', 'tools', 'fake-gateway.mjs');
/** 必须匹配不到任何真实进程：用户机器上的 wb2api.exe 不能被测试碰到。 */
const IMAGE = 'wb2api-fake-gateway-not-real.exe';

const dir = mkdtempSync(join(tmpdir(), 'dsh-wb2api-svc-'));
after(() => {
  registry().pids.clear();
  rmSync(dir, { recursive: true, force: true });
});

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.on('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
  });
}

async function waitHealthy(port, timeoutMs = 8000) {
  const began = Date.now();
  while (Date.now() - began < timeoutMs) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(500) });
      if (res.ok) return true;
    } catch {
      /* 还没起来 */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

function manager(port, extra = {}) {
  registry().pids.clear();
  return new ServiceManager({
    exePath: process.execPath,
    args: extra.args ?? [FIXTURE, '--port', String(port)],
    cwd: HERE,
    imageName: IMAGE,
    baseURL: `http://127.0.0.1:${port}`,
    stateDir: dir,
    startTimeoutMs: extra.startTimeoutMs ?? 20000,
    healthTimeoutMs: 800,
    watchdogSeconds: 30,
    restartDelayMs: extra.restartDelayMs ?? 20,
    keepAlive: extra.keepAlive ?? false,
    killOnExit: extra.killOnExit ?? false,
    adoptExisting: extra.adoptExisting ?? true,
    log: () => {},
  });
}

test('startService：拉起后健康检查通过、落 pid 文件、进程被纳管', async () => {
  const port = await freePort();
  const mgr = manager(port);
  const r = await mgr.startService('测试');
  try {
    assert.equal(r.ok, true, r.error);
    assert.equal(r.health.body.service, 'fake-gateway');
    const pidFile = JSON.parse(readFileSync(join(dir, 'wb2api.pid'), 'utf8'));
    assert.equal(pidFile.pid, r.pid);
    assert.equal(pidFile.reason, '测试');
    assert.ok(registry().pids.has(r.pid), '启动成功要纳管，否则 killOnExit 不成立');
    assert.equal(isAlive(r.pid), true);
    assert.equal(mgr.startedByUs, true);
  } finally {
    await mgr.stopService('测试结束');
  }
});

test('startService：子进程启动即退出时快速失败，不干等到超时', async () => {
  const port = await freePort();
  const mgr = manager(port, { startTimeoutMs: 20000, args: [FIXTURE, '--exit-now'] });
  const r = await mgr.startService('测试');
  assert.equal(r.ok, false);
  assert.match(String(r.error), /刚启动就退出/);
  assert.ok(r.waitedMs < 5000, `不该等满 20s 超时，实际 ${r.waitedMs}ms`);
  assert.match(String(mgr.lastError), /端口被占用/);
  assert.equal(
    registry().pids.has(r.pid),
    false,
    '已经死掉的 pid 必须从纳管表摘掉：Windows 的 PID 会复用，留着会在退出钩子里误杀无关进程',
  );
});

test('stopService：结束进程后不留残影', async () => {
  const port = await freePort();
  const mgr = manager(port);
  const r = await mgr.startService('测试');
  assert.equal(r.ok, true, r.error);
  const pid = r.pid;
  const stopped = await mgr.stopService('测试结束');
  assert.equal(stopped.ok, true, `仍有残留：${(stopped.left || []).join(', ')}`);
  assert.equal(isAlive(pid), false, 'stopService 之后进程必须真的没了');
  assert.equal(registry().pids.size, 0);
});

test('adoptExisting：把外部已在跑的进程纳管（killOnExit 才会生效）', async () => {
  const port = await freePort();
  const child = spawn(process.execPath, [FIXTURE, '--port', String(port)], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
  });
  child.unref();
  assert.equal(await waitHealthy(port), true, '假网关没起来，测试环境有问题');

  const mgr = manager(port, { keepAlive: true, killOnExit: true });
  mgr.listPids = () => [child.pid];
  try {
    assert.equal(await mgr.adoptExisting('测试纳管'), true);
    assert.equal(mgr.startedByUs, false, '外部的进程不该算是我们拉起的');
    assert.ok(registry().pids.has(child.pid));
    assert.equal(await mgr.adoptExisting('再纳一次'), false, '已经纳管过就不该重复');
  } finally {
    await mgr.stopService('测试结束');
    registry().pids.clear();
    killTree(child.pid, () => {});
  }
});

test('看护：连续 3 次健康检查失败才重启，重启后计数清零', async () => {
  const mgr = manager(await freePort(), { keepAlive: true });
  const calls = [];
  mgr.listPids = () => [process.pid]; // 假装服务进程还在，但端口上没有服务 → 健康检查失败
  mgr.restartService = async (reason) => {
    calls.push(reason);
    return { ok: true };
  };
  await mgr.tick();
  await mgr.tick();
  assert.deepEqual(calls, [], '不到 3 次不该重启');
  await mgr.tick();
  assert.deepEqual(calls, ['看护重启']);
  assert.equal(mgr.failStreak, 0, '重启之后计数要清零');
});

test('看护：发现进程不在了就重新拉起，并清掉纳管表', async () => {
  const mgr = manager(await freePort(), { keepAlive: true, restartDelayMs: 10 });
  const calls = [];
  mgr.listPids = () => [];
  mgr.startService = async (reason) => {
    calls.push(reason);
    return { ok: true };
  };
  registry().pids.add(123456);
  await mgr.tick();
  assert.deepEqual(calls, ['看护重启']);
  assert.equal(registry().pids.size, 0, '进程都没了，纳管表必须先清空');
});

test('startService：可执行文件不存在时快速失败（走前置检查）', async () => {
  const port = await freePort();
  const mgr = new ServiceManager({
    exePath: join(dir, '这个文件不存在-不存在.exe'),
    args: ['-config', 'config.json'],
    cwd: dir,
    imageName: IMAGE,
    baseURL: `http://127.0.0.1:${port}`,
    stateDir: dir,
    startTimeoutMs: 20000,
    healthTimeoutMs: 500,
    keepAlive: false,
    killOnExit: false,
    log: () => {},
  });
  const began = Date.now();
  const r = await mgr.startService('测试');
  const spent = Date.now() - began;
  assert.equal(r.ok, false, '可执行文件不存在必须失败');
  assert.match(r.error, /可执行文件不存在/, `错误文案要说清原因：${r.error}`);
  assert.ok(spent < 2000, `前置检查就该立刻返回（等了 ${spent}ms）`);
  assert.equal(registry().pids.size, 0);
});

test('startService：文件在但不是可执行程序时，spawn 失败必须被接住（同步抛或被 error 事件接住，都不能崩宿主）', async () => {
  const port = await freePort();
  // 存在、但不是有效的 Windows 可执行文件：spawn 会异步发 'error' 而不是 'exit'。
  const fakeExe = join(dir, '不是程序.exe');
  writeFileSync(fakeExe, 'this is not a program\n');
  const mgr = new ServiceManager({
    exePath: fakeExe,
    args: ['-config', 'config.json'],
    cwd: dir,
    imageName: IMAGE,
    baseURL: `http://127.0.0.1:${port}`,
    stateDir: dir,
    startTimeoutMs: 20000,
    healthTimeoutMs: 500,
    keepAlive: false,
    killOnExit: false,
    log: () => {},
  });
  const began = Date.now();
  const r = await mgr.startService('测试');
  const spent = Date.now() - began;
  assert.equal(r.ok, false, '不是可执行程序必须失败而不是"就绪"');
  assert.match(r.error, /拉起失败|无法启动/, `错误文案要说清是启动失败：${r.error}`);
  assert.ok(r.error.includes(fakeExe), `错误里要带上可执行文件路径，方便定位：${r.error}`);
  assert.ok(spent < 5000, `不该干等到超时（等了 ${spent}ms）`);
  assert.equal(registry().pids.size, 0, '启动失败不能留下纳管记录');
  assert.equal(mgr.child, null, '失败的子进程句柄要清掉');
});
