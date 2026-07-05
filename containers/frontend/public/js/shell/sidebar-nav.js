// Sidebar nav — wide (labeled) and collapsed (icons only).
//
// Renders once on mount; a `layout` attribute on the root element toggles
// between `wide` (≥1240 px) and `collapsed` (920–1239 px). AppShell owns
// the breakpoint listener and sets the attribute; SidebarNav only reacts
// to clicks + active-page updates.

import { router } from '../router.js';
import { PRIMARY_ITEMS, SYSTEM_ITEMS } from './nav-items.js';

export class SidebarNav {
    constructor() {
        this.root = null;
    }

    render({ activePage }) {
        const item = (it) => `
            <button class="sidebar-nav-btn ${activePage === it.page ? 'active' : ''}"
                    data-page="${it.page}" title="${it.label}" aria-label="${it.label}">
                <span class="sidebar-nav-icon">${it.svg}</span>
                <span class="sidebar-nav-label">${it.label}</span>
            </button>
        `;

        return `
            <nav class="sidebar-nav-list">
                <div class="sidebar-nav-section">
                    ${PRIMARY_ITEMS.map(item).join('')}
                </div>
                <div class="sidebar-nav-divider"></div>
                <span class="sidebar-nav-section-label">System</span>
                <div class="sidebar-nav-section">
                    ${SYSTEM_ITEMS.map(item).join('')}
                </div>
            </nav>
        `;
    }

    mount(root, { activePage }) {
        this.root = root;
        root.innerHTML = this.render({ activePage });

        root.addEventListener('click', (e) => {
            const btn = e.target.closest('.sidebar-nav-btn');
            if (!btn) return;
            const page = btn.dataset.page;
            if (page) router.navigate(page);
        });
    }

    updateActive(activePage) {
        if (!this.root) return;
        this.root.querySelectorAll('.sidebar-nav-btn').forEach(btn => {
            btn.classList.toggle('active', btn.dataset.page === activePage);
        });
    }
}
