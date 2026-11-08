"use strict";

const os = require("node:os");
const { monitorEventLoopDelay } = require("node:perf_hooks");

function createRuntimeMetrics({
  getStatus,
  intervalMs = 30000,
  logger = console,
} = {}) {
  const eventLoopDelay = monitorEventLoopDelay({ resolution: 20 });
  let interval = null;
  let previousCpu = process.cpuUsage();
  let previousSampleAt = Date.now();

  const sample = () => {
    const now = Date.now();
    const elapsedMs = Math.max(1, now - previousSampleAt);
    const cpu = process.cpuUsage(previousCpu);
    const memory = process.memoryUsage();
    const cpuPercent = Math.min(
      100,
      ((cpu.user + cpu.system) / (elapsedMs * 1000 * os.cpus().length)) * 100,
    );
    let dependencies = {};
    try {
      const status = getStatus?.();
      dependencies = {
        mongoReadyState: status?.databaseReadyState ?? null,
        redisState: status?.socketCluster?.state ?? null,
        socketClients: status?.socketClients ?? null,
        gpsWorkerStarted: status?.gpsWorker?.started ?? false,
        gpsWorkerLeaseHeld: status?.gpsWorker?.leaseHeld ?? false,
        gpsWorkerRestarts: status?.gpsWorker?.restartCount ?? 0,
        gpsLastSuccessfulUpdate:
          status?.gpsWorker?.lastSuccessfulGpsUpdate ?? null,
        gpsLastProviderTimestamp:
          status?.gpsWorker?.lastProviderTimestamp ?? null,
        gpsPublicationPending:
          status?.gpsLocationPublisher?.lastDrain?.pending ?? null,
        gpsPublicationFailures:
          status?.gpsLocationPublisher?.lastDrain?.failed ?? 0,
        gpsPublicationMaxDelayMs:
          status?.gpsLocationPublisher?.lastDrain?.maxDelayMs ?? null,
      };
    } catch (error) {
      logger.error(
        JSON.stringify({
          event: "runtime_metrics_status_failed",
          name: error?.name || "Error",
        }),
      );
    }

    logger.info(
      JSON.stringify({
        event: "runtime_metrics",
        sampledAt: new Date(now).toISOString(),
        eventLoopP99Ms: Number((eventLoopDelay.percentile(99) / 1e6).toFixed(2)),
        cpuPercent: Number(cpuPercent.toFixed(2)),
        rssBytes: memory.rss,
        heapUsedBytes: memory.heapUsed,
        ...dependencies,
      }),
    );
    eventLoopDelay.reset();
    previousCpu = process.cpuUsage();
    previousSampleAt = now;
  };

  return {
    start() {
      if (interval) return;
      eventLoopDelay.enable();
      interval = setInterval(sample, intervalMs);
      interval.unref?.();
    },
    stop() {
      if (interval) clearInterval(interval);
      interval = null;
      eventLoopDelay.disable();
    },
  };
}

module.exports = { createRuntimeMetrics };
