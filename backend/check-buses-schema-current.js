const mysql = require('mysql2/promise');
require('dotenv').config();

async function checkSchema() {
  try {
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
      database: process.env.DB_NAME || 'bts_db',
    });

    console.log('Checking buses table schema...\n');

    // Get table structure
    const [schema] = await connection.execute('DESCRIBE buses');
    console.log('Current buses table structure:');
    console.table(schema);

    // Check for status column specifically
    console.log('\n\nChecking status column details:');
    const [statusCol] = await connection.execute(
      "SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT FROM INFORMATION_SCHEMA.COLUMNS WHERE TABLE_NAME = 'buses' AND TABLE_SCHEMA = ? AND COLUMN_NAME = 'status'",
      [process.env.DB_NAME || 'bts_db']
    );
    console.log('Status column info:');
    console.table(statusCol);

    if (statusCol.length === 0) {
      console.log('\n⚠️  WARNING: status column does not exist in buses table!');
    }

    // Try to update a bus record with status
    console.log('\n\nAttempting test update:');
    try {
      const [buses] = await connection.execute('SELECT id, bus_number FROM buses LIMIT 1');
      if (buses.length > 0) {
        const testBusId = buses[0].id;
        const testBusNo = buses[0].bus_number;
        console.log(`Testing UPDATE on bus: ${testBusNo} (id: ${testBusId})`);
        
        // Try the update
        await connection.execute(
          'UPDATE buses SET status = ? WHERE id = ?',
          ['combined', testBusId]
        );
        console.log('✓ Update successful');
      }
    } catch (error) {
      console.error('✗ Update failed:', error.message);
    }

    await connection.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkSchema();
