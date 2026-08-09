const Bus = require("../models/Bus");
const BusLiveLocation = require("../models/BusLiveLocation");
const gpsService = require("../services/gpsService");
const { getIO } = require("../socket");

async function updateOnlineStateBasedOnStaleness({ busId, staleThresholdMs }) {
  const doc = await BusLiveLocation.findOne({ bus_id: busId }).select(
    "lastSuccessfulGpsUpdate is_online",
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
      },
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
      `🚀 GpsSyncWorker started: interval=${this.syncIntervalMs}ms, staleThreshold=${this.staleThresholdMs}ms`,
    );

    // immediate run
    this.runCycle().catch((e) =>
      console.error("Initial gpsSyncWorker cycle failed:", e),
    );

    // interval loop
    setInterval(() => {
      this.runCycle().catch((e) =>
        console.error("gpsSyncWorker cycle failed:", e),
      );
    }, this.syncIntervalMs);
  }

  async runCycle() {
    if (this.syncLock) {
      console.log("⏭️ gpsSyncWorker skipped: previous cycle still running");
      return;
    }

    this.syncLock = true;

    const cycleStart = new Date();

    try {
      const buses = await Bus.find({ status: "active" }).select(
        "_id gps_device_id reg_no bus_no preview_number",
      );

      console.log(`GPS Sync Started - buses=${buses.length}`);

      // 🔥 Fetch the FULL vehicle list from the provider in ONE request.
      // The provider is rate-limited to roughly once per 30s and only works
      // with token+email (returns ALL vehicles at once), so we must NOT call
      // it once per bus. We then match each local bus by deviceId/regNo.
      let locationMap = null;
      try {
        locationMap = await gpsService.getAllCurrentLocations({
          timeoutMs: this.timeoutPerAttemptMs,
        });
      } catch (err) {
        console.error(`GPS bulk fetch failed: ${err?.message || err}`);
      }

      const now = new Date();
      let successCount = 0;
      let failCount = 0;

      for (const bus of buses) {
        const busId = bus._id;
        const regNo = bus.reg_no || busId;

        // Lookup by deviceId, then by regNo ('reg:' + regNo).
        let location = locationMap
          ? locationMap[String(bus.gps_device_id)] ||
            (bus.reg_no ? locationMap["reg:" + bus.reg_no] : null) ||
            null
          : null;

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
            { upsert: true },
          );
          successCount++;
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
            { upsert: true },
          );
          failCount++;
          console.error(
            `Bus ${regNo} Failed: no matching location in provider response`,
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
            `staleness update failed for ${regNo}: ${e?.message || e}`,
          );
        }

        // 🔴 Push the freshly-updated DB location to all clients in the bus room.
        // This lets the frontend refresh the marker from the DB without making
        // an HTTP API call (avoids the rate-limited GPS provider).
        try {
          const freshDoc = await BusLiveLocation.findOne({ bus_id: busId });
          const io = getIO();
          if (io && bus.bus_no) {
            const busNo = bus.bus_no;
            io.to(`bus_${String(busNo).toUpperCase()}`).emit("locationUpdate", {
              busNo,
              bus_no: busNo,
              previewNumber: bus.preview_number,
              latitude: freshDoc ? freshDoc.latitude : null,
              longitude: freshDoc ? freshDoc.longitude : null,
              speed: freshDoc ? freshDoc.speed : 0,
              status: freshDoc && freshDoc.is_online ? "online" : "offline",
              source: freshDoc && freshDoc.source ? freshDoc.source : "offline",
              is_online: !!(freshDoc && freshDoc.is_online),
              lastSuccessfulGpsUpdate: freshDoc
                ? freshDoc.lastSuccessfulGpsUpdate
                : null,
              lastUpdated: freshDoc
                ? freshDoc.lastSuccessfulGpsUpdate || freshDoc.updatedAt
                : null,
            });
          }
        } catch (emitErr) {
          console.error(
            `locationUpdate emit failed for ${regNo}: ${emitErr?.message || emitErr}`,
          );
        }
      }

      console.log(
        `GPS Sync Completed - success=${successCount}, failed=${failCount}`,
      );
      console.log(`Polling Time: ${new Date() - cycleStart}ms`);
    } finally {
      this.syncLock = false;
    }
  }
}

module.exports = new GpsSyncWorker();
