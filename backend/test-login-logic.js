const mysql = require('mysql2/promise');
require('dotenv').config();

async function testLoginLogic() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'MYSQL@raj210',
    database: process.env.DB_NAME || 'bts_db'
  });

  try {
    console.log('Connected to database.');
    
    // Check the structure of the users table
    const [columns] = await connection.execute("SHOW COLUMNS FROM users LIKE 'deleted_by_user'");
    console.log('deleted_by_user column exists:', columns.length > 0);
    
    if (columns.length > 0) {
      console.log('Column details:', columns[0]);
    }
    
    // Check some sample users
    const [users] = await connection.execute(`
      SELECT id, name, email, role, is_active, temp_password, deleted_by_user 
      FROM users 
      ORDER BY id 
      LIMIT 5
    `);
    
    console.log('\nSample users:');
    users.forEach(user => {
      console.log(`ID: ${user.id}, Name: ${user.name}, Email: ${user.email}`);
      console.log(`  Role: ${user.role}, Active: ${user.is_active}, Temp Password: ${user.temp_password}, Deleted by User: ${user.deleted_by_user}`);
    });
    
    console.log('\n✅ Test completed successfully.');
    
  } catch (error) {
    console.error('Test error:', error.message);
  } finally {
    await connection.end();
  }
}

testLoginLogic();