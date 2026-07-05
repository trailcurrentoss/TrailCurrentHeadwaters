// Main application entry point
import { router } from './router.js';
import { API, wsClient } from './api.js';
import { NavBar } from './components/nav-bar.js';
import { homePage } from './pages/home.js';
import { trailerPage } from './pages/trailer.js';
import { energyPage } from './pages/energy.js';
import { waterPage } from './pages/water.js';
import { airqualityPage } from './pages/airquality.js';
import { settingsPage } from './pages/settings.js';
import { loginPage } from './pages/login.js';
import { mapPage } from './pages/map.js';
import { wizardPage } from './pages/wizard.js';
import { configPage } from './pages/config.js';
import { deploymentsPage } from './pages/deployments.js';
import { playbillPage } from './pages/playbill.js';
import { peregrinePage } from './pages/peregrine.js';
import { alarmsPage } from './pages/alarms.js';
import { AlarmBell } from './components/alarm-bell.js';
import * as notifications from './notifications.js';

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

        // Initialize router
        router
            .init(document.getElementById('main-content'))
            .register('home', homePage)
            .register('trailer', trailerPage)
            .register('energy', energyPage)
            .register('water', waterPage)
            .register('airquality', airqualityPage)
            .register('map', mapPage)
            .register('config', configPage)
            .register('deployments', deploymentsPage)
            .register('playbill', playbillPage)
            .register('peregrine', peregrinePage)
            .register('alarms', alarmsPage)
            .register('settings', settingsPage);

        // Initialize navigation
        const navBar = new NavBar();
        navBar.init();

        // Setup logout button
        this.setupLogoutButton();

        // Mount the alarm bell into the header right-side cluster.
        const headerRight = document.querySelector('.app-header .header-right');
        if (headerRight) {
            if (this.alarmBell) this.alarmBell.destroy();
            this.alarmBell = new AlarmBell();
            this.alarmBell.mount(headerRight);
        }

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

        // Navigate to initial page
        const initialPage = router.getPageFromHash();
        await router.navigate(initialPage);

        // Handle hash changes
        window.addEventListener('hashchange', () => {
            if (this.isAuthenticated) {
                const page = router.getPageFromHash();
                router.navigate(page);
            }
        });

    }

    showLogin() {
        const appEl = document.getElementById('app');
        appEl.innerHTML = loginPage.render();
        loginPage.init();
    }

    showWizard() {
        const appEl = document.getElementById('app');
        const user = API.getUser();
        const displayName = user?.display_name || user?.username || 'User';

        // Show full app structure with wizard page
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
        const user = API.getUser();
        const displayName = user?.display_name || user?.username || 'User';

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
                <!-- Page content will be injected here -->
            </main>

            <!-- Bottom navigation -->
            <nav class="bottom-nav" id="bottom-nav">
                <button class="nav-btn active" data-page="home">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path>
                        <polyline points="9 22 9 12 15 12 15 22"></polyline>
                    </svg>
                    <span>Home</span>
                </button>
                <button class="nav-btn" data-page="trailer">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="1" y="6" width="22" height="12" rx="2"></rect>
                        <circle cx="6" cy="18" r="2"></circle>
                        <circle cx="18" cy="18" r="2"></circle>
                        <line x1="6" y1="12" x2="18" y2="12"></line>
                    </svg>
                    <span>Vehicle</span>
                </button>
                <button class="nav-btn" data-page="energy">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon>
                    </svg>
                    <span>Energy</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="water">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>
                    </svg>
                    <span>Water</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="airquality">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path>
                    </svg>
                    <span>Air</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="map">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                        <circle cx="12" cy="10" r="3"></circle>
                    </svg>
                    <span>Map</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="peregrine">
                    <svg class="nav-icon" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M200 100 C230 80 280 80 310 100 C350 120 370 160 370 200 C370 220 365 235 355 245 L340 270 L340 300 C320 320 300 340 280 380 C260 420 240 440 220 450 C200 460 180 440 170 420 C160 400 160 360 170 320 C150 320 130 310 120 290 C110 270 110 240 120 210 C130 170 160 130 200 100Z"></path>
                        <path d="M355 200 C380 200 410 215 420 235 C425 245 415 255 400 250"></path>
                        <circle cx="280" cy="175" r="10" fill="currentColor" stroke="none"></circle>
                    </svg>
                    <span>Peregrine</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="playbill">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <rect x="2" y="6" width="20" height="13" rx="2"></rect>
                        <line x1="8" y1="22" x2="16" y2="22"></line>
                        <line x1="12" y1="19" x2="12" y2="22"></line>
                        <path d="M7 3l5 3 5-3"></path>
                    </svg>
                    <span>Playbill</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="config">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="4" y1="21" x2="4" y2="14"></line>
                        <line x1="4" y1="10" x2="4" y2="3"></line>
                        <line x1="12" y1="21" x2="12" y2="12"></line>
                        <line x1="12" y1="8" x2="12" y2="3"></line>
                        <line x1="20" y1="21" x2="20" y2="16"></line>
                        <line x1="20" y1="12" x2="20" y2="3"></line>
                        <line x1="1" y1="14" x2="7" y2="14"></line>
                        <line x1="9" y1="8" x2="15" y2="8"></line>
                        <line x1="17" y1="16" x2="23" y2="16"></line>
                    </svg>
                    <span>Config</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="deployments">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                        <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                        <line x1="12" y1="22.08" x2="12" y2="12"></line>
                    </svg>
                    <span>Deploy</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="alarms">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                    </svg>
                    <span>Alarms</span>
                </button>
                <button class="nav-btn nav-overflow-item" data-page="settings">
                    <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"></circle>
                        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                    </svg>
                    <span>Settings</span>
                </button>
                <!-- More button for overflow items on small screens -->
                <div class="nav-more-container">
                    <button class="nav-btn nav-more-btn" id="nav-more-btn">
                        <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <circle cx="12" cy="12" r="1"></circle>
                            <circle cx="19" cy="12" r="1"></circle>
                            <circle cx="5" cy="12" r="1"></circle>
                        </svg>
                        <span>More</span>
                    </button>
                    <div class="nav-overflow-menu" id="nav-overflow-menu">
                        <button class="nav-overflow-btn" data-page="water">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>
                            </svg>
                            <span>Water</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="airquality">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path>
                            </svg>
                            <span>Air</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="map">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path>
                                <circle cx="12" cy="10" r="3"></circle>
                            </svg>
                            <span>Map</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="peregrine">
                            <svg class="nav-icon" viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M200 100 C230 80 280 80 310 100 C350 120 370 160 370 200 C370 220 365 235 355 245 L340 270 L340 300 C320 320 300 340 280 380 C260 420 240 440 220 450 C200 460 180 440 170 420 C160 400 160 360 170 320 C150 320 130 310 120 290 C110 270 110 240 120 210 C130 170 160 130 200 100Z"></path>
                                <path d="M355 200 C380 200 410 215 420 235 C425 245 415 255 400 250"></path>
                                <circle cx="280" cy="175" r="10" fill="currentColor" stroke="none"></circle>
                            </svg>
                            <span>Peregrine</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="playbill">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="2" y="6" width="20" height="13" rx="2"></rect>
                                <line x1="8" y1="22" x2="16" y2="22"></line>
                                <line x1="12" y1="19" x2="12" y2="22"></line>
                                <path d="M7 3l5 3 5-3"></path>
                            </svg>
                            <span>Playbill</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="config">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <line x1="4" y1="21" x2="4" y2="14"></line>
                                <line x1="4" y1="10" x2="4" y2="3"></line>
                                <line x1="12" y1="21" x2="12" y2="12"></line>
                                <line x1="12" y1="8" x2="12" y2="3"></line>
                                <line x1="20" y1="21" x2="20" y2="16"></line>
                                <line x1="20" y1="12" x2="20" y2="3"></line>
                                <line x1="1" y1="14" x2="7" y2="14"></line>
                                <line x1="9" y1="8" x2="15" y2="8"></line>
                                <line x1="17" y1="16" x2="23" y2="16"></line>
                            </svg>
                            <span>Config</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="deployments">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"></path>
                                <polyline points="3.27 6.96 12 12.01 20.73 6.96"></polyline>
                                <line x1="12" y1="22.08" x2="12" y2="12"></line>
                            </svg>
                            <span>Deploy</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="alarms">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
                                <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
                                <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
                            </svg>
                            <span>Alarms</span>
                        </button>
                        <button class="nav-overflow-btn" data-page="settings">
                            <svg class="nav-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <circle cx="12" cy="12" r="3"></circle>
                                <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path>
                            </svg>
                            <span>Settings</span>
                        </button>
                    </div>
                </div>
            </nav>
        `;
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

        // Tear down the alarm bell so it doesn't double-mount on next login.
        if (this.alarmBell) {
            this.alarmBell.destroy();
            this.alarmBell = null;
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
        // Remove existing status element if any
        const existing = document.querySelector('.connection-status');
        if (existing) existing.remove();

        // Create connection status element
        const statusEl = document.createElement('div');
        statusEl.className = 'connection-status';
        statusEl.textContent = 'Connecting...';
        document.body.appendChild(statusEl);

        wsClient.on('connection', ({ status }) => {
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
