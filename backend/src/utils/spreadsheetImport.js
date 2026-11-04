const XLSX = require("xlsx");

const USER_COLUMNS = [
  "name",
  "email",
  "busno",
  "role",
  "mobile_no",
  "date_of_year",
];
const PLAN_HEADER = /^PLAN\s+([A-D])$/i;
const TIME_HEADER = /^PLAN\s+([A-D])\s+(?:TIME|TIMING|ARRIVAL\s+TIME)$/i;

function firstWorksheet(buffer) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) {
    throw new Error("The Excel workbook is empty.");
  }
  const workbook = XLSX.read(buffer, { type: "buffer" });
  const firstSheet = workbook.SheetNames[0];
  if (!firstSheet) throw new Error("The Excel workbook has no worksheets.");
  return workbook.Sheets[firstSheet];
}

function createUserWorkbookRows(buffer) {
  const worksheet = firstWorksheet(buffer);
  const reference = worksheet["!ref"];
  if (!reference) return function* emptyUserWorkbookRows() {};

  const { s, e } = XLSX.utils.decode_range(reference);
  const lastColumn = Math.min(e.c, s.c + USER_COLUMNS.length - 1);
  return function* userWorkbookRows() {
    for (let rowIndex = s.r + 1; rowIndex <= e.r; rowIndex += 1) {
      const row = [];
      let hasValue = false;
      for (let columnIndex = s.c; columnIndex <= lastColumn; columnIndex += 1) {
        const cell = worksheet[
          XLSX.utils.encode_cell({ r: rowIndex, c: columnIndex })
        ];
        const value = cell?.v ?? "";
        row.push(value);
        if (String(value).trim()) hasValue = true;
      }
      if (!hasValue) continue;

      yield {
        ...Object.fromEntries(
          USER_COLUMNS.map((column, index) => [column, row[index] ?? ""]),
        ),
        _sourceRowNumber: rowIndex + 1,
      };
    }
  };
}

function parseUserWorkbook(buffer) {
  return Array.from(createUserWorkbookRows(buffer)(), ({ _sourceRowNumber, ...row }) => row);
}

function formatArrivalTime(value) {
  if (typeof value === "number" && value >= 0 && value < 1) {
    const minutes = Math.round(value * 24 * 60) % (24 * 60);
    const hour24 = Math.floor(minutes / 60);
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${String(minutes % 60).padStart(2, "0")}${hour24 >= 12 ? "PM" : "AM"}`;
  }
  const rawTime = String(value ?? "").trim();
  const time24Hour = rawTime.match(/^([01]?\d|2[0-3]):([0-5]\d)$/);
  if (time24Hour) {
    const hour24 = Number(time24Hour[1]);
    const hour12 = hour24 % 12 || 12;
    return `${hour12}:${time24Hour[2]}${hour24 >= 12 ? "PM" : "AM"}`;
  }
  const match = rawTime.match(/^(\d{1,2}):([0-5]\d)\s*(AM|PM)$/i);
  return match
    ? `${Number(match[1])}:${match[2]}${match[3].toUpperCase()}`
    : rawTime;
}

function parseBusRoutesWorkbook(buffer) {
  const rows = XLSX.utils.sheet_to_json(firstWorksheet(buffer), {
    header: 1,
    defval: "",
    blankrows: false,
    raw: true,
  });
  const headers = (rows[0] || []).map((value) => String(value ?? "").trim());
  const plans = new Map();

  headers.forEach((header, index) => {
    const timeMatch = header.match(TIME_HEADER);
    if (timeMatch) {
      const plan = `PLAN ${timeMatch[1].toUpperCase()}`;
      const columns = plans.get(plan) || { stop: null, time: null };
      columns.time = index;
      plans.set(plan, columns);
      return;
    }

    const planMatch = header.match(PLAN_HEADER);
    if (planMatch) {
      const plan = `PLAN ${planMatch[1].toUpperCase()}`;
      const columns = plans.get(plan) || { stop: null, time: null };
      columns.stop = index;
      plans.set(plan, columns);
    }
  });

  const routesByPlan = {};
  for (const [plan, columns] of plans) {
    if (columns.stop === null) continue;
    const stops = [];
    for (const row of rows.slice(1)) {
      const stopName = String(row[columns.stop] ?? "").trim();
      if (!stopName) continue;
      const rawTime = columns.time === null ? "" : row[columns.time];
      const arrivalTime = String(rawTime ?? "").trim()
        ? formatArrivalTime(rawTime)
        : null;
      if (arrivalTime && !/^([1-9]|1[0-2]):[0-5]\d(AM|PM)$/i.test(arrivalTime)) {
        throw new Error(`Invalid arrival time "${arrivalTime}" for ${plan}. Use a valid time such as 8:15AM.`);
      }
      stops.push({
        stop_name: stopName,
        stop_order: stops.length + 1,
        arrival_time: arrivalTime,
      });
    }
    if (stops.length) routesByPlan[plan] = stops;
  }

  if (!Object.keys(routesByPlan).length) {
    throw new Error("No route plans found. Add PLAN A, PLAN B, PLAN C, or PLAN D columns with stop names.");
  }
  return routesByPlan;
}

module.exports = {
  parseUserWorkbook,
  createUserWorkbookRows,
  parseBusRoutesWorkbook,
};
