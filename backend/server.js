const { app, server } = require('./src/app');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0';

/**
 * IMPORTANT FIX:
 * Render / Nginx / proxies set X-Forwarded-For headers.
 * express-rate-limit requires trust proxy to be enabled,
 * otherwise it throws ERR_ERL_UNEXPECTED_X_FORWARDED_FOR
 */
app.set('trust proxy', 1);

const httpServer = server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Accessible at: http://localhost:${PORT}`);
  console.log(`Mobile access: http://${HOST}:${PORT} (ensure same WiFi network)`);
  console.log(`Health check: curl http://${HOST}:${PORT}/health`);

  // DB-dependent services are started by app.js
});

async function shutdown(signal) {
  console.log(`Received ${signal}; shutting down gracefully.`);
  try {
    const gpsSyncWorker = require('./src/workers/gpsSyncWorker');
    gpsSyncWorker.stop();
  } catch (error) {
    console.error('Failed to stop GPS worker:', error.message);
  }

  await new Promise((resolve) => httpServer.close(resolve));
  try {
    const mongoose = require('mongoose');
    await mongoose.disconnect();
  } catch (error) {
    console.error('Failed to close MongoDB:', error.message);
  }
  process.exit(0);
}

process.once('SIGINT', () => shutdown('SIGINT'));
process.once('SIGTERM', () => shutdown('SIGTERM'));