const jwt = require('jsonwebtoken');
const User = require('../models/User');

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
    const user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Enhanced login logic:
    // 1. If deleted by user -> Block login completely
    // 2. If SUPERADMIN -> Allow login even if inactive (system admin access)
    // 3. If temp password -> Allow login to change password (unless deleted)
    // 4. Regular users inactive -> Block login

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

    // Verify password using schema method
    const isValidPassword = await user.comparePassword(password);

    if (!isValidPassword) {
      return res.status(401).json({
        error: 'Invalid credentials'
      });
    }

    // Generate JWT token
    const token = jwt.sign(
      {
        id: user._id,
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
        id: user._id,
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

    const user = await User.findById(userId).select('-password_hash');

    if (!user) {
      return res.status(404).json({
        error: 'User not found'
      });
    }

    res.status(200).json({
      user: {
        id: user._id,
        name: user.name,
        email: user.email,
        role: user.role,
        bus_no: user.bus_no,
        is_active: user.is_active,
        temp_password: user.temp_password,
        created_at: user.createdAt
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
    const result = await User.updateOne(
      { _id: userId },
      { 
        is_active: false, 
        deleted_by_user: true 
      }
    );

    if (result.modifiedCount === 0) {
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
  try {
    // If we reach here, token is valid (middleware passed)
    // But we MUST also check if the user account is still active
    // This catches deactivated users who still have valid tokens
    const user = await User.findById(req.user.id).select('is_active deleted_by_user');

    if (!user || !user.is_active || user.deleted_by_user) {
      return res.status(403).json({
        valid: false,
        message: 'Account has been deactivated. Please contact admin.',
        deactivated: true
      });
    }

    res.status(200).json({
      valid: true,
      user: req.user
    });
  } catch (error) {
    console.error('verifyToken error:', error);
    res.status(500).json({
      valid: false,
      error: 'Internal server error'
    });
  }
};

module.exports = {
  login,
  getProfile,
  logout,
  deleteUserAccount,
  verifyToken
};
