const { pool } = require('../config/db');

class BusStateService {
    constructor() {
        this.WAITING_THRESHOLD = 5 * 60 * 1000; // 5 minutes
        this.STOPPED_THRESHOLD = 10 * 60 * 1000; // 10 minutes
        this.CHECK_INTERVAL = 60 * 1000; // Check every minute
        this.intervalId = null;
        this.started = false;
    }

    async startTracking() {
        // Singleton per process
        if (this.started) return;
        this.started = true;

        console.log('Starting bus state tracking...');
        this.intervalId = setInterval(() => this.checkAndUpdateStates(), this.CHECK_INTERVAL);
        // Initial check
        await this.checkAndUpdateStates();
    }

    async stopTracking() {
        if (this.intervalId) {
            clearInterval(this.intervalId);
            this.intervalId = null;
        }
    }

    async updateBusLocation(busNo, latitude, longitude) {
        try {
            const now = new Date();
            let repeatCountColumnExists = this.repeatCountColumnExists;

            if (repeatCountColumnExists === undefined) {
                const [columns] = await pool.execute("SHOW COLUMNS FROM bus_states LIKE 'repeat_count'");
                repeatCountColumnExists = columns.length > 0;
                this.repeatCountColumnExists = repeatCountColumnExists;
            }

            const selectSql = repeatCountColumnExists
                ? 'SELECT state, last_latitude, last_longitude, last_coords_time, repeat_count FROM bus_states WHERE bus_no = ?'
                : 'SELECT state, last_latitude, last_longitude, last_coords_time FROM bus_states WHERE bus_no = ?';

            const [currentState] = await pool.execute(selectSql, [busNo]);

            let newState = 'moving';
            let coordsChanged = true;
            let repeatCount = 1;

            if (currentState.length > 0) {
                const state = currentState[0];
                const lastLat = parseFloat(state.last_latitude);
                const lastLng = parseFloat(state.last_longitude);

                // Check if coordinates are the same (within small threshold)
                const latDiff = Math.abs(latitude - lastLat);
                const lngDiff = Math.abs(longitude - lastLng);
                coordsChanged = latDiff > 0.0001 || lngDiff > 0.0001; // ~10 meters difference

                if (!coordsChanged) {
                    repeatCount = repeatCountColumnExists ? ((state.repeat_count || 1) + 1) : 1;
                    if (repeatCount >= 10) {
                        newState = 'stopped';
                    } else if (repeatCount >= 3) {
                        newState = 'waiting';
                    } else {
                        newState = 'moving';
                    }
                } else {
                    repeatCount = 1;
                    newState = 'moving';
                }
            }

            // Update or insert state
            if (repeatCountColumnExists) {
                await pool.execute(`
                    INSERT INTO bus_states (bus_no, state, last_latitude, last_longitude, last_coords_time, repeat_count, state_changed_at)
                    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON DUPLICATE KEY UPDATE
                    state = VALUES(state),
                    last_latitude = VALUES(last_latitude),
                    last_longitude = VALUES(last_longitude),
                    repeat_count = VALUES(repeat_count),
                    last_coords_time = ${coordsChanged ? 'VALUES(last_coords_time)' : 'last_coords_time'},
                    state_changed_at = IF(VALUES(state) != state, CURRENT_TIMESTAMP, state_changed_at),
                    updated_at = CURRENT_TIMESTAMP
                `, [busNo, newState, latitude, longitude, coordsChanged ? now : null, repeatCount]);
            } else {
                await pool.execute(`
                    INSERT INTO bus_states (bus_no, state, last_latitude, last_longitude, last_coords_time, state_changed_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
                    ON DUPLICATE KEY UPDATE
                    state = VALUES(state),
                    last_latitude = VALUES(last_latitude),
                    last_longitude = VALUES(last_longitude),
                    last_coords_time = ${coordsChanged ? 'VALUES(last_coords_time)' : 'last_coords_time'},
                    state_changed_at = IF(VALUES(state) != state, CURRENT_TIMESTAMP, state_changed_at),
                    updated_at = CURRENT_TIMESTAMP
                `, [busNo, newState, latitude, longitude, coordsChanged ? now : null]);
            }

            console.log(`Bus ${busNo} state: ${newState} (${coordsChanged ? 'coords changed' : 'coords same'})`);

        } catch (error) {
            console.error('Error updating bus state:', error);
        }
    }

    async checkAndUpdateStates() {
        try {
            // Get all active buses with their last location
            const [buses] = await pool.execute(`
                SELECT bs.bus_no, bs.state, bs.last_latitude, bs.last_longitude, bs.last_coords_time,
                       bll.latitude, bll.longitude, bll.updated_at
                FROM bus_states bs
                LEFT JOIN bus_live_locations bll ON bs.bus_no = bll.bus_no
                JOIN buses b ON bs.bus_no = b.bus_no
                WHERE b.status = 'active'
            `);

            const now = new Date();

            for (const bus of buses) {
                let newState = bus.state;
                let coordsChanged = false;

                // Use live location if available and recent
                const liveLat = bus.latitude;
                const liveLng = bus.longitude;
                const liveTime = bus.updated_at;

                if (liveLat && liveLng && liveTime) {
                    const lastLat = parseFloat(bus.last_latitude);
                    const lastLng = parseFloat(bus.last_longitude);

                    const latDiff = Math.abs(liveLat - lastLat);
                    const lngDiff = Math.abs(liveLng - lastLng);
                    coordsChanged = latDiff > 0.0001 || lngDiff > 0.0001;

                    if (!coordsChanged && bus.last_coords_time) {
                        const timeSinceLastChange = now - new Date(bus.last_coords_time);
                        if (timeSinceLastChange >= this.STOPPED_THRESHOLD) {
                            newState = 'stopped';
                        } else if (timeSinceLastChange >= this.WAITING_THRESHOLD) {
                            newState = 'waiting';
                        }
                    } else if (coordsChanged) {
                        newState = 'moving';
                    }
                } else if (bus.last_coords_time) {
                    // No live location, check if we should change state based on time
                    const timeSinceLastChange = now - new Date(bus.last_coords_time);
                    if (timeSinceLastChange >= this.STOPPED_THRESHOLD && bus.state !== 'stopped') {
                        newState = 'stopped';
                    }
                }

                // Update if state changed
                if (newState !== bus.state) {
                    await pool.execute(`
                        UPDATE bus_states
                        SET state = ?, state_changed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
                        WHERE bus_no = ?
                    `, [newState, bus.bus_no]);

                    console.log(`Bus ${bus.bus_no} state updated to: ${newState}`);
                }

                // Update coordinates if live location is newer
                if (liveLat && liveLng && (!bus.last_coords_time || new Date(liveTime) > new Date(bus.last_coords_time))) {
                    await pool.execute(`
                        UPDATE bus_states
                        SET last_latitude = ?, last_longitude = ?, last_coords_time = ?, updated_at = CURRENT_TIMESTAMP
                        WHERE bus_no = ?
                    `, [liveLat, liveLng, liveTime, bus.bus_no]);
                }
            }

        } catch (error) {
            console.error('Error checking bus states:', error);
        }
    }

    async getBusState(busNo) {
        try {
            const [rows] = await pool.execute(
                'SELECT state, last_latitude, last_longitude, last_coords_time, state_changed_at FROM bus_states WHERE bus_no = ?',
                [busNo]
            );

            if (rows.length > 0) {
                return rows[0];
            }
            return {
                state: 'moving',
                last_latitude: null,
                last_longitude: null,
                last_coords_time: null,
                state_changed_at: null
            };
        } catch (error) {
            console.error('Error getting bus state:', error);
            return {
                state: 'moving',
                last_latitude: null,
                last_longitude: null,
                last_coords_time: null,
                state_changed_at: null
            };
        }
    }

    async getAllBusStates() {
        try {
            const [rows] = await pool.execute(`
                SELECT bs.bus_no, bs.state, bs.last_coords_time, bs.state_changed_at,
                       b.preview_number
                FROM bus_states bs
                JOIN buses b ON bs.bus_no = b.bus_no
                WHERE b.status = 'active'
                ORDER BY b.bus_no
            `);

            return rows;
        } catch (error) {
            console.error('Error getting all bus states:', error);
            return [];
        }
    }
}

module.exports = new BusStateService();