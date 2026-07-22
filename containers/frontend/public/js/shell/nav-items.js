// Shared nav item config used by SidebarNav and BottomNav.
// One source of truth for icon paths, labels, and route names.

export const PRIMARY_ITEMS = [
    {
        page: 'home',
        label: 'Home',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"></path><polyline points="9 22 9 12 15 12 15 22"></polyline></svg>'
    },
    {
        page: 'trailer',
        label: 'Vehicle',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="1" y="6" width="22" height="12" rx="2"></rect><circle cx="6" cy="18" r="2"></circle><circle cx="18" cy="18" r="2"></circle><line x1="6" y1="12" x2="18" y2="12"></line></svg>'
    },
    {
        page: 'energy',
        label: 'Energy',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"></polygon></svg>'
    },
    {
        page: 'water',
        label: 'Water',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path></svg>'
    },
    {
        page: 'airquality',
        label: 'Air',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path></svg>'
    },
    {
        page: 'map',
        label: 'Map',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"></path><circle cx="12" cy="10" r="3"></circle></svg>'
    },
    {
        page: 'trails',
        label: 'Trails',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 20l4-8 4 4 4-10 4 14"></path></svg>'
    },
    {
        page: 'monitoring',
        label: 'Monitor',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polygon points="23 7 16 12 23 17 23 7"></polygon><rect x="1" y="5" width="15" height="14" rx="2" ry="2"></rect></svg>'
    }
];

// System-section items (appear below a divider on the sidebar; live inside
// the "More" overflow menu on narrow screens).
export const SYSTEM_ITEMS = [
    {
        page: 'playbill',
        label: 'Playbill',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="2" y="6" width="20" height="13" rx="2"></rect><line x1="8" y1="22" x2="16" y2="22"></line><line x1="12" y1="19" x2="12" y2="22"></line><path d="M7 3l5 3 5-3"></path></svg>'
    },
    {
        page: 'peregrine',
        label: 'Peregrine',
        svg: '<svg viewBox="0 0 512 512" fill="none" stroke="currentColor" stroke-width="40" stroke-linecap="round" stroke-linejoin="round"><path d="M200 100 C230 80 280 80 310 100 C350 120 370 160 370 200 C370 220 365 235 355 245 L340 270 L340 300 C320 320 300 340 280 380 C260 420 240 440 220 450 C200 460 180 440 170 420 C160 400 160 360 170 320 C150 320 130 310 120 290 C110 270 110 240 120 210 C130 170 160 130 200 100Z"></path><path d="M355 200 C380 200 410 215 420 235 C425 245 415 255 400 250"></path><circle cx="280" cy="175" r="10" fill="currentColor" stroke="none"></circle></svg>'
    },
    // Config, Deploy, Maps, and Alarms live inside Settings (consolidated).
    // Reach them at #settings/network, #settings/deploy, #settings/maps,
    // and #settings/alarms respectively. Router.LEGACY_REDIRECTS keeps
    // old #config / #deployments / #maps / #alarms bookmarks working.
    {
        page: 'settings',
        label: 'Settings',
        svg: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"></path></svg>'
    }
];

// The narrow bottom-nav has room for six tabs + "More" at 375 px. The
// sidebar carries every primary item (there's vertical room); the bottom
// nav keeps the six most-frequently-used ones and pushes the rest into
// the More menu alongside the System items.
const BOTTOM_NAV_OVERFLOW_PAGES = new Set(['trails', 'monitoring']);
export const BOTTOM_NAV_PRIMARY = PRIMARY_ITEMS.filter(it => !BOTTOM_NAV_OVERFLOW_PAGES.has(it.page));

// Trails and Monitor ride in the More menu on narrow screens. Ordered
// above System items so they stay adjacent to the primary group they
// belong to.
export const BOTTOM_NAV_OVERFLOW = [
    ...PRIMARY_ITEMS.filter(it => BOTTOM_NAV_OVERFLOW_PAGES.has(it.page)),
    ...SYSTEM_ITEMS
];
