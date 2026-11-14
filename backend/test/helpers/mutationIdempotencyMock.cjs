"use strict";

const MutationIdempotency = require("../../src/models/MutationIdempotency");

function mockMutationIdempotency() {
  const originalFindById = MutationIdempotency.findById;
  const originalCreate = MutationIdempotency.create;
  const originalUpdateOne = MutationIdempotency.updateOne;
  const records = new Map();

  MutationIdempotency.findById = (id) => ({
    lean: async () => records.get(String(id)) || null,
  });
  MutationIdempotency.create = async (documents) => {
    const record = documents[0];
    if (records.has(String(record._id))) {
      const error = new Error("duplicate key");
      error.code = 11000;
      throw error;
    }
    records.set(String(record._id), record);
    return [record];
  };
  MutationIdempotency.updateOne = async (filter, update) => {
    const record = records.get(String(filter._id));
    if (!record || record.request_hash !== filter.request_hash) {
      return { matchedCount: 0 };
    }
    Object.assign(record, update.$set);
    return { matchedCount: 1 };
  };

  return {
    records,
    restore() {
      MutationIdempotency.findById = originalFindById;
      MutationIdempotency.create = originalCreate;
      MutationIdempotency.updateOne = originalUpdateOne;
    },
  };
}

module.exports = { mockMutationIdempotency };
