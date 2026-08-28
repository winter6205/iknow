import {
  readdirSync,
  statSync,
  unlinkSync,
  type Dirent,
} from "node:fs";
import { join } from "node:path";

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
    // A file may disappear while the directory is being inspected.
  }
}

function isActive(file: ManagedFile, now: number, windowMs: number): boolean {
  return now - file.mtimeMs < windowMs;
}

function deleteIfUnchanged(file: ManagedFile, now: number, windowMs: number): boolean {
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
    return false;
  }
}

function removeOrphanBlobs(dir: string, retained: readonly ManagedFile[]): void {
  if (retained.length === 0) return;
  const oldestSessionMtime = Math.min(
    ...retained
      .filter((file) => file.path.endsWith(".jsonl"))
      .map((file) => file.mtimeMs)
  );
  if (!Number.isFinite(oldestSessionMtime)) return;

  const blobsDir = join(dir, "blobs");
  let entries: Dirent[];
  try {
    entries = readdirSync(blobsDir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(blobsDir, entry.name);
    try {
      if (statSync(path).mtimeMs < oldestSessionMtime) unlinkSync(path);
    } catch {
      // Best effort: rotation must not make trace writes fail.
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
    .filter((file) => !isActive(file, now, activeWindowMs))
    .sort((left, right) => left.mtimeMs - right.mtimeMs);

  for (const file of candidates) {
    if (files.length <= maxFiles && totalBytes <= maxTotalBytes) break;
    if (!deleteIfUnchanged(file, now, activeWindowMs)) continue;
    files = files.filter((current) => current.path !== file.path);
    totalBytes -= file.bytes;
  }

  removeOrphanBlobs(dir, files);
}
