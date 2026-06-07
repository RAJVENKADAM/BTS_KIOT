const axios = require('axios');

class GPSService {
  constructor() {
    this.apiUrl = 'https://app.gpstrack.in/api/get_current_data';
    this.token = process.env.GPS_TOKEN;
    this.email = process.env.GPS_EMAIL;
    this.cachedLocations = new Map();
    this.cacheTTL = 30000; // 30 seconds
  }

  // Fetch live location from external GPS API for a single bus/device.
  // NOTE: user actions must NOT call this service directly.
  async getLocationForBus(deviceId, regNo) {
    const response = await axios.get(this.apiUrl, {
      params: {
        token: this.token,
        email: this.email,
        device_id: deviceId,
        reg_no: regNo,
      },
      timeout: 10000,
    });

    if (response.data && response.data.status === 'success' && response.data.data) {
      const data = response.data.data;
      return {
        latitude: parseFloat(data.latitude),
        longitude: parseFloat(data.longitude),
        speed: parseFloat(data.speed) || 0,
        source: 'gps',
        providerTimestamp: data.timestamp ? new Date(data.timestamp).toISOString() : null,
        timestamp: Date.now(),
      };
    }

    return null;
  }
}

module.exports = new GPSService();

