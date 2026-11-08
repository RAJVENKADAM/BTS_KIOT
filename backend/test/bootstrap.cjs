"use strict";

process.env.NODE_ENV = "test";
process.env.TEST_ENVIRONMENT = "unit";
process.env.SOCKET_IO_MODE = "single-instance";
process.env.GPS_DEVICE_REGISTRY_MODE = "legacy";

for (const name of [
  "MONGODB_URI",
  "DB_USER",
  "DB_PASSWORD",
  "DB_NAME",
  "GPS_TOKEN",
  "GPS_EMAIL",
  "REDIS_URL",
  "SOCKET_IO_REDIS_URL",
  "JWT_SECRET",
  "LOGIN_LIMITER_HASH_SECRET",
  "EMAIL_USER",
  "EMAIL_PASS",
  "SUPERADMIN_EMAIL",
  "SUPERADMIN_PASSWORD_HASH",
]) {
  delete process.env[name];
}
