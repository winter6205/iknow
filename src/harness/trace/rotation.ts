import {
  closeSync,
  readdirSync,
  openSync,
  readSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { BLOBS_DIR_NAME } from "../../shared/session-tree-names.js";

export const TRACE_ROTATION_ENV = "IKNOW_TRACE_ROTATION";
export const DEFAULT_TRACE_ROTATION = {
  maxTotalBytes: 500 * 1024 * 1024,
  maxFiles: 100,
  activeWindowMs: 5 * 60 * 1000,
} as const;

export interface TraceRotationOptions {
  readonly maxTotalBytes?: number;
  readonly maxFiles?: number;
  readonly activeWindowMs?: number;
}

interface ManagedFile {
  readonly path: string;
  readonly bytes: number;
  readonly mtimeMs: number;
}

const ERROR_SCAN_CHUNK_BYTES = 64 * 1024;
const ERROR_SCAN_MAX_BYTES = 256 * 1024;
const ERROR_SCAN_MAX_LINES = 1000;

type ErrorScanResult = "error" | "none" | "unknown";

function rotationDisabled(): boolean {
  const value = process.env[TRACE_ROTATION_ENV]?.trim().toLowerCase();
  return value === "off" || value === "false" || value === "0";
}

function listManagedFiles(dir: string): ManagedFile[] {
  const files: ManagedFile[] = [];
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // EXIT: a missing or inaccessible trace directory has nothing to rotate.
    return files;
  }

  for (const entry of entries) {
    const path = join(dir, entry.name);
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      addFile(files, path);
      continue;
    }
    if (entry.isDirectory() && entry.name === "stderr") {
      listDirectoryFiles(files, path, (name) => name.endsWith(".log"));
    }
  }
  return files;
}

function listDirectoryFiles(
  files: ManagedFile[],
  dir: string,
  include: (name: string) => boolean
): void {
  let entries: Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    // EXIT: an inaccessible trace subdirectory cannot contribute candidates.
    return;
  }
  for (const entry of entries) {
    if (entry.isFile() && include(entry.name)) {
      addFile(files, join(dir, entry.name));
    }
  }
}

function addFile(files: ManagedFile[], path: string): void {
  try {
    const stat = statSync(path);
    files.push({ path, bytes: stat.size, mtimeMs: stat.mtimeMs });
  } catch {
    // EXIT: a file may disappear while the directory is being inspected.
  }
}

function isProtectedFile(path: string): boolean {
  return (
    basename(path) === "subagent.jsonl" ||
    (basename(path).endsWith(".log") && basename(dirname(path)) === "stderr")
  );
}

function isSessionFile(file: ManagedFile): boolean {
  return file.path.endsWith(".jsonl") && !isProtectedFile(file.path);
}

function lineHasErrorStatus(line: string): boolean {
  try {
    const record: unknown = JSON.parse(line);
    return (
      typeof record === "object" &&
      record !== null &&
      "status" in record &&
      record.status === "error"
    );
  } catch {
    // EXIT: malformed JSONL is not a status-bearing error record.
    return false;
  }
}

function scanForErrorStatus(file: ManagedFile): ErrorScanResult {
  let descriptor: number;
  try {
    descriptor = openSync(file.path, "r");
  } catch {
    // EXIT: an unreadable candidate is protected from deletion.
    return "unknown";
  }

  const chunk = Buffer.allocUnsafe(ERROR_SCAN_CHUNK_BYTES);
  let bytesRead = 0;
  let linesRead = 0;
  let pending = "";

  try {
    while (
      bytesRead < ERROR_SCAN_MAX_BYTES &&
      linesRead < ERROR_SCAN_MAX_LINES
    ) {
      const amount = Math.min(chunk.length, ERROR_SCAN_MAX_BYTES - bytesRead);
      const count = readSync(descriptor, chunk, 0, amount, null);
      if (count === 0) {
        if (pending.length > 0 && linesRead < ERROR_SCAN_MAX_LINES) {
          return lineHasErrorStatus(pending) ? "error" : "none";
        }
        return "none";
      }

      bytesRead += count;
      pending += chunk.toString("utf8", 0, count);
      const lines = pending.split("\n");
      pending = lines.pop() ?? "";
      for (const line of lines) {
        linesRead += 1;
        if (lineHasErrorStatus(line)) return "error";
        if (linesRead >= ERROR_SCAN_MAX_LINES) return "unknown";
      }
    }

    if (file.bytes <= ERROR_SCAN_MAX_BYTES && bytesRead >= file.bytes) {
      return pending.length > 0 && lineHasErrorStatus(pending)
        ? "error"
        : "none";
    }
    return "unknown";
  } catch {
    // EXIT: rotation must not make trace writes fail when scanning races with a writer.
    return "unknown";
  } finally {
    try {
      closeSync(descriptor);
    } catch {
      // EXIT: the descriptor is already unusable; rotation remains best effort.
    }
  }
}

function isActive(file: ManagedFile, now: number, windowMs: number): boolean {
  return now - file.mtimeMs < windowMs;
}

function deleteIfUnchanged(
  file: ManagedFile,
  now: number,
  windowMs: number
): boolean {
  try {
    const current = statSync(file.path);
    if (
      current.mtimeMs !== file.mtimeMs ||
      isActive(
        { path: file.path, bytes: current.size, mtimeMs: current.mtimeMs },
        now,
        windowMs
      )
    ) {
      return false;
    }
    unlinkSync(file.path);
    return true;
  } catch {
    // EXIT: concurrent deletion or filesystem failure leaves this candidate intact.
    return false;
  }
}

function removeOrphanBlobs(
  dir: string,
  retained: readonly ManagedFile[]
): void {
  if (retained.length === 0) return;
  const oldestSessionMtime = Math.min(
    ...retained
      .filter((file) => file.path.endsWith(".jsonl"))
      .map((file) => file.mtimeMs)
  );
  if (!Number.isFinite(oldestSessionMtime)) return;

  const blobsDir = join(dir, BLOBS_DIR_NAME);
  let entries: Dirent[];
  try {
    entries = readdirSync(blobsDir, { withFileTypes: true });
  } catch {
    // EXIT: blob cleanup is optional when the directory is absent or inaccessible.
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(blobsDir, entry.name);
    try {
      if (statSync(path).mtimeMs < oldestSessionMtime) unlinkSync(path);
    } catch {
      // EXIT: best effort blob cleanup must not make trace writes fail.
    }
  }
}

export function maybeRotate(
  dir: string,
  options: TraceRotationOptions = {}
): void {
  if (rotationDisabled()) return;

  const maxTotalBytes =
    options.maxTotalBytes ?? DEFAULT_TRACE_ROTATION.maxTotalBytes;
  const maxFiles = options.maxFiles ?? DEFAULT_TRACE_ROTATION.maxFiles;
  const activeWindowMs =
    options.activeWindowMs ?? DEFAULT_TRACE_ROTATION.activeWindowMs;
  if (
    !Number.isFinite(maxTotalBytes) ||
    maxTotalBytes < 0 ||
    !Number.isFinite(maxFiles) ||
    maxFiles < 0
  ) {
    return;
  }

  let files = listManagedFiles(dir);
  let totalBytes = files.reduce((sum, file) => sum + file.bytes, 0);
  const now = Date.now();
  const candidates = files
    .filter(
      (file) => isSessionFile(file) && !isActive(file, now, activeWindowMs)
    )
    .sort(
      (left, right) => left.bytes - right.bytes || left.mtimeMs - right.mtimeMs
    );

  for (const file of candidates) {
    if (files.length <= maxFiles && totalBytes <= maxTotalBytes) break;
    if (scanForErrorStatus(file) !== "none") continue;
    if (!deleteIfUnchanged(file, now, activeWindowMs)) continue;
    files = files.filter((current) => current.path !== file.path);
    totalBytes -= file.bytes;
  }

  removeOrphanBlobs(dir, files);
}
