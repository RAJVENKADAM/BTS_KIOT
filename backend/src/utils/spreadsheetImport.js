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

function parseUserWorkbook(buffer) {
  const rows = XLSX.utils.sheet_to_json(firstWorksheet(buffer), {
    header: 1,
    range: 1,
    defval: "",
    blankrows: false,
  });
  return rows
    .filter((row) =>
      Array.isArray(row) &&
      row.some((value) => String(value ?? "").trim() !== ""),
    )
    .map((row) =>
      Object.fromEntries(
        USER_COLUMNS.map((column, index) => [column, row[index] ?? ""]),
      ),
    );
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

module.exports = { parseUserWorkbook, parseBusRoutesWorkbook };
