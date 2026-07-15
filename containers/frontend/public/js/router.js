// Simple SPA router
class Router {
    constructor() {
        this.routes = new Map();
        this.currentPage = null;
        this.contentElement = null;
        this._navListeners = new Set();
    }

    init(contentElement) {
        this.contentElement = contentElement;
        return this;
    }

    reset() {
        this.contentElement = null;
        this.currentPage = null;
    }

    // Subscribe to navigation events. Fires with the target page name after
    // the new page has rendered and the URL hash is updated. Used by
    // AppShell to keep sidebar / bottom-nav active state in sync.
    onNavigate(fn) {
        this._navListeners.add(fn);
        return () => this._navListeners.delete(fn);
    }

    register(name, pageModule) {
        this.routes.set(name, pageModule);
        return this;
    }

    // Legacy hash redirects — when a page has been consolidated into
    // Settings, keep old bookmarks working by mapping the top-level hash
    // to the new #settings/<group> deep link. Matched on the FIRST path
    // segment only (so `#config` and `#config/whatever` both redirect).
    LEGACY_REDIRECTS = {
        config: 'settings/network',
        deployments: 'settings/deploy',
        maps: 'settings/maps',
        alarms: 'settings/alarms',
    };

    async navigate(fullPath) {
        if (!this.contentElement) {
            console.error('Router not initialized - contentElement is null');
            return;
        }

        // Split "settings/general" → route="settings", subPath="general".
        // The route name is always the first segment; anything after the
        // first slash is a sub-path passed to the page module.
        let route = fullPath;
        let subPath = '';
        const slashIdx = fullPath.indexOf('/');
        if (slashIdx >= 0) {
            route = fullPath.slice(0, slashIdx);
            subPath = fullPath.slice(slashIdx + 1);
        }

        // Redirect legacy top-level pages that have been consolidated
        // into Settings. Rewrites the URL and re-enters navigate() so
        // hashchange listeners see the canonical destination.
        if (this.LEGACY_REDIRECTS[route]) {
            return this.navigate(this.LEGACY_REDIRECTS[route]);
        }

        if (!this.routes.has(route)) {
            console.error(`Page not found: ${route}`);
            return;
        }

        // Cleanup current page
        if (this.currentPage && this.currentPage.cleanup) {
            this.currentPage.cleanup();
        }

        const pageModule = this.routes.get(route);

        // Apply transition
        this.contentElement.classList.add('page-enter');

        // Render new page. Pass subPath so pages with internal sub-routes
        // (Settings) can render the correct sub-screen on first paint.
        this.contentElement.innerHTML = pageModule.render(subPath);

        // Initialize page
        if (pageModule.init) {
            await pageModule.init(subPath);
        }

        // Store current page reference
        this.currentPage = pageModule;

        // Trigger transition animation
        requestAnimationFrame(() => {
            this.contentElement.classList.remove('page-enter');
            this.contentElement.classList.add('page-enter-active');

            setTimeout(() => {
                this.contentElement.classList.remove('page-enter-active');
            }, 200);
        });

        // Update navigation state (nav highlights the top-level route,
        // not sub-paths — Settings stays selected across all its groups).
        this.updateNav(route);

        // Update URL hash. Preserve the full path so deep links round-trip.
        window.location.hash = fullPath;

        // Notify subscribers (AppShell listens for this)
        this._navListeners.forEach(fn => {
            try { fn(route); } catch (err) { console.error('nav listener error:', err); }
        });
    }

    updateNav(activePage) {
        // Update main nav buttons (exclude More button)
        const navButtons = document.querySelectorAll('.nav-btn:not(.nav-more-btn)');
        navButtons.forEach(btn => {
            const page = btn.dataset.page;
            btn.classList.toggle('active', page === activePage);
        });

        // Update overflow menu buttons
        const overflowButtons = document.querySelectorAll('.nav-overflow-btn');
        overflowButtons.forEach(btn => {
            const page = btn.dataset.page;
            btn.classList.toggle('active', page === activePage);
        });

        // Update More button active state when an overflow page is active on small screens
        const moreBtn = document.getElementById('nav-more-btn');
        if (moreBtn) {
            const overflowPages = ['water', 'airquality', 'map', 'peregrine', 'playbill', 'settings'];
            const isOverflowActive = overflowPages.includes(activePage);
            // Show More as active if overflow page is active and we're on small screen
            moreBtn.classList.toggle('active', isOverflowActive && window.innerWidth <= 480);
        }
    }

    getPageFromHash() {
        const hash = window.location.hash.slice(1);
        if (!hash) return 'home';
        // Route lookup uses only the first segment; sub-paths are preserved
        // in the returned string so navigate() sees the full deep link.
        const slashIdx = hash.indexOf('/');
        const route = slashIdx >= 0 ? hash.slice(0, slashIdx) : hash;
        if (this.LEGACY_REDIRECTS[route]) return hash;   // let navigate() resolve
        return this.routes.has(route) ? hash : 'home';
    }
}

export const router = new Router();
