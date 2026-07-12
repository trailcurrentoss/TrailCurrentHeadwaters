'use strict';

const fs = require('fs');

// Paths inside the container (mapped from host via volumes)
const THERMAL_ZONE = '/host/sys/class/thermal/thermal_zone0/temp';
const FAN_CUR_STATE = '/host/sys/class/thermal/cooling_device0/cur_state';
const FAN_MAX_STATE = '/host/sys/class/thermal/cooling_device0/max_state';
const PROC_STAT = '/host/proc/stat';
const HOST_ROOT = '/host/root';

function readFileOr(filePath, fallback) {
    try {
        return fs.readFileSync(filePath, 'utf8').trim();
    } catch {
        return fallback;
    }
}

// Previous CPU idle/total for utilization delta calculation
let prevIdle = 0;
let prevTotal = 0;

function getCpuUtilization() {
    const raw = readFileOr(PROC_STAT, null);
    if (!raw) return null;

    // First line: cpu  user nice system idle iowait irq softirq steal
    const line = raw.split('\n')[0];
    const parts = line.split(/\s+/).slice(1).map(Number);
    if (parts.length < 4) return null;

    const idle = parts[3] + (parts[4] || 0); // idle + iowait
    const total = parts.reduce((a, b) => a + b, 0);

    const diffIdle = idle - prevIdle;
    const diffTotal = total - prevTotal;

    prevIdle = idle;
    prevTotal = total;

    if (diffTotal === 0) return 0;
    return Math.round(((diffTotal - diffIdle) / diffTotal) * 100);
}

function readDiskStats() {
    // Bytes on the host root filesystem — statfs walks the actual mounted
    // filesystem at /host/root (bind-mounted from the host's `/`), so this
    // reports the CM5's real disk headroom, not the container overlay's.
    try {
        const s = fs.statfsSync(HOST_ROOT);
        const total = s.bsize * s.blocks;
        // `bavail` is what a non-root process can actually use (excludes
        // the reserved-for-root buffer, typically 5% on ext4). We use
        // bavail for `free` because it matches what most users think of
        // as "free space" (matches `df` output's Avail column).
        const free  = s.bsize * s.bavail;
        // "Used" here follows `df`'s definition: total - free-to-root.
        // That's why used + free doesn't exactly equal total — the
        // difference is the reserved-for-root buffer.
        const used  = total - (s.bsize * s.bfree);
        return { total, used, free };
    } catch {
        return { total: null, used: null, free: null };
    }
}

function readSystemStats() {
    // CPU temperature (millidegrees C → °C)
    const tempRaw = readFileOr(THERMAL_ZONE, null);
    const cpuTempC = tempRaw !== null ? parseFloat(tempRaw) / 1000 : null;

    // Fan speed as percentage
    const curState = readFileOr(FAN_CUR_STATE, null);
    const maxState = readFileOr(FAN_MAX_STATE, null);
    let fanPercent = null;
    if (curState !== null && maxState !== null) {
        const max = parseInt(maxState);
        fanPercent = max > 0 ? Math.round((parseInt(curState) / max) * 100) : 0;
    }

    // CPU utilization (delta since last call)
    const cpuPercent = getCpuUtilization();

    // Disk totals from the host root filesystem
    const disk = readDiskStats();

    return {
        cpu_temp_c: cpuTempC,
        cpu_percent: cpuPercent,
        fan_percent: fanPercent,
        disk_total_bytes: disk.total,
        disk_used_bytes:  disk.used,
        disk_free_bytes:  disk.free,
    };
}

module.exports = { readSystemStats };
