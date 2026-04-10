-- Migration 013: Add repeat count to bus_states for repeated coordinate tracking
-- Date: 2026-04-09
-- Purpose: Track consecutive identical coordinates to determine waiting/stopped state based on count

USE bts_db;

ALTER TABLE bus_states
  ADD COLUMN repeat_count INT NOT NULL DEFAULT 1 AFTER last_coords_time;

-- Set default repeat_count to 1 for existing rows
UPDATE bus_states SET repeat_count = 1 WHERE repeat_count IS NULL;

DESCRIBE bus_states;
