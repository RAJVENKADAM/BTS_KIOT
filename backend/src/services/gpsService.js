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
      console.error('GPS API request failed for bus:', regNo || deviceId);
      throw err;
    }

    // Provider payload has shown different shapes in the wild.
    // We normalize a few common variants so the worker can still persist locations.
    const payload = response?.data;

    // Common location containers: payload.data, payload.data.data, payload.data.locations[0]
    let providerData = null;

// CASE 1: API returns array (YOUR CURRENT CASE)
if (Array.isArray(payload?.data)) {
  providerData = payload.data[0];
}

// CASE 2: API returns direct array (your log shows THIS)
else if (Array.isArray(payload)) {
  providerData = payload[0];
}

// CASE 3: normal object formats
else {
  providerData =
    payload?.data?.data ??
    payload?.data?.locations?.[0] ??
    payload?.data?.location ??
    payload?.data;
}
    const candidate = providerData;

    const pick = (obj, keys) => {
      if (!obj || typeof obj !== 'object') return undefined;
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== '') return obj[k];
      }
      return undefined;
    };

    const latitudeRaw = pick(candidate, ['latitude', 'lat', 'Latitude', 'LAT']);
    const longitudeRaw = pick(candidate, ['longitude', 'lng', 'lon', 'Longitude', 'LNG', 'LON']);
    const speedRaw = pick(candidate, ['speed', 'spd', 'Speed']);
    const timestampRaw = pick(candidate, ['timestamp', 'time', 'providerTimestamp', 'ts']);

    const latitude = latitudeRaw !== undefined ? parseFloat(latitudeRaw) : NaN;
    const longitude = longitudeRaw !== undefined ? parseFloat(longitudeRaw) : NaN;
    const speed = speedRaw !== undefined && speedRaw !== null && speedRaw !== '' ? (parseFloat(speedRaw) || 0) : 0;
    const validCoords =
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180;

    if (validCoords) {
      let providerTimestamp = null;
      try {
        if (timestampRaw) providerTimestamp = new Date(timestampRaw).toISOString();
      } catch (_) {}

      return {
        latitude,
        longitude,
        speed,
        source: 'gps',
        providerTimestamp,
        timestamp: Date.now(),
      };
    }

    console.warn('GPS API returned unusable response (no valid coords)');

    return null;
  }
}

module.exports = new GPSService();


