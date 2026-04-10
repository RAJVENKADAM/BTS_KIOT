const { pool } = require('./db');

async function migrate() {
    try {
        console.log('Starting migration...');

        // First, allow the new roles in the ENUM temporarily or use VARCHAR
        await pool.execute("ALTER TABLE users MODIFY COLUMN role VARCHAR(50)");

        // Update existing values
        await pool.execute("UPDATE users SET role = 'student' WHERE role = 'USER'");
        await pool.execute("UPDATE users SET role = 'primary_admin' WHERE role = 'PRIMARY_ADMIN'");
        await pool.execute("UPDATE users SET role = 'superadmin' WHERE role = 'SUPERADMIN'");

        // Now set the ENUM
        await pool.execute("ALTER TABLE users MODIFY COLUMN role ENUM('student', 'primary_admin', 'superadmin') NOT NULL DEFAULT 'student'");
        console.log('Users role enum updated.');

        // Create buses table
        await pool.execute(`
      CREATE TABLE IF NOT EXISTS buses (
        id INT PRIMARY KEY AUTO_INCREMENT,
        bus_no VARCHAR(50) UNIQUE NOT NULL,
        bus_name VARCHAR(100) NOT NULL,
        gps_device_id VARCHAR(100),
        mobile_live BOOLEAN DEFAULT FALSE,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
      )
    `);
        console.log('Buses table created.');

        // Copy existing bus_no to buses table
        await pool.execute(`
      INSERT INTO buses (bus_no, bus_name)
      SELECT DISTINCT bus_no, CONCAT('Bus ', bus_no) 
      FROM users 
      WHERE bus_no IS NOT NULL AND bus_no != ''
      ON DUPLICATE KEY UPDATE bus_no = VALUES(bus_no)
    `);
        console.log('Existing buses migrated.');

        console.log('Migration completed successfully.');
        process.exit(0);
    } catch (error) {
        console.error('Migration failed:', error);
        process.exit(1);
    }
}

migrate();
