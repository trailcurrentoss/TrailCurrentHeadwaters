// Consolidated Settings page — iOS/Android-style grouped Settings shell.
//
// Owns:
//   - the master-detail (wide) / stacked (narrow) layout
//   - deep-linked sub-routing via #settings/<group>[#anchor]
//   - the search bar + flat search index over every setting
//   - the "back" navigation between landing and a group
//
// Group modules under ./groups/ own their own rendered content, event
// wiring, and cleanup. Their behavior is preserved verbatim from the
// pre-consolidation pages — this shell only re-hosts them.

import { router } from '../../router.js';
import { generalGroup } from './groups/general.js';
import { vehicleGroup } from './groups/vehicle.js';
import { alarmsGroup } from './groups/alarms.js';
import { networkGroup } from './groups/network.js';
import { mapsGroup } from './groups/maps.js';
import { voiceGroup } from './groups/voice.js';
import { camerasGroup } from './groups/cameras.js';
import { deployGroup } from './groups/deploy.js';
import { cloudGroup } from './groups/cloud.js';
import { systemGroup } from './groups/system.js';
import { securityGroup } from './groups/security.js';
import { aboutGroup } from './groups/about.js';

// Group order = display order on landing / rail.
const GROUPS = [
    generalGroup,
    vehicleGroup,
    alarmsGroup,
    networkGroup,
    mapsGroup,
    voiceGroup,
    camerasGroup,
    deployGroup,
    cloudGroup,
    systemGroup,
    securityGroup,
    aboutGroup,
];
const GROUP_BY_ID = Object.fromEntries(GROUPS.map(g => [g.meta.id, g]));

// Flat search index, aggregated from each group.
const SEARCH_INDEX = GROUPS.flatMap(g =>
    (g.searchIndex || []).map(item => ({ ...item, group: g }))
);

// Breakpoint from the design mock — 1120 px matches "app sidebar + rail
// + detail" comfortably. Below that we stack.
const WIDE_MIN_WIDTH = 1120;

function isWide() {
    return window.matchMedia(`(min-width: ${WIDE_MIN_WIDTH}px)`).matches;
}

function ion(name, opts = {}) {
    const size = opts.size || 18;
    const color = opts.color ? `color:${opts.color};` : '';
    const extra = opts.style ? opts.style : '';
    return `<ion-icon name="${name}" aria-hidden="true" style="font-size:${size}px;${color}flex:0 0 auto;${extra}"></ion-icon>`;
}

// --- module-scoped state ---
let activeGroup = null;         // reference to a group module currently mounted
let activeGroupId = null;
let searchQuery = '';
let resizeHandler = null;
let wide = false;

function currentLayout() { return wide ? 'wide' : 'narrow'; }

// Parse "general#dark-mode" into { id, anchor }.
function parseSubPath(subPath) {
    if (!subPath) return { id: null, anchor: null };
    const hashIdx = subPath.indexOf('#');
    if (hashIdx < 0) return { id: subPath, anchor: null };
    return { id: subPath.slice(0, hashIdx), anchor: subPath.slice(hashIdx + 1) };
}

// --- shell HTML builders ---

function searchBoxHtml() {
    const val = escapeAttr(searchQuery);
    const clearBtn = searchQuery
        ? `<button class="settings-v2-search-clear" id="settings-v2-search-clear" aria-label="Clear search">${ion('close-circle', { size: 17 })}</button>`
        : '';
    return `
        <div class="settings-v2-search">
            <span class="settings-v2-search-icon">${ion('search-outline', { size: 17 })}</span>
            <input type="search" id="settings-v2-search-input" placeholder="Search settings"
                   autocomplete="off" value="${val}">
            ${clearBtn}
        </div>
    `;
}

function groupItemHtml(g, opts = {}) {
    const active = opts.active ? ' active' : '';
    const flat = opts.flat ? ' flat' : '';
    return `
        <button class="settings-v2-gitem${active}${flat}" data-group="${g.meta.id}" type="button">
            <span class="settings-v2-gitem-icon">${ion(g.meta.icon, { size: 19 })}</span>
            <span class="settings-v2-gitem-body">
                <span class="settings-v2-gitem-title">${escapeHtml(g.meta.title)}</span>
                <span class="settings-v2-gitem-sub">${escapeHtml(g.meta.sub || '')}</span>
            </span>
            <span class="settings-v2-gitem-chevron">${ion('chevron-forward', { size: 15 })}</span>
        </button>
    `;
}

function searchResultsHtml() {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return '';
    const results = SEARCH_INDEX.filter(item => {
        return item.label.toLowerCase().includes(q)
            || (item.kw || '').toLowerCase().includes(q)
            || item.group.meta.title.toLowerCase().includes(q);
    });
    if (!results.length) {
        return `<div class="settings-v2-empty-search">No settings match "${escapeHtml(searchQuery.trim())}".</div>`;
    }
    return results.map((it, i) => `
        <button class="settings-v2-gitem" data-group="${it.group.meta.id}"
                data-anchor="${escapeAttr(it.anchor || '')}" type="button">
            <span class="settings-v2-gitem-icon" style="width:32px;height:32px;border-radius:8px;">
                ${ion(it.group.meta.icon, { size: 17 })}
            </span>
            <span class="settings-v2-gitem-body">
                <span class="settings-v2-gitem-title">${escapeHtml(it.label)}</span>
                <span class="settings-v2-gitem-sub">${escapeHtml(it.group.meta.title)}</span>
            </span>
            <span class="settings-v2-gitem-chevron">${ion('chevron-forward', { size: 15 })}</span>
        </button>
    `).join('');
}

function renderWideShell() {
    const groupsHtml = searchQuery.trim()
        ? searchResultsHtml()
        : GROUPS.map(g => groupItemHtml(g, { active: g.meta.id === activeGroupId })).join('');
    const g = activeGroupId ? GROUP_BY_ID[activeGroupId] : GROUP_BY_ID.general;
    return `
        <div class="settings-v2" id="settings-v2">
            <aside class="settings-v2-rail">
                <div class="settings-v2-rail-header">
                    <h1 class="settings-v2-rail-title">Settings</h1>
                    ${searchBoxHtml()}
                </div>
                <div class="settings-v2-rail-list" id="settings-v2-rail-list">
                    ${groupsHtml}
                </div>
            </aside>
            <section class="settings-v2-detail">
                <div class="settings-v2-detail-inner">
                    <header class="settings-v2-detail-header">
                        <div class="settings-v2-detail-eyebrow">Settings</div>
                        <h2 class="settings-v2-detail-title" id="settings-v2-detail-title">
                            ${escapeHtml(g.meta.title)}
                        </h2>
                        ${g.meta.sub ? `<div class="settings-v2-detail-sub">${escapeHtml(g.meta.sub)}</div>` : ''}
                    </header>
                    <div class="settings-v2-detail-body" id="settings-v2-group-mount"></div>
                </div>
            </section>
        </div>
    `;
}

function renderNarrowShell() {
    const inDetail = !!activeGroupId && !searchQuery.trim();
    const g = activeGroupId ? GROUP_BY_ID[activeGroupId] : null;
    let bodyHtml;
    if (inDetail) {
        bodyHtml = `
            <div class="settings-v2-narrow-body in-detail">
                <div id="settings-v2-group-mount"></div>
            </div>
        `;
    } else {
        const inner = searchQuery.trim()
            ? `<div class="settings-v2-narrow-list-results">${searchResultsHtml()}</div>`
            : GROUPS.map(g => groupItemHtml(g, { flat: true })).join('');
        bodyHtml = `
            <div class="settings-v2-narrow-body">
                ${searchBoxHtml()}
                <div class="settings-v2-narrow-list">${inner}</div>
            </div>
        `;
    }
    const topBar = `
        <div class="settings-v2-topbar">
            ${inDetail
                ? `<button class="settings-v2-back" id="settings-v2-back">
                       ${ion('chevron-back', { size: 20, color: 'var(--primary)' })}
                       <span>Settings</span>
                   </button>`
                : ''}
            <div class="settings-v2-topbar-title">
                ${inDetail ? escapeHtml(g.meta.title) : 'Settings'}
            </div>
        </div>
    `;
    return `
        <div class="settings-v2 narrow" id="settings-v2">
            ${topBar}
            ${bodyHtml}
        </div>
    `;
}

function renderShell() {
    return wide ? renderWideShell() : renderNarrowShell();
}

// --- runtime plumbing ---

function wireShellListeners() {
    const root = document.getElementById('settings-v2');
    if (!root) return;

    // Delegated click for all group rows + search results.
    root.addEventListener('click', (e) => {
        const gitem = e.target.closest('.settings-v2-gitem');
        if (gitem) {
            const groupId = gitem.dataset.group;
            const anchor = gitem.dataset.anchor || null;
            openGroup(groupId, { anchor });
            return;
        }
        if (e.target.closest('#settings-v2-back')) {
            openLanding();
            return;
        }
        if (e.target.closest('#settings-v2-search-clear')) {
            setSearchQuery('');
            return;
        }
    });

    // Search input.
    const input = document.getElementById('settings-v2-search-input');
    if (input) {
        input.addEventListener('input', (e) => setSearchQuery(e.target.value));
        // Keep focus after a re-render if the user was mid-type.
        if (searchQuery && document.activeElement !== input) {
            input.focus();
            input.setSelectionRange(searchQuery.length, searchQuery.length);
        }
    }
}

async function mountActiveGroupContent(anchor) {
    const mount = document.getElementById('settings-v2-group-mount');
    if (!mount) return;
    if (!activeGroupId) {
        mount.innerHTML = '';
        return;
    }
    const g = GROUP_BY_ID[activeGroupId];
    if (!g) return;

    // Tear down any previously-mounted group before swapping in the new one.
    // The scenarios that matter here: (1) wide-mode rail click switching
    // groups, (2) narrow-mode navigating between groups. Cleanup releases
    // WS listeners, aborts uploads, clears intervals, etc.
    if (activeGroup && activeGroup !== g && activeGroup.cleanup) {
        try { activeGroup.cleanup(); } catch (err) { console.error('Group cleanup error:', err); }
    }

    mount.innerHTML = g.render();
    activeGroup = g;
    try {
        if (g.init) await g.init();
    } catch (err) {
        console.error(`Group ${activeGroupId} init error:`, err);
    }
    if (anchor) scrollToAnchor(anchor);
}

function scrollToAnchor(anchor) {
    // Anchors can be either an element id or a data-anchor attribute.
    // Try id first, then data-anchor scoped to the group mount.
    const mount = document.getElementById('settings-v2-group-mount');
    if (!mount) return;
    let el = document.getElementById(anchor);
    if (!el) el = mount.querySelector(`[data-anchor="${cssEscape(anchor)}"]`);
    if (!el) return;
    requestAnimationFrame(() => {
        el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        // Flash the nearest card ancestor if any, else the element itself.
        const target = el.closest('.card, .settings-v2-card, .settings-v2-row') || el;
        target.classList.add('settings-v2-flash');
        setTimeout(() => target.classList.remove('settings-v2-flash'), 1900);
    });
}

// --- public navigation actions ---

async function openGroup(groupId, opts = {}) {
    if (!GROUP_BY_ID[groupId]) {
        console.warn(`Unknown settings group: ${groupId}`);
        return;
    }
    const wasActive = activeGroupId === groupId;
    activeGroupId = groupId;
    searchQuery = '';   // search closes when jumping to a group

    // Update URL WITHOUT retriggering the router: pushState leaves the hash
    // change silent so we can swap DOM in-place. The next router-driven
    // navigation (hashchange from browser back) will call this module's
    // init() again with the target sub-path.
    const newHash = opts.anchor
        ? `#settings/${groupId}#${opts.anchor}`
        : `#settings/${groupId}`;
    if (window.location.hash !== newHash) {
        history.pushState({ settingsSub: groupId, anchor: opts.anchor || null }, '', newHash);
    }

    // On narrow, entering a group is a push (rebuilds body). On wide, we
    // just update the rail active state + swap detail content — no shell
    // rerender needed unless we came from search.
    if (wide && !wasActive) {
        rerenderShell();
    } else if (!wide) {
        rerenderShell();
    }
    await mountActiveGroupContent(opts.anchor || null);
}

function openLanding() {
    // Narrow back → return to landing. On wide there is no "landing"
    // concept — the rail is always visible.
    if (wide) return;
    if (activeGroup && activeGroup.cleanup) {
        try { activeGroup.cleanup(); } catch (err) { console.error('Group cleanup error:', err); }
    }
    activeGroup = null;
    activeGroupId = null;
    const parentHash = '#settings';
    if (window.location.hash !== parentHash) {
        history.pushState({ settingsSub: null }, '', parentHash);
    }
    rerenderShell();
}

function setSearchQuery(q) {
    searchQuery = q;
    // Only the list section needs a targeted rebuild. Full shell rerender is
    // simplest and keeps the logic in one place.
    rerenderShell();
    // Refocus the input so typing stays continuous.
    const input = document.getElementById('settings-v2-search-input');
    if (input) {
        input.focus();
        const val = input.value;
        input.setSelectionRange(val.length, val.length);
    }
}

function rerenderShell() {
    // Detach the group content node from its old mount so we can preserve
    // its live DOM state across a shell rebuild (avoids re-initing group
    // listeners on every search keystroke or breakpoint flip).
    const oldMount = document.getElementById('settings-v2-group-mount');
    const savedContent = oldMount && oldMount.firstChild ? Array.from(oldMount.childNodes) : null;

    const container = document.getElementById('settings-page-outer');
    if (!container) return;
    container.innerHTML = renderShell();
    wireShellListeners();

    // Re-attach preserved group content if the new shell has a mount and
    // the same group is still active (i.e. we didn't change which group).
    const newMount = document.getElementById('settings-v2-group-mount');
    if (newMount && savedContent && activeGroupId) {
        newMount.innerHTML = '';
        for (const node of savedContent) newMount.appendChild(node);
    }
}

function onResize() {
    const nowWide = isWide();
    if (nowWide === wide) return;   // same layout, nothing to do
    wide = nowWide;
    rerenderShell();
    // When flipping between layouts we lose the group's live state anyway
    // (the mount container might not exist yet on wide→narrow flip if no
    // group was active). Remount cleanly to keep listeners in sync.
    if (activeGroupId) {
        mountActiveGroupContent(null);
    }
}

// --- page module export ---

export const settingsPage = {
    render(_subPath) {
        // Outer container the router injects into #main-content. The real
        // shell is rendered in init() where we can compute the breakpoint
        // and, more importantly, know whether a sub-path is present.
        return `<section class="page-settings-v2" id="settings-page-outer" style="height:100%;"></section>`;
    },

    async init(subPath) {
        const { id, anchor } = parseSubPath(subPath || '');
        wide = isWide();
        // Wide always shows a group in the detail pane; default to General.
        activeGroupId = id || (wide ? 'general' : null);
        activeGroup = null;
        searchQuery = '';

        rerenderShell();
        if (activeGroupId) {
            await mountActiveGroupContent(anchor);
        }

        if (!resizeHandler) {
            resizeHandler = () => onResize();
            window.addEventListener('resize', resizeHandler);
        }
    },

    cleanup() {
        if (activeGroup && activeGroup.cleanup) {
            try { activeGroup.cleanup(); } catch (err) { console.error('Group cleanup error:', err); }
        }
        activeGroup = null;
        activeGroupId = null;
        searchQuery = '';
        if (resizeHandler) {
            window.removeEventListener('resize', resizeHandler);
            resizeHandler = null;
        }
    }
};

// --- tiny helpers ---

function escapeHtml(s) {
    return String(s == null ? '' : s)
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function escapeAttr(s) { return escapeHtml(s); }
function cssEscape(s) {
    if (window.CSS && window.CSS.escape) return window.CSS.escape(s);
    return String(s).replace(/[^a-zA-Z0-9_-]/g, ch => `\\${ch}`);
}
