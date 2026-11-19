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

## Deploy

Build and push images to your registry:

```sh
docker build -t your-registry/paseo-workspaces-operator:0.1.0 .
docker build -t your-registry/paseo-workspace:0.16.2 images/workspace
docker push your-registry/paseo-workspaces-operator:0.1.0
docker push your-registry/paseo-workspace:0.16.2
```

The workspace image includes Paseo and basic development utilities. Add your agent
provider executables in a derived image. Replace the operator image in
`config/operator.yaml`, then install:

```sh
kubectl apply -f config/crd.yaml
kubectl apply -f config/operator.yaml
kubectl apply -f config/quota.yaml       # optional aggregate capacity limits
```

Set these environment variables on the main daemon, then restart it:

| Variable | Meaning |
|---|---|
| `PASEO_WORKSPACE_IMAGE` | Required workspace image |
| `PASEO_WORKSPACE_NAMESPACE` | Namespace; defaults to `paseo-workspaces` |
| `PASEO_WORKSPACE_CLUSTER_ID` | Stable unique cluster label; defaults to `default` |
| `PASEO_WORKSPACE_SECRET` | Optional existing Secret injected as environment variables into pods |
| `PASEO_MAIN_CONNECTION` | Optional Paseo connection target reachable from pods, for reverse registration |

Bind `config/plugin-rbac.yaml` to the main daemon's ServiceAccount, or grant its
kubeconfig equivalent access. For an in-cluster main daemon, provide `kubectl` in
its image. Enable plugins in Paseo settings, then install this companion:

```sh
cd plugin
npm ci
npm run typecheck
paseo plugin install "$PWD"
```

## Use

New agent sessions receive three tools:

1. `kubernetes_workspace_create({ "name": "demo" })` requests an environment.
2. Poll `kubernetes_workspace_list({})` until `hostStatus` is `online`; its
   `serverId` selects the workspace daemon with Paseo's cross-host tools.
3. Create one Paseo workspace at `/workspace` on that host, then create agents
   there. Agent sessions, terminals, scripts and files stay inside the pod.
4. Export results, then call `kubernetes_workspace_release({ "name": "demo" })`.
   **Release deletes the pod and PVC.** Reconciliation removes its host registration.

The same operations are plugin RPCs: `environment.create`, `environment.list` and
`environment.release`; typed contracts live in `plugin/shared/contracts.ts`. List/create
reconcile host registrations, including optional reverse links. A five-second
background reconciliation loop starts on the first plugin call or agent session
open, and resumes the same way after a plugin restart. A Ready pod can still have a connecting or failed
host registration, whose error is returned by list.

You can also create CRs directly with `config/example.yaml` after replacing its
image, then call the plugin's list operation to register them:

```sh
kubectl apply -f config/example.yaml
kubectl -n paseo-workspaces get pw
kubectl -n paseo-workspaces describe pod pw-example
```

One CR creates one pod/daemon and one PVC, with default limits of 2 CPUs, 4 GiB RAM,
4 GiB ephemeral storage and a 10 GiB PVC. CR specifications are immutable. Use a
new name to change settings; persistent storage survives pod replacement, but is
deleted with its CR. Use a StorageClass with reclaim policy `Delete` to release
physical storage too. The plugin does not enforce the number of Paseo workspaces a
user can manually create inside a daemon.

Apply `config/network-policy.yaml` when your main daemon runs in the same namespace
with label `workspaces.paseo.sh/access=main`; adapt its selectors for other network
layouts. Workspace pods cannot call the Kubernetes API with a mounted service
account token. Configure daemon authentication separately for your deployment.

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
