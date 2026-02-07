const mysql = require('mysql2/promise');

async function updateTables() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });
    
    console.log('Connected to database.');
    
    // Check if excel_upload_id column exists
    const [columns] = await conn.execute("SHOW COLUMNS FROM users LIKE 'excel_upload_id'");
    
    if (columns.length === 0) {
      console.log('Adding excel_upload_id column to users table...');
      await conn.execute('ALTER TABLE users ADD COLUMN excel_upload_id INT NULL AFTER temp_password');
      await conn.execute('ALTER TABLE users ADD FOREIGN KEY (excel_upload_id) REFERENCES excel_uploads(id) ON DELETE SET NULL');
      console.log('✓ Added excel_upload_id column to users table');
    } else {
      console.log('excel_upload_id column already exists in users table');
    }
    
    await conn.end();
    console.log('✓ Tables updated successfully!');
  } catch (error) {
    console.error('Error:', error.message);
  }
}

updateTables();