const mysql = require('mysql2/promise');
const fs = require('fs');
const path = require('path');
require('dotenv').config(); // Make sure this is added

async function setupDatabase() {
  console.log('Setting up BTS Database...\n');
  
  try {
    // Read SQL file
    const sqlFilePath = path.join(__dirname, 'src', 'config', 'db.sql');
    const sql = fs.readFileSync(sqlFilePath, 'utf8');
    
    // Create connection without specifying database (to create it)
    const connection = await mysql.createConnection({
      host: process.env.DB_HOST || 'localhost',
      user: process.env.DB_USER || 'root',
      password: process.env.DB_PASSWORD || '',
    });
    
    console.log('Connected to MySQL server.');
    
    // Execute SQL statements
    const statements = sql.split(';').filter(stmt => stmt.trim());
    
    for (const statement of statements) {
      if (statement.trim()) {
        try {
          const [results] = await connection.execute(statement);
          console.log('Executed:', statement.substring(0, 50) + '...');
          
          // Log any messages from SELECT statements
          if (Array.isArray(results) && results.length > 0) {
            results.forEach(row => {
              if (row.message) {
                console.log('Message:', row.message);
              }
              if (row.superadmin_count !== undefined) {
                console.log('SUPERADMIN count:', row.superadmin_count);
              }
            });
          }
        } catch (error) {
          // Skip errors for CREATE DATABASE IF NOT EXISTS
          if (!error.message.includes('database exists')) {
            console.error('Error executing statement:', error.message);
          }
        }
      }
    }
    
    await connection.end();
    console.log('\nDatabase setup completed successfully!');
    
  } catch (error) {
    console.error('Database setup failed:', error.message);
  }
}

setupDatabase();