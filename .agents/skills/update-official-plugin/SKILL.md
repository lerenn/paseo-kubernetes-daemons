---
name: update-official-plugin
description: Publish the latest released version of this plugin to the official registry behind paseo.sh/plugins (getpaseo/plugins). Use when asked to update, bump, list or submit the plugin on the official listing. It finds the latest release tag, checks whether the plugin is listed and at which tag, writes a submission issue with the changes and permission notes, and closes superseded submissions.
---

# Update the official plugin listing

The listing on paseo.sh/plugins is the registry `getpaseo/plugins`. Git updates are **manual**:
the registry never scans our repository. An update is a new submission issue naming the release
tag; the bot opens a "Review" PR and a reviewer merges it.

**Registry status (checked 2026-11-24): this plugin is NOT listed.** There is no
`plugins/lerenn/paseo-kubernetes-daemons.json` (404) and no record for it under
`plugins/lerenn/` (only excalidraw, mail, playbooks). So the first run is a *new
submission*, not an update, and no registry id is known yet: do not invent one. The id is
assigned by the bot (by convention `lerenn/<name>`, e.g. `lerenn/mail`); the manifest id is
`kubernetes-daemons` and the display name `Kubernetes Daemons`. Re-check in step 2: if a
record now exists, use its path (`plugins/lerenn/<name>.json`) and follow the update flow.

Opening an issue is public and outward-facing: show the user the final body and get a yes
before step 5 (unless they already said to go ahead).

## Repository facts

- Repo: `lerenn/paseo-kubernetes-daemons`. The Paseo plugin lives in the **`plugin/`
  subfolder** (manifest `plugin/paseo-plugin.json`, icon `plugin/assets/icon.png`); the repo
  also contains the Go operator, the Helm chart and the workspace image.
- Version: `plugin/package.json` `version` and `charts/paseo-daemons/Chart.yaml`
  (`version` and `appVersion`) are bumped together in a "Release X.Y.Z" PR.
- Release: pushing a `vX.Y.Z` tag runs the **Release** workflow
  (`.github/workflows/release.yaml`), which publishes the operator image, the workspace image
  and the Helm chart to ghcr.io. It does **not** create a GitHub Release object, so use tags,
  not `gh release list`.
- Requirement: `requirements.paseo` in `plugin/paseo-plugin.json`.

## 1. Find the latest release

```bash
git fetch --tags origin
git tag --list 'v*' --sort=-v:refname | head -1           # latest tag, e.g. v0.2.5
gh api repos/lerenn/paseo-kubernetes-daemons/commits/<tag> -q .sha   # the commit it points at
git show origin/main:plugin/package.json | grep '"version"'
```

The tag must be on `main` and match `plugin/package.json` there. If the version on `main` has
no tag yet, stop: the release is not out (a maintainer pushes the tag; never create it here).

## 2. Read what is listed now

```bash
gh api repos/getpaseo/plugins/contents/plugins/lerenn --jq '.[].name'
gh api repos/getpaseo/plugins/contents/plugins/lerenn/<name>.json -q .content | base64 -d
```

If no record exists (current state), this is a first submission: skip to step 3 and say so in
the body. Otherwise note `artifact.tag` and `artifact.commit`; if it already equals the latest
tag, say so and stop. For a monorepo record, `artifact.pluginPath` should be `plugin`.

## 3. Check for pending submissions

```bash
gh issue list --repo getpaseo/plugins --author lerenn --state open
gh pr list --repo getpaseo/plugins --state open --search "Kubernetes Daemons"
```

Any open, unmerged submission for this plugin is superseded by the new one: list it in the new
issue and close it (step 6) so the reviewer sees only one.

## 4. Write the submission body

Collect the changes between the listed tag and the latest one (for a first submission, summarize
the plugin from `README.md` and `plugin/paseo-plugin.json` instead):

```bash
git log --oneline <listed-tag>..<latest-tag>
git diff --stat <listed-tag>..<latest-tag> -- plugin/paseo-plugin.json plugin/assets
git diff <listed-tag>..<latest-tag> -- plugin/server plugin/shared
```

Use this exact shape (the form fields are parsed: keep `### Source` and `### Categories`):

```markdown
### Source

https://github.com/lerenn/paseo-kubernetes-daemons/tree/<latest-tag>/plugin

### Categories

- [ ] Daemon management
- [ ] Themes
- [ ] Providers
- [ ] Orchestration
- [x] Workspaces
- [ ] Git
- [ ] Sidebar
- [ ] Extras
- [x] Utils

<First submission of Kubernetes Daemons, release <latest-tag>, commit `<latest-commit>`.
OR: Update of the existing `<registry-id>` listing (currently <listed-tag>, `<listed-commit>`)
to release <latest-tag>, commit `<latest-commit>`.>
The requirement is Paseo `<requirements.paseo>`.
<Say if the manifest and icon changed or not.>

**Permissions:** <what the plugin does: talks to the Kubernetes API with the user's kubeconfig
or the operator's gateway, writes credential/provider-profile files, spawns processes, makes
network calls. For an update, say unchanged or what changed. Write it from the actual diff of
`plugin/server/`: new process spawns, file writes and fetches.>

Changes since <listed-tag>:
- <grouped, user-facing bullets from the log, not a commit dump; omit for a first submission>

Supersedes #<n> (<tag>), which I am closing. <only if step 3 found some>
```

Adjust the ticked categories if the manifest or README say otherwise (confirm against the
form in `getpaseo/plugins/.github/ISSUE_TEMPLATE/submit-plugin.yml`, whose list may change).
The permissions note must match the artifact: the reviewer checks it.

## 5. Open the issue

```bash
gh issue create --repo getpaseo/plugins --label submission --title "Kubernetes Daemons" --body-file <file>
```

The title is the plugin's name (`name` in the manifest). Do not add a Git ref other than the
tag in the Source URL.

## 6. Close superseded submissions

For each one from step 3, comment that it is superseded by the new issue, then close it:

```bash
gh issue close <n> --repo getpaseo/plugins --comment "Superseded by #<new>."
gh pr close <pr> --repo getpaseo/plugins --comment "Superseded by #<new>."
```

## 7. Report and follow up

Give the user the issue link. Within about 30 minutes the bot opens the review PR
(`gh pr list --repo getpaseo/plugins --search "Kubernetes Daemons"`); the reviewer then tags
the author in the outcome. If a PR exists but nothing happens for a day, say so rather than
re-submitting. Do not open a second issue for the same tag.
