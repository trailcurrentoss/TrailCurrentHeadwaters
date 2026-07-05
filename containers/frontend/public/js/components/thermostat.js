// Thermostat component
import { API, wsClient } from '../api.js';
import { units } from '../services/units.js';

export class Thermostat {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.data = {
            target_temp: null,
            mode: null
        };
        this.wsHandler = null;
        this.unsubStaleThermostat = null;

        this.dataTempAndHumidity = {
            tempInC: null,
            tempInF: null,
            humidity: null
        }
        this.wsTempAndHumidityHandler = null;
        this.unsubStaleTempHumid = null;
    }

    render() {
        const currentTempDisplay = units.formatTemp(this.dataTempAndHumidity.tempInF);
        const targetTempDisplay = units.formatTemp(this.data.target_temp);
        const modeDisplay = this.data.mode || '-';
        const label = units.tempLabel();
        return `
            <div class="thermostat-container">
                <div class="thermostat-dial" id="thermostat-dial">
                    <span class="current-temp">
                        <span id="current-temp">${currentTempDisplay}</span><span class="current-temp-unit" id="current-temp-unit">${label}</span>
                    </span>
                    <span class="target-temp">Target: <span id="target-temp">${targetTempDisplay}</span><span id="target-temp-unit">${label}</span></span>
                    <span class="thermostat-mode" id="thermostat-mode">${modeDisplay}</span>
                </div>
                <div class="thermostat-controls">
                    <button class="temp-btn" id="temp-down" aria-label="Decrease temperature">−</button>
                    <button class="temp-btn" id="temp-up" aria-label="Increase temperature">+</button>
                </div>
            </div>
        `;
    }

    async init() {
        // Fetch initial data
        try {
            const thermostatData = await API.getThermostat();
            if (thermostatData) {
                this.data = thermostatData;
            }
            this.updateDisplay();
        } catch (error) {
            console.error('Failed to fetch thermostat data:', error);
        }

        // Setup event listeners
        document.getElementById('temp-up').addEventListener('click', () => this.adjustTemp(1));
        document.getElementById('temp-down').addEventListener('click', () => this.adjustTemp(-1));

        // Setup WebSocket listener
        this.wsHandler = (data) => {
            if (data) {
                this.data = data;
            }
            this.updateDisplay();
        };
        wsClient.on('thermostat', this.wsHandler);

        this.wsTempAndHumidityHandler = (dataTempAndHumidity) => {
            this.dataTempAndHumidity = dataTempAndHumidity;
            this.updateDisplay();
        }
        wsClient.on('temphumid',this.wsTempAndHumidityHandler);

        this.unsubStaleThermostat = wsClient.onStale('thermostat', () => {
            this.data = { target_temp: null, mode: null };
            this.updateDisplay();
        });
        this.unsubStaleTempHumid = wsClient.onStale('temphumid', () => {
            this.dataTempAndHumidity = { tempInC: null, tempInF: null, humidity: null };
            this.updateDisplay();
        });

        // Re-render on Settings-page unit toggle.
        this.unitsHandler = () => this.updateDisplay();
        units.addEventListener('change', this.unitsHandler);
    }

    updateDisplay() {
        const currentTempEl = document.getElementById('current-temp');
        const targetTempEl = document.getElementById('target-temp');
        const modeEl = document.getElementById('thermostat-mode');
        const dialEl = document.getElementById('thermostat-dial');

        if (currentTempEl) currentTempEl.textContent = units.formatTemp(this.dataTempAndHumidity.tempInF);
        if (targetTempEl) targetTempEl.textContent = units.formatTemp(this.data.target_temp);
        const label = units.tempLabel();
        const curUnitEl = document.getElementById('current-temp-unit');
        const tgtUnitEl = document.getElementById('target-temp-unit');
        if (curUnitEl) curUnitEl.textContent = label;
        if (tgtUnitEl) tgtUnitEl.textContent = label;
        if (modeEl) modeEl.textContent = this.data.mode || '-';

        // Update dial state based on heating/cooling
        if (dialEl) {
            dialEl.classList.remove('heating', 'cooling');
            if (this.data.mode && this.data.mode !== 'off' && this.dataTempAndHumidity.tempInF != null && this.data.target_temp != null) {
                if (this.dataTempAndHumidity.tempInF < this.data.target_temp - 1) {
                    dialEl.classList.add('heating');
                } else if (this.dataTempAndHumidity.tempInF > this.data.target_temp + 1) {
                    dialEl.classList.add('cooling');
                }
            }
        }
    }

    async adjustTemp(delta) {
        // Delta is one step in the user's preferred unit. When the user is
        // in °C, a step of 1C ≈ 1.8F on the backend (which still stores +
        // clamps in °F). Round the F value so target_temp stays an integer.
        const stepF = units.temperature === 'C' ? delta * 9 / 5 : delta;
        const proposed = Math.round((this.data.target_temp || 70) + stepF);
        const newTarget = Math.max(50, Math.min(90, proposed));

        if (newTarget === this.data.target_temp) return;

        try {
            this.data = await API.setThermostat({ target_temp: newTarget });
            this.updateDisplay();
        } catch (error) {
            console.error('Failed to set temperature:', error);
        }
    }

    cleanup() {
        if (this.wsHandler) {
            wsClient.off('thermostat', this.wsHandler);
        }
        if (this.wsTempAndHumidityHandler) {
            wsClient.off('temphumid',this.wsTempAndHumidityHandler);
        }
        if (this.unsubStaleThermostat) this.unsubStaleThermostat();
        if (this.unsubStaleTempHumid) this.unsubStaleTempHumid();
        if (this.unitsHandler) {
            units.removeEventListener('change', this.unitsHandler);
            this.unitsHandler = null;
        }
    }
}
