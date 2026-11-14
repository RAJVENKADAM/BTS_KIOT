"use strict";

const User = require("../models/User");

function revisionCondition(field, expected) {
  return expected === 0
    ? { $or: [{ [field]: 0 }, { [field]: { $exists: false } }] }
    : { [field]: expected };
}

function buildUserRevisionFilter({
  userId,
  expectedResourceVersion,
  expectedAssignmentRevision,
}) {
  const conditions = [
    { _id: userId },
    revisionCondition("resourceVersion", expectedResourceVersion),
  ];
  if (expectedAssignmentRevision !== undefined) {
    conditions.push(revisionCondition("assignmentRevision", expectedAssignmentRevision));
  }
  return { $and: conditions };
}

async function updateUserWithRevision({
  userId,
  expectedResourceVersion,
  expectedAssignmentRevision,
  update,
  session,
  select = "_id resourceVersion assignmentRevision",
}) {
  const increments = { resourceVersion: 1 };
  if (expectedAssignmentRevision !== undefined) {
    increments.assignmentRevision = 1;
  }
  let query = User.findOneAndUpdate(
    buildUserRevisionFilter({
      userId,
      expectedResourceVersion,
      expectedAssignmentRevision,
    }),
    {
      ...update,
      $inc: { ...(update.$inc || {}), ...increments },
    },
    {
      new: true,
      runValidators: true,
      ...(session ? { session } : {}),
    },
  );
  if (select && typeof query.select === "function") query = query.select(select);
  return query;
}

module.exports = {
  buildUserRevisionFilter,
  revisionCondition,
  updateUserWithRevision,
};
