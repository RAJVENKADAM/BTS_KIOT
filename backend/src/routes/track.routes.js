const express = require('express');

// This deployment does not support mobile phone tracking.
// GPS provider syncing happens in src/workers/gpsSyncWorker.js.
// Keep this file so existing imports/routes don't crash, but return 410.

const router = express.Router();

router.use((req, res) => {
  res.status(410).json({
    error: 'Mobile tracking endpoints are disabled. GPS syncing is handled by gpsSyncWorker.',
  });
});

module.exports = router;

