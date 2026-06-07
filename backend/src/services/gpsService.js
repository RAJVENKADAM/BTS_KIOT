const axios = require('axios');

class GPSService {
  constructor() {
    this.apiUrl = 'https://app.gpstrack.in/api/get_current_data';
    this.token = process.env.GPS_TOKEN;
    this.email = process.env.GPS_EMAIL;
  }

  // NOTE: user actions must NOT call this service directly.
  // Returns:
  //  - { latitude, longitude, speed, source, providerTimestamp, timestamp }
  //  - null when provider response is invalid/unusable
  async getLocationForBus(deviceId, regNo, { timeoutMs = 10000 } = {}) {
    if (!this.token || !this.email) {
      throw new Error('GPS credentials missing (GPS_TOKEN/GPS_EMAIL).');
    }

    const requestMeta = {
      apiUrl: this.apiUrl,
      device_id: deviceId,
      reg_no: regNo,
    };

    let response;
    try {
      response = await axios.get(this.apiUrl, {
        params: {
          token: this.token,
          email: this.email,
          device_id: deviceId,
          reg_no: regNo,
        },
        timeout: timeoutMs,
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

    const payload = response?.data;
    const providerStatus = payload?.status;
    const providerData = payload?.data;

    // Bug observed: { status: undefined, data: null }
    const hasUsableData = !!providerData;

    if (payload && providerStatus === 'success' && hasUsableData) {
      const data = providerData;
      const latitude = parseFloat(data.latitude);
      const longitude = parseFloat(data.longitude);
      const speed = parseFloat(data.speed) || 0;

      // Basic sanity checks
      if (
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180
      ) {
        return {
          latitude,
          longitude,
          speed,
          source: 'gps',
          providerTimestamp: data.timestamp ? new Date(data.timestamp).toISOString() : null,
          timestamp: Date.now(),
        };
      }

      console.warn('⚠️ GPS API returned success but coordinates invalid:', {
        device_id: deviceId,
        reg_no: regNo,
        latitude,
        longitude,
      });

      return null;
    }

    console.warn('GPS API returned unusable response:', {
      ...requestMeta,
      status: providerStatus,
      has_data: !!providerData,
    });

    return null;
  }
}

module.exports = new GPSService();


