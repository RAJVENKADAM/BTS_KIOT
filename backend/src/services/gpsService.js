const axios = require('axios');
const cron = require('node-cron');
const { pool } = require('../config/db');
// const trackingService = require('./trackingService'); // Remove circular dependency

class GPSService {
  constructor() {
    this.gpsCache = new Map(); // regNo → {latitude, longitude, speed, vehicleStatus, timestamp}
    this.cronJob = null;
    this.GPS_TOKEN = process.env.GPS_TOKEN || '1v7XQwPwhKqcNEZc8m4rarQKqNFubSMJ';
    this.GPS_EMAIL = process.env.GPS_EMAIL || 'kiotcollege@gmail.com';
    this.GPS_API_BASE = 'https://app.gpstrack.in/api/get_current_data';
    this.POLL_INTERVAL_MS = 35000; // 35 seconds to stay safe
    this.STALE_TIMEOUT_MS = 60000; // 60s cache validity
    this.lastFetchTime = 0;
    this.isFetching = false;
    this.retryAfter = 0;
  }

  async fetchGPSData() {
    const now = Date.now();

    // Prevent overlapping requests
    if (this.isFetching) {
      console.log('📡 GPS fetch already in progress, skipping');
      return;
    }

    // Check if we're still in cooldown from rate limit
    if (now < this.retryAfter) {
      console.log(`📡 GPS rate limited, retry after ${new Date(this.retryAfter).toISOString()}`);
      return;
    }

    // Check if last fetch was too recent (shouldn't happen with cron, but safety check)
    if (now - this.lastFetchTime < 30000) {
      console.log('📡 GPS fetch too soon, skipping');
      return;
    }

    this.isFetching = true;
    this.lastFetchTime = now;

    try {
      console.log('📡 Fetching GPS data...');
      const url = `${this.GPS_API_BASE}?token=${this.GPS_TOKEN}&email=${this.GPS_EMAIL}`;
      const response = await axios.get(url, { timeout: 10000 });

      // Check for HTTP 429
      if (response.status === 429) {
        const retryAfter = response.headers['retry-after'];
        this.retryAfter = now + (retryAfter ? parseInt(retryAfter) * 1000 : 30000);
        console.error('❌ GPS API 429 rate limit hit, retry after:', new Date(this.retryAfter).toISOString());
        return;
      }

      // Check for 429 inside response body (GPS API quirk)
      if (response.data?.response === 429) {
        // Extract retry-after from message if available
        const match = response.data.message?.match(/after\s+(\d{1,2}):(\d{2}):(\d{2})/);
        if (match) {
          const [_, hours, mins, secs] = match;
          const retryTime = new Date();
          retryTime.setHours(parseInt(hours), parseInt(mins), parseInt(secs));
          this.retryAfter = retryTime.getTime();
        } else {
          this.retryAfter = now + 30000;
        }
        console.error('❌ GPS API 429 rate limit (in body), retry after:', new Date(this.retryAfter).toISOString());
        console.error('   Message:', response.data.message);
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
            console.warn('Tracking update failed:', trackErr.message);
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
      if (error.response?.status === 429) {
        const retryAfter = error.response.headers['retry-after'];
        this.retryAfter = now + (retryAfter ? parseInt(retryAfter) * 1000 : 30000);
        console.error('❌ GPS API 429 rate limit hit, retry after:', new Date(this.retryAfter).toISOString());
      } else {
        console.error('❌ GPS API Error:', error.message);
      }
    } finally {
      this.isFetching = false;
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

  /**
   * Fetch GPS data filtered by deviceId - for /bus/:busNo backend proxy
   * @param {string} deviceId - Bus device ID
   * @returns {Array} Raw GPS vehicles matching deviceId
   */
  async fetchGPSByDeviceId(deviceId) {
    try {
      const url = `${this.GPS_API_BASE}?token=${this.GPS_TOKEN}&email=${this.GPS_EMAIL}`;
      const response = await axios.get(url, { timeout: 10000 });
      const vehicles = response.data || [];
      
      // Normalize for matching (used by bus controller)
      const normalizedDeviceId = String(deviceId || '').replace(/[^0-9]/g, '');
      return vehicles.filter(v => 
        String(v.deviceId || '').replace(/[^0-9]/g, '') === normalizedDeviceId || 
        v.regNo === deviceId
      );
    } catch (error) {
      console.error('GPS fetch by deviceId error:', error.message);
      return [];
    }
  }

  /**
   * Fetch ALL GPS data without filtering - for bus location matching
   */
  async fetchAllGPSData() {
    try {
      const url = `${this.GPS_API_BASE}?token=${this.GPS_TOKEN}&email=${this.GPS_EMAIL}`;
      const response = await axios.get(url, { timeout: 10000 });
      return response.data || [];
    } catch (error) {
      console.error('GPS fetch all error:', error.message);
      return [];
    }
  }


  startPolling() {
    this.fetchGPSData();
    this.cronJob = cron.schedule('*/35 * * * * *', () => {
      this.fetchGPSData();
    });
    console.log('🚀 GPS Polling started (35s interval)');
  }

  stopPolling() {
    if (this.cronJob) {
      this.cronJob.stop();
    }
    this.gpsCache.clear();
    console.log('🛑 GPS Polling stopped');
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

