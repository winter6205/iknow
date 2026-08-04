/**
 * Stateless filesystem-backed session store (022 spec §Session Store).
 *
 * Why stateless: concurrency serialization is the hub's responsibility
 * (spec A15). This class is a thin typed-IO wrapper over data/sessions/*.json.
 * Every failure path throws a typed SessionStoreError — never a bare Error.
 */
import { createHash } from "node:crypto";
import {
  mkdir,
  readFile,
  readdir,
  rename,
  unlink,
  writeFile,
} from "node:fs/promises";
import { basename, join } from "node:path";
import type {
  AnthropicContentBlock,
  AnthropicNativeMessage,
} from "../../harness/index.js";
import type { SessionStoreError } from "./errors.js";
import type { SessionFileV1 } from "./schema.js";
import { sanitizeSessionFile } from "./schema.js";

/** Metadata returned by list(); intentionally excludes messages. */
export interface SessionListEntry {
  readonly conversation_id: string;
  readonly updatedAt: string;
  /** Text excerpt from the most recent assistant turn ("" if none). */
  readonly lastFinalText: string;
  readonly summary: string;
}

/**
 * Project namespace under the shared pool root (spec #120 SC 1).
 *
 * Layout: `<baseDir>/sessions/<basename(cwd)>-<sha1(cwd)[:12]>`.
 * basename keeps it human-browsable; the sha1 suffix disambiguates same-named
 * projects at different paths. Pure: no IO.
 */
export function resolveProjectSessionDir(baseDir: string, cwd: string): string {
  const digest = createHash("sha1").update(cwd).digest("hex").slice(0, 12);
  return join(baseDir, "sessions", `${basename(cwd)}-${digest}`);
}

export class SessionStore {
  private readonly dir: string;

  constructor(baseDir: string, cwd: string = process.cwd()) {
    this.dir = resolveProjectSessionDir(baseDir, cwd);
  }

  /**
   * Load and validate a session file.
   * Throws: not_found | parse_failed | schema_invalid | io_error
   */
  async load(id: string): Promise<SessionFileV1> {
    const raw = await this.readRaw(id);
    const parsed = this.parseJson({ id, raw });
    try {
      return sanitizeSessionFile(parsed);
    } catch (err) {
      // sanitize is pure and lacks store identity; reattach id for the typed contract.
      const field = (err as { field?: string }).field;
      throw {
        kind: "schema_invalid",
        conversation_id: id,
        field: field ?? "root",
      } satisfies SessionStoreError;
    }
  }

  /**
   * Atomic write: tmp file then rename, so a crash never leaves a half-written file.
   * Throws: write_failed
   */
  async save(opts: {
    readonly id: string;
    readonly file: SessionFileV1;
  }): Promise<void> {
    const { id, file } = opts;
    const path = this.filePath(id);
    const tmp = `${path}.tmp`;
    try {
      await mkdir(this.dir, { recursive: true });
      await writeFile(tmp, JSON.stringify(file, null, 2), "utf8");
      await rename(tmp, path);
    } catch (err) {
      throw {
        kind: "write_failed",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  /**
   * List all session files sorted by updatedAt descending.
   * Corrupt / unreadable files are silently skipped (sidebar must not break).
   * Sessions with no assistant text are skipped too (issue #96): bootstrap
   * creates an empty session file before the user ever sends a message, and an
   * interrupted sendMessage can leave one with no assistant reply — neither has
   * anything to show in the sidebar. Single-session load()/get() is unaffected.
   * Throws: io_error (only for directory-level failures)
   */
  async list(): Promise<SessionListEntry[]> {
    const names = await this.readDir();
    const entries: SessionListEntry[] = [];
    for (const name of names) {
      if (!name.endsWith(".json")) continue;
      const entry = await this.tryListEntry(name);
      if (entry) entries.push(entry);
    }
    entries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return entries;
  }

  /**
   * Delete a session file.
   * Throws: not_found | io_error
   */
  async delete(id: string): Promise<void> {
    try {
      await unlink(this.filePath(id));
    } catch (err) {
      if (isEnoent(err)) {
        throw {
          kind: "not_found",
          conversation_id: id,
        } satisfies SessionStoreError;
      }
      throw {
        kind: "io_error",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  // -- private helpers -------------------------------------------------------

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  private async readRaw(id: string): Promise<string> {
    try {
      return await readFile(this.filePath(id), "utf8");
    } catch (err) {
      if (isEnoent(err)) {
        throw {
          kind: "not_found",
          conversation_id: id,
        } satisfies SessionStoreError;
      }
      throw {
        kind: "io_error",
        conversation_id: id,
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  private parseJson(opts: {
    readonly id: string;
    readonly raw: string;
  }): unknown {
    const { id, raw } = opts;
    try {
      return JSON.parse(raw);
    } catch {
      // Excerpt of the raw content aids debugging without leaking full file.
      throw {
        kind: "parse_failed",
        conversation_id: id,
        reason: raw.slice(0, 120),
      } satisfies SessionStoreError;
    }
  }

  private async readDir(): Promise<string[]> {
    try {
      return await readdir(this.dir);
    } catch (err) {
      if (isEnoent(err)) return []; // no sessions yet
      throw {
        kind: "io_error",
        conversation_id: "",
        cause: errMsg(err),
      } satisfies SessionStoreError;
    }
  }

  private async tryListEntry(name: string): Promise<SessionListEntry | null> {
    const id = name.slice(0, -".json".length);
    try {
      const file = await this.load(id);
      const lastFinalText = lastAssistantText(file.messages);
      // issue #96: skip sessions with no assistant text — bootstrap writes an
      // empty file before the user sends anything, and an interrupted
      // sendMessage can leave one with no reply. Nothing to show in the
      // sidebar; single-session load()/get() is unaffected.
      if (!lastFinalText.trim()) return null;
      return {
        conversation_id: id,
        updatedAt: file.updatedAt,
        lastFinalText,
        summary: file.summary,
      };
    } catch {
      return null; // skip corrupt / unreadable files
    }
  }
}

// -- module-level helpers ----------------------------------------------------

function isEnoent(err: unknown): boolean {
  return (
    err instanceof Error && (err as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Extract joined text from the most recent assistant message ("" if none). */
function lastAssistantText(
  messages: ReadonlyArray<AnthropicNativeMessage>
): string {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg.role !== "assistant") continue;
    return msg.content
      .filter(
        (b): b is Extract<AnthropicContentBlock, { type: "text" }> =>
          b.type === "text"
      )
      .map((b) => b.text)
      .join(" ");
  }
  return "";
}
