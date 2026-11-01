const assert = require("node:assert/strict");
const test = require("node:test");
const isReusableTemporaryChangeSource = require("../src/utils/isReusableTemporaryChangeSource");

test("allows an active combination source to be reused", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
  ];

  assert.equal(isReusableTemporaryChangeSource(activeChanges, "source"), true);
});

test("does not allow a combination replacement bus to be reused", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
  ];

  assert.equal(isReusableTemporaryChangeSource(activeChanges, "replacement"), false);
});

test("allows an alteration source to be reused as a replacement", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "alter" },
  ];

  assert.equal(isReusableTemporaryChangeSource(activeChanges, "source"), true);
});

test("does not allow a source to be reused while its change is applying", () => {
  const activeChanges = [
    {
      sourceBusId: "source",
      targetBusId: "replacement",
      type: "alter",
      status: "applying",
    },
  ];

  assert.equal(isReusableTemporaryChangeSource(activeChanges, "source"), false);
});

test("does not allow a combination source to be reused as another change's replacement", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
    { sourceBusId: "other", targetBusId: "source", type: "alter" },
  ];

  assert.equal(isReusableTemporaryChangeSource(activeChanges, "source"), false);
});
