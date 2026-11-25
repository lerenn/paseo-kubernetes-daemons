# Design: a "Projects" tab

Status: proposal for review. No code changes. Evidence is cited as `path:line` on `origin/main` (789d0c8).

## 0. Summary

A project becomes a first-class record: **one project = one repository = one credential profile**.
The profile triple (Secret, env Secret, ConfigMap) and its naming stay exactly as today; the plugin
just produces one per project instead of one in total. The gateway **already** supports many
profiles through its catalog, so the gateway/operator/CRD/pod need almost no change.

One important finding: **nothing in this repository writes the gateway catalog**
(`paseo-workspaces-gateway` ConfigMap, key `projects.json`). The gateway only reads it
(`internal/gateway/configuration.go:34-60`, operator RBAC is `get` only at
`charts/paseo-workspaces/templates/operator.yaml:31-35`); `git log -S projects.json` shows only the
gateway commits, and `grep` finds no writer in `plugin/`. With no catalog the gateway reports
"project credentials have not been synced" (`session.go:134`). This must be verified on the live
cluster (someone may create it by hand), but it means the catalog writer is the first deliverable
and also the migration path for existing users.

## 1. Data model

### Today
- One saved `bundle` in plugin settings (`plugin/shared/settings.ts:30`), global `image`, `docker`,
  `ephemeral` (`settings.ts:22,28-29`).
- `sync()` writes `pw-profile-<owner>-<version>` + `-env` Secret + ConfigMap, label
  `workspaces.paseo.sh/profile-owner=<owner>` (`credentials.ts:319-361`). `owner` hashes server id and
  scope; `version` hashes files, env, provider snapshot and controls. The repository URL and trust
  approval live in `bootstrap.json` (`credentials.ts:293-298,361`).
- The gateway derives the project from that ConfigMap: id `prj_<sha256(url)[:16]>`, name from the URL
  basename, root `/__paseo_kubernetes_projects/<id>` (`discovery.go:62-81`).

### Proposal: one profile per project
- **Profile objects:** unchanged layout and names. Add one label to all three objects:
  `workspaces.paseo.sh/project=<id>` where `<id>` is the same 32-hex hash the gateway uses. The version
  hash already includes the repository, so two projects never collide. Name length stays well under
  the 59-char limit (`provision.go:58`): 11 + 16 + 1 + 20 = 48.
- **Project registry (source of truth):** plugin settings, version 1 -> 2 (`settings.ts:33-38`), new
  field `projects: Project[]` next to the existing fields:
  `{ id, repository (URL), path? (daemon checkout), trusted, revision, providers[], mcps[], mcpUrls,
  includeMcpOAuthFile, overrides: { image?, docker?, ephemeral? }, bundle: bundleSchema|null }`.
  `bundle` is the existing per-sync record (name, scope, syncedAt, providers, mcps, repository).
- **Gateway projection (derived, never edited by hand):** the existing catalog ConfigMap,
  with one `ProfileConfiguration` per *synced and approved* project
  (`configuration.go:20-26`): `{profile, image, docker, ephemeral, mainConnection}`. The plugin
  rewrites the whole list from settings with `applyOwned` (so it carries the `profile-owner` label that
  `Load` requires, `configuration.go:42`). Single writer, idempotent, no read-modify-write races.
  Limit 100 entries (`configuration.go:46`), which becomes the project limit.
- **Credentials per project:** each project profile carries its own selection (providers, MCPs,
  optional GITHUB_TOKEN), defaulting to the Credentials tab selection. Values still come from the one
  main daemon (`credentials.ts:225-233`), so `GITHUB_TOKEN` has one value but is opted in per project.
  Cost: `auth.json` is duplicated per profile (see risks).
- **Overrides** (`image`, `docker`, `ephemeral`) live only in the catalog entry, not in the profile, so
  editing them needs no re-sync, just a catalog rewrite. `Load` already defaults an empty image
  (`configuration.go:51-53`).

### Migration of the existing single profile (no user action)
- Settings: `projects` defaults to `[]`. On read, if `bundle?.repository` is set and `projects` is empty,
  synthesize one project from it (settings flags become its overrides: current `docker`/`ephemeral`).
  Persist lazily on the next save. A bundle with no repository stays a "no project" bundle and keeps
  working through the direct-environment path (`backend.ts:55-66`).
- Cluster: nothing is renamed. On first `setup.inspect` / attach, if the catalog is absent or stale,
  write it from the synthesized project. Existing profile objects, running pods and direct CRs are
  untouched. The Credentials tab keeps the same selection UI and its "Sync credentials" button keeps
  working (it becomes "sync the default project" until the Projects tab ships).

## 2. Gateway / operator impact

**How a create request picks a project.** The Paseo `workspace.create.request` carries
`source.projectId` (the id the gateway itself advertised in `project.list` / `emptyProjects`,
`discovery.go:85-92`, `directory.go:141-159`) or `source.path` / `source.cwd` equal to the synthetic
root. `Session` resolves it via the catalog: `session.go:480-488` then `discovery()`
(`session.go:120-134`) walks the catalog and returns the matching provisioner. That path is already
multi-profile. `PrepareCreate` rejects a mismatching project or path (`create_request.go:46-54`) and
`Creator` re-checks the repository (`create.go:63-70,88`; `provision.go:172-174`).

**Changes (all small):**
1. *Plugin writes the catalog* (the major missing piece; see section 0). No Go change needed, but add a
   contract test that `Load` parses what the plugin emits.
2. *Blast radius.* `Discover` failure for any one profile aborts the host-wide project list and
   workspace directory (`host_requests.go:25-29`, `directory.go:141-145`), because errors propagate.
   With N projects one deleted/corrupt profile would hide all of them. Change those loops (and
   `Catalog.Load`, `configuration.go:54-56`) to skip and log the broken entry. Required before shipping
   multiple projects.
3. *Duplicate repositories.* `discovery()` returns the first match (`session.go:130`); the plugin must
   enforce unique repository URL per project (the id is derived from the URL).
4. *No CRD change.* `spec.bootstrap` already names the profile per workspace and `workingDirectory` is
   `/workspace/repository` (`provision.go:182-186`; CRD fields at `charts/.../paseoworkspaces.yaml:45-64`).
5. *Pod bootstrap unchanged.* Each pod's init container gets its own profile and clones one repo to
   `/workspace/repository` (`images/workspace/bootstrap.py:64,104`; `controller/workspace.go:141-154`).
   Multiple repositories in one workspace are out of scope.
6. *Provider snapshot / controls* are merged across catalog entries by provider name, last wins
   (`host_requests.go:34-43`). Acceptable; documented as "the last project's snapshot wins".

**Back-compat with v0.2.5.** The plugin catalog is plain JSON that older gateways parse (unknown fields
ignored). Old plugin + new gateway: unchanged behaviour. Profile naming and labels are additive.
Existing workspaces keep their `spec.bootstrap` references (immutable profiles, `setup.md:157`), and
`Targets()` resolves each running workspace's own profile, not the catalog (`target.go:47-57`), so
removing or re-syncing a project cannot orphan or reroute running pods.

## 3. Tab UX (same Card/Badge/Field style as `plugin/client/screen.tsx`)

Add `{ id: "projects", label: "Projects", icon: ... }` to `TABS` (`screen.tsx:41-47`), between
Credentials and Workspaces; the Overview checklist gets a "Projects" step.

- **List** (one row/card per project): name, repository URL, badges `Approved`/`Not approved`,
  `Synced`/`Out of date`/`Not synced`, last sync time, workspace count (count environments whose
  `spec.bootstrap.configMapName` equals the project's current or previous profile; the list RPC needs
  to expose that field). Empty state explains the flow.
- **Add:** two inputs, *Checkout on this daemon* (path; reads `origin`, reuses `sources()`,
  `credentials.ts:87-121`) or *Repository URL* (validated with `repositoryUrl()`, `credentials.ts:70-86`).
  URL-only projects have no project `.codex/config.toml`, so only user-level MCPs are offered; the UI
  says so. Needs a small `sources()` branch for URL without path.
- **Approve:** shows URL, revision, and the MCP names found in the checkout, then sets `trusted`
  (replaces the Credentials-tab checkbox; the server still refuses to export without it,
  `credentials.ts:198-201`).
- **Edit:** revision (validated as today), image, docker, ephemeral, credential selection, MCP URL
  overrides. Image/docker/ephemeral save instantly (catalog only); the rest marks the project "Out of
  date" until synced.
- **Sync:** per project, plus "Sync all". The Credentials tab keeps defaults; "Sync all" reuses them.
- **Remove:** drops the project from settings and the catalog so it disappears from the host picker and
  cannot start new workspaces. **Do not** delete running workspaces or profile objects; running
  workspaces stay reachable (see `target.go:47-57`). The confirm dialog says so and shows the count.
  Profile cleanup stays manual (as `setup.md:157` documents) until the optional GC phase.
- **Private repos:** `GITHUB_TOKEN` stays one value read from the main daemon; each project has a
  checkbox "Use GitHub token" (default on if the repo is `https://github.com/`). SSH origins keep the
  existing image-specific requirement (`setup.md` credentials section).

## 4. Phased plan

| PR | Scope | Tests |
|----|-------|-------|
| 1 | **Catalog writer + silent migration** (plugin only): `catalog.ts` builds `projects.json` from settings (or legacy bundle), applied with `applyOwned`; called after sync and on attach. | Unit: catalog JSON for 0/1/N projects; foreign-owner refusal; Go contract test that `Catalog.Load` parses a plugin fixture. |
| 2 | **Project model + RPCs:** settings v2 `projects`, `projects.list/add/update/approve/remove/sync`, `project` label, URL-only `sources()`, unique-URL rule, workspace count field. | credentials/settings tests: migration from v1 bundle, URL-only bundle, trust gating, labels, size/limit. |
| 3 | **Projects tab UI** + trim repository/trust fields out of Credentials; Overview step; docs/website. | Component smoke via existing patterns; manual run on a cluster. |
| 4 | **Gateway hardening:** skip broken catalog entries (`host_requests.go`, `directory.go`, `configuration.go`), multi-profile create/route tests. | Go tests with two profiles, one deleted; create picks the right profile; `Targets` unaffected by catalog removal. |
| 5 (optional) | Sync all, profile GC (old versions not referenced by a CR or catalog; needs `delete` in `config/plugin-rbac.yaml`), display-name override (needs gateway change). | GC safety tests. |

PR 4 can run in parallel with 2-3 but must merge before 3 is released.

## 5. Risks

- Catalog may be hand-created today; replacing it could drop entries. Mitigation: the plugin only
  overwrites a catalog carrying its own owner label (`applyOwned` already refuses foreign objects,
  `kubernetes.ts:102-140`).
- Duplicated `auth.json` per project: Codex rotates refresh tokens, so pods from different profiles
  could invalidate each other's login (already true across pods of one profile; wider here).
- Project id is a hash of the URL: changing the URL is a different project (history in Paseo does not
  carry over).
- Stale detection needs a stored hash of the selection; otherwise "Out of date" is wrong.
- Catalog is one ConfigMap read per session call; fine at 100 entries.

## 6. Decisions needed from the user

1. **Per-project full profile (recommended)** vs shared credential profile plus a thin project profile
   (needs bootstrap/controller changes to mount two profiles).
2. Confirm the missing catalog writer on the live cluster; ship PR 1 as a standalone fix first?
3. Removing a project: keep profile objects and workspaces (recommended) or offer an explicit
   "also delete workspaces" option?
4. Allow URL-only projects (no project-level MCP config) or require a daemon checkout?
5. Credential selection per project defaults to the Credentials tab (recommended) or must be chosen
   each time?
6. Project display name: derived from the URL (no gateway change) or editable (gateway change)?
7. Does the Credentials tab keep the repository field for one more release, or move it immediately?
