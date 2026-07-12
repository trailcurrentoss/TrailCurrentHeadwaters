// Air quality display — v02 layout: header with title + recommendation +
// overall-status pill on the right; then a grid of cards for Temp /
// Humidity / TVOC / eCO₂ / CO, each with an icon-in-circle, the current
// value with a gradient slider bar and a pointer showing where the
// reading sits within the healthy range.
import { wsClient } from '../api.js';
import { units } from '../services/units.js';

export class AirQualityDisplay {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            tvoc_ppb: null,
            eco2_ppm: null
        };
        this.wsHandler = null;
        this.unsubStaleAir = null;

        this.dataTempAndHumidity = {
            tempInC: null,
            tempInF: null,
            humidity: null
        };
        this.wsTempAndHumidityHandler = null;
        this.unsubStaleTempHumid = null;
        this.unitsHandler = null;

        // Safety frame (Borealis 0x20) — CO ppm plus alarm bitmask.
        // Byte 4 is the source of truth for alarm state per DBC; ppm is
        // used for the slider position and trend value.
        this.dataSafety = {
            co_ppm: null,
            alarm_flags: null,
            co_warn: false,
            co_alarm: false
        };
        this.wsSafetyHandler = null;
        this.unsubStaleSafety = null;
    }

    render() {
        return `
            <div class="airquality-page">
                <header class="airquality-header">
                    <div class="airquality-header-left">
                        <h1 class="page-title">Air Quality</h1>
                        <span class="page-subtitle" id="airquality-rec">${this.getRecommendation()}</span>
                    </div>
                    <span class="airquality-status-pill ${this.getOverallClass()}" id="airquality-status-pill">${this.getOverallLabel()}</span>
                </header>

                <div class="airquality-grid">
                    ${this.renderTempCard()}
                    ${this.renderHumidityCard()}
                    ${this.renderTvocCard()}
                    ${this.renderEco2Card()}
                    ${this.renderCoCard()}
                </div>
            </div>
        `;
    }

    // ── Card renderers ──────────────────────────────────────────

    renderTempCard() {
        return `
            <div class="airquality-tile">
                <div class="airquality-tile-icon temp">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"></path>
                    </svg>
                </div>
                <div class="airquality-tile-body">
                    <div class="airquality-tile-head">
                        <span class="airquality-tile-value" id="temp-value">${units.formatTemp(this.dataTempAndHumidity.tempInF)}<span class="airquality-tile-unit">${units.tempLabel()}</span></span>
                        <span class="airquality-tile-label">Temperature</span>
                    </div>
                    <div class="airquality-slider temp-slider" id="temp-slider">
                        <span class="airquality-slider-pointer" id="temp-pointer" style="left:${this.tempPointerPct()}%"></span>
                    </div>
                    <div class="airquality-slider-scale">
                        <span>50°</span><span>Comfort</span><span>90°</span>
                    </div>
                </div>
            </div>
        `;
    }

    renderHumidityCard() {
        return `
            <div class="airquality-tile">
                <div class="airquality-tile-icon humidity">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"></path>
                    </svg>
                </div>
                <div class="airquality-tile-body">
                    <div class="airquality-tile-head">
                        <span class="airquality-tile-value" id="humidity-value">${this.fmtHumidity()}<span class="airquality-tile-unit">%</span></span>
                        <span class="airquality-tile-label">Humidity</span>
                    </div>
                    <div class="airquality-slider humidity-slider" id="humidity-slider">
                        <span class="airquality-slider-pointer" id="humidity-pointer" style="left:${this.humidityPointerPct()}%"></span>
                    </div>
                    <div class="airquality-slider-scale">
                        <span>Dry</span><span>30–50% ideal</span><span>Humid</span>
                    </div>
                </div>
            </div>
        `;
    }

    renderTvocCard() {
        return `
            <div class="airquality-tile">
                <div class="airquality-tile-icon neutral">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"></path>
                    </svg>
                </div>
                <div class="airquality-tile-body">
                    <div class="airquality-tile-head">
                        <span class="airquality-tile-value" id="tvoc-value">${this.fmtTvoc()}<span class="airquality-tile-unit"> ppb</span></span>
                        <span class="airquality-tile-label">TVOC</span>
                        <span class="airquality-badge ${this.getTvocClass()}" id="tvoc-badge" ${this.data.tvoc_ppb == null ? 'style="display:none"' : ''}>${this.getTvocLabel()}</span>
                    </div>
                    <div class="airquality-slider tvoc-slider" id="tvoc-slider">
                        <span class="airquality-slider-pointer" id="tvoc-pointer" style="left:${this.tvocPointerPct()}%"></span>
                    </div>
                    <div class="airquality-slider-scale">
                        <span>0</span><span>220 moderate</span><span>1000+ ppb</span>
                    </div>
                </div>
            </div>
        `;
    }

    renderEco2Card() {
        return `
            <div class="airquality-tile">
                <div class="airquality-tile-icon neutral">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"></path>
                    </svg>
                </div>
                <div class="airquality-tile-body">
                    <div class="airquality-tile-head">
                        <span class="airquality-tile-value" id="eco2-value">${this.fmtEco2()}<span class="airquality-tile-unit"> ppm</span></span>
                        <span class="airquality-tile-label">eCO₂</span>
                        <span class="airquality-badge ${this.getEco2Class()}" id="eco2-badge" ${this.data.eco2_ppm == null ? 'style="display:none"' : ''}>${this.getEco2Label()}</span>
                    </div>
                    <div class="airquality-slider eco2-slider" id="eco2-slider">
                        <span class="airquality-slider-pointer" id="eco2-pointer" style="left:${this.eco2PointerPct()}%"></span>
                    </div>
                    <div class="airquality-slider-scale">
                        <span>400</span><span>1000 high</span><span>2000+ ppm</span>
                    </div>
                </div>
            </div>
        `;
    }

    // Carbon Monoxide (SEN0466). Label uses plain "CO" — the eCO₂ card
    // uses the subscript ₂ so the two never read the same at a glance.
    renderCoCard() {
        return `
            <div class="airquality-tile">
                <div class="airquality-tile-icon neutral">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <path d="M12 2 L4 5 V11 C4 15.5 7 19 12 22 C17 19 20 15.5 20 11 V5 L12 2 Z"></path>
                        <line x1="12" y1="8" x2="12" y2="13"></line>
                        <line x1="12" y1="16" x2="12" y2="16.5"></line>
                    </svg>
                </div>
                <div class="airquality-tile-body">
                    <div class="airquality-tile-head">
                        <span class="airquality-tile-value" id="co-value">${this.fmtCo()}<span class="airquality-tile-unit"> ppm</span></span>
                        <span class="airquality-tile-label">CO — Carbon Monoxide</span>
                        <span class="airquality-badge ${this.getCoClass()}" id="co-badge" ${this.dataSafety.co_ppm == null ? 'style="display:none"' : ''}>${this.getCoLabel()}</span>
                    </div>
                    <div class="airquality-slider co-slider" id="co-slider">
                        <span class="airquality-slider-pointer" id="co-pointer" style="left:${this.coPointerPct()}%"></span>
                    </div>
                    <div class="airquality-slider-scale">
                        <span>0</span><span>70 warn</span><span>200+ ppm</span>
                    </div>
                </div>
            </div>
        `;
    }

    // ── Formatters ──────────────────────────────────────────────

    fmtHumidity() { return this.dataTempAndHumidity.humidity == null ? '--' : Math.round(this.dataTempAndHumidity.humidity); }
    fmtTvoc()     { return this.data.tvoc_ppb  == null ? '--' : Math.round(this.data.tvoc_ppb); }
    fmtEco2()     { return this.data.eco2_ppm  == null ? '--' : Math.round(this.data.eco2_ppm); }
    fmtCo()       { return this.dataSafety.co_ppm == null ? '--' : Math.round(this.dataSafety.co_ppm); }

    // ── Slider pointer positions (0-100%) ───────────────────────

    tempPointerPct() {
        const f = this.dataTempAndHumidity.tempInF;
        if (f == null) return 50;
        return Math.max(0, Math.min(100, ((f - 50) / 40) * 100));
    }
    humidityPointerPct() {
        const h = this.dataTempAndHumidity.humidity;
        if (h == null) return 50;
        return Math.max(0, Math.min(100, h));
    }
    tvocPointerPct() {
        const t = this.data.tvoc_ppb;
        if (t == null) return 0;
        return Math.max(0, Math.min(100, (t / 1000) * 100));
    }
    eco2PointerPct() {
        const e = this.data.eco2_ppm;
        if (e == null) return 0;
        return Math.max(0, Math.min(100, ((e - 400) / 1600) * 100));
    }
    // 0-300 ppm mapped so that the warn threshold (70) lands at 33% and
    // the alarm threshold (200) lands at 67% — matches the scale labels.
    coPointerPct() {
        const c = this.dataSafety.co_ppm;
        if (c == null) return 0;
        return Math.max(0, Math.min(100, (c / 300) * 100));
    }

    // ── Level classification ────────────────────────────────────

    getTvocClass() {
        const t = this.data.tvoc_ppb;
        if (t == null) return 'unset';
        if (t < 220) return 'good';
        if (t < 660) return 'moderate';
        return 'unhealthy';
    }
    getTvocLabel() {
        const t = this.data.tvoc_ppb;
        if (t == null) return '';
        if (t < 65)   return 'Excellent';
        if (t < 220)  return 'Good';
        if (t < 660)  return 'Moderate';
        if (t < 2200) return 'Poor';
        return 'Unhealthy';
    }
    getEco2Class() {
        const e = this.data.eco2_ppm;
        if (e == null) return 'unset';
        if (e < 1000) return 'good';
        if (e < 2000) return 'moderate';
        return 'unhealthy';
    }
    getEco2Label() {
        const e = this.data.eco2_ppm;
        if (e == null) return '';
        if (e < 1000) return 'Normal';
        if (e < 2000) return 'High';
        return 'Alarm';
    }

    // CO classification honors the Borealis alarm-flag byte first (per
    // DBC: byte 4 is the source of truth), and falls back to ppm-based
    // classification if the flags aren't reported.
    getCoClass() {
        const c = this.dataSafety.co_ppm;
        if (c == null) return 'unset';
        if (this.dataSafety.co_alarm) return 'unhealthy';
        if (this.dataSafety.co_warn)  return 'moderate';
        if (c >= 200) return 'unhealthy';
        if (c >= 70)  return 'moderate';
        return 'good';
    }
    getCoLabel() {
        const c = this.dataSafety.co_ppm;
        if (c == null) return '';
        if (this.dataSafety.co_alarm || c >= 200) return 'Danger';
        if (this.dataSafety.co_warn  || c >= 70)  return 'Warning';
        return 'Normal';
    }

    // Overall status: worst of TVOC + eCO₂ + CO. CO in alarm dominates
    // everything else because it's life-safety, not comfort.
    getOverallClass() {
        const t = this.data.tvoc_ppb;
        const e = this.data.eco2_ppm;
        const coCls = this.getCoClass();
        if (t == null && e == null && coCls === 'unset') return 'unset';
        if (coCls === 'unhealthy') return 'unhealthy';
        if ((t != null && t >= 660) || (e != null && e >= 2000)) return 'unhealthy';
        if (coCls === 'moderate') return 'moderate';
        if ((t != null && t >= 220) || (e != null && e >= 1000)) return 'moderate';
        return 'good';
    }
    getOverallLabel() {
        return ({ unset: '—', good: 'Good', moderate: 'Moderate', unhealthy: 'Unhealthy' })[this.getOverallClass()];
    }
    getRecommendation() {
        // CO danger gets its own explicit callout — generic "ventilate"
        // language undersells an active carbon-monoxide alarm.
        if (this.getCoClass() === 'unhealthy') return 'Carbon monoxide detected — ventilate immediately';
        const cls = this.getOverallClass();
        return ({
            unset:     'Waiting for sensor data…',
            good:      'Air quality is good',
            moderate:  'Ventilation recommended',
            unhealthy: 'Ventilation needed'
        })[cls];
    }

    // ── Lifecycle ────────────────────────────────────────────────

    init(data, dataTempAndHumidity, dataSafety) {
        if (data) this.data = data;
        if (dataTempAndHumidity) this.dataTempAndHumidity = dataTempAndHumidity;
        if (dataSafety) this.dataSafety = dataSafety;
        this.updateAll();

        this.wsHandler = (data) => {
            this.data = data;
            this.updateAll();
        };
        wsClient.on('airquality', this.wsHandler);

        this.wsTempAndHumidityHandler = (dataTempAndHumidity) => {
            this.dataTempAndHumidity = dataTempAndHumidity;
            this.updateAll();
        };
        wsClient.on('temphumid', this.wsTempAndHumidityHandler);

        this.wsSafetyHandler = (dataSafety) => {
            this.dataSafety = dataSafety;
            this.updateAll();
        };
        wsClient.on('airquality-safety', this.wsSafetyHandler);

        this.unsubStaleAir = wsClient.onStale('airquality', () => {
            this.data = { tvoc_ppb: null, eco2_ppm: null };
            this.updateAll();
        });
        this.unsubStaleTempHumid = wsClient.onStale('temphumid', () => {
            this.dataTempAndHumidity = { tempInC: null, tempInF: null, humidity: null };
            this.updateAll();
        });
        this.unsubStaleSafety = wsClient.onStale('airquality-safety', () => {
            this.dataSafety = { co_ppm: null, alarm_flags: null, co_warn: false, co_alarm: false };
            this.updateAll();
        });

        // Re-render when user flips temperature units.
        this.unitsHandler = () => this.updateAll();
        units.addEventListener('change', this.unitsHandler);
    }

    updateAll() {
        // Header
        const rec = document.getElementById('airquality-rec');
        if (rec) rec.textContent = this.getRecommendation();
        const pill = document.getElementById('airquality-status-pill');
        if (pill) {
            pill.textContent = this.getOverallLabel();
            pill.className = `airquality-status-pill ${this.getOverallClass()}`;
        }

        // Temp
        const tempV = document.getElementById('temp-value');
        if (tempV) tempV.innerHTML = `${units.formatTemp(this.dataTempAndHumidity.tempInF)}<span class="airquality-tile-unit">${units.tempLabel()}</span>`;
        const tempPtr = document.getElementById('temp-pointer');
        if (tempPtr) tempPtr.style.left = this.tempPointerPct() + '%';

        // Humidity
        const humV = document.getElementById('humidity-value');
        if (humV) humV.innerHTML = `${this.fmtHumidity()}<span class="airquality-tile-unit">%</span>`;
        const humPtr = document.getElementById('humidity-pointer');
        if (humPtr) humPtr.style.left = this.humidityPointerPct() + '%';

        // TVOC
        const tvocV = document.getElementById('tvoc-value');
        if (tvocV) tvocV.innerHTML = `${this.fmtTvoc()}<span class="airquality-tile-unit"> ppb</span>`;
        const tvocPtr = document.getElementById('tvoc-pointer');
        if (tvocPtr) tvocPtr.style.left = this.tvocPointerPct() + '%';
        const tvocBadge = document.getElementById('tvoc-badge');
        if (tvocBadge) {
            tvocBadge.textContent = this.getTvocLabel();
            tvocBadge.className = `airquality-badge ${this.getTvocClass()}`;
            tvocBadge.style.display = this.data.tvoc_ppb != null ? '' : 'none';
        }

        // eCO2
        const eco2V = document.getElementById('eco2-value');
        if (eco2V) eco2V.innerHTML = `${this.fmtEco2()}<span class="airquality-tile-unit"> ppm</span>`;
        const eco2Ptr = document.getElementById('eco2-pointer');
        if (eco2Ptr) eco2Ptr.style.left = this.eco2PointerPct() + '%';
        const eco2Badge = document.getElementById('eco2-badge');
        if (eco2Badge) {
            eco2Badge.textContent = this.getEco2Label();
            eco2Badge.className = `airquality-badge ${this.getEco2Class()}`;
            eco2Badge.style.display = this.data.eco2_ppm != null ? '' : 'none';
        }

        // CO
        const coV = document.getElementById('co-value');
        if (coV) coV.innerHTML = `${this.fmtCo()}<span class="airquality-tile-unit"> ppm</span>`;
        const coPtr = document.getElementById('co-pointer');
        if (coPtr) coPtr.style.left = this.coPointerPct() + '%';
        const coBadge = document.getElementById('co-badge');
        if (coBadge) {
            coBadge.textContent = this.getCoLabel();
            coBadge.className = `airquality-badge ${this.getCoClass()}`;
            coBadge.style.display = this.dataSafety.co_ppm != null ? '' : 'none';
        }
    }

    // Legacy shim names still called by any external code.
    updateDisplay() { this.updateAll(); }
    updateTempAndHumidity() { this.updateAll(); }

    cleanup() {
        if (this.wsHandler) wsClient.off('airquality', this.wsHandler);
        if (this.wsTempAndHumidityHandler) wsClient.off('temphumid', this.wsTempAndHumidityHandler);
        if (this.wsSafetyHandler) wsClient.off('airquality-safety', this.wsSafetyHandler);
        if (this.unsubStaleAir) this.unsubStaleAir();
        if (this.unsubStaleTempHumid) this.unsubStaleTempHumid();
        if (this.unsubStaleSafety) this.unsubStaleSafety();
        if (this.unitsHandler) {
            units.removeEventListener('change', this.unitsHandler);
            this.unitsHandler = null;
        }
    }
}
