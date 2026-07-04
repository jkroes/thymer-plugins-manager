class Plugin extends AppPlugin {

    onLoad() {
        // We load PAT from plugin configuration, removing from cleartext localstorage if found
        const conf = this.getConfiguration();
        this.githubPat = conf?.custom?.githubPat || '';
        if (localStorage.getItem('pm_github_pat')) localStorage.removeItem('pm_github_pat');
        if (localStorage.getItem('pm_github_pat_persistent')) localStorage.removeItem('pm_github_pat_persistent');
        this.communityRepos = conf?.custom?.community_repos || localStorage.getItem('pm_community_repos') || 'https://raw.githubusercontent.com/ed-nico/awesome-thymer/main/README.md';
        this._updateIntervalId = null;
        this._activeModals = []; // track all open modals for cleanup on unload
        try { this._disabledPlugins = JSON.parse(localStorage.getItem('pm_disabled_plugins') || '{}'); } catch (e) { this._disabledPlugins = {}; }
        try { this._incompatiblePlugins = JSON.parse(localStorage.getItem('pm_incompatible') || '{}'); } catch (e) { this._incompatiblePlugins = {}; }
        // Evict stale incompatible entries older than 30 days
        const _cutoff = Date.now() - 30 * 24 * 60 * 60 * 1000;
        Object.keys(this._incompatiblePlugins).forEach(k => {
            if (new Date(this._incompatiblePlugins[k].date || 0).getTime() < _cutoff)
                delete this._incompatiblePlugins[k];
        });
        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
        let savedThemes = conf?.custom?.saved_themes;

        if (!savedThemes) {
            const oldThemesRaw = localStorage.getItem('pm_saved_themes');
            if (oldThemesRaw) {
                try {
                    savedThemes = JSON.parse(oldThemesRaw);
                    // Schedule migration to config after load
                    setTimeout(() => {
                        this._savedThemes = savedThemes;
                        this._saveThemes();
                    }, 1000);
                } catch (e) { }
            }
        }

        this._savedThemes = savedThemes || [];
        this._autoExportEnabled = typeof conf?.custom?.auto_export_enabled === 'boolean'
            ? conf.custom.auto_export_enabled
            : localStorage.getItem('pm_auto_export') === 'true';
        this._autoExportDirHandle = null;
        this._autoExportDirName = localStorage.getItem('pm_auto_export_dir_name') || '';
        this._autoExportMode = localStorage.getItem('pm_auto_export_mode') || ''; // 'fsaccess' | 'download' | ''
        this._autoExportCaps = this._detectAutoExportCaps();
        // Restore directory handle from IndexedDB (browser File System Access API)
        this._restoreAutoExportHandle();

        // One-time migration: normalize pm_updates_available entries to {name, version}
        try {
            const rawUpdates = JSON.parse(localStorage.getItem('pm_updates_available') || '{}');
            let migrated = false;
            for (const k of Object.keys(rawUpdates)) {
                const v = rawUpdates[k];
                if (!v || typeof v !== 'object' || typeof v.version !== 'string') {
                    rawUpdates[k] = { name: '', version: typeof v === 'string' ? v : (v?.version || '') };
                    migrated = true;
                }
            }
            if (migrated) localStorage.setItem('pm_updates_available', JSON.stringify(rawUpdates));
        } catch (e) { /* ignore */ }

        // Register the panel type
        this.ui.registerCustomPanelType("plugin-manager-panel", (panel) => {
            this.renderUI(panel);
        });

        // Add a status bar button to launch it
        this._statusBarItem = this.ui.addStatusBarItem({
            icon: "box",
            tooltip: "Plugins Manager",
            onClick: async () => {
                const newPanel = await this.ui.createPanel();
                if (newPanel) {
                    newPanel.navigateToCustomType("plugin-manager-panel");
                }
            }
        });

        // Add a command palette command to launch it
        this.ui.addCommandPaletteCommand({
            label: "Open Plugins Manager",
            icon: "box",
            onSelected: async () => {
                const newPanel = await this.ui.createPanel();
                if (newPanel) {
                    newPanel.navigateToCustomType("plugin-manager-panel");
                }
            }
        });

        // Check if we just updated ourselves
        if (localStorage.getItem('pm_self_update_pending') === 'true') {
            localStorage.removeItem('pm_self_update_pending');
            setTimeout(async () => {
                try {
                    const newPanel = await this.ui.createPanel();
                    if (newPanel) {
                        newPanel.navigateToCustomType("plugin-manager-panel");
                    }
                } catch (e) { console.error('Failed to reopen panel after self-update', e); }
            }, 800);
        }

        // Reflect any already-cached updates in the status bar tooltip
        this._updateStatusBarIcon();

        // Start automated update checker
        this.startAutomatedUpdateChecker();
    }

    onUnload() {
        // Clean up interval to prevent memory leaks
        if (this._updateIntervalId) {
            clearInterval(this._updateIntervalId);
            this._updateIntervalId = null;
        }
        this._discoverItems = null;
        // Remove any dangling modals from the DOM to prevent memory leaks
        for (const modal of (this._activeModals || [])) {
            if (modal && modal.parentNode) modal.parentNode.removeChild(modal);
        }
        this._activeModals = [];
        // Disconnect responsive resize observer
        if (this._resizeObserver) {
            this._resizeObserver.disconnect();
            this._resizeObserver = null;
        }
        // Clean up instant-tooltip listeners + DOM
        if (this._tooltipCleanup) {
            try { this._tooltipCleanup(); } catch (e) { }
            this._tooltipCleanup = null;
        }
    }

    async startAutomatedUpdateChecker() {
        // Run daily
        const lastCheck = localStorage.getItem('pm_last_update_check');
        const now = Date.now();
        if (!lastCheck || now - parseInt(lastCheck) > 24 * 60 * 60 * 1000) {
            await this.checkForAllUpdatesInBackground();
            localStorage.setItem('pm_last_update_check', now.toString());
        }

        // Setup interval to check every 12 hours while open
        this._updateIntervalId = setInterval(() => this.checkForAllUpdatesInBackground(), 12 * 60 * 60 * 1000);
    }

    async checkForAllUpdatesInBackground(options = {}) {
        const isManual = options.manual === true;
        if (isManual) {
            this.ui.addToaster({ title: "Checking for updates...", message: "This may take a moment depending on the number of plugins.", autoDestroyTime: 3000, dismissible: true });
        }

        try {
            const updatesAvailable = {};
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const allPlugins = [...allGlobals, ...allCollections];
            let checkCount = 0;
            const MAX_CHECKS = isManual ? 100 : 50; // Higher cap for manual checks

            for (const p of allPlugins) {
                if (checkCount >= MAX_CHECKS) break;

                try {
                    const { json } = p.getExistingCodeAndConfig();
                    const repo = json.__source_repo;
                    if (repo && this._isValidGithubUrl(repo)) {
                        checkCount++;
                        const { json: remoteJson } = await this.fetchGithubRepo(repo, { sourceFiles: json.__source_files });
                        if (remoteJson.version && remoteJson.version !== json.version) {
                            updatesAvailable[p.getGuid()] = {
                                name: json.name || "Unnamed Plugin",
                                version: remoteJson.version
                            };
                        }
                        // Avoid GitHub rate limiting between requests
                        await new Promise(r => setTimeout(r, isManual ? 500 : 1000));
                    }
                } catch (e) {
                    if (e.message && (e.message.includes('rate limit') || e.message.includes('403'))) {
                        console.warn('[Plugins Manager] GitHub rate limit hit during check, stopping early.');
                        if (isManual) {
                            this.ui.addToaster({ title: "Rate Limit Hit", message: "GitHub API rate limit reached. Please try again later or add a PAT in Settings.", autoDestroyTime: 5000, dismissible: true });
                        }
                        localStorage.setItem('pm_last_update_check', (Date.now() + 6 * 60 * 60 * 1000).toString());
                        break;
                    }
                }
            }

            localStorage.setItem('pm_updates_available', JSON.stringify(updatesAvailable));
            localStorage.setItem('pm_last_update_check_success', Date.now().toString());
            this._updateStatusBarIcon();

            // Notify user if new updates were found
            const updateCount = Object.keys(updatesAvailable).length;
            if (updateCount > 0) {
                const previousUpdatesStr = localStorage.getItem('pm_last_notified_updates') || '{}';
                let previousUpdates = {};
                try { previousUpdates = JSON.parse(previousUpdatesStr); } catch (e) { }

                // Only notify if there are updates whose version differs from last notification
                let hasNewUpdates = false;
                for (const [guid, info] of Object.entries(updatesAvailable)) {
                    const prev = previousUpdates[guid];
                    const prevVersion = (prev && typeof prev === 'object') ? prev.version : prev;
                    if (prevVersion !== info.version) {
                        hasNewUpdates = true;
                        break;
                    }
                }

                if (hasNewUpdates) {
                    this.ui.addToaster({
                        title: "Plugin Updates Available",
                        message: `${updateCount} plugin${updateCount === 1 ? '' : 's'} can be updated. Open Plugins Manager to apply.`,
                        autoDestroyTime: 8000,
                        dismissible: true
                    });
                    localStorage.setItem('pm_last_notified_updates', JSON.stringify(updatesAvailable));
                }
            }
        } catch (e) {
            console.error("Update check failed", e);
            if (isManual) {
                this.ui.addToaster({ title: "Update Check Failed", message: e.message, autoDestroyTime: 5000, dismissible: true });
            }
        }
    }

    _updateStatusBarIcon() {
        if (!this._statusBarItem) return;
        const updates = this._readUpdateCache();
        const count = Object.keys(updates).length;
        if (count > 0) {
            const pluginNames = Object.values(updates).map(u => u.name || '').filter(Boolean).join(', ');
            // Some environments truncate native tooltips; keep it to two lines maximum
            this._statusBarItem.setTooltip(`Plugins Manager: ${count} update${count > 1 ? 's' : ''} available${pluginNames ? '\n' + pluginNames : ''}`);
        } else {
            this._statusBarItem.setTooltip("Plugins Manager");
        }
    }

    /** Normalize pm_updates_available to {name, version} shape. */
    _readUpdateCache() {
        let raw;
        try { raw = JSON.parse(localStorage.getItem('pm_updates_available') || '{}'); }
        catch (e) { return {}; }
        const out = {};
        for (const [k, v] of Object.entries(raw || {})) {
            if (v && typeof v === 'object' && typeof v.version === 'string') {
                out[k] = { name: v.name || '', version: v.version };
            } else if (typeof v === 'string' && v) {
                out[k] = { name: '', version: v };
            }
        }
        return out;
    }

    _writeUpdateCache(cache) {
        try { localStorage.setItem('pm_updates_available', JSON.stringify(cache)); } catch (e) { }
    }

    renderUI(panel) {
        const html = `
            <div class="pm-container">
                <div class="pm-header">
                    <h1>Plugins Manager</h1>
                    <button class="pm-btn pm-btn-check-updates" id="pm-check-updates-btn" title="Check All Updates">
                        <span class="pm-btn-icon" aria-hidden="true">↻</span>
                        <span class="pm-btn-label">Check All Updates</span>
                    </button>
                </div>
                
                <div class="pm-tabs">
                    <div class="pm-tab active" data-tab="global" title="Plugins"><span class="pm-tab-icon" data-icon="puzzle"></span><span class="pm-tab-label">Plugins</span></div>
                    <div class="pm-tab" data-tab="collections" title="Collections"><span class="pm-tab-icon" data-icon="folder"></span><span class="pm-tab-label">Collections</span></div>
                    <div class="pm-tab" data-tab="themes" title="Themes"><span class="pm-tab-icon" data-icon="brush"></span><span class="pm-tab-label">Themes</span></div>
                    <div class="pm-tab" data-tab="discover" title="Discover"><span class="pm-tab-icon" data-icon="compass"></span><span class="pm-tab-label">Discover</span></div>
                    <div class="pm-tab" data-tab="settings" title="Settings"><span class="pm-tab-icon" data-icon="settings"></span><span class="pm-tab-label">Settings</span></div>
                </div>

                <div class="pm-tab-content active" id="tab-global">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-install-global-btn">Install Plugin</button>
                            <button class="pm-btn" id="pm-import-global-btn">Restore Plugins</button>
                            <button class="pm-btn" id="pm-export-global-btn">Backup Plugins</button>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn pm-btn-update" id="pm-check-updates-global-btn" title="Check for plugin updates"><span class="pm-btn-icon" aria-hidden="true">↻</span></button>
                            <button class="pm-btn pm-btn-update update-btn pm-hidden" id="pm-update-all-global-btn">Update All</button>
                        </div>
                    </div>
                    <div id="pm-global-list" class="pm-list-container">Loading...</div>
                </div>

                <div class="pm-tab-content" id="tab-collections">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-install-col-btn">Install Collection Plugin</button>
                            <button class="pm-btn" id="pm-import-col-btn">Restore Collections</button>
                            <button class="pm-btn" id="pm-export-col-btn">Backup Collections</button>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn pm-btn-update" id="pm-check-updates-col-btn" title="Check for collection updates"><span class="pm-btn-icon" aria-hidden="true">↻</span></button>
                            <button class="pm-btn pm-btn-update update-btn pm-hidden" id="pm-update-all-col-btn">Update All</button>
                        </div>
                    </div>
                    <div id="pm-collections-list" class="pm-list-container">Loading...</div>
                </div>

                
                
                <div class="pm-tab-content" id="tab-discover">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <input type="text" id="pm-discover-search" class="pm-input pm-search-input" placeholder="Search plugins, collections, themes..." autocomplete="off" />
                            <div class="pm-filter-chips">
                                <button class="pm-filter-chip active" data-filter="all">All</button>
                                <button class="pm-filter-chip" data-filter="app">Plugins</button>
                                <button class="pm-filter-chip" data-filter="collection">Collections</button>
                                <button class="pm-filter-chip" data-filter="theme">Themes</button>
                            </div>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn" id="pm-refresh-discover-btn">Refresh</button>
                        </div>
                    </div>
                    <div id="pm-discover-list" class="pm-list-container">Loading...</div>
                </div>

                
                <div class="pm-tab-content" id="tab-themes">
                    <div class="pm-tab-toolbar">
                        <div class="pm-tab-actions pm-tab-actions-primary">
                            <button class="pm-btn primary" id="pm-add-theme-github-btn">Add from GitHub</button>
                            <button class="pm-btn" id="pm-add-theme-manual-btn">Paste CSS</button>
                        </div>
                        <div class="pm-tab-actions pm-tab-actions-secondary">
                            <button class="pm-btn" id="pm-export-all-themes-btn">Backup Theme CSS</button>
                        </div>
                    </div>
                    <div id="pm-themes-list" class="pm-list-container"></div>
                </div>

                <div class="pm-tab-content" id="tab-settings">
                    <div class="pm-card pm-settings-card">
                        <form class="pm-settings-form" onsubmit="return false;">
                            <div class="pm-settings-section">
                                <h3>GitHub Access</h3>
                                <div class="pm-input-group">
                                <label>GitHub Personal Access Token (Optional)</label>
                                <p class="pm-settings-help">
                                    Provide a PAT to increase API rate limits when updating or restoring many plugins. It is stored only in this plugin's configuration.
                                </p>
                                <input type="password" id="pm-pat-input" class="pm-input" placeholder="ghp_xxxxxxxxxxxx" value="${this._escHtml(this.githubPat)}" autocomplete="off">
                            </div>
                            </div>
                            
                            <div class="pm-settings-section">
                                <h3>Community Sources</h3>
                                <div class="pm-input-group pm-input-group-flush">
                                <label>Community Repositories</label>
                                <p class="pm-settings-help">
                                    List of raw Markdown URLs (one per line) to discover community plugins and themes.
                                </p>
                                <textarea id="pm-repos-input" class="pm-textarea pm-textarea-urls" placeholder="https://raw.githubusercontent.com/.../README.md">${this._escHtml(this.communityRepos)}</textarea>
                            </div>
                            </div>

                            <div class="pm-settings-section">
                                <h3>Workspace Backup &amp; Restore</h3>
                                <p class="pm-settings-help">
                                    Create a single backup for plugins, collections, theme library, and Plugins Manager settings, or restore that backup into a new workspace.
                                </p>
                                <div class="pm-tab-actions pm-settings-actions">
                                    <button type="button" class="pm-btn primary" id="pm-export-workspace-btn">Backup Workspace</button>
                                    <button type="button" class="pm-btn" id="pm-import-workspace-btn">Restore Workspace</button>
                                    <button type="button" class="pm-btn" id="pm-export-workspace-themes-btn">Backup Theme CSS</button>
                                </div>
                                <div id="pm-workspace-summary" class="pm-settings-summary"></div>
                            </div>

                            <div class="pm-settings-section">
                                <h3>Automatic Backups</h3>
                                <label class="pm-checkbox-row">
                                    <input type="checkbox" id="pm-auto-export-toggle" ${this._autoExportEnabled ? 'checked' : ''} />
                                    Auto-Backup Workspace on Changes
                                </label>
                                <p class="pm-settings-help pm-settings-help-tight">
                                    Automatically save a full workspace backup whenever plugins, collections, or themes change.
                                </p>
                                <div class="pm-inline-row">
                                    <button type="button" class="pm-btn" id="pm-auto-export-dir-btn">${this._autoExportCaps.hasFSAccess ? 'Choose Directory' : 'Choose Destination'}</button>
                                    <span id="pm-auto-export-dir-label" class="pm-settings-help pm-settings-help-flush">${this._escHtml(this._autoExportDestinationLabel())}</span>
                                </div>
                                <p class="pm-settings-help pm-settings-hint" id="pm-auto-export-mode-help">${this._escHtml(this._autoExportModeHint())}</p>
                            </div>

                            <div class="pm-settings-footer">
                                <button type="button" class="pm-btn primary" id="pm-save-settings">Save Settings</button>
                            </div>
                        </form>
                    </div>
                </div>
            </div>
        `;

        const element = panel.getElement();
        if (element) {
            element.innerHTML = html;
            this._populateTabIcons(element);
            this._installInstantTooltips(element);
            this.bindEvents(element, panel);
            this.loadPlugins(element);
            // Discover tab is loaded lazily on first click (see bindEvents)
        }
    }

    /**
     * Show button tooltips instantly (no browser title delay) for any element
     * inside the plugin panel that has a [title] attribute. The native title
     * is moved to data-pm-tip during hover so the browser's slow default
     * tooltip doesn't double up.
     */
    _installInstantTooltips(root) {
        if (!root) return;
        const tip = document.createElement('div');
        tip.className = 'pm-tooltip';
        tip.setAttribute('role', 'tooltip');
        tip.style.display = 'none';
        document.body.appendChild(tip);
        this._tooltipEl = tip;

        let activeTarget = null;

        const hide = () => {
            tip.style.display = 'none';
            if (activeTarget && activeTarget.dataset && activeTarget.dataset.pmTip != null) {
                // restore native title on leave so it remains accessible to
                // accessibility tools / non-mouse interactions
                activeTarget.setAttribute('title', activeTarget.dataset.pmTip);
                delete activeTarget.dataset.pmTip;
            }
            activeTarget = null;
        };

        const show = (target, ev) => {
            const text = target.getAttribute('title') || target.dataset.pmTip;
            if (!text) return;
            // suppress browser's native delayed tooltip while we show our own
            if (target.hasAttribute('title')) {
                target.dataset.pmTip = target.getAttribute('title');
                target.removeAttribute('title');
            }
            activeTarget = target;
            tip.textContent = text;
            tip.style.display = 'block';
            this._positionTooltip(tip, target, ev);
        };

        const onOver = (e) => {
            const target = e.target.closest('[title], [data-pm-tip]');
            if (!target || !root.contains(target)) return;
            if (target === activeTarget) return;
            if (activeTarget) hide();
            show(target, e);
        };

        const onOut = (e) => {
            if (!activeTarget) return;
            const next = e.relatedTarget;
            if (next && activeTarget.contains(next)) return;
            hide();
        };

        const onMove = (e) => {
            if (activeTarget) this._positionTooltip(tip, activeTarget, e);
        };

        const onScrollOrBlur = () => hide();

        root.addEventListener('mouseover', onOver);
        root.addEventListener('mouseout', onOut);
        root.addEventListener('mousemove', onMove);
        window.addEventListener('scroll', onScrollOrBlur, true);
        window.addEventListener('blur', onScrollOrBlur);

        this._tooltipCleanup = () => {
            root.removeEventListener('mouseover', onOver);
            root.removeEventListener('mouseout', onOut);
            root.removeEventListener('mousemove', onMove);
            window.removeEventListener('scroll', onScrollOrBlur, true);
            window.removeEventListener('blur', onScrollOrBlur);
            if (tip.parentNode) tip.parentNode.removeChild(tip);
            this._tooltipEl = null;
        };
    }

    /** Position the tooltip just below the target, flipped above if needed. */
    _positionTooltip(tip, target) {
        const rect = target.getBoundingClientRect();
        // Make sure we measure final size
        tip.style.left = '0px';
        tip.style.top = '0px';
        const tipRect = tip.getBoundingClientRect();
        const margin = 6;
        let left = rect.left + (rect.width / 2) - (tipRect.width / 2);
        let top = rect.bottom + margin;
        // Flip above if no room below
        if (top + tipRect.height > window.innerHeight - 4) {
            top = rect.top - tipRect.height - margin;
        }
        // Clamp horizontally inside viewport
        left = Math.max(4, Math.min(left, window.innerWidth - tipRect.width - 4));
        tip.style.left = `${Math.round(left)}px`;
        tip.style.top = `${Math.round(top)}px`;
    }

    /**
     * Replace [data-icon] placeholder spans with Thymer's native icons (Tabler).
     * Falls back silently if the icon name is unsupported by the host build.
     */
    _populateTabIcons(root) {
        const slots = root.querySelectorAll('.pm-tab-icon[data-icon]');
        slots.forEach(slot => {
            const name = slot.getAttribute('data-icon');
            if (!name) return;
            try {
                const icon = this.ui.createIcon(name);
                if (icon) {
                    slot.innerHTML = '';
                    slot.appendChild(icon);
                }
            } catch (e) { /* ignore unsupported icon names */ }
        });
    }

    bindEvents(container, panel) {
        container.querySelector('#pm-check-updates-btn').addEventListener('click', () => {
            this.checkForAllUpdatesInBackground({ manual: true });
        });

        // Tabs
        container.querySelector('.pm-tabs').addEventListener('click', (e) => {
            const tabBtn = e.target.closest('.pm-tab');
            if (!tabBtn) return;
            // Remove active classes
            container.querySelectorAll('.pm-tab').forEach(el => el.classList.remove('active'));
            container.querySelectorAll('.pm-tab-content').forEach(el => el.classList.remove('active'));

            // Add active class
            tabBtn.classList.add('active');
            const tabId = tabBtn.getAttribute('data-tab');
            container.querySelector(`#tab-${tabId}`).classList.add('active');

            // Lazy-load Discover tab on first click
            if (tabId === 'discover' && !this._discoverItems) {
                this.loadDiscoverPlugins(container);
            }

            if (tabId === 'global' || tabId === 'collections') this.loadPlugins(container);
            else if (tabId === 'themes') this._renderThemesList(container);
            else if (tabId === 'settings') this._renderWorkspaceSummary(container);
        });

        // Responsive: toggle 'narrow' (icon tabs) and 'wide' (multi-col cards) based on container width
        const pmContainer = container.querySelector('.pm-container');
        if (pmContainer && window.ResizeObserver) {
            this._resizeObserver = new ResizeObserver(entries => {
                for (const entry of entries) {
                    const w = entry.contentRect.width;
                    pmContainer.classList.toggle('narrow', w < 520);
                    pmContainer.classList.toggle('compact', w < 760);
                    pmContainer.classList.toggle('wide', w > 700);
                }
            });
            this._resizeObserver.observe(pmContainer);
        }

        // Settings
        container.querySelector('#pm-save-settings').addEventListener('click', async () => {
            const pat = container.querySelector('#pm-pat-input').value.trim();
            const repos = container.querySelector('#pm-repos-input').value.trim();
            const autoExport = container.querySelector('#pm-auto-export-toggle').checked;
            await this._saveManagerSettings({ githubPat: pat, communityRepos: repos, autoExportEnabled: autoExport });
            this._renderWorkspaceSummary(container);

            this.ui.addToaster({ title: "Settings Saved", dismissible: true, autoDestroyTime: 3000 });
        });

        // Auto-export directory / destination picker (adapts to environment)
        container.querySelector('#pm-auto-export-dir-btn').addEventListener('click', async () => {
            await this._chooseAutoExportTarget(container);
        });


        container.querySelector('#pm-refresh-discover-btn').addEventListener('click', () => {
            this.loadDiscoverPlugins(container);
        });

        // Discover search
        container.querySelector('#pm-discover-search').addEventListener('input', () => {
            this._filterDiscoverList(container);
        });

        // Discover filter chips
        container.querySelectorAll('.pm-filter-chip').forEach(chip => {
            chip.addEventListener('click', (e) => {
                container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
                e.target.classList.add('active');
                this._filterDiscoverList(container);
            });
        });


        container.querySelector('#pm-add-theme-github-btn').addEventListener('click', () => this._addThemeFromGithub(container));
        container.querySelector('#pm-add-theme-manual-btn').addEventListener('click', () => this._addThemeManually(container));
        container.querySelector('#pm-export-all-themes-btn').addEventListener('click', () => this._exportAllThemes());
        this._renderThemesList(container);
        this._renderWorkspaceSummary(container);

        // Actions
        container.querySelector('#pm-install-global-btn').addEventListener('click', () => this.showInstallDialog(container, 'app'));
        container.querySelector('#pm-import-global-btn').addEventListener('click', () => this.showImportDialog(container, 'app'));
        container.querySelector('#pm-export-global-btn').addEventListener('click', () => this.showExportDialog('app'));
        container.querySelector('#pm-check-updates-global-btn').addEventListener('click', () => this._manualCheckForUpdates(container, 'app'));
        container.querySelector('#pm-update-all-global-btn').addEventListener('click', () => this._updateAllAvailable(container, 'app'));

        container.querySelector('#pm-install-col-btn').addEventListener('click', () => this.showInstallDialog(container, 'collection'));
        container.querySelector('#pm-import-col-btn').addEventListener('click', () => this.showImportDialog(container, 'collection'));
        container.querySelector('#pm-export-col-btn').addEventListener('click', () => this.showExportDialog('collection'));
        container.querySelector('#pm-check-updates-col-btn').addEventListener('click', () => this._manualCheckForUpdates(container, 'collection'));
        container.querySelector('#pm-update-all-col-btn').addEventListener('click', () => this._updateAllAvailable(container, 'collection'));
        container.querySelector('#pm-export-workspace-btn').addEventListener('click', () => this.showExportDialog('all'));
        container.querySelector('#pm-import-workspace-btn').addEventListener('click', () => this.showImportDialog(container, 'all'));
        container.querySelector('#pm-export-workspace-themes-btn').addEventListener('click', () => this._exportAllThemes());

        // Delegated handler for external links (replaces <a target="_blank"> which is blocked in some environments)
        container.addEventListener('click', (e) => {
            const linkEl = e.target.closest('[data-external-url]');
            if (linkEl) {
                e.preventDefault();
                this._openExternalLink(linkEl.dataset.externalUrl);
            }
        });
    }

    async _saveManagerSettings(overrides = {}) {
        const conf = this.getConfiguration();
        if (!conf.custom) conf.custom = {};

        if (overrides.githubPat !== undefined) {
            this.githubPat = overrides.githubPat;
            conf.custom.githubPat = overrides.githubPat;
            localStorage.removeItem('pm_github_pat_persistent');
        }
        if (overrides.communityRepos !== undefined) {
            this.communityRepos = overrides.communityRepos;
            conf.custom.community_repos = overrides.communityRepos;
            localStorage.setItem('pm_community_repos', overrides.communityRepos);
        }
        if (overrides.savedThemes !== undefined) {
            this._savedThemes = this._cloneJsonValue(Array.isArray(overrides.savedThemes) ? overrides.savedThemes : []);
            conf.custom.saved_themes = this._savedThemes;
        }
        if (overrides.autoExportEnabled !== undefined) {
            this._autoExportEnabled = !!overrides.autoExportEnabled;
            conf.custom.auto_export_enabled = !!overrides.autoExportEnabled;
            localStorage.setItem('pm_auto_export', this._autoExportEnabled ? 'true' : 'false');
        }

        try {
            const plugin = this.data.getPluginByGuid(this.getGuid());
            if (plugin) {
                await plugin.saveConfiguration(conf);
            } else if (typeof this.saveConfiguration === 'function') {
                await this.saveConfiguration(conf);
            }
        } catch (e) {
            console.warn('[Plugins Manager] Failed to persist manager settings:', e);
        }
    }

    async _renderWorkspaceSummary(container) {
        const summaryEl = container.querySelector('#pm-workspace-summary');
        if (!summaryEl) return;

        try {
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            const themeCount = Array.isArray(this._savedThemes) ? this._savedThemes.length : 0;
            let autoBackupState;
            if (!this._autoExportEnabled) {
                autoBackupState = 'Auto-backup is disabled';
            } else if (this._autoExportMode === 'download' || (!this._autoExportCaps.hasFSAccess && !this._autoExportDirHandle)) {
                autoBackupState = this._autoExportMode === 'download'
                    ? 'Auto-backup is enabled (downloads on each change)'
                    : 'Auto-backup is enabled but needs a destination to be selected';
            } else if (this._autoExportDirHandle) {
                autoBackupState = `Auto-backup is enabled${this._autoExportDirName ? ` for ${this._autoExportDirName}` : ''}`;
            } else {
                autoBackupState = 'Auto-backup is enabled but needs a directory to be re-selected';
            }
            summaryEl.innerHTML = `
                <div class="pm-summary-grid">
                    <div class="pm-summary-card">
                        <strong>${allGlobals.length}</strong>
                        <span>Plugins</span>
                    </div>
                    <div class="pm-summary-card">
                        <strong>${allCollections.length}</strong>
                        <span>Collections</span>
                    </div>
                    <div class="pm-summary-card">
                        <strong>${themeCount}</strong>
                        <span>Saved Themes</span>
                    </div>
                </div>
                <div class="pm-summary-note">${this._escHtml(autoBackupState)}</div>
            `;
        } catch (e) {
            summaryEl.textContent = 'Unable to load workspace summary.';
        }
    }

    _getSectionMeta(typeFilter) {
        if (typeFilter === 'all') {
            return {
                label: 'Workspace',
                itemLabel: 'workspace items',
                importLabel: 'Workspace',
                warningLabel: 'plugins and collections'
            };
        }
        if (typeFilter === 'collection') {
            return {
                label: 'Collections',
                itemLabel: 'collections',
                importLabel: 'Collections',
                warningLabel: 'collections'
            };
        }
        return {
            label: 'Plugins',
            itemLabel: 'plugins',
            importLabel: 'Plugins',
            warningLabel: 'plugins'
        };
    }


    async loadDiscoverPlugins(container) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = 'Fetching community plugins...';

        // Reset search and filters
        const searchInput = container.querySelector('#pm-discover-search');
        if (searchInput) searchInput.value = '';
        container.querySelectorAll('.pm-filter-chip').forEach(c => c.classList.remove('active'));
        const allChip = container.querySelector('.pm-filter-chip[data-filter="all"]');
        if (allChip) allChip.classList.add('active');

        try {
            const repos = this.communityRepos.split('\n').map(u => u.trim()).filter(Boolean);
            if (repos.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No community repositories configured in Settings.</p></div></div>';
                return;
            }

            const items = [];

            for (const repoUrl of repos) {
                try {
                    // Security: only fetch HTTPS URLs to prevent data exfiltration
                    if (!repoUrl.startsWith('https://')) {
                        console.warn('[Plugins Manager] Skipping non-HTTPS community repo:', repoUrl);
                        continue;
                    }

                    // Pre-flight check to ensure we aren't fetching a massive file
                    const headRes = await fetch(repoUrl, { method: 'HEAD' });
                    if (!headRes.ok) continue;

                    const contentType = headRes.headers.get('content-type') || '';
                    if (contentType && !contentType.includes('text/plain') && !contentType.includes('text/markdown')) {
                        console.warn('[Plugins Manager] Skipping repo with invalid content-type:', repoUrl);
                        continue;
                    }

                    const contentLength = headRes.headers.get('content-length');
                    if (contentLength && parseInt(contentLength) > 10 * 1024 * 1024) { // 10MB limit
                        console.warn('[Plugins Manager] Skipping repo that is too large:', repoUrl);
                        continue;
                    }

                    const res = await fetch(repoUrl);
                    if (!res.ok) continue;
                    const text = await res.text();

                    const lines = text.split('\n');
                    let currentCategory = 'Other';
                    let foundPluginsSection = false;

                    for (let line of lines) {
                        line = line.trim();
                        if (line.startsWith('## Plugins') || line.startsWith('## Themes')) {
                            foundPluginsSection = true;
                        }
                        if (!foundPluginsSection) continue;

                        if (line.startsWith('## ') || line.startsWith('### ')) {
                            currentCategory = line.replace(/#/g, '').trim();
                        } else if (line.startsWith('- [')) {
                            const match = line.match(/- \[(.*?)\]\((.*?)\)(?: - (.*))?/);
                            if (match && match[2].startsWith('https://')) {
                                // Security: only accept HTTPS GitHub URLs in discover list
                                const itemUrl = match[2];
                                const catLower = currentCategory.toLowerCase();
                                let type = 'app';
                                if (catLower.includes('collection')) type = 'collection';
                                else if (catLower.includes('theme')) type = 'theme';

                                // For non-theme items, require valid GitHub URL
                                if (type !== 'theme' && !this._isValidGithubUrl(itemUrl)) continue;

                                items.push({
                                    name: match[1],
                                    url: itemUrl,
                                    description: match[3] || '',
                                    category: currentCategory,
                                    type: type,
                                    sourceRepo: repoUrl
                                });
                            }
                        }
                    }
                } catch (e) {
                    console.error("Error fetching discover repo", repoUrl, e);
                }
            }

            // Store items for filtering
            this._discoverItems = items;

            if (items.length === 0) {
                listContainer.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No plugins found in the configured community repositories.</p></div></div>';
                return;
            }

            await this._renderDiscoverCards(container, items);

        } catch (err) {
            console.error(err);
            listContainer.innerHTML = "Error loading community plugins.";
        }
    }

    async _filterDiscoverList(container) {
        if (!this._discoverItems) return;

        const searchInput = container.querySelector('#pm-discover-search');
        const activeChip = container.querySelector('.pm-filter-chip.active');
        const searchTerm = (searchInput ? searchInput.value : '').toLowerCase().trim();
        const filterType = activeChip ? activeChip.dataset.filter : 'all';

        let filtered = this._discoverItems;

        // Apply category filter
        if (filterType !== 'all') {
            filtered = filtered.filter(item => item.type === filterType);
        }

        // Apply search filter
        if (searchTerm) {
            filtered = filtered.filter(item => {
                return item.name.toLowerCase().includes(searchTerm) ||
                    item.description.toLowerCase().includes(searchTerm) ||
                    item.category.toLowerCase().includes(searchTerm);
            });
        }

        await this._renderDiscoverCards(container, filtered);
    }

    async _renderDiscoverCards(container, items) {
        const listContainer = container.querySelector('#pm-discover-list');
        listContainer.innerHTML = '';

        // Build a set of installed plugin source URLs and names for quick lookup
        const installedSet = new Set();
        try {
            const allGlobals = await this.data.getAllGlobalPlugins();
            const allCollections = await this.data.getAllCollections();
            [...allGlobals, ...allCollections].forEach(p => {
                try {
                    const conf = p.getExistingCodeAndConfig().json;
                    if (conf.__source_repo) installedSet.add(conf.__source_repo);
                    if (conf.name) installedSet.add(conf.name.toLowerCase());
                } catch (e) { /* skip */ }
            });
        } catch (e) { /* couldn't read installed plugins, proceed without */ }

        if (items.length === 0) {
            listContainer.innerHTML = '<div class="pm-card pm-empty-state"><div class="pm-card-info"><p>No matching plugins or themes found.</p></div></div>';
            return;
        }

        items.forEach(item => {
            const isCollection = item.type === 'collection';
            const isTheme = item.type === 'theme';
            const badgeText = isTheme ? 'Theme' : (isCollection ? 'Collection' : 'Plugin');
            const badgeClass = isTheme ? 'pm-badge-theme' : (isCollection ? 'pm-badge-collection' : 'pm-badge-plugin');

            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>
                        ${this._escHtml(item.name)} 
                        <span class="pm-badge ${badgeClass}">${badgeText}</span>
                    </h3>
                    <p>${this._escHtml(item.description)}</p>
                    <p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(item.url)}">${this._escHtml(item.url)}</span></p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actionsContainer = card.querySelector('.pm-card-actions');

            const previewBtn = document.createElement('button');
            previewBtn.className = 'pm-btn';
            previewBtn.innerText = 'Preview';
            previewBtn.style.marginRight = '5px';

            previewBtn.addEventListener('click', () => {
                this.previewTheme(item.url);
            });

            if (isTheme) {
                actionsContainer.appendChild(previewBtn);
            }

            // Check if plugin is on the incompatible list
            const isIncompatible = !!this._incompatiblePlugins[item.url];
            const isInstalled = !isTheme && (installedSet.has(item.url) || installedSet.has(item.name.toLowerCase()));

            const installBtn = document.createElement('button');
            if (isIncompatible) {
                installBtn.className = 'pm-btn';
                installBtn.innerText = 'Incompatible';
                installBtn.disabled = true;
                installBtn.style.opacity = '0.5';
            } else if (isTheme) {
                const isSavedTheme = this._savedThemes.some(t => t.source === item.url || t.name === item.name);
                installBtn.className = isSavedTheme ? 'pm-btn' : 'pm-btn primary';
                installBtn.innerText = isSavedTheme ? 'Re-Save Theme' : 'Save Theme';
            } else if (isInstalled) {
                installBtn.className = 'pm-btn';
                installBtn.innerText = 'Reinstall';
            } else {
                installBtn.className = 'pm-btn primary';
                installBtn.innerText = 'Install';
            }

            // If incompatible, add a Recheck button first
            if (isIncompatible) {
                const recheckBtn = document.createElement('button');
                recheckBtn.className = 'pm-btn';
                recheckBtn.innerText = 'Recheck';
                recheckBtn.style.marginRight = '5px';
                recheckBtn.addEventListener('click', async () => {
                    recheckBtn.innerText = 'Checking...';
                    recheckBtn.disabled = true;
                    try {
                        if (isTheme) {
                            await this._fetchThemeCSS(item.url);
                        } else {
                            await this.fetchGithubRepo(item.url);
                        }
                        // Success — remove from incompatible list
                        delete this._incompatiblePlugins[item.url];
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Compatible!", message: `${item.name} is now available to install.`, autoDestroyTime: 3000, dismissible: true });
                        this._renderDiscoverCards(container, items);
                    } catch (e) {
                        this.ui.addToaster({ title: "Still Incompatible", message: e.message, autoDestroyTime: 4000, dismissible: true });
                        recheckBtn.innerText = 'Recheck';
                        recheckBtn.disabled = false;
                    }
                });
                actionsContainer.appendChild(recheckBtn);
            }

            actionsContainer.appendChild(installBtn);

            if (!isIncompatible) {
                installBtn.addEventListener('click', async () => {
                    const originalText = installBtn.innerText;
                    installBtn.innerText = isTheme ? 'Fetching...' : 'Installing...';
                    installBtn.disabled = true;

                    try {
                        if (isTheme) {
                            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(item.url));
                            const existingIdx = this._savedThemes.findIndex(t => t.source === item.url || t.name === item.name);

                            if (existingIdx > -1) {
                                this._savedThemes[existingIdx].css = cssText;
                                this._savedThemes[existingIdx].date = new Date().toISOString();
                            } else {
                                this._savedThemes.push({
                                    id: Date.now().toString(36),
                                    name: item.name,
                                    css: cssText,
                                    source: item.url,
                                    date: new Date().toISOString()
                                });
                            }
                            this._saveThemes();
                            this._autoExport();
                            this.ui.addToaster({ title: "Theme Saved!", message: `Saved "${item.name}" to your Theme Library.`, autoDestroyTime: 4000, dismissible: true });

                            installBtn.className = 'pm-btn';
                            installBtn.innerText = 'Saved';
                        } else {
                            const { json, js, css } = await this.fetchGithubRepo(item.url);
                            await this.installPlugin(json, js, { interactive: false, cssCode: css });
                            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
                            installBtn.innerText = 'Installed';
                            this.loadPlugins(container);
                        }
                    } catch (err) {
                        // Add to incompatible list
                        this._incompatiblePlugins[item.url] = { name: item.name, error: err.message, date: new Date().toISOString() };
                        localStorage.setItem('pm_incompatible', JSON.stringify(this._incompatiblePlugins));
                        this.ui.addToaster({ title: "Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
                        // Re-render respecting current filter/search state
                        this._filterDiscoverList(container);
                    }
                });
            }

            listContainer.appendChild(card);
        });
    }

    async loadPlugins(container) {
        try {
            const globals = await this.data.getAllGlobalPlugins();
            const collections = await this.data.getAllCollections();

            this.renderPluginList(container, 'pm-global-list', globals, 'app');
            this.renderPluginList(container, 'pm-collections-list', collections, 'collection');
        } catch (err) {
            console.error(err);
            container.querySelector('#pm-global-list').innerHTML = "Error loading plugins.";
            container.querySelector('#pm-collections-list').innerHTML = "Error loading collections.";
        }
    }

    _saveDisabledPlugins() {
        localStorage.setItem('pm_disabled_plugins', JSON.stringify(this._disabledPlugins || {}));
    }

    _getDisabledPluginsForType(typeFilter) {
        const allDisabled = Object.values(this._disabledPlugins || {});
        return allDisabled.filter(item => {
            if (!item || !item.sourceRepo) return false;
            const type = (item.type || '').toLowerCase();
            const normalized = (type === 'global' || type === 'app') ? 'app' : (type === 'collection' ? 'collection' : 'app');
            return normalized === typeFilter;
        });
    }

    async _disablePlugin(pluginObj, conf, panelContainer) {
        const sourceRepo = conf.__source_repo;
        if (!sourceRepo) {
            this.ui.addToaster({
                title: 'Cannot Disable',
                message: 'Only plugins linked to a GitHub source can be disabled and re-enabled.',
                autoDestroyTime: 5000,
                dismissible: true
            });
            return;
        }

        const pluginName = conf.name || 'this plugin';
        if (!confirm(`Disable ${pluginName}?\n\nThis removes it from the official Plugins panel. You can re-enable it later from Plugins Manager.`)) {
            return;
        }

        const rawType = (conf.type || '').toLowerCase();
        const normalizedType = (rawType === 'collection') ? 'collection' : 'app';

        this._disabledPlugins[sourceRepo] = {
            name: conf.name || 'Unnamed Plugin',
            type: normalizedType,
            sourceRepo,
            sourceFiles: conf.__source_files || null,
            version: conf.version || conf.ver || '',
            dateDisabled: new Date().toISOString()
        };
        this._saveDisabledPlugins();

        await pluginObj.trashPlugin();
        this._autoExport();
        this.ui.addToaster({ title: 'Plugin disabled', message: `${pluginName} can be re-enabled anytime.`, dismissible: true, autoDestroyTime: 3500 });
        this.loadPlugins(panelContainer);
    }

    async _enableDisabledPlugin(disabledPlugin, panelContainer, enableBtn) {
        const sourceRepo = disabledPlugin.sourceRepo;
        try {
            enableBtn.innerHTML = '';
            enableBtn.appendChild(this.ui.createIcon('loader'));
            enableBtn.disabled = true;

            const { json, js, css } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: disabledPlugin.sourceFiles });
            await this.installPlugin(json, js, { interactive: false, cssCode: css });

            delete this._disabledPlugins[sourceRepo];
            this._saveDisabledPlugins();

            this.ui.addToaster({ title: 'Plugin enabled', message: `${json.name || disabledPlugin.name} reinstalled.`, dismissible: true, autoDestroyTime: 3500 });
            this.loadPlugins(panelContainer);
        } catch (e) {
            enableBtn.innerHTML = '';
            enableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            enableBtn.disabled = false;
            this.ui.addToaster({ title: 'Enable Failed', message: e.message, dismissible: true, autoDestroyTime: 5000 });
        }
    }

    _renderDisabledPluginCards(panelContainer, container, typeFilter) {
        const disabledPlugins = this._getDisabledPluginsForType(typeFilter);
        if (disabledPlugins.length === 0) return;

        disabledPlugins.forEach(disabled => {
            const disabledDate = disabled.dateDisabled ? new Date(disabled.dateDisabled).toLocaleDateString() : 'Unknown date';
            const card = document.createElement('div');
            card.className = 'pm-card pm-card-disabled';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>
                        ${this._escHtml(disabled.name || 'Unnamed Plugin')} 
                        <span class="pm-badge">Disabled</span>
                    </h3>
                    <p>Disabled on ${this._escHtml(disabledDate)}. Re-enable to reinstall in the official Plugins panel.</p>
                    ${disabled.sourceRepo ? `<p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(disabled.sourceRepo)}">${this._escHtml(disabled.sourceRepo)}</span></p>` : ''}
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actionsContainer = card.querySelector('.pm-card-actions');
            const enableBtn = document.createElement('button');
            enableBtn.className = 'pm-btn pm-btn-enable';
            enableBtn.title = 'Disabled plugin — click to enable (reinstall)';
            enableBtn.setAttribute('aria-label', 'Disabled plugin. Click to enable and reinstall');
            enableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            actionsContainer.appendChild(enableBtn);

            enableBtn.addEventListener('click', () => this._enableDisabledPlugin(disabled, panelContainer, enableBtn));
            container.appendChild(card);
        });
    }

    renderPluginList(panelContainer, containerId, plugins, typeFilter) {
        const container = panelContainer.querySelector(`#${containerId}`);
        container.innerHTML = '';

        if (plugins.length === 0 && this._getDisabledPluginsForType(typeFilter).length === 0) {
            container.innerHTML = '<div class="pm-card"><div class="pm-card-info"><p>No items found.</p></div></div>';
            return;
        }

        // Toggle Update All button visibility if there are known updates for this tab
        try {
            const availableUpdates = this._readUpdateCache();
            let hasUpdatesForTab = false;
            for (const p of plugins) {
                if (availableUpdates[p.getGuid()]) {
                    hasUpdatesForTab = true;
                    break;
                }
            }

            const btnId = typeFilter === 'app' ? '#pm-update-all-global-btn' : '#pm-update-all-col-btn';
            const updateAllBtn = panelContainer.querySelector(btnId);
            if (updateAllBtn) {
                updateAllBtn.style.display = hasUpdatesForTab ? 'inline-block' : 'none';
            }
        } catch (e) { }

        plugins.forEach(p => {
            let conf;
            try {
                // For global plugins, getExistingCodeAndConfig works. CollectionPlugin might need getConfiguration()
                // The SDK types suggest getExistingCodeAndConfig is on PluginPluginAPIBase which both extend.
                const codeAndConfig = p.getExistingCodeAndConfig();
                conf = codeAndConfig.json;
            } catch (e) {
                // Fallback
                conf = { name: "Unknown", version: "Unknown" };
            }

            const sourceRepo = conf.__source_repo || '';
            const isLocal = !sourceRepo;

            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3 id="pm-title-${p.getGuid()}">
                        ${this._escHtml(conf.name || 'Unnamed Plugin')} 
                        <span class="pm-badge" id="pm-badge-type-${p.getGuid()}"></span>
                        <span class="pm-badge pm-version-badge" id="vbadge-${p.getGuid()}">v${this._escHtml(conf.version || conf.ver || '0.0.0')}</span>
                    </h3>
                    <p>${this._escHtml(conf.description || 'No description')}</p>
                    ${sourceRepo ? `<p class="pm-card-url-row"><span class="pm-card-url" data-external-url="${this._escHtml(sourceRepo)}">${this._escHtml(sourceRepo)}</span></p>` : ''}
                </div>
                <div class="pm-card-actions"></div>
            `;

            // Add native Type Badges
            const typeBadge = card.querySelector(`#pm-badge-type-${p.getGuid()}`);
            if (isLocal) {
                typeBadge.appendChild(this.ui.createIcon('box'));
                typeBadge.appendChild(document.createTextNode(' Local'));
            } else {
                typeBadge.appendChild(this.ui.createIcon('cloud'));
                typeBadge.appendChild(document.createTextNode(' GitHub'));
            }

            const actionsContainer = card.querySelector('.pm-card-actions');

            // Check if updates are available in cache
            const updates = this._readUpdateCache();
            const updateInfo = updates[p.getGuid()];
            const remoteVersion = updateInfo ? updateInfo.version : null;
            const installedVersion = conf.version || conf.ver;

            if (remoteVersion && remoteVersion !== installedVersion) {
                card.classList.add('pm-card-upgradeable');
                const badge = card.querySelector(`#vbadge-${p.getGuid()}`);
                if (badge) {
                    badge.innerText = `Update Available (v${remoteVersion})`;
                    badge.classList.add('update');
                }
            }

            // Add Native Update Button
            let updateBtn = null;
            if (sourceRepo) {
                // Known update version (string) if background checker flagged one
                const knownUpdate = (remoteVersion && remoteVersion !== installedVersion) ? remoteVersion : null;

                updateBtn = document.createElement('button');
                updateBtn.className = knownUpdate ? 'pm-btn pm-btn-update update-btn' : 'pm-btn pm-btn-update';

                if (knownUpdate) {
                    updateBtn.title = `Update to v${knownUpdate}`;
                    updateBtn.appendChild(this.ui.createIcon('arrow-up'));
                    updateBtn.classList.add('update-btn');
                } else {
                    updateBtn.title = 'Check Update';
                    updateBtn.appendChild(this.ui.createIcon('refresh'));
                }
                actionsContainer.appendChild(updateBtn);

                const pendingVersion = knownUpdate;
                updateBtn.addEventListener('click', () => this.checkAndUpdatePlugin(p, conf, sourceRepo, updateBtn, panelContainer, pendingVersion));

                // Reinstall button — force re-download from source without version check
                const reinstallBtn = document.createElement('button');
                reinstallBtn.className = 'pm-btn pm-btn-reinstall';
                reinstallBtn.title = 'Reinstall from source (force overwrite)';
                reinstallBtn.appendChild(this.ui.createIcon('download'));
                actionsContainer.appendChild(reinstallBtn);

                reinstallBtn.addEventListener('click', async () => {
                    if (!confirm(`Reinstall ${conf.name} from source?\n\nThis will overwrite local code with the latest from GitHub, even if the version number hasn't changed.`)) return;
                    try {
                        reinstallBtn.innerHTML = '';
                        reinstallBtn.appendChild(this.ui.createIcon('loader'));
                        reinstallBtn.disabled = true;

                        const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: conf.__source_files });
                        this._validatePluginJS(remoteJson.name, remoteJs);
                        const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                        if (conf.custom !== undefined) {
                            sanitizedConf.custom = this._cloneJsonValue(conf.custom);
                        }

                        const isSelfUpdate = p.getGuid() === this.getGuid();

                        if (remoteCss) {
                            const sanitizedCSS = this._sanitizeCSS(remoteCss);
                            await p.saveCSS(sanitizedCSS);
                        }

                        if (isSelfUpdate) {
                            const panel = this.ui.getActivePanel();
                            if (panel) this.ui.closePanel(panel);
                            localStorage.setItem('pm_self_update_pending', 'true');
                        } else {
                            this._autoExport(); // fire-and-forget
                            this.ui.addToaster({ title: 'Reinstalled', message: `${conf.name} has been reinstalled from source.`, autoDestroyTime: 3000, dismissible: true });
                        }

                        await p.savePlugin(sanitizedConf, remoteJs);

                        if (!isSelfUpdate) {
                            this.loadPlugins(panelContainer);
                        }
                    } catch (e) {
                        this.ui.addToaster({ title: 'Reinstall Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                        reinstallBtn.innerHTML = '';
                        reinstallBtn.appendChild(this.ui.createIcon('download-cloud'));
                        reinstallBtn.disabled = false;
                    }
                });
            }

            // Always offer to link or edit a GitHub repo for updates
            const linkBtn = document.createElement('button');
            linkBtn.className = 'pm-btn';
            linkBtn.title = sourceRepo ? 'Edit GitHub repo link' : 'Link to a GitHub repo for updates';
            linkBtn.appendChild(this.ui.createIcon('link'));
            actionsContainer.appendChild(linkBtn);

            linkBtn.addEventListener('click', async () => {
                const repoUrl = await this._showPromptModal('Link GitHub Repository', 'Enter the GitHub repo URL for this plugin:', sourceRepo || '');
                if (repoUrl === null) return; // cancelled
                if (repoUrl === '') {
                    // Remove link
                    if (!confirm('Clear the repository link? This will disable updates.')) return;
                } else if (!this._isValidGithubUrl(repoUrl)) {
                    this.ui.addToaster({ title: 'Invalid URL', message: 'Please enter a valid github.com URL.', autoDestroyTime: 4000, dismissible: true });
                    return;
                }

                try {
                    const { json: currentJson, code: currentCode } = p.getExistingCodeAndConfig();
                    currentJson.__source_repo = repoUrl;
                    await p.savePlugin(currentJson, currentCode);
                    this.ui.addToaster({ title: 'Repo Updated', message: repoUrl ? `${conf.name} linked to ${repoUrl}.` : `${conf.name} link removed.`, autoDestroyTime: 4000, dismissible: true });
                    this.loadPlugins(panelContainer);
                } catch (e) {
                    this.ui.addToaster({ title: 'Update Failed', message: e.message, autoDestroyTime: 5000, dismissible: true });
                }
            });

            // Add Native Delete Button
            const deleteBtn = document.createElement('button');
            deleteBtn.className = 'pm-btn danger pm-btn-delete';
            deleteBtn.title = 'Delete Plugin';
            deleteBtn.appendChild(this.ui.createIcon('trash')); // trash usually exists in Thymer/Lucide
            actionsContainer.appendChild(deleteBtn);

            deleteBtn.addEventListener('click', async () => {
                if (confirm(`Are you sure you want to delete ${conf.name}?`)) {
                    await p.trashPlugin();
                    this._autoExport(); // fire-and-forget
                    this.ui.addToaster({ title: "Plugin deleted", dismissible: true, autoDestroyTime: 3000 });
                    this.loadPlugins(panelContainer);
                }
            });

            // Add Disable button (GitHub-linked plugins only)
            const disableBtn = document.createElement('button');
            disableBtn.className = 'pm-btn pm-btn-disable';
            disableBtn.title = sourceRepo ? 'Enabled plugin — click to disable (remove from Plugins panel)' : 'Link this plugin to GitHub first to enable disable/re-enable';
            disableBtn.setAttribute('aria-label', sourceRepo ? 'Enabled plugin. Click to disable and remove from Plugins panel' : 'Disable unavailable until this plugin is linked to GitHub');
            disableBtn.innerHTML = '<span class="pm-state-icon" aria-hidden="true">●</span>';
            disableBtn.disabled = !sourceRepo;
            actionsContainer.appendChild(disableBtn);

            disableBtn.addEventListener('click', async () => {
                if (!sourceRepo) return;
                await this._disablePlugin(p, conf, panelContainer);
            });

            container.appendChild(card);
        });

        this._renderDisabledPluginCards(panelContainer, container, typeFilter);
    }


    // --- Theme Library ---

    async _saveThemes() {
        await this._saveManagerSettings({ savedThemes: this._savedThemes });
    }

    _renderThemesList(container) {
        const list = container.querySelector('#pm-themes-list');
        if (!list) return;

        if (this._savedThemes.length === 0) {
            list.innerHTML = `
                <div class="pm-card pm-empty-state">
                    <div class="pm-card-info">
                        <p>No themes saved yet. Use <strong>Add from GitHub</strong> to fetch a theme CSS from a repository, or <strong>Paste CSS</strong> to save your own theme.</p>
                        <p class="pm-meta-text">Once saved, use <strong>Backup Theme CSS</strong> to copy the combined CSS into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    </div>
                </div>`;
            return;
        }

        list.innerHTML = '';
        this._savedThemes.forEach((theme, idx) => {
            const card = document.createElement('div');
            card.className = 'pm-card';
            card.innerHTML = `
                <div class="pm-card-info">
                    <h3>${this._escHtml(theme.name)}
                        <span class="pm-badge pm-version-badge">${theme.source ? 'GitHub' : 'Manual'}</span>
                    </h3>
                    <p class="pm-meta-text">
                        ${theme.css.length} chars · Added ${new Date(theme.date).toLocaleDateString()}
                        ${theme.source ? ` · <span class="pm-card-url" data-external-url="${this._escHtml(theme.source)}">${this._escHtml(theme.source)}</span>` : ''}
                    </p>
                </div>
                <div class="pm-card-actions"></div>
            `;

            const actions = card.querySelector('.pm-card-actions');

            // Copy CSS button
            const copyBtn = document.createElement('button');
            copyBtn.className = 'pm-btn';
            copyBtn.title = 'Copy this theme CSS to clipboard';
            copyBtn.appendChild(this.ui.createIcon('copy'));
            actions.appendChild(copyBtn);
            copyBtn.addEventListener('click', async () => {
                await navigator.clipboard.writeText(theme.css);
                this.ui.addToaster({ title: 'Copied!', message: `${theme.name} CSS copied to clipboard.`, autoDestroyTime: 3000, dismissible: true });
            });

            // Edit button
            const editBtn = document.createElement('button');
            editBtn.className = 'pm-btn';
            editBtn.title = 'Edit theme';
            editBtn.appendChild(this.ui.createIcon('edit'));
            actions.appendChild(editBtn);
            editBtn.addEventListener('click', () => {
                this._showEditThemeDialog(container, idx);
            });

            // Delete button
            const delBtn = document.createElement('button');
            delBtn.className = 'pm-btn danger pm-btn-delete';
            delBtn.title = 'Remove theme';
            delBtn.appendChild(this.ui.createIcon('x'));
            actions.appendChild(delBtn);
            delBtn.addEventListener('click', () => {
                if (confirm(`Remove theme "${theme.name}"?`)) {
                    this._savedThemes.splice(idx, 1);
                    this._saveThemes();
                    this._autoExport();
                    this._renderThemesList(container);
                    this._renderWorkspaceSummary(container);
                }
            });

            list.appendChild(card);
        });
    }

    async _addThemeFromGithub(container) {
        const url = await this._showPromptModal('Add Theme from GitHub', 'Enter the GitHub repo URL for the theme:');
        if (!url) return;

        this.ui.addToaster({ title: 'Fetching theme CSS...', autoDestroyTime: 2000, dismissible: true });

        try {
            const cssText = this._sanitizeCSS(await this._fetchThemeCSS(url));
            const { owner, repo } = this._parseGithubUrl(url);
            const name = await this._showPromptModal('Name This Theme', 'Enter a name for this theme:', repo || 'My Theme');
            if (!name) return;

            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css: cssText,
                source: url,
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your Theme Library.`, autoDestroyTime: 3000, dismissible: true });
        } catch (fetchErr) {
            // CSS not auto-detected → fall back to manual paste modal
            this._showManualThemePasteDialog(container, url, fetchErr.message);
        }
    }

    _addThemeManually(container) {
        this._showManualThemePasteDialog(container, null, null);
    }

    _showManualThemePasteDialog(container, sourceUrl, errorMsg) {
        let defaultName = 'My Theme';
        let repoLinkHtml = '';
        if (sourceUrl) {
            try {
                const { repo } = this._parseGithubUrl(sourceUrl);
                if (repo) defaultName = repo;
                repoLinkHtml = `<p class="pm-modal-link-row">
                                    <span class="pm-card-url" data-external-url="${this._escHtml(sourceUrl)}">
                                        Open repository in new tab
                                    </span>
                                </p>`;
            } catch (e) { /* ignore parse error */ }
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Edit Theme</h3>
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-manual-theme-name" class="pm-input" value="${this._escHtml(defaultName)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-manual-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here..."></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-manual-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-manual-theme-save">Save Theme</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        tempDiv.querySelector('#pm-manual-theme-cancel').addEventListener('click', () => this._closeModal(tempDiv));
        tempDiv.querySelector('#pm-manual-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-manual-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-manual-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes.push({
                id: Date.now().toString(36),
                name,
                css,
                source: sourceUrl || '',
                date: new Date().toISOString()
            });
            this._saveThemes();
            this._autoExport();
            this._closeModal(tempDiv);
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Saved', message: `"${name}" added to your Theme Library.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    _showEditThemeDialog(container, idx) {
        const theme = this._savedThemes[idx];
        if (!theme) return;

        const sourceUrl = theme.source || '';
        let repoLinkHtml = '';
        if (sourceUrl) {
            repoLinkHtml = `<p class="pm-modal-link-row">
                                <span class="pm-card-url" data-external-url="${this._escHtml(sourceUrl)}">
                                    Open repository in new tab
                                </span>
                            </p>`;
        }

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Edit Theme</h3>
                    ${repoLinkHtml}
                    <div class="pm-input-group" style="margin-bottom: 10px;">
                        <label>Theme Name</label>
                        <input type="text" id="pm-edit-theme-name" class="pm-input" value="${this._escHtml(theme.name)}" placeholder="My Theme" />
                    </div>
                    <textarea id="pm-edit-theme-css" class="pm-textarea" placeholder="Paste your theme CSS here...">${this._escHtml(theme.css)}</textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-edit-theme-cancel">Cancel</button>
                        <button class="pm-btn primary" id="pm-edit-theme-save">Save Changes</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        tempDiv.querySelector('#pm-edit-theme-cancel').addEventListener('click', () => this._closeModal(tempDiv));
        tempDiv.querySelector('#pm-edit-theme-save').addEventListener('click', () => {
            const name = tempDiv.querySelector('#pm-edit-theme-name').value.trim();
            const css = tempDiv.querySelector('#pm-edit-theme-css').value.trim();
            if (!name || !css) {
                this.ui.addToaster({ title: 'Missing Fields', message: 'Please provide both a name and CSS.', autoDestroyTime: 3000, dismissible: true });
                return;
            }
            this._savedThemes[idx] = {
                ...this._savedThemes[idx],
                name,
                css,
                date: new Date().toISOString()
            };
            this._saveThemes();
            this._autoExport();
            this._closeModal(tempDiv);
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
            this.ui.addToaster({ title: 'Theme Updated', message: `"${name}" has been updated.`, autoDestroyTime: 3000, dismissible: true });
        });
    }

    /** Register a modal overlay so it gets cleaned up in onUnload if still open. */
    _openModal(el) {
        if (!this._activeModals) this._activeModals = [];
        this._activeModals.push(el);
        el.classList.add('pm-container');
        document.body.appendChild(el);
        
        // Close modal when clicking outside its content area (on the background overlay)
        el.addEventListener('click', (e) => {
            // Handle external link clicks inside modals
            const linkEl = e.target.closest('[data-external-url]');
            if (linkEl) {
                e.preventDefault();
                this._openExternalLink(linkEl.dataset.externalUrl);
                return;
            }
            if (e.target.classList.contains('pm-modal')) {
                this._closeModal(el);
            }
        });
        
        return el;
    }

    /** Remove a modal and deregister it from the active list. */
    _closeModal(el) {
        if (el && el.parentNode) el.parentNode.removeChild(el);
        if (this._activeModals) {
            const idx = this._activeModals.indexOf(el);
            if (idx !== -1) this._activeModals.splice(idx, 1);
        }
    }

    /**
     * Custom prompt modal that replaces native prompt() which is blocked in
     * embedded/WebView/Electron environments.
     * @param {string} title - Dialog title
     * @param {string} message - Descriptive text shown above the input
     * @param {string} [defaultValue=''] - Pre-filled value for the input
     * @returns {Promise<string|null>} The user's input, or null if cancelled
     */
    _showPromptModal(title, message, defaultValue = '') {
        return new Promise(resolve => {
            const overlayHtml = `
                <div class="pm-modal">
                    <div class="pm-modal-content">
                        <h3>${this._escHtml(title)}</h3>
                        <p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 10px;">${this._escHtml(message)}</p>
                        <input type="text" id="pm-prompt-input" class="pm-input" value="${this._escHtml(defaultValue)}" placeholder="" autocomplete="off" />
                        <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                            <button class="pm-btn" id="pm-prompt-cancel">Cancel</button>
                            <button class="pm-btn primary" id="pm-prompt-ok">OK</button>
                        </div>
                    </div>
                </div>
            `;

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = overlayHtml;
            this._openModal(tempDiv);

            const input = tempDiv.querySelector('#pm-prompt-input');
            setTimeout(() => { input.focus(); input.select(); }, 50);

            const close = (value) => {
                this._closeModal(tempDiv);
                resolve(value);
            };

            tempDiv.querySelector('#pm-prompt-cancel').addEventListener('click', () => close(null));
            tempDiv.querySelector('#pm-prompt-ok').addEventListener('click', () => close(input.value.trim()));
            input.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') close(input.value.trim());
                if (e.key === 'Escape') close(null);
            });
        });
    }

    /** Open an external URL in a new browser tab/window. */
    _openExternalLink(url) {
        if (url) window.open(url, '_blank', 'noopener,noreferrer');
    }

    async _exportAllThemes() {
        if (this._savedThemes.length === 0) {
            this.ui.addToaster({ title: 'No Themes', message: 'No themes saved to export.', autoDestroyTime: 3000, dismissible: true });
            return;
        }
        const combined = this._savedThemes.map(t => `/* === ${t.name} === */\n${t.css}`).join('\n\n');

        const overlayHtml = `
            <div class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Export All Themes</h3>
                    <p style="font-size: 13px; color: var(--pm-text-muted); margin-bottom: 10px;">Copy this combined CSS and paste it into Thymer's <strong>Edit Theme CSS</strong> setting.</p>
                    <textarea class="pm-textarea pm-textarea-json" id="pm-all-themes-css" readonly></textarea>
                    <div style="margin-top: 15px; display: flex; justify-content: flex-end; gap: 10px;">
                        <button class="pm-btn" id="pm-themes-export-copy">Copy to Clipboard</button>
                        <button class="pm-btn" id="pm-themes-export-download">Download .css</button>
                        <button class="pm-btn primary" id="pm-themes-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);
        tempDiv.querySelector('#pm-all-themes-css').value = combined;

        tempDiv.querySelector('#pm-themes-export-close').addEventListener('click', () => this._closeModal(tempDiv));

        tempDiv.querySelector('#pm-themes-export-copy').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(combined);
            const orig = e.target.innerText;
            e.target.innerText = 'Copied!';
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-themes-export-download').addEventListener('click', () => {
            const blob = new Blob([combined], { type: 'text/css' });
            const blobUrl = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = blobUrl;
            const wsName = this._getWorkspaceName();
            const ts = this._getBackupTimestamp();
            a.download = `thymer-backup-themes-${wsName}-${ts}.css`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(blobUrl);
        });
    }


    async previewTheme(repoUrl) {
        try {
            const { owner, repo } = this._parseGithubUrl(repoUrl);
            if (!owner || !repo) return;

            // Fetch README directly from raw.githubusercontent.com to avoid CORS
            let content = '';
            for (const branch of ['main', 'master']) {
                try {
                    const readmeRes = await fetch(`https://raw.githubusercontent.com/${owner}/${repo}/${branch}/README.md`);
                    if (readmeRes.ok) {
                        content = await readmeRes.text();
                        break;
                    }
                } catch (e) { /* try next branch */ }
            }

            if (!content) throw new Error("No README found");

            // Extract images from markdown
            const imgRegex = /!\[.*?\]\((.*?)\)|<img.*?src="(.*?)".*?>/g;
            const images = [];
            let imgMatch;
            while ((imgMatch = imgRegex.exec(content)) !== null) {
                const src = imgMatch[1] || imgMatch[2];
                if (src && src.startsWith('http')) {
                    images.push(src);
                }
            }

            if (images.length === 0) {
                this.ui.addToaster({ title: "No Previews", message: "No images found in the theme's README.", autoDestroyTime: 3000, dismissible: true });
                return;
            }

            const overlayHtml = `
                <div id="pm-theme-preview-modal" class="pm-modal">
                    <div class="pm-modal-content" style="width: 800px; max-height: 90vh; overflow-y: auto;">
                        <h3>Theme Preview</h3>
                        <div style="display: flex; flex-direction: column; gap: 15px; margin-top: 15px;">
                            ${images.filter(img => img.startsWith('https://')).map(img => `<img src="${this._escHtml(img)}" style="max-width: 100%; border-radius: 4px; border: 1px solid var(--pm-border-default);" />`).join('')}
                        </div>
                        <div style="margin-top: 20px; display: flex; justify-content: flex-end;">
                            <button class="pm-btn primary" id="pm-close-preview">Close</button>
                        </div>
                    </div>
                </div>
            `;

            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = overlayHtml;
            this._openModal(tempDiv);

            document.getElementById('pm-close-preview').addEventListener('click', () => {
                this._closeModal(tempDiv);
            });

        } catch (e) {
            this.ui.addToaster({ title: "Preview Failed", message: "Could not load theme preview images.", autoDestroyTime: 3000, dismissible: true });
        }
    }

    /**
     * Fetch theme CSS using smart file discovery.
     */
    async _fetchThemeCSS(repoUrl) {
        const { owner, repo, subpath } = this._parseGithubUrl(repoUrl);
        if (!owner || !repo) throw new Error("Invalid GitHub URL.");

        const prefix = subpath ? `${subpath}/` : '';
        const cssFilenames = ['plugin.css', 'styles.css', 'theme.css', 'style.css', `${repo}-plugin.css`, 'Custom CSS'];

        // Strategy 1: Try common CSS filenames via raw.githubusercontent.com
        for (const branch of ['main', 'master']) {
            for (const filename of cssFilenames) {
                const url = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${prefix}${filename}`;
                try {
                    const res = await fetch(url);
                    if (res.ok) return await res.text();
                } catch (e) { /* try next */ }
            }
        }

        // Strategy 2: Use GitHub API to list directory and find CSS-like files
        try {
            const files = await this._listRepoDirectory(owner, repo, subpath);
            // First try the smart role-based finder (includes extensionless name matching)
            const cssFile = this._findFileByRole(files, 'css');
            if (cssFile) {
                const res = await fetch(cssFile.download_url);
                if (res.ok) return await res.text();
            }
            // Fallback: if there's exactly one .css file in the repo, use it regardless of name
            const allCssFiles = files.filter(f => f.name && f.name.endsWith('.css'));
            if (allCssFiles.length === 1 && allCssFiles[0].download_url) {
                const res = await fetch(allCssFiles[0].download_url);
                if (res.ok) return await res.text();
            }

            // Strategy 3: Content-sniff extensionless files with "css" in the name
            // (reuses the same directory listing to avoid a second API call)
            const candidates = files.filter(f =>
                f.type === 'file' && !f.name.includes('.') && f.name.toLowerCase().includes('css')
            );
            for (const candidate of candidates) {
                if (!candidate.download_url) continue;
                const res = await fetch(candidate.download_url);
                if (!res.ok) continue;
                const text = await res.text();
                if (this._looksLikeCSS(text)) return text;
            }
        } catch (e) { /* fall through */ }

        throw new Error("No CSS file found in this repository. You can paste the CSS manually instead.");
    }

    // --- Auto-Export ---

    _getBackupConfigSnapshot(baseJson, liveConfig) {
        const baseSnapshot = this._cloneJsonValue(baseJson || {});
        if (!liveConfig || typeof liveConfig !== 'object') return baseSnapshot;

        const liveSnapshot = this._cloneJsonValue(liveConfig);
        const reservedKeys = ['name', 'type', 'description', 'version', 'icon', 'permissions', '__source_repo', '__source_files', 'ver'];
        for (const key of reservedKeys) {
            if (baseSnapshot[key] !== undefined && liveSnapshot[key] === undefined) {
                liveSnapshot[key] = baseSnapshot[key];
            }
        }

        if (baseSnapshot.__source_repo !== undefined) liveSnapshot.__source_repo = baseSnapshot.__source_repo;
        if (baseSnapshot.__source_files !== undefined) liveSnapshot.__source_files = baseSnapshot.__source_files;
        return liveSnapshot;
    }

    /** Get a reusable export data array for all plugins + collections */
    async _getExportData() {
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const globalsData = allGlobals.map(p => {
            try {
                const { json, code, css } = p.getExistingCodeAndConfig();
                const liveConfig = typeof p.getConfiguration === 'function' ? p.getConfiguration() : null;
                const mergedJson = this._getBackupConfigSnapshot(json, liveConfig);
                return { name: mergedJson.name, type: 'plugin', version: mergedJson.version, source_repo: mergedJson.__source_repo, code, css, json: mergedJson };
            } catch (e) { return null; }
        });

        // Build a guid->name map for all collections (for filter_colguid annotation)
        const colGuidToName = {};
        for (const p of allCollections) {
            try {
                const lc = p.getConfiguration();
                const guid = p.getGuid ? p.getGuid() : null;
                if (guid && lc && lc.name) colGuidToName[guid] = lc.name;
            } catch (e) { }
        }

        const collectionsData = allCollections.map(p => {
            try {
                const { json, code, css } = p.getExistingCodeAndConfig();

                // Use the live configuration so runtime edits and newer schema keys are preserved in backups.
                let mergedJson = this._getBackupConfigSnapshot(json, null);
                try {
                    const liveConfig = p.getConfiguration();
                    if (liveConfig) {
                        mergedJson = this._getBackupConfigSnapshot(json, liveConfig);
                    }
                } catch (configErr) {
                    console.warn(`[Plugins Manager] Failed to get live config for collection ${json.name}:`, configErr);
                }

                // Annotate link-to-record fields with the target collection name
                // so the GUID can be remapped when importing into a different workspace
                if (Array.isArray(mergedJson.fields)) {
                    mergedJson.fields = mergedJson.fields.map(f => {
                        if (f.filter_colguid && colGuidToName[f.filter_colguid]) {
                            return { ...f, filter_colname: colGuidToName[f.filter_colguid] };
                        }
                        return f;
                    });
                }

                return { name: mergedJson.name, type: 'collection', version: mergedJson.version, source_repo: mergedJson.__source_repo, code, css, json: mergedJson };
            } catch (e) { return null; }
        });

        const sorted = this._topoSortCollections(collectionsData.filter(Boolean), colGuidToName);
        return [...globalsData, ...sorted];
    }

    _getManagerExportData() {
        return {
            communityRepos: this.communityRepos || '',
            savedThemes: this._cloneJsonValue(Array.isArray(this._savedThemes) ? this._savedThemes : []),
            autoExportEnabled: !!this._autoExportEnabled,
            autoExportDirName: this._autoExportDirName || ''
        };
    }

    _buildExportPayload(typeFilter, items) {
        const payload = {
            schemaVersion: 2,
            exportedAt: new Date().toISOString(),
            section: typeFilter,
            items
        };
        if (typeFilter === 'app' || typeFilter === 'all') {
            payload.managerSettings = this._getManagerExportData();
        }
        return payload;
    }

    _normalizeImportedBackup(parsed, typeFilter) {
        if (Array.isArray(parsed)) {
            return { items: parsed, managerSettings: null };
        }
        if (!parsed || typeof parsed !== 'object') {
            throw new Error('Invalid backup format');
        }
        const items = Array.isArray(parsed.items)
            ? parsed.items
            : (Array.isArray(parsed.plugins) ? parsed.plugins : null);
        if (!items) {
            throw new Error('Backup does not contain any items');
        }
        return {
            items,
            managerSettings: (typeFilter === 'app' || typeFilter === 'all') ? (parsed.managerSettings || null) : null
        };
    }

    async _restoreImportedManagerSettings(managerSettings, container) {
        if (!managerSettings || typeof managerSettings !== 'object') return;
        await this._saveManagerSettings({
            communityRepos: typeof managerSettings.communityRepos === 'string' ? managerSettings.communityRepos : undefined,
            savedThemes: Array.isArray(managerSettings.savedThemes) ? managerSettings.savedThemes : undefined,
            autoExportEnabled: typeof managerSettings.autoExportEnabled === 'boolean' ? managerSettings.autoExportEnabled : undefined
        });

        if (typeof managerSettings.autoExportDirName === 'string') {
            this._autoExportDirName = managerSettings.autoExportDirName;
            localStorage.setItem('pm_auto_export_dir_name', managerSettings.autoExportDirName);
        }

        if (container) {
            const reposInput = container.querySelector('#pm-repos-input');
            if (reposInput) reposInput.value = this.communityRepos;
            const autoExportToggle = container.querySelector('#pm-auto-export-toggle');
            if (autoExportToggle) autoExportToggle.checked = this._autoExportEnabled;
            const autoExportDirLabel = container.querySelector('#pm-auto-export-dir-label');
            if (autoExportDirLabel) autoExportDirLabel.textContent = this._autoExportDirName ? '📁 ' + this._autoExportDirName : 'No directory selected';
            this._renderThemesList(container);
            this._renderWorkspaceSummary(container);
        }
    }

    /**
     * Topologically sort collection export items so that collections depended upon
     * (via link-to-record filter_colguid) appear before the collections that reference them.
     * Falls back to original order for any cycles or unresolvable references.
     */
    _topoSortCollections(items, colGuidToName) {
        // Build name->item index
        const byName = {};
        for (const item of items) {
            if (item && item.name) byName[item.name] = item;
        }

        // Build adjacency: for each collection, which collection names does it depend on?
        const deps = {};
        for (const item of items) {
            deps[item.name] = new Set();
            const fields = item.json && item.json.fields;
            if (Array.isArray(fields)) {
                for (const f of fields) {
                    const depName = f.filter_colname || (f.filter_colguid && colGuidToName[f.filter_colguid]);
                    if (depName && depName !== item.name && byName[depName]) {
                        deps[item.name].add(depName);
                    }
                }
            }
        }

        // Kahn's algorithm (BFS topological sort)
        const inDegree = {};
        const dependents = {}; // dep -> [items that depend on it]
        for (const item of items) {
            inDegree[item.name] = inDegree[item.name] || 0;
            dependents[item.name] = dependents[item.name] || [];
        }
        for (const item of items) {
            for (const dep of deps[item.name]) {
                inDegree[item.name] = (inDegree[item.name] || 0) + 1;
                dependents[dep] = dependents[dep] || [];
                dependents[dep].push(item.name);
            }
        }

        const queue = items.filter(item => (inDegree[item.name] || 0) === 0).map(i => i.name);
        const result = [];
        const visited = new Set();

        while (queue.length > 0) {
            const name = queue.shift();
            if (visited.has(name)) continue;
            visited.add(name);
            if (byName[name]) result.push(byName[name]);
            for (const dependent of (dependents[name] || [])) {
                inDegree[dependent] = (inDegree[dependent] || 1) - 1;
                if (inDegree[dependent] === 0) queue.push(dependent);
            }
        }

        // Append any remaining items not reached (cycles or isolated)
        for (const item of items) {
            if (!visited.has(item.name)) result.push(item);
        }

        return result;
    }

    _getWorkspaceName() {
        try {
            if (window.location && window.location.hostname) {
                const parts = window.location.hostname.split('.');
                if (parts.length > 0 && parts[0] !== 'localhost' && parts[0] !== '127') {
                    return parts[0];
                }
            }
        } catch (e) { }
        return 'workspace';
    }

    _getBackupTimestamp() {
        const now = new Date();
        const pad = (n) => String(n).padStart(2, '0');
        return `${now.getFullYear()}${pad(now.getMonth() + 1)}${pad(now.getDate())}T${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}`;
    }

    _getBackupJsonFilename(section) {
        const wsName = this._getWorkspaceName();
        const ts = this._getBackupTimestamp();
        if (section === 'all') {
            return `thymer-backup-workspace-${wsName}-${ts}.json`;
        }
        if (section === 'collection') {
            return `thymer-backup-collections-${wsName}-${ts}.json`;
        }
        if (section === 'theme') {
            return `thymer-backup-themes-${wsName}-${ts}.css`;
        }
        return `thymer-backup-plugins-${wsName}-${ts}.json`;
    }

    /** Auto-export full backup using whichever destination mode is active. */
    async _autoExport() {
        if (!this._autoExportEnabled) return;

        // Debounce rapid successive calls (e.g. update-all loop)
        if (this._autoExportTimer) clearTimeout(this._autoExportTimer);
        this._autoExportTimer = setTimeout(() => { this._autoExportTimer = null; this._runAutoExport(); }, 400);
    }

    async _runAutoExport() {
        try {
            const data = await this._getExportData();
            const jsonStr = JSON.stringify(this._buildExportPayload('all', data), null, 2);
            const filename = this._getBackupJsonFilename('all');
            const mode = this._autoExportMode || (this._autoExportDirHandle ? 'fsaccess' : '');

            if (mode === 'fsaccess' && this._autoExportDirHandle) {
                const perm = await this._autoExportDirHandle.requestPermission({ mode: 'readwrite' });
                if (perm !== 'granted') {
                    console.warn('[Plugins Manager] Auto-export: write permission denied.');
                    return;
                }
                const fileHandle = await this._autoExportDirHandle.getFileHandle(filename, { create: true });
                const writable = await fileHandle.createWritable();
                await writable.write(jsonStr);
                await writable.close();
                console.log(`[Plugins Manager] Auto-exported backup to ${this._autoExportDirName}/${filename}`);
                return;
            }

            if (mode === 'download') {
                this._triggerDownload(filename, jsonStr, 'application/json');
                console.log(`[Plugins Manager] Auto-exported backup as download: ${filename}`);
                return;
            }

            console.warn('[Plugins Manager] Auto-export enabled but no destination is configured.');
        } catch (e) {
            console.error('[Plugins Manager] Auto-export failed:', e);
            this.ui.addToaster({ title: "Auto-Backup Failed", message: e.message, autoDestroyTime: 6000, dismissible: true });
        }
    }

    /** Detect available auto-export destinations in this runtime. */
    _detectAutoExportCaps() {
        const caps = { hasFSAccess: false, canDownload: true };
        try { caps.hasFSAccess = typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function'; } catch (e) { }
        // Downloads work in any environment that provides URL.createObjectURL + <a download>
        try { caps.canDownload = typeof URL !== 'undefined' && typeof URL.createObjectURL === 'function'; } catch (e) { caps.canDownload = false; }
        return caps;
    }

    _autoExportDestinationLabel() {
        if (this._autoExportMode === 'fsaccess' && this._autoExportDirName) return '📁 ' + this._autoExportDirName;
        if (this._autoExportMode === 'download') return '⬇ Downloads folder (per-change)';
        // Legacy state: dir name saved but mode not set → treat as fsaccess
        if (this._autoExportDirName) return '📁 ' + this._autoExportDirName;
        return 'No destination selected';
    }

    _autoExportModeHint() {
        if (this._autoExportCaps.hasFSAccess) {
            return 'Backups are written directly to the chosen folder.';
        }
        if (this._autoExportCaps.canDownload) {
            return 'Folder picker is unavailable in this build; backups will be saved via browser download to your Downloads folder on each change.';
        }
        return 'Automatic backups are not available in this runtime.';
    }

    /** Prompt for destination, adapting to runtime capabilities. */
    async _chooseAutoExportTarget(container) {
        // Re-detect (in case the build updated between sessions)
        this._autoExportCaps = this._detectAutoExportCaps();

        if (this._autoExportCaps.hasFSAccess) {
            try {
                const handle = await window.showDirectoryPicker({ mode: 'readwrite' });
                this._autoExportDirHandle = handle;
                this._autoExportDirName = handle.name;
                this._autoExportMode = 'fsaccess';
                localStorage.setItem('pm_auto_export_dir_name', handle.name);
                localStorage.setItem('pm_auto_export_mode', 'fsaccess');
                await this._storeAutoExportHandle(handle);
                this._applyAutoExportUI(container, 'Directory Set', `Backups will save to: ${handle.name}`);
            } catch (e) {
                if (e && e.name !== 'AbortError') {
                    // Some desktop builds expose showDirectoryPicker but it throws NotAllowedError; fall back.
                    console.warn('[Plugins Manager] showDirectoryPicker failed, falling back to download mode:', e);
                    this._autoExportCaps.hasFSAccess = false;
                    await this._offerDownloadFallback(container, e.message);
                }
            }
            return;
        }

        if (this._autoExportCaps.canDownload) {
            await this._offerDownloadFallback(container);
            return;
        }

        this.ui.addToaster({
            title: "Not Supported",
            message: "This runtime does not expose a way to save files. Please use the Backup Workspace button manually.",
            autoDestroyTime: 6000,
            dismissible: true
        });
    }

    async _offerDownloadFallback(container, originalError = '') {
        const msg = 'Folder picker is not available in this build (common on the Thymer desktop app). '
            + 'Enable "download backup on each change" instead? Files will land in your Downloads folder.'
            + (originalError ? `\n\n(Reason: ${originalError})` : '');
        if (!confirm(msg)) return;
        this._autoExportDirHandle = null;
        this._autoExportDirName = '';
        this._autoExportMode = 'download';
        localStorage.setItem('pm_auto_export_mode', 'download');
        localStorage.removeItem('pm_auto_export_dir_name');
        this._applyAutoExportUI(container, 'Auto-Download Enabled', 'Backups will download on each change.');
    }

    async _applyAutoExportUI(container, toastTitle, toastMessage) {
        if (container) {
            const lbl = container.querySelector('#pm-auto-export-dir-label');
            if (lbl) lbl.textContent = this._autoExportDestinationLabel();
            const btn = container.querySelector('#pm-auto-export-dir-btn');
            if (btn) btn.textContent = this._autoExportCaps.hasFSAccess ? 'Choose Directory' : 'Choose Destination';
            const hint = container.querySelector('#pm-auto-export-mode-help');
            if (hint) hint.textContent = this._autoExportModeHint();
            const toggle = container.querySelector('#pm-auto-export-toggle');
            if (toggle) toggle.checked = true;
        }
        this._autoExportEnabled = true;
        localStorage.setItem('pm_auto_export', 'true');
        await this._saveManagerSettings({ autoExportEnabled: true });
        if (container) this._renderWorkspaceSummary(container);
        this.ui.addToaster({ title: toastTitle, message: toastMessage, autoDestroyTime: 3000, dismissible: true });
    }

    /** Trigger a blob download via an ephemeral anchor. */
    _triggerDownload(filename, content, mimeType = 'application/json') {
        const blob = new Blob([content], { type: mimeType });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            try { document.body.removeChild(a); } catch (e) { }
            try { URL.revokeObjectURL(url); } catch (e) { }
        }, 1500);
    }

    /** Store directory handle in IndexedDB for persistence across sessions */
    async _storeAutoExportHandle(handle) {
        return new Promise((resolve, reject) => {
            const req = indexedDB.open('plugin-manager-db', 1);
            req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
            req.onsuccess = (e) => {
                const db = e.target.result;
                const tx = db.transaction('handles', 'readwrite');
                tx.objectStore('handles').put(handle, 'autoExportDir');
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            };
            req.onerror = () => reject(req.error);
        });
    }

    /** Restore directory handle from IndexedDB */
    async _restoreAutoExportHandle() {
        try {
            const handle = await new Promise((resolve, reject) => {
                const req = indexedDB.open('plugin-manager-db', 1);
                req.onupgradeneeded = (e) => { e.target.result.createObjectStore('handles'); };
                req.onsuccess = (e) => {
                    const db = e.target.result;
                    const tx = db.transaction('handles', 'readonly');
                    const getReq = tx.objectStore('handles').get('autoExportDir');
                    getReq.onsuccess = () => resolve(getReq.result || null);
                    getReq.onerror = () => reject(getReq.error);
                };
                req.onerror = () => reject(req.error);
            });
            if (handle) this._autoExportDirHandle = handle;
        } catch (e) {
            console.warn('[Plugins Manager] Could not restore auto-export directory handle:', e);
        }
    }

    // --- Utilities ---

    _cloneJsonValue(value) {
        if (value === undefined) return undefined;
        return JSON.parse(JSON.stringify(value));
    }

    /** Validate JS code is compatible with Thymer's runtime before saving */
    _validatePluginJS(name, jsCode) {
        if (!jsCode) return;
        if (/^\s*import\s+/m.test(jsCode) || /^\s*export\s+/m.test(jsCode)) {
            throw new Error(`"${name || 'Unknown'}" uses ES module syntax (import/export) which is not compatible with Thymer's plugin system.`);
        }
        // Security: removed new Function(jsCode) — it compiles arbitrary code pre-install.
        // Thymer's own runtime will surface syntax errors when the plugin loads.
    }

    /** Security: Whitelist allowed plugin.json config keys and enforce size limits */
    _sanitizePluginConfig(jsonConf, { allowCustom = false, preserveUnknownKeys = false } = {}) {
        if (preserveUnknownKeys) {
            const sanitized = this._cloneJsonValue(jsonConf || {});
            if (!allowCustom) delete sanitized.custom;
            if (allowCustom && sanitized.custom !== undefined) {
                const customJson = JSON.stringify(sanitized.custom);
                if (customJson.length > 200 * 1024) {
                    throw new Error(`"${jsonConf.name || 'Unknown'}" settings exceed the 200KB backup limit.`);
                }
            }
            return sanitized;
        }

        const ALLOWED_KEYS = ['name', 'type', 'description', 'version', 'icon', 'permissions', '__source_repo', '__source_files', 'ver'];
        const COLLECTION_SCHEMA_KEYS = ['color', 'item_name', 'show_sidebar_items', 'show_cmdpal_items',
            'sidebar_action', 'fields', 'views', 'page_field_ids', 'sidebar_record_sort_field_id',
            'sidebar_record_sort_dir', 'managed', 'home', 'related_query', 'default_banner'];
        const sanitized = {};
        for (const key of ALLOWED_KEYS) {
            if (jsonConf[key] !== undefined) {
                sanitized[key] = jsonConf[key];
            }
        }
        const isCollection = (jsonConf.type || '').toLowerCase() === 'collection';
        if (isCollection) {
            for (const key of COLLECTION_SCHEMA_KEYS) {
                if (jsonConf[key] !== undefined) {
                    sanitized[key] = jsonConf[key];
                }
            }
        }
        if (allowCustom && jsonConf.custom !== undefined) {
            const customJson = JSON.stringify(jsonConf.custom);
            if (customJson.length > 200 * 1024) {
                throw new Error(`"${jsonConf.name || 'Unknown'}" settings exceed the 200KB backup limit.`);
            }
            sanitized.custom = JSON.parse(customJson);
        }
        return sanitized;
    }

    /** Security: Strip dangerous CSS constructs that could exfiltrate data or execute scripts */
    _sanitizeCSS(cssText) {
        if (!cssText) return cssText;
        let sanitized = cssText;
        const warnings = [];

        // Strip @import rules (could load external resources/tracking pixels)
        if (/@import\s/i.test(sanitized)) {
            sanitized = sanitized.replace(/@import\s[^;]*;?/gi, '/* [removed @import] */');
            warnings.push('@import rules were removed for security');
        }

        // Strip expression() calls (IE script execution vector)
        if (/expression\s*\(/i.test(sanitized)) {
            sanitized = sanitized.replace(/expression\s*\([^)]*\)/gi, '/* [removed expression()] */');
            warnings.push('expression() calls were removed for security');
        }

        // Warn about external url() references (don't block — legitimate for fonts)
        const externalUrls = sanitized.match(/url\s*\(\s*['"]?https?:\/\//gi);
        if (externalUrls && externalUrls.length > 0) {
            warnings.push(`${externalUrls.length} external url() reference(s) found — review these if you did not author this theme`);
        }

        if (warnings.length > 0) {
            this.ui.addToaster({
                title: 'CSS Security Notice',
                message: warnings.join('. ') + '.',
                autoDestroyTime: 6000,
                dismissible: true
            });
        }

        return sanitized;
    }

    /** Escape HTML entities to prevent XSS when injecting user-controlled strings into innerHTML */
    _escHtml(str) {
        return String(str ?? '')
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    /** Validate that a URL points to github.com over HTTPS */
    _isValidGithubUrl(url) {
        return /^https:\/\/github\.com\/[^\/]+\/[^\/]+/.test(url);
    }

    // --- GitHub Utils ---

    /**
     * Parse a GitHub URL into owner, repo, and optional subpath.
     * Supports:
     *   https://github.com/user/repo
     *   https://github.com/user/repo/tree/branch/path/to/subfolder
     *   https://github.com/user/repo/tree/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/blob/branch/path/to/file.json  (extracts parent dir)
     *   https://github.com/user/repo/releases  (strips to owner/repo)
     *   https://github.com/user/repo/issues, /pulls, /wiki, etc.
     */
    _parseGithubUrl(url) {
        // Normalize SSH URLs: git@github.com:user/repo.git → https://github.com/user/repo
        url = url.replace(/^git@github\.com:/, 'https://github.com/').replace(/\.git$/, '');
        // First, strip known GitHub page paths that don't point to code
        const githubPages = /\/(releases|issues|pulls|wiki|actions|settings|discussions|tags|commit|compare|security|projects|milestones|labels|pulse|graphs|network|community)(\/.*)?$/;
        const cleanUrl = url.replace(githubPages, '');

        // Match URLs with /tree/ or /blob/ paths
        const treeMatch = cleanUrl.match(/github\.com\/([^\/]+)\/([^\/]+?)(?:\.git)?(?:\/(?:tree|blob)\/[^\/]+\/(.+?))?\/?\s*$/);
        if (!treeMatch) return { owner: null, repo: null, subpath: '' };

        let subpath = treeMatch[3] || '';

        // If subpath ends with a file extension, strip the filename to get its directory
        if (subpath && /\.[a-zA-Z0-9]+$/.test(subpath)) {
            const lastSlash = subpath.lastIndexOf('/');
            subpath = lastSlash > 0 ? subpath.substring(0, lastSlash) : '';
        }

        return {
            owner: treeMatch[1],
            repo: treeMatch[2],
            subpath: subpath
        };
    }

    /**
     * List files in a GitHub repository directory via the API.
     * Falls back through branches (main, master).
     */
    async _listRepoDirectory(owner, repo, subpath) {
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;

        const path = subpath || '';
        const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}`;

        const res = await fetch(apiUrl, { headers: apiHeaders });
        if (!res.ok) {
            const statusText = res.statusText || 'Unknown';
            throw new Error(`GitHub API ${res.status} (${statusText}): ${owner}/${repo}/${path}`);
        }

        const files = await res.json();
        if (!Array.isArray(files)) throw new Error("Path is not a directory");
        return files;
    }

    /**
     * Intelligently find a file by its role (json, js, css) from a directory listing.
     *
     * Priority order:
     * 1. Exact standard names: plugin.json, plugin.js, plugin.css
     * 2. Files with `-plugin` suffix: clock-plugin.json, clock-plugin.js
     * 3. Files with correct extension: *.json, *.js, *.css
     * 4. Extensionless Thymer export files by name heuristic:
     *    - json: "Config" or any file whose content parses as JSON
     *    - js:   "Custom Code" or file containing "extends AppPlugin"/"extends CollectionPlugin"
     *    - css:  "Custom CSS" or "Custom Style"
     */
    _findFileByRole(files, role) {
        const onlyFiles = files.filter(f => f.type === 'file');

        const extMap = { json: '.json', js: '.js', css: '.css' };
        const stdName = `plugin${extMap[role]}`;

        // 1. Exact standard name
        const exact = onlyFiles.find(f => f.name.toLowerCase() === stdName);
        if (exact) return exact;

        // 2. Files with *-plugin suffix
        const pluginSuffix = onlyFiles.find(f => f.name.toLowerCase().endsWith(`-plugin${extMap[role]}`));
        if (pluginSuffix) return pluginSuffix;

        // 3. Files with the correct extension
        const byExt = onlyFiles.filter(f => f.name.toLowerCase().endsWith(extMap[role]));
        if (byExt.length === 1) return byExt[0]; // Unambiguous single match
        // If multiple, prefer one containing 'plugin' in the name
        if (byExt.length > 1) {
            const withPlugin = byExt.find(f => f.name.toLowerCase().includes('plugin'));
            if (withPlugin) return withPlugin;
            return byExt[0]; // Fallback to first
        }

        // 4. Extensionless files by naming convention (e.g., Thymer export format)
        const nameHeuristics = {
            json: ['config'],
            js: ['custom code', 'code'],
            css: ['custom css', 'custom style', 'style', 'css']
        };

        const heuristic = nameHeuristics[role] || [];
        for (const hint of heuristic) {
            const match = onlyFiles.find(f => f.name.toLowerCase() === hint && !f.name.includes('.'));
            if (match) return match;
        }

        // 5. (CSS only) Extensionless files containing "css" in the name (e.g., "theme-name-css")
        if (role === 'css') {
            const cssInName = onlyFiles.filter(f => !f.name.includes('.') && f.name.toLowerCase().includes('css'));
            if (cssInName.length === 1) return cssInName[0];
            if (cssInName.length > 1) {
                const preferred = cssInName.find(f => /theme|style/i.test(f.name));
                return preferred || cssInName[0];
            }
        }

        return null;
    }

    /**
     * Simple heuristic to detect if text content is likely CSS.
     * Checks for CSS rule blocks and common CSS patterns while rejecting JS/JSON.
     */
    _looksLikeCSS(text) {
        if (!text || text.length < 10) return false;
        const sample = text.substring(0, 2000);
        if (!sample.includes('{') || !sample.includes('}')) return false;
        // Reject obvious non-CSS (JavaScript / JSON)
        if (/\b(function|const |let |var |module\.exports|require\(|import )\b/.test(sample)) return false;
        // Check for CSS-like content
        return /(:root|@media|@import|@font-face|color\s*:|background|font-|margin|padding|display\s*:|--[\w-]+\s*:)/i.test(sample);
    }

    async _fetchGithubFile(owner, repo, branch, path) {
        // Use API when PAT is available (required for private repos), else raw URL
        if (this.githubPat) {
            const apiUrl = `https://api.github.com/repos/${owner}/${repo}/contents/${path}?ref=${branch}`;
            const res = await fetch(apiUrl, {
                headers: {
                    'Authorization': `Bearer ${this.githubPat}`,
                    'Accept': 'application/vnd.github.v3.raw'
                }
            });
            if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
            return await res.text();
        }

        const rawUrl = `https://raw.githubusercontent.com/${owner}/${repo}/${branch}/${path}`;
        const res = await fetch(rawUrl);
        if (!res.ok) throw new Error(`Failed to fetch ${path} (${res.status})`);
        return await res.text();
    }

    async fetchGithubRepo(url, { sourceFiles } = {}) {
        if (!this._isValidGithubUrl(url)) throw new Error("URL must point to github.com");
        const { owner, repo, subpath } = this._parseGithubUrl(url);
        if (!owner || !repo) throw new Error("Invalid GitHub URL. Expected format: https://github.com/user/repo");

        // PAT auth headers — only for api.github.com, NOT for raw.githubusercontent.com (triggers CORS preflight)
        const apiHeaders = {
            'Accept': 'application/vnd.github.v3+json',
            'X-GitHub-Api-Version': '2022-11-28'
        };
        if (this.githubPat) {
            apiHeaders['Authorization'] = `Bearer ${this.githubPat}`;
        }

        const prefix = subpath ? `${subpath}/` : '';
        const label = `${owner}/${repo}${subpath ? '/' + subpath : ''}`;

        // Helper: build __source_files metadata for caching discovered filenames
        const buildSourceFiles = (branch, jsonName, jsName, cssName) => {
            const sf = { branch, json: jsonName, js: jsName };
            if (cssName) sf.css = cssName;
            return sf;
        };

        // ----- Strategy 0: Use cached filenames from a previous discovery (fastest — no probing needed) -----
        if (sourceFiles && sourceFiles.branch && sourceFiles.json && sourceFiles.js) {
            try {
                const pluginJson = JSON.parse(await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.json}`));
                const pluginJs = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.js}`);
                pluginJson.__source_repo = url;
                pluginJson.__source_files = buildSourceFiles(sourceFiles.branch, sourceFiles.json, sourceFiles.js, sourceFiles.css);
                const result = { json: pluginJson, js: pluginJs };
                if (sourceFiles.css) {
                    try {
                        result.css = await this._fetchGithubFile(owner, repo, sourceFiles.branch, `${prefix}${sourceFiles.css}`);
                    } catch (e) { /* CSS is optional */ }
                }
                return result;
            } catch (e) { /* cached names failed, fall through to full discovery */ }
        }

        // ----- Strategy 1: Try common filename patterns via raw.githubusercontent.com (fast, no API needed) -----
        // Build candidate filename lists based on common conventions:
        //   - Standard: plugin.json / plugin.js
        //   - SDK pattern: {repo}-plugin.json / {repo}-plugin.js
        //   - Thymer export names (extensionless): Config / Custom Code
        const jsonCandidates = ['plugin.json', `${repo}-plugin.json`, 'Config'];
        const jsCandidates = ['plugin.js', `${repo}-plugin.js`, 'Custom Code'];

        for (const branch of ['main', 'master']) {
            // Try each JSON candidate until one responds OK
            let foundJson = null;
            let foundJsonName = null;
            for (const jsonName of jsonCandidates) {
                try {
                    const text = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsonName}`);
                    try {
                        foundJson = JSON.parse(text);
                        foundJsonName = jsonName;
                        break;
                    } catch (e) { /* not valid JSON, try next */ }
                } catch (e) { /* try next */ }
            }
            if (!foundJson) continue;

            // Try each JS candidate until one responds OK
            for (const jsName of jsCandidates) {
                try {
                    const pluginJs = await this._fetchGithubFile(owner, repo, branch, `${prefix}${jsName}`);
                    foundJson.__source_repo = url;

                    // Also try to grab CSS while we're here
                    const cssCandidates = ['plugin.css', 'styles.css', `${repo}-plugin.css`, 'Custom CSS'];
                    const result = { json: foundJson, js: pluginJs };
                    let foundCssName = null;
                    for (const cssName of cssCandidates) {
                        try {
                            result.css = await this._fetchGithubFile(owner, repo, branch, `${prefix}${cssName}`);
                            foundCssName = cssName;
                            break;
                        } catch (e) { /* CSS is optional */ }
                    }

                    // Cache the discovered filenames for future fetches
                    foundJson.__source_files = buildSourceFiles(branch, foundJsonName, jsName, foundCssName);
                    return result;
                } catch (e) { /* try next */ }
            }
        }

        // ----- Strategy 2: Use GitHub API to discover files in the directory -----
        let files;
        try {
            files = await this._listRepoDirectory(owner, repo, subpath);
        } catch (e) {
            const reason = e.message || 'Unknown error';
            throw new Error(`Could not find plugin files in ${label}. Standard names (plugin.json/plugin.js) not found, and directory listing failed: ${reason}`);
        }

        // Find the JSON config file
        const jsonFile = this._findFileByRole(files, 'json');
        if (!jsonFile) throw new Error(`No config file (.json) found in ${label}`);

        // Find the JS code file
        const jsFile = this._findFileByRole(files, 'js');
        if (!jsFile) throw new Error(`No code file (.js) found in ${label}`);

        // Fetch the actual file contents
        const jsonRes = await fetch(jsonFile.download_url);
        if (!jsonRes.ok) throw new Error(`Failed to download ${jsonFile.name}`);

        let pluginJson;
        const jsonText = await jsonRes.text();
        try {
            pluginJson = JSON.parse(jsonText);
        } catch (e) {
            throw new Error(`${jsonFile.name} is not valid JSON`);
        }

        const jsRes = await fetch(jsFile.download_url);
        if (!jsRes.ok) throw new Error(`Failed to download ${jsFile.name}`);
        const pluginJs = await jsRes.text();

        // Optionally grab CSS
        const cssFile = this._findFileByRole(files, 'css');

        pluginJson.__source_repo = url;
        // Cache discovered filenames — detect branch from download_url
        const branchMatch = jsonFile.download_url && jsonFile.download_url.match(/raw\.githubusercontent\.com\/[^/]+\/[^/]+\/([^/]+)\//);
        pluginJson.__source_files = buildSourceFiles(
            branchMatch ? branchMatch[1] : 'main',
            jsonFile.name,
            jsFile.name,
            cssFile ? cssFile.name : null
        );

        const result = { json: pluginJson, js: pluginJs };
        if (cssFile) {
            try {
                const cssRes = await fetch(cssFile.download_url);
                if (cssRes.ok) result.css = await cssRes.text();
            } catch (e) { /* CSS is optional */ }
        }

        return result;
    }

    // --- Core Features ---

    async showInstallDialog(container, typeFilter) {
        const label = typeFilter === 'app' ? 'Plugin' : 'Collection Plugin';
        const url = await this._showPromptModal(`Install ${label}`, `Enter GitHub URL for the ${label} (e.g. https://github.com/user/repo):`);
        if (!url) return;

        try {
            this.ui.addToaster({ title: "Fetching plugin...", autoDestroyTime: 2000, dismissible: true });
            const { json, js, css } = await this.fetchGithubRepo(url);

            // Validate type
            let pType = json.type;
            if (!pType) {
                if (/extends\s+AppPlugin/.test(js)) pType = "app";
                else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(js)) pType = "collection";
            }

            const isGlobal = pType === 'app' || pType === 'global';
            const filterIsGlobal = typeFilter === 'app';

            if (isGlobal !== filterIsGlobal) {
                if (!confirm(`Warning: This repository appears to be a ${isGlobal ? 'Plugin' : 'Collection Plugin'}, but you are trying to install it as a ${filterIsGlobal ? 'Plugin' : 'Collection Plugin'}. Continue anyway?`)) {
                    return;
                }
            }

            await this.installPlugin(json, js, { cssCode: css });
            this.ui.addToaster({ title: `Successfully installed ${json.name}`, autoDestroyTime: 3000, dismissible: true });
            this.loadPlugins(container);
        } catch (err) {
            this.ui.addToaster({ title: "Install Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
        }
    }

    async installPlugin(jsonConf, jsCode, { interactive = true, cssCode = null, trustedConfig = false } = {}) {
        // Skip the Plugins Manager itself — it doesn't need to be reinstalled
        const name = (jsonConf.name || '').toLowerCase();
        if (name === 'plugins manager') {
            return 'skipped';
        }

        // Check for duplicates
        const allGlobals = await this.data.getAllGlobalPlugins();
        const allCollections = await this.data.getAllCollections();

        const existingPlugin = [...allGlobals, ...allCollections].find(p => {
            try {
                const conf = p.getExistingCodeAndConfig().json;
                // Match either by strict repo URL or exact name
                return (jsonConf.__source_repo && conf.__source_repo === jsonConf.__source_repo) || conf.name === jsonConf.name;
            } catch (e) {
                return false;
            }
        });

        let targetPlugin = null;

        // Determine the type early so we know how to handle existing plugins
        let pType = jsonConf.type;
        if (!pType) {
            if (/extends\s+AppPlugin/.test(jsCode)) {
                pType = "app";
            } else if (/extends\s+(CollectionPlugin|JournalCorePlugin)/.test(jsCode)) {
                pType = "collection";
            }
        }
        if (!pType || (pType !== 'app' && pType !== 'global' && pType !== 'collection')) {
            if (!interactive) {
                pType = 'app';
            } else {
                const choice = confirm(`Could not auto-detect the type for "${jsonConf.name || 'Unknown'}".\n\nClick OK for Plugin, or Cancel for Collection Plugin.`);
                pType = choice ? 'app' : 'collection';
            }
        }

        if (existingPlugin) {
            if (!interactive || confirm(`"${jsonConf.name}" already exists. Update/overwrite with the imported version?`)) {
                targetPlugin = existingPlugin;
            } else {
                return 'skipped';
            }
        }

        let existingConf = null;
        if (targetPlugin) {
            try {
                existingConf = targetPlugin.getExistingCodeAndConfig().json;
            } catch (e) { }
        }

        if (!targetPlugin) {
            if (pType === 'app' || pType === 'global') {
                targetPlugin = await this.data.createGlobalPlugin();
            } else if (pType === 'collection') {
                targetPlugin = await this.data.createCollection();
            }

            if (!targetPlugin) throw new Error("Failed to create plugin container in workspace.");
        }

        // Validate JS before saving — catch issues that would crash Thymer's runtime
        this._validatePluginJS(jsonConf.name, jsCode);

        // Security: sanitize config to only keep expected fields
        const sanitizedConf = this._sanitizePluginConfig(jsonConf, { allowCustom: trustedConfig, preserveUnknownKeys: trustedConfig });
        if (existingConf && existingConf.custom !== undefined && (!trustedConfig || jsonConf.custom === undefined)) {
            sanitizedConf.custom = this._cloneJsonValue(existingConf.custom);
        }

        // Security: enforce code size limit (500KB)
        if (jsCode && jsCode.length > 500 * 1024) {
            throw new Error(`"${jsonConf.name || 'Unknown'}" code exceeds the 500KB size limit.`);
        }

        // For collections: remap filter_colguid for link-to-record fields before saving
        const pTypeNorm = (jsonConf.type || '').toLowerCase();
        if (pTypeNorm === 'collection' && Array.isArray(sanitizedConf.fields) && sanitizedConf.fields.length > 0) {
            const hasColNames = sanitizedConf.fields.some(f => f.filter_colname);
            if (hasColNames) {
                const allCollections = await this.data.getAllCollections();
                const nameToGuid = {};
                for (const tc of allCollections) {
                    try {
                        const tc_conf = tc.getConfiguration();
                        const tc_guid = tc.getGuid ? tc.getGuid() : null;
                        if (tc_guid && tc_conf && tc_conf.name) nameToGuid[tc_conf.name] = tc_guid;
                    } catch (e) { }
                }
                sanitizedConf.fields = sanitizedConf.fields.map(f => {
                    if (f.filter_colguid && nameToGuid[f.filter_colname]) {
                        const { filter_colname, ...rest } = f;
                        return { ...rest, filter_colguid: nameToGuid[f.filter_colname] };
                    }
                    const { filter_colname, ...rest } = f;
                    return rest;
                });
            }
        }

        await targetPlugin.savePlugin(sanitizedConf, jsCode);

        // Security: sanitize and save CSS if provided
        if (cssCode) {
            const sanitizedCSS = this._sanitizeCSS(cssCode);
            await targetPlugin.saveCSS(sanitizedCSS);
        }

        this._autoExport(); // fire-and-forget
        return targetPlugin;
    }

    async _manualCheckForUpdates(container, filterType) {
        const btnId = filterType === 'app' ? '#pm-check-updates-global-btn' : '#pm-check-updates-col-btn';
        const btn = container.querySelector(btnId);
        if (!btn) return;

        const originalHtml = btn.innerHTML;
        btn.innerHTML = '';
        btn.appendChild(this.ui.createIcon('loader'));
        btn.disabled = true;

        try {
            await this.checkForAllUpdatesInBackground();
            this.loadPlugins(container);
            this.ui.addToaster({
                title: "Update Check Complete",
                message: "Checked for new versions.",
                autoDestroyTime: 3000,
                dismissible: true
            });
        } catch (e) {
            this.ui.addToaster({
                title: "Update Check Failed",
                message: e.message,
                autoDestroyTime: 5000,
                dismissible: true
            });
        } finally {
            btn.innerHTML = originalHtml;
            btn.disabled = false;
        }
    }

    async _updateAllAvailable(container, filterType) {
        const btnId = filterType === 'app' ? '#pm-update-all-global-btn' : '#pm-update-all-col-btn';
        const btn = container.querySelector(btnId);
        if (!btn) return;

        // Collect plugins that have known updates
        const availableUpdates = this._readUpdateCache();
        if (Object.keys(availableUpdates).length === 0) return;

        let pluginsToUpdate = [];
        try {
            if (filterType === 'app' || filterType === 'all') {
                pluginsToUpdate = pluginsToUpdate.concat(await this.data.getAllGlobalPlugins());
            }
            if (filterType === 'collection' || filterType === 'all') {
                pluginsToUpdate = pluginsToUpdate.concat(await this.data.getAllCollections());
            }
        } catch (e) { }

        pluginsToUpdate = pluginsToUpdate.filter(p => {
            try {
                return availableUpdates[p.getGuid()];
            } catch (e) { return false; }
        });

        if (pluginsToUpdate.length === 0) return;

        // Sort so that Plugins Manager (this plugin) updates LAST.
        // Updating self terminates the plugin context immediately.
        pluginsToUpdate.sort((a, b) => {
            if (a.getGuid() === this.getGuid()) return 1;
            if (b.getGuid() === this.getGuid()) return -1;
            return 0;
        });

        if (!confirm(`Apply updates to ${pluginsToUpdate.length} plugin${pluginsToUpdate.length === 1 ? '' : 's'}?\n\nWarning: This will overwrite any local code modifications for these plugins.`)) {
            return;
        }

        const originalText = btn.innerText;
        btn.innerHTML = '';
        btn.appendChild(this.ui.createIcon('loader'));
        btn.disabled = true;

        let successCount = 0;
        let failedNames = [];
        let deletedCount = 0;

        for (const p of pluginsToUpdate) {
            try {
                const conf = p.getExistingCodeAndConfig().json;
                const sourceRepo = conf.__source_repo;
                if (!sourceRepo) continue;

                // Call checkAndUpdatePlugin but bypassing UI prompts and buttons
                const { json: remoteJson, js: remoteJs, css: remoteCss } = await this.fetchGithubRepo(sourceRepo, { sourceFiles: conf.__source_files });

                this._validatePluginJS(remoteJson.name, remoteJs);
                const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                if (conf.custom !== undefined) {
                    sanitizedConf.custom = this._cloneJsonValue(conf.custom);
                }

                const isSelfUpdate = p.getGuid() === this.getGuid();

                if (remoteCss) {
                    const sanitizedCSS = this._sanitizeCSS(remoteCss);
                    await p.saveCSS(sanitizedCSS);
                }

                // Clear from known updates
                delete availableUpdates[p.getGuid()];
                this._writeUpdateCache(availableUpdates);
                this._updateStatusBarIcon();

                if (isSelfUpdate) {
                    const panel = this.ui.getActivePanel();
                    if (panel) this.ui.closePanel(panel);
                    localStorage.setItem('pm_self_update_pending', 'true');
                } else {
                    this._autoExport(); // fire-and-forget
                    this.ui.addToaster({ title: 'Reinstalled', message: `${conf.name} has been reinstalled from source.`, autoDestroyTime: 3000, dismissible: true });
                }

                await p.savePlugin(sanitizedConf, remoteJs);

                if (!isSelfUpdate) {
                    this.loadPlugins(container);
                }
            } catch (e) {
                console.error(e);
                try {
                    const conf = p.getExistingCodeAndConfig().json;
                    failedNames.push(conf.name || 'Unknown');
                } catch (e) { failedNames.push(p.getGuid()); }
            }
        }

        this._autoExport(); // fire-and-forget
        this.loadPlugins(container);

        btn.innerText = originalText;
        btn.disabled = false;

        const parts = [`Successfully updated: ${successCount}`];
        if (deletedCount > 0) parts.push(`Deleted: ${deletedCount}`);
        if (failedNames.length > 0) parts.push(`Failed: ${failedNames.join(', ')}`);

        this.ui.addToaster({
            title: failedNames.length > 0 ? "Update All Completed with Errors" : "Update All Successful",
            message: parts.join('. '),
            dismissible: true,
            autoDestroyTime: failedNames.length > 0 ? 8000 : 5000
        });
    }

    async showExportDialog(typeFilter) {
        const allData = await this._getExportData();
        let candidateData;
        if (typeFilter === 'app') {
            candidateData = allData.filter(d => d.type !== 'collection');
        } else if (typeFilter === 'collection') {
            candidateData = allData.filter(d => d.type === 'collection');
        } else {
            candidateData = allData;
        }

        const sectionMeta = this._getSectionMeta(typeFilter);
        const typeLabel = sectionMeta.label;

        // Build the selection list HTML
        const selectionRows = candidateData.map((d, i) => `
            <label style="display:flex; align-items:center; gap:8px; padding:6px 0; border-bottom:1px solid var(--pm-border-default); cursor:pointer;">
                <input type="checkbox" class="pm-export-cb" data-index="${i}" checked />
                <span style="flex:1; font-size:13px;">${this._escHtml(d.name || 'Unnamed')}</span>
                <span style="font-size:11px; color:var(--pm-text-muted);">${this._escHtml(d.type || '')}</span>
            </label>
        `).join('');

        const overlayHtml = `
            <div id="pm-export-modal" class="pm-modal">
                <div class="pm-modal-content pm-export-content">
                    <h3>Backup ${typeLabel}</h3>

                    <div style="margin-bottom:14px;">
                        <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:6px;">
                            <label style="font-weight:bold; font-size:13px;">Select ${this._escHtml(sectionMeta.itemLabel)} to include</label>
                            <div style="display:flex; gap:8px;">
                                <button class="pm-btn" id="pm-sel-all" style="padding:2px 8px; font-size:11px;">All</button>
                                <button class="pm-btn" id="pm-sel-none" style="padding:2px 8px; font-size:11px;">None</button>
                            </div>
                        </div>
                        <div id="pm-export-selection" style="max-height:180px; overflow-y:auto; border:1px solid var(--pm-border-default); border-radius:6px; padding:0 10px;">
                            ${selectionRows || '<p style="font-size:13px;color:var(--pm-text-muted);padding:8px 0;">No plugins found.</p>'}
                        </div>
                    </div>

                    <div style="margin-bottom: 20px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Repository URLs (for quick restore in another workspace)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-urls" style="padding: 2px 8px; font-size: 11px;">Copy URLs</button>
                                <button class="pm-btn" id="pm-download-urls" style="padding: 2px 8px; font-size: 11px;">Download URLs</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-urls" id="pm-urls-text" readonly></textarea>
                    </div>
                    
                    <div style="margin-bottom: 15px;">
                        <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 5px;">
                            <label style="font-weight: bold;">Full Backup (JSON with code, CSS, config, and manager settings)</label>
                            <div style="display: flex; gap: 5px;">
                                <button class="pm-btn" id="pm-copy-json" style="padding: 2px 8px; font-size: 11px;">Copy JSON</button>
                                <button class="pm-btn primary" id="pm-download-json" style="padding: 2px 8px; font-size: 11px;">Download Backup</button>
                            </div>
                        </div>
                        <textarea class="pm-textarea pm-textarea-json" id="pm-full-backup-text" readonly></textarea>
                    </div>
                    
                    <div style="display: flex; justify-content: flex-end; gap: 10px; margin-top: 20px;">
                        <button class="pm-btn" id="pm-export-close">Close</button>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        // Helper: compute selected export data and refresh the textareas
        const refreshTextareas = () => {
            const checked = [...tempDiv.querySelectorAll('.pm-export-cb:checked')].map(cb => candidateData[parseInt(cb.dataset.index)]);
            const urls = checked.map(d => d.source_repo).filter(Boolean).join('\n');
            const fullBackup = JSON.stringify(this._buildExportPayload(typeFilter, checked), null, 2);
            tempDiv.querySelector('#pm-urls-text').value = urls;
            tempDiv.querySelector('#pm-full-backup-text').value = fullBackup;
        };

        // Initial fill
        refreshTextareas();

        // Checkbox changes
        tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.addEventListener('change', refreshTextareas));

        // Select All / None
        tempDiv.querySelector('#pm-sel-all').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = true);
            refreshTextareas();
        });
        tempDiv.querySelector('#pm-sel-none').addEventListener('click', () => {
            tempDiv.querySelectorAll('.pm-export-cb').forEach(cb => cb.checked = false);
            refreshTextareas();
        });

        tempDiv.querySelector('#pm-export-close').addEventListener('click', () => {
            this._closeModal(tempDiv);
        });

        // Copy actions
        tempDiv.querySelector('#pm-copy-urls').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-urls-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        tempDiv.querySelector('#pm-copy-json').addEventListener('click', async (e) => {
            await navigator.clipboard.writeText(tempDiv.querySelector('#pm-full-backup-text').value);
            const orig = e.target.innerText;
            e.target.innerText = "Copied!";
            setTimeout(() => e.target.innerText = orig, 2000);
        });

        // Download actions
        tempDiv.querySelector('#pm-download-urls').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-urls-text').value;
            const blob = new Blob([content], { type: 'text/plain' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = `thymer-${typeFilter}-urls-${this._getWorkspaceName()}.txt`;
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });

        tempDiv.querySelector('#pm-download-json').addEventListener('click', () => {
            const content = tempDiv.querySelector('#pm-full-backup-text').value;
            const blob = new Blob([content], { type: 'application/json' });
            const url = URL.createObjectURL(blob);
            const a = document.createElement('a');
            a.href = url;
            a.download = this._getBackupJsonFilename(typeFilter);
            document.body.appendChild(a);
            a.click();
            document.body.removeChild(a);
            URL.revokeObjectURL(url);
        });
    }

    async showImportDialog(container, typeFilter) {
        const sectionMeta = this._getSectionMeta(typeFilter);
        const overlayHtml = `
            <div id="pm-import-modal" class="pm-modal">
                <div class="pm-modal-content">
                    <h3>Restore ${sectionMeta.importLabel}</h3>
                    <p>Paste GitHub URLs (one per line), paste a JSON backup array/object, or upload a workspace backup file.</p>
                    <textarea id="pm-import-textarea" class="pm-textarea" placeholder="https://github.com/user/repo1\nhttps://github.com/user/repo2"></textarea>
                    
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid var(--pm-border-default);">
                        <label style="display: block; font-size: 13px; margin-bottom: 5px; color: var(--pm-text-muted);">Or upload a backup file:</label>
                        <input type="file" id="pm-import-file" accept=".json" style="font-size: 13px; color: inherit; width: 100%;" />
                    </div>

                    <div style="margin-top: 15px; display: flex; align-items: center; justify-content: space-between;">
                        <label style="display: flex; align-items: center; gap: 8px; font-size: 13px; cursor: pointer;">
                            <input type="checkbox" id="pm-import-full-override" />
                            <span style="color: var(--pm-danger-fg, var(--pm-danger)); font-weight: bold;">Full Override (Delete existing)</span>
                        </label>
                        <div style="display: flex; gap: 10px;">
                            <button class="pm-btn" id="pm-import-cancel">Cancel</button>
                            <button class="pm-btn primary" id="pm-import-confirm">Import</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

        const tempDiv = document.createElement('div');
        tempDiv.innerHTML = overlayHtml;
        this._openModal(tempDiv);

        document.getElementById('pm-import-cancel').addEventListener('click', () => {
            this._closeModal(tempDiv);
        });

        // Handle file upload immediately dumping text into the textarea for preview/processing
        document.getElementById('pm-import-file').addEventListener('change', (e) => {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = (ev) => {
                document.getElementById('pm-import-textarea').value = ev.target.result;
            };
            reader.readAsText(file);
        });

        document.getElementById('pm-import-confirm').addEventListener('click', async () => {
            const val = document.getElementById('pm-import-textarea').value.trim();
            if (!val) return;

            const isFullOverride = document.getElementById('pm-import-full-override').checked;
            if (isFullOverride) {
                if (!confirm(`WARNING: Full Override will delete existing ${sectionMeta.warningLabel} that are NOT in this backup. This cannot be undone. Are you sure?`)) {
                    return;
                }
            }

            document.getElementById('pm-import-confirm').innerText = "Restoring...";
            document.getElementById('pm-import-confirm').disabled = true;

            let successCount = 0;
            let failedNames = [];
            let skippedNames = [];
            let deletedCount = 0;

            if (val.startsWith('[') || val.startsWith('{')) {
                // JSON full backup import
                try {
                    const parsed = JSON.parse(val);
                    const { items: importedItems, managerSettings } = this._normalizeImportedBackup(parsed, typeFilter);

                    if (isFullOverride) {
                        const backupNames = importedItems.map(p => (p.json && p.json.name) || p.name).filter(Boolean);

                        if (typeFilter === 'app' || typeFilter === 'all') {
                            const allGlobals = await this.data.getAllGlobalPlugins();
                            for (const p of allGlobals) {
                                try {
                                    const pName = p.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(pName) && pName.toLowerCase() !== 'plugins manager') {
                                        await p.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }

                        if (typeFilter === 'collection' || typeFilter === 'all') {
                            const allCollections = await this.data.getAllCollections();
                            for (const c of allCollections) {
                                try {
                                    const cName = c.getExistingCodeAndConfig().json.name;
                                    if (!backupNames.includes(cName)) {
                                        await c.trashPlugin();
                                        deletedCount++;
                                    }
                                } catch (e) { }
                            }
                        }
                    }

                    for (const p of importedItems) {
                        // Merge wrapper-level type into json conf (export format puts type on wrapper, not inside json)
                        const mergedJson = { ...p.json };
                        if (!mergedJson.type && p.type) mergedJson.type = p.type;
                        const pName = mergedJson.name || p.name || 'Unknown';
                        try {
                            const result = await this.installPlugin(mergedJson, p.code, { interactive: !isFullOverride, cssCode: p.css, trustedConfig: true });
                            if (result === 'skipped') { skippedNames.push(pName); }
                            else { successCount++; }
                        } catch (e) {
                            console.error(e);
                            failedNames.push(pName);
                        }
                    }

                    await this._restoreImportedManagerSettings(managerSettings, container);
                } catch (e) {
                    this.ui.addToaster({ title: "Import Failed", message: e.message || "Invalid JSON format", autoDestroyTime: 5000, dismissible: true });
                    this._closeModal(tempDiv);
                    return;
                }
            } else {
                // URLs import
                const urls = val.split('\n').map(u => u.trim()).filter(Boolean);
                for (const url of urls) {
                    const shortUrl = url.replace(/https?:\/\/github\.com\//, '');
                    try {
                        const { json, js, css } = await this.fetchGithubRepo(url);
                        const pName = json.name || shortUrl;
                        const result = await this.installPlugin(json, js, { interactive: !isFullOverride, cssCode: css });
                        if (result === 'skipped') { skippedNames.push(pName); }
                        else { successCount++; }
                    } catch (e) {
                        console.error(e);
                        failedNames.push(shortUrl);
                    }
                }
            }

            this._closeModal(tempDiv);
            const parts = [`Installed: ${successCount}`];
            if (deletedCount > 0) parts.push(`Deleted: ${deletedCount}`);
            if (skippedNames.length > 0) parts.push(`Skipped: ${skippedNames.join(', ')}`);
            if (failedNames.length > 0) parts.push(`Failed: ${failedNames.join(', ')}`);
            this.ui.addToaster({
                title: "Restore Complete",
                message: parts.join('. '),
                dismissible: true,
                autoDestroyTime: failedNames.length > 0 ? 8000 : 5000
            });
            this.loadPlugins(container);
            this._renderWorkspaceSummary(container);
        });
    }

    async checkAndUpdatePlugin(pluginObj, currentConf, sourceRepo, btnEl, container, knownUpdateVersion = null, options = {}) {
        const forceUpdate = options.forceUpdate === true;
        try {
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('loader'));
            btnEl.disabled = true;

            let remoteJson, remoteJs, remoteCss;
            try {
                const res = await this.fetchGithubRepo(sourceRepo, { sourceFiles: currentConf.__source_files });
                remoteJson = res.json;
                remoteJs = res.js;
                remoteCss = res.css;
            } catch (fetchErr) {
                throw new Error(`Failed to fetch from ${sourceRepo}: ${fetchErr.message}`);
            }

            if (!forceUpdate && remoteJson.version === currentConf.version) {
                this.ui.addToaster({ title: "Up to date", message: `${currentConf.name} is already on the latest version.`, autoDestroyTime: 3000, dismissible: true });
                btnEl.className = 'pm-btn pm-btn-update';
                btnEl.innerHTML = '';
                btnEl.appendChild(this.ui.createIcon('check'));

                // Clear from known updates
                try {
                    const available = this._readUpdateCache();
                    delete available[pluginObj.getGuid()];
                    this._writeUpdateCache(available);
                    this._updateStatusBarIcon();
                } catch (e) { }

                const badge = document.getElementById(`vbadge-${pluginObj.getGuid()}`);
                if (badge) {
                    badge.innerText = `v${currentConf.version}`;
                    badge.classList.remove('update');
                }

                setTimeout(() => {
                    btnEl.innerHTML = '';
                    btnEl.appendChild(this.ui.createIcon('refresh'));
                    btnEl.title = 'Check Update';
                    btnEl.disabled = false;
                }, 3000);
                return true;
            }

            // Update available or forceUpdate requested
            const pGuid = pluginObj.getGuid();
            const badge = document.getElementById(`vbadge-${pGuid}`);
            if (badge) {
                badge.innerText = `Update Available (v${remoteJson.version})`;
                badge.classList.add('update');
            }

            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('arrow-up'));
            btnEl.className = 'pm-btn pm-btn-update update-btn';
            btnEl.disabled = false;

            // Update local storage so indicator persists
            try {
                const available = this._readUpdateCache();
                available[pluginObj.getGuid()] = { name: currentConf.name || remoteJson.name || '', version: remoteJson.version };
                this._writeUpdateCache(available);
                this._updateStatusBarIcon();
            } catch (e) { }

            // Overwrite click handler to apply update
            const applyUpdate = async () => {
                // Local modifications warning check (simple length/hash comparison could go here in future)
                if (confirm(`Update ${currentConf.name} from v${currentConf.version} to v${remoteJson.version}?\n\nWarning: This will overwrite any local code modifications.`)) {
                    this._validatePluginJS(remoteJson.name, remoteJs);
                    const sanitizedConf = this._sanitizePluginConfig(remoteJson);
                    if (currentConf.custom !== undefined) {
                        sanitizedConf.custom = this._cloneJsonValue(currentConf.custom);
                    }

                    const isSelfUpdate = pluginObj.getGuid() === this.getGuid();

                    if (remoteCss) {
                        const sanitizedCSS = this._sanitizeCSS(remoteCss);
                        await pluginObj.saveCSS(sanitizedCSS);
                    }

                    // Remove from updates cache
                    try {
                        const available = this._readUpdateCache();
                        delete available[pGuid];
                        this._writeUpdateCache(available);
                        this._updateStatusBarIcon();
                    } catch (e) { }

                    if (isSelfUpdate) {
                        const panel = this.ui.getActivePanel();
                        if (panel) this.ui.closePanel(panel);
                        localStorage.setItem('pm_self_update_pending', 'true');
                    } else {
                        this._autoExport(); // fire-and-forget
                        this.ui.addToaster({ title: "Update Successful", message: `${currentConf.name} updated to v${remoteJson.version}`, autoDestroyTime: 3000, dismissible: true });
                    }

                    await pluginObj.savePlugin(sanitizedConf, remoteJs);

                    if (!isSelfUpdate) {
                        this.loadPlugins(container);
                    }
                }
                return false;
            };

            // If we already knew about this update, the click intent was to apply it, not just check
            if (knownUpdateVersion) {
                return await applyUpdate();
            } else {
                btnEl.onclick = applyUpdate;
                return true;
            }

        } catch (err) {
            console.error(err);
            this.ui.addToaster({ title: "Update Failed", message: err.message, autoDestroyTime: 5000, dismissible: true });
            btnEl.innerHTML = '';
            btnEl.appendChild(this.ui.createIcon('refresh'));
            btnEl.title = 'Check Update';
            btnEl.disabled = false;
            return false;
        }
    }
}
