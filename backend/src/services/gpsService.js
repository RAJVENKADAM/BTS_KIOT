const axios = require("axios");

class GPSService {
  constructor() {
    this.apiUrl = "https://app.gpstrack.in/api/get_current_data";
    this.token = process.env.GPS_TOKEN;
    this.email = process.env.GPS_EMAIL;
  }

  // NOTE: user actions must NOT call this service directly.
  // Returns:
  //  - { latitude, longitude, speed, source, providerTimestamp, timestamp }
  //  - null when provider response is invalid/unusable
  async getLocationForBus(deviceId, regNo, { timeoutMs = 10000 } = {}) {
    if (!this.token || !this.email) {
      throw new Error("GPS credentials missing (GPS_TOKEN/GPS_EMAIL).");
    }

    let response;
    try {
      // ⚠️ IMPORTANT: The provider returns an UNUSABLE payload when we send
      // device_id/reg_no params. It only works with just token+email, which
      // returns the FULL list of vehicles as a JSON array. So we fetch the
      // whole list and then filter the matching bus by deviceId/regNo below.
      response = await axios.get(this.apiUrl, {
        params: {
          token: this.token,
          email: this.email,
        },
        timeout: timeoutMs,
      });
    } catch (err) {
      console.error("GPS API request failed for bus:", regNo || deviceId);
      throw err;
    }

    // Provider payload has shown different shapes in the wild.
    // We normalize a few common variants so the worker can still persist locations.
    const payload = response?.data;

    // Build a list of vehicle entries from the common response shapes:
    //   [ {...} ]                          (direct array - YOUR case)
    //   { data: [ {...} ] }
    //   { data: { data: [ {...} ] } }
    //   { data: { locations: [ {...} ] } }
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

    // Helper to read the first non-empty value for a set of possible keys.
    const findVal = (obj, keys) => {
      if (!obj || typeof obj !== "object") return undefined;
      for (const k of keys) {
        const v = obj[k];
        if (v !== undefined && v !== null && String(v) !== "") return String(v);
      }
      return undefined;
    };

    const pick = (obj, keys) => {
      if (!obj || typeof obj !== "object") return undefined;
      for (const k of keys) {
        if (obj[k] !== undefined && obj[k] !== null && obj[k] !== "")
          return obj[k];
      }
      return undefined;
    };

    // Find the bus that matches this device (or reg no as a fallback).
    let candidate = null;
    if (deviceId) {
      candidate =
        rawList.find(
          (v) =>
            findVal(v, ["deviceId", "device_id", "deviceID", "id"]) ===
            String(deviceId),
        ) || null;
    }
    if (!candidate && regNo) {
      candidate =
        rawList.find(
          (v) =>
            findVal(v, ["regNo", "reg_no", "regno", "vehicle_number"]) ===
            String(regNo),
        ) || null;
    }
    // If we still couldn't match, fall back to the first entry (single-bus setups).
    if (!candidate) candidate = rawList[0];

    const latitudeRaw = pick(candidate, ["latitude", "lat", "Latitude", "LAT"]);
    const longitudeRaw = pick(candidate, [
      "longitude",
      "lng",
      "lon",
      "Longitude",
      "LNG",
      "LON",
    ]);
    const speedRaw = pick(candidate, ["speed", "spd", "Speed"]);
    const timestampRaw = pick(candidate, [
      "isoDate",
      "timestamp",
      "time",
      "providerTimestamp",
      "date",
      "ts",
    ]);

    const latitude = latitudeRaw !== undefined ? parseFloat(latitudeRaw) : NaN;
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

    if (validCoords) {
      let providerTimestamp = null;
      try {
        if (timestampRaw)
          providerTimestamp = new Date(timestampRaw).toISOString();
      } catch (_) {}

      return {
        latitude,
        longitude,
        speed,
        source: "gps",
        providerTimestamp,
        timestamp: Date.now(),
      };
    }

    console.warn("GPS API returned unusable response (no valid coords)");

    return null;
  }

  // Fetch the FULL list of vehicles from the provider in ONE request and
  // return a plain object map so the worker can update every bus in a single
  // call. The provider only works with token+email (returns every vehicle at
  // once) and is rate-limited to roughly once per 30s, so call this sparingly.
  // Map keys: deviceId, and also 'reg:' + regNo for lookups by reg number.
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

    const map = {};

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

      if (validCoords && deviceIdStr) {
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

        map[deviceIdStr] = entry;
        if (regNoStr && !map["reg:" + regNoStr]) {
          map["reg:" + regNoStr] = entry;
        }
      }
    }

    return Object.keys(map).length ? map : null;
  }
}

module.exports = new GPSService();
