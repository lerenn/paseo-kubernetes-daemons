import test from "node:test";
import assert from "node:assert/strict";
import { applySynced, projectName, projectStateBadge, removeCopy, rowStateBadge } from "./view.js";
import { projectSchema } from "../shared/settings.js";

const p = (repository: string) => projectSchema.parse({ repository });
test("applySynced updates only matching repositories with a result", () => {
  const synced = { profile: "x", providerSet: "y", at: "t" };
  const out = applySynced(
    [p("https://github.com/a/b"), p("https://github.com/a/c")],
    [
      { repository: "https://github.com/a/b", synced },
      { repository: "https://github.com/a/c", synced: null },
    ],
  );
  assert.deepEqual(out[0].synced, synced);
  assert.equal(out[1].synced, null);
});
test("badges and names", () => {
  assert.equal(projectName("https://github.com/a/repo.git"), "repo");
  assert.equal(projectName("git@github.com:a/repo"), "repo");
  assert.equal(projectStateBadge("unapproved").tone, "warning");
  assert.equal(rowStateBadge("none"), null);
});
test("remove copy states running workspaces stay", () => {
  assert.match(removeCopy("repo", 2), /2 running workspaces stay untouched/);
  assert.match(removeCopy("repo", 1), /1 running workspace stays untouched/);
});
