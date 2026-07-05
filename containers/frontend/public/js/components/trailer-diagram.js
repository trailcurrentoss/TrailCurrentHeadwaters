// Trailer diagram — top-down view of a trailer with 2·N tire slots (one
// axle = 2 tires, left + right). Axle count comes from the caller (driven
// by Settings → Trailer → Axles). All fields accept null to render as "--"
// placeholders (used until Aftline hardware reports).
//
//   trailerDiagram({
//       axles: 2,                        // 1 | 2 | 3 — one axle = 2 tires
//       breakawayArmed: true | false | null,
//       // Tire pressures indexed by "axle L/R" — axle0 is frontmost.
//       tires: { '0L': 62, '0R': 63, '1L': 61, '1R': 62 },
//       blindSpotLeft: 'clear' | 'vehicle' | null,
//       blindSpotRight: 'clear' | 'vehicle' | null
//   })

const CURVE_SVG = (color, animate) => `
    <svg width="26" height="44" viewBox="0 0 26 44" fill="none" stroke-width="2" stroke-linecap="round"
         style="stroke:${color};${animate ? 'animation:ovpulse 1s ease-in-out infinite' : ''}">
        <path d="M4 16a8 8 0 0 1 0 12"></path>
        <path d="M10 10a16 16 0 0 1 0 24"></path>
        <path d="M16 4a24 24 0 0 1 0 36"></path>
    </svg>
`;

const CURVE_SVG_MIRRORED = (color, animate) => `
    <svg width="26" height="44" viewBox="0 0 26 44" fill="none" stroke-width="2" stroke-linecap="round"
         style="stroke:${color};transform:scaleX(-1);${animate ? 'animation:ovpulse 1s ease-in-out infinite' : ''}">
        <path d="M4 16a8 8 0 0 1 0 12"></path>
        <path d="M10 10a16 16 0 0 1 0 24"></path>
        <path d="M16 4a24 24 0 0 1 0 36"></path>
    </svg>
`;

function fmtPsi(v) {
    if (v === null || v === undefined || Number.isNaN(v)) return '--';
    return String(Math.round(v));
}

function blindSpotColor(state) {
    if (state === 'clear') return 'var(--role-primary)';
    if (state === 'vehicle') return '#FFC107';
    return 'var(--text-muted)';
}

function blindSpotWord(state) {
    if (state === 'clear') return 'Clear';
    if (state === 'vehicle') return 'Vehicle';
    return '--';
}

// Return an array of vertical positions (in %) for each axle. The tires
// distribute evenly across the middle 45% of the trailer body so there's
// always room above for the window and below for the caption.
function axlePositions(count) {
    if (count === 1) return [55];
    if (count === 2) return [44, 66];
    if (count === 3) return [40, 55, 70];
    return [44, 66]; // fallback: tandem
}

export function trailerDiagram({
    axles = 2,
    breakawayArmed = null,
    tires = {},
    blindSpotLeft = null,
    blindSpotRight = null
} = {}) {
    const axleCount = [1, 2, 3].includes(Number(axles)) ? Number(axles) : 2;
    const positions = axlePositions(axleCount);

    const breakawayColor = breakawayArmed === true ? 'var(--role-primary)'
        : breakawayArmed === false ? 'var(--danger)'
        : 'var(--text-muted)';
    const breakawayGlow = breakawayArmed === true ? 'box-shadow:var(--glow-primary);' : '';
    const breakawayWord = breakawayArmed === true ? 'Breakaway Armed'
        : breakawayArmed === false ? 'Breakaway Off'
        : 'Breakaway --';

    const lsColor = blindSpotColor(blindSpotLeft);
    const rsColor = blindSpotColor(blindSpotRight);
    const lsWord = blindSpotWord(blindSpotLeft);
    const rsWord = blindSpotWord(blindSpotRight);

    // Tire blobs (positioned inside .trailer-body — they poke out via left:-5px
    // / right:-5px so their center sits on the body edge).
    const tireBlobs = positions.map((topPct) => `
        <div class="trailer-tire trailer-tire-l" style="top:${topPct}%"></div>
        <div class="trailer-tire trailer-tire-r" style="top:${topPct}%"></div>
    `).join('');
    // Psi labels live one level up — as siblings of .trailer-body inside the
    // wrap — so `left:0` / `right:0` puts them flush against the WRAP's
    // outer edge (i.e. outside the tire, not inside the trailer body).
    const psiBlobs = positions.map((topPct, i) => {
        const lKey = `${i}L`, rKey = `${i}R`;
        return `
            <span class="trailer-tire-psi trailer-tire-psi-l" style="top:${topPct + 2}%">${fmtPsi(tires[lKey])}</span>
            <span class="trailer-tire-psi trailer-tire-psi-r" style="top:${topPct + 2}%">${fmtPsi(tires[rKey])}</span>
        `;
    }).join('');

    return `
        <div class="trailer-diagram">
            <!-- Hitch / tongue coupler -->
            <div class="trailer-coupler">
                <div class="trailer-coupler-inner"></div>
            </div>

            <!-- Breakaway indicator -->
            <div class="trailer-breakaway">
                <span class="trailer-breakaway-dot" style="background:${breakawayColor};${breakawayGlow}"></span>
                <span class="trailer-breakaway-label" style="color:${breakawayColor}">${breakawayWord}</span>
            </div>

            <!-- Body + blind spots -->
            <div class="trailer-row">
                <div class="trailer-bs">
                    ${CURVE_SVG_MIRRORED(lsColor, blindSpotLeft === 'vehicle')}
                    <span class="trailer-bs-word" style="color:${lsColor}">${lsWord}</span>
                    <span class="trailer-bs-label">Blind Spot</span>
                </div>

                <div class="trailer-body-wrap" data-axles="${axleCount}">
                    <div class="trailer-body">
                        <div class="trailer-window"></div>
                        ${tireBlobs}
                    </div>
                    ${psiBlobs}
                </div>

                <div class="trailer-bs">
                    ${CURVE_SVG(rsColor, blindSpotRight === 'vehicle')}
                    <span class="trailer-bs-word" style="color:${rsColor}">${rsWord}</span>
                    <span class="trailer-bs-label">Blind Spot</span>
                </div>
            </div>

            <span class="trailer-caption">Tire pressure · psi</span>
        </div>
    `;
}
