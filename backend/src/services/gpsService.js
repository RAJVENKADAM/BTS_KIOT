const axios = require("axios");

function normalizeLocationResponse(payload) {
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

  if (!Array.isArray(rawList)) return null;
  if (rawList.length === 0) return new Map();

  const pick = (obj, keys) => {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      if (obj[key] !== undefined && obj[key] !== null && obj[key] !== "") {
        return obj[key];
      }
    }
    return undefined;
  };

  const findVal = (obj, keys) => {
    if (!obj || typeof obj !== "object") return undefined;
    for (const key of keys) {
      const value = obj[key];
      if (value !== undefined && value !== null && String(value) !== "") {
        return String(value);
      }
    }
    return undefined;
  };

  const map = new Map();
  const ambiguousKeys = new Set();
  const addLocation = (key, entry) => {
    if (ambiguousKeys.has(key)) return;
    const existing = map.get(key);
    if (!existing) {
      map.set(key, entry);
      return;
    }

    const existingTime = Date.parse(existing.providerTimestamp);
    const nextTime = Date.parse(entry.providerTimestamp);
    if (Number.isFinite(existingTime) && Number.isFinite(nextTime)) {
      if (nextTime > existingTime) map.set(key, entry);
      else if (nextTime === existingTime) {
        const sameLocation =
          existing.latitude === entry.latitude &&
          existing.longitude === entry.longitude &&
          existing.speed === entry.speed;
        if (!sameLocation) {
          map.delete(key);
          ambiguousKeys.add(key);
        }
      }
      return;
    }

    map.delete(key);
    ambiguousKeys.add(key);
  };

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

    const latitude = latitudeRaw !== undefined ? Number(latitudeRaw) : NaN;
    const longitude =
      longitudeRaw !== undefined ? Number(longitudeRaw) : NaN;
    const parsedSpeed =
      speedRaw !== undefined && speedRaw !== null && speedRaw !== ""
        ? Number(speedRaw)
        : 0;
    const speed =
      Number.isFinite(parsedSpeed) && parsedSpeed >= 0 ? parsedSpeed : 0;
    const validCoords =
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      latitude >= -90 &&
      latitude <= 90 &&
      longitude >= -180 &&
      longitude <= 180;
    const deviceId = findVal(item, [
      "deviceId",
      "device_id",
      "deviceID",
      "id",
    ]);
    const regNo = findVal(item, [
      "regNo",
      "reg_no",
      "regno",
      "vehicle_number",
    ]);

    if (!validCoords || (!deviceId && !regNo)) continue;

    const parsedTimestamp = new Date(timestampRaw);
    const providerTimestamp =
      timestampRaw !== undefined &&
      Number.isFinite(parsedTimestamp.getTime())
        ? parsedTimestamp.toISOString()
        : null;
    const entry = {
      deviceId,
      regNo,
      latitude,
      longitude,
      speed,
      source: "gps",
      providerTimestamp,
    };

    if (deviceId) addLocation(deviceId, entry);
    if (regNo) addLocation(`reg:${regNo}`, entry);
  }

  return map.size ? map : null;
}

class GPSService {
  constructor() {
    this.apiUrl = "https://app.gpstrack.in/api/get_current_data";
    this.token = process.env.GPS_TOKEN;
    this.email = process.env.GPS_EMAIL;
  }

  // Fetch the full fleet once per worker cycle. The worker performs all bus
  // matching against this normalized map without making per-bus requests.
  // Returns null for unusable responses and an empty Map for an explicit empty vehicle list.
  async getAllCurrentLocations({ timeoutMs = 10000, signal } = {}) {
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
        ...(signal ? { signal } : {}),
      });
    } catch (err) {
      console.error("GPS API request failed (getAllCurrentLocations)");
      throw err;
    }

    const locationMap = normalizeLocationResponse(response?.data);
    if (!locationMap) {
      console.warn("GPS API returned unusable response (no vehicle list)");
      return null;
    }
    return locationMap;
  }
}

module.exports = new GPSService();
module.exports.normalizeLocationResponse = normalizeLocationResponse;
