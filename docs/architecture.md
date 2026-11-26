# Architecture decision: reuse Paseo daemons

Status: accepted for the initial implementation.

Each `PaseoDaemon` describes one execution environment. A Go controller creates
one Pod and ClusterIP Service, plus either a PVC or an ephemeral emptyDir volume. Managed API objects carry controller owner references;
deleting the CR garbage-collects them. Physical volume deletion depends on the
StorageClass reclaim policy; use `Delete` for automatic disk cleanup. With persistent storage, a replacement Pod reattaches the same PVC, preserving
the daemon's identity and local state. Ephemeral Pod replacement loses both.

The main daemon's TypeScript companion plugin requests environments and registers
ready endpoints through `paseo.hosts.add`, using the CR UID as its durable source
key. An optional `PASEO_MAIN_CONNECTION` creates the reverse registration through
the connected host API. Registrations are directional. Agent discovery and prompts
use Paseo's existing `serverId` routing. The Go operator never implements the Paseo
wire protocol or stores conversations.

Specifications are immutable in v1alpha1. Reconciliation recreates missing children
but does not roll out changed images or repair manually edited child specifications.
Pod readiness means TCP availability; a usable agent destination additionally
requires the host registration to be online. There is deliberately no fallback to
local execution.

Host reconciliation runs on environment list/create calls and every five seconds
after the first plugin interaction or agent session open. After a plugin restart,
opening a session or listing environments resumes reconciliation from the Kubernetes
inventory. Registration cleanup follows a successful list, never an API timeout.
The timer is disposed with the plugin; concurrent inventory syncs share one request. Cluster ID plus
namespace scope registrations so inventory in one cluster cannot delete another's
hosts. Use one main plugin installation per managed namespace.

Resource requests and limits constrain each Pod; an optional ResourceQuota caps
aggregate admission. Kubernetes rejects over-quota resource creation and the
controller retries with backoff. This is not a fair scheduling queue. A PVC may be
created while its Pod is waiting for admission. CPU is throttled, memory overages
can cause OOM termination, and storage capacity depends on CSI enforcement. This version has no idle eviction, result export, TTL or remote Playbooks dispatch.
Approved repository checkout is handled by the bootstrap init container. Those can be added without changing the execution boundary.

The main daemon must reach cluster Service DNS and addresses; the reverse endpoint
must be reachable from Pods. Deploying the main daemon in-cluster is the simplest
configuration. Workspace pods receive no Kubernetes service account token. The
operator has namespace-scoped permissions and does not read Secrets; the kubelet mounts selected bootstrap Secrets into the init container and injects
selected environment variables into the workspace. Configure network
policy and daemon authentication to match your cluster's trust boundary.

References:

- https://github.com/getpaseo/paseo/blob/main/docs/connected-hosts.md
- https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md

## Credential profiles and bootstrap

The companion's native setup screen is registered in the main sidebar. Host-scoped
settings store connection information and an active immutable profile reference.
Discovery returns names/availability only. A human-triggered sync exports selected
Codex auth/configuration files and environment values as versioned Secrets, plus a
non-secret ConfigMap for repository/bootstrap configuration. Objects are scoped to
the main daemon identity and cluster connection; ownership checks prevent replacing
unmanaged objects. Configuration containing inline MCP credentials stays secret.

A bootstrap init container uses the workspace image to copy selected files into a
private writable Codex home, clone an approved repository and establish trust at
its stable pod path. The main container never mounts the raw file snapshot volume.
Root project MCP tables are removed in favor of the explicitly selected snapshot.
An unchanged profile preserves pod-local token refreshes on retries. No pod writes
credentials back to the main host, and no automatic export runs in the background.

Credential profiles outlive individual environments; existing pods must not lose
snapshots they reference. Old snapshot cleanup is explicit. OAuth grant refresh
coordination across copies and keychain credential export remain unsupported.
See [setup](setup.md) for the exact supported credential sources and limitations.

## Plugins

Pod daemons can get Paseo plugins (for example GitHub Proxy, Mail, Playbooks, Prompts) installed.
Design and settings/UI side: [docs/design/plugins.md](design/plugins.md).

- `spec.bootstrap.plugins[]` holds `{source, ref, configSecretName}`: a pinned source (`ref` is a
  Git branch, tag or commit) and an optional Secret whose keys become environment variables.
- `paseo plugin install` connects to a running daemon (verified in `@getpaseo/cli` 0.16.2), so it
  cannot run in the init container. When plugins are configured the operator wraps the daemon
  command in `install-plugins.py`: it starts the daemon as a child (signals are forwarded, its exit
  code is returned), waits until `paseo plugin ls --json` answers, then installs each plugin.
- `$PASEO_HOME/.k8s-plugins` (0600) records the installed `{source, ref}` pairs. A pod restart
  with an unchanged list installs nothing; a changed or new pin is installed. Failed installs are
  retried on the next start and never stop the daemon. Install output is never logged, only
  `Plugin N/M installed|failed|already installed`.
- Config Secrets are exposed through `envFrom` of the daemon container only (plugins run inside the
  daemon and read their configuration from its environment). They are not mounted in the init
  container. With several Secrets, a key defined twice takes the last one.
- Plugins removed from the list stay installed on that pod (no uninstall); a fresh pod will not have them.
- The CR spec is immutable for the gateway, so plugin changes apply to workspaces created afterwards.
- Release implications: the workspace image must contain `install-plugins.py`, and the CRD must be
  re-applied; with an old CRD the gateway deletes the new CR and reports "CRD out of date" instead
  of starting a pod without its plugins.
