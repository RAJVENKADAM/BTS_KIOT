const { pool } = require('../config/db');
const { getIO } = require('../socket');

const gpsService = require('./gpsService');
const busStateService = require('./busStateService');
const { getBusIdByBusNo } = require('./busIdHelper');

class TrackingService {
  constructor() {
    // In-memory state keyed by bus_id
    // busTrackingState[busId] = { mobile, gps, external_gps, activeSource }
    this.busTrackingState = {};
    this.staleTimeouts = {};
    this.FALLBACK_TIMEOUT = 10000; // 10s for mobile
    this.GPS_STALE_TIMEOUT = 20000; // 20s for GPS
    this.EXTERNAL_GPS_STALE_TIMEOUT = 30000; // 30s for external GPS
  }

  async _busIdFromBusNoOrNull(busNo) {
    if (!busNo) return null;
    return getBusIdByBusNo(busNo);
  }

  async updateMobileLocation(userId, busNo, location) {
    const busId = await this._busIdFromBusNoOrNull(busNo);
    if (!busId) return;

    if (!this.busTrackingState[busId]) {
      this.busTrackingState[busId] = { mobile: null, gps: null, activeSource: 'none' };
    }

    const now = Date.now();
    this.busTrackingState[busId].mobile = { ...location, timestamp: now };
    this.busTrackingState[busId].activeSource = 'mobile';

    await pool.execute('UPDATE buses SET mobile_live = TRUE WHERE id = ?', [busId]);

    this.broadcastLocation(busId);
    this.resetMobileTimeout(busId);
  }

  async updateGpsLocation(deviceId, location) {
    // Map deviceId -> bus_id (via bus table)
    const [busResult] = await pool.execute(
      'SELECT id FROM buses WHERE gps_device_id = ?',
      [deviceId]
    );

    if (busResult.length === 0) return;
    const busId = busResult[0].id;

    if (!this.busTrackingState[busId]) {
      this.busTrackingState[busId] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
    }

    const now = Date.now();
    this.busTrackingState[busId].gps = { ...location, timestamp: now };

    const determineActiveSource = () => {
      if (this.busTrackingState[busId].mobile) return 'mobile';
      if (this.busTrackingState[busId].gps) return 'gps';
      if (this.busTrackingState[busId].external_gps) return 'external_gps';
      return 'none';
    };

    this.busTrackingState[busId].activeSource = determineActiveSource();
    this.broadcastLocation(busId);
    this.resetGpsTimeout(busId);
  }

  async updateExternalGPSLocation(busNo, location) {
    // External GPS currently arrives with regNo/busNo string at API boundary.
    // Convert immediately to bus_id.
    const busId = await this._busIdFromBusNoOrNull(busNo);
    if (!busId) return;

    if (!this.busTrackingState[busId]) {
      this.busTrackingState[busId] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
    }

    const now = Date.now();
    this.busTrackingState[busId].external_gps = { ...location, timestamp: now };

    const determineActiveSource = () => {
      if (this.busTrackingState[busId].mobile) return 'mobile';
      if (this.busTrackingState[busId].gps) return 'gps';
      if (this.busTrackingState[busId].external_gps) return 'external_gps';
      return 'none';
    };

    this.busTrackingState[busId].activeSource = determineActiveSource();
    this.broadcastLocation(busId);
    this.resetExternalGPSTimeout(busId);
  }

  async setMobileTrackingStatus(busNo, active) {
    const busId = await this._busIdFromBusNoOrNull(busNo);
    if (!busId) return;

    if (!this.busTrackingState[busId]) {
      this.busTrackingState[busId] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
    }

    if (active) {
      this.busTrackingState[busId].activeSource = 'mobile';
    } else {
      const determineActiveSource = () => {
        if (this.busTrackingState[busId].gps) return 'gps';
        if (this.busTrackingState[busId].external_gps) return 'external_gps';
        return 'none';
      };
      this.busTrackingState[busId].activeSource = determineActiveSource();
      this.busTrackingState[busId].mobile = null;
    }

    await pool.execute('UPDATE buses SET mobile_live = ? WHERE id = ?', [active, busId]);
    this.broadcastLocation(busId);
  }

  resetMobileTimeout(busId) {
    if (this.staleTimeouts[busId]?.mobile) {
      clearTimeout(this.staleTimeouts[busId].mobile);
    }
    if (!this.staleTimeouts[busId]) this.staleTimeouts[busId] = {};

    this.staleTimeouts[busId].mobile = setTimeout(() => {
      console.log(`Mobile tracking for ${busId} stale, falling back to other sources`);
      this._updateActiveSource(busId);
      this.broadcastLocation(busId);
    }, this.FALLBACK_TIMEOUT);
  }

  resetGpsTimeout(busId) {
    if (this.staleTimeouts[busId]?.gps) {
      clearTimeout(this.staleTimeouts[busId].gps);
    }
    if (!this.staleTimeouts[busId]) this.staleTimeouts[busId] = {};

    this.staleTimeouts[busId].gps = setTimeout(() => {
      console.log(`GPS tracking for ${busId} lost signal`);
      this._updateActiveSource(busId);
      this.broadcastLocation(busId);
    }, this.GPS_STALE_TIMEOUT);
  }

  resetExternalGPSTimeout(busId) {
    if (this.staleTimeouts[busId]?.external_gps) {
      clearTimeout(this.staleTimeouts[busId].external_gps);
    }
    if (!this.staleTimeouts[busId]) this.staleTimeouts[busId] = {};

    this.staleTimeouts[busId].external_gps = setTimeout(() => {
      console.log(`External GPS for ${busId} stale`);
      this._updateActiveSource(busId);
      this.broadcastLocation(busId);
    }, this.EXTERNAL_GPS_STALE_TIMEOUT);
  }

  _updateActiveSource(busId) {
    if (!this.busTrackingState[busId]) return;

    const oldSource = this.busTrackingState[busId].activeSource;

    const determineActiveSource = () => {
      if (this.busTrackingState[busId].mobile?.timestamp > Date.now() - this.FALLBACK_TIMEOUT) return 'mobile';
      if (this.busTrackingState[busId].gps?.timestamp > Date.now() - this.GPS_STALE_TIMEOUT) return 'gps';
      if (this.busTrackingState[busId].external_gps?.timestamp > Date.now() - this.EXTERNAL_GPS_STALE_TIMEOUT) return 'external_gps';
      return 'none';
    };

    this.busTrackingState[busId].activeSource = determineActiveSource();

    if (oldSource !== this.busTrackingState[busId].activeSource) {
      console.log(`Source changed for ${busId}: ${oldSource} → ${this.busTrackingState[busId].activeSource}`);
    }
  }

  broadcastLocation(busId, gpsSignalLost = false) {
    const state = this.busTrackingState[busId];
    const io = getIO();
    if (!io || !state) return;

    const now = Date.now();

    let payload = {
      success: false,
      busId,
      latitude: null,
      longitude: null,
      speed: null,
      status: 'offline',
      source: 'none',
      updatedAt: new Date().toISOString(),
      isStale: false
    };

    if (state.activeSource === 'mobile' && state.mobile && state.mobile.timestamp > now - this.FALLBACK_TIMEOUT) {
      payload = {
        success: true,
        busId,
        latitude: state.mobile.latitude,
        longitude: state.mobile.longitude,
        speed: state.mobile.speed || null,
        status: 'online',
        source: 'mobile',
        updatedAt: new Date(state.mobile.timestamp).toISOString(),
        isStale: false
      };
    } else if (state.activeSource === 'gps' && state.gps && state.gps.timestamp > now - this.GPS_STALE_TIMEOUT) {
      payload = {
        success: true,
        busId,
        latitude: state.gps.latitude,
        longitude: state.gps.longitude,
        speed: state.gps.speed || null,
        status: gpsSignalLost ? 'signal_lost' : 'online',
        source: 'gps',
        updatedAt: new Date(state.gps.timestamp).toISOString(),
        isStale: false
      };
    } else if (state.activeSource === 'external_gps' && state.external_gps && state.external_gps.timestamp > now - this.EXTERNAL_GPS_STALE_TIMEOUT) {
      payload = {
        success: true,
        busId,
        latitude: state.external_gps.latitude,
        longitude: state.external_gps.longitude,
        speed: state.external_gps.speed || null,
        status: 'online',
        source: 'external_gps',
        updatedAt: new Date(state.external_gps.timestamp).toISOString(),
        isStale: false
      };
    }

    io.of('/bus-location').to(`bus_${busId}`).emit('locationUpdate', payload);

    console.log(`📡 Broadcast ${busId}: ${payload.status} (${payload.source}) lat:${payload.latitude?.toFixed(4)}`);

    if (payload.latitude != null && payload.longitude != null) {
      pool.execute(`
        INSERT INTO bus_live_locations (bus_id, latitude, longitude, speed, updated_at)
        VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON DUPLICATE KEY UPDATE
          latitude = VALUES(latitude),
          longitude = VALUES(longitude),
          speed = VALUES(speed),
          updated_at = CURRENT_TIMESTAMP
      `, [busId, payload.latitude, payload.longitude, payload.speed || 0]);

      busStateService.updateBusLocation(busId, payload.latitude, payload.longitude);
    }
  }
}

module.exports = new TrackingService();

