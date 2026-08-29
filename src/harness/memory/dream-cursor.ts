/**
 * Per-memoryDir cursor for the dream dual gate (24h ∧ 5 sessions).
 *
 * Gate state lives in `dream.json` (specs/auto-memory-layering.md); the
 * module keeps the historical `dream-cursor` symbol names.
 *
 * Isolated by `memoryDir` so two workspace roots cannot share a clock or
 * session set. Process restart must not lose progress: JSON on disk.
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { MemoryIOError } from "./errors.js";

export const DREAM_CURSOR_FILENAME = "dream.json";
export const DREAM_MIN_INTERVAL_MS = 24 * 60 * 60 * 1000;
export const DREAM_MIN_SESSIONS = 5;

export interface DreamCursor {
  readonly lastSuccessAtMs: number | null;
  readonly sessionIds: readonly string[];
}

export function emptyDreamCursor(): DreamCursor {
  return { lastSuccessAtMs: null, sessionIds: [] };
}

export function recordDreamSession(
  cursor: DreamCursor,
  sessionKey: string | undefined
): DreamCursor {
  if (sessionKey === undefined || sessionKey.length === 0) return cursor;
  if (cursor.sessionIds.includes(sessionKey)) return cursor;
  return { ...cursor, sessionIds: [...cursor.sessionIds, sessionKey] };
}

/** Time gate is open when there has never been a success (null). */
export function dreamGatesMet(cursor: DreamCursor, nowMs: number): boolean {
  const elapsed =
    cursor.lastSuccessAtMs === null
      ? DREAM_MIN_INTERVAL_MS
      : nowMs - cursor.lastSuccessAtMs;
  return (
    elapsed >= DREAM_MIN_INTERVAL_MS &&
    cursor.sessionIds.length >= DREAM_MIN_SESSIONS
  );
}

export function resetDreamCursor(nowMs: number): DreamCursor {
  return { lastSuccessAtMs: nowMs, sessionIds: [] };
}

export async function loadDreamCursor(memoryDir: string): Promise<DreamCursor> {
  const path = join(memoryDir, DREAM_CURSOR_FILENAME);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error: unknown) {
    if (isMissingFile(error)) {
      // EXIT: missing cursor is a fresh window, not a fault.
      return emptyDreamCursor();
    }
    throw new MemoryIOError(`dream cursor: read ${path} failed`, {
      cause: error,
    });
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new MemoryIOError(`dream cursor: parse ${path} failed`, {
      cause: error,
    });
  }
  return parseDreamCursor(parsed);
}

export async function saveDreamCursor(
  memoryDir: string,
  cursor: DreamCursor
): Promise<void> {
  try {
    await mkdir(memoryDir, { recursive: true });
  } catch (error) {
    throw new MemoryIOError(`dream cursor: mkdir ${memoryDir} failed`, {
      cause: error,
    });
  }
  const finalPath = join(memoryDir, DREAM_CURSOR_FILENAME);
  const tmpPath = `${finalPath}.${process.pid}.${Date.now()}.tmp`;
  const body = JSON.stringify({
    lastSuccessAtMs: cursor.lastSuccessAtMs,
    sessionIds: cursor.sessionIds,
  });
  try {
    await writeFile(tmpPath, body, "utf8");
    await rename(tmpPath, finalPath);
  } catch (error) {
    throw new MemoryIOError(`dream cursor: write ${finalPath} failed`, {
      cause: error,
    });
  }
}

function parseDreamCursor(value: unknown): DreamCursor {
  if (value === null || typeof value !== "object") return emptyDreamCursor();
  const rec = value as Record<string, unknown>;
  const last = rec.lastSuccessAtMs;
  const lastSuccessAtMs =
    last === null
      ? null
      : typeof last === "number" && Number.isFinite(last)
        ? last
        : null;
  const ids = rec.sessionIds;
  const sessionIds = Array.isArray(ids)
    ? ids.filter((id): id is string => typeof id === "string" && id.length > 0)
    : [];
  return { lastSuccessAtMs, sessionIds };
}

function isMissingFile(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code: unknown }).code === "ENOENT"
  );
}
