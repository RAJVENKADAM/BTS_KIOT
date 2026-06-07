const Bus = require('../models/Bus');
const BusLiveLocation = require('../models/BusLiveLocation');
const gpsService = require('../services/gpsService');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function withJitter(ms, jitterRatio = 0.2) {
  const jitter = ms * jitterRatio * (Math.random() * 2 - 1); // +/- jitter
  return Math.max(0, Math.round(ms + jitter));
}

async function updateOnlineStateBasedOnStaleness({ busId, staleThresholdMs }) {
  const doc = await BusLiveLocation.findOne({ bus_id: busId }).select('lastSuccessfulGpsUpdate is_online');
  if (!doc) return;

  const lastSuccess = doc.lastSuccessfulGpsUpdate;
  const now = Date.now();

  // Time-based offline detection (failure-based is avoided).
  // If now - lastSuccessfulGpsUpdate > threshold => offline
  const shouldBeOnline = !!lastSuccess && now - lastSuccess.getTime() <= staleThresholdMs;

  // Only flip is_online if we have an actual change
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
    this.syncIntervalMs = Number(process.env.GPS_SYNC_INTERVAL_MS) || 45000; // 30-60s default

    // Requirement: offline detection based on lastSuccessfulGpsUpdate
    // 2–5 minutes; default 3 minutes.
    this.staleThresholdMs = Number(process.env.GPS_OFFLINE_THRESHOLD_MS) || 3 * 60 * 1000;

    this.maxAttempts = Number(process.env.GPS_PROVIDER_RETRIES) || 3; // 2-3 retries desired
    this.baseBackoffMs = Number(process.env.GPS_PROVIDER_BASE_BACKOFF_MS) || 1000;
    this.timeoutPerAttemptMs = Number(process.env.GPS_PROVIDER_TIMEOUT_MS) || 10000;

    this.syncLock = false;
  }

  start() {
    if (this.started) return;
    this.started = true;

    console.log(
      `🚀 GpsSyncWorker starting: interval=${this.syncIntervalMs}ms, retries=${this.maxAttempts}, staleThreshold=${this.staleThresholdMs}ms`
    );

    // Run immediately and then on interval.
    this.runCycle().catch((e) => console.error('Initial gpsSyncWorker cycle failed:', e));
    setInterval(() => {
      this.runCycle().catch((e) => console.error('gpsSyncWorker cycle failed:', e));
    }, this.syncIntervalMs);
  }

  async runCycle() {
    if (this.syncLock) {
      console.log('gpsSyncWorker skipped: previous cycle still running');
      return;
    }
    this.syncLock = true;

    const cycleStart = new Date();
    const now = new Date();

    try {
      const buses = await Bus.find({ status: 'active' }).select('_id gps_device_id reg_no');
      console.log(`⏱️ gpsSyncWorker cycle started at ${cycleStart.toISOString()} - buses=${buses.length}`);

      for (const bus of buses) {
        const busId = bus._id;
        const busNo = bus.reg_no || bus._id.toString();

        let lastErr = null;
        let location = null;

        for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
          try {
            // gpsService must only be used from this worker.
            location = await gpsService.getLocationForBus(bus.gps_device_id, bus.reg_no, {
              timeoutMs: this.timeoutPerAttemptMs,
            });

            // gpsService returns null on invalid/unknown provider payload.
            if (location) break;
            lastErr = new Error('No valid GPS data returned');
          } catch (err) {
            lastErr = err;
          }

          if (attempt < this.maxAttempts) {
            const backoff = this.baseBackoffMs * Math.pow(2, attempt - 1);
            await sleep(withJitter(backoff));
          }
        }

        if (location) {
          await BusLiveLocation.updateOne(
            { bus_id: busId },
            {
              $set: {
                latitude: location.latitude,
                longitude: location.longitude,
                speed: location.speed,

                // online only on success
                is_online: true,

                lastSuccessfulGpsUpdate: now,

                // update lastUpdated explicitly for your requirement
                lastUpdated: now,
              },
            },
            { upsert: true }
          );
        } else {
          // Do NOT mark offline due to a single failure.
          // Keep latitude/longitude unchanged.
          // Only update lastUpdated to reflect worker heartbeat.
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

        // Time-based offline detection (2–5 minutes), not failure-based.
        // This may flip is_online once data goes stale.
        try {
          await updateOnlineStateBasedOnStaleness({ busId, staleThresholdMs: this.staleThresholdMs });
        } catch (e) {
          console.error(`Failed to update staleness offline state for bus ${busNo}:`, e?.message || e);
        }
      }

      console.log(`🏁 gpsSyncWorker cycle finished at ${new Date().toISOString()}`);
    } finally {
      this.syncLock = false;
    }
  }
}

module.exports = new GpsSyncWorker();

