const { pool } = require('../config/db');
const { getIO } = require('../socket'); // Get the shared Socket.IO instance
const NotificationService = require('../services/notificationService');

// Get messages based on user role and permissions
async function getMessages(req, res) {
  try {
    const userId = req.user.id;
    const userRole = req.user.role;
    
    // Get user details to determine bus access
    const [userResult] = await pool.execute(
      'SELECT id, name, email, role, bus_no FROM users WHERE id = ?',
      [userId]
    );
    
    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }
    
    const user = userResult[0];
    
    let query = `
      SELECT m.*, u.name as sender_name, u.role as sender_role,
        (mr.read_at IS NOT NULL) AS is_read
      FROM messages m
      LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
      JOIN users u ON u.id = m.sender_id
    `;
    let params = [];
    params.push(userId);
    
    // Apply different filters based on user role
    if (userRole === 'SUPERADMIN') {
      // Superadmin sees all messages
      query += ' ORDER BY m.created_at DESC';
    } else if (userRole === 'PRIMARY_ADMIN') {
      // Primary admin sees messages for their bus and general messages
      query += `
        WHERE (m.bus_number = ? OR m.message_type = 'general')
        ORDER BY m.created_at DESC
      `;
      params.push(user.bus_no);
    } else {
      // Regular user sees messages for their bus and general messages
      query += `
        WHERE (m.bus_number = ? OR m.message_type = 'general')
        ORDER BY m.created_at DESC
      `;
      params.push(user.bus_no);
    }
    
    const [messages] = await pool.execute(query, params);
    
    res.status(200).json({
      messages: messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Error fetching messages:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get general messages (plan changes, etc.)
async function getGeneralMessages(req, res) {
  try {
    const [messages] = await pool.execute(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.plan_name IS NOT NULL
      ORDER BY m.created_at DESC
    `);
    
    res.status(200).json({
      messages: messages,
      count: messages.length
    });
  } catch (error) {
    console.error('Error fetching general messages:', error);
    res.status(500).json({ error: error.message });
  }
}

// Get messages for user's bus
async function getMyBusMessages(req, res) {
  try {
    const userId = req.user.id;
    
    // Get user's bus
    const [userResult] = await pool.execute(
      'SELECT bus_no FROM users WHERE id = ?',
      [userId]
    );
    
    if (userResult.length === 0 || !userResult[0].bus_no) {
      return res.status(200).json({
        messages: [],
        count: 0
      });
    }
    
    const userBus = userResult[0].bus_no;
    
    const [messages] = await pool.execute(`
      SELECT m.*, u.name as sender_name, u.role as sender_role,
        (mr.read_at IS NOT NULL) AS is_read
      FROM messages m
      LEFT JOIN message_reads mr ON mr.message_id = m.id AND mr.user_id = ?
      JOIN users u ON u.id = COALESCE(m.sender_id, m.created_by)
      WHERE m.bus_number = ?
      ORDER BY m.created_at DESC
    `, [userId, userBus]);
    
    res.status(200).json({
      messages: messages,
      count: messages.length,
      busNo: userBus
    });
  } catch (error) {
    console.error('Error fetching my bus messages:', error);
    res.status(500).json({ error: error.message });
  }
}

// Send a message based on user role
async function sendMessage(req, res) {
  try {
    const userId = req.user.id;
    const { message, busNo, messageType } = req.body; // messageType could be 'general', 'bus-specific', 'all', etc.

    if (!message) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    // Get user details to check permissions
    const [userResult] = await pool.execute(
      'SELECT id, name, email, role, bus_no FROM users WHERE id = ?',
      [userId]
    );

    if (userResult.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const user = userResult[0];

    // Determine who can send messages based on role
    if (user.role === 'USER') {
      return res.status(403).json({ error: 'Regular users cannot send messages' });
    }

    let targetBusNo = null;
    let finalMessageType = messageType || 'general';

    // Handle different message types
    if (messageType === 'all') {
      // SUPERADMIN can send to all users
      if (user.role === 'SUPERADMIN') {
        targetBusNo = null;
        finalMessageType = 'general';
      } else {
        return res.status(403).json({ error: 'Only superadmin can send messages to all users' });
      }
    } else if (messageType === 'bus') {
      // Bus-specific message
      if (user.role === 'PRIMARY_ADMIN') {
        targetBusNo = user.bus_no;
        finalMessageType = 'bus';
      } else if (user.role === 'SUPERADMIN') {
        targetBusNo = busNo;
        finalMessageType = 'bus';
      } else {
        return res.status(403).json({ error: 'Insufficient permissions to send bus-specific messages' });
      }
    } else {
      // General message
      targetBusNo = null;
      finalMessageType = 'general';
    }

    // For PRIMARY_ADMIN, they can only send to their own bus
    if (user.role === 'PRIMARY_ADMIN' && targetBusNo && targetBusNo !== user.bus_no) {
      return res.status(403).json({ error: 'Primary admin can only send messages to their own bus' });
    }

    // Insert the message
    const [result] = await pool.execute(
      'INSERT INTO messages (bus_number, message_type, message, sender_id) VALUES (?, ?, ?, ?)',
      [targetBusNo, finalMessageType, message, userId]
    );

    // Fetch the created message to return
    const [createdMessage] = await pool.execute(`
      SELECT m.*, u.name as sender_name, u.role as sender_role
      FROM messages m
      JOIN users u ON m.sender_id = u.id
      WHERE m.id = ?
    `, [result.insertId]);
    
    // Emit real-time event via Socket.IO
    const messageData = {
      ...createdMessage[0],
      timestamp: new Date().toISOString()
    };
    
    // Determine the room to broadcast to
    const room = targetBusNo ? `bus-${targetBusNo}` : 'general';
    
    // Emit to the appropriate room
    const io = getIO();
    if (io) {
      io.to(room).emit('new-message', messageData);
    }

    // Send push notifications to appropriate users
    try {
      let busNumbers = [];
      let title = 'New Message';
      let body = message;

      if (user.role === 'SUPERADMIN') {
        // Superadmin sends to all users - get all active buses
        const [busesResult] = await pool.execute(
          'SELECT bus_number FROM buses WHERE status = "active"'
        );
        busNumbers = busesResult.map(bus => bus.bus_number);
        title = 'Message from Super Admin';
      } else if (user.role === 'PRIMARY_ADMIN') {
        // Primary admin sends to their bus users
        busNumbers = [targetBusNo];
        title = `Message from ${user.name}`;
      }

      if (busNumbers.length > 0) {
        await NotificationService.notifyBusUpdate({
          actorId: userId,
          actionType: 'MESSAGE',
          busNumbers: busNumbers,
          title: title,
          body: body
        });
      }
    } catch (notifyErr) {
      console.error('Notification error (manual message):', notifyErr.message);
      // Don't fail the message sending if notification fails
    }

    res.status(201).json({
      message: 'Message sent successfully',
      data: createdMessage[0]
    });
  } catch (error) {
    console.error('Error sending message:', error);
    res.status(500).json({ error: error.message });
  }
}

// Mark a message as read by the current user
async function markMessageRead(req, res) {
  try {
    const userId = req.user.id;
    const messageId = req.params.id;

    if (!messageId) return res.status(400).json({ error: 'Message id is required' });

    // Ensure message_reads table exists
    try {
      await pool.execute(`
        CREATE TABLE IF NOT EXISTS message_reads (
          id INT PRIMARY KEY AUTO_INCREMENT,
          message_id INT NOT NULL,
          user_id INT NOT NULL,
          read_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
          UNIQUE KEY unique_message_user (message_id, user_id)
        )
      `);
    } catch (err) {
      // ignore
    }

    // Insert or update read record
    await pool.execute(
      `INSERT INTO message_reads (message_id, user_id, read_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE read_at = NOW()`,
      [messageId, userId]
    );

    res.status(200).json({ message: 'Marked as read' });
  } catch (error) {
    console.error('Error marking message read:', error);
    res.status(500).json({ error: error.message });
  }
}

module.exports = {
  getMessages,
  getGeneralMessages,
  getMyBusMessages,
  sendMessage,
  markMessageRead
};