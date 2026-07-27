// Shared FontAwesome-Solid icon set — mirrors the CURATED_ICONS array
// in TrailCurrentFireside (button_config.c). Order and codepoints must
// stay in lockstep with Fireside so a user's picks look the same on the
// touchscreen and the PWA.
//
// Labels and groups were verified by dumping the CMAP of the same
// fa-solid-900.ttf that Fireside embeds — no guessing. Each entry:
//   cp    - hex string of the FA codepoint (used as CSS content ↩\XXXX)
//   key   - stable identifier stored in configs (usually the FA glyph
//           name so it round-trips readably in mongo dumps)
//   label - human-readable name shown in the picker + searchable
//   group - visual grouping for the picker

export const FIRESIDE_ICONS = [
    // Lights & Weather
    { cp: 'f0eb', key: 'lightbulb',         label: 'Light Bulb',       group: 'Lights & Weather' },
    { cp: 'f185', key: 'sun',               label: 'Sun',              group: 'Lights & Weather' },
    { cp: 'f186', key: 'moon',              label: 'Moon',             group: 'Lights & Weather' },
    { cp: 'f0c2', key: 'cloud',             label: 'Cloud',            group: 'Lights & Weather' },
    { cp: 'f0e9', key: 'umbrella',          label: 'Umbrella',         group: 'Lights & Weather' },
    { cp: 'f2dc', key: 'snowflake',         label: 'Snowflake',        group: 'Lights & Weather' },
    { cp: 'f06d', key: 'fire',              label: 'Fire',             group: 'Lights & Weather' },
    { cp: 'f7e4', key: 'fire-flame-curved', label: 'Flame',            group: 'Lights & Weather' },

    // Power & Utility
    { cp: 'f0e7', key: 'bolt',              label: 'Bolt',             group: 'Power & Utility' },
    { cp: 'f1e6', key: 'plug',              label: 'Plug',             group: 'Power & Utility' },
    { cp: 'f240', key: 'battery-full',      label: 'Battery',          group: 'Power & Utility' },
    { cp: 'f5e7', key: 'charging-station',  label: 'Charging Station', group: 'Power & Utility' },
    { cp: 'f863', key: 'fan',               label: 'Fan',              group: 'Power & Utility' },
    { cp: 'f5aa', key: 'paint-roller',      label: 'Paint Roller',     group: 'Power & Utility' },

    // Water
    { cp: 'f043', key: 'droplet',           label: 'Droplet',          group: 'Water' },
    { cp: 'e005', key: 'faucet',            label: 'Faucet',           group: 'Water' },
    { cp: 'f773', key: 'water',             label: 'Water',            group: 'Water' },
    { cp: 'f2cd', key: 'bath',              label: 'Bath / Shower',    group: 'Water' },

    // Kitchen
    { cp: 'f2e7', key: 'utensils',          label: 'Utensils',         group: 'Kitchen' },
    { cp: 'f7b6', key: 'mug-hot',           label: 'Hot Mug',          group: 'Kitchen' },
    { cp: 'f0f4', key: 'mug-saucer',        label: 'Coffee',           group: 'Kitchen' },

    // Home & Places
    { cp: 'f015', key: 'house',             label: 'House',            group: 'Home & Places' },
    { cp: 'f1ad', key: 'building',          label: 'Building',         group: 'Home & Places' },
    { cp: 'f52a', key: 'door-closed',       label: 'Door',             group: 'Home & Places' },
    { cp: 'f494', key: 'warehouse',         label: 'Warehouse',        group: 'Home & Places' },
    { cp: 'f236', key: 'bed',               label: 'Bed',              group: 'Home & Places' },
    { cp: 'f54f', key: 'shop',              label: 'Shop',             group: 'Home & Places' },
    { cp: 'f553', key: 'shirt',             label: 'Shirt',            group: 'Home & Places' },

    // Outdoors
    { cp: 'f1bb', key: 'tree',              label: 'Tree',             group: 'Outdoors' },
    { cp: 'f06c', key: 'leaf',              label: 'Leaf',             group: 'Outdoors' },
    { cp: 'f6fc', key: 'mountain',          label: 'Mountain',         group: 'Outdoors' },
    { cp: 'f0ac', key: 'globe',             label: 'Globe',            group: 'Outdoors' },
    { cp: 'f8ff', key: 'caravan',           label: 'Caravan',          group: 'Outdoors' },

    // Vehicle & Travel
    { cp: 'f1b9', key: 'car',               label: 'Car',              group: 'Vehicle & Travel' },
    { cp: 'f0d1', key: 'truck',             label: 'Truck',            group: 'Vehicle & Travel' },
    { cp: 'f206', key: 'bicycle',           label: 'Bicycle',          group: 'Vehicle & Travel' },
    { cp: 'f072', key: 'plane',             label: 'Plane',            group: 'Vehicle & Travel' },
    { cp: 'f135', key: 'rocket',            label: 'Rocket',           group: 'Vehicle & Travel' },

    // Navigation
    { cp: 'f3c5', key: 'location-dot',      label: 'Location',         group: 'Navigation' },
    { cp: 'f041', key: 'location-pin',      label: 'Pin',              group: 'Navigation' },
    { cp: 'f5fd', key: 'layer-group',       label: 'Layers',           group: 'Navigation' },

    // Media
    { cp: 'f083', key: 'camera-retro',      label: 'Camera',           group: 'Media' },
    { cp: 'f008', key: 'film',              label: 'Film',             group: 'Media' },
    { cp: 'f001', key: 'music',             label: 'Music',            group: 'Media' },
    { cp: 'f025', key: 'headphones',        label: 'Headphones',       group: 'Media' },
    { cp: 'f04b', key: 'play',              label: 'Play',             group: 'Media' },
    { cp: 'f04a', key: 'backward',          label: 'Backward',         group: 'Media' },
    { cp: 'f04d', key: 'stop',              label: 'Stop',             group: 'Media' },
    { cp: 'f11b', key: 'gamepad',           label: 'Gamepad',          group: 'Media' },

    // Communication
    { cp: 'f095', key: 'phone',             label: 'Phone',            group: 'Communication' },
    { cp: 'f075', key: 'comment',           label: 'Comment',          group: 'Communication' },
    { cp: 'f1eb', key: 'wifi',              label: 'Wi-Fi',            group: 'Communication' },
    { cp: 'f7c0', key: 'satellite-dish',    label: 'Satellite Dish',   group: 'Communication' },

    // People
    { cp: 'f0c0', key: 'users',             label: 'Group',            group: 'People' },
    { cp: 'f007', key: 'user',              label: 'Person',           group: 'People' },
    { cp: 'f183', key: 'person',            label: 'Adult',            group: 'People' },
    { cp: 'f21b', key: 'user-secret',       label: 'Incognito',        group: 'People' },

    // Alerts & Safety
    { cp: 'f0f3', key: 'bell',              label: 'Bell',             group: 'Alerts & Safety' },
    { cp: 'f0f1', key: 'stethoscope',       label: 'Stethoscope',      group: 'Alerts & Safety' },
    { cp: 'f06e', key: 'eye',               label: 'Eye',              group: 'Alerts & Safety' },
    { cp: 'f132', key: 'shield',            label: 'Shield',           group: 'Alerts & Safety' },
    { cp: 'f794', key: 'dumpster-fire',     label: 'Emergency',        group: 'Alerts & Safety' },

    // Security
    { cp: 'f023', key: 'lock',              label: 'Lock',             group: 'Security' },
    { cp: 'f084', key: 'key',               label: 'Key',              group: 'Security' },
    { cp: 'f2f6', key: 'right-to-bracket',  label: 'Sign In',          group: 'Security' },

    // Time
    { cp: 'f017', key: 'clock',             label: 'Clock',            group: 'Time' },
    { cp: 'f133', key: 'calendar',          label: 'Calendar',         group: 'Time' },
    { cp: 'f073', key: 'calendar-days',     label: 'Calendar Days',    group: 'Time' },

    // Favorites
    { cp: 'f004', key: 'heart',             label: 'Heart',            group: 'Favorites' },
    { cp: 'f005', key: 'star',              label: 'Star',             group: 'Favorites' },
    { cp: 'f164', key: 'thumbs-up',         label: 'Thumbs Up',        group: 'Favorites' },
    { cp: 'f06b', key: 'gift',              label: 'Gift',             group: 'Favorites' },

    // Storage
    { cp: 'f09d', key: 'credit-card',       label: 'Credit Card',      group: 'Storage' },
    { cp: 'f0b1', key: 'briefcase',         label: 'Briefcase',        group: 'Storage' },
    { cp: 'f0c6', key: 'paperclip',         label: 'Paperclip',        group: 'Storage' },
    { cp: 'f02d', key: 'book',              label: 'Book',             group: 'Storage' },
    { cp: 'f290', key: 'bag-shopping',      label: 'Shopping Bag',     group: 'Storage' },

    // System
    { cp: 'f013', key: 'gear',              label: 'Settings',         group: 'System' },
    { cp: 'f1de', key: 'sliders',           label: 'Sliders',          group: 'System' },
    { cp: 'f002', key: 'magnifying-glass',  label: 'Search',           group: 'System' },
    { cp: 'f05a', key: 'circle-info',       label: 'Info',             group: 'System' },
    { cp: 'f0ee', key: 'cloud-arrow-up',    label: 'Cloud Upload',     group: 'System' },
    { cp: 'f065', key: 'expand',            label: 'Expand',           group: 'System' },
    { cp: 'f1f8', key: 'trash',             label: 'Trash',            group: 'System' },
];

// Look-up by stable key
export const ICON_BY_KEY = Object.fromEntries(
    FIRESIDE_ICONS.map(ic => [ic.key, ic])
);

// Look-up by codepoint (hex string, no prefix)
export const ICON_BY_CP = Object.fromEntries(
    FIRESIDE_ICONS.map(ic => [ic.cp.toLowerCase(), ic])
);

// Legacy pdm-icons.js keys → current Fireside icon keys. Any value
// stored under an old name (before this consolidation) still renders.
export const LEGACY_KEY_MAP = {
    'ceiling-light':  'lightbulb',
    'exterior-light': 'lightbulb',
    'strip-light':    'lightbulb',
    'water-pump':     'water',
    'heater':         'fire',
    'power-outlet':   'plug',
    'fridge':         'snowflake',
    'awning':         'caravan',
    'step':           'house',
    'antenna':        'satellite-dish',
    'speaker':        'music',
    'generic':        'gear',
};

/**
 * Resolve any icon identifier (new key, legacy key, or codepoint) to
 * the canonical Fireside icon record. Falls back to lightbulb.
 */
export function resolveIcon(id) {
    if (!id) return ICON_BY_KEY['lightbulb'];
    const raw = String(id).toLowerCase().replace(/^0x/, '');
    if (ICON_BY_KEY[id])          return ICON_BY_KEY[id];
    if (LEGACY_KEY_MAP[id])       return ICON_BY_KEY[LEGACY_KEY_MAP[id]];
    if (ICON_BY_CP[raw])          return ICON_BY_CP[raw];
    return ICON_BY_KEY['lightbulb'];
}

/**
 * HTML snippet that renders the icon glyph via the FA font.
 * Callers style .fa-icon in CSS (size, color, opacity, etc.).
 */
export function renderIconHtml(id, extraClass = '') {
    const ic = resolveIcon(id);
    const cls = extraClass ? `fa-icon ${extraClass}` : 'fa-icon';
    return `<i class="${cls}" aria-hidden="true">&#x${ic.cp};</i>`;
}

// Groups in the order they should appear in the picker
export const ICON_GROUPS = [
    'Lights & Weather',
    'Power & Utility',
    'Water',
    'Kitchen',
    'Home & Places',
    'Outdoors',
    'Vehicle & Travel',
    'Navigation',
    'Media',
    'Communication',
    'People',
    'Alerts & Safety',
    'Security',
    'Time',
    'Favorites',
    'Storage',
    'System',
];
