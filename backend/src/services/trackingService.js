// Deprecated: scheduling moved to src/workers/gpsSyncWorker.js
// Keeping this module to avoid runtime errors from any legacy imports.

module.exports = {
  start: () => {
    console.warn('trackingService.start() is deprecated. Use gpsSyncWorker instead.');
  },
};




