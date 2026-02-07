const mysql = require('mysql2/promise');

async function checkDatabaseState() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });
    
    console.log('Connected to database.');
    
    // Check users
    const [users] = await conn.execute('SELECT id, name, email, role, is_active, temp_password FROM users ORDER BY id');
    console.log('\nUsers in database:');
    users.forEach(user => {
      console.log(`ID: ${user.id}, Name: ${user.name}, Email: ${user.email}, Role: ${user.role}, Active: ${user.is_active}, Temp Password: ${user.temp_password}`);
    });
    
    // Check excel uploads
    const [uploads] = await conn.execute('SELECT * FROM excel_uploads');
    console.log('\nExcel uploads:');
    if (uploads.length === 0) {
      console.log('No excel uploads found.');
    } else {
      uploads.forEach(upload => {
        console.log(`ID: ${upload.id}, File: ${upload.file_name}, Uploaded by: ${upload.uploaded_by}, Uploaded at: ${upload.uploaded_at}`);
      });
    }
    
    await conn.end();
    console.log('\nDatabase state check completed.');
    
  } catch (error) {
    console.error('Error checking database state:', error.message);
  }
}

checkDatabaseState();