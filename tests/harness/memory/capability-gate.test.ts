/**
 * runtime-capability-memory-gate T2: capability-gate.ts tests.
 *
 * Spec: specs/runtime-capability-memory-gate.md (Classifier fixtures — 合同,
 * 不是实现菜谱). ADR-0086.
 *
 * The gate exists because a recalled capability observation ("web_search is
 * unavailable in this sandbox") outranks the live tool result and stops the
 * model from trying the tool at all. This file pins the fixture semantics:
 * capability / environment-availability text is rejected, product-policy
 * `constraint` and project-convention text still pass.
 *
 * Five boundary classes:
 *   empty      — no capability signal → null (nothing to reject)
 *   negative   — the spec's MUST-reject fixtures, including when relabeled
 *   overflow   — an oversized capability body still rejects (SC3)
 *   concurrent — the predicate is pure: repeated calls agree, no IO
 *   exception  — not applicable (total function over strings; no throw path)
 */
import { describe, it } from "vitest";
import assert from "node:assert/strict";

import {
  CAPABILITY_OBSERVATION_REASON,
  detectCapabilityObservation,
} from "../../../src/harness/memory/capability-gate.ts";

describe("detectCapabilityObservation — MUST reject (spec fixtures)", () => {
  const reject: ReadonlyArray<{ label: string; title: string; body: string }> =
    [
      {
        label: "sandbox DNS/SSRF segment makes web_search unavailable",
        title: "web_search is unavailable in this sandbox",
        body: "The sandbox DNS/SSRF benchmarking segment blocks web_search, so web fetch calls fail.",
      },
      {
        label: "no real outbound network, do not call web tools",
        title: "本环境没有真实出网",
        body: "本环境没有真实出网，不要调用 web 工具。",
      },
      {
        label: "web_fetch cannot reach the network here",
        title: "Network access is disabled",
        body: "web_fetch cannot reach the internet from this environment.",
      },
      {
        label: "Chinese unavailable-tool observation",
        title: "沙箱内无法联网",
        body: "沙箱内无法联网，搜索工具不可用。",
      },
    ];

  for (const fixture of reject) {
    it(`rejects: ${fixture.label}`, () => {
      const reason = detectCapabilityObservation({
        title: fixture.title,
        body: fixture.body,
      });
      assert.notEqual(reason, null, "fixture must be rejected");
      assert.equal(typeof reason, "string");
    });
  }

  // The predicate takes title and body only — the draft's `type` is not an
  // input, so no label can reach a different verdict. The type-carrying write
  // seams (`memory_save` with `type: "constraint"`, an extract candidate typed
  // the same) are pinned in tools-save.test.ts / ingest.test.ts against this
  // same predicate.
  it("cannot be bought in by a constraint label — type is not an input", () => {
    const reason = detectCapabilityObservation({
      title: "web_search is unavailable in this sandbox",
      body: "The sandbox blocks outbound network access.",
    });
    assert.notEqual(
      reason,
      null,
      "a capability observation stays rejected however a caller labels it"
    );
  });

  it("exports a stable reason token for the save-path message", () => {
    assert.equal(CAPABILITY_OBSERVATION_REASON, "capability_observation");
  });
});

describe("detectCapabilityObservation — MUST pass (spec fixtures)", () => {
  const pass: ReadonlyArray<{
    label: string;
    title: string;
    body: string;
  }> = [
    {
      label: "product-policy constraint about worktree isolation",
      title: "隔离 ON 时 mutate 须先建 worktree",
      body: "隔离开启时，任何 mutate 类工具调用必须先建立 worktree 再执行。",
    },
    {
      label: "project convention about test commands / directories",
      title: "测试命令与目录习惯",
      body: "跑测试用 npm test；单元测试放 tests/harness，TUI 测试放 tests/tui。",
    },
    {
      label: "unrelated durable fact",
      title: "Use bar() for concurrency",
      body: "bar() is the thread-safe entry point in this repo.",
    },
    {
      label: "a policy that mentions a tool but asserts no availability",
      title: "web_fetch results must be summarized",
      body: "After calling web_fetch, summarize the page in three bullets.",
    },
    {
      label: "retry policy mentioning a failure mode",
      title: "Retry the Anthropic adapter on 529",
      body: "The adapter retries on HTTP 529 before failing the turn.",
    },
  ];

  for (const fixture of pass) {
    it(`passes: ${fixture.label}`, () => {
      assert.equal(
        detectCapabilityObservation({
          title: fixture.title,
          body: fixture.body,
        }),
        null
      );
    });
  }

  it("passes the constraint fixture (type is not an input to the verdict)", () => {
    assert.equal(
      detectCapabilityObservation({
        title: "隔离 ON 时 mutate 须先建 worktree",
        body: "隔离开启时，任何 mutate 类工具调用必须先建立 worktree 再执行。",
      }),
      null
    );
  });
});

// -- ambiguous policy verbs need environment footing --------------------------
//
// `disable` / `block` / `restrict` (and their Chinese equivalents) are also the
// vocabulary of a product rule. A sentence using one of them is a capability
// snapshot only when it also names the environment it describes; without that
// footing — or an intrinsic predicate such as "unavailable" / "cannot reach" —
// it is policy text and must stay writable (spec Assumption 3).

describe("detectCapabilityObservation — policy verbs with and without footing", () => {
  const policyPass: ReadonlyArray<{
    label: string;
    title: string;
    body: string;
  }> = [
    {
      label: "CI convention that disables the browser tool",
      title: "CI 中禁用浏览器工具",
      body: "CI 流水线里禁用浏览器工具，本地开发照常使用。",
    },
    {
      label: "production network policy that blocks inbound traffic",
      title: "生产网络策略",
      body: "生产网络策略要求：默认拦截入站，白名单放行。",
    },
    {
      label: "network retry policy that disables an endpoint",
      title: "网络重试策略",
      body: "网络请求失败后重试 3 次，随后禁用该端点。",
    },
    {
      label: "policy restricting the search tool",
      title: "搜索工具使用政策",
      body: "生产环境限制搜索工具的外呼频率。",
    },
    {
      label: "English policy restricting outbound requests",
      title: "Outbound request policy",
      body: "The service blocks outbound requests from the reporting job.",
    },
  ];

  for (const fixture of policyPass) {
    it(`passes: ${fixture.label}`, () => {
      assert.equal(
        detectCapabilityObservation({
          title: fixture.title,
          body: fixture.body,
        }),
        null,
        "a policy sentence with no environment footing must stay writable"
      );
    });
  }

  it("still rejects the footing-marked version of the same sentence", () => {
    assert.notEqual(
      detectCapabilityObservation({
        title: "本环境的网络策略",
        body: "本环境禁用出网，搜索工具不可用。",
      }),
      null,
      "naming this environment turns the same verb into a capability snapshot"
    );
    assert.notEqual(
      detectCapabilityObservation({
        title: "Sandbox outbound policy",
        body: "In this sandbox, outbound network requests are blocked.",
      }),
      null
    );
  });

  // The spec fixture "Network access is disabled" carries no footing of its
  // own — the body's "from this environment" is what makes the pair a
  // snapshot, so the segments must be classified as one document.
  it("rejects the spec's disabled-access fixture via its footing segment", () => {
    assert.notEqual(
      detectCapabilityObservation({
        title: "Network access is disabled",
        body: "web_fetch cannot reach the internet from this environment.",
      }),
      null
    );
  });
});

describe("detectCapabilityObservation — boundary classes", () => {
  // empty: no capability signal at all.
  it("returns null for empty title and body", () => {
    assert.equal(detectCapabilityObservation({ title: "", body: "" }), null);
  });

  // overflow (SC3): an oversized capability body still rejects.
  it("rejects an oversized capability body (SC3 overflow)", () => {
    const filler = "本仓库的约定与说明文字。".repeat(4000);
    const reason = detectCapabilityObservation({
      title: "本环境没有真实出网",
      body: `${filler}\n沙箱禁用出网，网络工具不可用。`,
    });
    assert.notEqual(reason, null, "长正文不得稀释拒写判定");
  });

  // purity: the predicate is a total function over strings.
  it("is pure — repeated calls agree and touch no disk", () => {
    const fixture = {
      title: "web_search is unavailable in this sandbox",
      body: "The sandbox blocks outbound network access.",
    };
    assert.deepEqual(
      detectCapabilityObservation(fixture),
      detectCapabilityObservation(fixture)
    );
  });

  // SC2-empty: the gate is pure — calling it never creates a file.
  it("writes nothing to an empty store (SC2-empty)", async () => {
    const { mkdtemp, readdir, rm } = await import("node:fs/promises");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    const dir = await mkdtemp(join(tmpdir(), "capability-gate-"));
    try {
      detectCapabilityObservation({
        title: "web_search is unavailable in this sandbox",
        body: "The sandbox blocks outbound network access.",
      });
      assert.deepEqual(await readdir(dir), [], "the gate must touch no disk");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("requires both a capability subject and an availability predicate", () => {
    // Predicate only, no capability surface named.
    assert.equal(
      detectCapabilityObservation({
        title: "The lockfile is unavailable",
        body: "Regenerate it before installing.",
      }),
      null
    );
    // Subject only, no availability claim.
    assert.equal(
      detectCapabilityObservation({
        title: "Use the browser tool for UI checks",
        body: "Playwright drives the web UI for acceptance.",
      }),
      null
    );
  });
});
