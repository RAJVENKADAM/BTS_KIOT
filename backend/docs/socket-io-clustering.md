# Socket.IO deployment modes

The backend has two explicit modes:

- In non-production environments, `single-instance` is the default. The
  in-memory adapter is suitable only when one backend process serves Socket.IO
  traffic.
- In production, `SOCKET_IO_MODE` must be explicitly set to `redis` or
  `single-instance`. The process does not silently select in-memory mode.
  `redis` requires `SOCKET_IO_REDIS_URL` or `REDIS_URL`; both clients must
  connect before the HTTP server starts. Startup fails if connection or adapter
  initialization fails.

The `/ready` response reports adapter mode and live connection state. A
configured Redis adapter that disconnects makes readiness fail until both
clients recover. Graceful shutdown closes Socket.IO transports and then the
Redis clients. `redis` and `@socket.io/redis-adapter` are declared backend
dependencies.

When HTTP long-polling is enabled behind a load balancer, requests for one
Socket.IO session must be routed to the same backend instance (sticky
sessions). Alternatively, clients may use WebSocket-only transport only if
that transport is supported end-to-end. This application retains the default
polling transport, so configure and verify sticky sessions for polling in a
multi-instance deployment.

Automated tests use fake Redis clients and verify lifecycle/readiness behavior;
they do not prove cross-instance event delivery. No Redis server, two-instance
integration test, deployment, or production configuration change was performed
as part of this remediation.
