const { pool } = require('./db');

async function migrateHybridTracking() {
    try {
        console.log('Running Hybrid Tracking Migration...');

        // 1. Update roles
        await pool.execute("ALTER TABLE users MODIFY COLUMN role VARCHAR(50)");
        await pool.execute("UPDATE users SET role = 'student' WHERE role = 'USER'");
        await pool.execute("UPDATE users SET role = 'primary_admin' WHERE role = 'PRIMARY_ADMIN'");
        await pool.execute("UPDATE users SET role = 'superadmin' WHERE role = 'SUPERADMIN'");
        await pool.execute("ALTER TABLE users MODIFY COLUMN role ENUM('student', 'primary_admin', 'superadmin') NOT NULL DEFAULT 'student'");
        console.log('✓ Roles updated');

        // 2. Adjust buses table
        // Check if buses table exists
        const [tables] = await pool.execute("SHOW TABLES LIKE 'buses'");
        if (tables.length === 0) {
            await pool.execute(`
        CREATE TABLE buses (
          id INT PRIMARY KEY AUTO_INCREMENT,
          bus_no VARCHAR(50) UNIQUE NOT NULL,
          bus_name VARCHAR(100) NOT NULL,
          gps_device_id VARCHAR(100),
          mobile_live BOOLEAN DEFAULT FALSE,
          created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
        )
      `);
        } else {
            // Alter existing table
            const [columns] = await pool.execute("SHOW COLUMNS FROM buses");
            const columnNames = columns.map(c => c.Field);

            if (columnNames.includes('bus_number') && !columnNames.includes('bus_no')) {
                await pool.execute("ALTER TABLE buses CHANGE COLUMN bus_number bus_no VARCHAR(50) UNIQUE NOT NULL");
            }
            if (!columnNames.includes('bus_name')) {
                await pool.execute("ALTER TABLE buses ADD COLUMN bus_name VARCHAR(100) AFTER bus_no");
            }
            if (!columnNames.includes('gps_device_id')) {
                await pool.execute("ALTER TABLE buses ADD COLUMN gps_device_id VARCHAR(100) AFTER bus_name");
            }
            if (!columnNames.includes('mobile_live')) {
                await pool.execute("ALTER TABLE buses ADD COLUMN mobile_live BOOLEAN DEFAULT FALSE AFTER gps_device_id");
            }
        }
        console.log('✓ Buses table updated');

        // 3. Ensure all buses from users/bus_routes exist in buses table
        await pool.execute(`
      INSERT IGNORE INTO buses (bus_no, bus_name)
      SELECT DISTINCT bus_no, CONCAT('Bus ', bus_no) 
      FROM users 
      WHERE bus_no IS NOT NULL AND bus_no != ''
    `);
        console.log('✓ Bus records synchronized');

        console.log('Hybrid Tracking Migration Completed Successfully.');
        process.exit(0);
    } catch (err) {
        console.error('Migration failed:', err);
        process.exit(1);
    }
}

migrateHybridTracking();
