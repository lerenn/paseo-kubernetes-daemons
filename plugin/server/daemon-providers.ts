import { readFile, stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";

// The main daemon's provider list as the new-conversation picker shows it: built-in providers plus
// user-defined profiles (custom providers that extend one). Profiles are read from the daemon
// config (`paseo.config.get`), which holds their env, including API keys. Secret values stay in
// this module and in the provider Secret; the rows returned to the panel never contain them.

export const PROFILE_PREFIX = "profile:";
export const profileRefOf = (id: string) => PROFILE_PREFIX + id;
export const profileIdOf = (ref: string) =>
  ref.startsWith(PROFILE_PREFIX) ? ref.slice(PROFILE_PREFIX.length) : null;

export type ProfileDefinition = Record<string, unknown>;
export interface SnapshotEntryLike {
  provider: string;
  label?: string;
  enabled?: boolean;
  status?: string;
  models?: { id: string; isSelectable?: boolean }[];
}
export interface ProfileSources {
  home?: string; // for tests: base of a profile's CODEX_HOME resolution (unused for absolute paths)
  readFile?: (path: string) => Promise<string>;
}

const hostOf = (value: string) => {
  try {
    const u = new URL(value);
    return ["http:", "https:", "ws:", "wss:"].includes(u.protocol) ? u : null;
  } catch {
    return null;
  }
};
export function isLoopbackUrl(value: unknown) {
  if (typeof value !== "string") return false;
  const u = hostOf(value);
  if (!u) return false;
  const h = u.hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h.endsWith(".localhost") || h === "::1" || h === "0.0.0.0" || /^127\./.test(h);
}
// A Codex auth.json holding a subscription login (access token) or an API key.
const usableAuth = (a: any) =>
  (typeof a?.tokens?.access_token === "string" && !!a.tokens.access_token) ||
  (typeof a?.OPENAI_API_KEY === "string" && !!a.OPENAI_API_KEY);
const isAbsolutePath = (v: unknown): v is string => typeof v === "string" && v.startsWith("/");
const envOf = (d: ProfileDefinition) => {
  const e = d.env;
  return e && typeof e === "object" && !Array.isArray(e)
    ? (Object.entries(e).filter(([, v]) => typeof v === "string") as [string, string][])
    : [];
};
const commandHead = (d: ProfileDefinition) =>
  Array.isArray(d.command) && typeof d.command[0] === "string" ? d.command[0] : undefined;

export const urlKey = (id: string, name: string) => `${id}/${name}`;

// Static analysis of a profile definition: what makes it unusable as-is in a pod.
export function analyzeProfile(id: string, d: ProfileDefinition, urls: Record<string, string> = {}) {
  const loopbackUrls = envOf(d)
    .filter(([, v]) => isLoopbackUrl(v))
    .map(([name, v]) => ({
      name,
      host: hostOf(v)!.host,
      override: urls[urlKey(id, name)] ?? "",
    }));
  const codexHome = envOf(d).find(([k, v]) => k === "CODEX_HOME" && isAbsolutePath(v))?.[1];
  const head = commandHead(d);
  return {
    loopbackUrls,
    codexHome,
    // A local binary path cannot exist in the pod image.
    localBinary: isAbsolutePath(head) && !head.startsWith("/usr/") ? head : undefined,
  };
}

export const countModels = (entry?: SnapshotEntryLike, d?: ProfileDefinition) => {
  const fromSnapshot = entry?.models?.filter((m) => m.isSelectable !== false).length;
  if (fromSnapshot) return fromSnapshot;
  const configured = Array.isArray(d?.models) ? d.models.length : undefined;
  return configured ?? null;
};

const isProfile = (d: unknown): d is ProfileDefinition =>
  !!d && typeof d === "object" && typeof (d as ProfileDefinition).extends === "string" && (d as ProfileDefinition).extends !== "";

export function profileIds(providers: Record<string, unknown>) {
  return Object.entries(providers)
    .filter(([id, d]) => /^[A-Za-z0-9_-]{1,64}$/.test(id) && isProfile(d))
    .map(([id]) => id)
    .sort();
}

const BUILTIN_CREDENTIAL: Record<string, string> = { claude: "anthropic-key", gemini: "gemini-key" };

export interface CredentialFacts {
  // Credential ids (codex-login, openai-key, anthropic-key, ...) usable on the main daemon.
  available: Set<string>;
  // A Claude subscription (OAuth) login exists: it cannot be copied to pods.
  claudeOauth: boolean;
}

export interface ProviderRow {
  id: string; // selection ref: a credential id or profile:<id>
  providerId: string;
  label: string;
  kind: "builtin" | "profile";
  base: string;
  models: number | null;
  found: boolean;
  supported: boolean;
  hint?: string;
  needsUrls: { name: string; host: string; override: string }[];
}

// Rows in picker order: built-ins first (config order of the snapshot), then profiles.
export async function listProviderRows(
  entries: SnapshotEntryLike[],
  providers: Record<string, unknown>,
  facts: CredentialFacts,
  selected: string[],
  urls: Record<string, string>,
  src: ProfileSources = {},
): Promise<ProviderRow[]> {
  const read = src.readFile ?? ((p: string) => readFile(p, "utf8"));
  const byId = new Map(entries.map((e) => [e.provider, e]));
  const profiles = new Set(profileIds(providers));
  const rows: ProviderRow[] = [];
  for (const e of entries) {
    if (profiles.has(e.provider) || e.enabled === false) continue;
    const label = e.label || e.provider;
    const models = countModels(e);
    if (e.provider === "codex") {
      const ref = selected.includes("openai-key") && !selected.includes("codex-login")
        ? "openai-key"
        : facts.available.has("codex-login") || !facts.available.has("openai-key")
          ? "codex-login"
          : "openai-key";
      const found = facts.available.has("codex-login") || facts.available.has("openai-key");
      rows.push({ id: ref, providerId: "codex", label, kind: "builtin", base: "codex", models, found, supported: true, needsUrls: [],
        ...(found ? {} : { hint: "No Codex login or OPENAI_API_KEY found on the main daemon." }) });
      continue;
    }
    const credential = BUILTIN_CREDENTIAL[e.provider];
    if (credential) {
      const found = facts.available.has(credential);
      const oauthOnly = e.provider === "claude" && !found && facts.claudeOauth;
      rows.push({ id: credential, providerId: e.provider, label, kind: "builtin", base: e.provider, models, found, supported: true, needsUrls: [],
        ...(found ? {} : { hint: oauthOnly
          ? "Only a Claude subscription login was found. It cannot be copied to pods; set ANTHROPIC_API_KEY on the main daemon."
          : "No ANTHROPIC_API_KEY found on the main daemon." }) });
      continue;
    }
    rows.push({ id: e.provider, providerId: e.provider, label, kind: "builtin", base: e.provider, models, found: false, supported: false, needsUrls: [],
      hint: "Pods cannot use this provider yet." });
  }
  for (const id of profiles) {
    const d = providers[id] as ProfileDefinition;
    if (d.enabled === false) continue;
    const entry = byId.get(id);
    const a = analyzeProfile(id, d, urls);
    let hint: string | undefined;
    let found = true;
    if (a.localBinary) {
      found = false;
      hint = "This profile runs a binary from a local path, which does not exist in pods.";
    } else if (a.codexHome) {
      try {
        const auth = JSON.parse(await read(join(a.codexHome, "auth.json")));
        if (!usableAuth(auth)) throw new Error();
      } catch {
        found = false;
        hint = "The profile's CODEX_HOME has no readable auth.json on the main daemon.";
      }
    }
    rows.push({
      id: profileRefOf(id),
      providerId: id,
      label: typeof d.label === "string" && d.label ? d.label : entry?.label || id,
      kind: "profile",
      base: d.extends as string,
      models: countModels(entry, d),
      found,
      supported: true,
      needsUrls: a.loopbackUrls,
      ...(hint ? { hint } : {}),
    });
  }
  return rows;
}

export interface ProfilePayloadEntry {
  provider: ProfileDefinition;
  codexAuth?: string;
}
export interface ProfilePayload {
  profiles: Record<string, ProfilePayloadEntry>;
  // Selected profiles that could not be exported (row shows Missing with a hint); never fatal.
  skipped: { id: string; reason: string }[];
  // Content hash per exported profile: lets the panel report "Out of date" without secrets.
  digests: Record<string, string>;
}

// Builds the (secret-bearing) payload written to the provider Secret. Unresolved loopback URLs are
// an error (like MCPs): copying them would silently break the profile in pods.
export async function buildProfilePayload(
  providers: Record<string, unknown>,
  selected: string[],
  urls: Record<string, string>,
  codexMode: "access-only" | "refreshing",
  src: ProfileSources = {},
): Promise<ProfilePayload> {
  const read = src.readFile ?? ((p: string) => readFile(p, "utf8"));
  const out: ProfilePayload = { profiles: {}, skipped: [], digests: {} };
  for (const ref of selected) {
    const id = profileIdOf(ref);
    if (!id) continue;
    const d = providers[id];
    if (!isProfile(d)) {
      out.skipped.push({ id, reason: "The profile no longer exists on the main daemon." });
      continue;
    }
    const a = analyzeProfile(id, d, urls);
    if (a.localBinary) {
      out.skipped.push({ id, reason: "The profile uses a local binary path." });
      continue;
    }
    const definition = structuredClone(d) as ProfileDefinition;
    const env = { ...(Object.fromEntries(envOf(d)) as Record<string, string>) };
    for (const l of a.loopbackUrls) {
      const replacement = l.override;
      if (!replacement) throw new Error(`Profile "${id}" points at a loopback address (${l.name}). Enter a URL reachable from pods.`);
      const u = hostOf(replacement);
      if (!u || u.username || u.password || isLoopbackUrl(replacement))
        throw new Error(`The URL override for profile "${id}" must be an HTTP(S) endpoint reachable from pods, without credentials.`);
      env[l.name] = u.toString();
    }
    let codexAuth: string | undefined;
    if (a.codexHome) {
      try {
        const raw = await read(join(a.codexHome, "auth.json"));
        const auth = JSON.parse(raw);
        if (!usableAuth(auth)) throw new Error();
        if (codexMode === "access-only" && auth.tokens) auth.tokens.refresh_token = "";
        codexAuth = JSON.stringify(auth);
      } catch {
        out.skipped.push({ id, reason: "The profile's CODEX_HOME has no readable auth.json." });
        continue;
      }
      // The pod bootstrap points CODEX_HOME at a pod-local directory; never leak the local path.
      delete env.CODEX_HOME;
    }
    if (Object.keys(env).length || "env" in definition) definition.env = env;
    out.profiles[id] = { provider: definition, ...(codexAuth ? { codexAuth } : {}) };
    out.digests[id] = createHash("sha256").update(JSON.stringify(out.profiles[id])).digest("hex").slice(0, 16);
  }
  return out;
}

export async function credentialFacts(available: Set<string>, home = homedir()): Promise<CredentialFacts> {
  let claudeOauth = false;
  try {
    claudeOauth = (await stat(join(home, ".claude", ".credentials.json"))).isFile();
  } catch {
    /* none */
  }
  return { available, claudeOauth };
}
