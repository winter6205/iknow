// src-adjacent runtime asset: vendor/egress-relay/egress-tcp-relay.mjs
//
// ADR-0107 换装：本仓自带围栏内最小中继（禁 socat 产品依赖）。
// 纯 node:net，无依赖、无 TS —— 由宿主解析到的 node 绝对路径在沙箱内执行。
//
// 形态对应旧 `socat TCP-LISTEN:<port>,fork,reuseaddr UNIX-CONNECT:<sock>`：
// 在 127.0.0.1:<port> 监听（沙箱 netns 内环回），把每条 TCP 连接双向 pipe 到
// 宿主 bind 进来的 unix socket（宿主 HTTP 代理直接 listen 该 socket）。
// 多连接并发 = net.Server 天然支持，无需 fork 语义。
//
// 用法: node egress-tcp-relay.mjs <unixSocketPath> <tcpPort>
import { connect, createServer } from "node:net";

const [sockPath, portRaw] = process.argv.slice(2);
const port = Number.parseInt(portRaw ?? "", 10);
if (
  typeof sockPath !== "string" ||
  sockPath.length === 0 ||
  !Number.isInteger(port) ||
  port <= 0 ||
  port > 65535
) {
  process.stderr.write(
    "usage: egress-tcp-relay.mjs <unixSocketPath> <tcpPort>\n"
  );
  process.exit(2);
}

const server = createServer((client) => {
  const upstream = connect({ path: sockPath });
  client.on("error", () => upstream.destroy());
  upstream.on("error", () => client.destroy());
  client.pipe(upstream);
  upstream.pipe(client);
});
server.on("error", (err) => {
  process.stderr.write(`egress-tcp-relay: listen failed: ${err.message}\n`);
  process.exit(1);
});
server.listen(port, "127.0.0.1");
