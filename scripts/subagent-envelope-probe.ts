/**
 * #356 D1 一次性 ajv 兼容性探针 — worker 协议信封 schema 编译结果。
 *
 * - ajv 配置: 与 src/harness/tools/registry.ts 同款 (`strict: true`,
 *   `allErrors: true` + ajv-formats),不引入第二份配置差异。
 * - 编译两组 envelope schema (父→子 / 子→父),各自输出 PASS / FAIL;
 * - 对 result schema 再编译两到三个 fixture 样本来验证校验函数真判。
 *
 * 运行: `npx tsx scripts/subagent-envelope-probe.ts`
 *
 * 这是探针脚本 (非产品 wire),因此允许 console.log。
 */
import {
  PARENT_SCHEMA,
  WORKER_SCHEMA,
  makeEnvelopeAjv,
} from "../src/harness/subagent/envelope.ts";

function tryCompile(label: string, schema: unknown): boolean {
  try {
    const ajv = makeEnvelopeAjv();
    ajv.compile(schema);
    console.log(`PASS  ${label}`);
    return true;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`FAIL  ${label}  reason=${msg}`);
    return false;
  }
}

function tryValidate(
  label: string,
  schema: unknown,
  fixture: unknown,
  expected: boolean
): boolean {
  const ajv = makeEnvelopeAjv();
  const validate = ajv.compile(schema);
  const ok = validate(fixture);
  const pass = ok === expected;
  console.log(
    `${pass ? "PASS" : "FAIL"}  ${label}  expected=${expected} got=${ok}`
  );
  if (!pass) {
    console.log(`      fixture=${JSON.stringify(fixture)}`);
    console.log(`      errors=${JSON.stringify(validate.errors ?? [])}`);
  }
  return pass;
}

console.log("subagent-envelope-probe  (D1 worker envelope ajv compatibility)");

const workerPass = tryCompile("worker envelope schema", WORKER_SCHEMA);
const parentPass = tryCompile("parent envelope schema", PARENT_SCHEMA);

let allPass = workerPass && parentPass;

if (parentPass) {
  // Fixture 1: 合法 ok envelope
  allPass =
    tryValidate(
      "parent fixture: ok envelope",
      PARENT_SCHEMA,
      { status: "ok", summary: "s", result: "r" },
      true
    ) && allPass;

  // Fixture 2: failed with reason = crashed
  allPass =
    tryValidate(
      "parent fixture: failed crashed",
      PARENT_SCHEMA,
      {
        status: "failed",
        reason: "crashed",
        summary: "s",
        result: "r",
      },
      true
    ) && allPass;

  // Fixture 3: 非法缺 status
  allPass =
    tryValidate(
      "parent fixture: missing status",
      PARENT_SCHEMA,
      { summary: "s", result: "r" },
      false
    ) && allPass;
}

if (workerPass) {
  // Fixture 4: 合法 worker envelope
  allPass =
    tryValidate(
      "worker fixture: minimal",
      WORKER_SCHEMA,
      { task: "t", sandboxRoot: "/tmp/sb" },
      true
    ) && allPass;

  // Fixture 5: 缺必填 task
  allPass =
    tryValidate(
      "worker fixture: missing task",
      WORKER_SCHEMA,
      { sandboxRoot: "/tmp/sb" },
      false
    ) && allPass;
}

console.log("");
console.log(allPass ? "probe: all green" : "probe: failures present");
process.exit(allPass ? 0 : 1);
