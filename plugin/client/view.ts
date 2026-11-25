// Pure helpers for the Providers and Projects tabs (no React, unit-tested).
import type { Project } from "../shared/settings.js";

export type Tone = "muted" | "success" | "warning";
export const PROVIDER_LABELS: Record<string, string> = {
  "codex-login": "Codex subscription",
  "openai-key": "OpenAI API key",
  "anthropic-key": "Anthropic API key",
  "gemini-key": "Gemini API key",
  "github-token": "GitHub repository access",
};
export const providerLabel = (id: string, fallback = id) =>
  PROVIDER_LABELS[id] ?? (id.startsWith("profile:") ? `${id.slice(8)} (profile)` : fallback);

export const rowStateBadge = (
  state: string,
): { label: string; tone: Tone } | null =>
  state === "synced"
    ? { label: "Synced", tone: "success" }
    : state === "out-of-date"
      ? { label: "Out of date", tone: "warning" }
      : state === "not-synced"
        ? { label: "Not synced", tone: "muted" }
        : state === "unknown"
          ? { label: "Unknown", tone: "muted" }
          : null;

export const projectStateBadge = (
  state: string,
): { label: string; tone: Tone } =>
  state === "synced"
    ? { label: "Synced", tone: "success" }
    : state === "out-of-date"
      ? { label: "Out of date", tone: "warning" }
      : state === "unapproved"
        ? { label: "Unapproved", tone: "warning" }
        : { label: "Not synced", tone: "muted" };

export const providersBadge = (p: { used: number; total: number }, subset: unknown) =>
  subset ? `${p.used} of ${p.total} providers` : "All providers";

// Display name: the last path segment of the repository URL, without ".git".
export function projectName(repository: string) {
  const parts = repository.replace(/\/+$/, "").split(/[/:]/);
  return (parts[parts.length - 1] ?? repository).replace(/\.git$/, "") || repository;
}

export const plural = (n: number, word: string) =>
  `${n} ${word}${n === 1 ? "" : "s"}`;

// Applies sync results to settings.projects. Matched by repository, since the stored id is informational.
export function applySynced(
  projects: Project[],
  results: { repository: string; synced: Project["synced"] }[],
): Project[] {
  return projects.map((p) => {
    const r = results.find((x) => x.repository === p.repository && x.synced);
    return r?.synced ? { ...p, synced: r.synced } : p;
  });
}

export const workspaceCountText = (n: number | null) =>
  n === null ? "workspaces unknown" : plural(n, "workspace");

export function removeCopy(name: string, workspaces: number | null) {
  const running =
    workspaces === null
      ? "Running workspaces"
      : workspaces === 0
        ? "Running workspaces"
        : `${plural(workspaces, "running workspace")}`;
  return `Remove ${name}? This stops new workspaces for it only. ${running} stay${workspaces === 1 ? "s" : ""} untouched and keep working.`;
}

// ---- Pods tab helpers ----
import type { Pods, PodsIssue, PodsOverride } from "../shared/pods.js";

export function formatCores(n: number) {
  if (n >= 1) return `${Math.round(n * 100) / 100} CPU`;
  return `${Math.round(n * 1000)}m CPU`;
}
export function formatBytes(n: number) {
  const units = [["Ti", 1024 ** 4], ["Gi", 1024 ** 3], ["Mi", 1024 ** 2], ["Ki", 1024]] as const;
  for (const [u, f] of units) if (n >= f) return `${Math.round((n / f) * 10) / 10}${u}`;
  return `${n}B`;
}

// First message for a field path (e.g. "compute.cpuLimit"), if any.
export const issueFor = (issues: PodsIssue[], path: string) =>
  issues.find((i) => i.path === path)?.message;

// Empty and unchanged-blank fields mean "use the global value": drop them from an override.
// Returns undefined when nothing is overridden so the project's pod overrides can be removed.
export function cleanOverride(o: PodsOverride | undefined): PodsOverride | undefined {
  const out: Record<string, Record<string, string>> = {};
  for (const group of ["compute", "storage", "docker"] as const) {
    const kept: Record<string, string> = {};
    for (const [k, v] of Object.entries(o?.[group] ?? {})) {
      const s = typeof v === "string" ? v.trim() : "";
      if (s !== "") kept[k] = s;
    }
    if (Object.keys(kept).length) out[group] = kept;
  }
  return Object.keys(out).length ? (out as PodsOverride) : undefined;
}

export const podsEqual = (a: Pods, b: Pods) => JSON.stringify(a) === JSON.stringify(b);

// One sentence on what a single workspace asks for and how many fit the quota (null = unknown).
export function capacityText(
  perPod: { requests: { cpu: number; memory: number }; storage: number },
  fit: number | null,
) {
  const base = `One workspace requests ${formatCores(perPod.requests.cpu)} and ${formatBytes(perPod.requests.memory)} memory${
    perPod.storage > 0 ? `, plus a ${formatBytes(perPod.storage)} volume` : ""
  }.`;
  if (fit === null) return base;
  return `${base} The namespace quota admits about ${plural(fit, "workspace")}.`;
}

// Pending workspaces carry the reason from the controller in status.message.
export function pendingReason(phase: string, message: string) {
  return phase === "Pending" && message ? message : null;
}
export const PENDING_HELP =
  "Quota rejections mean the namespace quota is full: raise it or lower the pod requests. A node-capacity shortfall leaves the pod Pending until nodes free up.";
