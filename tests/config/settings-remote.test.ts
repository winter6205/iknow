/**
 * `remote` user-layer settings (spec remote-sync §4.5 / §10).
 *
 * Pins:
 *  - absent section → `remote` undefined (no listener, no notifications);
 *  - a legal section is carried verbatim and deep-frozen;
 *  - every illegal field drops alone with one `[settings] remote.` warning while
 *    legal siblings survive; a non-object section is dropped with one warning;
 *  - `remote` stays out of the project allowlist: a project file's section is
 *    ignored with the usual "not in project allowlist" warning and never
 *    overrides user values (a clone cannot enable a listener or redirect notify);
 *  - token placeholder is stored verbatim (never resolved or echoed here);
 *  - url / topic / turnEndMinMs boundaries.
 *
 * Every read uses isolated temp home/cwd pairs; the real `~/.iknow` is never touched.
 */
import { afterAll, beforeAll, describe, it } from "vitest";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadIknowSettings,
  type IknowSettings,
} from "../../src/config/settings.ts";

let workDir: string;
beforeAll(async () => {
  workDir = await mkdtemp(join(tmpdir(), "iknow-settings-remote-"));
});
afterAll(async () => {
  await rm(workDir, { recursive: true, force: true });
});

/** Writes one settings file per layer (user / project), returns isolated opts. */
async function makeSettings(
  user: Record<string, unknown>,
  project: Record<string, unknown> = {}
): Promise<{ home: string; cwd: string }> {
  const home = join(workDir, "home", `${Math.random().toString(36).slice(2)}`);
  const cwd = join(workDir, "cwd", `${Math.random().toString(36).slice(2)}`);
  await mkdir(join(home, ".iknow"), { recursive: true });
  await mkdir(join(cwd, ".iknow"), { recursive: true });
  if (Object.keys(user).length > 0) {
    await writeFile(
      join(home, ".iknow", "settings.json"),
      JSON.stringify(user)
    );
  }
  if (Object.keys(project).length > 0) {
    await writeFile(
      join(cwd, ".iknow", "settings.json"),
      JSON.stringify(project)
    );
  }
  return { home, cwd };
}

/** Loads once through an injected sink so warnings are observable. */
async function loadWithWarnings(
  user: Record<string, unknown>,
  project: Record<string, unknown> = {}
): Promise<{ settings: IknowSettings; warnings: string[] }> {
  const { home, cwd } = await makeSettings(user, project);
  const warnings: string[] = [];
  const settings = loadIknowSettings({
    home,
    cwd,
    onWarn: (m) => warnings.push(m),
  });
  return { settings, warnings };
}

const TOPIC = "iknow-7f3k9q2m";
const NOTIFY = {
  url: "https://notify.example.org",
  topic: TOPIC,
  token: "${IKNOW_NTFY_TOKEN}",
  turnEndMinMs: 30_000,
};

describe("remote — section parsing", () => {
  it("absent section → no remote key", async () => {
    const { settings } = await loadWithWarnings({});
    assert.deepEqual(settings, {});
  });

  it("full valid section parses verbatim and is deep-frozen", async () => {
    const { settings, warnings } = await loadWithWarnings({
      remote: { enabled: true, notify: NOTIFY },
    });
    assert.deepEqual(settings, { remote: { enabled: true, notify: NOTIFY } });
    assert.deepEqual(warnings, []);
    assert.equal(Object.isFrozen(settings.remote), true);
    assert.equal(Object.isFrozen(settings.remote?.notify), true);
  });

  it("enabled false is preserved (explicit off)", async () => {
    const { settings, warnings } = await loadWithWarnings({
      remote: { enabled: false },
    });
    assert.deepEqual(settings, { remote: { enabled: false } });
    assert.deepEqual(warnings, []);
  });

  it("a non-object section is dropped with one warning", async () => {
    for (const bad of [5, "enabled", [], null, true]) {
      const { settings, warnings } = await loadWithWarnings({ remote: bad });
      assert.deepEqual(
        settings,
        {},
        `remote=${JSON.stringify(bad)} should be dropped`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote/);
    }
  });

  it("illegal enabled drops alone, notify survives", async () => {
    for (const bad of ["true", 1, null, {}]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { enabled: bad, notify: NOTIFY },
      });
      assert.deepEqual(
        settings,
        { remote: { notify: NOTIFY } },
        `enabled=${JSON.stringify(bad)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.enabled /);
    }
  });

  it("non-object notify is dropped with one warning, enabled survives", async () => {
    for (const bad of [5, "https://notify.example.org", [], null]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { enabled: true, notify: bad },
      });
      assert.deepEqual(
        settings,
        { remote: { enabled: true } },
        `notify=${JSON.stringify(bad)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify /);
    }
  });
});

describe("remote.notify.url", () => {
  it("https URLs are accepted", async () => {
    for (const url of [
      "https://notify.example.org",
      "https://notify.example.org:8443",
      "https://notify.example.org/ntfy",
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, url } },
      });
      assert.deepEqual(settings, { remote: { notify: { ...NOTIFY, url } } });
      assert.deepEqual(warnings, [], `url=${url}`);
    }
  });

  it("http is accepted only for a loopback host", async () => {
    for (const url of [
      "http://localhost",
      "http://localhost:8080",
      "http://127.0.0.1",
      "http://127.0.0.1:2586",
      "http://[::1]",
      "http://[::1]:2586",
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, url } },
      });
      assert.deepEqual(settings, { remote: { notify: { ...NOTIFY, url } } });
      assert.deepEqual(warnings, [], `url=${url}`);
    }
  });

  it("http for a non-loopback host is rejected", async () => {
    for (const url of [
      "http://notify.example.org",
      "http://localhost.evil.com",
      "http://127.0.0.2",
      "http://[::2]",
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, url } },
      });
      const { url: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `url=${url}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.url /);
    }
  });

  it("malformed / non-http(s) / non-string URLs are rejected", async () => {
    for (const url of [
      "notify.example.org",
      "https://",
      "ftp://notify.example.org",
      "/ntfy",
      "",
      42,
      null,
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, url } },
      });
      const { url: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `url=${JSON.stringify(url)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.url /);
    }
  });

  it("whitespace and control characters are rejected", async () => {
    for (const url of [
      "https://exa mple.org",
      "https://exa\tmple.org",
      "https://notify.example.org\n",
      "https://exa\u0000mple.org",
      "https://exa\u007fmple.org",
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, url } },
      });
      const { url: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `url=${JSON.stringify(url)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.url /);
    }
  });
});

describe("remote.notify.topic", () => {
  it("accepts boundaries 1 and 64 and the full alphabet", async () => {
    for (const topic of ["a", "0", "-", "_", "a".repeat(64), "A_a-09"]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, topic } },
      });
      assert.deepEqual(settings, { remote: { notify: { ...NOTIFY, topic } } });
      assert.deepEqual(warnings, [], `topic=${topic}`);
    }
  });

  it("rejects empty, 65 chars and illegal characters", async () => {
    for (const topic of [
      "",
      "a".repeat(65),
      "a/b",
      "a b",
      "a.b",
      "a:b",
      "tópico",
      42,
      null,
    ]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, topic } },
      });
      const { topic: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `topic=${JSON.stringify(topic)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.topic /);
    }
  });
});

describe("remote.notify.token", () => {
  it("accepts a literal and stores it verbatim", async () => {
    const token = "synthetic-token";
    const { settings, warnings } = await loadWithWarnings({
      remote: { notify: { ...NOTIFY, token } },
    });
    assert.deepEqual(settings, { remote: { notify: { ...NOTIFY, token } } });
    assert.deepEqual(warnings, []);
  });

  it("accepts a ${VAR} placeholder verbatim (never resolved here)", async () => {
    const token = "${IKNOW_NTFY_TOKEN}";
    const { settings, warnings } = await loadWithWarnings({
      remote: { notify: { ...NOTIFY, token } },
    });
    assert.deepEqual(settings, { remote: { notify: { ...NOTIFY, token } } });
    assert.deepEqual(warnings, []);
  });

  it("drops an empty / illegal-placeholder / non-string token without echoing it", async () => {
    for (const token of ["", "   ", "abc${}", 42, null]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, token } },
      });
      const { token: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `token=${JSON.stringify(token)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.token /);
      assert.ok(
        !warnings[0]!.includes("abc"),
        `token value must not be echoed: ${warnings[0]}`
      );
    }
  });
});

describe("remote.notify.turnEndMinMs", () => {
  it("accepts 0 and positive integers", async () => {
    for (const turnEndMinMs of [0, 1, 30_000]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, turnEndMinMs } },
      });
      assert.deepEqual(settings, {
        remote: { notify: { ...NOTIFY, turnEndMinMs } },
      });
      assert.deepEqual(warnings, []);
    }
  });

  it("absent stays undefined (consumer applies the 30000 default)", async () => {
    const { turnEndMinMs: _absent, ...notify } = NOTIFY;
    const { settings, warnings } = await loadWithWarnings({
      remote: { notify },
    });
    assert.deepEqual(settings, { remote: { notify } });
    assert.deepEqual(warnings, []);
    assert.equal(
      Object.hasOwn(settings.remote?.notify ?? {}, "turnEndMinMs"),
      false
    );
  });

  it("drops negative / fractional / non-number values", async () => {
    for (const turnEndMinMs of [-1, 1.5, "30000", null, true]) {
      const { settings, warnings } = await loadWithWarnings({
        remote: { notify: { ...NOTIFY, turnEndMinMs } },
      });
      const { turnEndMinMs: _dropped, ...siblings } = NOTIFY;
      assert.deepEqual(
        settings,
        { remote: { notify: siblings } },
        `turnEndMinMs=${JSON.stringify(turnEndMinMs)}`
      );
      assert.equal(warnings.length, 1, `warnings: ${JSON.stringify(warnings)}`);
      assert.match(warnings[0]!, /^\[settings\] remote\.notify\.turnEndMinMs /);
    }
  });
});

describe("remote — project layer", () => {
  it("a project remote key is ignored with the allowlist warning; user values win", async () => {
    const { settings, warnings } = await loadWithWarnings(
      { remote: { enabled: true, notify: NOTIFY } },
      {
        remote: {
          enabled: false,
          notify: {
            url: "http://localhost:9999",
            topic: "project-topic",
          },
        },
      }
    );
    assert.deepEqual(settings, { remote: { enabled: true, notify: NOTIFY } });
    assert.deepEqual(warnings, [
      '[settings] project settings key "remote" ignored (not in project allowlist)',
    ]);
  });

  it("a project-only remote section yields no remote key", async () => {
    const { settings, warnings } = await loadWithWarnings(
      {},
      { remote: { enabled: true } }
    );
    assert.deepEqual(settings, {});
    assert.deepEqual(warnings, [
      '[settings] project settings key "remote" ignored (not in project allowlist)',
    ]);
  });
});
