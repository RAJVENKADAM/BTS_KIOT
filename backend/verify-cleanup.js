const mysql = require('mysql2/promise');

async function verifyCleanup() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });
    
    const [users] = await conn.execute('SELECT id, name, email, role FROM users');
    console.log('Remaining users:');
    users.forEach(u => {
      console.log(`ID: ${u.id}, Name: ${u.name}, Email: ${u.email}, Role: ${u.role}`);
    });
    
    await conn.end();
  } catch (error) {
    console.error('Error:', error.message);
  }
}

verifyCleanup();