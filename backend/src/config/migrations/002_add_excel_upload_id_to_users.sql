-- Simplified migration for existing excel_uploads table
USE bts_db;

-- Add excel_upload_id column to users table if it doesn't exist
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS excel_upload_id INT,
ADD FOREIGN KEY IF NOT EXISTS fk_excel_upload (excel_upload_id) 
REFERENCES excel_uploads(id) ON DELETE SET NULL;

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_users_excel_upload_id ON users(excel_upload_id);

-- Verify the changes
DESCRIBE users;