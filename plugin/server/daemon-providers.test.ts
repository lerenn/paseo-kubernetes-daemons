import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeProfile,
  buildProfilePayload,
  isLoopbackUrl,
  listProviderRows,
  profileIds,
} from "./daemon-providers.js";

const entries = [
  { provider: "claude", label: "Claude", enabled: true, models: Array.from({ length: 17 }, (_, i) => ({ id: `m${i}` })) },
  { provider: "codex", label: "Codex", enabled: true, models: Array.from({ length: 8 }, (_, i) => ({ id: `c${i}` })) },
  { provider: "codex-proxy", label: "Codex (Anyshift Proxy)", enabled: true, models: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}` })) },
  { provider: "claude-backup", label: "Claude (Backup)", enabled: true, models: Array.from({ length: 17 }, (_, i) => ({ id: `b${i}` })) },
  { provider: "opencode", label: "OpenCode", enabled: false, models: [] },
  { provider: "pi", label: "Pi", enabled: true, models: [{ id: "x" }] },
];
const providers = {
  claude: { enabled: true },
  "claude-backup": { extends: "claude", label: "Claude (Backup)", env: { ANTHROPIC_API_KEY: "SECRET_A" } },
  "codex-proxy": { extends: "codex", label: "Codex (Anyshift Proxy)", env: { OPENAI_API_KEY: "SECRET_B", OPENAI_BASE_URL: "https://llm-proxy.anyshift.lab.home.lerenn.net/v1" } },
  local: { extends: "codex", env: { OPENAI_BASE_URL: "http://localhost:4000/v1", OPENAI_API_KEY: "SECRET_C" } },
  "codex-backup": { extends: "codex", env: { OPENAI_API_KEY: "SECRET_D", CODEX_HOME: "/home/me/.codex-backup" } },
  bin: { extends: "claude", command: ["/home/me/bin/claude"] },
};
const facts = (ids: string[], claudeOauth = false) => ({ available: new Set(ids), claudeOauth });
const rowsOf = (f = facts(["anthropic-key", "codex-login"]), selected: string[] = [], urls = {}, files: Record<string, string> = {}) =>
  listProviderRows(entries, providers, f, selected, urls, {
    readFile: async (p) => {
      if (p in files) return files[p];
      throw new Error("ENOENT");
    },
  });

test("loopback detection only flags local hosts, not LAN names", () => {
  for (const u of ["http://localhost:1/x", "http://127.0.0.1/", "http://[::1]:80", "http://0.0.0.0", "https://app.localhost"]) assert.ok(isLoopbackUrl(u), u);
  for (const u of ["https://llm-proxy.anyshift.lab.home.lerenn.net/v1", "http://192.168.1.4:8080", "not a url", undefined]) assert.ok(!isLoopbackUrl(u), String(u));
});

test("rows mirror the picker: built-ins then profiles, model counts, disabled hidden", async () => {
  const rows = await rowsOf(facts(["anthropic-key", "codex-login"]), [], {}, { "/home/me/.codex-backup/auth.json": JSON.stringify({ tokens: { access_token: "x" } }) });
  assert.deepEqual(rows.map((r) => [r.providerId, r.kind, r.models]), [
    ["claude", "builtin", 17],
    ["codex", "builtin", 8],
    ["pi", "builtin", 1],
    ["bin", "profile", null],
    ["claude-backup", "profile", 17],
    ["codex-backup", "profile", null],
    ["codex-proxy", "profile", 5],
    ["local", "profile", null],
  ]);
  assert.equal(rows.find((r) => r.providerId === "pi")!.supported, false);
  assert.equal(rows.find((r) => r.providerId === "claude-backup")!.label, "Claude (Backup)");
  // Nothing in a row can carry a secret.
  assert.ok(!JSON.stringify(rows).includes("SECRET_"));
});

test("Claude with only an OAuth login is Missing with a hint; API key makes it Found", async () => {
  const oauth = (await rowsOf(facts([], true))).find((r) => r.providerId === "claude")!;
  assert.equal(oauth.found, false);
  assert.match(oauth.hint!, /subscription login/);
  assert.equal((await rowsOf(facts(["anthropic-key"]))).find((r) => r.providerId === "claude")!.found, true);
});

test("loopback URLs and local binaries and unreadable CODEX_HOME are flagged", async () => {
  const rows = await rowsOf();
  const by = (id: string) => rows.find((r) => r.providerId === id)!;
  assert.deepEqual(by("local").needsUrls, [{ name: "OPENAI_BASE_URL", host: "localhost:4000", override: "" }]);
  assert.deepEqual(by("codex-proxy").needsUrls, []);
  assert.equal(by("bin").found, false);
  assert.equal(by("codex-backup").found, false);
  assert.match(by("codex-backup").hint!, /CODEX_HOME/);
  const withUrl = await rowsOf(facts([]), [], { "local/OPENAI_BASE_URL": "https://proxy.example/v1" });
  assert.equal(withUrl.find((r) => r.providerId === "local")!.needsUrls[0].override, "https://proxy.example/v1");
});

test("profileIds ignores built-in overrides", () => {
  assert.deepEqual(profileIds(providers), ["bin", "claude-backup", "codex-backup", "codex-proxy", "local"]);
  assert.equal(analyzeProfile("x", { extends: "codex", command: ["/usr/bin/codex"] }).localBinary, undefined);
});

test("payload copies secrets, applies URL overrides and refuses unresolved loopback", async () => {
  const read = async (p: string) => {
    if (p === "/home/me/.codex-backup/auth.json") return JSON.stringify({ tokens: { access_token: "A", refresh_token: "R" } });
    throw new Error("ENOENT");
  };
  await assert.rejects(buildProfilePayload(providers, ["profile:local"], {}, "access-only", { readFile: read }), /loopback/);
  await assert.rejects(buildProfilePayload(providers, ["profile:local"], { "local/OPENAI_BASE_URL": "http://127.0.0.1/x" }, "access-only", { readFile: read }), /reachable/);
  const p = await buildProfilePayload(
    providers,
    ["profile:local", "profile:codex-proxy", "profile:codex-backup", "profile:bin", "profile:gone", "anthropic-key"],
    { "local/OPENAI_BASE_URL": "https://proxy.example/v1" },
    "access-only",
    { readFile: read },
  );
  assert.deepEqual(Object.keys(p.profiles).sort(), ["codex-backup", "codex-proxy", "local"]);
  assert.equal((p.profiles.local.provider.env as any).OPENAI_BASE_URL, "https://proxy.example/v1");
  assert.equal((p.profiles["codex-proxy"].provider.env as any).OPENAI_API_KEY, "SECRET_B");
  // CODEX_HOME: local path dropped, auth.json copied access-only.
  assert.equal((p.profiles["codex-backup"].provider.env as any).CODEX_HOME, undefined);
  assert.equal(JSON.parse(p.profiles["codex-backup"].codexAuth!).tokens.refresh_token, "");
  assert.deepEqual(p.skipped.map((s) => s.id).sort(), ["bin", "gone"]);
  assert.deepEqual(Object.keys(p.digests).sort(), Object.keys(p.profiles).sort());
  // The original config object is not mutated.
  assert.equal((providers["codex-backup"].env as any).CODEX_HOME, "/home/me/.codex-backup");
});

test("a profile whose CODEX_HOME auth is unreadable is skipped, not fatal", async () => {
  const none = async () => { throw new Error("ENOENT"); };
  const noKey = { x: { extends: "codex", env: { CODEX_HOME: "/h/.c" } } };
  const p = await buildProfilePayload(noKey, ["profile:x"], {}, "access-only", { readFile: none });
  assert.deepEqual(p.skipped.map((s) => s.id), ["x"]);
  const apiKeyAuth = async () => JSON.stringify({ OPENAI_API_KEY: "SECRET_E" });
  const ok = await buildProfilePayload(providers, ["profile:codex-backup"], {}, "access-only", { readFile: apiKeyAuth });
  assert.deepEqual(Object.keys(ok.profiles), ["codex-backup"]);
});
