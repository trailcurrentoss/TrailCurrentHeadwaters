const express = require('express');
const fs = require('fs');
const path = require('path');
const mqttService = require('../mqtt');

const FIRMWARE_DIR = '/app/firmware';
const OTA_WAIT_MS = 5000;         // Wait for module to start HTTP server after CAN trigger
const OTA_WAIT_WIRELESS_MS = 2000; // Wireless devices are already running — shorter wait

/**
 * Resolve the correct firmware file for a module type, address, and optional target.
 * Resolution order:
 *   1. {type}_{target}_addr{addr}.bin  (Tapper paired to a target device)
 *   2. {type}_addr{addr}.bin           (multi-address module)
 *   3. {type}.bin                      (single-instance module)
 */
function resolveFirmwareFile(type, addr, target) {
    if (target && addr !== undefined && addr !== null) {
        const targetFile = `${type}_${target}_addr${addr}.bin`;
        if (fs.existsSync(path.join(FIRMWARE_DIR, targetFile))) {
            return targetFile;
        }
    }
    if (addr !== undefined && addr !== null) {
        const addrFile = `${type}_addr${addr}.bin`;
        if (fs.existsSync(path.join(FIRMWARE_DIR, addrFile))) {
            return addrFile;
        }
    }
    const singleFile = `${type}.bin`;
    if (fs.existsSync(path.join(FIRMWARE_DIR, singleFile))) {
        return singleFile;
    }
    return null;
}

module.exports = () => {
    const router = express.Router();
    // POST /api/ota/trigger - Trigger OTA update for a device
    // Wired: sends CAN 0x00, waits, then POSTs firmware via HTTP
    // Wireless: sends MQTT local/ota/trigger with hostname, waits, then POSTs firmware via HTTP
    router.post('/trigger', async (req, res) => {
        try {
            let { hostname, firmware_file, type, addr, target, wireless } = req.body;

            // Auto-resolve firmware file from type+addr+target if not explicitly provided
            if (!firmware_file && type) {
                firmware_file = resolveFirmwareFile(type, addr, target);
                if (!firmware_file) {
                    return res.status(404).json({ error: `No firmware found for type=${type} addr=${addr} target=${target}` });
                }
            }

            // Validate hostname format: esp32-XXXXXX where X are hex digits
            const hostnameRegex = /^esp32-([0-9A-Fa-f]{6})$/;
            const match = hostname.match(hostnameRegex);

            if (!match) {
                return res.status(400).json({
                    error: 'Invalid hostname format. Expected format: esp32-XXYYZZ (where XX, YY, ZZ are hex digits)'
                });
            }

            if (!firmware_file || typeof firmware_file !== 'string') {
                return res.status(400).json({ error: 'firmware_file is required' });
            }

            // Validate firmware file exists
            const firmwarePath = path.join(FIRMWARE_DIR, path.basename(firmware_file));
            if (!fs.existsSync(firmwarePath)) {
                return res.status(404).json({ error: `Firmware file not found: ${firmware_file}` });
            }

            const broadcast = req.app.get('broadcast');
            let triggerSuccess;

            if (wireless) {
                // Wireless path: publish hostname to local/ota/trigger MQTT topic
                triggerSuccess = mqttService.publishWirelessOtaTrigger(hostname);
                if (!triggerSuccess) {
                    return res.status(503).json({ error: 'MQTT service not connected' });
                }

                // Respond immediately — firmware upload happens async
                res.json({
                    success: true,
                    message: 'OTA triggered, firmware upload starting',
                    hostname: hostname,
                    firmware_file: firmware_file
                });

                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'triggered', message: 'MQTT trigger sent, waiting for wireless device...' });
                }

                // Wireless devices are already on WiFi — shorter wait before upload
                await new Promise(resolve => setTimeout(resolve, OTA_WAIT_WIRELESS_MS));
            } else {
                // Wired path: send CAN 0x00 trigger via MQTT → CAN bridge
                const macHex = match[1];
                const macBytes = [];
                for (let i = 0; i < 6; i += 2) {
                    macBytes.push(parseInt(macHex.substring(i, i + 2), 16));
                }
                const canData = [macBytes[0], macBytes[1], macBytes[2], 0x00, 0x00, 0x00, 0x00, 0x00];
                triggerSuccess = mqttService.publishCanMessage(0x0, canData);

                if (!triggerSuccess) {
                    return res.status(503).json({ error: 'MQTT service not connected' });
                }

                // Respond immediately — firmware upload happens async
                res.json({
                    success: true,
                    message: 'OTA triggered, firmware upload starting',
                    hostname: hostname,
                    firmware_file: firmware_file
                });

                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'triggered', message: 'CAN trigger sent, waiting for module...' });
                }

                // Wait for wired device to connect to WiFi and start HTTP server
                await new Promise(resolve => setTimeout(resolve, OTA_WAIT_MS));
            }

            // POST firmware binary to module
            try {
                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'uploading', message: 'Uploading firmware...' });
                }

                const firmwareData = fs.readFileSync(firmwarePath);
                const response = await fetch(`http://${hostname}.local/ota`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/octet-stream' },
                    body: firmwareData,
                    signal: AbortSignal.timeout(180000) // 3-minute timeout matches firmware
                });

                if (response.ok) {
                    const text = await response.text();
                    console.log(`[OTA] Firmware uploaded to ${hostname}: ${text}`);

                    if (broadcast) {
                        broadcast('ota_progress', { hostname, status: 'complete', message: 'Firmware uploaded, module rebooting' });
                    }
                } else {
                    const errText = await response.text();
                    console.error(`[OTA] Upload failed for ${hostname}: ${response.status} ${errText}`);
                    if (broadcast) {
                        broadcast('ota_progress', { hostname, status: 'error', message: `Upload failed: ${response.status}` });
                    }
                }
            } catch (uploadErr) {
                console.error(`[OTA] Upload error for ${hostname}:`, uploadErr.message);
                if (broadcast) {
                    broadcast('ota_progress', { hostname, status: 'error', message: uploadErr.message });
                }
            }
        } catch (error) {
            console.error('Error triggering OTA:', error);
            res.status(500).json({ error: 'Failed to trigger OTA update' });
        }
    });

    // GET /api/ota/firmware - List available firmware files
    router.get('/firmware', (req, res) => {
        try {
            if (!fs.existsSync(FIRMWARE_DIR)) {
                return res.json([]);
            }

            const files = fs.readdirSync(FIRMWARE_DIR)
                .filter(f => f.endsWith('.bin'))
                .map(f => {
                    const stats = fs.statSync(path.join(FIRMWARE_DIR, f));
                    return {
                        filename: f,
                        size: stats.size,
                        modified: stats.mtime.toISOString()
                    };
                })
                .sort((a, b) => new Date(b.modified) - new Date(a.modified));

            res.json(files);
        } catch (error) {
            console.error('Error listing firmware:', error);
            res.status(500).json({ error: 'Failed to list firmware files' });
        }
    });

    return router;
};
