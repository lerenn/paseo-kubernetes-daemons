# Design: a global "Providers" tab and a thin "Projects" tab

Status: proposal for review (revision 2). No code changes. Evidence is `path:line` on `origin/main`
(89fb032 and later). Items marked **[CHANGED]** differ from revision 1, which made each project carry a
full credential profile and kept the Credentials tab.

## 0. Summary

**[CHANGED]** The **Credentials** tab becomes a global **Providers** tab: the user picks once which
providers (Codex login, OpenAI/Anthropic/Gemini keys, `GITHUB_TOKEN`, user-level MCP servers) found on
the main daemon are shared with every Kubernetes workspace. A **Projects** tab then lists thin projects:
repository URL, trust approval, optional image/docker/ephemeral overrides and an optional per-project
subset of the shared providers (off = all). The Repository field moves from Credentials to Projects.

**Recommendation (section 2): keep the pod/controller/CRD/gateway contract unchanged.** Providers are
selected and read once on the daemon; at sync time the plugin writes one ordinary immutable profile
triple *per project* whose contents are `shared providers ∩ project subset` plus that project's
repository. "Synced once" is true from the user's side (one button, one read of the daemon); in the
cluster the result is fanned out to N small profiles. A shared cluster-side provider set (option B)
needs CRD, controller, bootstrap and gateway changes and does not reduce the Codex refresh-token risk;
it stays available as a later migration because the plugin-side model is identical.

**Missing catalog writer (verified on the live cluster).** The catalog ConfigMap
`paseo-workspaces-gateway` (key `projects.json`, read at `internal/gateway/configuration.go:34-60`) is
**not written by anything in this repository** (operator RBAC is `get` only,
`charts/paseo-workspaces/templates/operator.yaml:31-35`; no writer in `plugin/`) and **does not exist on
the cluster**. `Catalog.Load` then returns no provisioners and creation fails with "project credentials
have not been synced" (`session.go:134`). `sync()` even reports `gatewayReady: true`
(`plugin/server/credentials.ts:379`) although nothing the gateway needs was written. Workspace creation
is therefore broken today for every user, independent of this redesign. **Phase 1 is the catalog writer.**

## 1. Data model

### Today
- One saved `bundle` plus global `image`, `docker`, `ephemeral` in plugin settings, schema version 1
  (`plugin/shared/settings.ts:22,28-30,33-38`).
- `sync()` writes `pw-profile-<owner>-<version>` Secret (`files.json`) + `-env` Secret + ConfigMap
  (`bootstrap.json`: repository, trust, providers, mcps, providerSnapshot, providerControls), all
  immutable, label `workspaces.paseo.sh/profile-owner=<owner>` (`credentials.ts:319-371`). `owner` hashes
  server id and scope; `version` hashes files, env, snapshot and controls.
- The gateway derives the project from the profile ConfigMap: id `prj_<sha256(url)[:16]>`, name from the
  URL basename, root `/__paseo_kubernetes_projects/<id>` (`discovery.go:62-81`), and also reads the
  provider snapshot/controls from it (`discovery.go:44-55`).

### Proposal **[CHANGED]**
**Plugin settings (source of truth, version 1 -> 2, `settings.ts:33-38`):**
- `providers`: the shared selection `{ selected: ProviderId[], mcps: string[], mcpUrls, includeMcpOAuthFile,
  revision counter, lastSync: { at, version, error? } }`. Values are never stored; they are re-read from
  the main daemon at each sync (`credentials.ts:210-270`).
- `projects: Project[]`: `{ id, repository, path?, trusted, revision, overrides: { image?, docker?,
  ephemeral? }, providerSubset: ProviderId[] | null (null = all selected), projectMcps: string[],
  synced: { profile, providerVersion, at } | null }`. No secret material, only references and hashes.
- Existing `image`, `docker`, `ephemeral` become the defaults that project overrides fall back to.

**Cluster objects (no layout change):** per project, the same triple
`pw-profile-<owner>-<version>` / `-env` Secrets + ConfigMap, same immutability and `profile-owner`
label. Additive labels on all three:
- `workspaces.paseo.sh/project=<id>` (the gateway's 32-hex URL hash),
- `workspaces.paseo.sh/provider-set=<hash>`: hash of the *selected provider values and controls*
  (`version` already changes with them; the separate label lets the UI tell "providers changed" from
  "project changed" and find all profiles to GC).
Name length stays 48 chars, under the 59-char limit (`provision.go:58`).

**Catalog (derived, never hand edited):** the existing ConfigMap with one `ProfileConfiguration` per
synced and approved project (`configuration.go:20-26`), written whole by the plugin with `applyOwned`
(carries the `profile-owner` label `Load` requires, `configuration.go:42`). Limit 100 projects
(`configuration.go:46`). Overrides live only here, so editing them needs no re-sync.

**Profile contents per project:** `files.json` = `config.toml` (shared MCPs + that project's MCPs + trusted
repo path), `auth.json` if the Codex login is in the project's subset, `.credentials.json` if requested;
env Secret = the subset's API keys and `GITHUB_TOKEN`; ConfigMap = repository, trust, subset names,
snapshot/controls. This is exactly what `bundle()` already produces from a selection
(`credentials.ts:192-300`); the only change is that the selection is derived from the shared set and the
project instead of one form.

**What the project cannot do:** add a credential the Providers tab has not selected. A project subset can
only narrow.

### Fan-out sync
"Sync providers" reads the daemon once, then for every *approved* project builds its bundle, applies the
triples (secrets first, ConfigMap last, same as `credentials.ts:369-371`) and finally rewrites the catalog.
A failure mid-way leaves the catalog on the old profiles, so projects are never half-updated; the UI
reports per-project errors. "Sync project" does the same for a single project. Total size check (`credentials.ts:363-368`) stays per profile.

## 2. Two options for reading providers in the pod

Verified against code; both keep CRDs immutable (`paseoworkspaces.yaml:40-45`).

| | **A: merge at sync time (recommended)** | **B: shared provider set + project profile** |
|---|---|---|
| Cluster objects | N triples, each already contains its provider data | 1 shared provider triple + N thin project profiles (ConfigMap only, plus a project Secret only if per-project files exist) |
| CRD | none: `spec.bootstrap` keeps `secretName/configMapName/envSecretName` (`paseoworkspaces.yaml:61-70`) | add optional `spec.bootstrap.providers {secretName, envSecretName, configMapName}` |
| Controller | none (`controller/workspace.go:141-154`) | mount 2nd Secret + ConfigMap volumes, 2nd `envFrom`, pass `--providers` to init container; validate the new refs |
| `bootstrap.py` | none (`prepare()`, `bootstrap.py:88-140`) | read and merge two `files.json` / `bootstrap.json` (provider data under project, project wins), marker (`:128-140`) must key on both profile names; keep `ALLOWED_FILES` check per source |
| `provision.go` | none: owner-label co-ownership check over Secret + env Secret + ConfigMap (`provision.go:79-96`) and provider/MCP gates (`:97-164`) stay | run the same check on **both** triples, require *equal* owner labels, evaluate provider/MCP gates against the shared set restricted by the project subset, write the extra refs at `:186`, extend `existing()` (`:203-211`) |
| `configuration.go` | none | `ProfileConfiguration` gains `providers` (the shared profile name); `Load` validates it |
| `discovery.go` / `target.go` | none | `Discover` (`discovery.go:44-55`) reads snapshot/controls from the shared set; `Targets` (`target.go:47-57`) needs the second ref from the CR |
| Provider rotation | re-sync rewrites N triples (new versions); running pods unaffected | rewrite 1 shared triple, repoint the catalog; running pods unaffected |
| Partial failure | possible mid fan-out, mitigated by writing the catalog last | none (single object) |
| etcd/Secret volume | N copies of `auth.json`/keys (few KB each, <= 100 projects) | 1 copy |
| Back-compat | complete: old gateway/operator/images work | needs new operator **and** workspace image together; an old operator ignores the new CRD field and pods start with no providers |
| Release risk | plugin only | Go + chart (CRD) + image + plugin, coordinated |

**Codex refresh-token duplication.** Codex rotates refresh tokens. This risk already exists today: every
pod copies `auth.json` into its own `CODEX_HOME` (`bootstrap.py:136-139`), and pods refresh
independently. Neither option adds *pod-level* duplication, and B does not remove it. Option A adds only
stored copies (immutable, never refreshed in cluster), all identical at sync time, so no extra
invalidation arises from storing them. The real mitigation is operational, not structural: re-sync after
re-login on the daemon, and treat `auth.json` as a single-session credential. The Providers row warns
that sharing a Codex *subscription* login across many pods can log some of them out; API keys
(`openai-key`) do not have the problem and the UI should prefer them.

**Recommendation: A.** It delivers the user-visible model (select once, apply to every pod, per-project
narrowing) with plugin-only changes, and it is the only option shippable without a coordinated image and
operator rollout. B pays off only if the project count or Secret volume becomes an issue; because the
plugin model (shared selection + project subset) is identical, switching later is an internal change
with no new UI and no migration for users.

## 3. Gateway / operator impact (Option A)

**How a create request picks a project.** `workspace.create.request` carries `source.projectId` (id the
gateway advertised, `discovery.go:85-92`) or a path equal to the synthetic root; `Session` resolves it
via the catalog (`session.go:480-488`, `discovery()` `session.go:120-134`) to the matching provisioner,
and `Creator` re-checks repository and approval (`create.go:63-88`; `provision.go:172-174`). Already
multi-profile.

**Changes (all small):**
1. **Plugin writes the catalog (new, blocking, see section 0).** Add a Go contract test that `Load`
   parses the plugin's emitted JSON.
2. **Blast radius.** One broken profile aborts the whole host project list and directory
   (`host_requests.go:25-29`, `directory.go:141-145`, `configuration.go:54-56`). Skip and log broken
   entries instead. Required before shipping multiple projects. (Fan-out sync raises the odds of a stale
   profile, so this matters more than in revision 1.)
3. **Unique repository URL per project**, enforced by the plugin; `discovery()` returns the first match.
4. **No CRD, controller, `provision.go` or `bootstrap.py` change.** Profile references stay as in
   `provision.go:182-186`; each pod bootstraps one profile and clones one repository to
   `/workspace/repository` (`bootstrap.py:64,104`).
5. Provider snapshot/controls are merged across catalog entries last-wins (`host_requests.go:34-43`).
   With one shared selection the snapshots are nearly identical (differences only from subsets);
   acceptable.
6. RBAC: `config/plugin-rbac.yaml` already grants `secrets, configmaps: get, create, patch`, enough for
   the catalog (`applyOwned`) and profiles; `delete` is only needed by optional GC.

Back-compat with v0.2.5 and removal semantics are unchanged from revision 1: running workspaces resolve
their own profile (`target.go:47-57`) and are never orphaned by removing a project or re-syncing.

## 4. UX

### Providers tab **[CHANGED]** (replaces Credentials; same Card/Badge/Field style as `screen.tsx`)
- **Find credentials** (existing button, `screen.tsx:742`) scans the main daemon; rows appear for each
  found item. Not found = disabled row with a hint ("log in on the main host").
- **Row:** name, source (Codex login, env var, MCP server), badges `Found`, `Selected`,
  `Synced`/`Out of date`/`Not synced`, last-sync time, short error if the last sync failed.
  Checkbox selects it for all projects.
- **Details (moved from "Advanced credential settings", `screen.tsx:864`):** per row, expandable:
  Codex login: OAuth/file-store note and the refresh-token warning; MCP servers: URL override for
  loopback endpoints, "Include MCP OAuth cache" (`screen.tsx:897`, applies to the whole set); sync
  revision/status. Repository revision (`screen.tsx:871`) moves to the project, not the provider.
- **MCP servers:** user-level servers from `~/.codex/config.toml` are provider rows. Servers defined in a
  repository's `.codex/config.toml` are *project* MCPs, shown in the project's edit panel after
  approval, not here (they only exist with a checkout, see Projects).
- **`GITHUB_TOKEN`:** a normal provider row (`providerEnv`, `credentials.ts:15-19`). It is the only row
  with a per-project effect: a project whose repo is `https://github.com/` shows a "Use GitHub token"
  toggle (default on). SSH origins keep the existing image requirement.
- **Buttons:** one **Sync providers** (fan-out to all approved projects) and the per-project sync on the
  Projects tab. The tab shows "N projects will be updated".

### Projects tab (thin)
- Add `{ id: "projects", label: "Projects" }` to `TABS` (`screen.tsx:41-47`) after Providers; Overview
  gets a "Projects" step.
- **List:** name, repository URL, `Approved`, `Synced`/`Out of date`, providers badge (`All` or `3 of 5`),
  last sync, workspace count (needs `spec.bootstrap.configMapName` exposed by the list RPC).
- **Add:** *Checkout on this daemon* (reads `origin`, reuses `sources()`, `credentials.ts:87-121`) or
  *Repository URL* (`repositoryUrl()`, `credentials.ts:70-86`). URL-only projects get no project MCPs.
- **Approve** shows URL, revision and project MCP names, then sets `trusted` (the server still refuses to
  export without it, `credentials.ts:198-201`). Repository **moves here** from Credentials.
- **Edit:** revision, image, docker, ephemeral (catalog only, instant), provider subset toggle ("Use
  only some providers", off by default), project MCPs and URL overrides.
- **Remove:** drops the project from settings and catalog; never deletes running workspaces or profile
  objects (`target.go:47-57`); confirm dialog states this and shows the count.

## 5. Migration of the existing profile (no user action) **[CHANGED]**
- Settings v1 -> v2 on read: `providers.selected` = the old `bundle.providers`, `providers.mcps` = old
  `bundle.mcps`, OAuth/URLs likewise. If `bundle.repository` is set and `projects` is empty, synthesize
  one project from it (`trusted` = the old approval, `revision`, overrides from the old `docker` and
  `ephemeral`, subset null). A bundle without repository keeps working through the direct-environment path
  (`backend.ts:55-66`) and yields providers but no project. Persist lazily on next save.
- Cluster: nothing renamed or deleted. The old profile object is adopted as that project's current
  profile (label `project=<id>` added only at the next sync). Because the catalog does not exist today, on
  first attach / `setup.inspect` the plugin writes it from the synthesized project, which also **fixes
  workspace creation immediately** for existing users without any click.
- Running pods and direct CRs are untouched. Credentials tab disappears; the same selection shows up on
  Providers pre-ticked.

## 6. Phased plan **[CHANGED]**

| PR | Scope | Tests |
|----|-------|-------|
| 1 | **Catalog writer + silent migration** (plugin only): `catalog.ts` builds `projects.json` from settings or the legacy bundle, `applyOwned` on attach and after sync; stop reporting `gatewayReady` until the catalog exists. Fixes creation for current users. | Unit: JSON for 0/1/N entries; foreign-owner refusal; Go contract test that `Catalog.Load` parses a plugin fixture. |
| 2 | **Settings v2 + sync engine:** `providers` + `projects`, migration, fan-out sync, `project`/`provider-set` labels, subset logic, unique URL, per-project status. RPCs `providers.find/select/sync`, `projects.list/add/update/approve/remove/sync`. | v1 -> v2 migration, subset narrowing, trust gating, fan-out partial failure keeps old catalog, size/limit. |
| 3 | **Gateway hardening:** skip broken entries (`host_requests.go`, `directory.go`, `configuration.go`), multi-profile create/route tests. Parallel with 2, must merge before 4 is released. | Two profiles, one deleted; create picks the right one; `Targets` unaffected by catalog removal. |
| 4 | **UI:** Providers tab (rename + rows + details), Projects tab, Overview steps, docs/website. | Component smoke tests; manual run on a cluster. |
| 5 (optional) | Profile GC by `provider-set`/`project` label (needs `delete` in `config/plugin-rbac.yaml`), editable display name (gateway change), and the Option B migration if secret volume demands it. | GC safety. |

## 7. Risks
- Catalog could be hand-created on other clusters; the plugin only overwrites a catalog carrying its own
  owner label (`applyOwned`, `kubernetes.ts:102-140`).
- Codex refresh-token behaviour (section 2); unchanged pod-level risk, warned in the UI.
- Fan-out partial failure; mitigated by catalog-last and per-project retry.
- A project's id is a hash of its URL; changing the URL makes a new project.
- Stale detection depends on stored `provider-set`/profile hashes.
- Catalog is read once per session call; fine at 100 entries.

## 8. Decisions needed from the user **[CHANGED: list replaced and renumbered]**
1. **Option A (merge into per-project profiles, no operator/image change, recommended)** or B (shared
   cluster provider set; requires coordinated operator + image + CRD release)?
2. Codex subscription login: allow it as a shared provider with the refresh-token warning (recommended) or
   restrict sharing to API keys only?
3. Removing a project: keep profile objects and running workspaces (recommended) or offer an explicit
   "also delete workspaces"?
4. Allow URL-only projects (no project-level MCPs) or require a daemon checkout?
5. Project MCPs from the checkout: selectable per project (recommended) or ignore them and only share
   user-level MCPs?
6. Does a project with no providers selected (subset empty) count as valid (clone-only), or must it have at
   least one?
7. Project display name: derived from the URL (no gateway change) or editable (gateway change, PR 5)?
8. Ship PR 1 (catalog writer) as a standalone 0.2.x fix first (recommended, creation is broken today)?
