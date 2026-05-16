// Centralized DB safety wrapper to prevent transient mysql failures from crashing background services.
// Use this wrapper for all background/interval DB calls and for any path that must never throw.

const { pool } = require('./db');

function isMysqlTransientError(err) {
  if (!err) return false;
  const msg = String(err.message || '').toLowerCase();
  const code = err.code;

  // Common transient connection errors
  return (
    code === 'ECONNREFUSED' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ETIMEDOUT' ||
    code === 'ECONNRESET' ||
    msg.includes('econnrefused') ||
    msg.includes('protocol connection lost') ||
    msg.includes('etimedout')
  );
}

function structuredLog(level, code, details = {}) {
  const env = process.env.NODE_ENV || 'development';
  const payload = {
    level,
    code,
    env,
    ...details,
  };

  // Avoid raw stack traces in production.
  if (env !== 'production' && details.stack) payload.stack = details.stack;

  // eslint-disable-next-line no-console
  console[level === 'error' ? 'error' : 'log'](JSON.stringify(payload));
}

async function safeExecute(sql, params = [], context = {}) {
  try {
    const result = await pool.execute(sql, params);
    return result;
  } catch (err) {
    structuredLog('error', 'DB_ERROR', {
      ...context,
      transient: isMysqlTransientError(err),
      message: err?.message,
      code: err?.code,
      // stack omitted in production via structuredLog()
      stack: err?.stack,
    });

    // Return safe default compatible with mysql2/promise: [rows, fields]
    return [[], []];
  }
}

module.exports = {
  safeExecute,
  isMysqlTransientError,
};

