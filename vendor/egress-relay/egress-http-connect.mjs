// src-adjacent runtime asset: vendor/egress-relay/egress-http-connect.mjs
//
// ADR-0107 换装：GIT_SSH_COMMAND ProxyCommand 的最小 HTTP CONNECT 隧道件
// （替代旧 `socat - PROXY:127.0.0.1:%h:%p,proxyport=...,proxyauth=...`）。
// 纯 node:net + node:url，无依赖 —— 由 ssh 作为 ProxyCommand 以宿主解析到的
// node 绝对路径执行。
//
// token 不进 argv（旧 proxyauth= 内联串退役）：认证材料从 process.env
// .HTTP_PROXY（fence 注入，含 userinfo）读取 —— ssh 会向 ProxyCommand 继承
// env，凭证与代理三键同源。
//
// 用法: node egress-http-connect.mjs <destHost> <destPort>
import { connect } from "node:net";

const [destHost, destPortRaw] = process.argv.slice(2);
const proxyRaw = process.env.HTTP_PROXY ?? process.env.http_proxy;
if (
  typeof destHost !== "string" ||
  destHost.length === 0 ||
  !/^\d+$/.test(destPortRaw ?? "") ||
  typeof proxyRaw !== "string"
) {
  process.stderr.write(
    "usage: egress-http-connect.mjs <destHost> <destPort> (HTTP_PROXY must be set)\n"
  );
  process.exit(2);
}

let proxy;
try {
  proxy = new URL(proxyRaw);
} catch {
  process.stderr.write("egress-http-connect: HTTP_PROXY is not a URL\n");
  process.exit(2);
}
const proxyPort =
  proxy.port.length > 0 ? Number.parseInt(proxy.port, 10) : 80;
// userinfo 是 percent-encoded（buildProxyEnv 生成 hex token，无需转义，但
// URL 语义下解码保持正确）。Proxy-Authorization 走 Basic。
const credentials = Buffer.from(
  `${decodeURIComponent(proxy.username)}:${decodeURIComponent(proxy.password)}`
).toString("base64");

const socket = connect({ host: proxy.hostname, port: proxyPort });
let alive = true;
const die = (where, detail = "") => {
  if (!alive) return;
  alive = false;
  process.stderr.write(`egress-http-connect: ${where}${detail}\n`);
  socket.destroy();
  process.exit(1);
};

socket.on("error", (err) => die("proxy connect failed: ", err.message));

const target = `${destHost}:${destPortRaw}`;
socket.write(
  `CONNECT ${target} HTTP/1.1\r\n` +
    `Host: ${target}\r\n` +
    `Proxy-Authorization: Basic ${credentials}\r\n` +
    `\r\n`
);

let head = "";
// 挂死防线（review 修复 [Medium]）：头部解析完成前代理可能优雅 FIN /
// 半关闭 / 直接 close —— 旧实现只挂 error + 上限，此形态下进程永挂 stdin，
// 表现为 ssh ProxyCommand 挂死 = git push 无限 hang。end/close 一律
// 诊断到 stderr + 非零退出；隧道建立后这两个 once 监听器撤除。
let established = false;
const onEarlyClose = () => {
  if (established) return;
  process.stderr.write(
    "egress-http-connect: proxy closed before CONNECT response completed\n"
  );
  socket.destroy();
  process.exit(1);
};
socket.once("end", onEarlyClose);
socket.once("close", onEarlyClose);
// 隧道模式下 stdout 是到 ssh 的 pipe：退出前必须等缓冲 flush 完，
// 否则 banner / 数据尾部被截断（end 回调后再退）。exiting 旗标防止
// end→close 连发时第二次调用绕过在途 flush 立刻硬退出。
let exiting = false;
const flushExit = (code) => {
  if (exiting) return;
  exiting = true;
  try {
    process.stdout.end(() => process.exit(code));
  } catch {
    process.exit(code);
  }
};
const onData = (chunk) => {
  head += chunk.toString("latin1");
  const end = head.indexOf("\r\n\r\n");
  if (end === -1) {
    if (head.length > 65536) die("proxy response header too large");
    return;
  }
  const statusLine = head.slice(0, head.indexOf("\r\n"));
  socket.removeListener("data", onData);
  if (!/^HTTP\/1\.[01] 200\b/.test(statusLine)) {
    die("proxy refused CONNECT: ", statusLine);
    return;
  }
  // 隧道建立：stdio ↔ socket 双向 pipe（stdin 为 blocking fd，pipe 语义成立）。
  established = true;
  socket.removeListener("end", onEarlyClose);
  socket.removeListener("close", onEarlyClose);
  // 头部阶段的 die-on-error 监听换成 flush-exit：隧道期错误退出前也要
  // 让已写 stdout 完成 flush（banner 截断 = ssh kex 假失败，难排查）。
  socket.removeAllListeners("error");
  const rest = head.slice(end + 4);
  head = "";
  if (rest.length > 0) process.stdout.write(rest);
  socket.on("data", (buf) => process.stdout.write(buf));
  socket.on("end", () => flushExit(0));
  socket.once("close", () => flushExit(0));
  socket.on("error", () => flushExit(1));
  process.stdin.on("error", () => socket.destroy());
  process.stdin.pipe(socket);
  process.stdout.on("error", () => {
    alive = false;
    socket.destroy();
    process.exit(1);
  });
};
socket.on("data", onData);
