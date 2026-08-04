# Thymer Plugins Manager (fork)

Install, update, discover, and back up Thymer plugins, collection plugins, and
themes from a single panel.

**This is a permanently diverged fork of
[ahpatel/thymer-plugins-manager](https://github.com/ahpatel/thymer-plugins-manager)**
(forked at v1.4.0, maintained by [@jkroes](https://github.com/jkroes)). It does
not track upstream, and `__source_repo` points here so the manager self-updates
from this repository. The major divergence: backup/restore is **GitHub-only**
(Contents API) instead of upstream's file/folder pathways, because the plain
`fetch` approach works everywhere the plugin runs — including the Thymer
desktop app, where the File System Access folder picker is not wired up.

## Features

| Tab | Purpose |
| --- | --- |
| **Plugins** | Install, update, reinstall, disable/enable, or delete app plugins. |
| **Collections** | Same actions for collection plugins. Every Thymer collection appears here (a collection *is* a collection plugin); only GitHub-sourced ones are update-checked. |
| **Themes** | Theme Library: save themes from a GitHub URL or pasted CSS, preview, and export all saved themes as one merged stylesheet. |
| **Discover** | Browse, search, and one-click-install community plugins and themes from configurable repository README files. |
| **Settings** | GitHub PAT, community repo URLs, backup repository, restore. |

- **Install from GitHub** by pasting a repo URL. Discovers `plugin.json` /
  `plugin.js` / CSS automatically, including subdirectories, SDK examples,
  extensionless Thymer exports, and other naming conventions.
- **Update checks** run daily in the background (rate-limit aware) and badge
  the statusbar icon. An update is offered only when the remote version is
  **strictly newer** than the installed one — a GitHub repo that lags your
  local copy is reported as such, never offered as a downgrade. **Reinstall**
  is the explicit force-overwrite. Local plugins can be linked (🔗) to a repo
  to enable tracking.
- **Self-updating**: after the initial manual install, the manager updates
  itself like any other plugin, preserving your settings.
- **Panel behavior**: opens in the currently focused panel (full width), not a
  new split.
- **Failed installs** land on an incompatible list (30-day TTL) with a manual
  Recheck button.
- **Hardening**: HTML-escaping of all user-controlled strings before DOM
  injection, pre-save JS validation (catches module syntax/errors before they
  can crash Thymer), GitHub-URL and HTTPS-only validation, cleanup of
  intervals/modals/blob URLs on unload.

## Installation

The manager manages other plugins, so bootstrap it manually once:

1. Create a new **Plugin** in your Thymer workspace.
2. Paste `dist/plugin.js` into **Custom Code**, `plugin.json` into **Config**,
   and `plugin.css` into **Custom CSS**. (`plugin.js` is module-style source —
   Thymer's editor rejects its `export`; rebuild the bundle with `./build.sh .`.)
3. Save. A 📦 icon appears in the statusbar; open it from there or via the
   command palette (**Cmd+P → Open Plugins Manager**).

Future updates arrive through the manager itself. If the source link is ever
lost, click 🔗 on the Plugins Manager card and enter
`https://github.com/jkroes/thymer-plugins-manager`.

## Backup & restore (GitHub-only)

Backups are automatic and always on — there is no manual backup button, no
file downloads, and no folder picker (all removed from upstream).

- **Setup**: in Settings, set the backup repository (`owner/name`), branch,
  and file path, plus a PAT with **read/write Contents** permission on that
  repository. Keep the repository **private** — backups contain full plugin
  configurations.
- **What's backed up**: every plugin/collection/theme change commits a full
  snapshot — global plugin code + config, every collection's schema/code/CSS
  (topologically sorted so record relations restore in order), the Theme
  Library, and manager settings. Commits are debounced and skipped when
  content is identical (which also dedupes multiple open clients). **Not**
  included: the records inside collections (use Thymer's own export) and the
  PAT, which is redacted from every payload.
- **Restore**: Settings → **Restore from GitHub** lists the backup file's
  commit history (paged 50 at a time); pick a point in time, review, and
  import — optionally **Full Override**, which deletes anything not in the
  chosen backup. After a workspace rewind, re-paste the PAT once, then
  restore.

## Development

The plugin is plain source at the repo root (`plugin.js`, `plugin.json`,
`plugin.css`) — no build step. To ship a change: edit, **bump `version` in
`plugin.json`**, commit, and push; then apply the update from the manager in
Thymer. The updater only offers strictly newer versions, so an unpushed
version bump just means the manual check reports "ahead of GitHub" until you
push.
