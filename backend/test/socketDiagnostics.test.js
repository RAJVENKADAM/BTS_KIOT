const assert = require("node:assert/strict");
const test = require("node:test");
const { logSocketDiagnostic } = require("../src/utils/socketDiagnostics");

test("socket diagnostics include lifecycle metrics without leaking descriptions or IDs", () => {
  const originalInfo = console.info;
  const output = [];
  console.info = (...args) => output.push(args);

  try {
    logSocketDiagnostic("server-disconnected", {
      socketId: "student@example.com",
      disconnectReason: "ping timeout",
      disconnectDescription: {
        name: "Error",
        code: "private-token-value",
        message: "Authorization: Bearer private.jwt.value",
      },
      transportType: "websocket",
      wasConnected: true,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: 2,
      reconnectionResult: "pending",
      pingIntervalMs: 25000,
      pingTimeoutMs: 20000,
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(output.length, 1);
  assert.equal(output[0][0], "[socket-diagnostic]");
  const record = JSON.parse(output[0][1]);
  assert.equal(record.timestamp.length > 0, true);
  assert.equal(record.socketId, null);
  assert.equal(record.disconnectReason, "ping timeout");
  assert.equal(record.disconnectDescription.message, "redacted");
  assert.equal(record.transportType, "websocket");
  assert.equal(record.wasConnected, true);
  assert.equal(record.reconnectionAttempted, true);
  assert.equal(record.reconnectionAttemptNumber, 2);
  assert.equal(record.reconnectionResult, "pending");
  assert.equal(record.pingIntervalMs, 25000);
  assert.equal(record.pingTimeoutMs, 20000);
  assert.equal(typeof record.processUptimeSeconds, "number");
  assert.equal(typeof record.memoryUsageBytes.rss, "number");
  assert.equal(JSON.stringify(record).includes("private"), false);
  assert.equal(JSON.stringify(record).includes("student@example.com"), false);
});
