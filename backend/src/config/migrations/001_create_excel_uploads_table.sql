-- Migration 001: Create excel_uploads table and modify users table
-- Date: 2026-01-27
-- Purpose: Add Excel upload tracking with soft delete capability

USE bts_db;

-- Create excel_uploads table
CREATE TABLE IF NOT EXISTS excel_uploads (
    id CHAR(36) PRIMARY KEY, -- UUID
    file_name VARCHAR(255) NOT NULL,
    uploaded_by INT NOT NULL,
    uploaded_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (uploaded_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Add excel_upload_id column to users table (if not exists)
ALTER TABLE users 
ADD COLUMN IF NOT EXISTS excel_upload_id CHAR(36),
ADD FOREIGN KEY IF NOT EXISTS fk_excel_upload 
REFERENCES excel_uploads(id) ON DELETE SET NULL;

-- Add index for better performance
CREATE INDEX IF NOT EXISTS idx_users_excel_upload_id ON users(excel_upload_id);
CREATE INDEX IF NOT EXISTS idx_excel_uploads_uploaded_by ON excel_uploads(uploaded_by);

-- Verify the changes
DESCRIBE excel_uploads;
DESCRIBE users;