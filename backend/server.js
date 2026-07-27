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

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Accessible at: http://localhost:${PORT}`);
  console.log(`Mobile access: http://${HOST}:${PORT} (ensure same WiFi network)`);
  console.log(`Health check: curl http://${HOST}:${PORT}/health`);

  // DB-dependent services are started by app.js
});