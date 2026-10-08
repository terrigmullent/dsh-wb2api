/**
 * dsh-wb2api 客户端半侧：在 DSH 设置页加一个 "WorkBuddy2API" 分区。
 *
 * 四块内容：服务状态与安装进度、账号列表与扫码/链接登录、模型勾选、高级配置。
 *
 * 硬性约束（对应 DSH 客户端 bundle 协议）：
 *   - 文件本身是脚本，不是 ESM；由 window.__ModuleLoader__.load 包装，id 必须等于包名。
 *   - require 只能取冻结的 9 个平台模块；这里只用 react。
 *   - 模块体只注册 factory，任何副作用（含样式注入）都放在 factory 闭包内部，物化时才跑。
 *   - apply 与组件全程 try/catch + console.warn，绝不抛错（apply 抛错会让整个 web 壳启不来）。
 *   - fetch 路径不带前导斜杠（GUI 用 <base href="./">，根绝对路径会静默 404）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-wb2api',
  factory(require) {
    const React = require('react');
    const h = React.createElement;

    // 宿主路由（浏览器侧不带前导斜杠）
    const API = {
      status: 'api/dsh-wb2api/status',
      models: 'api/dsh-wb2api/models',
      keep: 'api/dsh-wb2api/keep',
      service: 'api/dsh-wb2api/service',
      install: 'api/dsh-wb2api/install',
      job: 'api/dsh-wb2api/job',
      loginStart: 'api/dsh-wb2api/login/start',
      loginPoll: 'api/dsh-wb2api/login/poll',
      openPanel: 'api/dsh-wb2api/open-panel',
      config: 'api/dsh-wb2api/config',
    };

    const NS = 'dsh-wb2api';
    const STYLE_ID = 'dsh-wb2api-client-style';
    const POLL_JOB_MS = 1500; // 安装进度轮询间隔
    const POLL_LOGIN_MS = 3000; // 登录轮询间隔
    const LOGIN_TIMEOUT_MS = 5 * 60 * 1000; // 登录轮询上限 5 分钟
const JOB_TIMEOUT_MS = 30 * 60 * 1000; // 安装/下载任务轮询上限 30 分钟（慢网络下 3.5 MB 也可能要几分钟）

    // ---------------------------------------------------------------- 请求

    /** 统一请求：POST 带 JSON，{ok:false,error} 与非 2xx 一律转成可读 Error。 */
    async function request(path, options) {
      const opts = options || {};
      const init = { method: opts.method || 'GET' };
      if (opts.body !== undefined) {
        init.headers = { 'content-type': 'application/json' };
        init.body = JSON.stringify(opts.body);
      }
      let response;
      try {
        response = await fetch(path, init);
      } catch (error) {
        // 只抛出底层原因，前缀由调用方按当前语言补（见 createController 的 tr 与 errorPrefix）
        throw new Error(String((error && error.message) || error));
      }
      let body;
      try {
        body = await response.json();
      } catch {
        body = undefined;
      }
      if (body && body.ok === false && typeof body.error === 'string') {
        throw new Error(body.error);
      }
      if (!response.ok) {
        throw new Error('HTTP ' + response.status + (body && body.error ? '：' + body.error : ''));
      }
      return body;
    }

    // ---------------------------------------------------------------- 文案
    //
    // 注意：key 必须是**带点号的扁平字面量**（'service.title'），不能写成嵌套对象
    // （service: { title: … }）。DSH 的 locale 运行时按 key 原文在字典里平查，
    // 查不到就把 key 本身当文案显示 —— 写成嵌套会让页面满屏 "service.title"。
    // 每个 key 都必须 zh/en 双全；test/client.test.mjs 会核对 t() 用到的每个字面 key。

    const zh = {
      'title': 'WorkBuddy2API',
      'subtitle': '本地 workbuddy2api 网关：服务、账号与模型清单都在这里管理。',

      'action.refresh': '刷新',
      'action.retry': '重试',
      'action.expand': '展开',
      'action.collapse': '收起',
      'action.cancel': '取消',
      'action.close': '关闭',
      'action.copy': '复制链接',
      'action.copied': '已复制',

      'service.title': '服务',
      'service.installed': '已安装',
      'service.notInstalled': '未安装',
      'service.running': '运行中',
      'service.stopped': '未运行',
      'service.healthy': '健康',
      'service.unhealthy': '异常',
      'service.unknown': '未知',
      'service.version': '版本',
      'service.pid': '进程号',
      'service.uptime': '已运行',
      'service.baseURL': '服务地址',
      'service.exeVersion': '服务自报版本',
      'service.installDir': '安装目录',
      'service.notInstalledHint': '尚未安装 workbuddy2api，点下面的按钮自动下载并安装。',
      'service.downloadAndInstall': '下载并安装',
      'service.installForce': '强制重装（忽略已有文件与校验缓存）',
      'service.installMirror': '下载镜像（留空使用默认源）',
      'service.installMirrorPlaceholder': '例如 https://ghproxy.example/',
      'service.installVersion': '指定版本（留空安装最新）',
      'service.installVersionPlaceholder': '例如 v1.11.11',
      'service.installProgress': '安装进度',
      'service.jobMessage': '当前步骤',
      'service.jobLog': '最近日志',
      'service.jobDone': '安装完成',
      'service.jobError': '安装失败',
      'service.jobTimeout': '安装任务超时（超过 30 分钟仍未完成）：可以重新开始，或到安装目录看 wb2api.log / dsh-wb2api.log。',
      'service.start': '启动',
      'service.stop': '停止',
      'service.restart': '重启',
      'service.openPanel': '打开官方面板',
      'service.installedAt': '安装位置',

      'accounts.title': '账号',
      'accounts.empty': '还没有账号，点上面的按钮添加一个。',
      'accounts.addCN': '添加账号（国内）',
      'accounts.addGlobal': '添加账号（国际）',
      'accounts.loginHint': '在国内/国际区域打开的授权链接：在浏览器打开链接完成登录，页面会自动检测结果。',
      'accounts.loginWaiting': '等待浏览器完成授权…',
      'accounts.loginDone': '账号 {nickname} 添加成功。',
      'accounts.loginTimeout': '登录超时（超过 5 分钟未完成），请重新点击添加账号。',
      'accounts.loginNoUrl': '服务没有返回授权链接，请稍后重试，或点「打开官方面板」在浏览器里添加账号。',
      'accounts.loginPollBadResponse': '登录状态查询返回了空响应，已停止等待。',
      'accounts.loginFailed': '添加账号失败',
      'accounts.copyOk': '授权链接已复制到剪贴板。',
      'accounts.copyFailed': '自动复制失败，请手动选中链接复制。',

      'accounts.col.uid': 'UID',
      'accounts.col.nickname': '昵称',
      'accounts.col.realm': '区域',
      'accounts.col.credits': '积分',
      'accounts.col.expiry': '到期时间',
      'accounts.col.disabled': '状态',
      'accounts.col.requests': '请求数',
      'accounts.col.tokens': '累计 tokens',

      'accounts.realmCN': '国内',
      'accounts.realmGlobal': '国际',
      'accounts.enabled': '正常',
      'accounts.disabledTag': '已禁用',
      'usage.title': '用量',
      'usage.empty': '还没有用量统计（网关还没处理过请求）。',
      'usage.col.account': '账号',
      'usage.col.requests': '请求数',
      'usage.col.success': '成功',
      'usage.col.tokens': '累计 tokens',
      'usage.col.split': '输入 / 输出',
      'usage.col.average': '每次平均',
      'usage.col.latency': '最近延迟',
      'usage.col.speed': '最近速度',
      'usage.col.lastUsed': '最近使用',
      'usage.ratesTitle': '按模型的费率样本（积分 / 1k tokens，样本越多越准）',
      'usage.col.model': '模型',
      'usage.col.rate': '费率',
      'usage.col.samples': '样本',
      'usage.col.accounts': '账号数',
      'usage.col.lastSeen': '最近出现',
      'usage.note': '数字来自网关自己的统计（state.json），重启网关不会清零；tokens 是输入与输出之和。',
      'usage.totals': '合计',

      'models.title': '模型',
      'models.searchPlaceholder': '搜索模型 id 或名称',
      'models.realmAll': '全部区域',
      'models.realmCN': '国内',
      'models.realmGlobal': '国际',
      'models.count': '共 {count} 个模型',
      'models.countKept': '共 {count} 个模型，已保留 {kept} 个',
      'models.keepAllHint': '清单为空即「全部保留」：保存后会把服务端当前所有模型都写进设置。',
      'models.selectAll': '全选',
      'models.clear': '全部保留',
      'models.save': '保存',
      'models.saved': '已保留 {count} 个模型，DSH 的下一个请求生效。',
      'models.saveFailed': '保存模型清单失败',
      'models.empty': '没有符合条件、或者服务当前提供不了模型。',
      'models.noneSelected': '一个模型都没勾选：空清单等于「全部保留」，请至少勾选一个，或直接点「全部保留」。',
      'models.metaImage': '图片',
      'models.metaReasoning': '推理',
      'models.kept': '已保留',
      'models.refreshList': '从服务重新拉取',

      'advanced.title': '高级',
      'advanced.desc': 'config.json 编辑（写入 wb2api 自己的配置文件）。',
      'advanced.server': '服务地址',
      'advanced.serverHint': '监听地址由插件配置决定；要换端口请改插件配置里的 host/port 再重启 DSH。',
      'advanced.serverPlaceholder': '127.0.0.1:7863',
      'advanced.apiKey': '管理密钥 apiKey',
      'advanced.apiKeyPlaceholder': '留空表示保留原值',
      'advanced.save': '保存配置',
      'advanced.saved': '配置已保存，重启服务后生效。',
      'advanced.saveFailed': '保存配置失败',
      'advanced.paths': '路径',

      'error.loadFailed': '加载状态失败',
      'error.serviceActionFailed': '服务操作失败',
      'error.installFailed': '安装失败',
      'error.openPanelFailed': '打开官方面板失败',
      'error.openPanelNoUrl': '服务没有返回面板地址。',
      'error.loginStartFailed': '发起登录失败',
      'error.sectionFailed': '这一块渲染失败，请查看浏览器控制台。',
      'error.pageFailed': 'WorkBuddy2API 面板渲染失败，详情见浏览器控制台。',

      'common.yes': '是',
      'common.no': '否',
      'common.none': '—',
      'common.unknown': '未知',
      'common.refreshHint': '数据来自本地服务，若刚做过改动可点「刷新」。',

    };

    const en = {
      'title': 'WorkBuddy2API',
      'subtitle': 'Local workbuddy2api gateway: service, accounts and model list in one place.',

      'action.refresh': 'Refresh',
      'action.retry': 'Retry',
      'action.expand': 'Expand',
      'action.collapse': 'Collapse',
      'action.cancel': 'Cancel',
      'action.close': 'Close',
      'action.copy': 'Copy link',
      'action.copied': 'Copied',

      'service.title': 'Service',
      'service.installed': 'Installed',
      'service.notInstalled': 'Not installed',
      'service.running': 'Running',
      'service.stopped': 'Stopped',
      'service.healthy': 'Healthy',
      'service.unhealthy': 'Unhealthy',
      'service.unknown': 'Unknown',
      'service.version': 'Version',
      'service.pid': 'PID',
      'service.uptime': 'Uptime',
      'service.baseURL': 'Endpoint',
      'service.exeVersion': 'Reported version',
      'service.installDir': 'Install directory',
      'service.notInstalledHint': 'workbuddy2api is not installed yet. Use the button below to download and install it.',
      'service.downloadAndInstall': 'Download and install',
      'service.installForce': 'Force reinstall (ignore existing files and checksum cache)',
      'service.installMirror': 'Download mirror (empty = default)',
      'service.installMirrorPlaceholder': 'e.g. https://ghproxy.example/',
      'service.installVersion': 'Version (empty = latest)',
      'service.installVersionPlaceholder': 'e.g. v1.11.11',
      'service.installProgress': 'Install progress',
      'service.jobMessage': 'Current step',
      'service.jobLog': 'Recent log',
      'service.jobDone': 'Install finished',
      'service.jobError': 'Install failed',
      'service.jobTimeout': 'The install job timed out (nothing after 30 minutes). Start it again, or check wb2api.log / dsh-wb2api.log in the install directory.',
      'service.start': 'Start',
      'service.stop': 'Stop',
      'service.restart': 'Restart',
      'service.openPanel': 'Open official panel',
      'service.installedAt': 'Location',

      'accounts.title': 'Accounts',
      'accounts.empty': 'No accounts yet. Add one with the buttons above.',
      'accounts.addCN': 'Add account (China)',
      'accounts.addGlobal': 'Add account (Global)',
      'accounts.loginHint': 'Open the authorization link in your browser to finish signing in; this page detects the result automatically.',
      'accounts.loginWaiting': 'Waiting for the browser to finish authorization…',
      'accounts.loginDone': 'Account {nickname} was added.',
      'accounts.loginTimeout': 'Sign-in timed out (over 5 minutes). Please start over.',
      'accounts.loginNoUrl': 'The service did not return an authorization link. Try again, or use "Open official panel" to add the account in your browser.',
      'accounts.loginPollBadResponse': 'The sign-in poll returned an empty response, so waiting stopped.',
      'accounts.loginFailed': 'Failed to add account',
      'accounts.copyOk': 'Authorization link copied to the clipboard.',
      'accounts.copyFailed': 'Copy failed. Please select the link and copy it manually.',

      'accounts.col.uid': 'UID',
      'accounts.col.nickname': 'Nickname',
      'accounts.col.realm': 'Realm',
      'accounts.col.credits': 'Credits',
      'accounts.col.expiry': 'Expires',
      'accounts.col.disabled': 'State',
      'accounts.col.requests': 'Requests',
      'accounts.col.tokens': 'Tokens',

      'accounts.realmCN': 'China',
      'accounts.realmGlobal': 'Global',
      'accounts.enabled': 'Active',
      'accounts.disabledTag': 'Disabled',
      'usage.title': 'Usage',
      'usage.empty': 'No usage statistics yet (the gateway has not served a request).',
      'usage.col.account': 'Account',
      'usage.col.requests': 'Requests',
      'usage.col.success': 'Succeeded',
      'usage.col.tokens': 'Total tokens',
      'usage.col.split': 'Prompt / completion',
      'usage.col.average': 'Avg per request',
      'usage.col.latency': 'Last latency',
      'usage.col.speed': 'Last speed',
      'usage.col.lastUsed': 'Last used',
      'usage.ratesTitle': 'Per-model rate samples (credits per 1k tokens; more samples, better estimate)',
      'usage.col.model': 'Model',
      'usage.col.rate': 'Rate',
      'usage.col.samples': 'Samples',
      'usage.col.accounts': 'Accounts',
      'usage.col.lastSeen': 'Last seen',
      'usage.note': 'Numbers come from the gateway own counters (state.json) and survive gateway restarts; tokens are prompt plus completion.',
      'usage.totals': 'Total',

      'models.title': 'Models',
      'models.searchPlaceholder': 'Search model id or name',
      'models.realmAll': 'All realms',
      'models.realmCN': 'China',
      'models.realmGlobal': 'Global',
      'models.count': '{count} models',
      'models.countKept': '{count} models, {kept} kept',
      'models.keepAllHint': 'An empty list means "keep everything": saving writes every model the service offers.',
      'models.selectAll': 'Select all',
      'models.clear': 'Keep all',
      'models.save': 'Save',
      'models.saved': 'Kept {count} models. Takes effect on the next DSH request.',
      'models.saveFailed': 'Failed to save the model list',
      'models.empty': 'No models match the filters, or the service does not offer any yet.',
      'models.noneSelected': 'Nothing is checked, and an empty list means "keep everything". Check at least one model, or use "Keep all".',
      'models.metaImage': 'image',
      'models.metaReasoning': 'reasoning',
      'models.kept': 'Kept',
      'models.refreshList': 'Reload from service',

      'advanced.title': 'Advanced',
      'advanced.desc': 'Edit config.json (written to wb2api\'s own configuration file).',
      'advanced.server': 'Endpoint',
      'advanced.serverHint': 'The endpoint is fixed by the plugin config; change host/port there and restart DSH to move it.',
      'advanced.serverPlaceholder': '127.0.0.1:7863',
      'advanced.apiKey': 'Admin apiKey',
      'advanced.apiKeyPlaceholder': 'Empty keeps the current value',
      'advanced.save': 'Save config',
      'advanced.saved': 'Configuration saved. Restart the service to apply.',
      'advanced.saveFailed': 'Failed to save configuration',
      'advanced.paths': 'Paths',

      'error.loadFailed': 'Failed to load status',
      'error.serviceActionFailed': 'Service action failed',
      'error.installFailed': 'Install failed',
      'error.openPanelFailed': 'Failed to open the official panel',
      'error.openPanelNoUrl': 'The service did not return a panel URL.',
      'error.loginStartFailed': 'Failed to start sign-in',
      'error.sectionFailed': 'This section failed to render. Check the browser console.',
      'error.pageFailed': 'The WorkBuddy2API panel failed to render. See the browser console.',

      'common.yes': 'Yes',
      'common.no': 'No',
      'common.none': '—',
      'common.unknown': 'Unknown',
      'common.refreshHint': 'Data comes from the local service; hit Refresh after changes.',

    };

    // ---------------------------------------------------------------- 工具

    /** 把字节数说成人话。 */
    function formatUptime(sec) {
      if (!Number.isFinite(sec) || sec < 0) return null;
      const total = Math.floor(sec);
      const d = Math.floor(total / 86400);
      const hrs = Math.floor((total % 86400) / 3600);
      const mins = Math.floor((total % 3600) / 60);
      const secs = total % 60;
      if (d > 0) return d + 'd ' + hrs + 'h';
      if (hrs > 0) return hrs + 'h ' + mins + 'm';
      if (mins > 0) return mins + 'm ' + secs + 's';
      return secs + 's';
    }

    /** 到期时间只保留日期部分，避免长串 ISO 把表格撑开。 */
    function shortTime(value) {
      const text = String(value == null ? '' : value);
      if (!text) return '';
      const match = /^(\d{4}-\d{2}-\d{2})/.exec(text);
      return match ? match[1] : text;
    }

    /** 模型 id 的 realm 前缀（与宿主侧 realmOf 同规则）。 */
    function realmOf(id) {
      const text = String(id == null ? '' : id);
      const index = text.indexOf(':');
      return index > 0 ? text.slice(0, index) : null;
    }

    /** 整数加千分位；不是有限数就返回 null。 */
    function formatInt(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return Math.round(n).toLocaleString('en-US');
    }

    /** 大数字紧凑显示：197831916 → 197.8M。 */
    function formatCompact(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      if (Math.abs(n) >= 1e9) return (n / 1e9).toFixed(1) + 'B';
      if (Math.abs(n) >= 1e6) return (n / 1e6).toFixed(1) + 'M';
      if (Math.abs(n) >= 1e3) return (n / 1e3).toFixed(1) + 'K';
      return String(Math.round(n));
    }

    /** 毫秒 → 1.2s / 340ms。 */
    function formatMs(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return null;
      return n >= 1000 ? (n / 1000).toFixed(1) + 's' : Math.round(n) + 'ms';
    }

    /** ISO 时间 → 本地「今天 14:31」这种短串，表格里不撑行。 */
    function shortDateTime(value) {
      const text = String(value == null ? '' : value);
      if (!text) return '';
      const date = new Date(text);
      if (Number.isNaN(date.getTime()) || date.getFullYear() < 2000) return '';
      const pad = (n) => String(n).padStart(2, '0');
      const hm = pad(date.getHours()) + ':' + pad(date.getMinutes());
      const now = new Date();
      const sameDay =
        date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
      return sameDay ? hm : date.getMonth() + 1 + '/' + date.getDate() + ' ' + hm;
    }

    /** 安装进度：0..100 或 null。 */
    function progressPercent(value) {
      if (!Number.isFinite(value)) return null;
      const pct = value <= 1 ? value * 100 : value;
      return Math.max(0, Math.min(100, Math.round(pct)));
    }

    // ---------------------------------------------------------------- 样式

    const CSS = [
      '.wb2-root{display:flex;flex-direction:column;gap:12px;padding:2px 0 8px;color:var(--dsw-alias-label-primary);font-family:var(--dsw-font-family);font-size:var(--dsw-font-s-14-font-size)}',
      '.wb2-head{display:flex;flex-direction:column;gap:4px}',
      '.wb2-title{margin:0;font-size:var(--dsw-font-m-18-font-size);font-weight:600}',
      '.wb2-subtitle{margin:0;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13-font-size)}',
      '.wb2-section{background:var(--dsw-alias-settings-card-fill);border:1px solid var(--dsw-alias-settings-card-stroke);border-radius:var(--dsw-radius-lg);overflow:hidden}',
      '.wb2-sectionHead{display:flex;flex-direction:row;align-items:center;gap:8px;width:100%;background:transparent;border:none;padding:10px 14px;color:var(--dsw-alias-label-primary);font:inherit;font-weight:600;cursor:pointer;text-align:left}',
      '.wb2-sectionHead:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.wb2-sectionHead:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}',
      '.wb2-chevron{display:inline-block;width:12px;color:var(--dsw-alias-label-tertiary);transition:transform .15s ease}',
      '.wb2-chevron[data-open="1"]{transform:rotate(90deg)}',
      '.wb2-sectionBody{display:flex;flex-direction:column;gap:10px;padding:12px 14px 14px;border-top:1px solid var(--dsw-alias-border-l1)}',
      '.wb2-row{display:flex;flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}',
      '.wb2-spacer{flex:1}',
      '.wb2-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(190px,1fr));gap:6px 16px}',
      '.wb2-field{display:flex;flex-direction:column;gap:2px;min-width:0}',
      '.wb2-fieldLabel{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size)}',
      '.wb2-fieldValue{color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xs-13-font-size);word-break:break-all}',
      '.wb2-mono{font-family:var(--dsw-font-markdown-code-font-family)}',
      '.wb2-badge{display:inline-flex;align-items:center;gap:4px;padding:1px 8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-xl);font-size:var(--dsw-font-xxxs-11-font-size);color:var(--dsw-alias-label-secondary)}',
      '.wb2-badge[data-state="ok"]{color:var(--dsw-alias-state-success-primary);border-color:currentColor}',
      '.wb2-badge[data-state="warn"]{color:var(--dsw-alias-state-warn-primary);border-color:currentColor}',
      '.wb2-badge[data-state="err"]{color:var(--dsw-alias-state-error-primary);border-color:currentColor}',
      '.wb2-badge[data-state="off"]{color:var(--dsw-alias-label-tertiary)}',
      '.wb2-dot{width:6px;height:6px;border-radius:50%;background:currentColor}',
      '.wb2-btn{appearance:none;border:1px solid var(--dsw-alias-border-l2);background:transparent;color:var(--dsw-alias-label-primary);border-radius:var(--dsw-radius-md);padding:4px 10px;font:inherit;font-size:var(--dsw-font-xs-13-font-size);cursor:pointer}',
      '.wb2-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover)}',
      '.wb2-btn:disabled{color:var(--dsw-alias-label-tertiary);cursor:not-allowed}',
      '.wb2-btn:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}',
      '.wb2-btn[data-variant="primary"]{background:var(--dsw-alias-button-primary-fill);border-color:transparent;color:var(--dsw-alias-label-primary-foreground)}',
      '.wb2-btn[data-variant="primary"]:hover:not(:disabled){background:var(--dsw-alias-button-primary-hover)}',
      '.wb2-btn[data-variant="danger"]{color:var(--dsw-alias-state-error-primary);border-color:var(--dsw-alias-border-l2)}',
      '.wb2-btn[data-small="1"]{padding:2px 8px;font-size:var(--dsw-font-xxxs-11-font-size)}',
      '.wb2-input,.wb2-select{background:var(--dsw-specific-input-major);border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:5px 8px;color:var(--dsw-alias-label-primary);font:inherit;font-size:var(--dsw-font-xs-13-font-size);min-width:0}',
      '.wb2-input::placeholder{color:var(--dsw-alias-label-tertiary)}',
      '.wb2-input:focus,.wb2-select:focus{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-1px}',
      '.wb2-input[data-grow="1"]{flex:1 1 200px}',
      '.wb2-form{display:flex;flex-direction:row;align-items:center;gap:8px;flex-wrap:wrap}',
      '.wb2-formLabel{color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xs-13-font-size);width:132px;flex:none}',
      '.wb2-notice{display:flex;align-items:flex-start;gap:8px;border:1px solid var(--dsw-alias-border-l2);border-radius:var(--dsw-radius-md);padding:8px 10px;font-size:var(--dsw-font-xs-13-font-size);color:var(--dsw-alias-label-secondary)}',
      '.wb2-notice[data-tone="error"]{color:var(--dsw-alias-state-error-primary)}',
      '.wb2-notice[data-tone="success"]{color:var(--dsw-alias-state-success-primary)}',
      '.wb2-notice[data-tone="warn"]{color:var(--dsw-alias-state-warn-primary)}',
      '.wb2-noticeText{flex:1;min-width:0;word-break:break-word;white-space:pre-wrap}',
      '.wb2-link{color:var(--dsw-alias-brand-primary);word-break:break-all}',
      '.wb2-linkBox{display:flex;flex-direction:column;gap:6px;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);padding:8px 10px;background:var(--dsw-alias-bg-layer-2)}',
      '.wb2-table{width:100%;border-collapse:collapse;font-size:var(--dsw-font-xs-13-font-size)}',
      '.wb2-table th{color:var(--dsw-alias-label-tertiary);font-weight:500;text-align:left;padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);white-space:nowrap}',
      '.wb2-table td{color:var(--dsw-alias-label-primary);padding:5px 8px;border-bottom:1px solid var(--dsw-alias-border-l1);vertical-align:top}',
      '.wb2-table tr:last-child td{border-bottom:none}',
      '.wb2-table tfoot td{font-weight:500;border-top:1px solid var(--dsw-alias-border-l1);border-bottom:none}',
      '.wb2-tableWrap{overflow-x:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md)}',
      '.wb2-modelList{display:flex;flex-direction:column;max-height:340px;overflow-y:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2)}',
      '.wb2-modelRow{display:flex;flex-direction:row;align-items:flex-start;gap:8px;padding:6px 10px;cursor:pointer}',
      '.wb2-modelRow:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.wb2-modelMain{display:flex;flex-direction:column;gap:1px;min-width:0}',
      '.wb2-modelId{color:var(--dsw-alias-label-primary);font-size:var(--dsw-font-xs-13-font-size);word-break:break-all}',
      '.wb2-modelMeta{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size);word-break:break-word}',
      '.wb2-checkbox{flex:none;margin:2px 0 0}',
      '.wb2-progress{height:6px;border-radius:var(--dsw-radius-xl);background:var(--dsw-alias-bg-layer-3);overflow:hidden}',
      '.wb2-progressBar{height:100%;background:var(--dsw-alias-brand-primary);transition:width .2s ease}',
      '.wb2-log{margin:0;max-height:160px;overflow:auto;border:1px solid var(--dsw-alias-border-l1);border-radius:var(--dsw-radius-md);background:var(--dsw-alias-bg-layer-2);padding:8px 10px;color:var(--dsw-alias-label-secondary);font-size:var(--dsw-font-xxxs-11-font-size);white-space:pre-wrap;word-break:break-all}',
      '.wb2-empty{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xs-13-font-size);padding:4px 0}',
      '.wb2-sectionTitle{font-weight:600}',
      '.wb2-count{color:var(--dsw-alias-label-tertiary);font-size:var(--dsw-font-xxxs-11-font-size)}',
      '.wb2-sr{position:absolute;width:1px;height:1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap}',
    ].join('\n');

    /** 幂等注入样式：只在 factory 闭包内执行一次，不碰 document.body。 */
    function ensureStyle() {
      try {
        if (typeof document === 'undefined' || !document.head) return;
        if (document.getElementById(STYLE_ID)) return;
        const tag = document.createElement('style');
        tag.id = STYLE_ID;
        tag.dataset.plugin = NS;
        tag.textContent = CSS;
        document.head.appendChild(tag);
      } catch (error) {
        console.warn('[wb2api] style injection failed:', error);
      }
    }

    // ---------------------------------------------------------------- 选项组件

    const EMPTY_ARRAY = [];

    /** 单选/多选组，仅用主题 token 上色。 */
    function Segmented(props) {
      const options = props.options || EMPTY_ARRAY;
      return h(
        'div',
        { className: 'wb2-row', role: 'group', 'aria-label': props.label || undefined },
        options.map((opt) =>
          h(
            'button',
            {
              key: opt.value,
              type: 'button',
              className: 'wb2-btn',
              'data-variant': opt.value === props.value ? 'primary' : undefined,
              'aria-pressed': opt.value === props.value,
              onClick: () => {
                try {
                  props.onChange(opt.value);
                } catch (error) {
                  console.warn('[wb2api] segmented change failed:', error);
                }
              },
            },
            opt.label,
          ),
        ),
      );
    }

    /** 可折叠分区。 */
    function Collapsible(props) {
      const openState = React.useState(props.defaultOpen !== false);
      const open = openState[0];
      const setOpen = openState[1];
      const toggle = () => {
        try {
          setOpen(!open);
        } catch (error) {
          console.warn('[wb2api] collapse toggle failed:', error);
        }
      };
      return h(
        'section',
        { className: 'wb2-section' },
        h(
          'button',
          {
            type: 'button',
            className: 'wb2-sectionHead',
            'aria-expanded': open,
            onClick: toggle,
          },
          h('span', { className: 'wb2-chevron', 'data-open': open ? '1' : '0', 'aria-hidden': true }, '\u25B6'),
          h('span', { className: 'wb2-sectionTitle' }, props.title),
          props.summary ? h('span', { className: 'wb2-count' }, props.summary) : null,
          h('span', { className: 'wb2-spacer' }),
          props.actions ? h('span', { onClick: (event) => event.stopPropagation() }, props.actions) : null,
        ),
        open ? h('div', { className: 'wb2-sectionBody' }, props.children) : null,
      );
    }

    /** 一行「标签 : 值」。 */
    function Field(props) {
      if (props.value == null || props.value === '') return null;
      return h(
        'div',
        { className: 'wb2-field' },
        h('span', { className: 'wb2-fieldLabel' }, props.label),
        h('span', { className: 'wb2-fieldValue' + (props.mono ? ' wb2-mono' : '') }, String(props.value)),
      );
    }

    /** 提示条：错误/成功/普通信息都用它，保证失败一定可见。 */
    function Notice(props) {
      if (!props.text) return null;
      return h(
        'div',
        { className: 'wb2-notice', 'data-tone': props.tone || 'info', role: props.tone === 'error' ? 'alert' : 'status' },
        h('span', { className: 'wb2-noticeText' }, String(props.text)),
        props.onClose
          ? h(
              'button',
              { type: 'button', className: 'wb2-btn', 'data-small': '1', onClick: props.onClose, 'aria-label': props.closeLabel || 'close' },
              '\u00D7',
            )
          : null,
      );
    }

    function Badge(props) {
      return h(
        'span',
        { className: 'wb2-badge', 'data-state': props.state || undefined },
        h('span', { className: 'wb2-dot', 'aria-hidden': true }),
        props.text,
      );
    }

    function Button(props) {
      return h(
        'button',
        {
          type: 'button',
          className: 'wb2-btn',
          'data-variant': props.variant,
          'data-small': props.small ? '1' : undefined,
          disabled: Boolean(props.disabled),
          title: props.title || undefined,
          onClick: (event) => {
            try {
              props.onClick(event);
            } catch (error) {
              console.warn('[wb2api] button handler failed:', error);
            }
          },
        },
        props.children,
      );
    }

    // ---------------------------------------------------------------- 控制器

    /**
     * 页面状态。getSnapshot 返回引用稳定的快照对象，subscribe 返回 unsubscribe，
     * 组件用 useSyncExternalStore 读，避免绕过 React 的重渲染。
     */
    function createController(api, t) {
      const listeners = new Set();
      let busy = new Set();
      let state = {
        status: null,
        models: EMPTY_ARRAY,
        keepSaved: EMPTY_ARRAY,
        loading: false,
        loaded: false,
        busy: Object.freeze(EMPTY_ARRAY),
        error: null,
        notice: null,
        job: null,
        login: null,
        lastUpdated: 0,
      };
      // 易失的定时器句柄放闭包，不进快照
      let jobTimer = null;
      let loginTimer = null;
      // 轮询"世代号"：取消/卸载/重新开始都会自增，await 回来发现世代号变了就不再排下一轮，
      // 否则取消之后轮询还会继续跑（最长 5/30 分钟），卸载后也不会停。
      let jobGen = 0;
      let loginGen = 0;
      // refresh 的请求序号与在飞计数：先发的响应后到不能覆盖新数据；
      // 并发的 refresh 里第一个结束也不能提前解锁按钮（busy 是集合，不是计数）。
      let loadSeq = 0;
      let loadInFlight = 0;

      function emit() {
        for (const listener of Array.from(listeners)) {
          try {
            listener();
          } catch (error) {
            console.warn('[wb2api] listener failed:', error);
          }
        }
      }

      function set(patch) {
        state = Object.assign({}, state, patch);
        emit();
      }

      function setBusy(key, on) {
        const next = new Set(busy);
        if (on) next.add(key);
        else next.delete(key);
        busy = next;
        set({ busy: Object.freeze(Array.from(next)) });
      }

      function toMessage(error) {
        return String((error && error.message) || error || 'unknown error');
      }

      /** 取译文（控制器不在 React 渲染里，拿不到 props.t，所以由 apply 注入）。
       *  这是全文件唯一一处非字面 key 的取词入口：内部用别名 translate 调用，
       *  好让 test/client.test.mjs 的"t() 只许传字符串字面量"守卫保持有效。
       *  翻译失败时退回 key，绝不因为文案问题让一次操作失败。 */
      function tr(key, params) {
        try {
          const translate = typeof t === 'function' ? t : null;
          return translate ? translate(key, params) : key;
        } catch (error) {
          console.warn('[wb2api] translate failed:', error);
          return key;
        }
      }

      function stopJobPoll() {
        jobGen += 1; // 让 in-flight 的那次轮询作废
        if (jobTimer !== null) {
          clearTimeout(jobTimer);
          jobTimer = null;
        }
      }

      function stopLoginPoll() {
        loginGen += 1;
        if (loginTimer !== null) {
          clearTimeout(loginTimer);
          loginTimer = null;
        }
      }

      async function refresh(options) {
        const opts = options || {};
        const seq = ++loadSeq;
        loadInFlight += 1;
        setBusy('load', true);
        if (!opts.silent) set({ error: null });
        try {
          const [status, modelList] = await Promise.all([
            api.status(),
            api.models(opts.refreshModels ? '1' : '').catch((error) => {
              // 模型拉取失败不该让整个页面空白，但错误要可见（宿主把它写在 accountError 里）
              console.warn('[wb2api] models fetch failed:', error);
              return null;
            }),
          ]);
          if (seq !== loadSeq) return; // 有更新的请求在跑，丢弃这份陈旧结果
          const keep = Array.isArray(status && status.models && status.models.keep) ? status.models.keep : EMPTY_ARRAY;
          // 宿主把"账号或模型列举失败"写在顶层 accountError：以前客户端不看它，
          // 结果服务没起来时页面只显示"还没有账号"，用户以为是真没账号。
          const accountError = status && status.accountError ? String(status.accountError) : null;
          set({
            status: status,
            models: modelList && Array.isArray(modelList.models) ? modelList.models : state.models,
            keepSaved: keep,
            loaded: true,
            error: accountError ? tr('error.loadFailed') + '：' + accountError : opts.silent ? state.error : null,
          });
        } catch (error) {
          if (seq !== loadSeq) return;
          set({ error: tr('error.loadFailed') + '：' + toMessage(error) });
        } finally {
          loadInFlight -= 1;
          if (loadInFlight <= 0) setBusy('load', false);
          set({ lastUpdated: Date.now() });
        }
      }

      /** 所有会改服务状态的操作都走这里：busy 标记 + 错误可见。 */
      async function run(key, fn, options) {
        const opts = options || {};
        setBusy(key, true);
        if (!opts.keepNotice) set({ notice: null });
        try {
          const result = await fn();
          if (opts.successMessage) set({ notice: { tone: 'success', text: opts.successMessage } });
          return result;
        } catch (error) {
          const text = toMessage(error);
          if (opts.errorPrefix) set({ error: opts.errorPrefix + '：' + text });
          else set({ notice: { tone: 'error', text: text } });
          return undefined;
        } finally {
          setBusy(key, false);
        }
      }

      // ---- 服务

      async function serviceAction(action) {
        await run(
          'service',
          async () => {
            await api.service(action);
            await refresh({ silent: true });
          },
          { errorPrefix: tr('error.serviceActionFailed') },
        );
      }

      function stopJob() {
        stopJobPoll();
        set({ job: null });
      }

      /** 安装：立刻返回 jobId，然后按 1.5s 轮询，直到 done/error/超时。 */
      async function install(opts) {
        stopJobPoll(); // 顺带自增世代号，取消掉上一次的轮询
        const gen = jobGen;
        const startedAt = Date.now();
        const started = await run('install', () => api.install(opts), { errorPrefix: tr('error.installFailed') });
        if (gen !== jobGen) return; // 等待期间被取消/重开/卸载了
        if (!started || !started.jobId) return;
        set({ job: { id: started.jobId, state: 'running', message: '', progress: null, log: [], error: null } });
        const tick = async () => {
          if (gen !== jobGen) return;
          try {
            const body = await api.job(started.jobId);
            if (gen !== jobGen) return; // await 期间被取消/卸载：绝不能再排下一轮
            const job = body && body.job ? body.job : null;
            if (!job) {
              set({ job: { id: started.jobId, state: 'error', message: '', progress: null, log: [], error: 'empty job payload' } });
              return;
            }
            set({ job: job });
            if (job.state === 'done') {
              stopJobPoll();
              set({ notice: { tone: 'success', text: tr('service.jobDone') } });
              await refresh({ silent: true });
              return;
            }
            if (job.state === 'error') {
              stopJobPoll();
              return;
            }
            if (Date.now() - startedAt > JOB_TIMEOUT_MS) {
              stopJobPoll();
              set({
                job: {
                  id: started.jobId,
                  state: 'error',
                  message: '',
                  progress: null,
                  log: [],
                  error: tr('service.jobTimeout'),
                },
              });
              return;
            }
            jobTimer = setTimeout(() => {
              tick().catch((error) => console.warn('[wb2api] job poll failed:', error));
            }, POLL_JOB_MS);
          } catch (error) {
            stopJobPoll();
            set({ job: { id: started.jobId, state: 'error', message: '', progress: null, log: [], error: toMessage(error) } });
          }
        };
        await tick();
      }

      async function openPanel(page) {
        // 用户手势在 await 之后已经失效，浏览器会拦掉那时才开的窗口，
        // 所以先用空白窗口占位，拿到 URL 再写进去；失败就把占位窗口关掉。
        let placeholder = null;
        if (typeof window !== 'undefined' && typeof window.open === 'function') {
          try {
            placeholder = window.open('', '_blank');
          } catch (error) {
            console.warn('[wb2api] placeholder window failed:', error);
            placeholder = null;
          }
        }
        const closePlaceholder = () => {
          if (placeholder && typeof placeholder.close === 'function') {
            try {
              placeholder.close();
            } catch (error) {
              console.warn('[wb2api] closing placeholder failed:', error);
            }
          }
        };
        const ok = await run(
          'panel',
          async () => {
            const body = await api.openPanel(page);
            const url = body && body.url ? body.url : null;
            if (!url) throw new Error(tr('error.openPanelNoUrl'));
            if (placeholder && placeholder.location) placeholder.location.href = url;
            else if (typeof window !== 'undefined' && typeof window.open === 'function') {
              window.open(url, '_blank', 'noopener,noreferrer');
            }
            return true;
          },
          { errorPrefix: tr('error.openPanelFailed') },
        );
        if (!ok) closePlaceholder();
        return ok;
      }

      // ---- 账号

      /** 登录轮询：3s 一次，最多 5 分钟；done/error/超时都要给出明确结果。 */
      function startLoginPoll(stateId) {
        stopLoginPoll(); // 顺带自增世代号
        const gen = loginGen;
        const startedAt = Date.now();
        const tick = async () => {
          if (gen !== loginGen) return;
          try {
            const body = await api.loginPoll(stateId);
            if (gen !== loginGen) return; // await 期间被取消/卸载：不能再排下一轮
            if (!body) {
              stopLoginPoll();
              set({ login: null, notice: { tone: 'error', text: tr('accounts.loginPollBadResponse') } });
              return;
            }
            if (body.error) {
              stopLoginPoll();
              set({ login: null, notice: { tone: 'error', text: String(body.error) } });
              return;
            }
            if (body.done) {
              stopLoginPoll();
              const nickname = body.nickname || body.uid || '';
              set({ login: null, notice: { tone: 'success', text: tr('accounts.loginDone', { nickname: nickname }) } });
              await refresh({ silent: true });
              return;
            }
            if (Date.now() - startedAt > LOGIN_TIMEOUT_MS) {
              stopLoginPoll();
              set({ login: null, notice: { tone: 'warn', text: tr('accounts.loginTimeout') } });
              return;
            }
            loginTimer = setTimeout(() => {
              tick().catch((error) => console.warn('[wb2api] login poll failed:', error));
            }, POLL_LOGIN_MS);
          } catch (error) {
            stopLoginPoll();
            set({ login: null, notice: { tone: 'error', text: toMessage(error) } });
          }
        };
        void tick().catch((error) => console.warn('[wb2api] login poll crashed:', error));
      }

      async function loginStart(realm) {
        stopLoginPoll();
        const body = await run('login', () => api.loginStart(realm), { errorPrefix: tr('error.loginStartFailed') });
        if (!body || !body.url) {
          // 宿主返回 200 但拿不到链接时以前是静默的，点"添加账号"毫无反应
          set({ notice: { tone: 'warn', text: tr('accounts.loginNoUrl') } });
          return;
        }
        set({ login: { url: body.url, realm: realm, state: body.state } });
        startLoginPoll(body.state);
      }

      function cancelLogin() {
        stopLoginPoll();
        set({ login: null });
      }

      // ---- 模型

      async function saveKeep(ids) {
        const list = Array.isArray(ids) ? ids : [];
        const body = await run('keep', () => api.keep(list), {});
        if (body && body.ok !== false) {
          set({ keepSaved: list, notice: { tone: 'success', text: tr('models.saved', { count: list.length }) } });
        }
        return body;
      }

      // ---- 配置

      async function saveConfig(server, apiKey) {
        return run(
          'config',
          async () => {
            await api.config(server, apiKey);
            set({ notice: { tone: 'success', text: tr('advanced.saved') } });
          },
          { errorPrefix: tr('advanced.saveFailed') },
        );
      }

      function clearNotice() {
        set({ notice: null });
      }

      function dispose() {
        stopJobPoll();
        stopLoginPoll();
        listeners.clear();
      }

      return {
        getSnapshot: () => state,
        subscribe: (listener) => {
          if (typeof listener !== 'function') return () => {};
          listeners.add(listener);
          return () => {
            listeners.delete(listener);
          };
        },
        set,
        run,
        toMessage,
        refresh,
        serviceAction,
        install,
        stopJob,
        openPanel,
        loginStart,
        cancelLogin,
        saveKeep,
        saveConfig,
        clearNotice,
        dispose,
      };
    }

    // ---------------------------------------------------------------- 页面

    function ServiceSection(props) {
      const { status, job, busy } = props;
      const t = props.t;
      const installOpts = React.useState({ force: false, mirror: '', version: '' });
      const opts = installOpts[0];
      const setOpts = installOpts[1];
      const service = (status && status.service) || null;
      const accounts = (status && status.accounts) || EMPTY_ARRAY;
      const installed = Boolean(service && service.installed);
      const running = Boolean(service && service.running);
      const healthy = Boolean(service && service.healthy);
      const installBusy = Boolean(job && job.state === 'running') || busy.indexOf('install') >= 0;

      function patchOpts(patch) {
        setOpts(Object.assign({}, opts, patch));
      }

      function onInstall() {
        props.onInstall({
          force: Boolean(opts.force),
          mirror: String(opts.mirror || '').trim(),
          version: String(opts.version || '').trim(),
        });
      }

      const uptime = formatUptime(service && service.uptimeSec);
      const pct = job ? progressPercent(job.progress) : null;

      const summary = installed
        ? running
          ? t('service.running')
          : t('service.stopped')
        : t('service.notInstalled');

      const body = [];

      if (!installed) {
        body.push(h(Notice, { key: 'hint', text: t('service.notInstalledHint') }));
        body.push(
          h(
            'div',
            { className: 'wb2-grid', key: 'opts' },
            h(
              'label',
              { className: 'wb2-row', style: { gap: '6px' } },
              h('input', {
                type: 'checkbox',
                className: 'wb2-checkbox',
                checked: Boolean(opts.force),
                onChange: (event) => patchOpts({ force: event.target.checked }),
              }),
              h('span', { className: 'wb2-fieldValue' }, t('service.installForce')),
            ),
            h(
              'label',
              { className: 'wb2-field' },
              h('span', { className: 'wb2-fieldLabel' }, t('service.installMirror')),
              h('input', {
                className: 'wb2-input',
                type: 'text',
                value: opts.mirror,
                placeholder: t('service.installMirrorPlaceholder'),
                onChange: (event) => patchOpts({ mirror: event.target.value }),
              }),
            ),
            h(
              'label',
              { className: 'wb2-field' },
              h('span', { className: 'wb2-fieldLabel' }, t('service.installVersion')),
              h('input', {
                className: 'wb2-input',
                type: 'text',
                value: opts.version,
                placeholder: t('service.installVersionPlaceholder'),
                onChange: (event) => patchOpts({ version: event.target.value }),
              }),
            ),
          ),
        );
        body.push(
          h(
            'div',
            { className: 'wb2-row', key: 'actions' },
            h(Button, { variant: 'primary', disabled: installBusy, onClick: onInstall }, installBusy ? t('service.installProgress') : t('service.downloadAndInstall')),
            h(Button, { disabled: installBusy, onClick: () => props.onRefresh() }, t('action.refresh')),
            h('span', { className: 'wb2-spacer' }),
            h('span', { className: 'wb2-count' }, t('service.installDir') + '：' + String((service && service.installDir) || t('common.none'))),
          ),
        );
      } else {
        body.push(
          h(
            'div',
            { className: 'wb2-grid', key: 'facts' },
            h(Field, { label: t('service.version'), value: (service && service.version) || t('common.unknown') }),
            h(Field, { label: t('service.exeVersion'), value: service && service.exeVersion }),
            h(Field, { label: t('service.pid'), value: service && service.pid, mono: true }),
            h(Field, { label: t('service.uptime'), value: uptime }),
            h(Field, { label: t('service.baseURL'), value: service && service.baseURL, mono: true }),
            h(Field, { label: t('service.installDir'), value: service && service.installDir, mono: true }),
          ),
        );
        body.push(
          h(
            'div',
            { className: 'wb2-row', key: 'actions' },
            h(
              Button,
              { variant: 'primary', disabled: running || busy.indexOf('service') >= 0, onClick: () => props.onService('start') },
              t('service.start'),
            ),
            h(
              Button,
              { disabled: !running || busy.indexOf('service') >= 0, onClick: () => props.onService('stop') },
              t('service.stop'),
            ),
            h(Button, { disabled: busy.indexOf('service') >= 0, onClick: () => props.onService('restart') }, t('service.restart')),
            h(Button, { disabled: busy.indexOf('panel') >= 0, onClick: () => props.onOpenPanel('panel') }, t('service.openPanel')),
            h(Button, { disabled: installBusy, onClick: onInstall }, installBusy ? t('service.installProgress') : t('service.downloadAndInstall')),
          ),
        );
        body.push(
          h(
            'div',
            { className: 'wb2-row', key: 'badges' },
            h(Badge, { state: healthy ? 'ok' : running ? 'warn' : 'off', text: healthy ? t('service.healthy') : running ? t('service.unhealthy') : t('service.stopped') }),
            h('span', { className: 'wb2-count' }, '(' + accounts.length + ')'),
          ),
        );
      }

      if (job) {
        body.push(
          h(
            'div',
            { className: 'wb2-field', key: 'job' },
            h(
              'div',
              { className: 'wb2-row' },
              h('span', { className: 'wb2-fieldLabel' }, t('service.jobMessage')),
              h('span', { className: 'wb2-fieldValue' }, String(job.message || job.state || '')),
              h('span', { className: 'wb2-spacer' }),
              h(
                'span',
                { className: 'wb2-badge', 'data-state': job.state === 'error' ? 'err' : job.state === 'done' ? 'ok' : 'warn' },
                job.state === 'error' ? t('service.jobError') : job.state === 'done' ? t('service.jobDone') : t('service.installProgress'),
              ),
            ),
            h('div', { className: 'wb2-progress' }, h('div', { className: 'wb2-progressBar', style: { width: (pct == null ? 8 : pct) + '%' } })),
            job.error ? h(Notice, { tone: 'error', text: String(job.error) }) : null,
            Array.isArray(job.log) && job.log.length
              ? h('pre', { className: 'wb2-log' }, job.log.slice(-8).join('\n'))
              : null,
            job.state === 'done' || job.state === 'error' ? h(Button, { small: true, onClick: () => props.onDismissJob() }, t('action.close')) : null,
          ),
        );
      }

      return h(Collapsible, { title: t('service.title'), summary: summary, defaultOpen: true }, body);
    }

    function AccountsSection(props) {
      const { status, login, busy, t } = props;
      const accounts = (status && status.accounts) || EMPTY_ARRAY;
      const loginBusy = Boolean(login) || busy.indexOf('login') >= 0;
      const copyState = React.useState('idle');
      const copyStatus = copyState[0];
      const setCopyStatus = copyState[1];

      function copyLink() {
        const url = login && login.url;
        if (!url) return;
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard && navigator.clipboard.writeText) {
            navigator.clipboard.writeText(url).then(
              () => props.onNotice({ tone: 'success', text: t('accounts.copyOk') }),
              () => props.onNotice({ tone: 'warn', text: t('accounts.copyFailed') }),
            );
          } else {
            props.onNotice({ tone: 'warn', text: t('accounts.copyFailed') });
          }
        } catch (error) {
          props.onNotice({ tone: 'warn', text: t('accounts.copyFailed') });
        }
      }

      const rows = accounts.map((account) => {
        const uid = String((account && account.uid) || '');
        const realm = String((account && account.realm) || '');
        const credits = account && Number.isFinite(account.credits) ? account.credits : account && account.credits;
        const total = account && account.creditsTotal;
        const creditsText = credits == null ? t('common.none') : total != null && total !== '' ? String(credits) + ' / ' + String(total) : String(credits);
        const requests = formatInt(account && account.requestCount);
        const tokens = formatCompact(account && account.totalTokens);
        return h(
          'tr',
          { key: uid || Math.random().toString(36).slice(2) },
          h('td', { className: 'wb2-mono' }, uid ? uid.slice(0, 12) : t('common.none')),
          h('td', null, (account && account.nickname) || t('common.none')),
          h('td', null, realm === 'cn' ? t('accounts.realmCN') : realm === 'global' ? t('accounts.realmGlobal') : realm || t('common.none')),
          h('td', null, creditsText),
          h('td', null, shortTime(account && account.expiry) || t('common.none')),
          h('td', null, requests || t('common.none')),
          h('td', null, tokens || t('common.none')),
          h('td', null, account && account.disabled ? h('span', { className: 'wb2-badge', 'data-state': 'warn' }, t('accounts.disabledTag')) : t('accounts.enabled')),
        );
      });

      const body = [
        h(
          'div',
          { className: 'wb2-row', key: 'actions' },
          h(Button, { variant: 'primary', disabled: loginBusy, onClick: () => props.onLogin('cn') }, t('accounts.addCN')),
          h(Button, { disabled: loginBusy, onClick: () => props.onLogin('global') }, t('accounts.addGlobal')),
          login ? h(Button, { small: true, onClick: () => props.onCancelLogin() }, t('action.cancel')) : null,
          h('span', { className: 'wb2-spacer' }),
          h('span', { className: 'wb2-count' }, '(' + accounts.length + ')'),
        ),
      ];

      if (login) {
        body.push(
          h(
            'div',
            { className: 'wb2-linkBox', key: 'login' },
            h('span', { className: 'wb2-fieldLabel' }, t('accounts.loginHint')),
            h(
              'a',
              { className: 'wb2-link', href: login.url, target: '_blank', rel: 'noreferrer' },
              login.url,
            ),
            h(
              'div',
              { className: 'wb2-row' },
              h(Button, { small: true, onClick: copyLink }, t('action.copy')),
              h('span', { className: 'wb2-count' }, t('accounts.loginWaiting')),
            ),
          ),
        );
      }

      body.push(
        accounts.length === 0
          ? h('div', { className: 'wb2-empty', key: 'empty' }, t('accounts.empty'))
          : h(
              'div',
              { className: 'wb2-tableWrap', key: 'table' },
              h(
                'table',
                { className: 'wb2-table' },
                h(
                  'thead',
                  null,
                  h(
                    'tr',
                    null,
                    h('th', null, t('accounts.col.uid')),
                    h('th', null, t('accounts.col.nickname')),
                    h('th', null, t('accounts.col.realm')),
                    h('th', null, t('accounts.col.credits')),
                    h('th', null, t('accounts.col.expiry')),
                    h('th', null, t('accounts.col.requests')),
                    h('th', null, t('accounts.col.tokens')),
                    h('th', null, t('accounts.col.disabled')),
                  ),
                ),
                h('tbody', null, rows),
              ),
            ),
      );

      return h(Collapsible, { title: t('accounts.title'), summary: '(' + accounts.length + ')', defaultOpen: true }, body);
    }

    /** 用量：把网关自己统计的请求数 / tokens / 速率摊开，省得再去开官方面板。 */
    function UsageSection(props) {
      const t = props.t;
      const accounts = (props.status && Array.isArray(props.status.accounts) ? props.status.accounts : []).filter(Boolean);
      const withUsage = accounts.filter((a) => a && (a.requestCount != null || a.totalTokens != null));

      const sum = { requests: 0, success: 0, tokens: 0, prompt: 0, completion: 0 };
      for (const a of withUsage) {
        sum.requests += Number(a.requestCount) || 0;
        sum.success += Number(a.successCount) || 0;
        sum.tokens += Number(a.totalTokens) || 0;
        sum.prompt += Number(a.promptTokens) || 0;
        sum.completion += Number(a.completionTokens) || 0;
      }

      const rows = withUsage.map((a) => {
        const requests = Number(a.requestCount);
        const tokens = Number(a.totalTokens);
        const average = requests > 0 && Number.isFinite(tokens) ? tokens / requests : null;
        const speed = Number(a.lastTokensPerSecond);
        const split = formatCompact(a.promptTokens) && formatCompact(a.completionTokens)
          ? formatCompact(a.promptTokens) + ' / ' + formatCompact(a.completionTokens)
          : null;
        return h(
          'tr',
          { key: String(a.uid || a.nickname) },
          h('td', null, a.nickname || a.uid || t('common.none')),
          h('td', null, formatInt(a.requestCount) || t('common.none')),
          h('td', null, formatInt(a.successCount) || t('common.none')),
          h('td', null, formatCompact(a.totalTokens) || t('common.none')),
          h('td', null, split || t('common.none')),
          h('td', null, average == null ? t('common.none') : formatCompact(average)),
          h('td', null, formatMs(a.lastLatencyMs) || t('common.none')),
          h('td', null, Number.isFinite(speed) && speed > 0 ? speed.toFixed(1) + ' tok/s' : t('common.none')),
          h('td', null, shortDateTime(a.lastUsedAt) || t('common.none')),
        );
      });

      // 费率样本按模型聚合（同一模型可能在多个账号上各有一份样本，按样本数加权）。
      const rates = new Map();
      for (const a of accounts) {
        for (const cost of Array.isArray(a.modelCosts) ? a.modelCosts : []) {
          if (!cost || !cost.model) continue;
          const current = rates.get(cost.model) || { model: cost.model, costPer1k: null, samples: 0, accounts: 0, lastSeen: null };
          const samples = Number(cost.samples) || 0;
          const value = Number(cost.costPer1k);
          if (Number.isFinite(value)) {
            const denominator = current.samples + samples;
            current.costPer1k = denominator > 0
              ? ((current.costPer1k == null ? 0 : current.costPer1k * current.samples) + value * samples) / denominator
              : value;
          }
          current.samples += samples;
          current.accounts += 1;
          if (cost.lastSeen && (!current.lastSeen || String(cost.lastSeen) > String(current.lastSeen))) current.lastSeen = cost.lastSeen;
          rates.set(cost.model, current);
        }
      }
      const rateRows = [...rates.values()].map((r) =>
        h(
          'tr',
          { key: r.model },
          h('td', { className: 'wb2-mono' }, r.model),
          h('td', null, Number.isFinite(r.costPer1k) ? r.costPer1k.toFixed(4) : t('common.none')),
          h('td', null, formatInt(r.samples) || t('common.none')),
          h('td', null, String(r.accounts)),
          h('td', null, shortDateTime(r.lastSeen) || t('common.none')),
        ),
      );

      const body = [];
      if (withUsage.length === 0) {
        body.push(h('div', { className: 'wb2-empty', key: 'empty' }, t('usage.empty')));
      } else {
        body.push(
          h(
            'div',
            { className: 'wb2-tableWrap', key: 'usage' },
            h(
              'table',
              { className: 'wb2-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, t('usage.col.account')),
                  h('th', null, t('usage.col.requests')),
                  h('th', null, t('usage.col.success')),
                  h('th', null, t('usage.col.tokens')),
                  h('th', null, t('usage.col.split')),
                  h('th', null, t('usage.col.average')),
                  h('th', null, t('usage.col.latency')),
                  h('th', null, t('usage.col.speed')),
                  h('th', null, t('usage.col.lastUsed')),
                ),
              ),
              h('tbody', null, rows),
              h(
                'tfoot',
                null,
                h(
                  'tr',
                  null,
                  h('td', null, t('usage.totals')),
                  h('td', null, formatInt(sum.requests) || '0'),
                  h('td', null, formatInt(sum.success) || '0'),
                  h('td', null, formatCompact(sum.tokens) || '0'),
                  h('td', null, (formatCompact(sum.prompt) || '0') + ' / ' + (formatCompact(sum.completion) || '0')),
                  h('td', null, sum.requests > 0 ? formatCompact(sum.tokens / sum.requests) : t('common.none')),
                  h('td', null, ''),
                  h('td', null, ''),
                  h('td', null, ''),
                ),
              ),
            ),
          ),
        );
      }
      if (rateRows.length > 0) {
        body.push(
          h('div', { className: 'wb2-fieldLabel', key: 'ratesTitle' }, t('usage.ratesTitle')),
          h(
            'div',
            { className: 'wb2-tableWrap', key: 'rates' },
            h(
              'table',
              { className: 'wb2-table' },
              h(
                'thead',
                null,
                h(
                  'tr',
                  null,
                  h('th', null, t('usage.col.model')),
                  h('th', null, t('usage.col.rate')),
                  h('th', null, t('usage.col.samples')),
                  h('th', null, t('usage.col.accounts')),
                  h('th', null, t('usage.col.lastSeen')),
                ),
              ),
              h('tbody', null, rateRows),
            ),
          ),
        );
      }
      body.push(h('div', { className: 'wb2-count', key: 'note' }, t('usage.note')));

      const summary = withUsage.length > 0
        ? '(' + (formatCompact(sum.tokens) || '0') + ' tokens / ' + (formatInt(sum.requests) || '0') + ')'
        : null;
      return h(Collapsible, { title: t('usage.title'), summary: summary, defaultOpen: true }, body);
    }

    /** 单行模型，memo 掉，避免快照变化时重建几十个 checkbox。 */
    const ModelRow = React.memo(function ModelRow(props) {
      const model = props.model || {};
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const meta = [];
      if (model.vendor) meta.push(String(model.vendor));
      if (model.credits) meta.push(String(model.credits));
      if (Number.isFinite(model.contextLength)) meta.push(Math.round(model.contextLength / 1000) + 'k');
      if (model.supportsImages) meta.push(t('models.metaImage'));
      if (model.supportsReasoning) meta.push(t('models.metaReasoning'));
      return h(
        'label',
        { className: 'wb2-modelRow' },
        h('input', {
          className: 'wb2-checkbox',
          type: 'checkbox',
          checked: Boolean(props.checked),
          onChange: (event) => props.onToggle(model.id, event.target.checked),
        }),
        h(
          'span',
          { className: 'wb2-modelMain' },
          h('span', { className: 'wb2-modelId' }, String(model.id || '')),
          h('span', { className: 'wb2-modelMeta' }, model.name ? String(model.name) + (meta.length ? ' · ' + meta.join(' · ') : '') : meta.join(' · ')),
        ),
      );
    });

    function ModelsSection(props) {
      const { status, models, keepSaved, busy, t } = props;
      const filter = React.useState({ query: '', realm: 'all' });
      const current = filter[0];
      const setFilter = filter[1];
      const draftState = React.useState(null);
      const draft = draftState[0];
      const setDraft = draftState[1];

      const savedList = Array.isArray(keepSaved) ? keepSaved : EMPTY_ARRAY;
      const savedKey = savedList.join('\u0000');
      const list = Array.isArray(models) ? models : EMPTY_ARRAY;
      const keepAll = savedList.length === 0;
      // 保存成功后把草稿清空，重新从 keepSaved 派生（keep 为空就当"全部勾选"）。
      React.useEffect(() => {
        setDraft(null);
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [savedKey]);

      // keepAll（保留清单为空）时界面上等价于"全部勾选"，所以草稿基集必须展开成当前全部模型。
      // 以前基集是空集，勾选框却被 keepAll 强行画成勾选态，用户点一下取消落在空集上是空操作，
      // 于是"全部保留"态下谁都取消不掉。
      const savedSet = draft || new Set(keepAll ? list.map((model) => model.id) : savedList);

      const visible = React.useMemo(() => {
        const query = String(current.query || '').trim().toLowerCase();
        return list.filter((model) => {
          const id = String((model && model.id) || '');
          if (current.realm !== 'all' && realmOf(id) !== current.realm) return false;
          if (!query) return true;
          const name = String((model && model.name) || '').toLowerCase();
          return id.toLowerCase().indexOf(query) >= 0 || name.indexOf(query) >= 0;
        });
      }, [list, current.query, current.realm]);

      const keptCount = list.filter((model) => savedSet.has(model.id)).length;

      function toggle(id, checked) {
        try {
          const next = new Set(savedSet);
          if (checked) next.add(id);
          else next.delete(id);
          setDraft(next);
        } catch (error) {
          console.warn('[wb2api] model toggle failed:', error);
        }
      }

      function selectAll() {
        setDraft(new Set(list.map((model) => model.id)));
      }

      function clearAll() {
        // 按钮文案是「全部保留」：勾满全部模型（所见即所得），等价于老的"空清单"语义
        setDraft(new Set(list.map((model) => model.id)));
      }

      function save() {
        const ids = list.map((model) => model.id).filter((id) => savedSet.has(id));
        // 一个都没勾会被宿主按"空清单 = 全部保留"处理，与用户看到的相反，所以拦住并说清。
        if (ids.length === 0 && list.length > 0) {
          props.onNotice({ tone: 'warn', text: t('models.noneSelected') });
          return;
        }
        props.onSaveKeep(ids);
      }

      const body = [
        h(
          'div',
          { className: 'wb2-row', key: 'toolbar' },
          h('input', {
            className: 'wb2-input',
            'data-grow': '1',
            type: 'search',
            value: current.query,
            placeholder: t('models.searchPlaceholder'),
            'aria-label': t('models.searchPlaceholder'),
            onChange: (event) => setFilter(Object.assign({}, current, { query: event.target.value })),
          }),
          h(
            'select',
            {
              className: 'wb2-select',
              value: current.realm,
              'aria-label': t('models.realmAll'),
              onChange: (event) => setFilter(Object.assign({}, current, { realm: event.target.value })),
            },
            h('option', { value: 'all' }, t('models.realmAll')),
            h('option', { value: 'cn' }, t('models.realmCN')),
            h('option', { value: 'global' }, t('models.realmGlobal')),
          ),
          h(Button, { small: true, onClick: () => props.onRefresh(true) }, t('models.refreshList')),
        ),
        h(
          'div',
          { className: 'wb2-row', key: 'hint' },
          h('span', { className: 'wb2-count' }, t('models.countKept', { count: visible.length, kept: keptCount })),
          keepAll ? h('span', { className: 'wb2-count' }, t('models.keepAllHint')) : null,
          h('span', { className: 'wb2-spacer' }),
          h(Button, { small: true, onClick: selectAll }, t('models.selectAll')),
          h(Button, { small: true, onClick: clearAll }, t('models.clear')),
        ),
        visible.length === 0
          ? h('div', { className: 'wb2-empty', key: 'empty' }, t('models.empty'))
          : h(
              'div',
              { className: 'wb2-modelList', key: 'list' },
              visible.map((model) =>
                h(ModelRow, {
                  key: model.id,
                  model: model,
                  // 勾选态只认草稿/已存清单：不能再并上 keepAll，
                  // 否则"保留清单为空 = 全部保留"时用户取消掉一个也画回勾选态。
                  checked: savedSet.has(model.id),
                  t: t,
                  onToggle: toggle,
                }),
              ),
            ),
        h(
          'div',
          { className: 'wb2-row', key: 'save' },
          h(Button, { variant: 'primary', disabled: busy.indexOf('keep') >= 0, onClick: save }, t('models.save')),
          h('span', { className: 'wb2-count' }, t('models.kept') + '：' + keptCount),
        ),
      ];

      return h(Collapsible, { title: t('models.title'), summary: t('models.count', { count: list.length }), defaultOpen: true }, body);
    }

    function AdvancedSection(props) {
      const { status, busy, t } = props;
      const service = (status && status.service) || {};
      const form = React.useState({ server: '', apiKey: '' });
      const values = form[0];
      const setValues = form[1];
      const initedRef = React.useRef(false);

      React.useEffect(() => {
        if (initedRef.current) return;
        const base = String(service.baseURL || '');
        const stripped = base.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
        if (!stripped) return;
        initedRef.current = true;
        setValues({ server: stripped, apiKey: '' });
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, [service.baseURL]);

      const body = [
        h('div', { className: 'wb2-count', key: 'desc' }, t('advanced.desc')),
        h(
          'div',
          { className: 'wb2-form', key: 'server' },
          h('span', { className: 'wb2-formLabel' }, t('advanced.server')),
          h('input', {
            className: 'wb2-input',
            'data-grow': '1',
            type: 'text',
            value: values.server,
            placeholder: t('advanced.serverPlaceholder'),
            // 只读：插件与 DSH 的模型供应商都按这个地址访问网关，改端口得改插件配置
            readOnly: true,
            title: t('advanced.serverHint'),
          }),
          h('div', { className: 'wb2-count' }, t('advanced.serverHint')),
        ),
        h(
          'div',
          { className: 'wb2-form', key: 'apiKey' },
          h('span', { className: 'wb2-formLabel' }, t('advanced.apiKey')),
          h('input', {
            className: 'wb2-input',
            'data-grow': '1',
            type: 'password',
            value: values.apiKey,
            placeholder: t('advanced.apiKeyPlaceholder'),
            autoComplete: 'off',
            onChange: (event) => setValues(Object.assign({}, values, { apiKey: event.target.value })),
          }),
        ),
        h(
          'div',
          { className: 'wb2-row', key: 'save' },
          h(
            Button,
            {
              variant: 'primary',
              disabled: busy.indexOf('config') >= 0,
              onClick: () => props.onSaveConfig(String(values.server || '').trim(), String(values.apiKey || '')),
            },
            t('advanced.save'),
          ),
        ),
        h(
          'div',
          { className: 'wb2-grid', key: 'paths' },
          h(Field, { label: t('service.installDir'), value: service.installDir, mono: true }),
          h(Field, { label: t('service.baseURL'), value: service.baseURL, mono: true }),
        ),
      ];

      return h(Collapsible, { title: t('advanced.title'), defaultOpen: false }, body);
    }

    function Wb2apiPage(props) {
      const controller = props.controller;
      const t = typeof props.t === 'function' ? props.t : (key) => key;
      const snapshot = React.useSyncExternalStore(
        (listener) => controller.subscribe(listener),
        () => controller.getSnapshot(),
      );

      React.useEffect(() => {
        try {
          controller.refresh({ silent: true });
        } catch (error) {
          console.warn('[wb2api] initial refresh failed:', error);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
      }, []);

      const service = snapshot.status && snapshot.status.service;
      const busy = snapshot.busy || EMPTY_ARRAY;

      return h(
        'div',
        { className: 'wb2-root' },
        h(
          'div',
          { className: 'wb2-head' },
          h('h2', { className: 'wb2-title' }, t('title')),
          h('p', { className: 'wb2-subtitle' }, t('subtitle')),
        ),
        h(
          'div',
          { className: 'wb2-row' },
          h(
            Button,
            { disabled: busy.indexOf('load') >= 0, onClick: () => controller.refresh({ refreshModels: true }) },
            t('action.refresh'),
          ),
          service
            ? h(Badge, {
                state: service.healthy ? 'ok' : service.running ? 'warn' : 'off',
                text: service.running ? t('service.running') : t('service.stopped'),
              })
            : null,
          service
            ? h(Badge, {
                state: service.installed ? 'ok' : 'off',
                text: service.installed ? t('service.installed') : t('service.notInstalled'),
              })
            : null,
          h('span', { className: 'wb2-spacer' }),
          h('span', { className: 'wb2-count' }, t('common.refreshHint')),
        ),
        h(Notice, {
          text: snapshot.error,
          tone: 'error',
          closeLabel: t('action.close'),
          onClose: () => controller.set({ error: null }),
        }),
        h(Notice, {
          text: snapshot.notice && snapshot.notice.text,
          tone: snapshot.notice && snapshot.notice.tone,
          closeLabel: t('action.close'),
          onClose: () => controller.clearNotice(),
        }),
        h(
          SectionBoundary,
          { key: 'service', fallback: h('div', { className: 'wb2-empty' }, t('error.sectionFailed')) },
          h(ServiceSection, {
            status: snapshot.status,
            job: snapshot.job,
            busy: busy,
            t: t,
            onRefresh: () => controller.refresh({ refreshModels: true }),
            onService: (action) => controller.serviceAction(action),
            onInstall: (opts) => controller.install(opts),
            onDismissJob: () => controller.stopJob(),
            onOpenPanel: (page) => controller.openPanel(page),
          }),
        ),
        h(
          SectionBoundary,
          { key: 'accounts', fallback: h('div', { className: 'wb2-empty' }, t('error.sectionFailed')) },
          h(AccountsSection, {
            status: snapshot.status,
            login: snapshot.login,
            busy: busy,
            t: t,
            onLogin: (realm) => controller.loginStart(realm),
            onCancelLogin: () => controller.cancelLogin(),
            onNotice: (notice) => controller.set({ notice: notice }),
          }),
        ),
        h(
          SectionBoundary,
          { key: 'usage', fallback: h('div', { className: 'wb2-empty' }, t('error.sectionFailed')) },
          h(UsageSection, {
            status: snapshot.status,
            t: t,
          }),
        ),
        h(
          SectionBoundary,
          { key: 'models', fallback: h('div', { className: 'wb2-empty' }, t('error.sectionFailed')) },
          h(ModelsSection, {
            status: snapshot.status,
            models: snapshot.models,
            keepSaved: snapshot.keepSaved,
            busy: busy,
            t: t,
            onSaveKeep: (ids) => controller.saveKeep(ids),
            onRefresh: (refreshModels) => controller.refresh({ refreshModels: refreshModels }),
            onNotice: (notice) => controller.set({ notice: notice }),
          }),
        ),
        h(
          SectionBoundary,
          { key: 'advanced', fallback: h('div', { className: 'wb2-empty' }, t('error.sectionFailed')) },
          h(AdvancedSection, {
            status: snapshot.status,
            busy: busy,
            t: t,
            onSaveConfig: (server, apiKey) => controller.saveConfig(server, apiKey),
          }),
        ),
      );
    }

    // 单个分区或整页出错时只降级那一块，不要把整个设置页替换掉。
    // 必须用类组件的错误边界：函数组件里的 try/catch 抓不到子组件**渲染期**的抛错，
    // 以前 GuardedPage 就是个函数，整页崩溃时什么也拦不住。
    const ReactComponent = React && React.Component ? React.Component : null;

    function makeBoundary(label, fallbackOf) {
      if (!ReactComponent) return function Boundary(props) { return props.children; };
      return class Boundary extends ReactComponent {
        constructor(props) {
          super(props);
          this.state = { failed: false };
        }

        static getDerivedStateFromError() {
          return { failed: true };
        }

        componentDidCatch(error) {
          console.warn('[wb2api] ' + label + ' crashed:', error);
        }

        render() {
          if (this.state && this.state.failed) return fallbackOf(this.props) || null;
          return this.props.children;
        }
      };
    }

    // 单个分区出错时只让那一块降级
    const SectionBoundary = makeBoundary('section', (props) => props.fallback);

    // 整个设置页的兜底：边界在模块级拿不到 t，所以走 props.t
    const PageBoundary = makeBoundary('page', (props) => {
      const tt = typeof props.t === 'function' ? props.t : (key) => key;
      return h('div', { className: 'wb2-empty' }, tt('error.pageFailed'));
    });

    function GuardedPage(props) {
      return h(PageBoundary, { t: props.t }, h(Wb2apiPage, props));
    }

    // ---------------------------------------------------------------- 插件

    const inject = ['slots', 'locale'];

    function apply(ctx) {
      try {
        ensureStyle();

        let t = (key) => key;
        try {
          ctx.effect(
            () => {
              try {
                return ctx.locale.register(NS, { zh: zh, en: en });
              } catch (error) {
                console.warn('[wb2api] locale register failed:', error);
                return () => {};
              }
            },
            'wb2api: dictionaries',
          );
        } catch (error) {
          console.warn('[wb2api] locale effect failed:', error);
        }
        try {
          t = ctx.locale.bind(NS);
        } catch (error) {
          console.warn('[wb2api] locale bind failed:', error);
        }

        const api = {
          request: request,
          status: () => request(API.status),
          models: (refresh) => request(API.models + (refresh ? '?refresh=1' : '')),
          keep: (keep) => request(API.keep, { method: 'POST', body: { keep: keep, all: keep.length === 0 } }),
          service: (action) => request(API.service, { method: 'POST', body: { action: action } }),
          install: (opts) => request(API.install, { method: 'POST', body: opts || {} }),
          job: (id) => request(API.job + '?id=' + encodeURIComponent(String(id))),
          loginStart: (realm) => request(API.loginStart, { method: 'POST', body: { realm: realm } }),
          loginPoll: (id) => request(API.loginPoll + '?state=' + encodeURIComponent(String(id))),
          openPanel: (page) => request(API.openPanel, { method: 'POST', body: { page: page } }),
          config: (server, apiKey) => request(API.config, { method: 'POST', body: { server: server, apiKey: apiKey } }),
        };

        const controller = createController(api, t);

        try {
          ctx.effect(
            () => () => {
              try {
                controller.dispose();
              } catch (error) {
                console.warn('[wb2api] controller dispose failed:', error);
              }
            },
            'wb2api: lifecycle',
          );
        } catch (error) {
          console.warn('[wb2api] lifecycle effect failed:', error);
        }

        try {
          ctx.slots.inject('settings.section', () =>
            ctx.slots.register(
              {
                name: 'settings.section',
                id: 'wb2api',
                order: 60,
                label: () => {
                  try {
                    return t('title');
                  } catch (error) {
                    console.warn('[wb2api] label failed:', error);
                    return 'WorkBuddy2API';
                  }
                },
              },
              () => h(GuardedPage, { api: api, controller: controller, t: t }),
            ),
          );
        } catch (error) {
          console.warn('[wb2api] settings section registration failed:', error);
        }
      } catch (error) {
        // apply 抛错会让整个 web 壳启动失败，这里必须吞掉
        console.warn('[wb2api] apply failed:', error);
      }
    }

    return { inject: inject, apply: apply };
  },
});
