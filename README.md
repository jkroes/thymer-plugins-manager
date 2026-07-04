# Thymer Plugins Manager

A utility plugin for Thymer that allows you to install, manage, update, import, and export your Plugins and Collection Plugins from a single unified interface.

## Features

### Plugin Management

- **Centralized Dashboard**: View all installed Plugins and Collection Plugins in a clean, tabbed interface.
- **One-Click Install**: Install plugins by pasting a GitHub repository URL. Supports standard repos, subdirectories, SDK examples, and non-standard file naming conventions.
- **Smart File Discovery**: Automatically detects `plugin.json`, `plugin.js`, and CSS files — even when using custom filenames, extensionless Thymer exports, or nested folder structures.
- **Automated Update Checks**: Background update checking (daily) with rate-limit-aware GitHub API polling. Displays a badge when newer versions are available.
- **One-Click Updates**: Update any plugin to its latest GitHub version with pre-save validation to prevent incompatible code from crashing Thymer.
- **Link Local Plugins**: Associate locally-installed plugins with a GitHub repo to enable update tracking.

### Discover Tab

- **Community Plugin Browser**: Discover plugins and themes from configurable community repository README files.
- **Search & Filter**: Filter by name, description, or category. Filter chips for App Plugins, Collections, and Themes.
- **Theme Preview & Save**: Preview theme screenshots directly from the plugin's README, and save themes directly to your local Theme Library.
- **Incompatible Plugin Handling**: Plugins that fail to install are automatically added to an exception list (persisted in localStorage with 30-day TTL). Greyed-out Install buttons with a manual "Recheck" option to test for newer, compatible versions.
- **One-Click Installs**: Install community plugins directly from the Discover tab without copy-pasting code.
- **Smart Updates**: Background update checker runs twice daily and notifies you when new versions are available. Update a single plugin with one click or use "Update All" to batch apply all pending updates.

### Import & Export

- **Bulk Import**: Import multiple plugins via a list of GitHub URLs or a JSON backup file. Per-plugin duplicate resolution — skipping one plugin doesn't cancel the rest.
- **Full Override Restore**: When importing a JSON backup, optionally check "Full Override" to cleanly delete any currently installed plugins not present in the backup, restoring the exact configuration state.
- **Full Backup Export**: Download a complete JSON backup containing all plugin configuration and code, or export a simple URL list. Export filenames automatically include the workspace subdomain and timestamp.
- **Auto-Export**: Optionally auto-save a backup JSON file to a local directory whenever plugins are installed, updated, or deleted. Auto-exports feature timestamped and workspace-aware filenames. Uses the File System Access API.
- **Theme Library**: A dedicated tab to manage your saved themes. Add themes via GitHub URL (with smart CSS detection) or manual paste. Combine and export all saved themes into a single CSS file.

### Security & Reliability

- **XSS Prevention**: All user-controlled strings are HTML-escaped before DOM injection.
- **JS Validation**: Pre-save validation catches ES module syntax and syntax errors before they can crash Thymer's runtime.
- **Input Validation**: GitHub URL validation, HTTPS-only image rendering, and `rel="noopener noreferrer"` on all external links.
- **Memory Leak Prevention**: Intervals cleared on unload, blob URLs revoked, and dangling modals cleaned up.
- **Rate Limit Awareness**: Background update checker adds delays between requests and bails early on GitHub rate limits.

## Installation

Since this plugin manages other plugins, it must be installed manually first.

1. Create a new **Plugin** in your Thymer workspace.
2. Paste the contents of `plugin.js` into the **Custom Code** section of the plugin.
3. Paste the contents of `plugin.json` into the **Config** section.
4. Paste the contents of `styles.css` into the **Custom CSS** section.
5. Save the plugin. A new **Plugins Manager** icon (📦) will appear in your statusbar.

### Self-Update

After initial manual install, the PluginsManager will get future updates from its GitHub repo.  If the repo needs to be reset, you can manually enter the URL following these steps:

1. Open Plugins Manager → **Plugins** tab.
2. Click the 🔗 link icon on the Plugins Manager card.
3. Enter: `https://github.com/ahpatel/thymer-plugins-manager`
4. The update button (↻) will appear — click it to pull the latest version.

## Usage

Click the **Plugins Manager** icon in your left statusbar or from the Command Palette (Cmd+P) to open the dashboard.

### Tabs

| Tab | Purpose |
| ----- | --------- |
| **Plugins** | Manage workspace-level app plugins. Install, update, delete, import, export. |
| **Collections** | Manage collection-specific plugins. Same actions as Plugins. |
| **Themes** | Manage your Theme Library. Save themes from GitHub URLs or manual paste, and export a combined CSS block. |
| **Discover** | Browse community plugins and themes. Search, filter, install, or preview. |
| **Settings** | Configure GitHub PAT, community repo URLs, and auto-export preferences. |

### Settings

- **GitHub PAT** (Optional): Provide a Personal Access Token to increase API rate limits when managing many plugins or allow you to pull from your private repos.
- **Community Repositories**: List of raw Markdown URLs pointing to community plugin/theme directories.
- **Auto-Export**: Toggle automatic backup on every plugin change. Choose a local directory using the browser's directory picker.

## Browser Compatibility

- **Chrome / Edge**: Full support including Auto-Export (File System Access API flag must be enabled).
- **Firefox / Safari**: All features except Auto-Export (File System Access API not available).

## Development

To modify the Plugins Manager itself:

```bash
cd thymer-plugins-manager
npm install
npm run build
```

This bundles `plugin.js` via esbuild into the `dist/` directory.
