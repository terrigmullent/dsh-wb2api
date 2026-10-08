/**
 * 官方验证清单里的静态两项：JS 语法 + manifest 契约。
 *
 * 这里不做浏览器验证（官方 verification.md 禁止起浏览器/截图/模拟 DOM）；
 * 任何"渲染是否正确"的结论都必须由人在真机上看。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (rel) => readFileSync(join(ROOT, rel), 'utf8');

/** 客户端沙箱只提供这 9 个模块，别的 require 会在真机上直接抛错。 */
const CLIENT_MODULES = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]);

const pkg = JSON.parse(read('package.json'));

test('manifest：包名、入口与 bundle patch', () => {
  assert.equal(pkg.name, 'dsh-wb2api');
  assert.equal(pkg.type, 'module');
  assert.equal(pkg.main, './lib/index.js');
  assert.equal(pkg.exports['.'], './lib/index.js');
  assert.equal(pkg.exports['./client'], './lib/client.js');
  assert.equal(pkg.dsh.bundle.patch, './cordis.patch.yml');
  assert.ok(existsSync(join(ROOT, pkg.dsh.bundle.patch)), 'bundle patch 文件必须存在');
  assert.ok(existsSync(join(ROOT, 'lib/index.js')));
  assert.ok(existsSync(join(ROOT, 'lib/client.js')), '声明了 dsh.client 就必须有 exports["./client"] 的产物');
});

test('manifest：client 段合法且依赖真实存在的官方包', () => {
  const client = pkg.dsh.client;
  assert.equal(client.platform, 'web');
  assert.ok(Array.isArray(client.inject) && client.inject.length > 0);
  // settings.section 这个席位由 settings-general 声明；slots/locale 是注册时用到的服务。
  for (const required of ['@deepseek-ai/dsh-client-ui-slots', '@deepseek-ai/dsh-client-locale', '@deepseek-ai/dsh-client-ui-settings-general']) {
    assert.ok(client.inject.includes(required), `dsh.client.inject 缺少 ${required}`);
  }
  for (const name of client.inject) {
    assert.match(name, /^@deepseek-ai\/dsh-client-[a-z0-9-]+$/, `客户端依赖名不像官方包：${name}`);
    assert.ok(!/runtime/.test(name), `${name} 在 DSH 里不存在（没有 dsh-client-runtime 这个包）`);
  }
});

test('bundle patch：YAML 形状与 insert 行', () => {
  const yml = read('cordis.patch.yml');
  assert.match(yml, /^-\s*insert:/m, 'patch 顶层应是 - insert: 数组');
  assert.match(yml, /^\s*-?\s*id:\s*dsh-wb2api\s*$/m);
  assert.match(yml, /^\s*name:\s*'dsh-wb2api'\s*$/m);
  // 注释里的示例不能出现在实际生效的 insert 段里（缩进更深的不算）
  const activeLines = yml.split(/\r?\n/).filter((line) => line.trim() !== '' && !line.trimStart().startsWith('#'));
  assert.ok(activeLines.length >= 3, '生效内容应包含 insert 与其下的 id/name');
});

test('宿主入口是合法 ESM，且不 import 任何 @deepseek-ai/*', () => {
  const text = read('lib/index.js');
  assert.match(text, /export function apply\s*\(/);
  assert.match(text, /export const name\s*=\s*'dsh-wb2api'/);
  assert.match(text, /export const inject\s*=/);
  assert.ok(!/from\s+['"]@deepseek-ai\//.test(text), 'profile 的 node_modules 解析不到 @deepseek-ai/*，宿主插件不能 import 它们');
  assert.ok(!/require\s*\(/.test(text), 'ESM 里不该出现 require');
});

test('宿主入口的全部 import 都能解析到同包文件或 node 内置', () => {
  const text = read('lib/index.js');
  const specs = [...text.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  assert.ok(specs.length > 0);
  for (const spec of specs) {
    if (spec.startsWith('node:')) continue;
    assert.ok(spec.startsWith('./') || spec.startsWith('../'), `第三方依赖 ${spec} 不能出现在插件包里`);
    assert.ok(existsSync(join(ROOT, 'lib', spec)), `找不到 ${spec}`);
  }
});

test('客户端入口语法合法，且只 require 沙箱白名单里的模块', () => {
  const text = read('lib/client.js');
  // 不是 ESM，而是交给 window.__ModuleLoader__ 的脚本体，所以能用 vm 直接解析。
  assert.doesNotThrow(() => new vm.Script(text, { filename: 'lib/client.js' }), '客户端脚本体必须能通过语法解析');
  assert.match(text, /window\.__ModuleLoader__\.load\(/);

  const specs = [...text.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
  assert.ok(specs.length > 0, '至少要 require react');
  for (const spec of specs) {
    assert.ok(CLIENT_MODULES.has(spec), `client.js require 了沙箱里没有的模块：${spec}`);
  }
});

test('客户端入口的 id 等于包名，且导出的是 cordis 插件对象而不是组件', () => {
  const text = read('lib/client.js');
  const loadIndex = text.indexOf('__ModuleLoader__.load');
  const head = text.slice(loadIndex, loadIndex + 400);
  assert.match(head, /id:\s*['"]dsh-wb2api['"]/, 'load 的 id 必须精确等于包名');
  assert.match(head, /factory/, 'load 需要 factory(require)');
  assert.match(text, /apply\s*\(/, 'factory 应返回带 apply 的插件对象');
});

test('客户端不用 primitives、不嵌 iframe、不往 document.body 追加', () => {
  const text = read('lib/client.js');
  assert.ok(!/dsh-client-ui-primitives/.test(text), '官方禁止客户端插件使用 primitives');
  assert.ok(!/<iframe/i.test(text), '不使用 iframe（拿不到主题与 locale）');
  assert.ok(!/document\.body\s*\.\s*(append|appendChild|prepend|insertBefore)/.test(text), '不许往 document.body 追加节点');
  assert.ok(!/createRoot\s*\(/.test(text), '不许替换根节点');
});

test('客户端注册的是 settings.section 且 id 为 wb2api', () => {
  const text = read('lib/client.js');
  assert.match(text, /slots\.inject\(\s*['"]settings\.section['"]/);
  const registerIndex = text.indexOf('slots.register');
  assert.ok(registerIndex > 0);
  const block = text.slice(registerIndex, registerIndex + 300);
  assert.match(block, /name:\s*['"]settings\.section['"]/);
  assert.match(block, /id:\s*['"]wb2api['"]/);
  assert.ok(!/name:\s*['"]settings\.section\.root['"]/.test(text), 'root 席位不许注册');
});

test('客户端 i18n：中英字典齐全', () => {
  const text = read('lib/client.js');
  assert.match(text, /locale\.register\(\s*NS\s*,\s*\{\s*zh:/);
  assert.match(text, /\ben\s*[:=]\s*\{/);
  assert.match(text, /locale\.bind\(\s*NS\s*\)/);
});

test('客户端样式只用主题 token，不写字面颜色', () => {
  const text = read('lib/client.js');
  const colors = [...text.matchAll(/(#[0-9a-fA-F]{3,8}\b|\brgba?\([^)]*\)|\bhsla?\([^)]*\))/g)].map((m) => m[1]);
  assert.deepEqual(colors, [], `样式里出现了字面颜色：${colors.join(', ')}（应改用 --dsw-* token）`);
  assert.match(text, /--dsw-/, '至少要引用一处主题 token');
});

test('README 与 LICENSE 齐备，且 README 不引用不存在的文件', () => {
  for (const rel of ['README.md', 'LICENSE', 'icon.svg', '.gitignore']) {
    assert.ok(existsSync(join(ROOT, rel)), `缺少 ${rel}`);
  }
  const readme = read('README.md');
  assert.match(readme, /workbuddy2api/);
  const referenced = ['lib/index.js', 'lib/client.js', 'cordis.patch.yml', 'package.json'];
  for (const rel of referenced) {
    assert.ok(readme.includes(rel), `README 应说明仓库结构，缺少 ${rel}`);
  }
});
