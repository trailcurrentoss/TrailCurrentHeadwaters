// Main application entry point
import { router } from './router.js';
import { API, wsClient } from './api.js';
import { AppShell } from './shell/app-shell.js';
import { modeController } from './shell/mode-controller.js';
import { homePage } from './pages/home.js';
import { trailerPage } from './pages/trailer.js';
import { energyPage } from './pages/energy.js';
import { waterPage } from './pages/water.js';
import { airqualityPage } from './pages/airquality.js';
import { settingsPage } from './pages/settings/index.js';
import { loginPage } from './pages/login.js';
import { mapPage } from './pages/map.js';
import { wizardPage } from './pages/wizard.js';
import { playbillPage } from './pages/playbill.js';
import { peregrinePage } from './pages/peregrine.js';
import { drivingPage } from './pages/driving.js';
import { storagePage } from './pages/storage.js';
import { alarmBell } from './components/alarm-bell.js';
import * as notifications from './notifications.js';
import { gnssSimulator } from './services/gnss-simulator.js';

class App {
    constructor() {
        this.isAuthenticated = false;
    }

    async init() {
        try {
            // Register service worker
            this.registerServiceWorker();

            // iOS Safari ignores user-scalable=no in the viewport meta when
            // gestures originate from inside the page. Belt-and-suspenders:
            // explicitly cancel iOS's non-standard pinch (`gesturestart`)
            // and the double-tap-zoom (`dblclick`) at the document level.
            // CSS `touch-action: manipulation` on each control covers the
            // common case; this catches anything that slips through.
            const cancel = (e) => e.preventDefault();
            document.addEventListener('gesturestart',  cancel, { passive: false });
            document.addEventListener('gesturechange', cancel, { passive: false });
            document.addEventListener('gestureend',    cancel, { passive: false });
            document.addEventListener('dblclick',      cancel, { passive: false });

            // Set default theme
            document.documentElement.setAttribute('data-theme', 'dark');

            // Check authentication status
            let authStatus = { authenticated: false };
            try {
                authStatus = await API.checkAuth();
            } catch (error) {
                console.error('Auth check failed:', error);
            }

            this.isAuthenticated = authStatus.authenticated;

            if (this.isAuthenticated) {
                await this.initAuthenticatedApp();
            } else {
                this.showLogin();
            }

            // Listen for auth events
            window.addEventListener('authRequired', () => {
                this.handleLogout();
            });

            window.addEventListener('authSuccess', () => {
                this.handleLoginSuccess();
            });
        } catch (error) {
            console.error('App init error:', error);
            // Show login on any error
            this.showLogin();
        } finally {
            // Always hide loading overlay
            this.hideLoading();
        }
    }

    async initAuthenticatedApp() {
        // Load settings
        await this.loadSettings();

        // Check if wizard needs to be completed
        let systemConfig = null;
        let wizardNeeded = false;

        try {
            systemConfig = await API.getSystemConfig();
            // Wizard is needed if not completed
            wizardNeeded = !systemConfig.wizard_completed;
        } catch (error) {
            console.error('Failed to load system config:', error);
            // If we can't load config, show wizard to complete setup
            systemConfig = null;
            wizardNeeded = true;
        }

        if (wizardNeeded) {
            // Show wizard instead of normal app UI
            console.log('Showing wizard...');
            this.showWizard();
            return;
        }

        // Show normal app UI
        console.log('Showing normal app UI...');
        this.showAppUI();

        // Initialize router — bound to #main-content owned by AppShell.
        // NOTE ordering: AppShell.mount() (called from showAppUI() above)
        // triggers _applyMode → router.navigate() during boot, BEFORE
        // router.init has been called with the content element. That
        // initial navigate bails out with "contentElement is null" (logged
        // but harmless). We re-navigate below to actually render the
        // initial page now that the router is fully wired.
        // Config, Deployments, Maps, and Alarms are no longer top-level
        // pages — they live inside the consolidated Settings screen at
        // #settings/network, #settings/deploy, #settings/maps, and
        // #settings/alarms. Legacy hash bookmarks (#config, #maps, etc.)
        // still work; the router transparently redirects them.
        router
            .init(document.getElementById('main-content'))
            .register('home', homePage)
            .register('trailer', trailerPage)
            .register('energy', energyPage)
            .register('water', waterPage)
            .register('airquality', airqualityPage)
            .register('map', mapPage)
            .register('playbill', playbillPage)
            .register('peregrine', peregrinePage)
            .register('settings', settingsPage);

        // Render the initial page now that the router is bound + populated.
        // If a hash is present in the URL, honor it; otherwise home.
        router.navigate(router.getPageFromHash() || 'home');

        // Sync theme buttons to the persisted theme
        const currentTheme = document.documentElement.getAttribute('data-theme') || 'dark';
        this.appShell.syncTheme(currentTheme);

        // Mount mode-specific pages. Driving lives in Phase 4 (this).
        // Storage lands in Phase 5.
        this._modePage = null;
        this.appShell.setModePageHandler((mode) => {
            // Tear down whatever mode page was mounted (if any).
            if (this._modePage?.cleanup) {
                try { this._modePage.cleanup(); } catch (_) {}
            }
            this._modePage = null;

            const el = this.appShell.getMainContentEl();
            if (!el) return;

            if (mode === 'driving') {
                el.innerHTML = drivingPage.render();
                drivingPage.init();
                this._modePage = drivingPage;
                return;
            }

            if (mode === 'storage') {
                el.innerHTML = storagePage.render();
                storagePage.init();
                this._modePage = storagePage;
                return;
            }
            // camping: nothing — AppShell delegates to the router.
        });

        // Setup logout button (AppShell renders the button; app.js wires it)
        this.setupLogoutButton();

        // Alarm bell + banner + pill are managed by AppShell via AlertHost
        // (Phase 3). The alarmBell singleton is started inside AppShell.mount.

        // Install the GNSS-simulator emit wrapper BEFORE wsClient.connect() so
        // any latlon/gnss_details frames that arrive before consumers subscribe
        // still pass through the interceptor.
        gnssSimulator.init();

        // Connect WebSocket
        wsClient.connect();
        this.setupConnectionStatus();

        // Alarm notifier lives at the app level so notifications fire
        // regardless of which page is showing. Wake-lock keeps the WS
        // alive when the display would otherwise sleep — this is what
        // makes offline alarm delivery viable on a vehicle Wi-Fi with
        // no internet path to a cloud push service.
        notifications.startAlarmNotifier();
        if (notifications.isEnabled()) {
            notifications.enableWakeLock();
        }

        // Navigate to initial page — only if we're in Camping. Driving /
        // Storage are single-page dashboards owned by AppShell's mode handler.
        if (modeController.getMode() === 'camping') {
            const initialPage = router.getPageFromHash();
            await router.navigate(initialPage);
        }

        // Handle hash changes
        window.addEventListener('hashchange', () => {
            if (!this.isAuthenticated) return;
            if (modeController.getMode() !== 'camping') return;
            const page = router.getPageFromHash();
            router.navigate(page);
        });

    }

    showLogin() {
        // Ensure the AppShell (if any) unwinds its window resize listener
        // before we tear down the DOM.
        if (this.appShell) {
            this.appShell.destroy();
            this.appShell = null;
        }
        const appEl = document.getElementById('app');
        appEl.innerHTML = loginPage.render();
        loginPage.init();
    }

    showWizard() {
        const appEl = document.getElementById('app');
        const user = API.getUser();
        const displayName = user?.display_name || user?.username || 'User';

        // The setup wizard is intentionally chrome-less — the sidebar/nav
        // aren't meaningful yet because modules haven't been configured.
        // Keep the minimal header + logout, mount the wizard into #main-content.
        appEl.innerHTML = `
            <header class="app-header">
                <div class="header-left">
                    <img src="/icons/logo-white.svg" alt="Overlook" class="app-logo app-logo-dark">
                    <img src="/icons/logo-color.svg" alt="Overlook" class="app-logo app-logo-light">
                </div>
                <div class="header-right">
                    <button class="logout-btn" id="logout-btn" title="Sign out (${displayName})">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
                            <polyline points="16 17 21 12 16 7"/>
                            <line x1="21" y1="12" x2="9" y2="12"/>
                        </svg>
                    </button>
                </div>
            </header>

            <!-- Main content area -->
            <main id="main-content" class="main-content">
                <!-- Wizard will render here -->
            </main>
        `;

        const mainContent = document.getElementById('main-content');
        mainContent.innerHTML = wizardPage.render();

        // Setup logout button
        this.setupLogoutButton();

        // Set up wizard completion listener (one time only)
        const handleWizardCompleted = () => {
            window.removeEventListener('wizardCompleted', handleWizardCompleted);
            // Cleanup wizard
            wizardPage.cleanup();
            // Reset and reinitialize the app with normal UI
            router.reset();
            this.initAuthenticatedApp();
        };
        window.addEventListener('wizardCompleted', handleWizardCompleted);

        // Connect WebSocket (needed for discovery events in wizard step 2)
        wsClient.connect();

        // Initialize wizard
        wizardPage.init();
    }

    showAppUI() {
        const appEl = document.getElementById('app');
        // The shell owns brand, mode switcher, sidebar/bottom-nav, connection
        // indicator, theme switcher, logout, and the #main-content slot. Pages
        // never write outside of #main-content.
        if (this.appShell) this.appShell.destroy();
        this.appShell = new AppShell();
        this.appShell.mount(appEl);
    }

    setupLogoutButton() {
        const logoutBtn = document.getElementById('logout-btn');
        if (logoutBtn) {
            logoutBtn.addEventListener('click', () => this.handleLogout());
        }
    }

    async handleLoginSuccess() {
        this.isAuthenticated = true;
        await this.initAuthenticatedApp();
    }

    async handleLogout() {
        try {
            await API.logout();
        } catch (error) {
            console.error('Logout error:', error);
        }

        // Disconnect WebSocket
        wsClient.disconnect();
        notifications.stopAlarmNotifier();
        notifications.disableWakeLock();

        // Stop the shared alarm store so the WS listener unwinds. AppShell
        // owns the AlertHost lifecycle via its own destroy().
        alarmBell.stop();

        // Tear down the AppShell so its resize + document listeners unwind.
        if (this.appShell) {
            this.appShell.destroy();
            this.appShell = null;
        }

        // Reset router
        router.reset();

        // Reset state
        this.isAuthenticated = false;

        // Show login
        this.showLogin();

        // Clear hash
        window.location.hash = '';
    }

    async loadSettings() {
        try {
            const settings = await API.getSettings();
            document.documentElement.setAttribute('data-theme', settings.theme || 'dark');
            // Prime unit + trailer prefs so every display site formats
            // correctly on first render — before any Settings-page interaction.
            const { units } = await import('./services/units.js');
            units.primeFromSettings(settings);
            const { trailerConfig } = await import('./services/trailer-config.js');
            trailerConfig.primeFromSettings(settings);
        } catch (error) {
            console.error('Failed to load settings, using defaults:', error);
            document.documentElement.setAttribute('data-theme', 'dark');
        }
    }

    registerServiceWorker() {
        if (!('serviceWorker' in navigator)) return;

        // Reload the page when a new SW takes control. This is what makes
        // iOS standalone PWAs actually pick up updates — without it the old
        // JS heap stays resident across app launches.
        let refreshing = false;
        navigator.serviceWorker.addEventListener('controllerchange', () => {
            if (refreshing) return;
            refreshing = true;
            window.location.reload();
        });

        window.addEventListener('load', async () => {
            try {
                const registration = await navigator.serviceWorker.register('/service-worker.js');
                console.log('Service Worker registered:', registration.scope);

                // If a new SW is already waiting at registration time, activate it.
                if (registration.waiting && navigator.serviceWorker.controller) {
                    registration.waiting.postMessage({ type: 'SKIP_WAITING' });
                }

                setInterval(() => registration.update(), 60000);

                registration.addEventListener('updatefound', () => {
                    const newWorker = registration.installing;
                    if (!newWorker) return;
                    newWorker.addEventListener('statechange', () => {
                        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                            // New SW installed alongside an existing controller — push it
                            // to activate now; controllerchange above will reload the page.
                            newWorker.postMessage({ type: 'SKIP_WAITING' });
                        }
                    });
                });
            } catch (error) {
                console.error('Service Worker registration failed:', error);
            }
        });
    }

    setupConnectionStatus() {
        // The sidebar's connection indicator (rendered by AppShell) is the
        // primary surface. We keep the legacy floating pill for narrow-screen
        // reconnect visibility when the sidebar isn't shown.
        const existing = document.querySelector('.connection-status');
        if (existing) existing.remove();

        // Create connection status element
        const statusEl = document.createElement('div');
        statusEl.className = 'connection-status';
        statusEl.textContent = 'Connecting...';
        document.body.appendChild(statusEl);

        wsClient.on('connection', ({ status }) => {
            // Sidebar indicator
            if (this.appShell) this.appShell.setConnectionStatus(status);
            if (status === 'connected') {
                statusEl.textContent = 'Connected';
                statusEl.classList.add('connected', 'visible');
                setTimeout(() => {
                    statusEl.classList.remove('visible');
                }, 2000);
            } else if (status === 'disconnected') {
                statusEl.textContent = 'Reconnecting...';
                statusEl.classList.remove('connected');
                statusEl.classList.add('visible');
            } else if (status === 'error') {
                statusEl.textContent = 'Connection Error';
                statusEl.classList.remove('connected');
                statusEl.classList.add('visible');
            }
        });
    }

    hideLoading() {
        const loadingEl = document.getElementById('loading-overlay');
        if (loadingEl) {
            loadingEl.classList.add('hidden');
            setTimeout(() => {
                loadingEl.remove();
            }, 300);
        }
    }
}

// Initialize app when DOM is ready
document.addEventListener('DOMContentLoaded', () => {
    const app = new App();
    app.init().catch(error => {
        console.error('App initialization failed:', error);
    });
});
