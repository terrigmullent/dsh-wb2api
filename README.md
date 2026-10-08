# dsh-wb2api

把本机的 [workbuddy2api](https://github.com/linguo2625469/workbuddy2api-panel) 网关（上游 [Sliverkiss/workbuddy2api](https://github.com/Sliverkiss/workbuddy2api) 的增强分支）装进 DeepSeek Harness（DSH）一起管理：DSH 启动时自动拉起网关，掉线自动看护重启，在 DSH 的「设置 → WorkBuddy2API」里下载二进制、加账号、勾选模型。

本仓库只做**管理**：不内嵌、不修改 workbuddy2api 的代码或二进制，二进制在安装时按上游 MIT 协议从 Release 下载。

## 前置条件

- DSH 0.2.0-rc.2 或更高版本。
- Node.js >= 20（见 `package.json` 的 `engines`）。
- **DSH 所在机器必须能访问 GitHub**：首次安装要从 Release 下载约 3.4 MB 的二进制。国内直连很慢——实测这台机器约 18 KB/s、耗时 190 秒，慢的话用下面的镜像用法。

## 仓库结构

```
package.json                 插件元数据（main / icon / dsh.bundle / dsh.client）
cordis.patch.yml             bundle patch，config 段示例在顶部注释
icon.svg                     插件图标（24×24，currentColor）
LICENSE                      MIT
lib/index.js                 宿主半侧：注册 workbuddy 工具、配置解析、启动与看护
lib/client.js                客户端半侧：DSH「设置 → WorkBuddy2API」页面
lib/core/platform.js         平台识别：platform/arch → 上游资产名
lib/core/download.js         Release 查询、镜像拼接、下载、sha256 校验、解压
lib/core/workspace.js        config.json 生成与修补、api_key 生成与读取
lib/core/service.js          进程生命周期：启动、接管、健康检查、看护重启、退出清理
lib/core/wb2api.js           本地网关的 HTTP 客户端与模型档案映射
lib/core/models.js           keepModels → DSH 模型清单的纯函数计算
test/                        node --test test/ 的离线测试（真实网络测试默认跳过）
```

## 安装

推荐第二种（用 plugin_manager 装 git URL 或本地路径）。三种方式任选：

**a) 让 agent 装。** 对 DSH 说：「用 plugin_manager 装 `/path/to/dsh-wb2api`」。`install_bundle` 要传绝对路径，需要 danger-full-access 权限或当次批准。

**b) 用 plugin_manager 工具（推荐）。** `target` 写 git URL 或本地绝对路径：

```
target: https://github.com/<OWNER>/dsh-wb2api
target: C:\path\to\dsh-wb2api
```

`dsh.profile.bundles` 由 plugin-manager 维护——它把包名追加到这个有序列表里（组合包开关就是这个列表）。**不要手改 profile 的 `package.json`**（官方禁止）。用本地路径安装得到的是 `link:` 依赖 + 指向仓库目录的 Junction，所以改完代码重启 DSH 就生效，不需要重新复制。

要改插件配置，就在 profile 的 `cordis.patch.yml` 里按 id 覆盖（官方写插件开关用的也是这里）：

```yaml
- id: dsh-wb2api
  config:
    installDir: /home/you/.dsh-wb2api
    autoInstall: false
```

**按 id 覆盖会替换整个 `config` 段，不做深度合并**，所以保留的字段要写全。替换同名包、或改过 `lib/*.js` 之后**必须重启 DSH**：热重载不会重新求值已经加载的宿主模块，改文件不生效。

**c) 手动放目录（不推荐，只用于排障）。** 把仓库目录放到 `$DSH_HOME/profiles/<profile>/node_modules/dsh-wb2api`，再把包名加进 profile `package.json` 的 `dsh.profile.bundles`，然后重启 DSH。

依赖只有 Node 内置模块，不需要 `pnpm install`。

## 首次使用

1. 打开 DSH 的「设置 → WorkBuddy2API」。
2. 点「下载并安装」。插件会：从 `linguo2625469/workbuddy2api-panel` 的 latest Release 取 `checksums.txt` 与当前平台资产（windows/darwin/linux × amd64/arm64，Windows 是 `.zip`，macOS/Linux 是 `.tar.gz`）→ 下载 → 校验 sha256 → 解压 → 在解压结果里定位可执行文件。**sha256 不匹配就中止并保留原文件**（归档留在 `installDir/.download/` 供排查）。拿不到 `checksums.txt`、或里面没有当前资产时，会记一条日志并跳过校验，不中止。Windows 上 zip 用系统自带 `tar.exe`（bsdtar）解压，失败回退 PowerShell `Expand-Archive`。
3. 安装时生成 `config.json`：含一个随机生成的 43 位 `api_key`，并把上游默认的 `":7863"` 收紧为 `127.0.0.1:7863`（只监听回环，不暴露到局域网）。`auths/` 与 `data/` 目录同时建好。
4. 点「添加账号（国内/国际）」。插件调 `/panel/api/login/start` 拿到授权链接 → 你用浏览器打开并登录 → 插件轮询 `/panel/api/login/poll`，成功后账号出现在列表里。
5. 在「模型」分区勾选要保留的模型 → 保存。DSH 模型选择器里**下一个请求**生效（不需要重启）。

### 镜像用法

GitHub 直连慢时，给一个加速前缀（例如 `https://ghfast.top/`）。插件把前缀直接拼在 GitHub URL 前面（`lib/core/download.js` 的 `applyMirror`）：

```
https://ghfast.top/https://github.com/linguo2625469/workbuddy2api-panel/releases/download/<tag>/<asset>
```

三种传法，效果一样：

- 配置里写 `mirror: 'https://ghfast.top/'`（持久生效）。
- 设置页的「下载并安装」里填镜像前缀（单次）。
- agent 调 `workbuddy` 工具时带 `{"action":"install","mirror":"https://ghfast.top/"}`（单次）。

镜像只作用于 GitHub 的下载地址，不走镜像的接口（如 `api.github.com`）仍然直连。离线跑测试时可以用环境变量 `WB2API_TEST_MIRROR`。

## 配置

配置写在 profile 的 `cordis.patch.yml` 的 `config` 段（仓库里的 `cordis.patch.yml` 顶部注释有同样的示例）。全部可省略。

| 键 | 类型 | 默认值 | 说明 |
| --- | --- | --- | --- |
| `installDir` | string | `~/.dsh-wb2api` | 二进制与生成文件目录。Windows 上是 `C:\Users\<你>\.dsh-wb2api` |
| `host` | string | `127.0.0.1` | 网关监听地址，别改成 `0.0.0.0` |
| `port` | number | `7863` | 网关端口，只监听回环 |
| `mirror` | string | `''` | GitHub 下载镜像前缀，例如 `https://ghfast.top/`；空 = 直连 |
| `token` | string | `''` | 可选 GitHub token，只用来提高 Release API 的限额；属于凭据，别提交 |
| `autoStart` | boolean | `true` | DSH 启动时拉起网关 |
| `killOnExit` | boolean | `true` | DSH 退出时停掉网关 |
| `adoptExisting` | boolean | `true` | 发现端口上已有网关进程时接管它，而不是再拉一个 |
| `autoInstall` | boolean | `true` | 缺少二进制时自动下载安装 |
| `autoOpenPanelWhenEmpty` | boolean | `true` | 账号池为空时自动打开面板 |
| `watchdogSeconds` | number | `30` | 看护间隔，`0` 关闭；实际最小 `5` 秒 |
| `restartDelayMs` | number | `4000` | 重启前的静默期 |
| `startTimeoutMs` | number | `90000` | 等网关起来（健康检查通过）的上限 |
| `installTimeoutMs` | number | `600000` | 下载安装任务的超时（10 分钟） |
| `requestTimeoutMs` | number | `15000` | 面板/模型接口的 HTTP 超时 |
| `keepModels` | string[] | `[]` | 要保留的模型 id；**空数组 = 全部保留** |

还有三个进阶键，一般不用动：`settingsNs`（默认 `llm-pi-ai`，写入 DSH 模型设置时用的插件条目 id）、`providerId`（默认 `wb2api`）、`credentialRef`（默认 `WB2API_KEY`，DSH 凭据服务里存 api_key 的名字）。

完整示例（可整段照抄）：

```yaml
- insert:
    - id: dsh-wb2api
      name: 'dsh-wb2api'
      config:
        installDir: 'C:\Users\me\.dsh-wb2api'
        host: 127.0.0.1
        port: 7863
        mirror: ''                 # 国内慢就填 'https://ghfast.top/'
        autoStart: true
        killOnExit: true
        autoInstall: true          # 不想让它自己下载就设 false
        autoOpenPanelWhenEmpty: true
        adoptExisting: true
        watchdogSeconds: 30
        restartDelayMs: 4000
        startTimeoutMs: 90000
        installTimeoutMs: 600000
        keepModels:
          - 'cn:deepseek-v4.1-flash'
          - 'cn:hy3'
        requestTimeoutMs: 15000
```

模型 id 带 realm 前缀（`cn:` / `global:`，见 `lib/core/models.js`）。`keepModels` 里写了服务端没有的 id 不会静默消失，会在结果里作为 `missing` 列出来。

## 工具

装上插件后，agent 可以直接调 `workbuddy` 工具：

| action | 用途 |
| --- | --- |
| `status` | 状态总览：服务是否在跑、pid、健康检查、账号数与积分、当前保留的模型 |
| `install` | 从 GitHub Release 下载并安装上游二进制（sha256 校验）；可带 `force`、`mirror`、`version` |
| `login` | 发起添加账号流程（`realm` 取 `cn`/`global`），返回授权链接与 `state`；带 `state` 再调一次可查是否完成 |
| `models` | 列出服务端模型，★ 标记已保留；可用 `query` 按 id/名称过滤 |
| `keep` | 设置要保留的模型清单（`keep` 数组，不传或空数组 = 全部保留） |
| `start` | 启动网关并等健康检查通过 |
| `stop` | 停掉网关（会杀进程树） |
| `restart` | 重启网关 |
| `open_panel` | 在浏览器打开官方面板，`page` 取 `accounts`（默认）或 `panel` |

> 关于"空清单 = 全部保留"：agent 显式调 `keep` 传空数组时就是这个意思。设置页同理，但它会把空清单**显式**标成 `"all": true`；HTTP 接口 `POST /api/dsh-wb2api/keep` 对没带 `all` 的空清单直接返回 400——因为一次手滑的空请求就会把服务端几十个模型全写进 profile，盖掉你精挑的清单。

示例参数：

```jsonc
{ "action": "status" }
{ "action": "install" }                                              // 简单安装
{ "action": "install", "mirror": "https://ghfast.top/", "version": "v1.11.11" }
{ "action": "install", "force": true }                                // 已装也重新下载
{ "action": "login", "realm": "cn" }                                  // 国际账号用 "global"
{ "action": "login", "state": "<上一步返回的 state>" }
{ "action": "models", "query": "deepseek" }
{ "action": "keep", "keep": ["cn:deepseek-v4.1-flash"] }               // 空数组 = 全部保留
{ "action": "start" }
{ "action": "stop" }
{ "action": "restart" }
{ "action": "open_panel", "page": "panel" }
```

## 文件与日志

都在 `installDir` 下（默认 `~/.dsh-wb2api`）：

- `wb2api.exe`（Windows）/ `wb2api`（macOS、Linux）——上游二进制。插件在 `installDir` 下递归查找它，具体落在哪一层取决于上游归档结构（本地测试用的布局是 `wb2api-panel-<tag>-windows-amd64/wb2api.exe`）。
- `config.json` —— 上游配置，含 `api_key` 与 `listen`。
- `auths/` —— 账号凭据（`accessToken` 等）。**只在本机，别提交。**
- `data/state.json` —— 上游运行状态。
- `wb2api.log` —— 网关子进程的 stdout/stderr（追加写入）。
- `dsh-wb2api.log` —— 插件自身的日志（`lib/index.js` 侧写）。
- `wb2api.pid` —— pid 文件，JSON，含 `pid`、`exePath`、`startedBy`、`startedAt`。
- `.download/` —— 临时下载目录，安装成功后归档会被删掉；校验失败时保留供排查。

`lib/core/service.js` 里记录的服务事件用 ISO 8601 UTC 时间戳；`wb2api.log` 是上游自己写的，格式以上游为准。

排障顺序：健康检查失败 → 先看 `wb2api.log` 尾部有没有上游报错；进程不在 → 看 `dsh-wb2api.log` 里的拉起/看护记录；端口被占用 → 改 `port`。

## 与 DSH 生命周期

默认 `killOnExit: true`，DSH 关闭会一起停掉网关。但**网关不在跑时，上游的签到、旅行、活跃上报、保活都会停**，账号积分有效期约两周，过期作废。

想让网关在 DSH 之外常驻，二选一：

- 设 `killOnExit: false`（插件仍会接管已在运行的进程并做看护）。
- 自己写一个 `start.bat`，在 `installDir` 里直接拉起 `wb2api.exe -config config.json`，让网关独立于 DSH。

看护默认每 `watchdogSeconds` 秒探一次 `/healthz`，连续 3 次失败就重启；进程整个消失时先等 `restartDelayMs`，再重新拉起。

## 安全与合规

- 本仓库**不内嵌、不修改** workbuddy2api 的二进制。二进制按其 MIT 协议从上游 Release 分发，版权与出处属于上游作者。
- 凭据只留在本机：`config.json` 的 `api_key`、`auths/*.json` 里的 `accessToken`。不要把 `.dsh-wb2api/`、`auths/`、`config.json` 提交进 Git（`.gitignore` 已覆盖）。
- `api_key` 优先从 `config.json` 读，读不到回退环境变量 `WB2API_KEY`（`lib/core/workspace.js` 的 `readApiKey`）。插件不把密钥写进 profile 配置，正常路径是让它走 DSH 凭据服务（`ctx.credentials` 的 `WB2API_KEY`）。
- 配置里的 `token` 是 GitHub token，属于凭据，会被写进 profile 的 `cordis.patch.yml`；那个文件可能被同步或分享，别在里面填真实 token，非必要就别填。
- 面板路由只监听回环，不允许局域网访问。

## 已知限制

- 加账号**没有二维码**，只给授权链接 + 复制。
- 客户端（设置页）UI 的视觉一致性未在真机渲染验证（官方禁止截图验证）。
- 上游 Release 变更资产命名时，需要更新插件（资产名按 `wb2api-panel-<tag>-<os>-<arch>.<ext>` 组装；改了就退化为按 os+arch 模糊匹配）。
- 只支持 loopback，面板路由不对外网开放。
- 接口形状是按上游 v1.11.11 实测写的（见 `lib/core/wb2api.js` 顶部注释），上游改接口需要同步。
- 不支持 32 位平台（ia32/arm），上游只发 amd64/arm64。

## 卸载 / 回滚

- 用 plugin_manager 的 `remove_bundle` 移除。
- 或者把 profile 的 `cordis.patch.yml` 里 `- id: dsh-wb2api` 那段设 `disabled: true`，然后重启 DSH。
- 想连二进制一起清掉，删 `installDir`（默认 `~/.dsh-wb2api`）即可。账号凭据在这个目录里，删了就没了。

## English summary

`dsh-wb2api` is a DSH plugin that installs and manages a local `workbuddy2api` gateway: it downloads the upstream binary from GitHub Releases (sha256 verified), generates `config.json` with a random 43-char `api_key` bound to `127.0.0.1:7863`, starts the gateway with DSH, watchdog-restarts it, and exposes account sign-in plus a model picker in DSH Settings.

Requires DSH >= 0.2.0-rc.2 and Node >= 20, and the machine must reach GitHub. Install via `plugin_manager` (git URL or absolute local path), then restart DSH.

The repo only manages the gateway; it bundles no upstream code or binary. Credentials stay in `installDir` (`~/.dsh-wb2api` by default) and are never committed.

## License

MIT，见 `LICENSE`。上游 workbuddy2api 同样以 MIT 分发。
