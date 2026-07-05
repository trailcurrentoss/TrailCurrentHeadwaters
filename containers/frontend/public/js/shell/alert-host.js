// AlertHost — renders active alarms in three v02 surfaces:
//
//   * banner       — top of #main-content (wide screens)
//   * pill         — fixed capsule at top of viewport (narrow screens)
//   * sidebarBell  — icon + badge in sidebar footer (always accurate)
//
// State source: shared AlarmBell singleton. AlertHost subscribes to its
// `change` events and re-renders. Each mount is a separate call to
// `mountInto(slotEl, variant)`; there are 3 total (banner + pill + bell).
//
// Dismiss semantics: the banner and pill are dismissible together via the X
// button on either. Dismissal is UI-only (in-memory dismissedIds set); the
// underlying alarms remain active and the sidebar bell count stays accurate.
// A new alarm whose id is not in dismissedIds re-shows the banner + pill.

import { router } from '../router.js';

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

const BELL_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path><path d="M13.73 21a2 2 0 0 1-3.46 0"></path></svg>`;
const X_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><line x1="18" y1="6" x2="6" y2="18"></line><line x1="6" y1="6" x2="18" y2="18"></line></svg>`;

export class AlertHost {
    constructor(alarmBell) {
        this.store = alarmBell;
        this.dismissedIds = new Set();
        this._mounts = []; // { el, variant }
        this._onChange = (e) => this._render();
        this.store.addEventListener('change', this._onChange);
    }

    mountInto(slotEl, variant) {
        if (!slotEl) return;
        this._mounts.push({ el: slotEl, variant });
        this._renderOne(slotEl, variant);
        this._wire(slotEl, variant);
    }

    destroy() {
        this.store.removeEventListener('change', this._onChange);
        for (const m of this._mounts) {
            if (m.el) m.el.innerHTML = '';
        }
        this._mounts = [];
        this.dismissedIds.clear();
    }

    _visibleAlarms() {
        return this.store.getActive().filter(a => !this.dismissedIds.has(a.id));
    }

    _render() {
        for (const m of this._mounts) this._renderOne(m.el, m.variant);
    }

    _renderOne(el, variant) {
        const active = this.store.getActive();
        const visible = this._visibleAlarms();

        if (variant === 'sidebarBell') {
            el.innerHTML = this._renderSidebarBell(active);
            return;
        }

        // banner + pill share the same visibility rule (dismissible).
        if (visible.length === 0) {
            el.innerHTML = '';
            return;
        }
        if (variant === 'banner') {
            el.innerHTML = this._renderBanner(visible);
        } else if (variant === 'pill') {
            el.innerHTML = this._renderPill(visible);
        }
    }

    _renderSidebarBell(active) {
        const count = active.length;
        const has = count > 0;
        const label = has ? `${count} active alarm${count === 1 ? '' : 's'}` : 'No active alarms';
        return `
            <button type="button"
                    class="alert-bell ${has ? 'alert-bell-active' : 'alert-bell-empty'}"
                    aria-label="${escapeHtml(label)}"
                    data-alert-action="goto-alarms">
                ${BELL_SVG}
                <span class="alert-bell-badge" ${has ? '' : 'hidden'}>${count > 99 ? '99+' : count}</span>
            </button>
        `;
    }

    _renderBanner(visible) {
        const first = visible[0];
        const rest = visible.length - 1;
        return `
            <div class="alert-banner" role="alert">
                <span class="alert-icon">${BELL_SVG}</span>
                <span class="alert-title">${visible.length > 1 ? 'Alarms' : 'Alarm'}</span>
                <span class="alert-text">${escapeHtml(first.label || '(unnamed)')}</span>
                ${rest > 0 ? `<span class="alert-more">+${rest} more</span>` : ''}
                <span class="alert-spacer"></span>
                <button type="button" class="alert-view" data-alert-action="goto-alarms">View</button>
                <button type="button" class="alert-dismiss" data-alert-action="dismiss" aria-label="Dismiss all">${X_SVG}</button>
                ${visible.length > 1 ? this._renderBannerRows(visible) : ''}
            </div>
        `;
    }

    _renderBannerRows(visible) {
        const rows = visible.map(a => `
            <div class="alert-row">
                <span class="alert-row-dot"></span>
                <span class="alert-row-text">${escapeHtml(a.label || '(unnamed)')}</span>
            </div>
        `).join('');
        return `<div class="alert-rows">${rows}</div>`;
    }

    _renderPill(visible) {
        const first = visible[0];
        const rest = visible.length - 1;
        const text = rest > 0
            ? `${first.label || '(unnamed)'} · +${rest} more`
            : (first.label || '(unnamed)');
        return `
            <div class="alert-pill" role="alert" data-alert-action="goto-alarms">
                <span class="alert-pill-dot"></span>
                <span class="alert-pill-text">${escapeHtml(text)}</span>
                <button type="button" class="alert-pill-dismiss" data-alert-action="dismiss" aria-label="Dismiss all">${X_SVG}</button>
            </div>
        `;
    }

    _wire(slotEl, variant) {
        slotEl.addEventListener('click', (e) => {
            const el = e.target.closest('[data-alert-action]');
            if (!el) return;
            const action = el.dataset.alertAction;
            if (action === 'dismiss') {
                e.stopPropagation();
                for (const a of this.store.getActive()) this.dismissedIds.add(a.id);
                this._render();
            } else if (action === 'goto-alarms') {
                router.navigate('alarms');
            }
        });
    }
}
