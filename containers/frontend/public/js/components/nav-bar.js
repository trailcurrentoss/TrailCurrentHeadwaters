// Navigation bar component
import { router } from '../router.js';

export class NavBar {
    constructor() {
        this.navElement = document.getElementById('bottom-nav');
        this.moreBtn = null;
        this.overflowMenu = null;
    }

    init() {
        if (!this.navElement) return;

        this.moreBtn = document.getElementById('nav-more-btn');
        this.overflowMenu = document.getElementById('nav-overflow-menu');

        // Handle main nav button clicks
        this.navElement.addEventListener('click', (e) => {
            const btn = e.target.closest('.nav-btn:not(.nav-more-btn)');
            if (!btn) return;

            const page = btn.dataset.page;
            if (page) {
                router.navigate(page);
            }
        });

        // Handle More button click
        if (this.moreBtn && this.overflowMenu) {
            this.moreBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                this.toggleOverflowMenu();
            });

            // Handle overflow menu item clicks
            this.overflowMenu.addEventListener('click', (e) => {
                const btn = e.target.closest('.nav-overflow-btn');
                if (!btn) return;

                const page = btn.dataset.page;
                if (page) {
                    router.navigate(page);
                    this.closeOverflowMenu();
                }
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!this.overflowMenu.contains(e.target) && !this.moreBtn.contains(e.target)) {
                    this.closeOverflowMenu();
                }
            });
        }
    }

    toggleOverflowMenu() {
        if (!this.overflowMenu) return;
        this.overflowMenu.classList.toggle('open');
        this.moreBtn.classList.toggle('active', this.overflowMenu.classList.contains('open'));
    }

    closeOverflowMenu() {
        if (!this.overflowMenu) return;
        this.overflowMenu.classList.remove('open');
        this.moreBtn.classList.remove('active');
    }

    updateActiveState(page) {
        // Update main nav buttons
        this.navElement.querySelectorAll('.nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === page);
        });

        // Update overflow menu buttons
        if (this.overflowMenu) {
            this.overflowMenu.querySelectorAll('.nav-overflow-btn').forEach(btn => {
                btn.classList.toggle('active', btn.dataset.page === page);
            });

            // If an overflow item is active, show indicator on More button
            const overflowPages = ['water', 'airquality', 'map', 'peregrine', 'config', 'deployments', 'playbill', 'alarms', 'settings'];
            const isOverflowActive = overflowPages.includes(page);
            // Only show More as active if menu is open or if we're on small screen with overflow page
            if (isOverflowActive && window.innerWidth <= 480) {
                this.moreBtn?.classList.add('active');
            }
        }
    }
}
