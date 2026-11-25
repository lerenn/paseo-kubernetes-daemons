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
  PROVIDER_LABELS[id] ?? fallback;

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
