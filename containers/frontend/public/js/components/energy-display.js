// Energy display component — v02-style flow diagram (Solar → Battery →
// Loads) at the top with a grid of stats tiles (Voltage, Charge Status,
// Net Power, Time Remaining) below. Data flows in via WebSocket on the
// `energy` topic; each field renders `--` until first data arrives.
import { wsClient } from '../api.js';

export class EnergyDisplay {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            solar_watts: null,
            battery_percent: null,
            battery_voltage: null,
            charge_type: null,
            time_remaining_minutes: null,
            consumption_watts: null
        };
        this.wsHandler = null;
        this.unsubStale = null;
    }

    render() {
        return `
            <div class="energy-page">
                <!-- Flow diagram: Solar → Battery → Loads -->
                <div class="energy-flow-card">
                    <div class="energy-flow-item">
                        <div class="energy-flow-icon solar">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                <circle cx="12" cy="12" r="5"></circle>
                                <line x1="12" y1="1" x2="12" y2="3"></line>
                                <line x1="12" y1="21" x2="12" y2="23"></line>
                                <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"></line>
                                <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"></line>
                                <line x1="1" y1="12" x2="3" y2="12"></line>
                                <line x1="21" y1="12" x2="23" y2="12"></line>
                                <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"></line>
                                <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"></line>
                            </svg>
                        </div>
                        <span class="energy-flow-value" id="flow-solar">${this.fmtWatts(this.data.solar_watts)}<span class="energy-flow-unit"> W</span></span>
                        <span class="energy-flow-label">Solar</span>
                    </div>
                    <svg class="energy-flow-arrow" viewBox="0 0 36 16" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="2" y1="8" x2="30" y2="8"></line>
                        <polyline points="24 2 30 8 24 14"></polyline>
                    </svg>
                    <div class="energy-flow-item">
                        <div class="energy-flow-icon battery" id="flow-battery-icon">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                <rect x="1" y="6" width="18" height="12" rx="2"></rect>
                                <line x1="23" y1="10" x2="23" y2="14"></line>
                            </svg>
                        </div>
                        <span class="energy-flow-value" id="flow-battery">${this.fmtPct(this.data.battery_percent)}<span class="energy-flow-unit"> %</span></span>
                        <span class="energy-flow-label" id="flow-battery-label">Battery · ${this.formatChargeType(this.data.charge_type) || '--'}</span>
                    </div>
                    <svg class="energy-flow-arrow" viewBox="0 0 36 16" fill="none" stroke="var(--text-muted)" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                        <line x1="2" y1="8" x2="30" y2="8"></line>
                        <polyline points="24 2 30 8 24 14"></polyline>
                    </svg>
                    <div class="energy-flow-item">
                        <div class="energy-flow-icon loads">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true">
                                <path d="M18 20V10"></path>
                                <path d="M12 20V4"></path>
                                <path d="M6 20v-6"></path>
                            </svg>
                        </div>
                        <span class="energy-flow-value" id="flow-loads">${this.fmtWatts(this.data.consumption_watts)}<span class="energy-flow-unit"> W</span></span>
                        <span class="energy-flow-label">Loads</span>
                    </div>
                </div>

                <!-- Stats tiles -->
                <div class="energy-stats-grid">
                    <div class="energy-stat-tile">
                        <span class="energy-stat-label">Battery Voltage</span>
                        <span class="energy-stat-value" id="stat-voltage">${this.formatVoltage()}<span class="energy-stat-unit"> V</span></span>
                    </div>
                    <div class="energy-stat-tile">
                        <span class="energy-stat-label">Charge Status</span>
                        <span class="energy-stat-badge ${this.data.charge_type || 'unset'}" id="stat-charge">${this.formatChargeType(this.data.charge_type) || '--'}</span>
                    </div>
                    <div class="energy-stat-tile">
                        <span class="energy-stat-label">Net Power</span>
                        <span class="energy-stat-value ${this.getNetClass()}" id="stat-net">${this.formatNet()}<span class="energy-stat-unit"> W</span></span>
                    </div>
                    <div class="energy-stat-tile ${this.getTimeRemainingClass()}" id="stat-time-tile">
                        <span class="energy-stat-label">Time Remaining</span>
                        <span class="energy-stat-value" id="stat-time">${this.formatTimeRemaining()}</span>
                    </div>
                </div>
            </div>
        `;
    }

    // ── formatting helpers ─────────────────────────────────────

    fmtWatts(w) { return w == null ? '--' : Math.round(w); }
    fmtPct(p) { return p == null ? '--' : Math.round(p); }

    formatChargeType(type) {
        if (!type) return '';
        const types = {
            off: 'Off',
            float: 'Float',
            bulk: 'Bulk',
            absorption: 'Absorption',
            equalize: 'Equalize',
            fault: 'Fault'
        };
        return types[type] || type;
    }

    formatVoltage() {
        return this.data.battery_voltage == null ? '--' : this.data.battery_voltage.toFixed(1);
    }

    formatNet() {
        const solar = this.data.solar_watts;
        const load = this.data.consumption_watts;
        if (solar == null || load == null) return '--';
        const net = Math.round(solar - load);
        return net > 0 ? `+${net}` : String(net);
    }

    getNetClass() {
        const solar = this.data.solar_watts;
        const load = this.data.consumption_watts;
        if (solar == null || load == null) return '';
        return (solar - load) >= 0 ? 'net-positive' : 'net-negative';
    }

    formatTimeRemaining() {
        const minutes = this.data.time_remaining_minutes;
        if (minutes == null) return '--';
        const days = Math.floor(minutes / 1440);
        const hours = Math.floor((minutes % 1440) / 60);
        const mins = Math.floor(minutes % 60);
        if (days > 0) return `${days}d ${hours}h`;
        if (hours > 0) return `${hours}h ${mins}m`;
        return `${mins}m`;
    }

    getTimeRemainingClass() {
        const minutes = this.data.time_remaining_minutes;
        if (minutes == null) return '';
        if (minutes <= 60) return 'critical';
        if (minutes <= 240) return 'warning';
        return '';
    }

    // ── lifecycle ────────────────────────────────────────────────

    markStale() {
        this.data = {
            solar_watts: null,
            battery_percent: null,
            battery_voltage: null,
            charge_type: null,
            time_remaining_minutes: null,
            consumption_watts: null
        };
        this.updateDisplay();
    }

    init(data) {
        if (data) this.data = data;
        this.updateDisplay();

        this.wsHandler = (data) => {
            this.data = data;
            this.updateDisplay();
        };
        wsClient.on('energy', this.wsHandler);

        this.unsubStale = wsClient.onStale('energy', () => this.markStale());
    }

    updateDisplay() {
        // Flow row
        const solarEl = document.getElementById('flow-solar');
        if (solarEl) solarEl.innerHTML = `${this.fmtWatts(this.data.solar_watts)}<span class="energy-flow-unit"> W</span>`;

        const battEl = document.getElementById('flow-battery');
        if (battEl) battEl.innerHTML = `${this.fmtPct(this.data.battery_percent)}<span class="energy-flow-unit"> %</span>`;

        const battLabel = document.getElementById('flow-battery-label');
        if (battLabel) battLabel.textContent = `Battery · ${this.formatChargeType(this.data.charge_type) || '--'}`;

        const battIcon = document.getElementById('flow-battery-icon');
        if (battIcon) battIcon.classList.toggle('low',
            this.data.battery_percent != null && this.data.battery_percent < 20);

        const loadsEl = document.getElementById('flow-loads');
        if (loadsEl) loadsEl.innerHTML = `${this.fmtWatts(this.data.consumption_watts)}<span class="energy-flow-unit"> W</span>`;

        // Stats grid
        const vEl = document.getElementById('stat-voltage');
        if (vEl) vEl.innerHTML = `${this.formatVoltage()}<span class="energy-stat-unit"> V</span>`;

        const chargeEl = document.getElementById('stat-charge');
        if (chargeEl) {
            chargeEl.textContent = this.formatChargeType(this.data.charge_type) || '--';
            chargeEl.className = `energy-stat-badge ${this.data.charge_type || 'unset'}`;
        }

        const netEl = document.getElementById('stat-net');
        if (netEl) {
            netEl.innerHTML = `${this.formatNet()}<span class="energy-stat-unit"> W</span>`;
            netEl.className = `energy-stat-value ${this.getNetClass()}`;
        }

        const timeEl = document.getElementById('stat-time');
        if (timeEl) timeEl.textContent = this.formatTimeRemaining();

        const timeTile = document.getElementById('stat-time-tile');
        if (timeTile) {
            timeTile.classList.remove('warning', 'critical');
            const cls = this.getTimeRemainingClass();
            if (cls) timeTile.classList.add(cls);
        }
    }

    cleanup() {
        if (this.wsHandler) wsClient.off('energy', this.wsHandler);
        if (this.unsubStale) this.unsubStale();
    }
}
