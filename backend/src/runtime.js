"use strict";

const http = require("node:http");
const { attachStartupStage } = require("./utils/safeErrorLog");

function createRuntime({ env = process.env, port, host, dependencies = {} } = {}) {
  let io = null;
  let socketCluster = null;
  const createApplication =
    dependencies.createApplication || require("./app").createApplication;
  const getRuntimeStatus = () => {
    const mongoose = dependencies.mongoose || require("mongoose");
    const gpsWorker = dependencies.getGpsWorker
      ? dependencies.getGpsWorker()
      : require("./services/startServices").getGpsWorkerStatus();
    const gpsLocationPublisher = dependencies.getGpsLocationPublisher
      ? dependencies.getGpsLocationPublisher()
      : require("./services/startServices").getGpsLocationPublisherStatus();
    return {
      databaseReadyState: mongoose.connection.readyState,
      gpsWorker: dependencies.getGpsWorker
        ? gpsWorker?.getStatus?.() || null
        : gpsWorker,
      gpsLocationPublisher,
      socketClients: io?.engine?.clientsCount || 0,
      socketCluster: socketCluster
        ? socketCluster.getStatus()
        : {
            mode:
              env.SOCKET_IO_MODE ||
              (env.NODE_ENV === "production" ? "redis" : "single-instance"),
            state: "disabled",
            enabled: false,
            reason: "Socket.IO has not been initialized.",
          },
    };
  };
  const app = createApplication({
    env,
    getRuntimeStatus,
    incrementSharedRateLimit: (key, windowMs) => {
      if (!socketCluster?.incrementRateLimit) {
        throw new Error("Shared request rate limiting is unavailable.");
      }
      return socketCluster.incrementRateLimit(key, windowMs);
    },
  });
  const createHttpServer =
    dependencies.createHttpServer || http.createServer;
  const server = createHttpServer(app);

  let listening = false;
  let startPromise = null;
  let shutdownPromise = null;
  let backgroundStartupPromise = null;
  let runtimeMetrics = null;
  let startupStage = "Socket.IO server construction";
  let stopping = false;
  let httpDrainStarted = false;
  let listenPromise = null;
  let cancelStartup;
  const startupCancelled = new Promise((resolve) => {
    cancelStartup = resolve;
  });

  function initializeSocket() {
    const createSocketServer = dependencies.createSocketServer || (() => {
      const { Server } = require("socket.io");
      return (httpServer, options) => new Server(httpServer, options);
    })();
    const { createSocketAuthentication } =
      dependencies.createSocketAuthentication
        ? { createSocketAuthentication: dependencies.createSocketAuthentication }
        : require("./socket/authenticateSocket");
    const { setIO } = dependencies.socketModule || require("./socket");
    const registerTrackSocketHandlers =
      dependencies.registerTrackSocketHandlers ||
      require("./socket/trackSocket").registerTrackSocketHandlers;
    const jwt = dependencies.jwt || require("jsonwebtoken");
    const corsOrigin = [
      ...String(env.CORS_ORIGIN || "")
        .split(",")
        .map((origin) => origin.trim())
        .filter(Boolean),
      "https://rajvenkadam.github.io",
      "http://localhost:8765",
      "http://127.0.0.1:8765",
    ];

    startupStage = "Socket.IO server construction";
    io = createSocketServer(server, {
      path: "/socket.io",
      cors: {
        origin: [...new Set(corsOrigin)],
        methods: ["GET", "POST", "PUT", "DELETE"],
        allowedHeaders: ["Content-Type", "Authorization"],
        credentials: true,
      },
    });
    startupStage = "Socket authentication setup";
    io.use(createSocketAuthentication(jwt, () => env.JWT_SECRET));
    startupStage = "Socket.IO global registration";
    setIO(io);
    startupStage = "Socket event-handler registration";
    registerTrackSocketHandlers({ io });

    startupStage = "Socket.IO shared-transport configuration";
    const configureSocketCluster =
      dependencies.configureSocketCluster ||
      require("./config/sharedServices").configureSocketCluster;
    socketCluster = configureSocketCluster(io, { env });
  }

  function listen() {
    const listeningPromise = dependencies.listen
      ? Promise.resolve(
          dependencies.listen(server, {
            host: host || env.HOST || "0.0.0.0",
            port: port || env.PORT || 5000,
          }),
        )
      : new Promise((resolve, reject) => {
      const onError = (error) => {
        server.removeListener("error", onError);
        reject(error);
      };
      server.once("error", onError);
      server.listen(port || env.PORT || 5000, host || env.HOST || "0.0.0.0", () => {
        server.removeListener("error", onError);
        listening = true;
        resolve();
      });
    });

    listenPromise = listeningPromise.then(() => {
      listening = true;
      if (!stopping || httpDrainStarted) return;
      httpDrainStarted = true;
      return new Promise((resolve, reject) => {
        server.close((error) => {
          listening = false;
          if (error) reject(error);
          else resolve();
        });
      });
    });
    return Promise.race([
      listenPromise,
      startupCancelled.then(() => {
        throw new Error("Runtime startup was cancelled by shutdown.");
      }),
    ]);
  }

  async function start() {
    if (shutdownPromise) throw new Error("Runtime has already been shut down.");
    if (startPromise) return startPromise;

    startPromise = (async () => {
      try {
        startupStage = "Socket.IO initialization";
        initializeSocket();
        startupStage = "Socket.IO shared-transport readiness";
        await Promise.race([
          socketCluster.ready,
          startupCancelled.then(() => {
            throw new Error("Runtime startup was cancelled by shutdown.");
          }),
        ]);
        if (stopping) throw new Error("Runtime startup was cancelled by shutdown.");
        startupStage = "HTTP server listen";
        await listen();
        listening = true;
        if (stopping) throw new Error("Runtime startup was cancelled by shutdown.");

        const localIntegrationEnvironment =
          env.TEST_ENVIRONMENT === "local-integration" ||
          process.env.TEST_ENVIRONMENT === "local-integration";
        const testEnvironment =
          !localIntegrationEnvironment &&
          (env.NODE_ENV === "test" ||
            env.TEST_ENVIRONMENT === "unit" ||
            Boolean(env.NODE_TEST_CONTEXT) ||
            Boolean(process.env.NODE_TEST_CONTEXT));
        if (!testEnvironment) {
          startupStage = "runtime metrics initialization";
          const createRuntimeMetrics =
            dependencies.createRuntimeMetrics ||
            require("./services/runtimeMetrics").createRuntimeMetrics;
          runtimeMetrics = createRuntimeMetrics({ getStatus: getRuntimeStatus });
          runtimeMetrics.start();
          const startBackgroundServices =
            dependencies.startBackgroundServices ||
            (() =>
              require("./services/startServices").startDbDependentServices({
                env,
                startGpsWorker: env.TEST_ENVIRONMENT !== "local-integration",
                getSocketClusterStatus: () => socketCluster?.getStatus(),
                getSocketClusterGeneration: () =>
                  socketCluster?.getConnectionGeneration?.() ?? 0,
                publishGpsLocationEvent: (...args) =>
                  socketCluster?.publishSocketEvent?.(...args),
              }));
          backgroundStartupPromise = Promise.resolve()
            .then(() => {
              if (stopping) return;
              return startBackgroundServices();
            })
            .catch((error) => {
              const logSafeError =
                dependencies.logSafeError ||
                require("./utils/safeErrorLog").logSafeError;
              logSafeError(
                "Starting DB-dependent services failed",
                attachStartupStage(error, "DB-dependent services startup"),
                undefined,
                { includeDiagnostics: true },
              );
            });
        }
        return { app, server, io, socketCluster, shutdown };
      } catch (error) {
        if (!shutdownPromise) {
          try {
            await shutdown("STARTUP_FAILURE", false);
          } catch (shutdownError) {
            const logSafeError =
              dependencies.logSafeError ||
              require("./utils/safeErrorLog").logSafeError;
            logSafeError("Cleaning up after server startup failure failed", shutdownError);
          }
        }
        throw attachStartupStage(error, startupStage);
      } finally {
        if (!listening && !shutdownPromise) startPromise = null;
      }
    })();

    return startPromise;
  }

  async function shutdown(signal = "SHUTDOWN", waitForStartup = true) {
    if (shutdownPromise) return shutdownPromise;
    stopping = true;
    cancelStartup();
    shutdownPromise = (async () => {
      let httpClosePromise = Promise.resolve();
      const httpServerCloseStarted = Boolean(server.listening);
      if (httpServerCloseStarted) {
        httpDrainStarted = true;
        httpClosePromise = new Promise((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }

      const stopBackgroundServices =
        dependencies.stopBackgroundServices ||
        (() => require("./services/startServices").stopDbDependentServices());
      const stopGpsWorker =
        dependencies.stopGpsWorker ||
        (() => require("./services/startServices").stopGpsWorker());
      const disconnectDatabase =
        dependencies.disconnectDatabase ||
        (() => require("mongoose").disconnect());
      const logSafeError =
        dependencies.logSafeError || require("./utils/safeErrorLog").logSafeError;

      try {
        runtimeMetrics?.stop();
      } catch (error) {
        logSafeError("Failed to stop runtime metrics", error);
      }
      if (waitForStartup && startPromise) {
        try {
          await startPromise;
        } catch {
          // Startup failure is reported by start(); shutdown still owns cleanup.
        }
      }
      if (listenPromise) {
        try {
          await listenPromise;
        } catch {
          // A cancelled or failed bind has nothing left to drain.
        }
      }
      if (backgroundStartupPromise) await backgroundStartupPromise;
      try {
        await stopBackgroundServices();
      } catch (error) {
        logSafeError("Failed to stop DB-dependent service retries", error);
      }
      try {
        await stopGpsWorker();
      } catch (error) {
        logSafeError("Failed to stop GPS worker", error);
      }
      if (io && socketCluster) {
        try {
          const closeSocketServices =
            dependencies.closeSocketServices ||
            require("./config/sharedServices").closeSocketServices;
          await closeSocketServices(io, socketCluster, {
            httpServerCloseStarted:
              httpServerCloseStarted || !server.listening,
          });
        } catch (error) {
          logSafeError("Failed to close Socket.IO and shared services", error);
        }
      } else if (io) {
        try {
          await new Promise((resolve, reject) => {
            io.close((error) => {
              if (!server.listening && error?.code === "ERR_SERVER_NOT_RUNNING") {
                resolve();
              } else if (error) {
                reject(error);
              } else {
                resolve();
              }
            });
          });
        } catch (error) {
          logSafeError("Failed to close Socket.IO", error);
        }
      } else if (socketCluster) {
        try {
          await socketCluster.close();
        } catch (error) {
          logSafeError("Failed to close shared services", error);
        }
      }
      try {
        await httpClosePromise;
      } catch (error) {
        logSafeError("Failed to drain HTTP server", error);
      }
      try {
        await disconnectDatabase();
      } catch (error) {
        logSafeError("Failed to close MongoDB", error);
      }
      listening = false;
      if (dependencies.logShutdown) dependencies.logShutdown(signal);
    })();

    return shutdownPromise;
  }

  return { app, server, start, shutdown };
}

module.exports = { createRuntime };
