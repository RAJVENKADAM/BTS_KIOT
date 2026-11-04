const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { test } = require("node:test");
const XLSX = require("xlsx");
const { reserveImportCapacity } = require("../src/middleware/importAdmission");
const { parseUserWorkbookUpload } = require("../src/middleware/spreadsheetImport");

function responseDouble() {
  const response = new EventEmitter();
  response.statusCode = null;
  response.headers = {};
  response.set = (name, value) => {
    response.headers[name] = value;
    return response;
  };
  response.status = (code) => {
    response.statusCode = code;
    return response;
  };
  response.json = (payload) => {
    response.payload = payload;
    return response;
  };
  return response;
}

test("import admission bounds concurrent synthetic workbook parsing and releases capacity once", () => {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet([
      ["Name", "Email", "Bus", "Role", "Mobile", "Year"],
      ...Array.from({ length: 10 }, (_, index) => [
        `Student ${index}`,
        `student${index}@example.test`,
        12,
        "student",
        "9876543210",
        2004,
      ]),
    ]),
    "Users",
  );
  const buffer = XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
  let firstContinued = false;
  let secondContinued = false;
  const firstResponse = responseDouble();
  const secondResponse = responseDouble();

  const firstRequest = {
    body: { excelCustomName: "synthetic" },
    file: { buffer },
  };
  const secondRequest = {
    body: { excelCustomName: "synthetic" },
    file: { buffer },
  };
  reserveImportCapacity(firstRequest, firstResponse, () => {
    parseUserWorkbookUpload(firstRequest, firstResponse, () => {
      firstContinued = Array.from(firstRequest.body.users).length === 10;
    });
  });
  reserveImportCapacity(secondRequest, secondResponse, () => {
    parseUserWorkbookUpload(secondRequest, secondResponse, () => {
      secondContinued =
        Array.from(secondRequest.body.users).length === 10 &&
        secondRequest.file.buffer === null;
    });
  });

  assert.equal(firstContinued, true);
  assert.equal(secondContinued, true);

  const overloadedResponse = responseDouble();
  reserveImportCapacity({ file: { buffer } }, overloadedResponse, () => {
    assert.fail("over-capacity imports must not start parsing");
  });
  assert.equal(overloadedResponse.statusCode, 503);
  assert.equal(overloadedResponse.headers["Retry-After"], "5");
  assert.equal(overloadedResponse.payload.code, "IMPORT_BUSY");

  firstResponse.emit("finish");
  firstResponse.emit("close");
  const retryResponse = responseDouble();
  let retryContinued = false;
  reserveImportCapacity({}, retryResponse, () => {
    retryContinued = true;
  });
  assert.equal(retryContinued, true);
  retryResponse.emit("finish");
  secondResponse.emit("finish");
});
