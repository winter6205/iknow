/**
 * PROTOTYPE（throwaway）— ACI 原型工具层：上下文压缩管理器。
 *
 * 验证问题：ch04 组件④（压缩旧观测）能否以纯函数实现，
 * 不修改协议、不碰产品流量、无 FS 依赖。
 * 边界：保留最近 keepRecent（默认 3）条原文；更早的截断到 maxChars（默认 200，超长加 "…"）；
 * droppedChars = 原文总长 - 压缩后总长（不小于 0）。
 * lazy: true —— 演示延迟加载，默认不进 prompt schema。
 */

import type { AciToolDef } from "../types.js";
import { ToolExecutionError } from "../../errors.js";

/**
 * 工厂：创建 context_manager 工具（ch04 组件④：压缩旧观测）。
 * 纯函数，无 FS，无状态。lazy: true 演示延迟加载。
 */
export function createContextManagerTool(): AciToolDef {
  return Object.freeze({
    name: "context_manager",
    description:
      "Compress old observations to save context window. Keeps the most recent N verbatim; truncates older ones to maxChars.",
    inputSchema: {
      type: "object",
      properties: {
        observations: { type: "array", items: { type: "string" } },
        keepRecent: { type: "number" },
        maxChars: { type: "number" },
      },
      required: ["observations"],
      additionalProperties: false,
    },
    aci: {
      category: "read-only" as const,
      isReadOnly: true,
      isDestructive: false,
      isConcurrencySafe: true,
      interruptBehavior: "cancel" as const,
      lazy: true,
    },
    handler: async (input: unknown) => {
      const {
        observations: rawObs,
        keepRecent: rawKeep,
        maxChars: rawMax,
      } = input as {
        observations?: unknown;
        keepRecent?: unknown;
        maxChars?: unknown;
      };
      if (
        !Array.isArray(rawObs) ||
        rawObs.some((o: unknown) => typeof o !== "string")
      ) {
        throw new ToolExecutionError(
          "context_manager: observations must be string[]",
        );
      }
      const observations = rawObs as string[];
      const keepRecent =
        typeof rawKeep === "number" && rawKeep >= 0 ? Math.floor(rawKeep) : 3;
      const maxChars =
        typeof rawMax === "number" && rawMax > 0 ? Math.floor(rawMax) : 200;

      const splitAt = Math.max(0, observations.length - keepRecent);
      const kept = observations.slice(splitAt);
      const older = observations.slice(0, splitAt);

      let originalChars = 0;
      let compressedChars = 0;
      const compressed = older.map((obs) => {
        originalChars += obs.length;
        if (obs.length <= maxChars) {
          compressedChars += obs.length;
          return obs;
        }
        const truncated = obs.slice(0, maxChars) + "…";
        compressedChars += truncated.length;
        return truncated;
      });

      return {
        kept,
        compressed,
        droppedChars: Math.max(0, originalChars - compressedChars),
      };
    },
  });
}
