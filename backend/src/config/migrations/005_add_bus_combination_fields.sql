-- Migration 005: Add bus combination fields
-- Date: 2026-01-27
-- Purpose: Add fields to support combining multiple buses under one operating bus

USE bts_db;

-- Add operating_bus_id and combined_buses fields to buses table
ALTER TABLE buses
ADD COLUMN operating_bus_id INT DEFAULT NULL,
ADD COLUMN combined_buses JSON DEFAULT NULL,
ADD COLUMN status ENUM('active', 'inactive', 'combined') DEFAULT 'active';

-- Add foreign key constraint for operating_bus_id
ALTER TABLE buses
ADD CONSTRAINT fk_operating_bus
FOREIGN KEY (operating_bus_id) REFERENCES buses(id) ON DELETE SET NULL;

-- Create index for better performance on operating_bus_id
CREATE INDEX IF NOT EXISTS idx_buses_operating_bus_id ON buses(operating_bus_id);

-- Update existing records to have status instead of is_active
UPDATE buses SET status = CASE WHEN is_active = 1 THEN 'active' ELSE 'inactive' END;

-- Drop the old is_active column
ALTER TABLE buses DROP COLUMN is_active;

-- Verify the changes
DESCRIBE buses;
