const assert = require("node:assert/strict");
const { test } = require("node:test");
const Bus = require("../src/models/Bus");
const User = require("../src/models/User");
const { findStudentsAssignedToBus } = require("../src/controllers/bus.controller");

test("assignment lookup preserves supported normalized bus number formats", async () => {
  const originalFind = User.find;
  let capturedFilter;
  User.find = (filter) => {
    capturedFilter = filter;
    return {
      select() {
        return this;
      },
    };
  };

  try {
    const bus = new Bus({
      bus_no: " bus-02 ",
      gps_device_id: "gps-bus-2",
      preview_number: "4",
    });
    await findStudentsAssignedToBus(bus);

    assert.equal(bus.bus_no, "BUS-02");
    assert.equal(capturedFilter.role, "student");
    assert.equal(capturedFilter.is_active, true);
    assert.equal(capturedFilter.bus_no.$in.length, 2);
    assert.equal(capturedFilter.bus_no.$in[0].test("BUS-02"), true);
    assert.equal(capturedFilter.bus_no.$in[0].test("bus-02"), true);
    assert.equal(capturedFilter.bus_no.$in[0].test(" bus-02 "), false);
    assert.equal(capturedFilter.bus_no.$in[1].test("4"), true);
  } finally {
    User.find = originalFind;
  }
});

test("numeric leading-zero assignments use their normalized stored number", async () => {
  const originalFind = User.find;
  let capturedFilter;
  User.find = (filter) => {
    capturedFilter = filter;
    return {
      select() {
        return this;
      },
    };
  };

  try {
    const bus = new Bus({ bus_no: "04", gps_device_id: "gps-bus-4" });
    const user = new User({ bus_no: "04" });
    await findStudentsAssignedToBus(bus);

    assert.equal(bus.bus_no, "4");
    assert.equal(user.bus_no, "4");
    assert.equal(capturedFilter.bus_no.$in[0].test(user.bus_no), true);
  } finally {
    User.find = originalFind;
  }
});
