const assert = require("node:assert/strict");
const test = require("node:test");
const isReusableCombinedSource = require("../src/utils/isReusableCombinedSource");

test("allows an active combination source to be reused", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
  ];

  assert.equal(isReusableCombinedSource(activeChanges, "source"), true);
});

test("does not allow a combination replacement bus to be reused", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
  ];

  assert.equal(isReusableCombinedSource(activeChanges, "replacement"), false);
});

test("does not allow a bus involved in an alteration to be reused", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "alter" },
  ];

  assert.equal(isReusableCombinedSource(activeChanges, "source"), false);
});

test("does not allow a combination source to be reused as another change's replacement", () => {
  const activeChanges = [
    { sourceBusId: "source", targetBusId: "replacement", type: "combine" },
    { sourceBusId: "other", targetBusId: "source", type: "alter" },
  ];

  assert.equal(isReusableCombinedSource(activeChanges, "source"), false);
});
