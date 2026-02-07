-- Migration 004: Create buses table with is_active field
-- Date: 2026-01-27
-- Purpose: Create buses table to store bus information separately from users

USE bts_db;

-- Create buses table
CREATE TABLE IF NOT EXISTS buses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_number VARCHAR(50) UNIQUE NOT NULL,
    current_plan VARCHAR(100) DEFAULT NULL,
    is_active BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Create index for better performance
CREATE INDEX IF NOT EXISTS idx_buses_bus_number ON buses(bus_number);
CREATE INDEX IF NOT EXISTS idx_buses_is_active ON buses(is_active);

-- Migrate existing bus data from bus_routes to buses table
-- Insert distinct bus_numbers from bus_routes into buses table
INSERT IGNORE INTO buses (bus_number, is_active)
SELECT DISTINCT bus_no, TRUE FROM bus_routes;

-- Update bus_routes to reference buses.id instead of users.bus_no
-- First, add bus_id column to bus_routes
ALTER TABLE bus_routes
ADD COLUMN bus_id INT,
ADD FOREIGN KEY (bus_id) REFERENCES buses(id) ON DELETE CASCADE;

-- Populate bus_id in bus_routes
UPDATE bus_routes br
JOIN buses b ON br.bus_no = b.bus_number
SET br.bus_id = b.id;

-- Drop the old bus_no column from bus_routes (after ensuring bus_id is populated)
-- Note: This will be done in a separate migration to avoid data loss

-- Verify the changes
DESCRIBE buses;
SELECT COUNT(*) as buses_count FROM buses;
