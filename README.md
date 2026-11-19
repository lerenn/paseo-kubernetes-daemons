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
