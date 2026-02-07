require('dotenv').config();
const { pool } = require('./src/config/db');

async function testPasswordUpdate() {
  try {
    console.log('Testing password update functionality...');
    
    // Test with user ID 17 (Test Known User) who has temp_password = 1
    const userId = 17;
    
    console.log(`Testing user ID: ${userId}`);
    
    // Check current state
    const [beforeResult] = await pool.execute(
      'SELECT id, name, email, temp_password, is_active FROM users WHERE id = ?',
      [userId]
    );
    
    console.log('Before update:', beforeResult[0]);
    
    // Simulate password change update
    const updateResult = await pool.execute(
      'UPDATE users SET temp_password = 0 WHERE id = ?',
      [userId]
    );
    
    console.log('Update result:', updateResult);
    
    // Verify the update
    const [afterResult] = await pool.execute(
      'SELECT id, name, email, temp_password, is_active FROM users WHERE id = ?',
      [userId]
    );
    
    console.log('After update:', afterResult[0]);
    
    if (afterResult[0].temp_password == 0) {  // Using == for string/number comparison
      console.log('✅ Update successful - temp_password is now 0');
    } else {
      console.log('❌ Update failed - temp_password is still:', afterResult[0].temp_password);
    }
    
    // Test the reverse update to restore original state
    console.log('\nRestoring original state...');
    await pool.execute(
      'UPDATE users SET temp_password = 1 WHERE id = ?',
      [userId]
    );
    
    const [finalResult] = await pool.execute(
      'SELECT temp_password FROM users WHERE id = ?',
      [userId]
    );
    
    console.log('Restored state - temp_password:', finalResult[0].temp_password);
    
  } catch (error) {
    console.error('Test error:', error);
  } finally {
    await pool.end();
  }
}

testPasswordUpdate();