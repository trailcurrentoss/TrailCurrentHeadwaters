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

class App {
    constructor() {
        this.isAuthenticated = false;
    }

    async init() {
        try {
            // Register service worker
            this.registerServiceWorker();

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
            .register('settings', settingsPage);

        // Initialize navigation
        const navBar = new NavBar();
        navBar.init();

        // Setup logout button
        this.setupLogoutButton();

        // Connect WebSocket
        wsClient.connect();
        this.setupConnectionStatus();

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
                    <img src="/icons/logo-white.svg" alt="TrailCurrent" class="app-logo app-logo-dark">
                    <img src="/icons/logo-color.svg" alt="TrailCurrent" class="app-logo app-logo-light">
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
                    <img src="/icons/logo-white.svg" alt="TrailCurrent" class="app-logo app-logo-dark">
                    <img src="/icons/logo-color.svg" alt="TrailCurrent" class="app-logo app-logo-light">
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
                    <span>Trailer</span>
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
        if ('serviceWorker' in navigator) {
            window.addEventListener('load', async () => {
                try {
                    // Add cache-busting parameter with version from manifest to force fresh service worker
                    const response = await fetch('/manifest.json');
                    const manifest = await response.json();
                    const version = manifest.version || 'unknown';
                    const registration = await navigator.serviceWorker.register(`/service-worker.js?v=${version}`);
                    console.log('Service Worker registered:', registration.scope);

                    // Check for updates periodically
                    setInterval(() => {
                        registration.update();
                    }, 60000); // Check every minute

                    // Check for updates
                    registration.addEventListener('updatefound', () => {
                        const newWorker = registration.installing;
                        newWorker.addEventListener('statechange', () => {
                            if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
                                // New content available, show update notification
                                console.log('New content available, please refresh.');
                            }
                        });
                    });
                } catch (error) {
                    console.error('Service Worker registration failed:', error);
                }
            });
        }
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
