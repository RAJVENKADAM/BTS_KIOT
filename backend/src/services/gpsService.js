const axios = require("axios");

class GPSService {
  constructor() {
    this.apiUrl = "https://app.gpstrack.in/api/get_current_data";
    this.token = process.env.GPS_TOKEN;
    this.email = process.env.GPS_EMAIL;
  }

  // Fetch the full fleet once per worker cycle. The worker performs all bus
  // matching against this normalized map without making per-bus requests.
  // Returns null when the whole response is unusable.
  async getAllCurrentLocations({ timeoutMs = 10000 } = {}) {
    if (!this.token || !this.email) {
      throw new Error("GPS credentials missing (GPS_TOKEN/GPS_EMAIL).");
    }

    let response;
    try {
      response = await axios.get(this.apiUrl, {
        params: {
          token: this.token,
          email: this.email,
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      console.error("GPS API request failed (getAllCurrentLocations)");
      throw err;
    }

    const payload = response?.data;
    const rawList = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.data?.data)
          ? payload.data.data
          : Array.isArray(payload?.data?.locations)
            ? payload.data.locations
            : Array.isArray(payload?.data?.location)
              ? [].concat(payload.data.location)
              : null;

    if (!Array.isArray(rawList) || rawList.length === 0) {
      console.warn("GPS API returned unusable response (no vehicle list)");
      return null;
    }

    const pick = (obj, keys) => {
      if (!obj || typeof obj !== "object") return undefined;
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
          return obj[k];
      }
      return undefined;
    };

    const findVal = (obj, keys) => {
      if (!obj || typeof obj !== "object") return undefined;
      for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && String(v) !== "") return String(v);
      }
      return undefined;
    };

    const map = new Map();

    for (const item of rawList) {
      const latitudeRaw = pick(item, ["latitude", "lat", "Latitude", "LAT"]);
      const longitudeRaw = pick(item, [
        "longitude",
        "lng",
        "lon",
        "Longitude",
        "LNG",
        "LON",
      ]);
      const speedRaw = pick(item, ["speed", "spd", "Speed"]);
      const timestampRaw = pick(item, [
        "isoDate",
        "timestamp",
        "time",
        "providerTimestamp",
        "date",
        "ts",
      ]);

      const latitude =
        latitudeRaw !== undefined ? parseFloat(latitudeRaw) : NaN;
      const longitude =
        longitudeRaw !== undefined ? parseFloat(longitudeRaw) : NaN;
      const speed =
        speedRaw !== undefined && speedRaw !== null && speedRaw !== ""
          ? parseFloat(speedRaw) || 0
          : 0;
      const validCoords =
        Number.isFinite(latitude) &&
        Number.isFinite(longitude) &&
        latitude >= -90 &&
        latitude <= 90 &&
        longitude >= -180 &&
        longitude <= 180;

      const deviceIdStr = findVal(item, [
        "deviceId",
        "device_id",
        "deviceID",
        "id",
      ]);
      const regNoStr = findVal(item, [
        "regNo",
        "reg_no",
        "regno",
        "vehicle_number",
      ]);

      if (validCoords && (deviceIdStr || regNoStr)) {
        let providerTimestamp = null;
        try {
          if (timestampRaw)
            providerTimestamp = new Date(timestampRaw).toISOString();
        } catch (_) {}

        const entry = {
          deviceId: deviceIdStr,
          regNo: regNoStr,
          latitude,
          longitude,
          speed,
          source: "gps",
          providerTimestamp,
          timestamp: Date.now(),
        };

        if (deviceIdStr) map.set(deviceIdStr, entry);
        if (regNoStr && !map.has("reg:" + regNoStr)) {
          map.set("reg:" + regNoStr, entry);
        }
      }
    }

    return map.size ? map : null;
  }
}

module.exports = new GPSService();
