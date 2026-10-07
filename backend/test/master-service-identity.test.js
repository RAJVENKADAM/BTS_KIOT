const test = require("node:test");
const assert = require("node:assert/strict");
const getMasterServiceIdentity = require("../src/utils/masterServiceIdentity");

test("an altered service shows its original preview and the operating bus", () => {
  const identity = getMasterServiceIdentity({
    bus: { preview_number: "2" },
    operationalBus: { preview_number: "2" },
    incomingChanges: [
      { alteration_type: "alter", preview_number: "4" },
    ],
    isAssignedOperationalService: false,
  });

  assert.equal(identity.operationType, "ALTER");
  assert.equal(identity.busNumber, "4");
  assert.deepEqual(identity.serviceBusNumbers, ["4"]);
  assert.equal(identity.operatingBusNumber, "2");
});

test("a combined service shows all original previews and the operating bus", () => {
  const identity = getMasterServiceIdentity({
    bus: { preview_number: "2" },
    operationalBus: { preview_number: "2" },
    incomingChanges: [
      { alteration_type: "combine", preview_number: "4" },
      { alteration_type: "combine", preview_number: "7" },
    ],
    isAssignedOperationalService: false,
  });

  assert.equal(identity.operationType, "COMBINE");
  assert.deepEqual(identity.serviceBusNumbers, ["4", "7", "2"]);
  assert.equal(identity.operatingBusNumber, "2");
});

test("an assigned rider sees their original preview during an alteration", () => {
  const identity = getMasterServiceIdentity({
    bus: { preview_number: "2" },
    operationalBus: { preview_number: "2" },
    assignedBus: { preview_number: "4", alteration_type: "alter" },
    incomingChanges: [
      { alteration_type: "alter", preview_number: "4" },
    ],
    isAssignedOperationalService: true,
  });

  assert.equal(identity.busNumber, "4");
  assert.deepEqual(identity.serviceBusNumbers, ["4"]);
  assert.equal(identity.operatingBusNumber, "2");
});
