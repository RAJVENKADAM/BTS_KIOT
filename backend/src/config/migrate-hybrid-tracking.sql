-- Hybrid Tracking Migration
USE bts_db;

-- Update users role enum
ALTER TABLE users MODIFY COLUMN role ENUM('student', 'primary_admin', 'superadmin') NOT NULL DEFAULT 'student';

-- Create buses table
CREATE TABLE IF NOT EXISTS buses (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_no VARCHAR(50) UNIQUE NOT NULL,
    bus_name VARCHAR(100) NOT NULL,
    gps_device_id VARCHAR(100),
    mobile_live BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Copy existing bus_no to buses table if they don't exist
INSERT INTO buses (bus_no, bus_name)
SELECT DISTINCT bus_no, CONCAT('Bus ', bus_no) 
FROM users 
WHERE bus_no IS NOT NULL AND bus_no != ''
ON DUPLICATE KEY UPDATE bus_no = bus_no;
