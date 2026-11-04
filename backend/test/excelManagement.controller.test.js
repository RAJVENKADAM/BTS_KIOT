const assert = require("node:assert/strict");
const { test } = require("node:test");
const Bus = require("../src/models/Bus");
const ExcelUpload = require("../src/models/ExcelUpload");
const User = require("../src/models/User");
const {
  getUsersByExcelUpload,
} = require("../src/controllers/excelManagement.controller");

test("returns bus preview numbers for users linked to an Excel upload", async () => {
  const originalFindById = ExcelUpload.findById;
  const originalUserFind = User.find;
  const originalUserCountDocuments = User.countDocuments;
  const originalBusFind = Bus.find;
  const users = [
    { _id: "user-1", bus_no: "TN30AH5907" },
    { _id: "user-2", bus_no: "02" },
    { _id: "user-3", bus_no: null },
  ];
  let busFilter;
  ExcelUpload.findById = () => ({
    select: () => ({ lean: async () => ({ _id: "upload-1" }) }),
  });
  User.find = () => ({
    select: () => ({
      sort: () => ({
        skip: () => ({
          limit: () => ({ lean: async () => users }),
        }),
      }),
    }),
  });
  User.countDocuments = async () => users.length;
  Bus.find = (filter) => {
    busFilter = filter;
    return {
      select: () => ({
        lean: async () => [
          { bus_no: "TN30AH5907", preview_number: "12" },
          { bus_no: "2", preview_number: "2" },
        ],
      }),
    };
  };
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

  try {
    await getUsersByExcelUpload({ params: { id: "upload-1" } }, response);

    assert.deepEqual(busFilter, {
      bus_no: { $in: ["TN30AH5907", "2"] },
    });
    assert.equal(response.statusCode, 200);
    assert.deepEqual(
      response.payload.data.map(({ id, previewNumber }) => ({
        id,
        previewNumber,
      })),
      [
        { id: "user-1", previewNumber: "12" },
        { id: "user-2", previewNumber: "2" },
        { id: "user-3", previewNumber: null },
      ],
    );
    assert.deepEqual(response.payload.pagination, {
      page: 1,
      limit: 100,
      total: 3,
      totalPages: 1,
      hasNextPage: false,
      hasPreviousPage: false,
    });
  } finally {
    ExcelUpload.findById = originalFindById;
    User.find = originalUserFind;
    User.countDocuments = originalUserCountDocuments;
    Bus.find = originalBusFind;
  }
});

test("rejects invalid Excel-user pagination without querying the upload", async () => {
  const originalFindById = ExcelUpload.findById;
  ExcelUpload.findById = () => {
    throw new Error("Must not query uploads for invalid pagination.");
  };
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

  try {
    await getUsersByExcelUpload(
      { params: { id: "upload-1" }, query: { page: "0" } },
      response,
    );
    assert.equal(response.statusCode, 400);
    assert.equal(response.payload.success, false);
  } finally {
    ExcelUpload.findById = originalFindById;
  }
});
