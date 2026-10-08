// 测试用的假网关：只为 ServiceManager 的进程生命周期测试提供一个"能起、能健康、能立刻退出"的替身，
// 避免测试去碰真的 wb2api.exe（也不会占用 7863）。
//
//   node tools/fake-gateway.mjs --port 12345          正常启动并响应 /healthz
//   node tools/fake-gateway.mjs --exit-now            立刻退出（模拟端口被占用/配置非法）
import { createServer } from 'node:http';

const argv = process.argv.slice(2);
const arg = (name, fallback) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : fallback;
};

if (argv.includes('--exit-now')) {
  process.stdout.write('fake-gateway: 启动即退出（模拟端口被占用 / config.json 非法）\n');
  process.exit(3);
}

const server = createServer((req, res) => {
  if (req.url && req.url.startsWith('/healthz')) {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ healthy: 0, total: 0, service: 'fake-gateway' }));
    return;
  }
  res.writeHead(404, { 'content-type': 'application/json' });
  res.end('{"error":"not found"}');
});

const port = Number(arg('--port', '0'));
server.listen(port, '127.0.0.1', () => {
  process.stdout.write(`fake-gateway listening on 127.0.0.1:${server.address().port}\n`);
});

const bye = () => {
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 300).unref();
};
process.on('SIGTERM', bye);
process.on('SIGINT', bye);
