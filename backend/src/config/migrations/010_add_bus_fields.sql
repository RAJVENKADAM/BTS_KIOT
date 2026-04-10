-- Migration 010: Add required bus fields for scalable tracking
-- Run: node backend/run-migration.js or manually

ALTER TABLE buses 
ADD COLUMN bus_name VARCHAR(100) AFTER bus_no,
ADD COLUMN reg_no VARCHAR(20) AFTER bus_name,
ADD COLUMN route_excel_path VARCHAR(255) AFTER reg_no;

-- Update existing buses with defaults if needed
UPDATE buses SET bus_name = CONCAT('Bus ', bus_no), reg_no = bus_no WHERE bus_name IS NULL OR reg_no IS NULL;

-- Add indexes for performance
CREATE INDEX idx_buses_device_id ON buses(gps_device_id);
CREATE INDEX idx_buses_reg_no ON buses(reg_no);
CREATE INDEX idx_buses_status ON buses(status);

-- Verify
SELECT bus_no, bus_name, reg_no, gps_device_id, route_excel_path FROM buses LIMIT 5;

