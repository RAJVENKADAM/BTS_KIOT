-- Migration 007: Add missing columns to messages table
-- Date: 2026-02-04
-- Purpose: Add bus_no, plan_name, and sender_id columns to messages table

USE bts_db;

-- Add missing columns to messages table
ALTER TABLE messages
ADD COLUMN IF NOT EXISTS bus_no VARCHAR(50),
ADD COLUMN IF NOT EXISTS plan_name VARCHAR(100),
ADD COLUMN IF NOT EXISTS sender_id INT,
ADD CONSTRAINT fk_messages_sender_id FOREIGN KEY (sender_id) REFERENCES users(id) ON DELETE SET NULL;

-- Make plan_name nullable if it's not already
ALTER TABLE messages MODIFY COLUMN plan_name VARCHAR(100);

-- Add indexes for better performance
CREATE INDEX IF NOT EXISTS idx_messages_bus_no ON messages(bus_no);
CREATE INDEX IF NOT EXISTS idx_messages_plan_name ON messages(plan_name);
CREATE INDEX IF NOT EXISTS idx_messages_sender_id ON messages(sender_id);

-- Verify the changes
DESCRIBE messages;
