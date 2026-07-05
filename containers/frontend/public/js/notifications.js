// Local, offline-first alarm notifications for the TrailCurrent PWA.
//
// Delivery path:
//   backend alarms-service → WebSocket (vehicle Wi-Fi) → this module →
//   serviceWorkerRegistration.showNotification() (OS-native banner)
//
// No cloud dependency: everything stays on the vehicle LAN. That's the
// point — the vehicle is often off-grid and cellular is unreliable when
// boondocking. Web Push was rejected as a design because it requires
// internet on both the Headwaters side and the phone side.
//
// The trade-off is iOS/Android suspending a backgrounded PWA after ~30s.
// The Screen Wake Lock API is used to hold the display on while
// notifications are enabled — that keeps the PWA foregrounded, keeps
// the WebSocket alive, and lets alarms fire indefinitely on a
// dashboard-mounted tablet or phone left on charge.

import { API, wsClient } from './api.js';

const STORAGE_KEY = 'alarmPushEnabled';
const ICON_URL = '/icons/icon-192.png';
const BADGE_URL = '/icons/icon-192.png';

let started = false;
let lastActiveKeys = new Set();
let seeded = false;
let wsListener = null;

// Wake lock state (per current tab). Sentinel is auto-released by the OS
// on tab visibility change, so we re-acquire on `visibilitychange`.
let wakeLockSentinel = null;
let wakeLockRequested = false;
let visibilityListener = null;

function alarmKey(a) {
    return `${a.type || ''}:${a.addr ?? ''}:${a.sensor ?? ''}`;
}

export function isSupported() {
    return typeof window !== 'undefined'
        && 'Notification' in window
        && 'serviceWorker' in navigator;
}

export function isWakeLockSupported() {
    return typeof navigator !== 'undefined' && 'wakeLock' in navigator;
}

export function permissionState() {
    if (!isSupported()) return 'unsupported';
    return Notification.permission; // 'default' | 'granted' | 'denied'
}

export function isEnabled() {
    if (!isSupported()) return false;
    if (Notification.permission !== 'granted') return false;
    return localStorage.getItem(STORAGE_KEY) === '1';
}

export function setEnabled(on) {
    if (on) localStorage.setItem(STORAGE_KEY, '1');
    else localStorage.removeItem(STORAGE_KEY);
}

// Ask the browser for permission. Must be called from a user gesture
// so Safari/iOS actually shows the prompt.
export async function requestPermission() {
    if (!isSupported()) return 'unsupported';
    if (Notification.permission === 'granted') return 'granted';
    if (Notification.permission === 'denied') return 'denied';
    try {
        return await Notification.requestPermission();
    } catch (err) {
        console.error('[notifications] requestPermission failed:', err);
        return Notification.permission;
    }
}

async function acquireWakeLock() {
    if (!isWakeLockSupported()) return;
    if (document.visibilityState !== 'visible') return;
    if (wakeLockSentinel) return;
    try {
        wakeLockSentinel = await navigator.wakeLock.request('screen');
        wakeLockSentinel.addEventListener('release', () => {
            wakeLockSentinel = null;
        });
        console.log('[notifications] wake lock acquired');
    } catch (err) {
        // Common: 'NotAllowedError' when tab isn't focused, or hardware
        // constraints. Not fatal — we'll retry on visibilitychange.
        console.warn('[notifications] wake lock request failed:', err && err.message);
    }
}

async function releaseWakeLock() {
    if (!wakeLockSentinel) return;
    try {
        await wakeLockSentinel.release();
    } catch (_) { /* already released */ }
    wakeLockSentinel = null;
}

export async function enableWakeLock() {
    if (!isWakeLockSupported()) return { ok: false, reason: 'unsupported' };
    wakeLockRequested = true;
    if (!visibilityListener) {
        visibilityListener = () => {
            if (!wakeLockRequested) return;
            if (document.visibilityState === 'visible') acquireWakeLock();
        };
        document.addEventListener('visibilitychange', visibilityListener);
    }
    await acquireWakeLock();
    return { ok: !!wakeLockSentinel };
}

export async function disableWakeLock() {
    wakeLockRequested = false;
    if (visibilityListener) {
        document.removeEventListener('visibilitychange', visibilityListener);
        visibilityListener = null;
    }
    await releaseWakeLock();
}

async function showAlarmNotification(alarms) {
    if (!alarms.length) return;
    let title, body;
    if (alarms.length === 1) {
        title = 'Alarm triggered';
        body = alarms[0].label || 'Sensor active';
    } else {
        title = `${alarms.length} alarms triggered`;
        body = alarms.map(a => a.label || 'Sensor').slice(0, 4).join(', ')
            + (alarms.length > 4 ? '…' : '');
    }
    const options = {
        body,
        icon: ICON_URL,
        badge: BADGE_URL,
        tag: 'trailcurrent-alarm',
        renotify: true,
        requireInteraction: false,
        data: { url: '/#alarms' },
    };
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) {
            await reg.showNotification(title, options);
            return { ok: true, via: 'sw' };
        }
        if (typeof Notification === 'function') {
            new Notification(title, options);
            return { ok: true, via: 'direct' };
        }
        return { ok: false, error: 'no notification path' };
    } catch (err) {
        console.error('[notifications] showNotification failed:', err);
        return { ok: false, error: String(err) };
    }
}

function handleAlarmsUpdate(data) {
    const list = (data && Array.isArray(data.active)) ? data.active : [];
    const nowKeys = new Set(list.map(alarmKey));
    const newlyActive = list.filter(a => !lastActiveKeys.has(alarmKey(a)));
    lastActiveKeys = nowKeys;
    if (!seeded) {
        seeded = true;
        return;
    }
    if (!isEnabled()) return;
    if (newlyActive.length > 0) {
        showAlarmNotification(newlyActive);
    }
}

// Idempotent. Seeds baseline from the REST snapshot so the FIRST WS
// transition after connect isn't swallowed as the baseline event.
export async function startAlarmNotifier() {
    if (started) return;
    started = true;
    try {
        const snap = await API.getActiveAlarms();
        const list = (snap && Array.isArray(snap.active)) ? snap.active : [];
        lastActiveKeys = new Set(list.map(alarmKey));
        seeded = true;
    } catch (err) {
        console.error('[notifications] baseline fetch failed:', err);
    }
    wsListener = handleAlarmsUpdate;
    wsClient.on('alarms_update', wsListener);
}

export function stopAlarmNotifier() {
    if (!started) return;
    if (wsListener) wsClient.off('alarms_update', wsListener);
    wsListener = null;
    started = false;
    lastActiveKeys = new Set();
    seeded = false;
}

// One-shot test notification via the service worker — verifies the OS
// display pipeline (permission + SW) independent of the WS/alarm chain.
export async function fireTestNotification() {
    if (!isSupported()) return { ok: false, error: 'notifications-unsupported' };
    if (Notification.permission !== 'granted') return { ok: false, error: 'permission-not-granted' };
    try {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg && reg.showNotification) {
            await reg.showNotification('Test notification', {
                body: 'If you see this, alarm notifications will fire while this device is unlocked.',
                icon: ICON_URL,
                badge: BADGE_URL,
                tag: 'trailcurrent-alarm-test',
                data: { url: '/#alarms' },
            });
            return { ok: true, via: 'sw' };
        }
        new Notification('Test notification', { body: 'Notification pipeline works.' });
        return { ok: true, via: 'direct' };
    } catch (err) {
        console.error('[notifications] fireTestNotification failed:', err);
        return { ok: false, error: String(err) };
    }
}
