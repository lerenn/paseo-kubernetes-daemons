# Setup and credential reuse

The main daemon runs the companion plugin. Its **Kubernetes Workspaces** entry in
Paseo's top-left sidebar menu opens the setup and environment screen. It talks to
the Kubernetes API through `kubectl`; the operator does not expose a public Service.

## Install or upgrade

Build and push both images. Use a fresh tag when upgrading; the workspace image now
includes pinned Codex CLI and the bootstrap helper, which older images do not have.

```sh
docker build -t your-registry/paseo-workspaces-operator:0.2.0 .
docker build -t your-registry/paseo-workspace:0.2.0 images/workspace
docker push your-registry/paseo-workspaces-operator:0.2.0
docker push your-registry/paseo-workspace:0.2.0
```

Replace the Deployment image in `config/operator.yaml`. Apply the CRD update before
using bootstrap references. The supplied manifests use `paseo-workspaces`; adapt
all namespace fields, RoleBindings and the operator's `--namespace` argument if
choosing another namespace.

```sh
kubectl apply -f config/crd.yaml
kubectl apply -f config/operator.yaml
kubectl apply -f config/plugin-rbac.yaml
# Optional aggregate admission limits and network restrictions:
kubectl apply -f config/quota.yaml
# Adapt this policy's main-daemon selector before applying it:
# kubectl apply -f config/network-policy.yaml
```

Bind the plugin Role to the main daemon's ServiceAccount (replace the subject
namespace and name with yours):

```sh
kubectl -n paseo-workspaces create rolebinding paseo-main-workspaces \
  --role=paseo-workspaces-plugin \
  --serviceaccount=main-daemon-namespace:main-daemon-serviceaccount
```

The Role can also read `resourcequotas`, which the Pods settings use for capacity
warnings. Storage classes are cluster-scoped: to let the Pods settings list them
(and warn when a class cannot expand volumes), bind the optional ClusterRole from
`config/plugin-rbac.yaml` (chart: `pluginRole.clusterReadEnabled=true`) to the same
ServiceAccount:

```sh
kubectl create clusterrolebinding paseo-main-workspaces-storageclasses \
  --clusterrole=paseo-workspaces-plugin-storageclasses \
  --serviceaccount=main-daemon-namespace:main-daemon-serviceaccount
```

Without it the storage class stays a free-text field. Either way both reads are
optional: a forbidden request just hides the warnings.

For an external main daemon, give its kubeconfig equivalent permissions. The main
host needs `kubectl` and network access to pod Services. The operator needs no
Secret-reading permissions; Kubernetes mounts the selected resources into pods.
The plugin Role can get/create/patch Secrets and ConfigMaps in the managed
namespace. Treat this namespace as the credential-sharing boundary.

Install the companion or reload an existing directory installation:

```sh
cd plugin
npm ci
npm run typecheck
paseo plugin install "$PWD"
# Existing installation:
# paseo plugin reload kubernetes-workspaces
```

### Pod settings

Compute, storage and Docker sidecar settings of new pods default to the former
built-in values (requests 250m/512Mi/1Gi scratch, limits 2/4Gi/4Gi; storage 4Gi
ephemeral or 10Gi persistent; sidecar requests 250m/256Mi/1Gi, limits 2/2Gi/12Gi,
10Gi data) and can be overridden per project. They only affect workspaces created
afterwards: a workspace spec is immutable. A namespace quota *rejects* a pod that
exceeds it (the operator retries); a node-capacity shortfall leaves the pod Pending.

### Docker sidecar settings

Workspaces with `spec.docker.enabled` get a privileged `docker` sidecar. Tune it with
chart values `docker.image`, `docker.mtu` (default 1450) and `docker.registryMirrors`
(default none). Clusters with image-allowlist or pod-security policies should pin
`docker.image` by digest (`docker.io/library/docker:<version>-dind@sha256:...`) and allow a
privileged container named `docker` in the workspace namespace. A registry mirror only
applies to Docker Hub pulls and must be reachable from the workspace namespace.

## Connect the cluster

Open **Kubernetes Workspaces**. Save the context, namespace, stable cluster ID and
workspace image. **Check connection** verifies the CRD and available operator
Deployment. When using a kubeconfig, the screen pins the detected context to avoid
silently exporting credentials to a different cluster after `kubectl` changes its
current context. In-cluster service-account access does not require a context.

When the operator runs with the gateway enabled (chart value `gateway.enabled=true`), the
plugin registers the virtual "<Name> · Kubernetes" host by itself, using the in-cluster
Service `paseo-workspaces-gateway.<namespace>.svc:8787` and the password in the operator's
`paseo-workspaces-gateway-auth` Secret. This needs the main daemon to reach that Service
and to hold the plugin Role (get on that Secret). The host is removed when the Secret is gone.

Apps outside the cluster (a laptop, for example) cannot resolve that `.svc` name, so the host
shows as unreachable there. Expose the Service through an Ingress with TLS, add its hostname to
the chart's `gateway.hostnames`, and set **Public gateway endpoint** (`host[:port]`, default port
443, or `PASEO_WORKSPACES_GATEWAY_ENDPOINT`) in the plugin. The plugin then registers
`tcp://<endpoint>?ssl=true`, still authenticated with the Secret's password.

An optional main-daemon endpoint enables reverse host registration. The main daemon
must be reachable from the pod; ordinary pod registration is directional. Configure
authentication and Service/network policy for your deployment.

## Providers and projects

The panel has six tabs: **Overview**, **Cluster**, **Providers**, **Projects**, **Pods** and
**Workspaces**. Overview lists the setup steps (cluster, providers, projects) with
buttons that jump to each tab. Providers are chosen once and shared; each project
adds only its repository settings.

### Providers tab

**Find providers** reads names and availability on the main host, not credential
values in the client. It uses `$CODEX_HOME` or `~/.codex`. Each row shows whether the
item is *Found*, *Selected* and *Synced*, *Out of date* or *Not synced*, and the last
sync time. **Save selection**, then **Sync providers** writes the shared provider set
once and refreshes every approved project. The Codex mode (access-only by default, or
refreshing), the MCP OAuth cache switch and MCP URL overrides are under *Advanced
provider settings*.

Select only the credentials and MCP definitions to export:

- **Codex subscription login:** file-backed `auth.json`. This reuses the existing
  account; it does not create another subscription. Keychain-only login cannot be
  exported by this implementation.
- **Provider API keys:** `OPENAI_API_KEY`, `ANTHROPIC_API_KEY` and `GEMINI_API_KEY`
  from the main daemon's environment. Their provider executables must exist in the
  workspace image; the supplied image includes Codex only. Choose the subscription
  login without the OpenAI API key to keep subscription authentication distinct.
- **GitHub token:** optional `GITHUB_TOKEN` for private HTTPS clones on github.com.
  Tokens are passed through Git askpass, never embedded in repository URLs. SSH
  origins need an image-specific SSH credential and host-key setup.
- **MCP definitions:** selected `[mcp_servers.<name>]` tables, including inline
  headers/environment values, go into the Secret. Referenced environment variables
  are exported only for selected servers. Missing variables block sync. Loopback
  URLs must be replaced with endpoints reachable from pods. STDIO commands and
  dependencies must be installed in the image. Main-host repository `cwd` and
  executable paths are translated to `/workspace/repository` where applicable;
  other host-specific paths and arbitrary command arguments are not rewritten.
- **MCP OAuth file cache:** a separate, explicit switch copies the entire
  `.credentials.json` cache, including entries for unselected servers. It is not
  enabled automatically. OS-keychain entries are not exported. Test compatibility
  with the Codex versions used on both hosts.

### Projects tab

A project is a repository that new workspaces can start from. Add one by **repository
URL** (no project MCP servers) or by **checkout on this daemon**, which reads the
origin remote and the MCP servers defined only by that checkout. A repository must
have a credential-free HTTPS or SSH origin. Every project must be **approved**: the
approval dialog shows the URL, revision and project MCP servers, and is tied to
exactly that repository. Review project configuration before approving it.

Each project row shows its state (*Synced*, *Out of date*, *Not synced* or
*Unapproved*), how many providers it uses and how many workspaces run from it.
**Edit project** sets the branch/tag/commit (default: the origin's default branch),
an optional subset of the selected providers, project MCP servers, and image, Docker
and ephemeral-storage overrides, plus a **Pod settings** section (off by default) to
override any pod size for that project. **Sync project** writes only that project's profile.
**Remove** stops new workspaces for the project only; running workspaces stay
untouched.

### Pods tab

Sets the compute (CPU and memory request and limit, plus scratch space), storage
(volume size, storage class, persistent or ephemeral) and, when Docker is on, the
Docker sidecar (its resources and data volume) of pods created by the gateway. The
defaults equal the previous built-in values, so nothing changes until you edit them.
Fields are validated as you type (valid quantities, request no greater than limit,
volume at least 1Gi). **Reset to defaults** restores the built-in values; **Save pod
settings** rewrites the catalog.

**Changes apply to new workspaces only**: a workspace spec is immutable, so existing
workspaces keep their values. A project can override any field in **Edit project >
Pod settings**; empty fields inherit the global value.

When the plugin may read them, the tab shows the namespace `ResourceQuota`, how many
workspaces fit, and warnings (a pod larger than the quota, a missing storage class, a
class without volume expansion). Without that access it degrades silently to free-text
fields. Reading quotas needs the `resourcequotas` rule in the plugin Role; reading
storage classes needs the optional cluster-scoped read (`pluginRole.clusterReadEnabled`).
Storage caveats: a volume cannot shrink, growing one is manual and needs a class with
expansion, and ephemeral workspaces ignore the class.

A workspace that cannot start shows **Pending** with the reason in the Workspaces tab
(for example "Insufficient cpu" or "Quota exceeded: ..."). A full namespace quota
rejects the pod and is retried; a node-capacity shortfall leaves it Pending.

**Sync providers** and **Sync project** create immutable versioned objects: a file
Secret and environment Secret for the provider set, and a non-secret bootstrap
ConfigMap per project. The panel saves only their references and selection metadata
in host settings. Raw values never appear in RPC responses,
CRs, ConfigMaps, command-line arguments or diagnostic errors. The panel never
exports credentials in the background.

## Create and open

Enter an environment name and choose **Create**. Ephemeral storage is enabled by
default in the companion: the pod uses a size-limited `emptyDir` instead of a PVC.
Turn this off for storage that survives pod replacement until explicit release.
Direct CRs retain their existing PVC default for compatibility.

The operator mounts the two snapshot resources read-only in an init container.
Bootstrap copies selected files into a private, writable `/workspace/.codex` and
clones the approved repository into `/workspace/repository`. It sets project trust
for that fixed path. Selected MCP definitions live in the copied user config;
root repository MCP definitions are removed so they cannot override the explicit
selection. Other project settings remain. Nested `.codex` configurations are not
filtered; they remain governed by repository trust when entered later.

The daemon starts only after bootstrap succeeds. Once host status is **online**,
**Open workspace** opens/creates the directory workspace on the remote daemon and
navigates to it. New agents run there. RPC users can call `environment.open` with
`{ "name": "demo" }` and receive `{ workspaceId, serverId }`.

Export results before **Release**. The screen asks for confirmation because release
deletes the environment and its storage. Credential profiles persist independently
for reuse. Delete old profile Secrets/ConfigMaps manually after confirming that no
workspace references them; the companion does not garbage-collect credential
snapshots that existing environments might still need.

## Credential lifetime and remaining limits

These are **snapshots**, not a credential broker. Codex can refresh its writable
pod-local login cache. Bootstrap preserves it on retries/restarts with the same
profile. Pods do not write tokens back to the main host or to Kubernetes Secrets.
New workspaces use the last snapshot selected in settings; re-sync providers after main-host
credentials change. Multiple clients refreshing the same copied OAuth grant can
still invalidate one another, depending on the provider. Fully coordinated OAuth
refresh and a central authenticated MCP proxy are not implemented. A new workspace
may need a fresh sync if its saved grant is no longer valid; no additional
subscription is required.

Do not mount one writable auth directory into concurrent pods. Secrets are reusable
and contain account credentials; Kubernetes Secret objects are not automatically
encrypted at rest. Use your cluster's normal RBAC and encryption configuration.

Ephemeral pod replacement loses the daemon identity along with workspace files.
Paseo can then report a pinned-host identity mismatch. Release/recreate that
environment with a new CR UID, or use a PVC if identity must survive pod replacement.
Existing environments are not silently retargeted to a new identity or snapshot.

Troubleshooting:

```sh
kubectl -n paseo-workspaces get pw
kubectl -n paseo-workspaces describe pod pw-demo
kubectl -n paseo-workspaces logs pw-demo -c bootstrap
kubectl -n paseo-workspaces logs pw-demo -c daemon
paseo plugin logs kubernetes-workspaces
```

The helper deliberately redacts parser/Git exceptions; investigate source config,
repository access and selected image dependencies without printing credentials.

References:

- [Codex authentication](https://learn.chatgpt.com/docs/auth)
- [Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli)
- [Project configuration and trust](https://learn.chatgpt.com/docs/config-file/config-basic)
