import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { parse } from "smol-toml";
import { bundle, discover, sync } from "./credentials.js";
import { syncSelection } from "../shared/contracts.js";
import { settingsSchema, scopeOf } from "../shared/settings.js";
import type { Kubectl } from "./kubernetes.js";
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paseo-sync-test-"));
  const home = join(root, "codex");
  await mkdir(home);
  await writeFile(
    join(home, "auth.json"),
    JSON.stringify({
      tokens: {
        access_token: "PRIVATE_CODEX",
        refresh_token: "PRIVATE_REFRESH",
      },
    }),
  );
  await writeFile(
    join(home, ".credentials.json"),
    JSON.stringify({ test: { access_token: "PRIVATE_OAUTH" } }),
  );
  await writeFile(
    join(home, "config.toml"),
    `[mcp_servers.docs]\nurl="https://docs.example/mcp"\nbearer_token_env_var="DOCS_TOKEN"\n[mcp_servers.private]\nurl="http://localhost:3000/mcp"\nhttp_headers={Authorization="PRIVATE_HEADER"}\n`,
  );
  return {
    root,
    home,
    env: { DOCS_TOKEN: "PRIVATE_DOCS", ANTHROPIC_API_KEY: "PRIVATE_ANTHROPIC" },
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}
test("discovery returns names/availability, never credential values or raw configuration", async () => {
  const f = await fixture();
  try {
    const result = await discover("", f);
    const serialized = JSON.stringify(result);
    assert.ok(!serialized.includes("PRIVATE_"));
    assert.equal(result.mcps[1].needsUrl, true);
    assert.ok(result.providers.find((p) => p.id === "codex-login")?.available);
  } finally {
    await f.cleanup();
  }
});
test("exports only selected credentials and MCP definitions, with explicit OAuth opt-in", async () => {
  const f = await fixture();
  try {
    const result = await bundle(
      syncSelection.parse({ providers: ["codex-login"], mcps: ["docs"] }),
      f,
    );
    assert.match(result.files["auth.json"], /PRIVATE_CODEX/);
    assert.deepEqual(result.environment, { DOCS_TOKEN: "PRIVATE_DOCS" });
    assert.ok(!result.files[".credentials.json"]);
    assert.deepEqual(
      Object.keys(parse(result.files["config.toml"]).mcp_servers as object),
      ["docs"],
    );
    const oauth = await bundle(
      syncSelection.parse({
        providers: [],
        mcps: ["docs"],
        includeMcpOAuthFile: true,
      }),
      f,
    );
    assert.match(oauth.files[".credentials.json"], /PRIVATE_OAUTH/);
  } finally {
    await f.cleanup();
  }
});
test("rejects missing MCP environment and localhost unless a pod URL is provided", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      bundle(syncSelection.parse({ providers: [], mcps: ["docs"] }), {
        ...f,
        env: {},
      }),
      /DOCS_TOKEN/,
    );
    await assert.rejects(
      bundle(syncSelection.parse({ providers: [], mcps: ["private"] }), f),
      /localhost/,
    );
    const result = await bundle(
      syncSelection.parse({
        providers: [],
        mcps: ["private"],
        mcpUrls: { private: "http://mcp.tools.svc:3000/mcp" },
      }),
      f,
    );
    assert.match(result.files["config.toml"], /mcp.tools.svc/);
  } finally {
    await f.cleanup();
  }
});
test("repository checkout requires explicit trust and translates main-host project paths", async () => {
  const f = await fixture();
  try {
    const repo = join(f.root, "repo");
    await mkdir(join(repo, ".codex"), { recursive: true });
    execFileSync("git", ["init", repo], { stdio: "ignore" });
    execFileSync("git", [
      "-C",
      repo,
      "remote",
      "add",
      "origin",
      "https://github.com/example/repo.git",
    ]);
    await writeFile(
      join(repo, ".codex", "config.toml"),
      `[mcp_servers.local]\ncommand="node"\nargs=["server.js"]\ncwd=${JSON.stringify(repo)}\n`,
    );
    await assert.rejects(
      bundle(
        syncSelection.parse({
          providers: [],
          mcps: ["local"],
          repositoryPath: repo,
        }),
        f,
      ),
      /Approve/,
    );
    const data = await bundle(
      syncSelection.parse({
        providers: [],
        mcps: ["local"],
        repositoryPath: repo,
        trustRepository: true,
      }),
      f,
    );
    assert.match(data.files["config.toml"], /\/workspace\/repository/);
    assert.equal(
      data.bootstrap.repository?.url,
      "https://github.com/example/repo.git",
    );
  } finally {
    await f.cleanup();
  }
});
test("sync sends values only in immutable Secrets, never ConfigMaps, CRs or responses", async () => {
  const f = await fixture();
  try {
    const writes: Record<string, unknown>[] = [];
    const run: Kubectl = async (args, input) => {
      if (input) writes.push(input as Record<string, unknown>);
      return "";
    };
    const c = settingsSchema.parse({
      context: "test",
      namespace: "test",
      image: "image",
    });
    const result = await sync(
      c,
      syncSelection.parse({
        providers: ["codex-login", "anthropic-key"],
        mcps: ["docs"],
      }),
      "main-daemon",
      run,
      f,
    );
    assert.equal(writes.length, 3);
    assert.ok(writes.every((o) => o.immutable === true));
    const config = writes.find((o) => o.kind === "ConfigMap")!;
    assert.ok(!JSON.stringify(config).includes("PRIVATE_"));
    const bootstrap = JSON.parse((config.data as Record<string, string>)["bootstrap.json"]);
    assert.deepEqual(bootstrap.providers, ["codex-login", "anthropic-key"]);
    assert.ok(!JSON.stringify(result).includes("PRIVATE_"));
    assert.equal(result.scope, scopeOf(c));
    assert.ok(result.name.length + 4 <= 63);
    const second = await sync(
      c,
      syncSelection.parse({
        providers: ["codex-login", "anthropic-key"],
        mcps: ["docs"],
      }),
      "main-daemon",
      run,
      f,
    );
    assert.equal(second.name, result.name);
  } finally {
    await f.cleanup();
  }
});
test("invalid source TOML never includes its contents in an error", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.home, "config.toml"), "PRIVATE_SECRET = @broken");
    await assert.rejects(
      discover("", f),
      (e) => e instanceof Error && !e.message.includes("PRIVATE_SECRET"),
    );
  } finally {
    await f.cleanup();
  }
});
test("subscription login and API billing credentials cannot be selected together", () => {
  assert.equal(
    syncSelection.safeParse({
      providers: ["codex-login", "openai-key"],
      mcps: [],
    }).success,
    false,
  );
});
