// Air Quality page - Indoor air quality monitoring
import { AirQualityDisplay } from '../components/airquality-display.js';

let airqualityDisplay = null;

export const airqualityPage = {
    render() {
        return `
            <section class="page-airquality">
                <div id="airquality-container">
                    <!-- Air quality display will be rendered here -->
                </div>
            </section>
        `;
    },

    init() {
        // Air quality data arrives via WebSocket from CAN bus — no API fetch needed.
        // Shows "-" until first real data arrives.
        airqualityDisplay = new AirQualityDisplay('airquality-container');
        document.getElementById('airquality-container').innerHTML = airqualityDisplay.render();
        airqualityDisplay.init();
    },

    cleanup() {
        if (airqualityDisplay) {
            airqualityDisplay.cleanup();
            airqualityDisplay = null;
        }
    }
};
