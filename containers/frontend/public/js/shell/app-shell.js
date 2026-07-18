// Top-level app chrome. Owns the sidebar (wide/collapsed), bottom-nav
// (narrow), mode segmented control, brand, connection indicator, theme
// switcher, logout button, and #main-content slot.
//
// Responsibilities:
//   * Render one shell HTML with slots for SidebarNav / BottomNav / #main-content
//   * Listen to matchMedia breakpoints and set data-layout ("wide" | "collapsed"
//     | "narrow"). CSS handles the visibility transitions.
//   * Instantiate SidebarNav + BottomNav once; hand each a slot to render into.
//   * Wire the mode segmented control to ModeController.
//   * When mode != camping, hide the sidebar/bottom-nav and hand #main-content
//     to the mode page (driving.js / storage.js). When mode = camping, restore
//     nav and let router drive #main-content.
//   * Provide an "onModeChange" callback so app.js can (later) mount the
//     driving/storage pages without AppShell needing to know their internals.
//
// This class is intentionally the ONLY DOM writer for the app chrome —
// individual pages should never touch anything outside #main-content.

import { API } from '../api.js';
import { router } from '../router.js';
import { modeController } from './mode-controller.js';
import { SidebarNav } from './sidebar-nav.js';
import { BottomNav } from './bottom-nav.js';
import { alarmBell } from '../components/alarm-bell.js';
import { AlertHost } from './alert-host.js';

const BP_WIDE = 1240;    // ≥ this = full sidebar
const BP_TABLET = 920;   // ≥ this and < wide = collapsed icon rail
                         // < BP_TABLET = bottom nav (phone)

export class AppShell {
    constructor() {
        this.root = null;
        this.sidebarNav = new SidebarNav();
        this.bottomNav = new BottomNav();
        this.alertHost = null;
        this._layout = this._detectLayout();
        this._activePage = 'home';
        this._modePageHandler = null;
        this._resizeHandler = null;
    }

    // Optional callback: (mode) => void
    // Called whenever the user picks a mode. In camping mode the shell
    // restores nav + delegates to the router; in driving/storage mode the
    // shell clears #main-content and hands off to the caller so they can
    // mount the appropriate page.
    //
    // If a non-camping mode was already active when the handler is
    // registered (e.g. loaded from localStorage on boot), the handler
    // is invoked immediately so main-content isn't left empty.
    setModePageHandler(fn) {
        this._modePageHandler = fn;
        const current = modeController.getMode();
        if (current !== 'camping') {
            const mainEl = this.getMainContentEl();
            if (mainEl) mainEl.innerHTML = '';
            fn(current);
        }
    }

    mount(target) {
        target.innerHTML = this._renderShell();
        this.root = target.querySelector('.app-shell');
        this._applyLayout(this._layout);
        // Sync mode DOM only — content dispatch is skipped because the
        // router hasn't been initialized yet and the mode page handler
        // hasn't been registered. app.js drives the initial render
        // (router.navigate / setModePageHandler) after mount() returns.
        this._syncModeDOM(modeController.getMode());

        // Mount nav components into their slots
        this.sidebarNav.mount(
            this.root.querySelector('#app-sidebar-nav-slot'),
            { activePage: this._activePage }
        );
        this.bottomNav.mount(
            this.root.querySelector('#app-bottom-nav'),
            { activePage: this._activePage }
        );

        // Start the alarm state source (idempotent) and mount the alert host
        // into three surfaces. The store lives across shell tear-downs so
        // notifications keep firing when the user is in Driving/Storage mode.
        alarmBell.start();
        this.alertHost = new AlertHost(alarmBell);
        this.alertHost.mountInto(this.root.querySelector('#alert-banner-slot'), 'banner');
        this.alertHost.mountInto(this.root.querySelector('#alert-pill-slot'), 'pill');
        this.alertHost.mountInto(this.root.querySelector('#sidebar-alarm-bell-slot'), 'sidebarBell');

        this._wireModeSwitcher();
        this._wireThemeSwitcher();
        this._wireLogout();
        this._wireResize();

        // Route changes → active-state updates
        router.onNavigate((page) => {
            this._activePage = page;
            this.sidebarNav.updateActive(page);
            this.bottomNav.updateActive(page);
        });

        // Mode changes → hide/show nav; delegate to caller
        modeController.addEventListener('change', (e) => {
            this._applyMode(e.detail.mode);
        });
    }

    // Called by app.js after login to sync theme buttons with the loaded theme.
    syncTheme(theme) {
        this._updateThemeButtons(theme);
    }

    // Called by app.js's WebSocket connection listener.
    setConnectionStatus(status) {
        const el = this.root?.querySelector('#app-connection-indicator');
        if (!el) return;
        el.dataset.status = status;
        const label = status === 'connected' ? 'Connected'
            : status === 'disconnected' ? 'Reconnecting…'
            : status === 'error' ? 'Connection error'
            : 'Connecting…';
        el.querySelector('.conn-label').textContent = label;
    }

    getMainContentEl() {
        return this.root?.querySelector('#main-content') ?? null;
    }

    destroy() {
        if (this._resizeHandler) window.removeEventListener('resize', this._resizeHandler);
        this._resizeHandler = null;
        this.bottomNav.destroy();
        if (this.alertHost) {
            this.alertHost.destroy();
            this.alertHost = null;
        }
        // Note: we intentionally do NOT stop() the alarmBell store here —
        // it's a shared singleton that also feeds notifications.js. It only
        // stops on full logout.
    }

    // ────────────────────────────────────────────────────────────────────

    _renderShell() {
        const user = API.getUser?.();
        const displayName = user?.display_name || user?.username || 'User';
        const currentMode = modeController.getMode();

        return `
            <div class="app-shell" data-layout="${this._layout}" data-mode="${currentMode}">
                <aside class="app-sidebar">
                    <div class="sidebar-brand">
                        <img src="/icons/logo-white.svg" alt="Overlook" class="app-logo app-logo-dark">
                        <img src="/icons/logo-color.svg" alt="Overlook" class="app-logo app-logo-light">
                    </div>

                    <div class="mode-switcher" role="tablist">
                        ${this._renderModeButton('camping', 'Camping', currentMode)}
                        ${this._renderModeButton('driving', 'Driving', currentMode)}
                        ${this._renderModeButton('storage', 'Storage', currentMode)}
                    </div>

                    <div id="app-sidebar-nav-slot"></div>

                    <div class="sidebar-flex-fill"></div>

                    <div id="app-connection-indicator" class="sidebar-connection" data-status="connecting">
                        <span class="conn-dot"></span>
                        <span class="conn-label">Connecting…</span>
                        <span class="sidebar-connection-spacer"></span>
                        <span id="sidebar-alarm-bell-slot"></span>
                    </div>

                    <div class="sidebar-theme-switcher">
                        <button class="theme-btn" data-theme="light" aria-label="Light theme">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="5"></circle><line x1="12" y1="1" x2="12" y2="3"></line><line x1="12" y1="21" x2="12" y2="23"></line><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line><line x1="1" y1="12" x2="3" y2="12"></line><line x1="21" y1="12" x2="23" y2="12"></line><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line></svg>
                            <span>Light</span>
                        </button>
                        <button class="theme-btn" data-theme="dark" aria-label="Dark theme">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"></path></svg>
                            <span>Dark</span>
                        </button>
                    </div>

                    <button id="logout-btn" class="sidebar-logout" title="Sign out (${displayName})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"></path><polyline points="16 17 21 12 16 7"></polyline><line x1="21" y1="12" x2="9" y2="12"></line></svg>
                        <span>Sign out</span>
                    </button>
                </aside>

                <div class="app-main-column">
                    <div class="app-main-mode-header">
                        <div class="mode-switcher mode-switcher-narrow" role="tablist">
                            ${this._renderModeButton('camping', 'Camping', currentMode)}
                            ${this._renderModeButton('driving', 'Driving', currentMode)}
                            ${this._renderModeButton('storage', 'Storage', currentMode)}
                        </div>
                    </div>
                    <div id="alert-banner-slot"></div>
                    <main id="main-content" class="main-content"></main>
                </div>

                <nav id="app-bottom-nav" class="app-bottom-nav"></nav>

                <div id="alert-pill-slot"></div>
            </div>
        `;
    }

    _renderModeButton(mode, label, currentMode) {
        return `<button class="mode-btn ${currentMode === mode ? 'active' : ''}"
                        data-mode="${mode}" role="tab"
                        aria-selected="${currentMode === mode}">${label}</button>`;
    }

    _wireModeSwitcher() {
        this.root.addEventListener('click', (e) => {
            const btn = e.target.closest('.mode-btn');
            if (!btn) return;
            const mode = btn.dataset.mode;
            if (mode) modeController.setMode(mode);
        });
    }

    _wireThemeSwitcher() {
        this.root.addEventListener('click', (e) => {
            const btn = e.target.closest('.theme-btn');
            if (!btn) return;
            const theme = btn.dataset.theme;
            if (!theme) return;
            document.documentElement.setAttribute('data-theme', theme);
            this._updateThemeButtons(theme);
            // Persist to server-side settings.
            API.setSettings?.({ theme }).catch(err => {
                console.error('Failed to persist theme:', err);
            });
        });
        this._updateThemeButtons(document.documentElement.getAttribute('data-theme') || 'dark');
    }

    _updateThemeButtons(theme) {
        if (!this.root) return;
        this.root.querySelectorAll('.theme-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.theme === theme);
        });
    }

    _wireLogout() {
        // Preserve existing behavior: the button dispatches a click event and
        // app.js's `setupLogoutButton` (called separately) wires it.
        // Nothing to do here — app.js still owns handleLogout.
    }

    _wireResize() {
        this._resizeHandler = () => {
            const layout = this._detectLayout();
            if (layout !== this._layout) {
                this._layout = layout;
                this._applyLayout(layout);
            }
        };
        window.addEventListener('resize', this._resizeHandler);
    }

    _detectLayout() {
        const w = window.innerWidth;
        if (w >= BP_WIDE) return 'wide';
        if (w >= BP_TABLET) return 'collapsed';
        return 'narrow';
    }

    _applyLayout(layout) {
        if (!this.root) return;
        this.root.dataset.layout = layout;
    }

    _syncModeDOM(mode) {
        if (!this.root) return;
        this.root.dataset.mode = mode;

        // Sync all mode-switcher buttons (there are two: sidebar + narrow header)
        this.root.querySelectorAll('.mode-btn').forEach(btn => {
            const active = btn.dataset.mode === mode;
            btn.classList.toggle('active', active);
            btn.setAttribute('aria-selected', String(active));
        });
    }

    _applyMode(mode) {
        this._syncModeDOM(mode);
        if (!this.root) return;

        // Camping = router owns #main-content, nav visible.
        // Driving/Storage = mode page owns #main-content, nav hidden (CSS via
        // [data-mode]), delegate to registered handler.
        const mainEl = this.getMainContentEl();
        if (!mainEl) return;

        if (mode === 'camping') {
            // Let the router re-render the current page. If a mode page was
            // mounted, its cleanup runs here so its subscriptions unwind.
            if (this._modePageHandler) this._modePageHandler('camping');
            const page = router.getPageFromHash() || 'home';
            router.navigate(page);
        } else {
            // Cleanup whatever the router had mounted, then delegate. We call
            // the router's cleanup by asking it to "unmount" the current page.
            if (router.currentPage?.cleanup) {
                try { router.currentPage.cleanup(); } catch (_) {}
                router.currentPage = null;
            }
            mainEl.innerHTML = '';
            if (this._modePageHandler) this._modePageHandler(mode);
        }
    }
}
