# Architecture decision: reuse Paseo daemons

Status: accepted for the initial implementation.

Each `PaseoWorkspace` describes one execution environment. A Go controller creates
one Pod, ClusterIP Service and PVC. All three carry controller owner references;
deleting the CR garbage-collects them. Physical volume deletion depends on the
StorageClass reclaim policy; use `Delete` for automatic disk cleanup. A restarted Pod
reattaches the same PVC, preserving the daemon's identity and local state.

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
can cause OOM termination, and storage capacity depends on CSI enforcement. This
version has no idle eviction, result export, TTL, automatic git checkout or remote
Playbooks dispatch. Those can be added without changing the execution boundary.

The main daemon must reach cluster Service DNS and addresses; the reverse endpoint
must be reachable from Pods. Deploying the main daemon in-cluster is the simplest
configuration. Workspace pods receive no Kubernetes service account token. The
operator has namespace-scoped permissions and does not read Secrets; the kubelet
injects only a named Secret's environment into the workspace. Configure network
policy and daemon authentication to match your cluster's trust boundary.

References:
- https://github.com/getpaseo/paseo/blob/main/docs/connected-hosts.md
- https://github.com/getpaseo/paseo/blob/main/public-docs/plugins/reference.md
