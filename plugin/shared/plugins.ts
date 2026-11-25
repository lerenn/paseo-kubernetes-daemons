import { sha256Hex } from "./sha256.js";
import type { Plugin } from "./settings.js";

export const pluginKey = (p: Pick<Plugin, "source" | "ref">) => p.source + "\0" + p.ref;
// Content digest of what the pod receives; independent of the installation owner.
export const pluginDigest = (p: Pick<Plugin, "source" | "ref" | "env">) =>
  sha256Hex(JSON.stringify([p.source, p.ref, Object.entries(p.env).sort(([a], [b]) => (a < b ? -1 : 1))])).slice(0, 20);
export type PluginState = "synced" | "out-of-date" | "not-synced";
export function pluginState(p: Plugin): PluginState {
  if (!p.synced) return "not-synced";
  return p.synced.digest === pluginDigest(p) ? "synced" : "out-of-date";
}
export interface PluginEntry {
  source: string;
  ref?: string;
  configSecret?: string;
}
// Enabled, synced plugins in the shape of the catalog entries and spec.bootstrap.plugins. A plugin that
// was never synced is left out. `fresh` holds Secret names written in this run (they win over settings).
export function pluginEntries(
  plugins: Plugin[],
  fresh: Record<string, { secret?: string }> = {},
): PluginEntry[] {
  const out: PluginEntry[] = [];
  for (const p of plugins) {
    if (!p.enabled) continue;
    const names = fresh[pluginKey(p)] ?? p.synced;
    if (!names) continue;
    out.push({
      source: p.source,
      ...(p.ref ? { ref: p.ref } : {}),
      ...(names.secret ? { configSecret: names.secret } : {}),
    });
  }
  return out;
}
