const axios = require('axios');

class GPSService {
  constructor() {
    this.apiUrl = 'https://app.gpstrack.in/api/get_current_data';
    this.token = '1v7XQwPwhKqcNEZc8m4rarQKqNFubSMJ';
    this.email = 'kiotcollege@gmail.com';
    this.cachedLocations = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  // Fetch live location from external GPS API based on deviceId and regNo
  async getLocationForBus(deviceId, regNo) {
    try {
      const response = await axios.get(this.apiUrl, {
        params: {
          token: this.token,
          email: this.email,
          device_id: deviceId,
          reg_no: regNo
        },
        timeout: 10000
      });

      if (response.data && response.data.status === 'success') {
        const data = response.data.data;
        return {
          latitude: parseFloat(data.latitude),
          longitude: parseFloat(data.longitude),
          speed: parseFloat(data.speed) || 0,
          status: 'online',
          timestamp: Date.now(),
          source: 'gps',
          isOnline: true
        };
      }

      return null;
    } catch (error) {
      console.error(`GPS API error for device ${deviceId}:`, error.message);
      return null;
    }
  }

  // Cache location
  cacheLocation(busNo, locationData) {
    this.cachedLocations.set(busNo, {
      ...locationData,
      cachedAt: Date.now()
    });
  }

  // Get cached location if fresh
  getCachedLocation(busNo) {
    const cached = this.cachedLocations.get(busNo);
    if (cached && Date.now() - cached.cachedAt < this.cacheTTL) {
      return cached;
    }
    this.cachedLocations.delete(busNo);
    return null;
  }

  // Get all cached locations
  getAllCachedLocations() {
    const now = Date.now();
    const fresh = [];
    for (const [busNo, data] of this.cachedLocations) {
      if (now - data.cachedAt < this.cacheTTL) {
        fresh.push({ busNo, ...data });
      } else {
        this.cachedLocations.delete(busNo);
      }
    }
    return fresh;
  }
}

module.exports = new GPSService();
