import test from "node:test";
import assert from "node:assert/strict";
import { discoverLocal, type DaemonProject } from "./projects.js";
import { settingsSchema } from "../shared/settings.js";
import { projectId } from "./credentials.js";

const d = (path: string, kind: DaemonProject["projectKind"] = "git", custom?: string): DaemonProject => ({
  projectId: path,
  projectDisplayName: path.split("/").pop()!,
  projectCustomName: custom ?? null,
  projectRootPath: path,
  projectKind: kind,
});
const origins: Record<string, string> = {
  "/w/a": "https://github.com/o/a.git",
  "/w/a-clone": "https://github.com/o/a.git",
  "/w/b": "git@github.com:o/b.git",
  "/w/cred": "https://user:secret@github.com/o/cred.git",
  "/w/token": "https://tok@github.com/o/token.git",
  "/w/file": "file:///srv/repo.git",
};
const origin = async (p: string) => {
  const o = origins[p];
  if (!o) throw Object.assign(new Error("no origin"), { code: 2, stderr: "error: No such remote" });
  return o;
};
const conf = (projects: unknown[] = []) => settingsSchema.parse({ projects });

test("maps daemon projects to candidates and dedupes by origin", async () => {
  const r = await discoverLocal(conf(), [d("/w/a", "git", "Custom"), d("/w/a-clone"), d("/w/b")], origin);
  assert.equal(r.candidates.length, 2);
  assert.equal(r.candidates[0]!.name, "Custom");
  assert.equal(r.candidates[0]!.id, projectId("https://github.com/o/a.git"));
  assert.equal(r.candidates[0]!.host, "github.com");
  assert.equal(r.candidates[1]!.host, "github.com");
  assert.equal(r.candidates[1]!.status, "not-added");
});
test("skips non-git, no origin, credentials and unsupported schemes without echoing URLs", async () => {
  const r = await discoverLocal(
    conf(),
    [d("/w/dir", "directory"), d("/w/none"), d("/w/cred"), d("/w/token"), d("/w/file")],
    origin,
  );
  assert.deepEqual(r.candidates.map((c) => c.status), Array(5).fill("skipped"));
  assert.match(r.candidates[0]!.reason!, /Not a Git/);
  assert.match(r.candidates[1]!.reason!, /No origin/);
  for (const c of r.candidates.slice(2)) assert.match(c.reason!, /credentials or is not/);
  const dump = JSON.stringify(r);
  assert.ok(!dump.includes("secret") && !dump.includes("tok@") && !dump.includes("file://"));
  assert.ok(r.candidates.every((c) => c.repository === null));
});
test("status joins against the plugin's projects by repository", async () => {
  const synced = { profile: "p", providerSet: "s", at: "t" };
  const c = conf([
    { repository: "https://github.com/o/a.git", trusted: true, synced },
    { repository: "git@github.com:o/b.git" },
  ]);
  const r = await discoverLocal(c, [d("/w/a"), d("/w/b")], origin);
  assert.deepEqual(r.candidates.map((x) => x.status), ["synced", "unapproved"]);
  const c2 = conf([{ repository: "https://github.com/o/a.git", trusted: true }]);
  assert.equal((await discoverLocal(c2, [d("/w/a")], origin)).candidates[0]!.status, "not-synced");
});
test("caps the number of candidates", async () => {
  const many = Array.from({ length: 205 }, (_, i) => d(`/w/x${i}`, "directory"));
  const r = await discoverLocal(conf(), many, origin);
  assert.equal(r.candidates.length, 200);
  assert.equal(r.truncated, true);
});
