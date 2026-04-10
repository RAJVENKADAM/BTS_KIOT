-- Migration to add speed column to bus_live_locations table
-- Run this if the speed column is missing

USE bts_db;

-- Add speed column if it doesn't exist
ALTER TABLE bus_live_locations
ADD COLUMN speed DECIMAL(6, 2);

-- Verify the column was added
DESCRIBE bus_live_locations;