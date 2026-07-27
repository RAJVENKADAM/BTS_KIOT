const Bus = require('../models/Bus');
const BusLiveLocation = require('../models/BusLiveLocation');
const gpsService = require('../services/gpsService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateOnlineStateBasedOnStaleness({ busId, staleThresholdMs }) {
  const doc = await BusLiveLocation.findOne({ bus_id: busId }).select(
    'lastSuccessfulGpsUpdate is_online'
  );

  if (!doc) return;

  const lastSuccess = doc.lastSuccessfulGpsUpdate;
  const now = Date.now();

  const shouldBeOnline =
    !!lastSuccess && now - lastSuccess.getTime() <= staleThresholdMs;

  if (doc.is_online !== shouldBeOnline) {
    await BusLiveLocation.updateOne(
      { bus_id: busId },
      {
        $set: {
          is_online: shouldBeOnline,
        },
      }
    );
  }
}

class GpsSyncWorker {
  constructor() {
    this.started = false;

    // ⚡ 35s cycle (your requirement)
    this.syncIntervalMs = Number(process.env.GPS_SYNC_INTERVAL_MS) || 35000;

    // offline after 3 min no success
    this.staleThresholdMs =
      Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000;

    this.timeoutPerAttemptMs =
      Number(process.env.GPS_PROVIDER_TIMEOUT_MS) || 10000;

    this.syncLock = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    console.log(
      `🚀 GpsSyncWorker started: interval=${this.syncIntervalMs}ms, staleThreshold=${this.staleThresholdMs}ms`
    );

    // immediate run
    this.runCycle().catch((e) =>
      console.error('Initial gpsSyncWorker cycle failed:', e)
    );

    // interval loop
    setInterval(() => {
      this.runCycle().catch((e) =>
        console.error('gpsSyncWorker cycle failed:', e)
      );
    }, this.syncIntervalMs);
  }

  async runCycle() {
    if (this.syncLock) {
      console.log('⏭️ gpsSyncWorker skipped: previous cycle still running');
      return;
    }

    this.syncLock = true;

    const cycleStart = new Date();

    try {
      const buses = await Bus.find({ status: 'active' }).select(
        '_id gps_device_id reg_no'
      );

      console.log(
        `GPS Sync Started - buses=${buses.length}`
      );

      // Fetch all buses concurrently using Promise.allSettled
      const results = await Promise.allSettled(
        buses.map(async (bus) => {
          const busId = bus._id;
          const regNo = bus.reg_no || busId;

          let location = null;

          try {
            location = await gpsService.getLocationForBus(
              bus.gps_device_id,
              bus.reg_no,
              { timeoutMs: this.timeoutPerAttemptMs }
            );
          } catch (err) {
            console.error(
              `Bus ${regNo} Failed: ${err?.message || err}`
            );
            return { busId, regNo, location: null };
          }

          const now = new Date();

          if (location) {
            await BusLiveLocation.updateOne(
              { bus_id: busId },
              {
                $set: {
                  latitude: location.latitude,
                  longitude: location.longitude,
                  speed: location.speed,
                  is_online: true,
                  lastSuccessfulGpsUpdate: now,
                  lastUpdated: now,
                },
              },
              { upsert: true }
            );
            console.log(`Bus ${regNo} Updated`);
          } else {
            // ❗ DO NOT mark offline on failure
            await BusLiveLocation.updateOne(
              { bus_id: busId },
              {
                $set: {
                  lastUpdated: now,
                },
              },
              { upsert: true }
            );
          }

          // 🔵 time-based offline logic (safe)
          try {
            await updateOnlineStateBasedOnStaleness({
              busId,
              staleThresholdMs: this.staleThresholdMs,
            });
          } catch (e) {
            console.error(
              `staleness update failed for ${regNo}: ${e?.message || e}`
            );
          }

          return { busId, regNo, location };
        })
      );

      // Log failed buses individually
      let successCount = 0;
      let failCount = 0;
      for (const result of results) {
        if (result.status === 'fulfilled') {
          successCount++;
        } else {
          failCount++;
          console.error(`Bus ${result.reason?.regNo || 'unknown'} Failed: ${result.reason?.message || result.reason}`);
        }
      }

      console.log(
        `GPS Sync Completed - success=${successCount}, failed=${failCount}`
      );
      console.log(
        `Polling Time: ${new Date() - cycleStart}ms`
      );
    } finally {
      this.syncLock = false;
    }
  }
}

module.exports = new GpsSyncWorker();