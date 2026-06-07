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
    const requestMeta = {
      apiUrl: this.apiUrl,
      device_id: deviceId,
      reg_no: regNo,
      email_set: !!this.email,
      token_set: !!this.token,
    };

    console.log('📡 GPS API request:', requestMeta);

    let response;
    try {
      response = await axios.get(this.apiUrl, {
        params: {
          token: this.token,
          email: this.email,
          device_id: deviceId,
          reg_no: regNo,
        },
        timeout: 10000,
      });
    } catch (err) {
      const status = err?.response?.status;
      const data = err?.response?.data;
      console.error('❌ GPS API request failed:', {
        device_id: deviceId,
        reg_no: regNo,
        apiUrl: this.apiUrl,
        status,
        errorMessage: err?.message,
        responseData: data ? String(data).slice(0, 500) : null,
      });
      throw err;
    }

    const status = response?.data?.status;
    const hasData = !!response?.data?.data;
    console.log('📥 GPS API response meta:', {
      device_id: deviceId,
      reg_no: regNo,
      status,
      has_data: hasData,
    });

    if (response.data && response.data.status === 'success' && response.data.data) {
      const data = response.data.data;
      const latitude = parseFloat(data.latitude);
      const longitude = parseFloat(data.longitude);
      const speed = parseFloat(data.speed) || 0;

      console.log('✅ GPS API parsed location:', {
        device_id: deviceId,
        reg_no: regNo,
        latitude,
        longitude,
        speed,
        providerTimestamp: data.timestamp || null,
      });

      return {
        latitude,
        longitude,
        speed,
        source: 'gps',
        providerTimestamp: data.timestamp ? new Date(data.timestamp).toISOString() : null,
        timestamp: Date.now(),
      };
    }

    // Exact reason will be logged by scheduler based on returned null.
    return null;
  }
}

module.exports = new GPSService();

