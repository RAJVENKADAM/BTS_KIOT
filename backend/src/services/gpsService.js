const axios = require('axios');
const { pool } = require('../config/db');

// Absolute singleton per process to ensure only ONE scheduler loop exists.
const GLOBAL_STATE_KEY = '__BTS_AGEPS_GPS_SINGLE_LOOP__';
if (!global[GLOBAL_STATE_KEY]) {
  global[GLOBAL_STATE_KEY] = {
    running: false,
    lastRequestAt: 0,
    // per-bus cooldown after 429 (min 2–5 minutes, capped)
    busCooldown: new Map(), // busNo -> untilEpochMs
    lastLogAt: 0,
    logThrottleMs: 60 * 1000,
  };
}

class GPSService {
  constructor() {
    this.gpsCache = new Map(); // regNo → {latitude, longitude, speed, vehicleStatus, timestamp}
    this.started = false;
    this.isRunning = false; // anti-overlap lock
    this.loopTimeout = null;
    this.loopVersion = 0;

    // 32s safe interval (must be 30–35s constraint friendly)
    this.POLL_INTERVAL_SAFE_MS = 32000;

    // cooldown caps: after 429, we do NOT immediately retry
    this.MIN_429_COOLDOWN_MS = 2 * 60 * 1000;
    this.MAX_429_COOLDOWN_MS = 5 * 60 * 1000;

    this.GPS_TOKEN = process.env.GPS_TOKEN || '1v7XQwPwhKqcNEZc8m4rarQKqNFubSMJ';
    this.GPS_EMAIL = process.env.GPS_EMAIL || 'kiotcollege@gmail.com';
    this.GPS_API_BASE = 'https://app.gpstrack.in/api/get_current_data';

    // STRICT: AGEPS constraint handled by single scheduler loop.
    // Do not set interval here; use recursive setTimeout.
    this.POLL_INTERVAL_MS = 30000;

    this.STALE_TIMEOUT_MS = 60000; // 60s cache validity
    this.lastFetchTime = 0;
    this.isFetching = false;
    // retryAfter removed from cooldown behavior to prevent long freezes
  }


  async fetchGPSData({ forced = false } = {}) {
    const now = Date.now();
    const g = global[GLOBAL_STATE_KEY];

    // anti-overlap lock
    if (this.isRunning) return;

    // global cooldown between requests (process-wide)
    if (!forced && g.lastRequestAt && now - g.lastRequestAt < this.POLL_INTERVAL_SAFE_MS) {
      return;
    }

    this.isRunning = true;
    this.isFetching = true;
    g.lastRequestAt = now;


    this.isFetching = true;
    this.lastFetchTime = now;

    try {
      // Throttled log to avoid spam
      if (Date.now() - global[GLOBAL_STATE_KEY].lastLogAt > global[GLOBAL_STATE_KEY].logThrottleMs) {
        global[GLOBAL_STATE_KEY].lastLogAt = Date.now();
        console.log('📡 Fetching GPS data...');
      }
      const url = `${this.GPS_API_BASE}?token=${this.GPS_TOKEN}&email=${this.GPS_EMAIL}`;
      const response = await axios.get(url, { timeout: 10000 });

      // Required behavior: DO NOT lock permanently using “future timestamp” cooldown.
      // If GPS responds with 429, we simply let the next 30s cycle handle it.
      if (response.status === 429) {
        console.log(JSON.stringify({ code: 'GPS_SKIPPED', reason: 'GPS_429_HTTP', bus: null }));
        return;
      }

      // Check for 429 inside response body (GPS API quirk)
      if (response.data?.response === 429) {
        console.log(JSON.stringify({ code: 'GPS_SKIPPED', reason: 'GPS_429_BODY', bus: null }));
        return;
      }


      const vehicles = Array.isArray(response.data) ? response.data : [];

      vehicles.forEach(vehicle => {
        const { latitude, longitude, regNo, speed, vehicleStatus } = vehicle;
        if (regNo && latitude && longitude) {
          this.gpsCache.set(regNo.toUpperCase(), {
            latitude: parseFloat(latitude),
            longitude: parseFloat(longitude),
            speed: parseFloat(speed || 0),
            vehicleStatus: vehicleStatus || 'unknown',
            timestamp: now
          });

          // Feed into tracking service (async-safe) - lazy require to avoid circular dependency
          // Update DB via existing trackingService method (NO AGEPS calls inside trackingService).
          try {
            const trackingService = require('./trackingService');
            trackingService.updateExternalGPSLocation(regNo, {
              latitude: parseFloat(latitude),
              longitude: parseFloat(longitude),
              speed: parseFloat(speed || 0),
              status: vehicleStatus,
              timestamp: now
            });
          } catch (trackErr) {
            // silent skip to keep scheduler stable
          }

        }
      });

      // Reset retry after on success
      this.retryAfter = 0;
      console.log(`✅ GPS: ${this.gpsCache.size} active vehicles`);

      // Cleanup stale cache entries
      for (const [regNo, data] of this.gpsCache.entries()) {
        if (now - data.timestamp > this.STALE_TIMEOUT_MS) {
          this.gpsCache.delete(regNo);
        }
      }
    } catch (error) {
      const status = error?.response?.status;
      if (status === 429) {
        // Enforce cooldown: do not immediately retry; min 2 min, cap 5 min
        const retryAfterHeader = error?.response?.headers?.['retry-after'];
        const retryAfterMs = retryAfterHeader ? parseInt(retryAfterHeader, 10) * 1000 : this.MIN_429_COOLDOWN_MS;
        const cooldownMs = Math.min(this.MAX_429_COOLDOWN_MS, Math.max(this.MIN_429_COOLDOWN_MS, retryAfterMs));

        // Since API is per-device and we don't have device mapping at request time,
        // store a process-wide cooldown via lastRequestAt manipulation.
        const until = Date.now() + cooldownMs;
        global[GLOBAL_STATE_KEY].cooldownUntil = until;

        if (Date.now() - global[GLOBAL_STATE_KEY].lastLogAt > global[GLOBAL_STATE_KEY].logThrottleMs) {
          global[GLOBAL_STATE_KEY].lastLogAt = Date.now();
          console.warn(`⚠️ AGEPS 429 rate limit hit. Cooling down for ${Math.round(cooldownMs / 1000)}s`);
        }
        return;
      }

      if (Date.now() - global[GLOBAL_STATE_KEY].lastLogAt > global[GLOBAL_STATE_KEY].logThrottleMs) {
        global[GLOBAL_STATE_KEY].lastLogAt = Date.now();
        console.warn('❌ GPS API Error:', error?.message || error);
      }
    } finally {
      this.isFetching = false;
      this.isRunning = false;
    }
  }

  async getLocationByRegNo(regNo) {
    const data = this.gpsCache.get(regNo.toUpperCase());
    if (!data) return null;

    const now = Date.now();
    const isStale = now - data.timestamp > this.STALE_TIMEOUT_MS;

    // Validate coordinates
    if (Math.abs(data.latitude) > 90 || Math.abs(data.longitude) > 180) {
      console.log('❌ Stale GPS cache invalid coords for', regNo);
      return null;
    }

    return {
      success: true,
      busNo: regNo.toUpperCase(),
      latitude: data.latitude,
      longitude: data.longitude,
      speed: data.speed,
      status: data.vehicleStatus,
      source: 'cache',
      updatedAt: new Date(data.timestamp).toISOString(),
      isStale
    };
  }

  getCachedLocation(busNo) {
    return this.getLocationByRegNo(busNo);
  }

  // IMPORTANT:
  // - This service is the ONLY one that may call the AGEPS API.
  // - All AGEPS API calls happen ONLY inside the single scheduler loop.
  // - Any other exported methods must operate ONLY on the in-memory cache.

  startPolling() {
    const g = global[GLOBAL_STATE_KEY];

    // Absolute singleton guard across the process lifetime.
    if (g.running) {
      console.warn('⚠️ GPS scheduler already running. Skipping duplicate startPolling().');
      return;
    }
    g.running = true;

    // Start the loop only once.
    if (this.started) return;
    this.started = true;

    const loop = () => {
      const cooldownUntil = g.cooldownUntil || 0;
      const now = Date.now();
      const delayMs = cooldownUntil > now
        ? Math.max(0, Math.min(cooldownUntil - now, this.MAX_429_COOLDOWN_MS))
        : this.POLL_INTERVAL_SAFE_MS;

      this.loopTimeout = setTimeout(async () => {
        try {
          await this.fetchGPSData();
        } catch (e) {
          // never crash backend process
        }
        if (g.running) loop();
      }, delayMs);
    };

    // Kick off immediately, then continue via recursive setTimeout.
    loop();

    console.log('🚀 GPS single-loop scheduler started');
  }

  stopPolling() {
    const g = global[GLOBAL_STATE_KEY];
    g.running = false;
    if (this.loopTimeout) clearTimeout(this.loopTimeout);
    this.loopTimeout = null;
    this.gpsCache.clear();
    console.log('🛑 GPS single-loop scheduler stopped');
  }


  /**
   * Get all cached GPS locations as array for listing
   * @returns {Array} [{busNo, latitude, longitude, speed, status, timestamp, ageMs, source}]
   */
  getAllCachedLocations() {
    const now = Date.now();
    const locations = [];
    for (const [busNo, data] of this.gpsCache.entries()) {
      const ageMs = now - data.timestamp;
      const isStale = ageMs > this.STALE_TIMEOUT_MS;
      locations.push({
        success: true,
        busNo: busNo.toUpperCase(),
        latitude: data.latitude,
        longitude: data.longitude,
        speed: data.speed,
        status: data.vehicleStatus || 'unknown',
        source: 'cache',
        updatedAt: new Date(data.timestamp).toISOString(),
        isStale,
        ageMs
      });
    }
    return locations;
  }
}

module.exports = new GPSService();


