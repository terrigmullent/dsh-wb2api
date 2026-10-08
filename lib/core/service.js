/**
 * 服务生命周期管理：启动、接管、健康探测、看护重启、退出清理。
 * 只依赖 Node 内置模块。跨平台（Windows 用 tasklist/taskkill，其他平台用 pgrep/kill）。
 */
import { spawn, execFileSync } from 'node:child_process';
import { openSync, writeFileSync, readFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 进程级共享注册表：同一个 DSH 进程里多个插件实例（例如 HMR 重载）共用，避免重复安装退出钩子。 */
export const REGISTRY_KEY = Symbol.for('dsh.wb2api.registry');

export function registry() {
  if (!globalThis[REGISTRY_KEY]) {
    globalThis[REGISTRY_KEY] = { pids: new Set(), exitHookInstalled: false };
  }
  return globalThis[REGISTRY_KEY];
}

/** 杀掉单个进程及其子进程。 */
export function killTree(pid, log = () => {}) {
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGTERM');
    }
    log(`已结束进程 ${pid}`);
    return true;
  } catch (err) {
    log(`结束进程 ${pid} 失败：${err.message}`);
    return false;
  }
}

/** 进程是否还活着（不依赖 /proc）。 */
export function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return err.code === 'EPERM';
  }
}

export class ServiceManager {
  /**
   * @param {object} opts
   * @param {string} opts.exePath
   * @param {string[]} opts.args
   * @param {string} opts.cwd
   * @param {string} opts.imageName        用于按镜像名找进程，默认取 exePath 的文件名
   * @param {string} opts.baseURL          健康检查基址，例如 http://127.0.0.1:7863
   * @param {string} opts.stateDir         放 pid 文件与日志的目录
   * @param {number} [opts.startTimeoutMs] 启动后等待就绪的上限
   * @param {number} [opts.healthTimeoutMs] 单次健康检查超时
   * @param {number} [opts.watchdogSeconds] 看护间隔（0 表示不启用）
   * @param {number} [opts.restartDelayMs]  重启前的静默期
   * @param {boolean} [opts.keepAlive]      掉了是否自动重启
   * @param {boolean} [opts.killOnExit]     DSH/宿主进程退出时是否结束服务
   * @param {boolean} [opts.adoptExisting]  发现服务已在跑时是否纳管（影响 killOnExit 能否生效）
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts) {
    this.opts = {
      args: ['-config', 'config.json'],
      startTimeoutMs: 90000,
      healthTimeoutMs: 3000,
      watchdogSeconds: 30,
      restartDelayMs: 4000,
      keepAlive: true,
      killOnExit: true,
      adoptExisting: true,
      log: () => {},
      ...opts,
    };
    this.opts.imageName ||= this.opts.exePath.split(/[\\/]/).pop();
    this.pidFile = join(this.opts.stateDir, 'wb2api.pid');
    this.logFile = join(this.opts.stateDir, 'wb2api.log');
    this.child = null;
    this.watchdogTimer = null;
    this.failStreak = 0;
    this.lastEvent = null;
    this.lastError = null;
    this.startedByUs = false;
    this.installedAt = null;
    this.reg = registry();
  }

  log(msg) {
    this.lastEvent = `${new Date().toISOString()} ${msg}`;
    this.opts.log(msg);
  }

  /** 健康检查：返回 {ok, status, body}，任何异常都算不健康。 */
  async health(timeoutMs = this.opts.healthTimeoutMs) {
    const url = `${this.opts.baseURL.replace(/\/+$/, '')}/healthz`;
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
      const text = await res.text();
      let body = null;
      try {
        body = JSON.parse(text);
      } catch {
        /* 非 JSON 也认，只要 2xx */
      }
      return { ok: res.ok, status: res.status, body, raw: text };
    } catch (err) {
      return { ok: false, status: 0, body: null, error: err.message };
    }
  }

  /** 按镜像名列出正在运行的进程 pid。 */
  listPids() {
    const name = this.opts.imageName;
    try {
      if (process.platform === 'win32') {
        const out = execFileSync('tasklist', ['/FI', `IMAGENAME eq ${name}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
        const pids = [];
        for (const line of out.split(/\r?\n/)) {
          const m = line.match(/^"[^"]+","(\d+)"/);
          if (m) pids.push(Number(m[1]));
        }
        return pids;
      }
      const out = execFileSync('pgrep', ['-f', this.opts.exePath], { encoding: 'utf8' });
      return out
        .split(/\s+/)
        .filter(Boolean)
        .map(Number)
        .filter((n) => Number.isFinite(n));
    } catch {
      return [];
    }
  }

  readPidFile() {
    try {
      const json = JSON.parse(readFileSync(this.pidFile, 'utf8'));
      return Number.isFinite(json.pid) ? json : null;
    } catch {
      return null;
    }
  }

  rememberPids(pids, reason) {
    for (const pid of pids) {
      if (!this.reg.pids.has(pid)) {
        this.reg.pids.add(pid);
        this.log(`${reason}：纳管 pid ${pid}`);
      }
    }
    this.installExitHook();
  }

  /** 安装退出钩子：进程退出时同步杀掉纳管的服务进程。 */
  installExitHook() {
    if (this.reg.exitHookInstalled || !this.opts.killOnExit) return;
    this.reg.exitHookInstalled = true;
    process.on('exit', () => {
      for (const pid of this.reg.pids) {
        try {
          if (process.platform === 'win32') execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
          else process.kill(pid, 'SIGTERM');
        } catch {
          /* 退出阶段尽力而为 */
        }
      }
    });
  }

  /**
   * 发现服务已经在跑（例如用户手动开的，或上一次 DSH 的非正常退出残留）时纳管它。
   * 没有这一步，killOnExit 对"本来就在跑的服务"不成立。
   */
  async adoptExisting(reason) {
    if (!this.opts.keepAlive || !this.opts.killOnExit || !this.opts.adoptExisting) return false;
    if (this.reg.pids.size > 0) return false;
    const pids = this.listPids();
    if (!pids.length) return false;
    this.rememberPids(pids, `接管已在运行的 wb2api（${reason}）`);
    this.startedByUs = false;
    return true;
  }

  writePidFile(pid, extra = {}) {
    try {
      mkdirSync(dirname(this.pidFile), { recursive: true });
      writeFileSync(this.pidFile, JSON.stringify({ pid, exePath: this.opts.exePath, startedBy: 'dsh-wb2api', startedAt: new Date().toISOString(), ...extra }, null, 2));
    } catch (err) {
      this.log(`写 pid 文件失败：${err.message}`);
    }
  }

  /** 拉起服务并等到健康检查通过；已有进程则接管。 */
  async startService(reason) {
    const running = this.listPids();
    if (running.length) {
      this.rememberPids(running, `接管已在运行的 wb2api（${reason}）`);
      this.startedByUs = false;
      const h = await this.health();
      if (h.ok) {
        this.log(`服务就绪（复用现有进程 ${running.join(',')}）`);
        return { ok: true, pid: running[0], adopted: true, health: h };
      }
    }

    if (!existsSync(this.opts.exePath)) {
      const msg = `可执行文件不存在：${this.opts.exePath}（先执行安装 / 检查 installDir 配置）`;
      this.lastError = msg;
      this.log(msg);
      return { ok: false, error: msg };
    }
    if (this.opts.cwd && !existsSync(this.opts.cwd)) {
      const msg = `工作目录不存在：${this.opts.cwd}`;
      this.lastError = msg;
      this.log(msg);
      return { ok: false, error: msg };
    }

    let out;
    try {
      mkdirSync(dirname(this.logFile), { recursive: true });
      out = openSync(this.logFile, 'a');
    } catch {
      out = 'ignore';
    }
    let child;
    try {
      child = spawn(this.opts.exePath, this.opts.args, {
        cwd: this.opts.cwd,
        detached: true,
        windowsHide: true,
        stdio: ['ignore', out, out],
      });
    } catch (err) {
      // Windows 上文件存在但不是有效程序时，spawn 会**同步**抛（如 spawn UNKNOWN）；
      // 其他情况（权限、路径失效）则异步发 'error'，两条路都得接住。
      const msg =
        `拉起失败：${err.message}；可执行文件是 ${this.opts.exePath}，` +
        `可能是文件被删/损坏、被杀软拦截或没有执行权限，详见 ${this.logFile}`;
      this.lastError = msg;
      this.log(msg);
      return { ok: false, error: msg };
    }
    child.unref();
    this.child = child;
    this.startedByUs = true;
    this.installedAt = new Date().toISOString();
    // 早退监视：端口被占用 / config.json 非法 / 被杀软拦下时子进程会立刻退出，
    // 有它就不必干等到 startTimeoutMs（默认 90s）才报错。
    const exited = { done: false, code: null, signal: null, spawnError: null };
    // spawn 失败（可执行文件不存在、没有执行权限、不是有效的应用程序）不会触发 'exit'，
    // 而是异步发 'error'；没有监听器时 Node 会按未捕获异常抛出，足以把宿主进程带走。
    child.once('error', (err) => {
      exited.done = true;
      exited.spawnError = err;
      this.lastError = `拉起失败：${err.message}`;
      this.log(`拉起失败（${reason}）：${err.message}`);
    });
    child.once('exit', (code, signal) => {
      exited.done = true;
      exited.code = code;
      exited.signal = signal;
    });
    this.log(`已拉起 wb2api（${reason}）：pid ${child.pid}，日志 ${this.logFile}`);
    this.writePidFile(child.pid, { reason, args: this.opts.args, cwd: this.opts.cwd });
    this.rememberPids([child.pid], `纳管新进程（${reason}）`);

    const ready = await this.waitForReady(this.opts.startTimeoutMs, { exited, pid: child.pid });
    if (!ready.ok) {
      this.lastError = ready.error;
      this.log(`启动后未能就绪：${ready.error}`);
      if (exited.done) {
        // 进程已经死了就把它从纳管表里摘掉：Windows 的 PID 会被复用，
        // 留着会在退出钩子里误杀无关进程。
        this.reg.pids.delete(child.pid);
        this.child = null;
      }
    } else {
      this.log(`服务就绪（pid ${child.pid}，等待 ${ready.waitedMs}ms）`);
    }
    return { ok: ready.ok, pid: child.pid, started: true, error: ready.error, health: ready.health, waitedMs: ready.waitedMs };
  }

  /**
   * 轮询健康检查直到通过或超时。
   * @param {number} timeoutMs
   * @param {{exited?: {done: boolean, code: number|null, signal: string|null}, pid?: number}} [watch] 刚拉起的子进程早退监视
   */
  async waitForReady(timeoutMs, watch = null) {
    const began = Date.now();
    let last = null;
    while (Date.now() - began < timeoutMs) {
      last = await this.health();
      if (last.ok) return { ok: true, waitedMs: Date.now() - began, health: last };
      if (watch?.exited?.done) {
        const spawnError = watch.exited.spawnError;
        if (spawnError) {
          return {
            ok: false,
            waitedMs: Date.now() - began,
            error:
              `wb2api 无法启动（${spawnError.message}）；可执行文件是 ${this.opts.exePath}，` +
              `可能是文件被删/损坏、路径不对或没有执行权限，详见 ${this.logFile}`,
            health: last,
          };
        }
        const how = watch.exited.code === null ? `信号 ${watch.exited.signal}` : `退出码 ${watch.exited.code}`;
        return {
          ok: false,
          waitedMs: Date.now() - began,
          error:
            `wb2api 进程刚启动就退出了（pid ${watch.pid}，${how}）；` +
            `常见原因是端口被占用、config.json 配置非法或被杀软拦截，详见 ${this.logFile}`,
          health: last,
        };
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    return { ok: false, waitedMs: Date.now() - began, error: `等待 ${timeoutMs}ms 仍未就绪（最后一次：${last?.error ?? `HTTP ${last?.status}`}）`, health: last };
  }

  /** 需要时确保服务在跑。 */
  async ensureService(reason) {
    const h = await this.health();
    if (h.ok) {
      await this.adoptExisting(reason);
      return { ok: true, running: true, health: h };
    }
    return this.startService(reason);
  }

  /**
   * 结束当前服务进程。taskkill /T /F 是同步生效的，因此清理钩子里"发起即完成"；
   * 后面的等待只是确认端口/进程确实消失。
   */
  async stopService(reason) {
    const pids = new Set([...this.reg.pids, ...this.listPids()]);
    let killed = 0;
    for (const pid of pids) {
      if (killTree(pid, (m) => this.log(`${m}（${reason}）`))) killed += 1;
      this.reg.pids.delete(pid);
    }
    this.child = null;
    for (let i = 0; i < 40 && this.listPids().length > 0; i += 1) await sleep(150);
    const left = this.listPids();
    if (left.length) this.log(`警告：仍有进程未结束 ${left.join(',')}`);
    return { ok: left.length === 0, killed, left };
  }

  /** 重启：先杀干净再拉起。 */
  async restartService(reason = '手动重启') {
    await this.stopService(reason);
    return this.startService(reason);
  }

  startWatchdog() {
    if (this.watchdogTimer || !this.opts.keepAlive || !this.opts.watchdogSeconds) return;
    const period = Math.max(5, Number(this.opts.watchdogSeconds)) * 1000;
    this.watchdogTimer = setInterval(() => {
      this.tick().catch((err) => this.log(`看护异常：${err.message}`));
    }, period);
    if (typeof this.watchdogTimer.unref === 'function') this.watchdogTimer.unref();
    this.log(`看护已启用：每 ${period / 1000}s 检查一次`);
  }

  stopWatchdog() {
    if (this.watchdogTimer) clearInterval(this.watchdogTimer);
    this.watchdogTimer = null;
  }

  async tick() {
    const pids = this.listPids();
    if (pids.length === 0) {
      this.reg.pids.clear();
      this.log('检测到服务已不在运行，准备拉起');
      await new Promise((r) => setTimeout(r, this.opts.restartDelayMs));
      await this.startService('看护重启');
      return;
    }
    this.rememberPids(pids, '看护发现');
    const h = await this.health();
    if (h.ok) {
      this.failStreak = 0;
      return;
    }
    this.failStreak += 1;
    this.log(`健康检查失败（第 ${this.failStreak} 次）：${h.error ?? `HTTP ${h.status}`}`);
    if (this.failStreak >= 3) {
      this.failStreak = 0;
      this.log('连续 3 次健康检查失败，重启服务');
      await this.restartService('看护重启');
    }
  }

  async status() {
    const pids = this.listPids();
    const health = await this.health();
    const pidFile = this.readPidFile();
    return {
      running: pids.length > 0,
      pids,
      health,
      pidFile,
      startedByUs: this.startedByUs,
      managed: [...this.reg.pids],
      lastEvent: this.lastEvent,
      lastError: this.lastError,
      installedAt: this.installedAt,
      logFile: this.logFile,
    };
  }

  /** 释放：停止看护、按需结束服务。注意：进程级退出钩子常驻，不在此移除。 */
  dispose({ kill = true } = {}) {
    this.stopWatchdog();
    if (kill && this.opts.killOnExit) {
      // 不 await：一次调用即可，taskkill 在第一个 await 之前已经同步发出。
      this.stopService('DSH 退出/插件卸载').catch(() => {});
    }
    return { ok: true };
  }
}
