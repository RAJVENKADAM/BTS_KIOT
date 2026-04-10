-- Migration 009: Add advanced bus features
-- preview_number, enhanced status enum, is_moving, altered_by
-- Date: Current
-- Purpose: Support real-time transport management features

USE bts_db;

-- Add preview_number column (unique display ID)
ALTER TABLE buses 
ADD COLUMN IF NOT EXISTS preview_number VARCHAR(20) UNIQUE AFTER bus_no;

-- Enhance status with full enum (active, deactivated, altered, combined)
ALTER TABLE buses 
MODIFY COLUMN IF EXISTS status ENUM('active', 'deactivated', 'altered', 'combined') DEFAULT 'active';

-- Add if not exists
ALTER TABLE buses 
ADD COLUMN IF NOT EXISTS status ENUM('active', 'deactivated', 'altered', 'combined') DEFAULT 'active' AFTER bus_no;

-- Add is_moving for live status
ALTER TABLE buses 
ADD COLUMN IF NOT EXISTS is_moving BOOLEAN DEFAULT FALSE AFTER status;

-- Add altered_by for alter logic
ALTER TABLE buses 
ADD COLUMN IF NOT EXISTS altered_by VARCHAR(50) DEFAULT NULL AFTER is_moving;

-- Update existing buses to active status if status field was different
UPDATE buses SET status = 'active' WHERE status NOT IN ('active', 'deactivated', 'altered', 'combined');

-- Indexes for performance
CREATE INDEX IF NOT EXISTS idx_buses_preview_number ON buses(preview_number);
CREATE INDEX IF NOT EXISTS idx_buses_status ON buses(status);
CREATE INDEX IF NOT EXISTS idx_buses_is_moving ON buses(is_moving);
CREATE INDEX IF NOT EXISTS idx_buses_altered_by ON buses(altered_by);

-- Verify changes
DESCRIBE buses;
SELECT COUNT(*) as buses_count, GROUP_CONCAT(DISTINCT status) as statuses FROM buses;
