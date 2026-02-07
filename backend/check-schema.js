const mysql = require('mysql2/promise');

async function checkSchema() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });
    
    const [rows] = await conn.execute('SHOW COLUMNS FROM excel_uploads');
    console.log('excel_uploads columns:', rows);
    
    const [rows2] = await conn.execute("SHOW COLUMNS FROM users LIKE 'excel_upload_id'");
    console.log('excel_upload_id column exists:', rows2.length > 0);
    
    await conn.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

checkSchema();