const mysql = require('mysql2/promise');

async function deleteNonSuperadminUsers() {
  try {
    const conn = await mysql.createConnection({
      host: 'localhost',
      user: 'root',
      password: 'MYSQL@raj210',
      database: 'bts_db'
    });
    
    console.log('Connected to database.');
    
    // First, let's see what users exist
    const [allUsers] = await conn.execute('SELECT id, name, email, role, is_active FROM users ORDER BY id');
    console.log('\nCurrent users in database:');
    allUsers.forEach(user => {
      console.log(`ID: ${user.id}, Name: ${user.name}, Email: ${user.email}, Role: ${user.role}, Active: ${user.is_active}`);
    });
    
    // Count non-superadmin users
    const [nonSuperadminCount] = await conn.execute(
      "SELECT COUNT(*) as count FROM users WHERE email != 'rajvenkadam@gmail.com'"
    );
    
    console.log(`\nFound ${nonSuperadminCount[0].count} non-superadmin users.`);
    
    if (nonSuperadminCount[0].count > 0) {
      // Show which users will be deleted
      const [usersToDelete] = await conn.execute(
        "SELECT id, name, email, role FROM users WHERE email != 'rajvenkadam@gmail.com'"
      );
      
      console.log('\nUsers to be deleted:');
      usersToDelete.forEach(user => {
        console.log(`- ${user.name} (${user.email}) - ${user.role}`);
      });
      
      // Delete all users except superadmin
      const [result] = await conn.execute(
        "DELETE FROM users WHERE email != 'rajvenkadam@gmail.com'"
      );
      
      console.log(`\n✅ Successfully deleted ${result.affectedRows} users.`);
      
      // Verify remaining users
      const [remainingUsers] = await conn.execute('SELECT id, name, email, role FROM users ORDER BY id');
      console.log('\nRemaining users:');
      remainingUsers.forEach(user => {
        console.log(`ID: ${user.id}, Name: ${user.name}, Email: ${user.email}, Role: ${user.role}`);
      });
      
    } else {
      console.log('\n✅ No non-superadmin users found. Database is already clean.');
    }
    
    await conn.end();
    console.log('\n✅ Database cleanup completed successfully!');
    
  } catch (error) {
    console.error('Error:', error.message);
    process.exit(1);
  }
}

deleteNonSuperadminUsers();