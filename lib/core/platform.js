/**
 * 平台识别：把 Node 的 platform/arch 映射成上游 Release 的资产名。
 *
 * 上游命名规则（见 https://github.com/linguo2625469/workbuddy2api-panel 的 Release）：
 *   wb2api-panel-<tag>-<os>-<arch>.zip       (windows)
 *   wb2api-panel-<tag>-<os>-<arch>.tar.gz    (darwin / linux)
 * 另有 checksums.txt 列出所有资产的 sha256。
 */

/** Node 平台名 -> 上游 os 段 */
const OS_MAP = {
  win32: 'windows',
  darwin: 'darwin',
  linux: 'linux',
};

/** Node 架构名 -> 上游 arch 段 */
const ARCH_MAP = {
  x64: 'amd64',
  arm64: 'arm64',
  // Node 在部分 32 位环境报告 ia32/arm，上游没有对应资产，直接判为不支持
};

/**
 * @param {string} [platform] 默认取 process.platform
 * @param {string} [arch] 默认取 process.arch
 * @returns {{os: string|null, arch: string|null, supported: boolean, reason?: string}}
 */
export function detectTarget(platform = process.platform, arch = process.arch) {
  const os = OS_MAP[platform] ?? null;
  const cpu = ARCH_MAP[arch] ?? null;
  if (!os) {
    return { os: null, arch: cpu, supported: false, reason: `不支持的操作系统：${platform}（上游只发布 windows/darwin/linux）` };
  }
  if (!cpu) {
    return { os, arch: null, supported: false, reason: `不支持的架构：${arch}（上游只发布 amd64/arm64）` };
  }
  return { os, arch: cpu, supported: true };
}

/**
 * 组装某个 tag 下、某平台资产的准确文件名。
 * @param {string} tag 形如 v1.12.0
 * @param {{os: string, arch: string}} target
 */
export function assetNameFor(tag, target) {
  const ext = target.os === 'windows' ? 'zip' : 'tar.gz';
  return `wb2api-panel-${tag}-${target.os}-${target.arch}.${ext}`;
}

/**
 * 可执行文件名。Windows 带 .exe，其他平台裸名。
 * @param {string} os 上游 os 段
 */
export function exeNameFor(os) {
  return os === 'windows' ? 'wb2api.exe' : 'wb2api';
}

/**
 * 从 GitHub Release 的资产列表里挑出目标平台的资产。
 * 先按准确文件名匹配；若上游改了命名（例如加了前缀/后缀），退化为按 os+arch 段模糊匹配。
 * @param {Array<{name: string, size?: number, browser_download_url: string}>} assets
 * @param {string} tag
 * @param {{os: string, arch: string}} target
 */
export function pickAsset(assets, tag, target) {
  const exact = assetNameFor(tag, target);
  const hit = assets.find((a) => a.name === exact);
  if (hit) return hit;
  const near = assets.find(
    (a) =>
      a.name.includes(target.os) &&
      a.name.includes(target.arch) &&
      (a.name.endsWith('.zip') || a.name.endsWith('.tar.gz')),
  );
  return near ?? null;
}
