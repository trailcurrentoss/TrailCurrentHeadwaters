const fs = require('fs');
const http = require('http');

const NODE_RED_URL = 'http://node-red:1880';
const TEMPLATE_PATH = '/app/config/cloud-workflow.json';
const STARTER_FLOW_PATH = '/app/config/starter-flow.json';
const STARTER_TAB_ID = 'starter_flow_tab_01';
const CLOUD_TAB_ID = 'cloud_workflow_tab_01';
const CLOUD_BROKER_ID = 'cloud_mqtt_broker_01';
const CLOUD_TLS_ID = 'cloud_tls_config_01';

// IDs of cloud-specific config nodes that should be removed with the flow
const CLOUD_CONFIG_IDS = new Set([CLOUD_TAB_ID, CLOUD_BROKER_ID, CLOUD_TLS_ID]);

/**
 * Make an HTTP request and return the parsed JSON response.
 */
function request(method, path, body, headers = {}) {
    return new Promise((resolve, reject) => {
        const url = new URL(path, NODE_RED_URL);
        const options = {
            method,
            hostname: url.hostname,
            port: url.port,
            path: url.pathname,
            headers: { ...headers },
            timeout: 15000,
        };

        if (body) {
            const data = JSON.stringify(body);
            options.headers['Content-Type'] = 'application/json';
            options.headers['Content-Length'] = Buffer.byteLength(data);
        }

        const req = http.request(options, (res) => {
            let chunks = '';
            res.on('data', (chunk) => { chunks += chunk; });
            res.on('end', () => {
                if (res.statusCode >= 400) {
                    reject(new Error(`Node-RED API ${method} ${path} returned ${res.statusCode}: ${chunks}`));
                    return;
                }
                try {
                    resolve(chunks ? JSON.parse(chunks) : null);
                } catch {
                    resolve(chunks);
                }
            });
        });

        req.on('error', reject);
        req.on('timeout', () => { req.destroy(); reject(new Error('Node-RED API request timed out')); });

        if (body) {
            req.write(JSON.stringify(body));
        }
        req.end();
    });
}

/**
 * Authenticate with Node-RED and return an access token.
 */
async function getToken() {
    const username = process.env.NODE_RED_ADMIN_USER;
    const password = process.env.NODE_RED_ADMIN_PASSWORD;

    if (!username || !password) {
        throw new Error('NODE_RED_ADMIN_USER and NODE_RED_ADMIN_PASSWORD must be set');
    }

    const result = await request('POST', '/auth/token', {
        client_id: 'node-red-admin',
        grant_type: 'password',
        scope: '*',
        username,
        password,
    });

    return result.access_token;
}

/**
 * Extract hostname from a URL string.
 * Handles "https://cloud.example.com", "cloud.example.com", etc.
 */
function extractHostname(cloudUrl) {
    if (!cloudUrl) return '';
    try {
        // If it looks like a bare domain, prepend https://
        const urlStr = cloudUrl.includes('://') ? cloudUrl : `https://${cloudUrl}`;
        return new URL(urlStr).hostname;
    } catch {
        // Fall back to stripping protocol/path manually
        return cloudUrl.replace(/^https?:\/\//, '').split('/')[0].split(':')[0];
    }
}

/**
 * Load the cloud workflow template and replace placeholders.
 */
function loadTemplate(cloudDomain, mqttUsername, mqttPassword) {
    const raw = fs.readFileSync(TEMPLATE_PATH, 'utf8');
    const replaced = raw
        .replace(/__CLOUD_DOMAIN__/g, cloudDomain)
        .replace(/__CLOUD_MQTT_USER__/g, mqttUsername || '')
        .replace(/__CLOUD_MQTT_PASS__/g, mqttPassword || '');
    return JSON.parse(replaced);
}

/**
 * Inject the cloud workflow into Node-RED.
 * Merges with existing flows (removes any previous cloud workflow first).
 */
async function injectCloudWorkflow(cloudUrl, mqttUsername, mqttPassword) {
    const cloudDomain = extractHostname(cloudUrl);
    if (!cloudDomain) {
        console.error('[Cloud Workflow] Cannot inject: no cloud domain provided');
        return false;
    }

    console.log(`[Cloud Workflow] Injecting cloud workflow for domain: ${cloudDomain}`);

    const token = await getToken();
    const authHeader = { Authorization: `Bearer ${token}` };

    // Get current flows
    const currentFlows = await request('GET', '/flows', null, authHeader);

    // Remove any existing cloud workflow nodes and config nodes
    const filtered = currentFlows.filter(node =>
        node.z !== CLOUD_TAB_ID && !CLOUD_CONFIG_IDS.has(node.id)
    );

    // Load and merge the new cloud workflow
    const cloudNodes = loadTemplate(cloudDomain, mqttUsername, mqttPassword);
    const merged = [...filtered, ...cloudNodes];

    // Deploy the merged flows
    await request('POST', '/flows', merged, {
        ...authHeader,
        'Node-RED-Deployment-Type': 'full',
    });

    console.log(`[Cloud Workflow] Successfully injected cloud workflow (${cloudNodes.length} nodes)`);
    return true;
}

/**
 * Remove the cloud workflow from Node-RED.
 */
async function removeCloudWorkflow() {
    console.log('[Cloud Workflow] Removing cloud workflow');

    const token = await getToken();
    const authHeader = { Authorization: `Bearer ${token}` };

    // Get current flows
    const currentFlows = await request('GET', '/flows', null, authHeader);

    // Check if cloud workflow exists
    const hasCloudTab = currentFlows.some(node => node.id === CLOUD_TAB_ID);
    if (!hasCloudTab) {
        console.log('[Cloud Workflow] No cloud workflow found, nothing to remove');
        return true;
    }

    // Remove cloud workflow nodes and config nodes
    const filtered = currentFlows.filter(node =>
        node.z !== CLOUD_TAB_ID && !CLOUD_CONFIG_IDS.has(node.id)
    );

    // Deploy the filtered flows
    await request('POST', '/flows', filtered, {
        ...authHeader,
        'Node-RED-Deployment-Type': 'full',
    });

    console.log('[Cloud Workflow] Successfully removed cloud workflow');
    return true;
}

/**
 * Inject with retries (Node-RED may not be ready immediately after startup).
 */
async function injectWithRetry(cloudUrl, mqttUsername, mqttPassword, retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await injectCloudWorkflow(cloudUrl, mqttUsername, mqttPassword);
        } catch (error) {
            console.error(`[Cloud Workflow] Inject attempt ${attempt}/${retries} failed:`, error.message);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    console.error('[Cloud Workflow] All inject attempts failed');
    return false;
}

/**
 * Remove with retries.
 */
async function removeWithRetry(retries = 3) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            return await removeCloudWorkflow();
        } catch (error) {
            console.error(`[Cloud Workflow] Remove attempt ${attempt}/${retries} failed:`, error.message);
            if (attempt < retries) {
                await new Promise(resolve => setTimeout(resolve, 3000));
            }
        }
    }
    console.error('[Cloud Workflow] All remove attempts failed');
    return false;
}

/**
 * Extract the version number from a starter flow tab's info field.
 * Expects "Version: N" as the first line of the info string.
 */
function getFlowVersion(flowTab) {
    if (!flowTab || !flowTab.info) return 0;
    const match = flowTab.info.match(/^Version:\s*(\d+)/);
    return match ? parseInt(match[1], 10) : 0;
}

/**
 * Inject or update the starter flow in Node-RED.
 * On first boot, injects the full starter flow.
 * On subsequent boots, compares version numbers and replaces if the
 * template is newer (preserving other flows like the cloud workflow).
 */
async function injectStarterFlowIfEmpty(retries = 5) {
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const token = await getToken();
            const authHeader = { Authorization: `Bearer ${token}` };

            const currentFlows = await request('GET', '/flows', null, authHeader);

            // Load the starter flow template
            const starterFlow = JSON.parse(fs.readFileSync(STARTER_FLOW_PATH, 'utf8'));
            const templateTab = starterFlow.find(node => node.id === STARTER_TAB_ID);
            const templateVersion = getFlowVersion(templateTab);

            // Check if the starter flow tab is already present
            const existingTab = currentFlows.find(node => node.id === STARTER_TAB_ID);

            if (existingTab) {
                const existingVersion = getFlowVersion(existingTab);
                if (existingVersion >= templateVersion) {
                    console.log(`[Starter Flow] Up to date (version ${existingVersion})`);
                    return true;
                }
                console.log(`[Starter Flow] Updating from version ${existingVersion} to ${templateVersion}`);

                // Remove old starter flow nodes, keep everything else (cloud workflow, etc.)
                const starterNodeIds = new Set(starterFlow.map(n => n.id));
                const filtered = currentFlows.filter(node =>
                    node.z !== STARTER_TAB_ID && !starterNodeIds.has(node.id)
                );
                const merged = [...filtered, ...starterFlow];

                await request('POST', '/flows', merged, {
                    ...authHeader,
                    'Node-RED-Deployment-Type': 'full',
                });

                console.log(`[Starter Flow] Successfully updated to version ${templateVersion} (${starterFlow.length} nodes)`);
                return true;
            }

            // First boot — inject fresh
            const merged = [...currentFlows, ...starterFlow];

            await request('POST', '/flows', merged, {
                ...authHeader,
                'Node-RED-Deployment-Type': 'full',
            });

            console.log(`[Starter Flow] Successfully injected version ${templateVersion} (${starterFlow.length} nodes)`);
            return true;
        } catch (error) {
            console.error(`[Starter Flow] Attempt ${attempt}/${retries} failed:`, error.message);
            if (attempt < retries) {
                // Longer delay on startup — Node-RED may still be booting
                await new Promise(resolve => setTimeout(resolve, 5000));
            }
        }
    }
    console.error('[Starter Flow] All injection attempts failed');
    return false;
}

module.exports = { injectWithRetry, removeWithRetry, injectStarterFlowIfEmpty };
