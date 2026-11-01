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
  const originalBusFind = Bus.find;
  const users = [
    { _id: "user-1", bus_no: "TN30AH5907" },
    { _id: "user-2", bus_no: "02" },
    { _id: "user-3", bus_no: null },
  ];
  let busFilter;
  ExcelUpload.findById = async () => ({ _id: "upload-1" });
  User.find = () => ({
    select: () => ({ lean: async () => users }),
  });
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
  } finally {
    ExcelUpload.findById = originalFindById;
    User.find = originalUserFind;
    Bus.find = originalBusFind;
  }
});
