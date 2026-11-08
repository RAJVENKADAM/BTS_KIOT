function databaseStatus(readyState) {
  if (readyState === 1) return "CONNECTED";
  if (readyState === 2) return "CONNECTING";
  if (readyState === 3) return "DISCONNECTING";
  return "DISCONNECTED";
}

function buildReadiness({
  databaseReadyState,
  gpsWorker,
  socketClients,
  socketCluster = { mode: "single-instance", state: "disabled", enabled: false },
}) {
  const socketReady =
    socketCluster.mode !== "redis" || socketCluster.enabled === true;
  const ready = databaseReadyState === 1 && socketReady;
  const lastCycle = gpsWorker?.lastCycle;
  return {
    httpStatus: ready ? 200 : 503,
    payload: {
      status: ready ? "READY" : "NOT_READY",
      database: databaseStatus(databaseReadyState),
      socketCluster: {
        mode: socketCluster.mode,
        state: socketCluster.state,
        ready: socketReady,
        reason: socketCluster.reason,
      },
      databaseReadFailures: lastCycle?.databaseReadFailures || 0,
      gpsWorker: {
        started: Boolean(gpsWorker?.started),
        stopping: Boolean(gpsWorker?.stopping),
        leaseHeld: Boolean(gpsWorker?.leaseHeld),
        leaseMode: gpsWorker?.leaseMode || "single-instance",
        syncIntervalMs: gpsWorker?.syncIntervalMs ?? 35000,
        activeCycle: Boolean(gpsWorker?.activeCycleId),
        lastCycleStatus: lastCycle?.status || "UNKNOWN",
        lastCycleCompletedAt: lastCycle?.completedAt || null,
      },
      gpsProvider: {
        status: lastCycle
          ? lastCycle.providerRequestSkipped
            ? "NOT_CONFIGURED"
            : lastCycle.providerFailures
              ? "DEGRADED"
              : "AVAILABLE"
          : "UNKNOWN",
        failures: lastCycle?.providerFailures || 0,
      },
      socketClients: Number.isFinite(socketClients) ? socketClients : 0,
    },
  };
}

module.exports = { buildReadiness };
