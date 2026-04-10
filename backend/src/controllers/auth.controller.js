const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { pool } = require('../config/db');

const login = async (req, res) => {
  try {
    const { email, password } = req.body;

    // Validate input
    if (!email || !password) {
      return res.status(400).json({
        error: 'Email and password are required'
      });
    }

    // Find user by email
    const [users] = await pool.execute(
      'SELECT id, name, email, password_hash, role, bus_no, is_active, temp_password, deleted_by_user FROM users WHERE email = ?',
      [email]
    );

    if (users.length === 0) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    const user = users[0];

    // ✅ ENHANCED LOGIN LOGIC:
    // 1. If account was deleted by user themselves (deleted_by_user = true) -> Block login completely
    // 2. If SUPERADMIN account -> Allow login even when is_active = false (for system administration)
    // 3. If user has temporary password -> Allow login to change password (unless deleted by user)
    // 4. Regular users with is_active = false and no temp password -> Block login

    if (user.deleted_by_user) {
      return res.status(401).json({
        error: 'Account has been deleted. Credentials are invalid.'
      });
    }

    if (!user.is_active && user.role !== 'superadmin' && !user.temp_password) {
      return res.status(401).json({
        error: 'Account deactivated. Contact admin.'
      });
    }

    // This check allows users with temporary passwords to log in regardless of active status
    // The frontend will handle redirecting them to the ChangePassword screen

    // Verify password
    const isValidPassword = await bcrypt.compare(password, user.password_hash);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user.id,
        email: user.email,
        role: user.role
      },
      process.env.JWT_SECRET,
      { expiresIn: '24h' }
    );

    // Return user data and token
    res.status(200).json({
      message: 'Login successful',
      token: token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        bus_no: user.bus_no,
        is_active: user.is_active,
        temp_password: user.temp_password
      }
    });

  } catch (error) {
    console.error('Login error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

const getProfile = async (req, res) => {
  try {
    const userId = req.user.id;

    const [users] = await pool.execute(
      'SELECT id, name, email, role, bus_no, is_active, temp_password, deleted_by_user, created_at FROM users WHERE id = ?',
      [userId]
    );

    if (users.length === 0) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    const user = users[0];

    res.status(200).json({
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        role: user.role,
        bus_no: user.bus_no,
        is_active: user.is_active,
        temp_password: user.temp_password,
        created_at: user.created_at
      }
    });

  } catch (error) {
    console.error('Get profile error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};

const logout = async (req, res) => {
  // In a stateless JWT system, logout is handled client-side
  // by removing the token from storage
  res.status(200).json({
    message: 'Logout successful'
  });
};

const deleteUserAccount = async (req, res) => {
  try {
    const userId = req.user.id;

    // Mark user account as deleted by user
    // This will prevent login completely
    const [result] = await pool.execute(
      'UPDATE users SET is_active = FALSE, deleted_by_user = TRUE WHERE id = ?',
      [userId]
    );

    if (result.affectedRows === 0) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.status(200).json({
      message: 'Account deleted successfully. You will be logged out.'
    });

  } catch (error) {
    console.error('Delete user account error:', error);
    res.status(500).json({
      error: 'Internal server error'
    });
  }
};



const verifyToken = async (req, res) => {
  // If we reach here, token is valid (middleware passed)
  res.status(200).json({
    valid: true,
    user: req.user
  });
};

module.exports = {
  login,
  getProfile,
  logout,
  deleteUserAccount,
  verifyToken
};
