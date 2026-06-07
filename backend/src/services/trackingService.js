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

    this.cycleCounter = 0;

    console.log('🚀 Starting GPS sync scheduler (every 35s)...');

    // run immediately once (optional). still counts as a single cycle.
    this.runCycle().catch((e) => console.error('Initial GPS sync cycle failed:', e.message));

    setInterval(() => {
      this.runCycle().catch((e) => console.error('GPS sync cycle failed:', e.message));
    }, this.syncIntervalMs);
  }

  async runCycle() {
    this.cycleCounter = (this.cycleCounter || 0) + 1;
    const cycleId = this.cycleCounter;
    const cycleStart = new Date();

    console.log(`⏱️ GPS sync cycle #${cycleId} started at ${cycleStart.toISOString()}`);

    if (this.syncLock) {
      console.log(`GPS sync skipped (cycle #${cycleId}) - previous cycle still running`);
      return;
    }

    this.syncLock = true;
    try {
      const buses = await Bus.find({ status: 'active' }).select('_id bus_no gps_device_id reg_no');
      const now = new Date();

      // Fetch GPS data once per bus/device from the provider.
      // Requirement says: fetch GPS provider data only through this scheduler.
      // Provider does not support a true bulk call in current integration, so we fetch per bus inside the cycle.
      console.log(`📋 GPS sync cycle #${cycleId}: active buses to process = ${buses.length}`);

      for (const bus of buses) {
        const busMeta = {
          cycleId,
          bus_id: bus._id?.toString?.() || String(bus._id),
          bus_no: bus.bus_no,
          gps_device_id: bus.gps_device_id,
          reg_no: bus.reg_no,
        };

        try {
          console.log('➡️ Before GPS API call:', busMeta);
          const location = await gpsService.getLocationForBus(bus.gps_device_id, bus.reg_no);
          console.log('⬅️ After GPS API call:', { ...busMeta, location_present: !!location });

          if (location) {
            const updatePayload = {
              latitude: location.latitude,
              longitude: location.longitude,
              speed: location.speed,
              is_online: true,
              source: location.source || 'gps',
              lastSuccessfulGpsUpdate: now,
            };

            console.log('💾 Mongo update (success) payload:', { ...busMeta, updatePayloadKeys: Object.keys(updatePayload) });

            const res = await BusLiveLocation.updateOne(
              { bus_id: bus._id },
              updatePayload,
              { upsert: true }
            );

            console.log('✅ Mongo update (success) result:', {
              ...busMeta,
              matchedCount: res.matchedCount,
              modifiedCount: res.modifiedCount,
              upsertedId: res.upsertedId?._id || null,
              wroteLastSuccessfulGpsUpdate: true,
            });
          } else {
            // Exact skip reason logging
            console.log('⏭️ GPS sync skipped success (provider returned no usable data / offline):', {
              ...busMeta,
              reason: 'GPS provider returned status != success or missing data.data (gpsService returned null)',
            });

            // GPS fetch returned no data -> mark stale/offline but keep previous coords
            // We update status and timestamps, but avoid overwriting lat/lng.
            const updatePayload = {
              is_online: false,
              source: 'gps',
            };

            console.log('💾 Mongo update (offline) payload:', { ...busMeta, updatePayloadKeys: Object.keys(updatePayload) });

            const res = await BusLiveLocation.updateOne(
              { bus_id: bus._id },
              updatePayload,
              { upsert: true }
            );

            console.log('⚠️ Mongo update (offline) result:', {
              ...busMeta,
              matchedCount: res.matchedCount,
              modifiedCount: res.modifiedCount,
              upsertedId: res.upsertedId?._id || null,
              wroteLastSuccessfulGpsUpdate: false,
            });
          }
        } catch (busErr) {
          console.error(`❌ GPS sync error for bus ${bus.bus_no}:`, busErr.message);
          console.log('💾 Mongo update (error/offline) payload:', { ...busMeta, updatePayloadKeys: ['is_online', 'source'] });

          // Mark bus stale/offline; do not crash
          const res = await BusLiveLocation.updateOne(
            { bus_id: bus._id },
            {
              is_online: false,
              source: 'gps',
            },
            { upsert: true }
          );

          console.log('⚠️ Mongo update (error/offline) result:', {
            ...busMeta,
            matchedCount: res.matchedCount,
            modifiedCount: res.modifiedCount,
            upsertedId: res.upsertedId?._id || null,
            wroteLastSuccessfulGpsUpdate: false,
          });
        }
      }

      console.log(`🏁 GPS sync cycle #${cycleId} finished at ${new Date().toISOString()}`);
    } finally {
      this.syncLock = false;
    }
  }
}

module.exports = new BusGpsSyncScheduler();



