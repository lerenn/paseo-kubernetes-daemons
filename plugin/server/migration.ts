import { scopeOf, type Configuration } from "../shared/settings.js";
import {
  buildCatalog,
  effectiveProjects,
  readCatalog,
  writeCatalog,
  type SyncedNames,
} from "./catalog.js";
import { ownerOf, type ProviderSelection } from "./credentials.js";
import {
  splitAll,
  type ProjectResult,
  type ProviderContext,
  type Status,
  type SyncDeps,
} from "./sync.js";

export type MigrationDeps = SyncDeps;
export type { ProviderContext, Status };

// The legacy bundle (or the saved providers selection) as the shared provider selection.
export function selectionOf(c: Configuration): ProviderSelection | null {
  const b = c.bundle;
  if (b && b.scope === scopeOf(c))
    return {
      providers: b.providers as ProviderSelection["providers"],
      mcps: b.mcps,
      mcpUrls: c.providers.mcpUrls,
      includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
      codexMode: c.providers.codexMode,
    };
  if (c.providers.selected.length || c.providers.mcps.length)
    return {
      providers: c.providers.selected,
      mcps: c.providers.mcps,
      mcpUrls: c.providers.mcpUrls,
      includeMcpOAuthFile: c.providers.includeMcpOAuthFile,
      codexMode: c.providers.codexMode,
    };
  return null;
}

// Runs after the operator upgrade, from setup.inspect. Idempotent and never throws: the catalog
// ends up with synced entries when the split succeeds, with legacy entries otherwise. The catalog is
// always written last, so a partial failure keeps the previous one. Settings are not written here
// (the server cannot); the cluster catalog is the state that marks a project as split.
export interface SplitOutcome {
  providerSet: { name: string; providers: string[]; mcps: string[]; at: string };
  lastSync: { at: string; version: string };
  projects: ProjectResult[];
}
// Runs after the operator upgrade, from setup.inspect. Idempotent and never throws: the catalog
// ends up with synced entries when the split succeeds, with legacy entries otherwise. The split is
// all-or-nothing (one failing project keeps every legacy entry and is retried at the next check). The
// catalog is always written last, so a partial failure keeps the previous one. Settings are not
// written here (the server cannot): the returned `split` carries the names for the client to save, and
// the cluster catalog is what marks a project as split.
export async function reconcile(
  c: Configuration,
  status: Status,
  deps: MigrationDeps,
  force?: { selection: ProviderSelection },
): Promise<{ migrated: boolean; error?: string; split?: SplitOutcome }> {
  if (status.operator !== "ready") return { migrated: false };
  const owner = ownerOf(deps.serverId, c);
  const projects = effectiveProjects(c).filter((p) => p.trusted);
  const selection = force?.selection ?? selectionOf(c);
  let synced: Record<string, SyncedNames> | undefined;
  let split: SplitOutcome | undefined;
  let error: string | undefined;
  let migrated = false;
  try {
    if (status.crdCurrent && selection && projects.length) {
      const existing = await readCatalog(deps.run);
      const done = existing.some((e) => e.providers);
      if (!done || force) {
        const r = await splitAll(c, selection, deps);
        const failed = r.results.find((x) => x.error);
        if (failed) throw new Error(failed.error);
        synced = r.synced;
        split = {
          providerSet: {
            name: r.set.name,
            providers: r.set.providers,
            mcps: r.set.mcps,
            at: r.at,
          },
          lastSync: { at: r.at, version: r.set.name },
          projects: r.results,
        };
        migrated = true;
      } else {
        return { migrated: false };
      }
    }
  } catch (e) {
    synced = undefined;
    split = undefined;
    migrated = false;
    error = e instanceof Error ? e.message : "The provider split failed.";
  }
  try {
    await writeCatalog(
      deps.run,
      owner,
      c.namespace,
      buildCatalog(c, { crdCurrent: status.crdCurrent, synced }),
    );
  } catch (e) {
    error ??= e instanceof Error ? e.message : "The catalog could not be written.";
  }
  return { migrated, ...(split ? { split } : {}), ...(error ? { error } : {}) };
}
