const { pool } = require('../config/db');

class MessageService {
  async createAutoMessage(busNo, planName, createdBy) {
    try {
      // Create the auto-generated message
      const message = `Today bus ${busNo} is operated in ${planName}`;
      
      // Insert the message into the database
      const [result] = await pool.execute(
        'INSERT INTO messages (bus_no, plan_name, message, created_by) VALUES (?, ?, ?, ?)',
        [busNo, planName, message, createdBy]
      );

      return {
        id: result.insertId,
        busNo,
        planName,
        message,
        createdById: createdBy
      };
    } catch (error) {
      throw new Error(`Error creating auto message: ${error.message}`);
    }
  }

  async changeBusPlan(busNo, newPlan, userId) {
    try {
      // Update the current plan for all routes of this bus
      const [result] = await pool.execute(
        'UPDATE bus_routes SET current_plan = ? WHERE bus_no = ?',
        [newPlan, busNo]
      );

      // Create the auto message for the plan change
      const messageData = await this.createAutoMessage(busNo, newPlan, userId);

      return {
        busNo,
        newPlan,
        affectedRows: result.affectedRows,
        message: messageData
      };
    } catch (error) {
      throw new Error(`Error changing bus plan: ${error.message}`);
    }
  }

  async getCurrentPlan(busNo) {
    try {
      const [rows] = await pool.execute(
        'SELECT DISTINCT current_plan FROM bus_routes WHERE bus_no = ? AND current_plan IS NOT NULL LIMIT 1',
        [busNo]
      );

      if (rows.length > 0) {
        return rows[0].current_plan;
      }
      
      return null;
    } catch (error) {
      throw new Error(`Error getting current plan: ${error.message}`);
    }
  }

  async getAllMessages(busNo = null) {
    try {
      let query = 'SELECT m.*, u.name as created_by_name FROM messages m JOIN users u ON m.created_by = u.id';
      let params = [];

      if (busNo) {
        query += ' WHERE m.bus_no = ?';
        params = [busNo];
      }

      query += ' ORDER BY m.created_at DESC';

      const [messages] = await pool.execute(query, params);
      return messages;
    } catch (error) {
      throw new Error(`Error fetching messages: ${error.message}`);
    }
  }
}

module.exports = new MessageService();