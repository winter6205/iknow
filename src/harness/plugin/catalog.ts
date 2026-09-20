/**
 * Plugin component catalog — data plane only (no assembly).
 *
 * `createPluginCatalog` splits `PluginInstallation[]` into three arrays:
 *   - `skillDirs`:  each plugin's `<root>/skills` absolute path;
 *   - `agentDirs`:  each plugin's `<root>/agents` absolute path;
 *   - `hooksFiles`: each plugin's `<root>/hooks/hooks.json` absolute path.
 *
 * Missing subdirectories are skipped (fail-open — one absent component never
 * blocks the others). Dependency direction is one-way:
 * skill/subagent/hooks → plugin; this module imports no consumer.
 * There is no module-level cache: each assembly layer (build-engine / worker)
 * holds its own instance, and repeated calls are idempotent.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { PluginInstallation } from "./roots.js";

/**
 * A hooks.json paired with its owning plugin name. The pairing must come from
 * the data plane because placeholder substitution (`${*_PLUGIN_ROOT}` /
 * `${*_PLUGIN_DATA}`, consumed by `hooks/plugin-hooks.ts`) needs the plugin
 * namespace, which cannot be derived from the file path alone (the same file
 * may be reachable through multiple roots).
 */
export interface PluginHooksEntry {
  /** Absolute path of `<root>/hooks/hooks.json`. */
  readonly file: string;
  /** Owning plugin name: namespace prefix for substitution and plugin-data dirs. */
  readonly plugin: string;
}

/**
 * Union of the three data planes — held by the assembly layer and passed to
 * each consumer on demand. All arrays preserve `plugins` input order and skip
 * plugins whose component path is missing.
 */
export interface PluginCatalog {
  /** Each plugin's `<root>/skills` (absolute); skipped if the dir is missing. */
  readonly skillDirs: ReadonlyArray<string>;
  /** Each plugin's `<root>/agents` (absolute); skipped if the dir is missing. */
  readonly agentDirs: ReadonlyArray<string>;
  /** Each plugin's `<root>/hooks/hooks.json` (absolute); skipped if missing. */
  readonly hooksFiles: ReadonlyArray<string>;
  /** `{file, plugin}` form of `hooksFiles` (same order, same filtering). */
  readonly hooksEntries: ReadonlyArray<PluginHooksEntry>;
}

/**
 * Flatten plugin installations into the three directory/file lists.
 * Synchronous: path joining plus `existsSync` only (roots.ts already did the
 * readdir); downstream consumers do their own scanning.
 */
export function createPluginCatalog(
  installations: ReadonlyArray<PluginInstallation>
): PluginCatalog {
  const skillDirs: string[] = [];
  const agentDirs: string[] = [];
  const hooksFiles: string[] = [];
  const hooksEntries: PluginHooksEntry[] = [];
  for (const plugin of installations) {
    const skillsPath = join(plugin.root, "skills");
    if (existsSync(skillsPath)) skillDirs.push(skillsPath);
    const agentsPath = join(plugin.root, "agents");
    if (existsSync(agentsPath)) agentDirs.push(agentsPath);
    const hooksPath = join(plugin.root, "hooks", "hooks.json");
    if (existsSync(hooksPath)) {
      hooksFiles.push(hooksPath);
      hooksEntries.push({ file: hooksPath, plugin: plugin.name });
    }
  }
  return Object.freeze({
    skillDirs: Object.freeze(skillDirs),
    agentDirs: Object.freeze(agentDirs),
    hooksFiles: Object.freeze(hooksFiles),
    hooksEntries: Object.freeze(hooksEntries.map((e) => Object.freeze(e))),
  });
}
