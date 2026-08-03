# plugins-manager

A Thymer plugin. Thymer is alpha and moves fast — verify behavior against the live app
before relying on it.

**General Thymer knowledge lives in the `thymer` skill, not here.** The data model, the
plugin SDK surface and its timing gotchas, MCP write safety, the Markdown Mirror,
diagnostics and theming are all documented there. This file is only for what is specific
to this plugin.

## Layout

- `plugin.js` + `plugin.json` — the plugin source and its configuration
- `./build.sh .` — bundle to `dist/plugin.js` (paste into Thymer → Edit Code → Custom Code,
  and `plugin.json` into the Configuration field)
- `./setup.sh` — re-link third-party deps after a fresh clone

`sdk/`, `bin/thymercli` and `examples/` are **symlinks into a shared cache** owned by the
`thymer-plugin-init` skill, and are gitignored. One cache update refreshes every plugin
repo at once — which also means an SDK refresh moves this repo underneath you. Run
`./setup.sh --refresh` deliberately rather than as a habit.

**Don't edit `sdk/`** — it's a vendored upstream snapshot shared with every other plugin
repo. Edits vanish on the next refresh and affect everything else in the meantime.

## Dev loop

```bash
./setup.sh                    # first time, or after a fresh clone
cd sdk && npm run dev         # esbuild bundles + pushes over CDP on save
```

For hot reload, run Chrome with remote debugging and enable it in the app:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --remote-debugging-port=9222 --user-data-dir=/tmp/chrome-debug-profile \
  --no-first-run https://<yoursite>.thymer.com
# In Thymer: Cmd+P → Plugins → create/select → Edit Code → Developer Tools → Enable Hot Reload
```

## Rules that override convenience

- **Never let plugin code touch the editor DOM.** A community plugin corrupted an
  encrypted workspace beyond repair. Only `this.ui.*`.
- **Never create pages or collections casually** — including for throwaway tests. Reuse
  what exists and clean up. If a task seems to require a genuinely new page or collection,
  ask first.
- **No `export` keyword** in code pasted into the Custom Code editor. `./build.sh` strips
  it; hand-pasting `plugin.js` does not.
- **Never override the constructor.** Initialize in `onLoad()`.

## Notes

`origin` is jkroes/thymer-plugins-manager, with full shared history — a plain
`git push origin main` works.
