import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { DEFAULT_WORKSPACE_IMAGE } from "../shared/settings.js";

test("default workspace image tracks the plugin version", () => {
  const { version } = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(DEFAULT_WORKSPACE_IMAGE, `ghcr.io/lerenn/paseo-workspace:${version}`);
});
