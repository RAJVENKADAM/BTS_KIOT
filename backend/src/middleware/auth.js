const jwt = require('jsonwebtoken');

const authenticateToken = (req, res, next) => {
  const authHeader = req.headers['authorization'];
  console.log('Auth header received:', authHeader ? 'Present' : 'Missing');
  const token = authHeader && authHeader.split(' ')[1]; // Bearer TOKEN

  if (!token) {
    console.log('No token provided');
    return res.status(401).json({
      error: 'Access token required'
    });
  }

  console.log('Token received, attempting to verify');

  jwt.verify(token, process.env.JWT_SECRET, (err, user) => {
    if (err) {
      console.log('Token verification failed:', err.message);
      return res.status(403).json({
        error: 'Invalid or expired token'
      });
    }

    console.log('Token verified successfully, user:', user);
    req.user = user;
    next();
  });
};

const authorizeRoles = (...roles) => {
  return (req, res, next) => {
    console.log('AuthorizeRoles middleware called, required roles:', roles);
    console.log('Request user:', req.user);

    if (!req.user) {
      console.log('No authenticated user found');
      return res.status(401).json({
        error: 'Authentication required'
      });
    }

    const userRole = (req.user.role || '').toUpperCase();
    const allowedRoles = roles.map(r => r.toUpperCase());

    console.log('Checking if user role', userRole, 'is in allowed roles:', allowedRoles);
    if (!allowedRoles.includes(userRole)) {
      console.log('User does not have required role. User role:', userRole, 'Required roles:', allowedRoles);
      return res.status(403).json({
        error: 'Insufficient permissions'
      });
    }

    console.log('User authorized successfully');
    next();
  };
};

module.exports = {
  authenticateToken,
  authorizeRoles
};