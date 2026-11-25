import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { buildCatalog, catalogJson, writeCatalog } from "./catalog.js";
import { projectId } from "./credentials.js";
import { settingsSchema, migrateV1, scopeOf } from "../shared/settings.js";
import type { Kubectl } from "./kubernetes.js";

const golden = new URL(
  "../../internal/gateway/testdata/catalog_plugin.json",
  import.meta.url,
);
const project = (repository: string, extra = {}) => ({
  repository,
  trusted: true,
  ...extra,
});
function fixture() {
  const c = settingsSchema.parse({
    namespace: "ns",
    image: "ghcr.io/lerenn/paseo-workspace:0.3.0",
    mainConnection: "main:6767",
    docker: false,
    ephemeral: true,
    projects: [
      project("https://github.com/example/split.git", {
        overrides: { docker: true, ephemeral: false },
        synced: { profile: "pw-profile-o-1", providerSet: "pw-providers-o-2", at: "t" },
      }),
      project("https://github.com/example/legacy.git"),
      project("https://github.com/example/unsynced.git"),
    ],
  });
  c.bundle = {
    name: "pw-profile-o-legacy",
    scope: scopeOf(c),
    syncedAt: "t",
    providers: [],
    mcps: [],
    repository: "https://github.com/example/legacy.git",
    gatewayReady: true,
  };
  return c;
}
test("catalog JSON matches the golden file the Go contract test reads", () => {
  const json = catalogJson(buildCatalog(fixture(), { crdCurrent: true }));
  if (process.env.UPDATE_GOLDEN) {
    mkdirSync(new URL(".", golden), { recursive: true });
    writeFileSync(golden, json);
  }
  assert.equal(json, readFileSync(golden, "utf8"));
  const entries = JSON.parse(json);
  assert.deepEqual(entries[0], {
    profile: "pw-profile-o-1",
    providers: "pw-providers-o-2",
    image: "ghcr.io/lerenn/paseo-workspace:0.3.0",
    docker: true,
    ephemeral: false,
    mainConnection: "main:6767",
  });
  assert.equal(entries.length, 2);
  assert.equal("providers" in entries[1], false);
  assert.equal(entries[1].profile, "pw-profile-o-legacy");
});
test("version gate: providers entries are never emitted with an old CRD", () => {
  const entries = buildCatalog(fixture(), { crdCurrent: false });
  assert.deepEqual(entries.map((e) => e.profile), ["pw-profile-o-legacy"]);
  assert.ok(entries.every((e) => !("providers" in e)));
});
test("a repository can belong to one project only", () => {
  const c = fixture();
  c.projects.push(project("https://github.com/example/legacy.git") as never);
  assert.throws(() => buildCatalog(c, { crdCurrent: true }), /one project/);
});
test("fresh sync names win over saved settings", () => {
  const c = fixture();
  const url = "https://github.com/example/unsynced.git";
  const entries = buildCatalog(c, {
    crdCurrent: true,
    synced: { [projectId(url)]: { profile: "p", providerSet: "s" } },
  });
  assert.ok(entries.some((e) => e.profile === "p" && e.providers === "s"));
});
test("project id matches the gateway derivation (32 hex of sha256)", () => {
  assert.match(projectId("https://github.com/example/x.git"), /^[0-9a-f]{32}$/);
});
test("catalog is only overwritten when it carries our owner label", async () => {
  const calls: string[][] = [];
  const mk = (label: string, exists: string): Kubectl => async (args) => {
    calls.push(args);
    if (args.includes("jsonpath={.metadata.labels.workspaces\\.paseo\\.sh/profile-owner}")) return label;
    if (args.includes("name")) return exists;
    return "";
  };
  await writeCatalog(mk("", ""), "me", "ns", []); // absent: created
  await writeCatalog(mk("me", "configmap/x"), "me", "ns", []); // ours: overwritten
  await assert.rejects(writeCatalog(mk("other", "x"), "me", "ns", []), /another installation/);
  await assert.rejects(writeCatalog(mk("", "configmap/x"), "me", "ns", []), /unmanaged/);
});
test("settings v1 migrate: bundle becomes providers + one project; no repository = providers only", () => {
  const bundle = {
    name: "pw-profile-o-1", scope: "s", syncedAt: "t",
    providers: ["codex-login", "bogus"], mcps: ["docs"],
    repository: "https://github.com/example/r.git", gatewayReady: true,
  };
  const out = settingsSchema.parse(migrateV1({ namespace: "ns", bundle }));
  assert.deepEqual(out.providers.selected, ["codex-login"]);
  assert.deepEqual(out.providers.mcps, ["docs"]);
  assert.equal(out.providers.codexMode, "access-only");
  assert.equal(out.projects.length, 1);
  assert.equal(out.projects[0].repository, bundle.repository);
  assert.equal(out.projects[0].trusted, true);
  assert.equal(out.projects[0].synced, null);
  assert.equal(out.bundle?.name, "pw-profile-o-1");
  const none = settingsSchema.parse(migrateV1({ bundle: { ...bundle, repository: "" } }));
  assert.equal(none.projects.length, 0);
  assert.deepEqual(none.providers.selected, ["codex-login"]);
  assert.equal(settingsSchema.parse(migrateV1({})).projects.length, 0);
});
