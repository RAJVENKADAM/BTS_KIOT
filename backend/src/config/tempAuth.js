// Temporary authentication system for testing without database
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
require('dotenv').config();

// Hardcoded superadmin user using env variables
const tempUsers = [
  {
    id: 1,
    name: 'Raj Venkadam',
    email: process.env.SUPERADMIN_EMAIL || 'rajvenkadam@gmail.com',
    password_hash: process.env.SUPERADMIN_PASSWORD_HASH || '$2a$12$gQQ15quczb2iBycx9iHp1O.LPAeSBk8yy6UjHuwEjl6ihMc55clde',
    role: 'SUPERADMIN',
    bus_no: null,
    is_active: true, // Always active for superadmin
    temp_password: false, // Permanent password for superadmin
    created_at: new Date(),
    updated_at: new Date()
  }
];

const findUserByEmail = async (email) => {
  return tempUsers.find(user => user.email === email);
};

const verifyPassword = async (password, hash) => {
  return await bcrypt.compare(password, hash);
};

const generateToken = (user) => {
  return jwt.sign(
    { 
      id: user.id, 
      email: user.email, 
      role: user.role 
    },
    process.env.JWT_SECRET || 'supersecretkey',
    { expiresIn: '24h' }
  );
};

module.exports = {
  findUserByEmail,
  verifyPassword,
  generateToken,
  tempUsers
};