"use strict";

const assert = require("node:assert/strict");
const { test } = require("node:test");
const router = require("../src/routes/excelManagement.routes");

test("metadata-only Excel re-upload returns 410 without upload middleware", async () => {
  const layer = router.stack.find(
    (item) => item.route?.path === "/:id" && item.route.methods.put,
  );
  assert.ok(layer);
  assert.equal(layer.route.stack.length, 3);

  const response = {
    statusCode: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(payload) {
      this.payload = payload;
      return this;
    },
  };
  await layer.route.stack[2].handle({}, response);

  assert.equal(response.statusCode, 410);
  assert.equal(response.payload.code, "EXCEL_UPLOAD_REUPLOAD_RETIRED");
});
