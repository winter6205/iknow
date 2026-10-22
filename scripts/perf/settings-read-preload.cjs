#!/usr/bin/env node
"use strict";
/**
 * Preload for scripts/perf/settings-read.ts (child process).
 *
 * Installs a counting wrapper around `fs.readFileSync` BEFORE any ESM module
 * graph is instantiated, so the wrapper is visible to the ESM named imports
 * (`import { readFileSync } from "node:fs"`) that src/config/settings.ts uses.
 * An in-script patch of the CJS exports object does NOT reach ESM named
 * imports: the built-in module's ESM facade snapshots its exports at first
 * instantiation, so the patch must predate it (verified by probe; see
 * scripts/perf/settings-read.ts header for the full rationale).
 *
 * Counts only reads of `.../.iknow/settings.json` paths so that unrelated
 * reads (tsx loader internals, source-file reads) stay out of the number.
 * The counter is exposed to the child script via `globalThis.__SETTINGS_READ_PROBE`.
 */
const fs = require("node:fs");
const path = require("node:path");

const origReadFileSync = fs.readFileSync;
const suffix = path.join(".iknow", "settings.json");
let count = 0;
fs.readFileSync = function patchedReadFileSync(...args) {
  const target = args[0];
  if (typeof target === "string" && target.endsWith(suffix)) {
    count += 1;
  }
  return origReadFileSync.apply(this, args);
};

globalThis.__SETTINGS_READ_PROBE = {
  get count() {
    return count;
  },
};
