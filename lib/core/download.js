/**
 * 从 GitHub Release 下载上游二进制并校验 sha256，然后解压。
 * 只依赖 Node 内置模块；跨平台靠系统自带的 tar（Win10 1803+ 自带 bsdtar，可解 zip 与 tar.gz）。
 */
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readdirSync, rmSync } from 'node:fs';
import { join, basename, dirname } from 'node:path';
import { assetNameFor, pickAsset, exeNameFor, detectTarget } from './platform.js';

const UA = 'dsh-wb2api';

/**
 * 解析镜像前缀：国内直连 GitHub 常常很慢，允许用户给一个加速前缀。
 * @param {string} url
 * @param {string} [mirror] 形如 https://ghfast.top/
 */
export function applyMirror(url, mirror) {
  if (!mirror) return url;
  const base = String(mirror).replace(/\/+$/, '');
  return `${base}/${url}`;
}

async function fetchWithTimeout(url, { token, timeoutMs = 120000, headers = {} } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      redirect: 'follow',
      signal: controller.signal,
      headers: {
        'user-agent': UA,
        accept: 'application/vnd.github+json',
        ...(token ? { authorization: `Bearer ${token}` } : {}),
        ...headers,
      },
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 取 Release 信息（tag + 资产列表）。
 * @param {{repo: string, tag?: string, token?: string, timeoutMs?: number}} opts
 * @returns {Promise<{tag: string, name: string, assets: Array<any>}>}
 */
export async function fetchRelease({ repo, tag = 'latest', token, timeoutMs } = {}) {
  const api =
    !tag || tag === 'latest'
      ? `https://api.github.com/repos/${repo}/releases/latest`
      : `https://api.github.com/repos/${repo}/releases/tags/${tag}`;
  const res = await fetchWithTimeout(api, { token, timeoutMs: timeoutMs ?? 30000 });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`读取 Release 失败：HTTP ${res.status} ${res.statusText} ${api}${body ? ` — ${body.slice(0, 300)}` : ''}`);
  }
  const json = await res.json();
  return { tag: json.tag_name, name: json.name ?? json.tag_name, assets: json.assets ?? [] };
}

/**
 * 下载到本地文件，边下边算 sha256。
 * @returns {Promise<{path: string, bytes: number, sha256: string}>}
 */
export async function downloadFile(url, destPath, { token, timeoutMs = 600000 } = {}) {
  const res = await fetchWithTimeout(url, { token, timeoutMs });
  if (!res.ok) throw new Error(`下载失败：HTTP ${res.status} ${res.statusText} ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  mkdirSync(dirname(destPath), { recursive: true });
  writeFileSync(destPath, buf);
  return { path: destPath, bytes: buf.length, sha256: createHash('sha256').update(buf).digest('hex') };
}

/**
 * 取 checksums.txt 并解析成 map。
 * @param {{repo: string, tag: string, token?: string, mirror?: string}} opts
 * @returns {Promise<Map<string, string>>} 文件名 -> 小写 sha256
 */
export async function fetchChecksums({ repo, tag, token, mirror } = {}) {
  const url = applyMirror(`https://github.com/${repo}/releases/download/${tag}/checksums.txt`, mirror);
  const res = await fetchWithTimeout(url, { token, timeoutMs: 30000 });
  if (!res.ok) throw new Error(`下载 checksums.txt 失败：HTTP ${res.status} ${res.statusText}`);
  return parseChecksums(await res.text());
}

/**
 * 解析 sha256sum 输出。每行形如 "<hex>  <name>"，可能带 * 前缀或路径。
 * @param {string} text
 */
export function parseChecksums(text) {
  const map = new Map();
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/);
    if (!m) continue;
    map.set(basename(m[2].trim()), m[1].toLowerCase());
  }
  return map;
}

/**
 * 解压归档。tar 在 Windows 10 1803+ / macOS / 大多数 Linux 上都可用（bsdtar/libarchive 能处理 zip）。
 * 只有在 tar 不可用时才回退到 PowerShell / unzip。
 */
export function extractArchive(archivePath, destDir, { log = () => {} } = {}) {
  mkdirSync(destDir, { recursive: true });
  const lower = archivePath.toLowerCase();
  const isZip = lower.endsWith('.zip');

  const tarArgs = isZip ? ['-xf', archivePath, '-C', destDir] : ['-xzf', archivePath, '-C', destDir];
  let r = spawnSync('tar', tarArgs, { encoding: 'utf8' });
  if (r.status === 0) return { tool: 'tar' };
  log(`tar 解压失败：${(r.stderr || r.error?.message || '').trim()}`);

  if (process.platform === 'win32' && isZip) {
    r = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`],
      { encoding: 'utf8' },
    );
    if (r.status === 0) return { tool: 'powershell' };
    throw new Error(`解压失败：tar 与 Expand-Archive 都不行 — ${(r.stderr || '').trim()}`);
  }
  if (!isZip) {
    r = spawnSync('unzip', ['-o', archivePath, '-d', destDir], { encoding: 'utf8' });
    if (r.status === 0) return { tool: 'unzip' };
  }
  throw new Error(`解压失败：${archivePath} → ${(r.stderr || r.error?.message || '').trim()}`);
}

/**
 * 在解压结果里递归找可执行文件（跳过 macOS 的 __MACOSX 噪音目录）。
 * @returns {string|null} 可执行文件绝对路径
 */
export function findExecutable(rootDir, exeName) {
  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      if (e.name === '__MACOSX' || e.name.startsWith('.')) continue;
      const full = join(dir, e.name);
      if (e.isDirectory()) stack.push(full);
      else if (e.name === exeName) return full;
    }
  }
  return null;
}

/** 目录是否为空（不存在也算空）。 */
export function isEmptyDir(dir) {
  if (!existsSync(dir)) return true;
  try {
    return readdirSync(dir).length === 0;
  } catch {
    return true;
  }
}

/**
 * 完整安装流程：取 Release → 选资产 → 下载 → 校验 sha256 → 解压 → 定位可执行文件。
 *
 * @param {object} opts
 * @param {string} opts.repo        上游仓库，形如 linguo2625469/workbuddy2api-panel
 * @param {string} [opts.tag]       'latest' 或具体 tag
 * @param {string} opts.installDir  安装目录（会被创建）
 * @param {string} [opts.token]     GitHub token（可选，用于绕过匿名限流）
 * @param {string} [opts.mirror]    下载镜像前缀
 * @param {boolean} [opts.force]    已存在时是否强制重装
 * @param {(msg: string) => void} [opts.log]
 * @returns {Promise<{exePath: string, installDir: string, tag: string, asset: string, sha256: string, extractedWith: string}>}
 */
export async function installFromRelease(opts) {
  const { repo, tag = 'latest', installDir, token, mirror, force = false, log = () => {} } = opts;
  const target = opts.target ?? detectTarget();
  if (!target.supported) throw new Error(target.reason);
  const exeName = exeNameFor(target.os);

  if (!force) {
    const existing = findExecutable(installDir, exeName);
    if (existing) {
      log(`复用已安装的可执行文件：${existing}`);
      log('（想装最新 Release 请在设置页用「重新下载安装」或工具 install 带 force: true）');
      return { exePath: existing, installDir, tag: 'existing', asset: '', sha256: '', extractedWith: 'none' };
    }
  }

  log(`读取 Release：${repo}@${tag}`);
  const release = await fetchRelease({ repo, tag, token });
  const asset = pickAsset(release.assets, release.tag, target);
  if (!asset) {
    throw new Error(
      `Release ${release.tag} 里没有 ${target.os}-${target.arch} 的资产（期望 ${assetNameFor(release.tag, target)}）；` +
        `现有资产：${release.assets.map((a) => a.name).join(', ')}`,
    );
  }

  let expected = null;
  try {
    const sums = await fetchChecksums({ repo, tag: release.tag, token, mirror });
    expected = sums.get(asset.name) ?? null;
    if (!expected) log(`checksums.txt 里没有 ${asset.name}，跳过校验`);
  } catch (err) {
    log(`拿不到 checksums.txt（${err.message}），跳过校验`);
  }

  const tmpDir = join(installDir, '.download');
  mkdirSync(tmpDir, { recursive: true });
  const archivePath = join(tmpDir, asset.name);
  const url = applyMirror(asset.browser_download_url, mirror);
  log(`下载 ${asset.name}（${asset.size ?? '?'} 字节）${mirror ? `经镜像 ${mirror}` : ''}`);
  const { sha256, bytes } = await downloadFile(url, archivePath, { token });
  log(`下载完成 ${bytes} 字节，sha256=${sha256}`);

  if (expected && expected !== sha256) {
    throw new Error(`sha256 校验失败：期望 ${expected}，实际 ${sha256}（文件 ${archivePath} 已保留供排查）`);
  }

  const { tool } = extractArchive(archivePath, installDir, { log });
  const exePath = findExecutable(installDir, exeName);
  if (!exePath) throw new Error(`解压完成但没找到 ${exeName}，请检查 ${installDir}`);
  try {
    rmSync(archivePath, { force: true });
  } catch {
    /* 留着也无妨 */
  }
  log(`安装完成：${exePath}（解压工具 ${tool}）`);
  return { exePath, installDir, tag: release.tag, asset: asset.name, sha256, extractedWith: tool };
}
