// Settings > About
// Version + third-party licenses viewer — extracted verbatim from settings.js.

export const aboutGroup = {
    meta: {
        id: 'about',
        title: 'About',
        icon: 'information-circle-outline',
        sub: 'Version, licenses',
    },
    searchIndex: [
        { label: 'App Version',              kw: 'about version overlook progressive web app pwa', anchor: 'about-version' },
        { label: 'Licenses & Attribution',   kw: 'licenses attribution openstreetmap maplibre pmtiles photon valhalla third party',
          anchor: 'show-licenses-btn' },
    ],

    render() {
        return `
            <!-- Third-party licenses + attribution. Same content as the
                 legacy settings.js "Licenses & Attribution" card. -->
            <div class="card settings-item-vertical">
                <div class="settings-item-header">
                    <span class="settings-label">Licenses &amp; Attribution</span>
                    <p class="settings-description">
                        Map data © OpenStreetMap contributors, licensed under ODbL.
                        This app bundles MapLibre GL JS, PMTiles.js, OpenMapTiles styles,
                        Photon, Valhalla, and other third-party components.
                    </p>
                </div>
                <div class="licenses-controls">
                    <button type="button" class="password-submit-btn" id="show-licenses-btn"
                            style="width: auto; padding: 8px 14px;">View third-party licenses</button>
                </div>
                <pre class="licenses-content hidden" id="licenses-content"
                     aria-live="polite" aria-label="Third-party licenses"></pre>
            </div>

            <!-- App Info -->
            <div class="card settings-item" id="about-version" style="flex-direction: column; align-items: flex-start; gap: 10px;">
                <span class="settings-label">About</span>
                <p class="settings-description">Overlook 0.0.20</p>
                <p class="settings-description">A Progressive Web App by TrailCurrent</p>
            </div>
        `;
    },

    init() {
        // Third-party licenses viewer. First click fetches the markdown from
        // /THIRD_PARTY_LICENSES.md and shows it in the <pre> block. Second
        // click hides it again.
        const licensesBtn = document.getElementById('show-licenses-btn');
        const licensesContent = document.getElementById('licenses-content');
        if (licensesBtn && licensesContent) {
            let loaded = false;
            licensesBtn.addEventListener('click', async () => {
                const isHidden = licensesContent.classList.contains('hidden');
                if (!isHidden) {
                    licensesContent.classList.add('hidden');
                    licensesBtn.textContent = 'View third-party licenses';
                    return;
                }
                if (!loaded) {
                    licensesBtn.disabled = true;
                    licensesBtn.textContent = 'Loading…';
                    try {
                        const resp = await fetch('/THIRD_PARTY_LICENSES.md', { cache: 'no-cache' });
                        if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
                        licensesContent.textContent = await resp.text();
                        loaded = true;
                    } catch (err) {
                        licensesContent.textContent = `Could not load THIRD_PARTY_LICENSES.md: ${err.message}\n\nSee the file in the repo root for the full text.`;
                    } finally {
                        licensesBtn.disabled = false;
                    }
                }
                licensesContent.classList.remove('hidden');
                licensesBtn.textContent = 'Hide third-party licenses';
            });
        }
    },

    cleanup() {
        // Listeners attach to elements removed with the mount swap.
    },
};
