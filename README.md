# paseo-kubernetes-daemons

Run Paseo workspace daemons in isolated Kubernetes pods with resource limits and
lifecycle management. Initial implementation: Go operator and TypeScript companion
plugin; no Paseo core changes.

## Requirements

- Kubernetes 1.32+ with dynamic PVC provisioning.
- Paseo 0.15.3+ on the main daemon and in workspace images.
- Main daemon network access to cluster Service DNS/IPs; workspace pods must reach
  the main daemon for reverse communication.
- `kubectl` available to the main daemon, authenticated with access to the managed
  namespace. Node 22+ for plugin development; Go 1.26 for operator development.

## Set up from Paseo

> **0.5.0 renamed everything from "workspaces" to "daemons"** (breaking): see [docs/migration-0.5.md](docs/migration-0.5.md).

Install the companion, then open **Kubernetes Daemons** from Paseo's top-left
sidebar menu. The panel checks for the operator and guides setup.

1. Build/push the operator and bootstrap-enabled workspace images, then apply the
   CRD, operator and main-daemon RBAC manifests.
2. Save the Kubernetes context, namespace and workspace image in the panel.
3. On the **Providers** tab, **Find providers** on the main host, select the
   credentials and MCP servers to share, **Save selection** and **Sync providers**.
   Only references are saved in plugin settings; values go into Kubernetes Secrets.
   The list mirrors the main daemon's new-conversation picker: built-in providers and
   your **provider profiles** (custom providers with their own env, such as an API key or
   proxy URL). Selected profiles are copied to pod daemons with the same name and models,
   API keys included (secret at rest in the provider Secret, never shown in the panel).
   A profile pointing at a loopback URL needs a reachable URL override; a profile whose
   `CODEX_HOME` is a local directory has its `auth.json` copied to a pod-local home, or shows
   Missing when unreadable. The Claude subscription login is supported
   too: preferably as a long-lived token (`claude setup-token`, exported as
   `CLAUDE_CODE_OAUTH_TOKEN` on the main daemon), otherwise as the file-backed login
   (`~/.claude/.credentials.json`, or a profile's `CLAUDE_CONFIG_DIR`), copied access-only.
4. On the **Projects** tab, add a repository by URL or local checkout, approve it
   once for new pods, and **Sync project**. The **Overview** tab tracks these steps.
   Optionally size new pods (CPU, memory, storage, Docker sidecar) on the **Pods** tab;
   changes apply to new workspaces only.
5. Create an environment, wait for its daemon to be online, and **Open workspace**.
   Bootstrap prepares Codex authentication, repository checkout, project trust and
   selected MCP definitions before the daemon starts.
6. Export results before **Release**; release deletes workspace storage.

The companion uses ephemeral workspace storage by default. Turn it off for a PVC.
Direct `PaseoDaemon` CRs retain their PVC default. The workspace image now
includes Codex and the bootstrap helper; rebuild images when upgrading.

**[Full installation, credential sync and bootstrap guide](docs/setup.md)**

Credential reuse currently supports file-backed Codex subscription login, selected
provider environment API keys, and Codex TOML MCP definitions plus their selected
environment variables. MCP OAuth file-cache export is an explicit opt-in; OS
keychains are not exported. These are snapshots: OAuth refresh is not coordinated
across pods. Re-sync when main-host credentials change. No real credentials are
synced until you select them and click Sync providers in the panel.

The operator uses Kubernetes owner references for resource cleanup. Optional
namespace quota and network policy manifests are provided. Physical PV deletion
depends on the StorageClass reclaim policy; use `Delete` for automatic disk cleanup.

## Development

```sh
make test
go vet ./...
make build
```

Tests cover reconciliation, Pod recovery, ownership isolation and host registration
logic. CI also installs a temporary Kubernetes API server to validate CRD admission
and creation of real Pod, Service and PVC objects. See [the architecture decision](docs/architecture.md) for scope and limits.

## Website

The static documentation site lives in `website/`, following the Paseo Mail and
Playbooks sites. Preview it with `python3 -m http.server 8091 --directory website`.
The Pages workflow deploys changes on `main`; the custom domain is
`kubernetes-daemons.paseo.lerenn.dev` (DNS must point to GitHub Pages).

### Optional Docker engine

Enable **Enable Docker** under Advanced cluster settings, save, then create a new
workspace. With manifests, set `spec.docker.enabled: true`. Apply the updated CRD
and deploy the updated operator and workspace image first; existing workspace
specifications are immutable.

Each enabled pod gets a `docker:29.0.0-dind` sidecar (configurable, see below) and the workspace image includes
Docker CLI, Buildx and Compose. The engine listens only on the shared Unix socket
at `/var/run/docker/docker.sock`; no node Docker socket is mounted. Both containers
mount `/workspace` at the same path so workspace bind mounts work. Published ports
are accessible within the pod (including from the workspace via localhost).

The sidecar requires admission policies that permit privileged containers in the
workspace namespace. The Paseo container still runs as UID 1000 without privilege
escalation. Docker requests 250m CPU, 256Mi RAM and 1Gi ephemeral storage, with
limits of 2 CPUs, 2Gi RAM and 12Gi ephemeral storage. Its image/container data uses
a 10Gi emptyDir and disappears whenever the pod is deleted or replaced, even for
workspaces using persistent storage. Account for these extra resources in namespace
quotas. Pod readiness waits for Docker; commands started earlier may need to retry
until `docker info` succeeds.

The sidecar is configured through chart values (operator flags):

| Value | Flag | Default | Purpose |
| --- | --- | --- | --- |
| `docker.image` | `--docker-image` | `docker:29.0.0-dind` | Sidecar image. Clusters with image allowlists or pod-security policies should pin it by digest (`repo:tag@sha256:...`). |
| `docker.mtu` | `--docker-mtu` | `1450` | MTU of dockerd and its default bridge networks (match your CNI overlay; `0` keeps Docker's default). |
| `docker.registryMirrors` | `--docker-registry-mirror` | `[]` | Docker Hub mirrors (`--registry-mirror`). They only apply to Docker Hub pulls and must be reachable from the workspace namespace. |

The containerd image store (`containerd-snapshotter`) is always disabled in the sidecar
because it breaks pushes and concurrent pulls in nested Docker.

## Helm chart

```sh
helm install paseo-daemons ./charts/paseo-daemons -n paseo-daemons --create-namespace \
  --set image.tag=<operator image tag> --set gateway.enabled=true
```

`charts/paseo-daemons/crds/` is a copy of `config/crd.yaml` (CI checks they match; refresh with `make chart-crd`).
Helm installs CRDs once but never upgrades them: apply `config/crd.yaml` yourself when upgrading.
The gateway is off by default; enabling it adds permissions to the operator Role.

### Releases

Releases are automatic. Bump the version in one PR, in all of: `plugin/package.json`, `plugin/package-lock.json`
(`npm version X.Y.Z --no-git-tag-version` in `plugin/`), `charts/paseo-daemons/Chart.yaml` (`version` and `appVersion`)
and the tag of `DEFAULT_WORKSPACE_IMAGE` in `plugin/shared/settings.ts`. The `version` CI job checks they agree and that
the new version is greater than the latest tag. Merging to `main` runs the Release workflow: if `vX.Y.Z` has no tag yet,
it publishes the images and chart, then creates the tag and the GitHub release (an already tagged version is a no-op;
re-run a failed release with *Run workflow* on `main`). Never push tags by hand. It publishes `ghcr.io/lerenn/paseo-daemons-operator:X.Y.Z`, `ghcr.io/lerenn/paseo-daemon:X.Y.Z`
and the chart `oci://ghcr.io/lerenn/charts/paseo-daemons` (chart and app version X.Y.Z):

```sh
helm install paseo-daemons oci://ghcr.io/lerenn/charts/paseo-daemons --version X.Y.Z -n paseo-daemons --create-namespace
```
