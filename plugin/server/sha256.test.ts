import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { test } from "node:test";
import { sha256Hex } from "../shared/sha256.js";

test("sha256Hex matches node:crypto", () => {
  for (const s of ["", "abc", "é€😀", "x".repeat(55), "x".repeat(56), "x".repeat(64), "y".repeat(1000)]) {
    assert.equal(sha256Hex(s), createHash("sha256").update(s).digest("hex"));
  }
});

test("shared/ and client/ import no Node modules", () => {
  for (const dir of ["shared", "client"]) {
    const root = new URL(`../${dir}/`, import.meta.url);
    for (const f of readdirSync(root).filter((n) => /\.tsx?$/.test(n) && !n.endsWith(".test.ts"))) {
      assert.doesNotMatch(readFileSync(new URL(f, root), "utf8"), /from "node:/, `${dir}/${f} imports a node: module`);
    }
  }
});
