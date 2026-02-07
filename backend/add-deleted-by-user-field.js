const mysql = require('mysql2/promise');
require('dotenv').config();

async function addDeletedByUserField() {
  const connection = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'MYSQL@raj210',
    database: process.env.DB_NAME || 'bts_db'
  });

  try {
    console.log('Connected to database.');

    // Check if the column already exists
    const [columns] = await connection.execute(
      "SHOW COLUMNS FROM users LIKE 'deleted_by_user'"
    );

    if (columns.length > 0) {
      console.log('deleted_by_user column already exists.');
      return;
    }

    console.log('Adding deleted_by_user column to users table...');
    
    // Add the new column
    await connection.execute(`
      ALTER TABLE users 
      ADD COLUMN deleted_by_user BOOLEAN DEFAULT FALSE 
      AFTER is_active
    `);

    console.log('Column added successfully.');
    
    // Update existing records to have default value
    await connection.execute(`
      UPDATE users 
      SET deleted_by_user = FALSE 
      WHERE deleted_by_user IS NULL
    `);
    
    console.log('Existing records updated with default values.');
    
    // Create index for performance
    await connection.execute(`
      CREATE INDEX idx_users_deleted_by_user ON users(deleted_by_user)
    `);
    
    console.log('Index created successfully.');
    console.log('✅ Migration completed successfully.');

  } catch (error) {
    console.error('Error adding deleted_by_user field:', error.message);
    throw error;
  } finally {
    await connection.end();
  }
}

// Run the migration
if (require.main === module) {
  addDeletedByUserField()
    .then(() => {
      console.log('Migration script completed.');
      process.exit(0);
    })
    .catch((error) => {
      console.error('Migration failed:', error.message);
      process.exit(1);
    });
}

module.exports = addDeletedByUserField;