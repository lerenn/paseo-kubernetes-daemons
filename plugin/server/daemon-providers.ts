import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { join } from "node:path";

// The main daemon's provider list as the new-conversation picker shows it: built-in providers plus
// user-defined profiles (custom providers that extend one). Profiles are read from the daemon
// config (`paseo.config.get`), which holds their env, including API keys. Secret values stay in
// this module and in the provider Secret; the rows returned to the panel never contain them.

// The Claude Code config directory of the main daemon: CLAUDE_CONFIG_DIR, else ~/.claude.
export function claudeDir(o: { claudeHome?: string; env?: NodeJS.ProcessEnv }) {
  const env = o.env ?? process.env;
  return env.CLAUDE_CONFIG_DIR || join(o.claudeHome ?? homedir(), ".claude");
}
// Reads the subscription login from a Claude config directory and returns what pods may receive:
// the claudeAiOauth entry only (never the MCP OAuth cache stored in the same file). Access-only
// blanks the refresh token (key kept; Claude Code accepts an empty one and just stops renewing).
export async function readClaudeLogin(
  dir: string,
  mode: "access-only" | "refreshing",
  read: (file: string) => Promise<string> = (f) => readFile(f, "utf8"),
) {
  const v = JSON.parse(await read(join(dir, ".credentials.json")));
  const oauth = v?.claudeAiOauth;
  if (typeof oauth?.accessToken !== "string" || !oauth.accessToken) throw new Error("No Claude login.");
  const entry = { ...oauth };
  if (mode === "access-only") entry.refreshToken = "";
  return JSON.stringify({ claudeAiOauth: entry });
}
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
  const claudeConfigDir = envOf(d).find(([k, v]) => k === "CLAUDE_CONFIG_DIR" && isAbsolutePath(v))?.[1];
  // A profile that carries its own key or token needs no login file from the config directory.
  const ownClaudeAuth = envOf(d).some(
    ([k, v]) => !!v && ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "CLAUDE_CODE_OAUTH_TOKEN"].includes(k),
  );
  return {
    loopbackUrls,
    codexHome,
    claudeConfigDir,
    ownClaudeAuth,
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

const BUILTIN_CREDENTIAL: Record<string, string> = { gemini: "gemini-key" };
// Claude can reach pods three ways, best first: a long-lived token (`claude setup-token`, valid a
// year, nothing to refresh), the subscription login file, or an API key.
export const CLAUDE_CREDENTIALS = ["claude-token", "claude-login", "anthropic-key"] as const;

export interface CredentialFacts {
  // Credential ids (codex-login, openai-key, anthropic-key, ...) usable on the main daemon.
  available: Set<string>;
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
    if (e.provider === "claude") {
      const chosen = CLAUDE_CREDENTIALS.find((id) => selected.includes(id));
      const ref = chosen ?? CLAUDE_CREDENTIALS.find((id) => facts.available.has(id)) ?? "claude-token";
      const found = facts.available.has(ref);
      const hint = !found
        ? "No Claude login, CLAUDE_CODE_OAUTH_TOKEN or ANTHROPIC_API_KEY found on the main daemon. Run `claude setup-token` and export CLAUDE_CODE_OAUTH_TOKEN, or log in with Claude Code."
        : ref === "claude-login"
          ? "Subscription login: it expires with its access token in pods. A long-lived token (`claude setup-token`, CLAUDE_CODE_OAUTH_TOKEN) is more robust."
          : undefined;
      rows.push({ id: ref, providerId: "claude", label, kind: "builtin", base: "claude", models, found, supported: true, needsUrls: [],
        ...(hint ? { hint } : {}) });
      continue;
    }
    const credential = BUILTIN_CREDENTIAL[e.provider];
    if (credential) {
      const found = facts.available.has(credential);
      rows.push({ id: credential, providerId: e.provider, label, kind: "builtin", base: e.provider, models, found, supported: true, needsUrls: [],
        ...(found ? {} : { hint: "No API key found on the main daemon." }) });
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
    } else if (a.claudeConfigDir && !a.ownClaudeAuth) {
      try {
        await readClaudeLogin(a.claudeConfigDir, "access-only", read);
      } catch {
        found = false;
        hint = "The profile's CLAUDE_CONFIG_DIR has no readable Claude login on the main daemon.";
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
  // {"claudeAiOauth": ...} read from the profile's CLAUDE_CONFIG_DIR.
  claudeAuth?: string;
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
  claudeMode: "access-only" | "refreshing" = "access-only",
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
    let claudeAuth: string | undefined;
    if (a.claudeConfigDir) {
      // The pod bootstrap points CLAUDE_CONFIG_DIR at a pod-local directory; never leak the local path.
      delete env.CLAUDE_CONFIG_DIR;
      try {
        claudeAuth = await readClaudeLogin(a.claudeConfigDir, claudeMode, read);
      } catch {
        if (!a.ownClaudeAuth) {
          out.skipped.push({ id, reason: "The profile's CLAUDE_CONFIG_DIR has no readable Claude login." });
          continue;
        }
      }
    }
    if (Object.keys(env).length || "env" in definition) definition.env = env;
    out.profiles[id] = { provider: definition, ...(codexAuth ? { codexAuth } : {}), ...(claudeAuth ? { claudeAuth } : {}) };
    out.digests[id] = createHash("sha256").update(JSON.stringify(out.profiles[id])).digest("hex").slice(0, 16);
  }
  return out;
}

export async function credentialFacts(available: Set<string>): Promise<CredentialFacts> {
  return { available };
}
