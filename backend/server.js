const { app, server } = require('./src/app');
const { startDbDependentServices } = require('./src/services/startServices');

const PORT = process.env.PORT || 5000;
const HOST = process.env.HOST || '0.0.0.0'; // Bind to all interfaces for mobile access

server.listen(PORT, HOST, () => {
  console.log(`Server is running on http://${HOST}:${PORT}`);
  console.log(`Accessible at: http://localhost:${PORT}`);
  console.log(`Mobile access: http://${HOST}:${PORT} (ensure same WiFi network)`);
  console.log(`Health check: curl http://${HOST}:${PORT}/health`);

  // Important: start DB-dependent background loops only after DB is confirmed reachable.
  // This prevents ECONNREFUSED during cold starts / render restarts.
  startDbDependentServices().catch((err) => {
    console.error('Failed to start DB-dependent services:', err);
  });
});

