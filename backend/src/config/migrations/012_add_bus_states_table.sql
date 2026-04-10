-- Migration 012: Add bus states table for tracking moving/waiting/stopped status
-- Date: 2026-04-09
-- Purpose: Track bus states based on coordinate changes over time

USE bts_db;

-- Create bus_states table
CREATE TABLE IF NOT EXISTS bus_states (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_no VARCHAR(50) NOT NULL,
    state ENUM('moving', 'waiting', 'stopped') DEFAULT 'moving',
    last_latitude DECIMAL(10, 8),
    last_longitude DECIMAL(11, 8),
    last_coords_time TIMESTAMP NULL,
    state_changed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (bus_no) REFERENCES buses(bus_no) ON DELETE CASCADE,
    UNIQUE KEY unique_bus_state (bus_no)
);

-- Add indexes for performance
CREATE INDEX idx_bus_states_bus_no ON bus_states(bus_no);
CREATE INDEX idx_bus_states_state ON bus_states(state);
CREATE INDEX idx_bus_states_last_coords_time ON bus_states(last_coords_time);

-- Insert initial states for existing buses
INSERT IGNORE INTO bus_states (bus_no, state)
SELECT bus_no, 'moving' FROM buses WHERE status = 'active';

-- Verify
DESCRIBE bus_states;
SELECT COUNT(*) as states_count FROM bus_states;