// Alarm bell — header indicator + popout listing currently active sensors.
// Always visible; dimmed when count = 0, accent-coloured with badge when active.
// State source: GET /api/alarms/active on mount, then WS `alarms_update` events.
import { API, wsClient } from '../api.js';

const BELL_ICON_SVG = `
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
         stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"></path>
        <path d="M13.73 21a2 2 0 0 1-3.46 0"></path>
    </svg>
`;

function escapeHtml(s) {
    return String(s)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

export class AlarmBell {
    constructor() {
        this.active = [];
        this.popoverOpen = false;
        this.wrapperEl = null;
        this.buttonEl = null;
        this.badgeEl = null;
        this.popoverEl = null;
        this.docClickListener = null;
        this.wsListener = null;
    }

    mount(parentEl) {
        if (!parentEl) return;
        // Remove any previous instance so re-mounts (after login) don't stack.
        const existing = parentEl.querySelector('.alarm-bell-wrapper');
        if (existing) existing.remove();

        const wrapper = document.createElement('div');
        wrapper.className = 'alarm-bell-wrapper';
        wrapper.innerHTML = `
            <button class="alarm-bell-btn alarm-bell-empty" type="button"
                    aria-label="Active alarms" aria-haspopup="true" aria-expanded="false">
                ${BELL_ICON_SVG}
                <span class="alarm-bell-badge" hidden>0</span>
            </button>
            <div class="alarm-bell-popover" role="dialog" aria-label="Active alarms" hidden>
                <div class="alarm-bell-popover-header">Active Alarms</div>
                <div class="alarm-bell-popover-body">
                    <p class="alarm-bell-empty-msg">No active alarms.</p>
                </div>
            </div>
        `;
        // Place the bell to the LEFT of the logout button so the logout
        // affordance stays in its expected spot.
        const logoutBtn = parentEl.querySelector('.logout-btn');
        if (logoutBtn) parentEl.insertBefore(wrapper, logoutBtn);
        else parentEl.appendChild(wrapper);

        this.wrapperEl = wrapper;
        this.buttonEl = wrapper.querySelector('.alarm-bell-btn');
        this.badgeEl = wrapper.querySelector('.alarm-bell-badge');
        this.popoverEl = wrapper.querySelector('.alarm-bell-popover');

        this.buttonEl.addEventListener('click', (e) => {
            e.stopPropagation();
            this.togglePopover();
        });

        this.docClickListener = (e) => {
            if (!this.popoverOpen) return;
            if (this.wrapperEl.contains(e.target)) return;
            this.closePopover();
        };
        document.addEventListener('click', this.docClickListener);

        this.wsListener = (data) => this.update(data && data.active);
        wsClient.on('alarms_update', this.wsListener);

        // Fetch initial snapshot — WS events take over from there.
        API.getActiveAlarms()
            .then(snap => this.update(snap && snap.active))
            .catch(err => console.error('[AlarmBell] Failed to load active alarms:', err));
    }

    update(activeList) {
        this.active = Array.isArray(activeList) ? activeList : [];
        const count = this.active.length;
        if (!this.buttonEl || !this.badgeEl) return;
        if (count > 0) {
            this.buttonEl.classList.remove('alarm-bell-empty');
            this.buttonEl.classList.add('alarm-bell-active');
            this.badgeEl.textContent = count > 99 ? '99+' : String(count);
            this.badgeEl.hidden = false;
        } else {
            this.buttonEl.classList.add('alarm-bell-empty');
            this.buttonEl.classList.remove('alarm-bell-active');
            this.badgeEl.hidden = true;
        }
        if (this.popoverOpen) this.renderPopoverBody();
    }

    renderPopoverBody() {
        if (!this.popoverEl) return;
        const body = this.popoverEl.querySelector('.alarm-bell-popover-body');
        if (!body) return;
        if (this.active.length === 0) {
            body.innerHTML = '<p class="alarm-bell-empty-msg">No active alarms.</p>';
            return;
        }
        const items = this.active.map(a =>
            `<li class="alarm-bell-item">
                <span class="alarm-bell-item-dot"></span>
                <span class="alarm-bell-item-label">${escapeHtml(a.label || '')}</span>
            </li>`
        ).join('');
        body.innerHTML = `<ul class="alarm-bell-list">${items}</ul>`;
    }

    togglePopover() {
        if (this.popoverOpen) this.closePopover();
        else this.openPopover();
    }

    openPopover() {
        if (!this.popoverEl) return;
        this.renderPopoverBody();
        this.popoverEl.hidden = false;
        this.popoverOpen = true;
        this.buttonEl.setAttribute('aria-expanded', 'true');
    }

    closePopover() {
        if (!this.popoverEl) return;
        this.popoverEl.hidden = true;
        this.popoverOpen = false;
        this.buttonEl.setAttribute('aria-expanded', 'false');
    }

    destroy() {
        if (this.docClickListener) {
            document.removeEventListener('click', this.docClickListener);
            this.docClickListener = null;
        }
        if (this.wsListener) {
            wsClient.off('alarms_update', this.wsListener);
            this.wsListener = null;
        }
        if (this.wrapperEl) {
            this.wrapperEl.remove();
            this.wrapperEl = null;
        }
        this.buttonEl = null;
        this.badgeEl = null;
        this.popoverEl = null;
    }
}
