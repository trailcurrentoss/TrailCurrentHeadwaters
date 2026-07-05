// Bottom nav (narrow screens only). Primary items in the tab bar; system
// items ride inside a "More" overflow popup. Matches the v02 layout.

import { router } from '../router.js';
import { BOTTOM_NAV_PRIMARY, BOTTOM_NAV_OVERFLOW } from './nav-items.js';

const MORE_ID = 'app-bottom-more-btn';
const MENU_ID = 'app-bottom-overflow-menu';

export class BottomNav {
    constructor() {
        this.root = null;
        this._onDocClick = null;
    }

    render({ activePage }) {
        const isOverflowActive = BOTTOM_NAV_OVERFLOW.some(it => it.page === activePage);

        const tab = (it) => `
            <button class="bnav-btn ${activePage === it.page ? 'active' : ''}"
                    data-page="${it.page}" aria-label="${it.label}">
                <span class="bnav-icon">${it.svg}</span>
                <span class="bnav-label">${it.label}</span>
            </button>
        `;

        const overflowRow = (it) => `
            <button class="bnav-overflow-btn ${activePage === it.page ? 'active' : ''}"
                    data-page="${it.page}">
                <span class="bnav-icon">${it.svg}</span>
                <span>${it.label}</span>
            </button>
        `;

        return `
            ${BOTTOM_NAV_PRIMARY.map(tab).join('')}
            <div class="bnav-more">
                <button class="bnav-btn ${isOverflowActive ? 'active' : ''}"
                        id="${MORE_ID}" aria-label="More">
                    <span class="bnav-icon">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="1"></circle><circle cx="19" cy="12" r="1"></circle><circle cx="5" cy="12" r="1"></circle></svg>
                    </span>
                    <span class="bnav-label">More</span>
                </button>
                <div class="bnav-overflow-menu" id="${MENU_ID}">
                    ${BOTTOM_NAV_OVERFLOW.map(overflowRow).join('')}
                </div>
            </div>
        `;
    }

    mount(root, { activePage }) {
        this.root = root;
        root.innerHTML = this.render({ activePage });

        root.addEventListener('click', (e) => {
            const moreBtn = e.target.closest(`#${MORE_ID}`);
            if (moreBtn) {
                e.stopPropagation();
                this._toggleMenu();
                return;
            }
            const tab = e.target.closest('.bnav-btn:not(#' + MORE_ID + ')');
            if (tab) {
                const page = tab.dataset.page;
                if (page) router.navigate(page);
                this._closeMenu();
                return;
            }
            const overflowBtn = e.target.closest('.bnav-overflow-btn');
            if (overflowBtn) {
                const page = overflowBtn.dataset.page;
                if (page) router.navigate(page);
                this._closeMenu();
            }
        });

        this._onDocClick = (e) => {
            const menu = document.getElementById(MENU_ID);
            const more = document.getElementById(MORE_ID);
            if (!menu || !more) return;
            if (!menu.contains(e.target) && !more.contains(e.target)) this._closeMenu();
        };
        document.addEventListener('click', this._onDocClick);
    }

    updateActive(activePage) {
        if (!this.root) return;
        this.root.querySelectorAll('.bnav-btn[data-page]').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === activePage);
        });
        this.root.querySelectorAll('.bnav-overflow-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === activePage);
        });
        const moreBtn = document.getElementById(MORE_ID);
        if (moreBtn) {
            const isOverflow = BOTTOM_NAV_OVERFLOW.some(it => it.page === activePage);
            moreBtn.classList.toggle('active', isOverflow);
        }
    }

    _toggleMenu() {
        const menu = document.getElementById(MENU_ID);
        if (!menu) return;
        menu.classList.toggle('open');
    }

    _closeMenu() {
        const menu = document.getElementById(MENU_ID);
        if (menu) menu.classList.remove('open');
    }

    destroy() {
        if (this._onDocClick) document.removeEventListener('click', this._onDocClick);
        this._onDocClick = null;
    }
}
