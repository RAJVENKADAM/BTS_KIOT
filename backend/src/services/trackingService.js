const Bus = require('../models/Bus');
const BusLiveLocation = require('../models/BusLiveLocation');
const gpsService = require('./gpsService');

// Background GPS sync scheduler (single loop, 35s)
class BusGpsSyncScheduler {
  constructor() {
    this.syncIntervalMs = 35000;
    this.syncLock = false; // prevent overlapping cycles
    this.started = false;
  }

  async start() {
    if (this.started) return;
    this.started = true;

    console.log('🚀 Starting GPS sync scheduler (every 35s)...');

    // run immediately once (optional). still counts as a single cycle.
    this.runCycle().catch((e) => console.error('Initial GPS sync cycle failed:', e.message));

    setInterval(() => {
      this.runCycle().catch((e) => console.error('GPS sync cycle failed:', e.message));
    }, this.syncIntervalMs);
  }

  async runCycle() {
    if (this.syncLock) {
      console.log('GPS sync skipped (previous cycle still running)');
      return;
    }

    this.syncLock = true;
    try {
      const buses = await Bus.find({ status: 'active' }).select('_id bus_no gps_device_id reg_no');
      const now = new Date();

      // Fetch GPS data once per bus/device from the provider.
      // Requirement says: fetch GPS provider data only through this scheduler.
      // Provider does not support a true bulk call in current integration, so we fetch per bus inside the cycle.
      for (const bus of buses) {
        try {
          const location = await gpsService.getLocationForBus(bus.gps_device_id, bus.reg_no);

          if (location) {
            await BusLiveLocation.updateOne(
              { bus_id: bus._id },
              {
                latitude: location.latitude,
                longitude: location.longitude,
                speed: location.speed,
                is_online: true,
                source: location.source || 'gps',
                lastSuccessfulGpsUpdate: now,
              },
              { upsert: true }
            );
          } else {
            // GPS fetch returned no data -> mark stale/offline but keep previous coords
            // We update status and timestamps, but avoid overwriting lat/lng.
            await BusLiveLocation.updateOne(
              { bus_id: bus._id },
              {
                is_online: false,
                source: 'gps',
              },
              { upsert: true }
            );
          }
        } catch (busErr) {
          console.error(`GPS sync error for bus ${bus.bus_no}:`, busErr.message);
          // Mark bus stale/offline; do not crash
          await BusLiveLocation.updateOne(
            { bus_id: bus._id },
            {
              is_online: false,
              source: 'gps',
            },
            { upsert: true }
          );
        }
      }
    } finally {
      this.syncLock = false;
    }
  }
}

module.exports = new BusGpsSyncScheduler();

