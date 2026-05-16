const { pool } = require('../config/db');

async function getBusIdByBusNo(busNo) {
  if (busNo === null || busNo === undefined || busNo === '') return null;
  const normalized = String(busNo).trim().toUpperCase();
  const [rows] = await pool.execute('SELECT id FROM buses WHERE bus_no = ? LIMIT 1', [normalized]);
  return rows.length ? rows[0].id : null;
}

async function getBusesIdByBusNoOrPreviewOrReg({ busNo, previewNumber, regNo }) {
  // Optional utility for controller-level conversions if needed.
  // Uses external identifiers to find bus_id.
  const normalizedBusNo = busNo ? String(busNo).trim().toUpperCase() : null;
  const normalizedPreview = previewNumber ? String(previewNumber).trim() : null;
  const normalizedReg = regNo ? String(regNo).trim().toUpperCase() : null;

  if (!normalizedBusNo && !normalizedPreview && !normalizedReg) return null;

  const conditions = [];
  const values = [];
  if (normalizedBusNo) {
    conditions.push('bus_no = ?');
    values.push(normalizedBusNo);
  }
  if (normalizedPreview) {
    conditions.push('preview_number = ?');
    values.push(normalizedPreview);
  }
  if (normalizedReg) {
    conditions.push('reg_no = ?');
    values.push(normalizedReg);
  }

  const where = conditions.join(' OR ');
  const [rows] = await pool.execute(`SELECT id FROM buses WHERE ${where} LIMIT 1`, values);
  return rows.length ? rows[0].id : null;
}

module.exports = {
  getBusIdByBusNo,
  getBusesIdByBusNoOrPreviewOrReg
};

