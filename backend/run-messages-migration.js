const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

async function runMessagesMigration() {
  console.log('Running Messages Table Migration...\n');

  try {
    // Read migration SQL file
    const sqlFilePath = path.join(__dirname, 'src', 'config', 'migrations', '007_add_missing_columns_to_messages.sql');
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

          // Log results for DESCRIBE statements
          if (statement.includes('DESCRIBE')) {
            console.log('  Results:', results);
          }
        } catch (error) {
          console.error('✗ Error executing statement:', error.message);
        }
      }
    }

    await connection.end();
    console.log('\n✅ Messages table migration completed successfully!');
    console.log('Columns added: bus_no, plan_name, sender_id');

  } catch (error) {
    console.error('❌ Migration failed:', error.message);
  }
}

runMessagesMigration();
