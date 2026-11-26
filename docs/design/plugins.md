# Plugins in pod daemons

## Goal

Install a chosen set of Paseo plugins in every workspace pod daemon, pinned and explicitly
configured by the user. Nothing from the main daemon's own plugin configuration or secrets is
copied implicitly.

## Why post-start

`paseo plugin install` connects to a running daemon. The bootstrap init container runs before the
daemon exists, so installation happens in the daemon container through the wrapper
`images/daemon/install-plugins.py` (see docs/architecture.md, "Plugins").

## Settings (plugin side)

`settings.plugins`: list of `{source, ref, enabled, env}`.

- `source`: registry slug, Git URL or npm source accepted by `paseo plugin install`.
- `ref`: pinned Git branch, tag or commit (required for Git sources; the UI warns on branch names).
- `enabled`: disabled entries are kept but not synced to workspaces.
- `env`: optional variables for the plugin, e.g. a token. Values are stored with the plugin
  settings; they are never shown after saving and never logged.

Entries exist only when the user adds them (suggestions: GitHub Proxy, Mail, Playbooks, Prompts).

## Sync

`plugins.sync` writes one Secret per entry with env, named `pw-plugin-<digest>` (digest of source,
ref and env, so a change creates a new Secret and old workspaces keep theirs), labelled with the
plugin's owner label like the other synced objects. Then the gateway catalog entries get
`plugins: [{source, ref, configSecret}]` (enabled entries only), and the gateway copies them into
`spec.bootstrap.plugins` (`configSecretName`) of each new workspace. Single-environment creation
does the same.

## Limits and failure handling

At most 16 plugins. Entries are validated in the plugin, the gateway, the operator and the wrapper.
A failed install is reported as `Plugin N/M failed` without details and retried on next start.
