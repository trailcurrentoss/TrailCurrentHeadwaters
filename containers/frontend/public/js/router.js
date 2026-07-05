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

    async navigate(pageName) {
        if (!this.contentElement) {
            console.error('Router not initialized - contentElement is null');
            return;
        }

        if (!this.routes.has(pageName)) {
            console.error(`Page not found: ${pageName}`);
            return;
        }

        // Cleanup current page
        if (this.currentPage && this.currentPage.cleanup) {
            this.currentPage.cleanup();
        }

        const pageModule = this.routes.get(pageName);

        // Apply transition
        this.contentElement.classList.add('page-enter');

        // Render new page
        this.contentElement.innerHTML = pageModule.render();

        // Initialize page
        if (pageModule.init) {
            await pageModule.init();
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

        // Update navigation state
        this.updateNav(pageName);

        // Update URL hash
        window.location.hash = pageName;

        // Notify subscribers (AppShell listens for this)
        this._navListeners.forEach(fn => {
            try { fn(pageName); } catch (err) { console.error('nav listener error:', err); }
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
            const overflowPages = ['water', 'airquality', 'map', 'peregrine', 'playbill', 'config', 'deployments', 'settings'];
            const isOverflowActive = overflowPages.includes(activePage);
            // Show More as active if overflow page is active and we're on small screen
            moreBtn.classList.toggle('active', isOverflowActive && window.innerWidth <= 480);
        }
    }

    getPageFromHash() {
        const hash = window.location.hash.slice(1);
        return this.routes.has(hash) ? hash : 'home';
    }
}

export const router = new Router();
