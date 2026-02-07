const mysql = require('mysql2/promise');

async function checkBusesSchema() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });

    console.log('Checking buses table schema...');

    // Check if buses table exists
    const [tables] = await conn.execute("SHOW TABLES LIKE 'buses'");
    if (tables.length === 0) {
      console.log('❌ Buses table does not exist');
      await conn.end();
      return;
    }

    console.log('✅ Buses table exists');

    // Check columns
    const [columns] = await conn.execute('DESCRIBE buses');
    console.log('Buses table columns:');
    columns.forEach(col => {
      console.log(`  - ${col.Field}: ${col.Type} ${col.Null === 'NO' ? 'NOT NULL' : ''} ${col.Default ? `DEFAULT ${col.Default}` : ''}`);
    });

    // Check if is_active column exists
    const isActiveColumn = columns.find(col => col.Field === 'is_active');
    if (isActiveColumn) {
      console.log('✅ is_active column exists');
    } else {
      console.log('❌ is_active column is missing');
    }

    await conn.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkBusesSchema();
