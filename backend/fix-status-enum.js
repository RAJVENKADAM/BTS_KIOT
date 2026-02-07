const mysql = require('mysql2/promise');
require('dotenv').config();

async function fixStatusEnum() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'bts_db',
    });

    console.log('Updating status ENUM to include "combined" value...\n');

    // Modify the status column to include 'combined' value
    await connection.execute(
      "ALTER TABLE buses MODIFY COLUMN status ENUM('active', 'inactive', 'maintenance', 'combined') DEFAULT 'active'"
    );

    console.log('✓ Status column ENUM updated successfully');

    // Verify the change
    const [statusCol] = await connection.execute(
      "SELECT COLUMN_NAME, COLUMN_TYPE FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'buses' AND TABLE_SCHEMA = ? AND COLUMN_NAME = 'status'",
      [process.env.DB_NAME || 'bts_db']
    );
    
    console.log('\nUpdated status column info:');
    console.table(statusCol);

    await connection.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

fixStatusEnum();
