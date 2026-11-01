const assert = require("node:assert/strict");
const { test } = require("node:test");
const XLSX = require("xlsx");
const {
  parseBusRoutesWorkbook,
  parseUserWorkbook,
} = require("../src/utils/spreadsheetImport");
const normalizeBusNumber = require("../src/utils/normalizeBusNumber");

function createWorkbook(rows) {
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.aoa_to_sheet(rows),
    "Import",
  );
  return XLSX.write(workbook, { type: "buffer", bookType: "xlsx" });
}

test("parses users using the existing mobile Excel column order", () => {
  const workbook = createWorkbook([
    ["Name", "Email", "Bus", "Role", "Mobile", "Year"],
    ["Student One", "student@example.test", 12, "student", "9876543210", 2004],
  ]);

  assert.deepEqual(parseUserWorkbook(workbook), [{
    name: "Student One",
    email: "student@example.test",
    busno: 12,
    role: "student",
    mobile_no: "9876543210",
    date_of_year: 2004,
  }]);
});

test("normalizes numeric bus numbers with leading zeros without changing alphanumeric IDs", () => {
  assert.equal(normalizeBusNumber("02"), "2");
  assert.equal(normalizeBusNumber("000"), "0");
  assert.equal(normalizeBusNumber(" bus-02 "), "BUS-02");
});

test("parses plan route columns and Excel time values", () => {
  const workbook = createWorkbook([
    ["Plan A", "Plan A Arrival Time", "Plan B"],
    ["Central Stop", 0.5, "North Stop"],
    ["Market Road", "", "College Gate"],
  ]);

  assert.deepEqual(parseBusRoutesWorkbook(workbook), {
    "PLAN A": [
      { stop_name: "Central Stop", stop_order: 1, arrival_time: "12:00PM" },
      { stop_name: "Market Road", stop_order: 2, arrival_time: null },
    ],
    "PLAN B": [
      { stop_name: "North Stop", stop_order: 1, arrival_time: null },
      { stop_name: "College Gate", stop_order: 2, arrival_time: null },
    ],
  });
});

test("normalizes typed 24-hour arrival times to the API's accepted format", () => {
  const workbook = createWorkbook([
    ["Plan C", "Plan C Arrival Time"],
    ["Evening Stop", "18:45"],
  ]);

  assert.deepEqual(parseBusRoutesWorkbook(workbook), {
    "PLAN C": [
      { stop_name: "Evening Stop", stop_order: 1, arrival_time: "6:45PM" },
    ],
  });
});
