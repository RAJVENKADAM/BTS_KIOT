-- BTS Database Schema
-- Create database
CREATE DATABASE IF NOT EXISTS bts_db CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

USE bts_db;

-- Drop tables if exists (for clean setup)
DROP TABLE IF EXISTS bus_live_locations;
DROP TABLE IF EXISTS messages;
DROP TABLE IF EXISTS bus_routes;
DROP TABLE IF EXISTS users;

-- Create users table
CREATE TABLE users (
    id INT PRIMARY KEY AUTO_INCREMENT,
    name VARCHAR(100) NOT NULL,
    email VARCHAR(150) UNIQUE NOT NULL,
    password_hash VARCHAR(255) NOT NULL,
    role ENUM('USER', 'PRIMARY_ADMIN', 'SUPERADMIN') NOT NULL DEFAULT 'USER',
    bus_no VARCHAR(50),
    is_active BOOLEAN DEFAULT TRUE,
    temp_password BOOLEAN DEFAULT TRUE,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
);

-- Create bus_routes table
CREATE TABLE bus_routes (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_no VARCHAR(50) NOT NULL,
    plan_name VARCHAR(100) NOT NULL,
    stop_name VARCHAR(200) NOT NULL,
    stop_order INT NOT NULL,
    current_plan VARCHAR(100) DEFAULT NULL, -- Track current active plan
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (bus_no) REFERENCES users(bus_no) ON DELETE CASCADE
);

-- Create messages table
CREATE TABLE messages (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_no VARCHAR(50) NOT NULL,
    plan_name VARCHAR(100) NOT NULL,
    message TEXT NOT NULL,
    created_by INT NOT NULL,
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE CASCADE
);

-- Create bus_live_locations table
CREATE TABLE bus_live_locations (
    id INT PRIMARY KEY AUTO_INCREMENT,
    bus_no VARCHAR(50) NOT NULL,
    latitude DECIMAL(10, 8) NOT NULL,
    longitude DECIMAL(11, 8) NOT NULL,
    speed DECIMAL(6, 2),
    accuracy DECIMAL(8, 2),
    updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    FOREIGN KEY (bus_no) REFERENCES users(bus_no) ON DELETE CASCADE,
    UNIQUE KEY unique_bus_location (bus_no)
);

-- Create indexes for better performance
CREATE INDEX idx_users_email ON users(email);
CREATE INDEX idx_users_role ON users(role);
CREATE INDEX idx_users_bus_no ON users(bus_no);
CREATE INDEX idx_users_is_active ON users(is_active);
CREATE INDEX idx_bus_routes_bus_no ON bus_routes(bus_no);
CREATE INDEX idx_bus_routes_plan_name ON bus_routes(plan_name);
CREATE INDEX idx_bus_routes_current_plan ON bus_routes(current_plan);
CREATE INDEX idx_messages_bus_no ON messages(bus_no);
CREATE INDEX idx_messages_created_at ON messages(created_at);
CREATE INDEX idx_bus_live_locations_bus_no ON bus_live_locations(bus_no);

-- Insert SUPERADMIN user
-- Password: Raj@210 (hashed using bcrypt with salt rounds = 12)
INSERT INTO users (name, email, password_hash, role, is_active, temp_password) 
VALUES (
    'Raj Venkadam', 
    'rajvenkadam@gmail.com', 
    '$2b$12$INJuxx2bL3SVgaA71nZWIuNIJuwFy63wjU2NPtUJQ8fIcA.pwQE02', 
    'SUPERADMIN', 
    TRUE, 
    TRUE
);

-- Verify the insertion
SELECT 'Database setup completed successfully!' as message;
SELECT COUNT(*) as superadmin_count FROM users WHERE role = 'SUPERADMIN' AND email = 'rajvenkadam@gmail.com';