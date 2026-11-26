import { applyOwned, type Kubectl } from "./kubernetes.js";
import {
  scopeOf,
  type Configuration,
  type Project,
} from "../shared/settings.js";
import { projectId } from "./credentials.js";
import { pluginEntries, type PluginEntry } from "../shared/plugins.js";
import { catalogPods, mergePods, validatePods, type CatalogPods } from "../shared/pods.js";

export const CATALOG_NAME = "paseo-daemons-gateway";
export const CATALOG_LIMIT = 100;

// Read by internal/gateway/configuration.go (ProfileConfiguration).
export interface CatalogEntry extends Partial<CatalogPods> {
  profile: string;
  providers?: string;
  image: string;
  docker: boolean;
  ephemeral: boolean;
  mainConnection?: string;
  // Plugins every pod daemon installs after it starts; copied into spec.bootstrap.plugins.
  plugins?: PluginEntry[];
}
export interface SyncedNames {
  profile: string;
  providerSet?: string;
}
export interface CatalogOptions {
  // False when the CRD or operator is too old: `providers` fields are never emitted.
  crdCurrent: boolean;
  // Names produced by a sync in this run, keyed by project id; they win over saved settings.
  synced?: Record<string, SyncedNames>;
  // Config Secrets written in this run, keyed by pluginKey.
  plugins?: Record<string, { secret?: string }>;
}

// Saved projects, plus the legacy bundle's repository when settings were not yet split.
export function effectiveProjects(c: Configuration): Project[] {
  const projects = [...c.projects];
  const b = c.bundle;
  if (
    b?.repository &&
    b.scope === scopeOf(c) &&
    !projects.some((p) => p.repository === b.repository)
  )
    projects.push({
      id: "",
      repository: b.repository,
      trusted: true,
      revision: "",
      providerSubset: null,
      projectMcps: [],
      overrides: {},
      synced: null,
    });
  return projects;
}

export function buildCatalog(
  c: Configuration,
  options: CatalogOptions,
): CatalogEntry[] {
  const seen = new Set<string>();
  const entries: CatalogEntry[] = [];
  const plugins = options.crdCurrent ? pluginEntries(c.plugins, options.plugins) : [];
  for (const project of effectiveProjects(c)) {
    if (seen.has(project.repository))
      throw new Error("Each repository can only be used by one project.");
    seen.add(project.repository);
    if (!project.trusted) continue;
    let names: SyncedNames | undefined =
      options.synced?.[projectId(project.repository)] ??
      (project.synced
        ? { profile: project.synced.profile, providerSet: project.synced.providerSet }
        : undefined);
    // Not split yet: the existing full profile (no providers field) keeps working.
    if (
      !names &&
      c.bundle &&
      c.bundle.scope === scopeOf(c) &&
      c.bundle.repository === project.repository
    )
      names = { profile: c.bundle.name };
    if (!names) continue;
    if (names.providerSet && !options.crdCurrent) continue;
    const mainConnection = c.mainConnection;
    const docker = project.overrides.docker ?? c.docker;
    const ephemeral = project.overrides.ephemeral ?? c.ephemeral;
    const pods = mergePods(c.pods, project.overrides.pods);
    const issue = validatePods(pods)[0];
    if (issue)
      throw new Error(`Invalid pod settings for ${project.repository}: ${issue.path}: ${issue.message}`);
    entries.push({
      profile: names.profile,
      ...(names.providerSet ? { providers: names.providerSet } : {}),
      image: project.overrides.image ?? c.image,
      docker,
      ephemeral,
      ...(mainConnection ? { mainConnection } : {}),
      ...(plugins.length ? { plugins } : {}),
      ...catalogPods(pods, docker, ephemeral),
    });
  }
  if (entries.length > CATALOG_LIMIT)
    throw new Error("The gateway catalog supports at most 100 projects.");
  return entries;
}

export const catalogJson = (entries: CatalogEntry[]) =>
  JSON.stringify(entries, null, 2) + "\n";

// Overwrites only a catalog that carries our own owner label; a foreign or unlabelled one is refused.
export async function writeCatalog(
  run: Kubectl,
  owner: string,
  namespace: string,
  entries: CatalogEntry[],
) {
  await applyOwned(
    run,
    {
      apiVersion: "v1",
      kind: "ConfigMap",
      metadata: {
        name: CATALOG_NAME,
        namespace,
        labels: { "daemons.paseo.sh/profile-owner": owner },
      },
      data: { "projects.json": catalogJson(entries) },
    },
    owner,
  );
}

export async function readCatalog(run: Kubectl): Promise<CatalogEntry[]> {
  try {
    const raw = await run([
      "get",
      "configmap",
      CATALOG_NAME,
      "--ignore-not-found",
      "-o",
      "jsonpath={.data.projects\\.json}",
    ]);
    const parsed = raw.trim() ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}
