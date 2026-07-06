// Energy page - Solar and battery monitoring
import { EnergyDisplay } from '../components/energy-display.js';

let energyDisplay = null;

export const energyPage = {
    render() {
        return `
            <section class="page-energy">
                <header class="page-heading">
                    <h1 class="page-title">Energy</h1>
                    <span class="page-subtitle">Solar, battery and consumption</span>
                </header>
                <div id="energy-container">
                    <!-- Energy display will be rendered here -->
                </div>
            </section>
        `;
    },

    init() {
        // Energy data arrives via WebSocket from CAN bus — no API fetch needed.
        // Shows "-" until first real data arrives.
        energyDisplay = new EnergyDisplay('energy-container');
        document.getElementById('energy-container').innerHTML = energyDisplay.render();
        energyDisplay.init();
    },

    cleanup() {
        if (energyDisplay) {
            energyDisplay.cleanup();
            energyDisplay = null;
        }
    }
};
