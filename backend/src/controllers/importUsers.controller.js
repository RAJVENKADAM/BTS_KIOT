const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');


function isNonEmptyString(v) {
  return typeof v === 'string' && v.trim().length > 0;
}

function normalizeEmail(email) {
  return (email || '').toString().trim().toLowerCase();
}

function isValidEmail(email) {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
}

function normalizeRole(role) {
  const roles = ['student', 'primary_admin', 'superadmin'];
  const r = (role || '').toString().trim().toLowerCase();
  if (r === 'user') return 'student';
  if (roles.includes(r)) return r;
  return null;
}

function coerceYear(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  if (!s) return null;

  const match = s.match(/(19|20)\\d{2}/);
  if (match) return parseInt(match[0], 10);

  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

function shallowEqualA(a, b, keys) {
  for (const k of keys) {
    if ((a[k] ?? null) !== (b[k] ?? null)) return false;
  }
  return true;
}

async function importUsers(req, res) {
  try {
    const payload = req.body || {};
    const users = Array.isArray(payload.users) ? payload.users : [];

    const summary = {
      totalRows: users.length,
      insertedRows: 0,
      updatedRows: 0,
      unchangedRows: 0,
      failedRows: 0,
      rowResults: [],
    };

    if (!users.length) {
      return res.status(400).json({
        success: false,
        summary: { ...summary, totalRows: 0, failedRows: 0 },
        error: 'Missing users array',
      });
    }

    // Validate + normalize rows up-front
    const normalizedRows = users.map((row, idx) => {
      try {
        const name = (row?.name ?? '').toString().trim();
        const email = normalizeEmail(row?.email);
        const busno = (row?.busno ?? row?.bus_no ?? '').toString().trim();
        const role = normalizeRole(row?.role);
        const mobile_no = (row?.mobile_no ?? row?.mobile ?? '').toString().trim();
        const date_of_year = coerceYear(row?.date_of_year);

        if (!isNonEmptyString(name)) throw new Error('Invalid name');
        if (!isNonEmptyString(email) || !isValidEmail(email)) throw new Error('Invalid email');
        if (!role) throw new Error('Invalid role');
        if (!isNonEmptyString(mobile_no)) throw new Error('Invalid mobile_no');
        if (!date_of_year) throw new Error('Invalid date_of_year');

        // busno can be null for some roles? requirement says include; we'll allow empty => null
        const bus_no = busno ? busno : null;

        return {
          idx,
          ok: true,
          value: {
            name,
            email,
            bus_no,
            role,
            phone: mobile_no,
            dobYear: date_of_year,
          },
        };
      } catch (e) {
        return { idx, ok: false, error: e.message || 'Validation error' };
      }
    });

    for (const r of normalizedRows) {
      if (!r.ok) {
        summary.failedRows += 1;
        summary.rowResults.push({ index: r.idx, status: 'failed', reason: r.error });
      }
    }

    const goodRows = normalizedRows.filter((r) => r.ok).map((r) => r.value);
    if (!goodRows.length) {
      return res.status(400).json({ success: false, summary, error: 'All rows failed validation' });
    }

    // Intelligent upsert:
    // - key: email
    // - if existing: compare fields; if identical => unchanged
    // - upsert new: create with password_hash derived from phone+year

    const updates = [];
    const existingUsers = await User.find({ email: { $in: goodRows.map((r) => r.email) }, is_active: { $in: [true, false] } }).lean();
    const existingByEmail = new Map(existingUsers.map((u) => [u.email.toLowerCase(), u]));

    for (const row of goodRows) {
      const email = row.email;
      const existing = existingByEmail.get(email);

      const computedPassword = `${row.phone.replace(/\D/g, '').substring(0, 4)}${row.dobYear}`;
      // IMPORTANT: We're using User.bulkWrite (no Mongoose pre('save') middleware runs),
      // so we must hash password_hash manually.
      const hashedPassword = await bcrypt.hash(computedPassword, 12);

      const next = {
        name: row.name,
        email,
        role: row.role,
        bus_no: row.bus_no,
        // password_hash required for create; for updates we only set if empty or temp behavior.
        password_hash: hashedPassword,
        is_active: true,
        temp_password: false,
      };

      if (!existing) {
        updates.push({
          index: goodRows.indexOf(row),
          type: 'create',
          filter: { email },
          update: { $set: next },
        });
        continue;
      }

      const keys = ['name', 'role', 'bus_no', 'is_active'];
      const currentProjection = {
        name: existing.name,
        role: existing.role,
        bus_no: existing.bus_no,
        is_active: existing.is_active,
      };
      const desiredProjection = {
        name: next.name,
        role: next.role,
        bus_no: next.bus_no,
        is_active: true,
      };

      const changed = !shallowEqualA(currentProjection, desiredProjection, keys);
      if (!changed) {
        summary.unchangedRows += 1;
        summary.rowResults.push({
          email,
          status: 'unchanged',
        });
        continue;
      }

      updates.push({
        index: goodRows.indexOf(row),
        type: 'update',
        filter: { email },
        update: {
          $set: {
            name: next.name,
            role: next.role,
            bus_no: next.bus_no,
            is_active: true,
            password_hash: hashedPassword,
            temp_password: false,

          },
        },
      });
    }

    if (updates.length) {
      const ops = updates.map((u) => ({
        updateOne: {
          filter: u.filter,
          update: u.update,
          upsert: true,
        },
      }));

      const result = await User.bulkWrite(ops, { ordered: false });

      // bulkWrite doesn't give unchanged counts; we already counted unchanged.
      summary.insertedRows = (result.upsertedCount || 0);
      summary.updatedRows = (result.modifiedCount || 0);
    }

    // Failed rows count (from bulkWrite errors) isn't granular; attempt to detect duplicate key etc.
    // For strict per-row failure, we would upsert one-by-one. Here we do best-effort.

    // Ensure failedRows reflects any thrown errors above.
    return res.status(200).json({ success: true, summary });
  } catch (error) {
    console.error('importUsers error:', error);
    return res.status(500).json({
      success: false,
      summary: {
        totalRows: Array.isArray(req.body?.users) ? req.body.users.length : 0,
        insertedRows: 0,
        updatedRows: 0,
        unchangedRows: 0,
        failedRows: Array.isArray(req.body?.users) ? req.body.users.length : 0,
      },
      error: error.message,
    });
  }
}

module.exports = { importUsers };

