const assert = require("node:assert/strict");
const test = require("node:test");
const { parsePagination } = require("../src/utils/pagination");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");

test("pagination defaults to the first page and configured page size", () => {
  assert.deepEqual(parsePagination({}, { defaultLimit: 100, maxLimit: 200 }), {
    page: 1,
    limit: 100,
    skip: 0,
    search: "",
  });
});

test("pagination clamps requested limits to the configured maximum", () => {
  assert.deepEqual(
    parsePagination(
      { page: "3", limit: "999", search: "  bus  " },
      { defaultLimit: 100, maxLimit: 200 },
    ),
    { page: 3, limit: 200, skip: 400, search: "bus" },
  );
});

test("pagination rejects malformed, zero, negative, and unsafe values", () => {
  for (const query of [
    { page: "0" },
    { page: "-1" },
    { page: "1.5" },
    { page: "1000001" },
    { limit: "0" },
    { limit: "abc" },
    { limit: "9007199254740992" },
    { search: "x".repeat(101) },
  ]) {
    assert.ok(parsePagination(query).error, JSON.stringify(query));
  }
});

test("declares indexes for upload ownership and paginated upload-user queries", () => {
  const uploadIndexes = ExcelUpload.schema.indexes().map(([fields]) => fields);
  const userIndexes = User.schema.indexes().map(([fields]) => fields);

  assert.ok(
    uploadIndexes.some(
      (fields) => fields.uploaded_by === 1 && fields.createdAt === -1,
    ),
  );
  assert.ok(
    userIndexes.some(
      (fields) =>
        fields.excel_upload_id === 1 &&
        fields.is_active === 1 &&
        fields._id === 1,
    ),
  );
});
