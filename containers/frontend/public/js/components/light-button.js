// Light button component
import { API, wsClient } from '../api.js';
import { brightnessModal } from './brightness-modal.js';
import { getIconSvg } from './pdm-icons.js';

export class LightButton {
    constructor(light) {
        this.light = light;
    }

    render() {
        const stateClass = this.light.state ? 'on' : '';
        const iconKey = this.light.icon || 'lightbulb';
        const showBrightness = this.light.type !== 'other' && this.light.source !== 'switchback';
        return `
            <div class="light-btn-wrapper">
                <button class="light-btn ${stateClass}" data-light-id="${this.light.id}" aria-pressed="${this.light.state ? 'true' : 'false'}">
                    ${getIconSvg(iconKey, !!this.light.state)}
                    <span>${this.light.name}</span>
                </button>
                ${showBrightness ? `
                <button class="brightness-trigger" data-light-id="${this.light.id}" title="Adjust brightness" aria-label="Adjust brightness for ${this.light.name}">
                    <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2">
                        <circle cx="12" cy="12" r="3"/>
                        <line x1="12" y1="5" x2="12" y2="3"/>
                        <line x1="12" y1="21" x2="12" y2="19"/>
                        <line x1="5" y1="12" x2="3" y2="12"/>
                        <line x1="21" y1="12" x2="19" y2="12"/>
                        <line x1="7.05" y1="7.05" x2="5.63" y2="5.63"/>
                        <line x1="18.36" y1="18.36" x2="16.95" y2="16.95"/>
                        <line x1="7.05" y1="16.95" x2="5.63" y2="18.36"/>
                        <line x1="18.36" y1="5.64" x2="16.95" y2="7.05"/>
                    </svg>
                </button>` : ''}
            </div>
        `;
    }
}

export class LightsGrid {
    constructor(containerId) {
        this.container = document.getElementById(containerId);
        this.lights = [];
        this.wsHandler = null;
    }

    render(lights) {
        this.lights = lights;
        const anyOn = lights.some(l => l.state);
        return `
            <div class="lights-grid" id="lights-grid">
                ${lights.map(light => new LightButton(light).render()).join('')}
            </div>
            <button class="all-lights-btn ${anyOn ? 'any-on' : ''}" id="all-lights-btn">
                ${anyOn ? 'All Off' : 'All On'}
            </button>
        `;
    }

    async init(lights) {
        this.lights = lights;

        // Initialize brightness modal
        brightnessModal.init();

        const grid = document.getElementById('lights-grid');

        // Setup click handler for light toggle (main button)
        grid.addEventListener('click', async (e) => {
            // Ignore if clicking on brightness trigger
            if (e.target.closest('.brightness-trigger')) return;

            const btn = e.target.closest('.light-btn');
            if (!btn) return;

            const lightId = parseInt(btn.dataset.lightId);
            const light = this.lights.find(l => l.id === lightId);
            if (!light) return;

            const newState = light.state ? 0 : 1;

            try {
                // Send command via API (which publishes to MQTT)
                // Only sends state, not brightness
                await API.setLight(lightId, newState);
                // Note: UI will update when we receive the status via WebSocket
            } catch (error) {
                console.error('Failed to toggle light:', error);
            }
        });

        // Setup click handler for brightness trigger
        grid.addEventListener('click', (e) => {
            const trigger = e.target.closest('.brightness-trigger');
            if (!trigger) return;

            e.stopPropagation();

            const lightId = parseInt(trigger.dataset.lightId);
            const light = this.lights.find(l => l.id === lightId);
            if (!light) return;

            // Open brightness modal
            brightnessModal.open(light, async (id, brightness) => {
                try {
                    // Send brightness change (turns light on with specified brightness)
                    await API.setLightBrightness(id, brightness);
                } catch (error) {
                    console.error('Failed to set brightness:', error);
                }
            });
        });

        // Setup click handler for all on/off button
        const allBtn = document.getElementById('all-lights-btn');
        if (allBtn) {
            allBtn.addEventListener('click', async () => {
                const anyOn = this.lights.some(l => l.state);
                try {
                    await API.setAllLights(anyOn ? 0 : 1);
                } catch (error) {
                    console.error('Failed to set all lights:', error);
                }
            });
        }

        // Subscribe to WebSocket light status updates
        this.wsHandler = (lightData) => {
            this.updateLight(lightData);
        };
        wsClient.on('light', this.wsHandler);
    }

    updateLight(updatedLight) {
        const index = this.lights.findIndex(l => l.id === updatedLight.id);
        if (index > -1) {
            // Merge updated data with existing light data
            this.lights[index] = { ...this.lights[index], ...updatedLight };
        }

        const wrapper = document.querySelector(`.light-btn-wrapper:has(.light-btn[data-light-id="${updatedLight.id}"])`);
        if (!wrapper) return;

        const btn = wrapper.querySelector('.light-btn');
        if (btn) {
            btn.classList.toggle('on', updatedLight.state === 1);
            btn.setAttribute('aria-pressed', updatedLight.state === 1 ? 'true' : 'false');

            // Re-render the icon with correct fill state
            const light = this.lights.find(l => l.id === updatedLight.id);
            const iconKey = light?.icon || 'lightbulb';
            const iconContainer = btn.querySelector('.light-icon');
            if (iconContainer) {
                const temp = document.createElement('div');
                temp.innerHTML = getIconSvg(iconKey, updatedLight.state === 1);
                const newSvg = temp.querySelector('.light-icon');
                if (newSvg) {
                    iconContainer.replaceWith(newSvg);
                }
            }
        }

        // Update all on/off button
        this.updateAllLightsBtn();
    }

    updateAllLightsBtn() {
        const allBtn = document.getElementById('all-lights-btn');
        if (!allBtn) return;
        const anyOn = this.lights.some(l => l.state);
        allBtn.textContent = anyOn ? 'All Off' : 'All On';
        allBtn.classList.toggle('any-on', anyOn);
    }

    cleanup() {
        // Unsubscribe from WebSocket events
        if (this.wsHandler) {
            wsClient.off('light', this.wsHandler);
            this.wsHandler = null;
        }
    }
}
