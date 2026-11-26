// Checks that the four version places agree: plugin/package.json, plugin/package-lock.json,
// charts/paseo-daemons/Chart.yaml (version + appVersion) and DEFAULT_WORKSPACE_IMAGE.
// When a base commit is given and the version changed against it, it must be greater than
// the latest vX.Y.Z tag. Usage: node check-version.mjs [<base-commit>]
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const SEMVER = /^(\d+)\.(\d+)\.(\d+)$/;
const fail = (m) => { console.log(`::error::${m}`); process.exit(1); };
const git = (...a) => execFileSync("git", a, { encoding: "utf8" });
const parse = (v, where) => {
  const m = SEMVER.exec(v ?? "");
  if (!m) fail(`${where}: version "${v}" is not MAJOR.MINOR.PATCH`);
  return m.slice(1).map(Number);
};
const compare = (a, b) => a.map((x, i) => x - b[i]).find((d) => d !== 0) ?? 0;
const grab = (file, re, what) => {
  const m = re.exec(readFileSync(file, "utf8"));
  if (!m) fail(`${file}: cannot find ${what}`);
  return m[1];
};

const pkg = JSON.parse(readFileSync("plugin/package.json", "utf8")).version;
const lock = JSON.parse(readFileSync("plugin/package-lock.json", "utf8"));
const found = {
  "plugin/package.json": pkg,
  "plugin/package-lock.json (version)": lock.version,
  "plugin/package-lock.json (packages[''])": lock.packages?.[""]?.version,
  "Chart.yaml version": grab("charts/paseo-daemons/Chart.yaml", /^version: (\S+)$/m, "version"),
  "Chart.yaml appVersion": grab("charts/paseo-daemons/Chart.yaml", /^appVersion: "?([^"\s]+)"?$/m, "appVersion"),
  "DEFAULT_WORKSPACE_IMAGE": grab("plugin/shared/settings.ts", /DEFAULT_WORKSPACE_IMAGE = "[^"]*:([^":]+)"/, "DEFAULT_WORKSPACE_IMAGE tag"),
};
const bad = Object.entries(found).filter(([, v]) => v !== pkg);
if (bad.length) fail(`versions differ from plugin/package.json (${pkg}): ${bad.map(([k, v]) => `${k}=${v}`).join(", ")}`);
const head = parse(pkg, "plugin/package.json");

const base = process.argv[2];
if (!base) { console.log(`Versions aligned at ${pkg}.`); process.exit(0); }

const baseVersion = JSON.parse(git("show", `${base}:plugin/package.json`)).version;
if (baseVersion === pkg) { console.log(`Versions aligned at ${pkg}, unchanged vs base.`); process.exit(0); }

const tags = git("tag", "--list", "v*.*.*").split("\n").map((t) => SEMVER.exec(t.slice(1))).filter(Boolean).map((m) => m.slice(1).map(Number));
const latest = tags.sort(compare).pop();
if (latest && compare(head, latest) <= 0) fail(`version ${pkg} is not greater than the latest tag v${latest.join(".")}`);
console.log(`Version bumped ${baseVersion} -> ${pkg} (latest tag ${latest ? "v" + latest.join(".") : "none"}).`);
