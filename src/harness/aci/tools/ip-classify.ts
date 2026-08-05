/**
 * ip-classify：IP 字面量非公网分类（network-guard 的判定数据层）。
 *
 * code-review 整改抽出：network-guard.ts 超 300 行文件预算，把 IPv4/IPv6
 * 分类与解析（纯函数、无 I/O）独立成本模块，guard 只保留出站流程。
 * 非公网段清单对齐 Python ipaddress 的 is_global 语义（loopback / 私网 /
 * link-local / CGNAT / 多播 / 保留段等）。
 */

import { isIP } from "node:net";

/** IPv4 非公网段（base / prefix / 类别标签）。 */
const IPV4_BLOCKED_RANGES: ReadonlyArray<{
  base: string;
  prefix: number;
  label: string;
}> = [
  { base: "0.0.0.0", prefix: 8, label: "this-network" },
  { base: "10.0.0.0", prefix: 8, label: "private" },
  { base: "100.64.0.0", prefix: 10, label: "cgnat" },
  { base: "127.0.0.0", prefix: 8, label: "loopback" },
  { base: "169.254.0.0", prefix: 16, label: "link-local" },
  { base: "172.16.0.0", prefix: 12, label: "private" },
  { base: "192.0.0.0", prefix: 24, label: "ietf-protocol" },
  { base: "192.0.2.0", prefix: 24, label: "test-net" },
  { base: "192.168.0.0", prefix: 16, label: "private" },
  { base: "198.18.0.0", prefix: 15, label: "benchmarking" },
  { base: "198.51.100.0", prefix: 24, label: "test-net" },
  { base: "203.0.113.0", prefix: 24, label: "test-net" },
  { base: "224.0.0.0", prefix: 4, label: "multicast" },
  { base: "240.0.0.0", prefix: 4, label: "reserved" },
];

/** 判定 IP 是否非公网：非公网返回类别标签，公网返回 null。 */
export function classifyIp(ip: string): string | null {
  const version = isIP(ip);
  if (version === 4) return classifyIpv4(ip);
  if (version === 6) return classifyIpv6(ip);
  return null; // 非 IP 字面量（主机名），交由主机名 + DNS 防线处理
}

/** IPv4 非公网段匹配。 */
function classifyIpv4(ip: string): string | null {
  const value = ipv4ToNumber(ip);
  if (value === null) return null;
  for (const range of IPV4_BLOCKED_RANGES) {
    if (inIpv4Range(value, range.base, range.prefix)) return range.label;
  }
  return null;
}

/** IPv4 点分十进制 → 32 位无符号整数；非法返回 null。 */
function ipv4ToNumber(ip: string): number | null {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let acc = 0;
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    const octet = Number(part);
    if (octet > 255) return null;
    acc = acc * 256 + octet;
  }
  return acc >>> 0;
}

/** IPv4 是否在 base/prefix 段内。 */
function inIpv4Range(value: number, base: string, prefix: number): boolean {
  const baseValue = ipv4ToNumber(base);
  if (baseValue === null) return false;
  const shift = 32 - prefix;
  return value >>> shift === baseValue >>> shift;
}

/** IPv6 非公网类别：loopback / unspecified / link-local / unique-local / multicast / v4-mapped。 */
function classifyIpv6(ip: string): string | null {
  const groups = ipv6Groups(ip);
  if (groups === null) return null;
  const first = groups[0];
  if (groups.slice(0, 7).every((g) => g === 0)) {
    if (groups[7] === 1) return "loopback"; // IPv6 回环地址
    if (groups[7] === 0) return "unspecified"; // IPv6 未指定地址
  }
  if ((first & 0xffc0) === 0xfe80) return "link-local"; // fe80::/10
  if ((first & 0xfe00) === 0xfc00) return "unique-local"; // fc00::/7
  if ((first & 0xff00) === 0xff00) return "multicast"; // ff00::/8
  return classifyIpv6MappedIpv4(groups);
}

/** IPv4-mapped IPv6（内嵌 IPv4 段）→ 判定内嵌 IPv4。 */
function classifyIpv6MappedIpv4(groups: readonly number[]): string | null {
  const prefixAllZero = groups.slice(0, 5).every((g) => g === 0);
  if (!prefixAllZero || groups[5] !== 0xffff) return null;
  const embedded = `${(groups[6] >>> 8) & 0xff}.${groups[6] & 0xff}.${(groups[7] >>> 8) & 0xff}.${groups[7] & 0xff}`;
  return classifyIpv4(embedded);
}

/** IPv6 展开为 8 个 16 位组；非法返回 null（处理双冒号缩写与内嵌 IPv4）。 */
function ipv6Groups(ip: string): readonly number[] | null {
  let s = ip.toLowerCase();
  const zone = s.indexOf("%");
  if (zone !== -1) s = s.slice(0, zone);
  const lastColon = s.lastIndexOf(":");
  const tailPart = s.slice(lastColon + 1);
  if (tailPart.includes(".")) {
    const v4 = ipv4ToNumber(tailPart);
    if (v4 === null) return null;
    const hi = ((v4 >>> 16) & 0xffff).toString(16);
    const lo = (v4 & 0xffff).toString(16);
    s = s.slice(0, lastColon + 1) + hi + ":" + lo;
  }
  return expandDoubleColon(s);
}

/** 双冒号缩写展开 + 每组合法性校验。 */
function expandDoubleColon(s: string): readonly number[] | null {
  const dcIdx = s.indexOf("::");
  let parts: string[];
  if (dcIdx !== -1) {
    const head = s.slice(0, dcIdx);
    const tail = s.slice(dcIdx + 2);
    const headParts = head === "" ? [] : head.split(":");
    const tailParts = tail === "" ? [] : tail.split(":");
    const missing = 8 - headParts.length - tailParts.length;
    if (missing < 0) return null;
    parts = [...headParts, ...Array<string>(missing).fill("0"), ...tailParts];
  } else {
    parts = s.split(":");
  }
  if (parts.length !== 8) return null;
  const groups: number[] = [];
  for (const part of parts) {
    if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
    groups.push(parseInt(part, 16));
  }
  return groups;
}
