// Arc gauge — 270° conic donut used by the Driving-mode battery + solar tiles.
// Value/max drive the fill fraction; color drives the arc hue. The center of
// the ring is a slot for whatever caller wants to render (big number, icon).
//
// Renders as an HTML string so pages can compose it via template literals.
//
//   arcGauge({
//       value: 84,             // current value
//       max: 100,              // scale max — value/max drives fill
//       color: '#52A441',      // arc color (or var())
//       size: 186,             // outer diameter, px
//       inner: `<big-number>`  // HTML for the inner circle
//   })
//
// If value is null / undefined, renders an "empty" arc (no fill).

export function arcGauge({ value, max = 100, color = 'var(--role-primary)', size = 186, inner = '' } = {}) {
    const hasData = value !== null && value !== undefined && !Number.isNaN(value);
    const clamped = hasData ? Math.max(0, Math.min(1, value / max)) : 0;
    const fillTurn = (0.75 * clamped).toFixed(3);
    const arcBg = hasData
        ? `conic-gradient(from 225deg, ${color} 0turn ${fillTurn}turn, var(--bg-card-hover) ${fillTurn}turn 0.75turn, transparent 0.75turn 1turn)`
        : `conic-gradient(from 225deg, var(--bg-card-hover) 0turn 0.75turn, transparent 0.75turn 1turn)`;
    const inset = Math.round(size * 0.06);
    return `
        <div class="arc-gauge" style="width:${size}px;height:${size}px;background:${arcBg}">
            <div class="arc-gauge-inner" style="inset:${inset}px">
                ${inner}
            </div>
        </div>
    `;
}
