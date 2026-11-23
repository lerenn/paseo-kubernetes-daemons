# paseo-kubernetes-workspaces

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

Install the companion, then open **Kubernetes Workspaces** from Paseo's top-left
sidebar menu. The panel checks for the operator and guides setup.

1. Build/push the operator and bootstrap-enabled workspace images, then apply the
   CRD, operator and main-daemon RBAC manifests.
2. Save the Kubernetes context, namespace and workspace image in the panel.
3. Discover provider credentials and Codex MCP definitions from the main host.
   Optionally select a local repository and approve it once for new pods.
4. Select the credentials/MCPs to export and click **Sync to Kubernetes**. Only
   references are saved in plugin settings; values go into Kubernetes Secrets.
5. Create an environment, wait for its daemon to be online, and **Open workspace**.
   Bootstrap prepares Codex authentication, repository checkout, project trust and
   selected MCP definitions before the daemon starts.
6. Export results before **Release**; release deletes workspace storage.

The companion uses ephemeral workspace storage by default. Turn it off for a PVC.
Direct `PaseoWorkspace` CRs retain their PVC default. The workspace image now
includes Codex and the bootstrap helper; rebuild images when upgrading.

**[Full installation, credential sync and bootstrap guide](docs/setup.md)**

Credential reuse currently supports file-backed Codex subscription login, selected
provider environment API keys, and Codex TOML MCP definitions plus their selected
environment variables. MCP OAuth file-cache export is an explicit opt-in; OS
keychains are not exported. These are snapshots: OAuth refresh is not coordinated
across pods. Re-sync when main-host credentials change. No real credentials are
synced until you select them and click Sync in the panel.

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
`kubernetes-workspaces.paseo.lerenn.dev` (DNS must point to GitHub Pages).

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
helm install paseo-workspaces ./charts/paseo-workspaces -n paseo-workspaces --create-namespace \
  --set image.tag=<operator image tag> --set gateway.enabled=true
```

`charts/paseo-workspaces/crds/` is a copy of `config/crd.yaml` (CI checks they match; refresh with `make chart-crd`).
Helm installs CRDs once but never upgrades them: apply `config/crd.yaml` yourself when upgrading.
The gateway is off by default; enabling it adds permissions to the operator Role.

### Releases

Pushing a `vX.Y.Z` tag publishes `ghcr.io/lerenn/paseo-workspaces-operator:X.Y.Z`, `ghcr.io/lerenn/paseo-workspace:X.Y.Z`
and the chart `oci://ghcr.io/lerenn/charts/paseo-workspaces` (chart and app version X.Y.Z):

```sh
helm install paseo-workspaces oci://ghcr.io/lerenn/charts/paseo-workspaces --version X.Y.Z -n paseo-workspaces --create-namespace
```
