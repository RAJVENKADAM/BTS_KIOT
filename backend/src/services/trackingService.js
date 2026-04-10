const { pool } = require('../config/db');
const { getIO } = require('../socket');

const gpsService = require('./gpsService');
const busStateService = require('./busStateService');

class TrackingService {
    constructor() {
        // busTrackingState[bus_no] = { 
        //   mobile/gps/external_gps: { lat, lng, speed, heading, timestamp }, 
        //   activeSource: 'mobile' | 'gps' | 'external_gps' | 'none'
        // }
        this.busTrackingState = {};
        this.staleTimeouts = {};
        this.FALLBACK_TIMEOUT = 10000; // 10s for mobile
        this.GPS_STALE_TIMEOUT = 20000; // 20s for GPS
        this.EXTERNAL_GPS_STALE_TIMEOUT = 30000; // 30s for external GPS
    }

    async updateMobileLocation(userId, busNo, location) {
        if (!this.busTrackingState[busNo]) {
            this.busTrackingState[busNo] = { mobile: null, gps: null, activeSource: 'none' };
        }

        const now = Date.now();
        this.busTrackingState[busNo].mobile = { ...location, timestamp: now };

        // Mobile always overrides GPS if active
        this.busTrackingState[busNo].activeSource = 'mobile';

        // Update database for persistence (optional, but requested for some fields)
        await pool.execute(
            'UPDATE buses SET mobile_live = TRUE WHERE bus_no = ?',
            [busNo]
        );

        this.broadcastLocation(busNo);
        this.resetMobileTimeout(busNo);
    }

    async updateGpsLocation(deviceId, location) {
        // Map deviceId to bus_no
        const [busResult] = await pool.execute(
            'SELECT bus_no FROM buses WHERE gps_device_id = ?',
            [deviceId]
        );

        if (busResult.length === 0) return;
        const busNo = busResult[0].bus_no;

        if (!this.busTrackingState[busNo]) {
            this.busTrackingState[busNo] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
        }

        const now = Date.now();
        this.busTrackingState[busNo].gps = { ...location, timestamp: now };

        // Priority: mobile > gps > external_gps
        const determineActiveSource = () => {
            if (this.busTrackingState[busNo].mobile) return 'mobile';
            if (this.busTrackingState[busNo].gps) return 'gps';
            if (this.busTrackingState[busNo].external_gps) return 'external_gps';
            return 'none';
        };
        this.busTrackingState[busNo].activeSource = determineActiveSource();

        this.broadcastLocation(busNo);
        this.resetGpsTimeout(busNo);
    }

    async updateExternalGPSLocation(busNo, location) {
        if (!this.busTrackingState[busNo]) {
            this.busTrackingState[busNo] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
        }

        const now = Date.now();
        this.busTrackingState[busNo].external_gps = { ...location, timestamp: now };

        // Priority: mobile > gps > external_gps
        const determineActiveSource = () => {
            if (this.busTrackingState[busNo].mobile) return 'mobile';
            if (this.busTrackingState[busNo].gps) return 'gps';
            if (this.busTrackingState[busNo].external_gps) return 'external_gps';
            return 'none';
        };
        this.busTrackingState[busNo].activeSource = determineActiveSource();

        this.broadcastLocation(busNo);
        this.resetExternalGPSTimeout(busNo);
    }

    async setMobileTrackingStatus(busNo, active) {
        if (!this.busTrackingState[busNo]) {
            this.busTrackingState[busNo] = { mobile: null, gps: null, external_gps: null, activeSource: 'none' };
        }

        if (active) {
            this.busTrackingState[busNo].activeSource = 'mobile';
        } else {
            // Fallback priority: gps > external_gps > none
            const determineActiveSource = () => {
                if (this.busTrackingState[busNo].gps) return 'gps';
                if (this.busTrackingState[busNo].external_gps) return 'external_gps';
                return 'none';
            };
            this.busTrackingState[busNo].activeSource = determineActiveSource();
            this.busTrackingState[busNo].mobile = null;
        }

        await pool.execute(
            'UPDATE buses SET mobile_live = ? WHERE bus_no = ?',
            [active, busNo]
        );

        this.broadcastLocation(busNo);
    }

    resetMobileTimeout(busNo) {
        if (this.staleTimeouts[busNo]?.mobile) {
            clearTimeout(this.staleTimeouts[busNo].mobile);
        }
        if (!this.staleTimeouts[busNo]) this.staleTimeouts[busNo] = {};

        this.staleTimeouts[busNo].mobile = setTimeout(() => {
            console.log(`Mobile tracking for ${busNo} stale, falling back to other sources`);
            this._updateActiveSource(busNo);
            this.broadcastLocation(busNo);
        }, this.FALLBACK_TIMEOUT);
    }

    resetGpsTimeout(busNo) {
        if (this.staleTimeouts[busNo]?.gps) {
            clearTimeout(this.staleTimeouts[busNo].gps);
        }
        if (!this.staleTimeouts[busNo]) this.staleTimeouts[busNo] = {};

        this.staleTimeouts[busNo].gps = setTimeout(() => {
            console.log(`GPS tracking for ${busNo} lost signal`);
            this._updateActiveSource(busNo);
            this.broadcastLocation(busNo);
        }, this.GPS_STALE_TIMEOUT);
    }

    resetExternalGPSTimeout(busNo) {
        if (this.staleTimeouts[busNo]?.external_gps) {
            clearTimeout(this.staleTimeouts[busNo].external_gps);
        }
        if (!this.staleTimeouts[busNo]) this.staleTimeouts[busNo] = {};

        this.staleTimeouts[busNo].external_gps = setTimeout(() => {
            console.log(`External GPS for ${busNo} stale`);
            this._updateActiveSource(busNo);
            this.broadcastLocation(busNo);
        }, this.EXTERNAL_GPS_STALE_TIMEOUT);
    }

    _updateActiveSource(busNo) {
        if (!this.busTrackingState[busNo]) return;

        const oldSource = this.busTrackingState[busNo].activeSource;
        const determineActiveSource = () => {
            if (this.busTrackingState[busNo].mobile?.timestamp > Date.now() - this.FALLBACK_TIMEOUT) return 'mobile';
            if (this.busTrackingState[busNo].gps?.timestamp > Date.now() - this.GPS_STALE_TIMEOUT) return 'gps';
            if (this.busTrackingState[busNo].external_gps?.timestamp > Date.now() - this.EXTERNAL_GPS_STALE_TIMEOUT) return 'external_gps';
            return 'none';
        };
        this.busTrackingState[busNo].activeSource = determineActiveSource();
        if (oldSource !== this.busTrackingState[busNo].activeSource) {
            console.log(`Source changed for ${busNo}: ${oldSource} → ${this.busTrackingState[busNo].activeSource}`);
        }
    }

    broadcastLocation(busNo, gpsSignalLost = false) {
        const state = this.busTrackingState[busNo];
        const io = getIO();
        if (!io || !state) return;

        const now = Date.now();
        let payload = {
            success: false,
            busNo,
            latitude: null,
            longitude: null,
            speed: null,
            status: 'offline',
            source: 'none',
            updatedAt: new Date().toISOString(),
            isStale: false
        };

        // Determine active location with priority
        if (state.activeSource === 'mobile' && state.mobile && state.mobile.timestamp > now - this.FALLBACK_TIMEOUT) {
            payload = {
                success: true,
                busNo,
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
                busNo,
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
                busNo,
                latitude: state.external_gps.latitude,
                longitude: state.external_gps.longitude,
                speed: state.external_gps.speed || null,
                status: 'online',
                source: 'external_gps',
                updatedAt: new Date(state.external_gps.timestamp).toISOString(),
                isStale: false
            };
        }

        // Emit consistent payload to socket room
        io.of('/bus-location').to(`bus_${busNo}`).emit('locationUpdate', payload);

        console.log(`📡 Broadcast ${busNo}: ${payload.status} (${payload.source}) lat:${payload.latitude?.toFixed(4)}`);

        // Update DB if valid location
        if (payload.latitude != null && payload.longitude != null) {
            pool.execute(`
                INSERT INTO bus_live_locations (bus_no, latitude, longitude, speed, updated_at)
                VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
                ON DUPLICATE KEY UPDATE
                latitude = VALUES(latitude),
                longitude = VALUES(longitude),
                speed = VALUES(speed),
                updated_at = CURRENT_TIMESTAMP
            `, [busNo, payload.latitude, payload.longitude, payload.speed || 0]);

            // Update bus state
            busStateService.updateBusLocation(busNo, payload.latitude, payload.longitude);
        }
    }
}

module.exports = new TrackingService();
