// Air quality display component
import { wsClient } from '../api.js';

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
        }
        this.wsTempAndHumidityHandler = null;
        this.unsubStaleTempHumid = null;
    }

    render() {
        const tempDisplay = this.dataTempAndHumidity.tempInF != null ? Math.round(this.dataTempAndHumidity.tempInF) : '-';
        const humidityDisplay = this.dataTempAndHumidity.humidity != null ? Math.round(this.dataTempAndHumidity.humidity) : '-';
        const tvocDisplay = this.data.tvoc_ppb != null ? Math.round(this.data.tvoc_ppb) : '-';
        const eco2Display = this.data.eco2_ppm != null ? Math.round(this.data.eco2_ppm) : '-';
        return `
            <div class="airquality-container">
                <!-- Temperature -->
                <div class="card airquality-card">
                    <svg class="airquality-icon temp" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M14 14.76V3.5a2.5 2.5 0 0 0-5 0v11.26a4.5 4.5 0 1 0 5 0z"/>
                    </svg>
                    <div class="airquality-info">
                        <span class="airquality-value" id="temp-value">${tempDisplay}<span class="airquality-unit">°F</span></span>
                        <span class="airquality-label">Temperature</span>
                    </div>
                </div>

                <!-- Humidity -->
                <div class="card airquality-card">
                    <svg class="airquality-icon humidity" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M12 2.69l5.66 5.66a8 8 0 1 1-11.31 0z"/>
                    </svg>
                    <div class="airquality-info">
                        <span class="airquality-value" id="humidity-value">${humidityDisplay}<span class="airquality-unit">%</span></span>
                        <span class="airquality-label">Humidity</span>
                    </div>
                </div>
                <!-- TVOC -->
                <div class="card airquality-card ${this.getTvocClass()}">
                    <svg class="airquality-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M9.59 4.59A2 2 0 1 1 11 8H2m10.59 11.41A2 2 0 1 0 14 16H2m15.73-8.27A2.5 2.5 0 1 1 19.5 12H2"/>
                    </svg>
                    <div class="airquality-info">
                        <span class="airquality-value" id="tvoc-value">${tvocDisplay}<span class="airquality-unit">ppb</span></span>
                        <span class="airquality-label">TVOC</span>
                        <span class="airquality-badge ${this.getTvocClass()}" id="tvoc-badge" ${this.data.tvoc_ppb == null ? 'style="display:none"' : ''}>${this.getTvocLabel()}</span>
                    </div>
                </div>

                <!-- eCO2 -->
                <div class="card airquality-card ${this.getEco2Class()}">
                    <svg class="airquality-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M17.5 19H9a7 7 0 1 1 6.71-9h1.79a4.5 4.5 0 1 1 0 9Z"/>
                    </svg>
                    <div class="airquality-info">
                        <span class="airquality-value" id="eco2-value">${eco2Display}<span class="airquality-unit">ppm</span></span>
                        <span class="airquality-label">eCO₂</span>
                        <span class="airquality-badge ${this.getEco2Class()}" id="eco2-badge" ${this.data.eco2_ppm == null ? 'style="display:none"' : ''}>${this.getEco2Label()}</span>
                    </div>
                </div>
            </div>
        `;
    }

    getTvocClass() {
        const tvoc = this.data.tvoc_ppb;
        if (tvoc == null) return '';
        if (tvoc < 65) return 'good';
        if (tvoc < 220) return 'moderate';
        if (tvoc < 660) return 'sensitive';
        return 'unhealthy';
    }

    getTvocLabel() {
        const tvoc = this.data.tvoc_ppb;
        if (tvoc == null) return '';
        if (tvoc < 65) return 'Excellent';
        if (tvoc < 220) return 'Good';
        if (tvoc < 660) return 'Moderate';
        if (tvoc < 2200) return 'Poor';
        return 'Unhealthy';
    }

    getEco2Class() {
        const eco2 = this.data.eco2_ppm;
        if (eco2 == null) return '';
        if (eco2 < 400) return 'good';
        if (eco2 < 1000) return 'good';
        if (eco2 < 2000) return 'sensitive';
        return 'unhealthy';
    }

    getEco2Label() {
        const eco2 = this.data.eco2_ppm;
        if (eco2 == null) return '';
        if (eco2 < 400) return 'Low';
        if (eco2 < 1000) return 'Normal';
        if (eco2 < 2000) return 'High';
        return 'Alarm';
    }

    init(data, dataTempAndHumidity) {
        if (data) this.data = data;
        if (dataTempAndHumidity) this.dataTempAndHumidity = dataTempAndHumidity;
        this.updateDisplay();
        this.updateTempAndHumidity();

        // Setup WebSocket listener
        this.wsHandler = (data) => {
            this.data = data;
            this.updateDisplay();
        };
        wsClient.on('airquality', this.wsHandler);

        this.wsTempAndHumidityHandler = (dataTempAndHumidity) => {
            this.dataTempAndHumidity = dataTempAndHumidity;
            this.updateTempAndHumidity();
        }
        wsClient.on('temphumid',this.wsTempAndHumidityHandler);

        this.unsubStaleAir = wsClient.onStale('airquality', () => {
            this.data = { tvoc_ppb: null, eco2_ppm: null };
            this.updateDisplay();
        });
        this.unsubStaleTempHumid = wsClient.onStale('temphumid', () => {
            this.dataTempAndHumidity = { tempInC: null, tempInF: null, humidity: null };
            this.updateTempAndHumidity();
        });
    }

    updateTempAndHumidity() {
        const tempValue = document.getElementById('temp-value');
        const humidityValue = document.getElementById('humidity-value');

        if (tempValue) {
            tempValue.innerHTML = this.dataTempAndHumidity.tempInF != null
                ? `${Math.round(this.dataTempAndHumidity.tempInF)}<span class="airquality-unit">°F</span>`
                : `-<span class="airquality-unit">°F</span>`;
        }

        if (humidityValue) {
            humidityValue.innerHTML = this.dataTempAndHumidity.humidity != null
                ? `${Math.round(this.dataTempAndHumidity.humidity)}<span class="airquality-unit">%</span>`
                : `-<span class="airquality-unit">%</span>`;
        }
    }

    updateDisplay() {
        const tvocValue = document.getElementById('tvoc-value');
        const tvocBadge = document.getElementById('tvoc-badge');
        const eco2Value = document.getElementById('eco2-value');
        const eco2Badge = document.getElementById('eco2-badge');

        if (tvocValue) {
            tvocValue.innerHTML = this.data.tvoc_ppb != null
                ? `${Math.round(this.data.tvoc_ppb)}<span class="airquality-unit">ppb</span>`
                : `-<span class="airquality-unit">ppb</span>`;
        }
        if (tvocBadge) {
            tvocBadge.textContent = this.getTvocLabel();
            tvocBadge.className = `airquality-badge ${this.getTvocClass()}`;
            tvocBadge.style.display = this.data.tvoc_ppb != null ? '' : 'none';
        }

        if (eco2Value) {
            eco2Value.innerHTML = this.data.eco2_ppm != null
                ? `${Math.round(this.data.eco2_ppm)}<span class="airquality-unit">ppm</span>`
                : `-<span class="airquality-unit">ppm</span>`;
        }
        if (eco2Badge) {
            eco2Badge.textContent = this.getEco2Label();
            eco2Badge.className = `airquality-badge ${this.getEco2Class()}`;
            eco2Badge.style.display = this.data.eco2_ppm != null ? '' : 'none';
        }
        // Update card classes for TVOC
        const tvocCard = document.querySelector('.airquality-card:nth-child(3)');
        if (tvocCard) {
            tvocCard.className = `card airquality-card ${this.getTvocClass()}`;
        }

        // Update card classes for eCO2
        const eco2Card = document.querySelector('.airquality-card:nth-child(4)');
        if (eco2Card) {
            eco2Card.className = `card airquality-card ${this.getEco2Class()}`;
        }
    }

    cleanup() {
        if (this.wsHandler) {
            wsClient.off('airquality', this.wsHandler);
        }
        if (this.wsTempAndHumidityHandler) {
            wsClient.off('temphumid', this.wsTempAndHumidityHandler);
        }
        if (this.unsubStaleAir) this.unsubStaleAir();
        if (this.unsubStaleTempHumid) this.unsubStaleTempHumid();
    }
}
