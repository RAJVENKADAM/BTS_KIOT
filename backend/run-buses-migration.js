const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runBusesMigration() {
  console.log('Running Buses Table Migration...\n');

  try {
    // Read migration SQL file
    const sqlFilePath = path.join(__dirname, 'src', 'config', 'migrations', '004_create_buses_table.sql');
    const sql = fs.readFileSync(sqlFilePath, 'utf8');

    // Create connection
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'bts_db',
    });

    console.log('Connected to database.');

    // Execute SQL statements
    const statements = sql.split(';').filter(stmt => stmt.trim());

    for (const statement of statements) {
      if (statement.trim()) {
        try {
          const [results] = await connection.execute(statement);
          console.log('✓ Executed:', statement.substring(0, 60) + '...');

          // Log results for DESCRIBE and SELECT statements
          if (statement.includes('DESCRIBE') || statement.includes('SELECT COUNT')) {
            console.log('  Results:', results);
          }
        } catch (error) {
          console.error('✗ Error executing statement:', error.message);
        }
      }
    }

    await connection.end();
    console.log('\n✅ Buses table migration completed successfully!');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  }
}

runBusesMigration();
