# Design: a global "Providers" tab, thin "Projects" and a "Pods" tab

Status: proposal for review (revision 3). No code changes. Evidence is `path:line` on `origin/main`
(89fb032 and later). **[CHANGED]** marks differences from the previous revision. Decisions taken by the
user: Option B (shared provider set read by every pod), catalog writer bundled with the Projects work,
Docker sidecar + per-project pod overrides + quota/storageclass read access all included.

## 0. Summary

The **Credentials** tab becomes a global **Providers** tab: the user picks once which providers (Codex
login, OpenAI/Anthropic/Gemini keys, `GITHUB_TOKEN`, user-level MCP servers) found on the main daemon
are shared. Projects are thin profiles (repository, trust, image/docker/ephemeral and pod overrides,
optional provider subset). A **Pods** tab holds pod compute/storage/Docker settings.

**[CHANGED] Option B.** The selected providers are written to the cluster **once** as an immutable,
versioned *provider set*. Every created pod references **both** the provider set and its project profile;
the init container merges them. This needs changes in the CRD, controller, bootstrap script and gateway
(section 2 lists them with `file:line`) and a coordinated 0.3.0 release of operator, workspace image,
CRD and plugin.

**Creation is broken today and the first shipped phase fixes it.** The catalog ConfigMap
`paseo-workspaces-gateway` (`projects.json`, read at `internal/gateway/configuration.go:34-60`) is
**not written by anything in this repository** (operator RBAC is `get` only,
`charts/paseo-workspaces/templates/operator.yaml:31-35`; no writer in `plugin/`) and **does not exist on
the cluster** (verified). `Catalog.Load` returns no provisioners and creation fails with "project
credentials have not been synced" (`session.go:134`); `sync()` even reports `gatewayReady: true`
(`plugin/server/credentials.ts:379`). **[CHANGED]** The writer is *not* shipped standalone; it is bundled
with the Projects work, so **the first phase that ships (PR 3 below) contains the catalog writer and the
legacy-profile entry, and fixes creation for existing users the moment it is released.** Earlier PRs are
merge-ready groundwork that is not released on its own.

## 1. Data model **[CHANGED]**

### Today
- One saved `bundle` plus global `image`, `docker`, `ephemeral` in plugin settings v1
  (`plugin/shared/settings.ts:22,28-30,33-38`).
- `sync()` writes `pw-profile-<owner>-<version>` + `-env` Secrets + ConfigMap, all immutable, label
  `workspaces.paseo.sh/profile-owner=<owner>` (`credentials.ts:319-371`). `owner` hashes server id and
  scope; `version` hashes files, env, snapshot and controls. `bootstrap.json` holds repository, trust,
  providers, mcps, providerSnapshot, providerControls.
- The gateway derives the project from that ConfigMap (`discovery.go:62-81`) and reads the provider
  snapshot/controls from it (`discovery.go:44-55`).

### Plugin settings (source of truth, v1 -> v2, `settings.ts:33-38`)
- `providers`: `{ selected: ProviderId[], mcps, mcpUrls, includeMcpOAuthFile, codexMode, lastSync: {at,
  version, error?} }`. No values stored; re-read from the main daemon at each sync (`credentials.ts:210-270`).
- `projects: Project[]`: `{ id, repository, path?, trusted, revision, providerSubset: ProviderId[] | null,
  projectMcps, overrides: { image?, docker?, ephemeral?, pods? }, synced: { profile, providerSet, at } | null }`.
- `pods` defaults (section 6). `image`, `docker`, `ephemeral` remain the defaults for overrides.

### Cluster resource layout
All objects immutable, content-addressed, same `profile-owner=<owner>` label (one owner per server id +
scope, `credentials.ts:319-322`), created with `applyOwned` (`kubernetes.ts:102-140`).

| Object | Name | Holds | Extra labels |
|---|---|---|---|
| **Provider set** Secret | `pw-providers-<owner>-<ver>` | `files.json`: `auth.json` (Codex login), `.credentials.json` (OAuth cache), `config.toml` (stores = file, user-level MCP definitions) | `workspaces.paseo.sh/kind=providers` |
| Provider set env Secret | `pw-providers-<owner>-<ver>-env` | API keys, `GITHUB_TOKEN`, MCP env vars | same |
| Provider set ConfigMap | `pw-providers-<owner>-<ver>` | `providers.json`: selected ids, MCP names, providerSnapshot, providerControls | same |
| **Project profile** Secret | `pw-profile-<owner>-<ver>` | `files.json`: project-only `config.toml` fragment (trusted path, project MCPs); always present | `kind=project`, `workspaces.paseo.sh/project=<id>` |
| Project env Secret | `pw-profile-<owner>-<ver>-env` | project-only vars (usually empty) | same |
| Project ConfigMap | `pw-profile-<owner>-<ver>` | `bootstrap.json`: repository, revision, trust, `providers` subset (absent = all), `mcps` subset | same |

`<ver>` = first 20 hex of the sha256 of the object's content (as `credentials.ts:323-326`). Names stay
<= 59 chars (`provision.go:58`). Providers are **never** copied into project objects.

**Catalog:** per synced, approved project one entry (`configuration.go:20-26`) plus new optional
fields: `providers` (provider-set name) and the pod settings of section 6. Entries without `providers`
(legacy full profiles) keep the old path. Limit 100 (`configuration.go:46`). Overrides live only here.

**Project can only narrow the set:** the subset is validated against `providers.json` at sync time and
again by the gateway at create time.

## 2. Option B in detail: exact changes **[CHANGED: rewritten]**

### CRD (`config/crd.yaml`, mirrored by `make chart-crd`, `Makefile:7-8`)
Add optional `spec.bootstrap.providers` next to `secretName/configMapName/envSecretName`
(`config/crd.yaml` bootstrap block, same patterns and `maxLength: 63`; chart copy
`crds/paseoworkspaces.yaml:65-80`): `{ secretName, configMapName, envSecretName, envKeys []string,
files []string, mcps []string }`, all three names required when present. `envKeys`/`files`/`mcps` carry
the subset (gateway-computed). Spec stays immutable (`self == oldSelf`, `:40-43`), so existing workspaces
are untouched. Also the Docker sidecar fields (section 6): `spec.docker.resources`, `spec.docker.dataSize`.

### Controller (`internal/controller/workspace.go`)
- `Bootstrap` struct (`:25-29`) gains `Providers *ProviderRefs`.
- `:141-155`: when set, require all names (extends the check at `:142`), add two volumes
  (`provider-credentials`, `provider-config`, mode 0440) and mount them **read-only in the init container
  only** at `/var/run/paseo/providers/{credentials,config}`; pass `--providers <secretName>` and the
  mount paths. The daemon container never mounts them.
- **Subset enforcement for env vars:** do **not** `envFrom` the shared env Secret (it would leak
  unselected keys to the daemon and init container, `:149-153`). Instead emit one `env` entry per
  `envKeys` item with `secretKeyRef{name: envSecretName, key}` into `pod.Spec.Containers[0].Env` before
  the init container copies `Env` (`:151-153`). The project env Secret keeps `envFrom` as today.
- Legacy path: `Providers == nil` behaves exactly as now.

### Bootstrap (`images/workspace/bootstrap.py`)
- `prepare()` (`:88-140`) gains `providers_dir`/`providers_config_dir`. It loads the provider files
  with the same `ALLOWED_FILES` validation (`:98-102`), filters `auth.json`/`.credentials.json` by the
  subset (`files` list) and `mcp_servers` by `mcps`, then merges `config.toml`: provider TOML first, project
  TOML over it (`mcp_servers` tables merged by name, project wins; `projects` table from the project).
- Project `config.toml` is still *required* (trusted repo path); it is the project's contribution.
- Marker `.paseo-bootstrap-profile` (`:128-140`) stores `<profile>+<providers>`; a pod-local copy on a PVC
  is not overwritten when unchanged, so pod-level token refreshes survive restarts as today.
- New flags in `main()` (`:142-157`); everything stays secret-silent.

### Gateway
- `ProfileConfiguration`/`Provisioner` (`configuration.go:20-26`, `provision.go:27-35`) gain `Providers
  string`; `Catalog.Load` copies it (`configuration.go:57`) and validates the name like `provision.go:58`.
- **Co-ownership check (`provision.go:79-96`)** now covers **six** objects: project Secret, env Secret,
  ConfigMap *and* provider Secret, env Secret, ConfigMap. Rules: all six exist, are `immutable`, and carry
  the **same non-empty** `profile-owner` label (one owner => one plugin installation/scope, so a project
  profile can never be paired with another owner's providers); kinds match (`kind=project` vs `providers`).
- Gates at `:115-152` run against the provider set: `providers.json` replaces `bootstrap.Providers/MCPs`,
  `auth.json` comes from the provider `files.json`, keys from the provider env Secret, restricted by the
  project's subset. `Requirements.MCPs` (`:153-164`) checks the union. Repository/trust checks (`:165-174`)
  are unchanged and use the project ConfigMap.
- `spec.bootstrap` (`:186`) also writes `providers` incl. the computed `envKeys/files/mcps`.
  `existing()` (`:203-211`) compares the provider-set name too (like it compares the profile today).
- **CRD-skew guard:** after `Create` (`:189`) verify `spec.bootstrap.providers` survived in the returned
  object; an old CRD prunes unknown fields silently, so fail with "CRD out of date: apply config/crd.yaml".
- `Discover` (`discovery.go:44-55`) reads providerSnapshot/controls from the provider ConfigMap named in
  the entry and repository/trust from the project profile; `Targets` (`target.go:47-57`) additionally
  reads `spec.bootstrap.providers.configMapName` from the CR, so running workspaces keep their own sets.
- `create.go:63-88` needs no change (it goes through `Provisioner`).

### Plugin
`credentials.ts` splits `bundle()`/`sync()` into `syncProviders()` (provider triple) and
`syncProject()` (project triple, validates subset against the provider set), then rewrites the catalog
last. RBAC: unchanged for these objects (`get, create, patch` already, `config/plugin-rbac.yaml`).

### Rollout and back-compat (coordinated 0.3.0)
1. Order: apply `config/crd.yaml` first (Helm never upgrades CRDs, `README.md:110`, `docs/setup.md:19-25`),
   then operator + gateway, then workspace image (`DEFAULT_WORKSPACE_IMAGE`, `settings.ts:17`), then the
   plugin. **Check connection** (`docs/setup.md:72`) is extended to verify the new CRD property and the
   operator version; the plugin refuses to write `providers` catalog fields until both pass.
2. Old CRs and legacy catalog entries (no `providers`) keep working with the new controller/gateway.
3. New plugin + old operator would silently create pods without providers, hence the version gate (the plugin asks to upgrade; it never falls back to legacy profiles) and the
   CRD-skew guard. Old plugin + new operator is fine (legacy path).
4. The workspace image must be >= 0.3.0 for new CRs (the init container needs the new flags); the gateway
   pins the image in the catalog entry, so mixed images stay consistent.

### Codex refresh-token duplication (how it is limited)
Codex rotates refresh tokens; the first holder to refresh invalidates the others. B alone does not fix
this: every pod still copies `auth.json` into its own `CODEX_HOME` (`bootstrap.py:136-139`). What B adds is a
single place to change the policy:
- `codexMode: "refreshing"` (today's behaviour, with a UI warning) or **`"access-only"` (recommended
  default for shared sets)**: the provider set carries `auth.json` with the `refresh_token` removed, so pods
  can use the access token but never rotate; the main daemon is the only refresher and the plugin re-syncs a new
  provider-set version (catalog repointed; new pods pick it up). Running pods keep their copy until the access
  token expires.
- **Spike required before PR 2 merges:** confirm Codex's behaviour with an absent `refresh_token` and the
  access-token lifetime. If long-running pods would lose login too quickly, the fallback is
  `"refreshing"` with the warning, and API keys (`openai-key`) recommended for multi-pod use.
- The daemon's own login can still be invalidated by a pod in `refreshing` mode; the UI says so.

**Spike result (PR 2, Codex 0.170.0).** (1) Refresh tokens rotate and reuse is fatal: the binary carries
"your refresh token was already used. Please log out and sign in again", so `refreshing` mode really
invalidates the other holders. (2) The access token in `auth.json` is a JWT valid **10 days**
(`exp - iat`); `last_refresh` is recorded separately. (3) **Removing the `refresh_token` key makes Codex
reject the file** (`codex login status`: "failed to deserialize CLI auth from file"), whereas an **empty
string** `"refresh_token": ""` is accepted ("Logged in using ChatGPT"). So `access-only` must **blank** the
field, never delete it. Pods therefore work for the access token's remaining life (up to 10 days) and then
need a re-sync from the main daemon. Not verified: the exact error shown once a blank token has to refresh
(no network refresh was attempted, to avoid touching the real login). Decision: keep `access-only` as the
default; the plugin (PR 4) writes the blanked `auth.json` and re-syncs before expiry. The bootstrap image
copies `auth.json` as given and does not itself rewrite tokens.

**Bootstrap interface (PR 2).** `bootstrap.py` takes `--providers <secretName>` (enables provider mode and is
appended to the marker as `<profile>+<providers>`), `--providers-secrets` / `--providers-config`
(default `/var/run/paseo/providers/{credentials,config}`), and optional comma lists `--provider-files` and
`--provider-mcps` (flag absent = all, empty = none). The controller derives these from
`spec.bootstrap.providers.{files,mcps}`.

## 3. Gateway / operator impact beyond the provider set **[CHANGED]**

**How a create request picks a project.** `workspace.create.request` carries `source.projectId` or a
synthetic-root path (`discovery.go:85-92`); `Session` resolves it via the catalog (`session.go:480-488`,
`discovery()` `session.go:120-134`) and `Creator` re-checks repository and approval (`create.go:63-88`,
`provision.go:172-174`). Already multi-profile.

Changes:
1. **Catalog writer in the plugin** (bundled, see section 0), plus a Go contract test that `Load`
   parses the plugin's JSON.
2. **Blast radius:** one broken profile aborts the host project list and directory
   (`host_requests.go:25-29`, `directory.go:141-145`, `configuration.go:54-56`); skip and log instead. A
   missing provider set must disable only entries that reference it.
3. **Unique repository URL per project** (the plugin enforces; `discovery()` returns the first match).
4. Provider snapshot/controls merged across entries last-wins (`host_requests.go:34-43`); with one set
   the snapshots only differ by subset.
5. Back-compat for removal: running workspaces resolve their own profile and provider set (`target.go:47-57`).

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
- **Sync:** one **Sync providers** writes the provider set once (and repoints every project entry in the
  catalog); **Sync project** on the Projects tab writes only that thin profile. Status shows the set version.

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
- **Step 1 (creation fix, no secrets touched):** on first attach / `setup.inspect` with the new plugin, the
  catalog is written from settings: one entry pointing at the **existing full profile**, with no `providers`
  field (legacy path). It works with the new gateway immediately, and with an old gateway too. Creation is
  fixed here for existing users.
- **Step 2 (split into set + thin project):** settings v1 -> v2 on read: `providers.*` from the old bundle,
  one project from its repository (trust, revision, overrides from old `docker`/`ephemeral`, subset null).
  Once Check connection confirms the new CRD/operator, the plugin performs a one-time silent sync: it
  writes the provider set and the thin project profile from the same selection, then repoints the catalog.
  Nothing is deleted; the old full profile stays for running pods. A bundle without repository keeps the
  direct-environment path (`backend.ts:55-66`) and yields a provider set only.
- Running pods and direct CRs are untouched (immutable specs, own profile resolution). The Credentials tab
  disappears and the same selection appears pre-ticked on Providers.

## 6. Pods tab: settings of created pods **[CHANGED: Docker sidecar, overrides and warnings all included]**

A dedicated **Pods** tab holds compute, storage and Docker settings for pods created by the gateway.

### What exists today (verified on `origin/main`)
- The workspace spec already carries `resources`, `storage`, `storageClassName` (`internal/controller/workspace.go:41-43`)
  and the CRD requires cpu, memory and ephemeral-storage in both requests and limits
  (`config/crd.yaml:92-105`). The spec is immutable (`self == oldSelf`, chart CRD `paseoworkspaces.yaml:40-43`).
- The gateway **hard-codes** them: storage `4Gi` (ephemeral) or `10Gi` (persistent), requests cpu `250m` /
  memory `512Mi` / ephemeral-storage `1Gi`, limits cpu `2` / memory `4Gi` / ephemeral-storage `4Gi`
  (`provision.go:178-187`). `storageClassName` is never set (cluster default class).
- The Docker sidecar has its own fixed resources (requests 250m/256Mi/1Gi, limits 2/2Gi/12Gi) and a 10Gi
  `docker-data` emptyDir (`workspace.go:156-183`); none of it is configurable from the spec.
- The chart can create a namespace `ResourceQuota` (`charts/paseo-workspaces/values.yaml:43-53`,
  `templates/optional.yaml:22-31`).
- Status only reports init/container waiting reasons (`workspace.go:231-257`): an unschedulable pod
  (`Pending`, condition `PodScheduled=False`, "Insufficient cpu") produces an **empty** message, and
  `WaitReady` just loops until the client times out (`readiness.go:40-47`).

### Layout
- **Compute:** CPU and memory *request* and *limit* (ephemeral-storage request/limit as "scratch space",
  advanced).
- **Storage:** size, `storageClassName` (dropdown from `storageclasses` list if the RBAC allows, else free
  text, empty = cluster default), mode **Persistent** (PVC) vs **Ephemeral** (emptyDir; the existing
  `ephemeral` setting moves here from the cluster settings).
- **Docker sidecar** (visible only when Docker is on): cpu/memory request+limit, ephemeral-storage limit and
  data volume size. Because the sidecar is privileged, the card keeps the existing warning.
- Header shows a **capacity summary**: per-pod requests, the namespace `ResourceQuota` (read-only) and "about N
  pods fit".

### Defaults and overrides
- **Global defaults** in plugin settings (v2): `pods: { compute, storage, docker }`, initialised to **exactly
  today's hard-coded values**, so nothing changes until the user edits them (back-compat).
- **Per-project override** (thin project, section 1): `overrides.pods?` with the same shape, partial; any
  absent field falls back to the global default. A project edit screen gets a "Pod settings" accordion that
  is off by default. Image/docker/ephemeral overrides join this one structure.

### Catalog and gateway
- `ProfileConfiguration` (`configuration.go:20-26`) gains optional fields: `resources` (a
  `corev1.ResourceRequirements`), `storage`, `storageClassName`, `dockerResources`, `dockerDataSize`.
  The plugin writes the effective values (default merged with override) per entry, so the gateway needs no merge logic.
- `Provisioner` gets the same fields; `CreateWithRequirements` (`provision.go:178-187`) uses them when
  set and the current literals otherwise, so an old catalog without them behaves exactly as today.
  `Catalog.Load` validates quantities with `resource.ParseQuantity` and skips the entry on error
  (consistent with the hardening in section 3).
- **Docker sidecar (included now):** new spec fields `spec.docker.resources` (same shape and CEL
  requirements as `resources`) and `spec.docker.dataSize` (same pattern as `storage`), in the same CRD change as
  `spec.bootstrap.providers` (section 2) and `Docker` struct (`workspace.go:30-32`). The controller replaces the
  literals at `workspace.go:159,177-179` with them, falling back to today's values when absent.
  Compute/storage need no CRD change.
- `existing()` (`provision.go:203-211`) must **not** compare resources: a retried request for an
  existing workspace keeps its original values. **Existing workspaces keep old values** for free (immutable spec); changing
  the settings only affects pods created afterwards, and the UI says so.

### Validation (plugin side, mirrored in Go)
- Quantities parse (cpu `250m`/`2`, memory `Mi/Gi`); request <= limit for each pair; non-zero; sane upper bounds.
- Storage: size >= 1Gi; for an existing class, warn when `allowVolumeExpansion` is false.
- **Quota warning:** read the namespace `ResourceQuota` (new RBAC, below) and warn when one pod's requests/limits exceed any `requests.*`/`limits.*` hard
  limit, or when `pods x requests` exceeds it. Warning, not an error: the quota may be raised. Note the
  chart text "excess pods stay Pending" (`values.yaml:43`) is inaccurate for namespace quota: admission
  *rejects* the pod create, so the controller returns an error and retries (`workspace.go:201-213`); a
  node-capacity shortfall is what leaves a pod Pending. The doc and UI should say both.

### RBAC additions (`config/plugin-rbac.yaml`, mirrored in the chart's plugin Role)
- Namespaced Role: new rule `apiGroups: [""], resources: [resourcequotas], verbs: [get, list]`.
- `storageclasses` is cluster-scoped, so it needs a new `ClusterRole` (`storage.k8s.io`, `storageclasses`,
  `get, list`) and `ClusterRoleBinding` to the same main-daemon ServiceAccount, shipped as an *optional*
  manifest (and `pluginRole.clusterReadEnabled` in `values.yaml`). Without it the UI degrades to a free-text
  class name and no expansion warning. This is applied in the implementation PR, not in this design PR.

### Surfacing Pending reasons
- Controller (small Go change): when the pod is `Pending`, copy the `PodScheduled=False` condition message
  (e.g. "0/3 nodes are available: Insufficient cpu") and a failed PVC binding ("storageclass not found",
  "unbound immediate PersistentVolumeClaims") into `status.message`; surface quota rejection as
  message `Quota exceeded: ...` instead of a bare reconcile error.
- Gateway: `WaitReady` returns "workspace pending: <message>" after a short grace period instead of
  waiting silently (`readiness.go:40-47`).
- UI: the Workspaces list shows a `Pending` badge with the reason, and the Pods tab links "increase
  quota / lower requests".

### Storage class caveats
- `storageClassName` and `storage` are fixed per workspace; **shrinking is impossible** and expanding an
  existing PVC is a manual operation (class must allow expansion). Changing the setting affects only new
  workspaces. A class that does not exist leaves the PVC unbound (the Pending reason above).
- Ephemeral mode ignores the class; the size is an emptyDir `sizeLimit`, counted as ephemeral storage.

## 7. Phased plan **[CHANGED]**

PR-sized, ordered. **Release gate:** nothing is released until PR 3 (it contains the catalog writer, which
is what fixes creation). PRs 1-2 are merged to main as unreleased groundwork; PR 3 onwards form 0.3.0.
Dependencies: 1 -> 3; 2 -> 3; 3 -> 4 -> 5; 6 and 7 parallel after 3; 8 last.

| PR | Scope | Depends | Tests |
|----|-------|---------|-------|
| 1 | **CRD + controller:** `spec.bootstrap.providers`, `spec.docker.resources/dataSize`, mounts, per-key `secretKeyRef` env, CRD CEL, `make chart-crd`. Legacy path untouched. | none | envtest: legacy CR unchanged, subset env only, missing ref rejected, sidecar resources. |
| 2 | **Bootstrap image:** `bootstrap.py` provider merge, subset filtering, marker, tests; Codex refresh-token **spike** and `codexMode`. | none | `test_bootstrap.py`: merge precedence, subset, legacy, unsafe paths. |
| 3 | **Gateway + catalog writer (first release):** `Providers` in catalog/Provisioner, six-object co-ownership, provider gates, CRD-skew guard, Discover/Targets, skip-broken-entries (`host_requests.go`, `directory.go`, `configuration.go`); plugin `catalog.ts` writer + settings v2 + legacy-profile entry (migration step 1). **Fixes creation for existing users.** | 1, 2 | Go: co-owner mismatch, missing set, subset gate, old catalog; contract test; plugin: catalog JSON. |
| 4 | **Plugin sync engine:** `syncProviders`/`syncProject`, labels, subset validation, RPCs `providers.*`, `projects.*`, migration step 2 (silent split after Check connection). | 3 | migration v1->v2, subset narrowing, trust gating, partial failure keeps old catalog. |
| 5 | **Providers + Projects UI**, Overview steps, remove Credentials, docs/website. | 4 | component smoke, manual cluster run. |
| 6 | **Pods settings (compute/storage/Docker, per-project override):** settings, catalog fields, `provision.go` applies them, validation, quota/storageclass RBAC manifest. | 3 | old catalog = identical spec; request<=limit; invalid quantity skipped; `existing()` ignores resources. |
| 7 | **Pending reasons:** controller copies scheduling/PVC/quota messages to `status.message`; `WaitReady` reports them. | 3 | envtest: unschedulable pod message; quota rejection message. |
| 8 | **Pods tab UI** + capacity summary. | 6, 7 | smoke + manual. |
| 9 (optional) | Profile/provider-set GC by labels (needs `delete` in plugin RBAC), editable display name. | 5 | GC safety. |

## 8. Risks
- Catalog could be hand-created on other clusters; the plugin only overwrites a catalog carrying its own
  owner label (`applyOwned`, `kubernetes.ts:102-140`).
- Codex refresh-token behaviour (section 2); unchanged pod-level risk, warned in the UI.
- Skew between plugin, CRD, operator and image: version gate, Check connection and CRD-skew guard (section 2).
- A project profile paired with a deleted provider set: skipped entry plus message, not a host-wide failure.
- A project's id is a hash of its URL; changing the URL makes a new project.
- Stale detection depends on stored `provider-set`/profile hashes.
- Catalog is read once per session call; fine at 100 entries.

## 9. Assumed (recommended) defaults, tell me if you disagree **[CHANGED: replaces the decision list]**
Decisions 2-7 were not answered; this design assumes my earlier recommendation for each:
1. **Codex subscription login** is shareable, default `access-only` mode with a UI warning; API keys are
   preferred for multi-pod use (subject to the spike).
2. **Removing a project** keeps profile objects, provider sets and running workspaces.
3. **URL-only projects** are allowed (no project-level MCPs).
4. **Project MCPs from the checkout** are selectable per project after approval; user-level MCPs are
   provider rows.
5. A project with an **empty provider subset** is valid (clone-only, no credentials).
6. **Display name** is derived from the URL (no gateway change); editable name is optional PR 9.

Decided by the user:
- **Q1.** The migration split (step 2, section 5) runs **automatically** after the operator upgrade.
- **Q2.** A **coordinated 0.3.0** is accepted: apply the CRD manually, then operator, image and plugin
  together. There is **no legacy-profile fallback** for old operators.

No open questions remain.
