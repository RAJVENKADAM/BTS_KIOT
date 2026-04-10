-- Migration 008: Add custom_name column to excel_uploads table
-- Date: 2026-02-09
-- Purpose: Add custom name support for Excel uploads

USE bts_db;

-- Add custom_name column to excel_uploads table
-- First check if column exists, then add it
SET @column_exists = (SELECT COUNT(*) FROM INFORMATION_SCHEMA.COLUMNS 
                      WHERE TABLE_SCHEMA = 'bts_db' 
                      AND TABLE_NAME = 'excel_uploads' 
                      AND COLUMN_NAME = 'custom_name');

SET @sql = IF(@column_exists = 0,
    'ALTER TABLE excel_uploads ADD COLUMN custom_name VARCHAR(255)',
    'SELECT "Column already exists" as message');

PREPARE stmt FROM @sql;
EXECUTE stmt;
DEALLOCATE PREPARE stmt;

-- Verify the changes
DESCRIBE excel_uploads;