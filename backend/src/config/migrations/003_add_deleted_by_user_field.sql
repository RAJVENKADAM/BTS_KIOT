-- Add deleted_by_user field to users table
-- This field will track whether a user deleted their own account
-- vs accounts deactivated by admins

ALTER TABLE users 
ADD COLUMN deleted_by_user BOOLEAN DEFAULT FALSE 
AFTER is_active;

-- Update existing users to have the default value
UPDATE users 
SET deleted_by_user = FALSE 
WHERE deleted_by_user IS NULL;

-- Add index for performance
CREATE INDEX idx_users_deleted_by_user ON users(deleted_by_user);