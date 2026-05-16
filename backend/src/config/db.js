const mysql = require('mysql2/promise');
require('dotenv').config();

function requireDatabaseUrl() {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error('Missing DATABASE_URL env var');
  }
  return url;
}

function parseMysql2PoolConfigFromDatabaseUrl(databaseUrl) {
  // mysql://user:pass@host:port/database
  // We only accept DATABASE_URL as the source of truth.
  const url = new URL(databaseUrl);

  return {
    uri: undefined,
    host: url.hostname,
    port: url.port ? Number(url.port) : 3306,
    user: url.username,
    password: url.password,
    database: url.pathname ? url.pathname.replace(/^\//, '') : undefined,

    // Production pool stability settings
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    enableKeepAlive: true,

    // Avoid too aggressive timeouts during cold starts
    connectTimeout: 10000,
    acquireTimeout: 10000,
    // Keep a small number of connections warm (defaults are usually fine, but these help Render/Railway churn)
    // Note: mysql2 ignores unknown options; these are safe.
    maxIdle: 5 * 60 * 1000,
    idleTimeout: 5 * 60 * 1000,
  };
}

const pool = mysql.createPool(parseMysql2PoolConfigFromDatabaseUrl(requireDatabaseUrl()));

async function testConnection() {
  let conn;
  try {
    conn = await pool.getConnection();
    await conn.query('SELECT 1 AS ok');
    return true;
  } catch (err) {
    console.error('Database connection failed:', err.message);
    return false;
  } finally {
    if (conn) conn.release();
  }
}

module.exports = {
  pool,
  testConnection,
};

