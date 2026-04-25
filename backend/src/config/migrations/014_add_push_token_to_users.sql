-- Migration 014: Add push_token column to users table for Expo Push Notifications
-- This supports the bus-based notification system

ALTER TABLE users ADD COLUMN IF NOT EXISTS push_token VARCHAR(255) NULL;

-- For MySQL versions that don't support IF NOT EXISTS in ALTER TABLE,
-- the application will handle column creation gracefully via ensurePushTokenColumn().

-- Add index for fast token lookups by bus
CREATE INDEX IF NOT EXISTS idx_users_push_token ON users(push_token);
CREATE INDEX IF NOT EXISTS idx_users_bus_active ON users(bus_no, is_active);

