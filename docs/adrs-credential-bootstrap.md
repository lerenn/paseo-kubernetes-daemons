# Decision: explicit credential snapshots and pod bootstrap

Status: accepted for this implementation.

Keep provider-specific credential discovery in the main-daemon companion, where
existing login files and MCP configuration are accessible. The operator receives
resource references only and never needs to read or interpret credential bytes.

Use immutable versioned Secrets and ConfigMaps so changing a selection cannot
silently change an existing workspace's identity, repository or authentication.
The active reference is host-scoped plugin configuration. Export happens only via
the human-facing sync RPC; agent tools only create/list/release environments.
The UI does not receive raw credential values. kubectl error text is redacted
because API admission errors can include the rejected Secret payload.

Use an init container to create private writable Codex files; mounting read-only
login files directly prevents normal token refresh. Keep raw file Secret mounts
out of the daemon container. Selected environment credentials are deliberately
available to provider/MCP processes, as are the copied credential files.

Use an explicit approved repository origin, cloned to a fixed path, for repeatable
project trust. Root project MCP definitions are removed to prevent precedence over
the chosen user-config snapshot. This modifies the ephemeral working copy, not the
source repository. Other project settings are retained. Nested configurations are
outside the selection filter and remain under the approved repository's trust.

Codex file-backed login and MCP caches are credential snapshots. Concurrent OAuth
refresh across copies is not coordinated. Avoid promising transparent indefinite
session reuse; a broker or provider-aware refresh service requires a separate design.
Do not fabricate access to OS-keychain credentials. Document the supported sources
and show unavailable credentials instead of exporting unrelated host files.

Default companion-created environments to ephemeral storage. Keep direct CRs
persistent by default for backward compatibility. With ephemeral pod replacement,
Paseo's pinned-host identity check must not be silently bypassed.
