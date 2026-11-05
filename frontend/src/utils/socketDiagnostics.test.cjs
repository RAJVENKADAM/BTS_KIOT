"use strict";

const assert = require("node:assert/strict");
const test = require("node:test");
const {
  logSocketDiagnostic,
  sanitizeSocketDescription,
} = require("./socketDiagnostics.cjs");

test("client diagnostics redact arbitrary error details and preserve safe disconnect fields", () => {
  const originalInfo = console.info;
  const output = [];
  console.info = (...args) => output.push(args);

  try {
    const socket = {
      id: "temporarySocketId",
      io: { engine: { transport: { name: "websocket" } } },
    };
    logSocketDiagnostic("client-disconnected", socket, {
      disconnectReason: "ping timeout",
      disconnectDescription: {
        name: "Error",
        code: "private-token-value",
        message: "Authorization: Bearer private.jwt.value",
      },
      wasConnected: true,
      reconnectionAttempted: true,
      reconnectionAttemptNumber: 3,
      reconnectionResult: "pending",
    });
  } finally {
    console.info = originalInfo;
  }

  assert.equal(output.length, 1);
  const record = output[0][1];
  assert.equal(record.timestamp.length > 0, true);
  assert.equal(record.socketId, "temporarySocketId");
  assert.equal(record.disconnectReason, "ping timeout");
  assert.deepEqual(record.disconnectDescription, {
    name: "Error",
    message: "redacted",
  });
  assert.equal(record.transportType, "websocket");
  assert.equal(record.wasConnected, true);
  assert.equal(record.reconnectionAttemptNumber, 3);
  assert.equal(record.reconnectionResult, "pending");
  assert.equal(JSON.stringify(record).includes("private"), false);
});

test("client description sanitizer redacts nonstandard text", () => {
  assert.deepEqual(
    sanitizeSocketDescription("user@example.com has token private-value"),
    { message: "redacted" },
  );
});
