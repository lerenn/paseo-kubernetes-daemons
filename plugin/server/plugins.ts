import {
  pluginEnv,
  pluginRef,
  pluginSchema,
  pluginSource,
  type Configuration,
  type Plugin,
} from "../shared/settings.js";
import { pluginDigest, pluginKey, pluginState } from "../shared/plugins.js";
import { applyOwned, type Kubectl } from "./kubernetes.js";
import { OWNER_LABEL, ownerOf } from "./credentials.js";
import { publishCatalog, requireCurrent, type SyncDeps } from "./sync.js";

// Everything here deals in references only: environment values are written to a Secret and never
// appear in a result, an error message or a log line.
const b64 = (v: string) => Buffer.from(v).toString("base64");

function parse<T>(schema: { safeParse: (v: unknown) => { success: boolean; data?: T } }, value: unknown, message: string): T {
  const r = schema.safeParse(value);
  if (!r.success) throw new Error(message);
  return r.data as T;
}

export interface AddInput {
  source: string;
  ref?: string;
  env?: Record<string, string>;
}
export interface UpdateInput {
  source: string;
  ref: string;
  // New pin; changing it makes the plugin "not synced" until the next sync.
  newRef?: string;
  enabled?: boolean;
  // Replaces the whole variable map.
  env?: Record<string, string>;
}

export function addPlugin(c: Configuration, input: AddInput) {
  const plugin = pluginSchema.parse({
    source: parse(pluginSource, input.source, "Invalid plugin source."),
    ref: parse(pluginRef, input.ref ?? "", "Invalid plugin ref."),
    env: parse(pluginEnv, input.env ?? {}, "Invalid plugin environment variables."),
  });
  if (c.plugins.some((p) => pluginKey(p) === pluginKey(plugin)))
    throw new Error("This plugin source and ref are already added.");
  if (c.plugins.length >= 16) throw new Error("At most 16 plugins can be added.");
  return { plugin, plugins: [...c.plugins, plugin] };
}

export function updatePlugin(c: Configuration, input: UpdateInput) {
  const key = input.source + "\0" + input.ref;
  const current = c.plugins.find((p) => pluginKey(p) === key);
  if (!current) throw new Error("Unknown plugin.");
  const ref = input.newRef === undefined ? current.ref : parse(pluginRef, input.newRef, "Invalid plugin ref.");
  const env = input.env === undefined ? current.env : parse(pluginEnv, input.env, "Invalid plugin environment variables.");
  const plugin: Plugin = {
    ...current,
    ref,
    env,
    enabled: input.enabled ?? current.enabled,
    synced: ref === current.ref ? current.synced : null,
  };
  if (c.plugins.some((p) => p !== current && pluginKey(p) === pluginKey(plugin)))
    throw new Error("This plugin source and ref are already added.");
  return { plugin, plugins: c.plugins.map((p) => (p === current ? plugin : p)) };
}

export function removePlugin(c: Configuration, input: { source: string; ref: string }) {
  const key = input.source + "\0" + input.ref;
  if (!c.plugins.some((p) => pluginKey(p) === key)) throw new Error("Unknown plugin.");
  return { plugins: c.plugins.filter((p) => pluginKey(p) !== key) };
}

// Pure view of the saved settings: key names only, never values.
export function pluginsStatus(c: Configuration) {
  return {
    plugins: c.plugins.map((p) => ({
      source: p.source,
      ref: p.ref,
      enabled: p.enabled,
      envKeys: Object.keys(p.env).sort(),
      state: pluginState(p),
      synced: p.synced ? { at: p.synced.at, secret: p.synced.secret } : null,
    })),
  };
}

export const pluginSecretName = (owner: string, digest: string) => `pw-plugin-${owner}-${digest}`;

export interface PluginResult {
  source: string;
  ref: string;
  // Present when this run wrote or confirmed the plugin; the client saves it as plugins[].synced.
  synced: { digest: string; secret?: string; at: string } | null;
  skipped?: "disabled";
  error?: string;
}

// Writes one immutable, content-addressed Secret per enabled plugin that has variables, then the
// catalog. A failing plugin keeps its previous state. The catalog is written last.
export async function syncPlugins(c: Configuration, deps: SyncDeps) {
  const status = await requireCurrent(c, deps.run);
  const owner = ownerOf(deps.serverId, c);
  const at = new Date().toISOString();
  const fresh: Record<string, { secret?: string }> = {};
  const results: PluginResult[] = [];
  for (const p of c.plugins) {
    if (!p.enabled) {
      results.push({ source: p.source, ref: p.ref, synced: null, skipped: "disabled" });
      continue;
    }
    const digest = pluginDigest(p);
    try {
      const secret = Object.keys(p.env).length ? pluginSecretName(owner, digest) : undefined;
      if (secret)
        await writeSecret(deps.run, owner, c.namespace, secret, p.env);
      fresh[pluginKey(p)] = { secret };
      results.push({ source: p.source, ref: p.ref, synced: { digest, ...(secret ? { secret } : {}), at } });
    } catch {
      // Never forward the underlying error: it may quote the Secret's content.
      results.push({ source: p.source, ref: p.ref, synced: null, error: "The plugin configuration could not be written to the cluster." });
    }
  }
  const catalog = await publishCatalog(c, deps, status, undefined, fresh);
  return { plugins: results, catalog };
}

async function writeSecret(run: Kubectl, owner: string, namespace: string, name: string, env: Record<string, string>) {
  await applyOwned(
    run,
    {
      apiVersion: "v1",
      kind: "Secret",
      metadata: {
        name,
        namespace,
        labels: { [OWNER_LABEL]: owner, "workspaces.paseo.sh/kind": "plugin" },
      },
      type: "Opaque",
      immutable: true,
      data: Object.fromEntries(Object.entries(env).map(([k, v]) => [k, b64(v)])),
    },
    owner,
  );
}
