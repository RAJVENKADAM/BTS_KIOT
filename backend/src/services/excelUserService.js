const xlsx = require('xlsx');
const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { sendEmail } = require('../services/emailService');

class ExcelUserService {
  async processExcelFile(filePath) {
    try {
      // Verify the file exists and is readable before processing
      const fs = require('fs');
      if (!fs.existsSync(filePath)) {
        throw new Error('Uploaded file not found on server');
      }

      const stats = fs.statSync(filePath);
      if (stats.size === 0) {
        throw new Error('Uploaded file is empty');
      }

      const workbook = xlsx.readFile(filePath);
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);

      if (!jsonData || jsonData.length === 0) {
        throw new Error('Excel file contains no data');
      }

      return this.validateAndNormalizeData(jsonData);
    } catch (error) {
      throw new Error(`Error processing Excel file: ${error.message}`);
    }
  }

  async processExcelBuffer(buffer) {
    try {
      // Process Excel from buffer (for memory storage uploads)
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);

      return this.validateAndNormalizeData(jsonData);
    } catch (error) {
      throw new Error(`Error processing Excel buffer: ${error.message}`);
    }
  }

  validateAndNormalizeData(jsonData) {
    try {

      // Validate required columns
      const requiredColumns = ['name', 'email', 'busno', 'role', 'mobile_no', 'date_of_year'];
      const headers = Object.keys(jsonData[0] || {});

      for (const col of requiredColumns) {
        if (!headers.includes(col)) {
          throw new Error(`Missing required column: ${col}`);
        }
      }

      // Normalize role values
      const normalizedData = jsonData.map(row => ({
        name: row.name?.toString().trim(),
        email: row.email?.toString().toLowerCase().trim(),
        busno: row.busno?.toString().trim() || null,
        role: this.normalizeRole(row.role?.toString().trim()),
        phone: row.mobile_no?.toString().trim(),
        dob: row.date_of_year?.toString().trim()
      }));

      // Validate data
      for (const user of normalizedData) {
        if (!this.isValidEmail(user.email)) {
          throw new Error(`Invalid email format: ${user.email}`);
        }
        if (!user.name || user.name.length < 2) {
          throw new Error(`Invalid name: ${user.name}`);
        }
        if (!user.role) {
          throw new Error(`Invalid role: ${user.role}`);
        }
      }

      // Check for duplicate emails in the Excel file
      const emailCounts = {};
      for (const user of normalizedData) {
        emailCounts[user.email] = (emailCounts[user.email] || 0) + 1;
      }
      const duplicates = Object.keys(emailCounts).filter(email => emailCounts[email] > 1);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate emails found in Excel: ${duplicates.join(', ')}`);
      }

      return normalizedData;
    } catch (error) {
      throw new Error(`Error validating Excel data: ${error.message}`);
    }
  }

  normalizeRole(role) {
    const roles = ['student', 'primary_admin', 'superadmin'];
    const normalizedRole = (role || '').toLowerCase().trim();
    // Support legacy names during transition if needed, or just map them
    if (normalizedRole === 'user') return 'student';
    return roles.includes(normalizedRole) ? normalizedRole : 'student';
  }

  isValidEmail(email) {
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return emailRegex.test(email);
  }

  async processUsers(users, uploadedByUserId) {
    try {
      const results = {
        created: [],
        updated: [],
        skipped: [],
        emailsToNotify: []
      };

      // Get all existing users from the database
      const [existingUsers] = await pool.execute('SELECT id, email, name, role FROM users WHERE is_active = 1');
      const existingEmails = existingUsers.map(user => user.email.toLowerCase());

      // Process each user from the Excel file
      for (const excelUser of users) {
        const existingUser = existingUsers.find(user => user.email === excelUser.email);

        if (existingUser) {
          // Update existing user
          await pool.execute(
            'UPDATE users SET name = ?, role = ?, bus_no = ? WHERE email = ?',
            [excelUser.name, excelUser.role, excelUser.busno, excelUser.email]
          );

          results.updated.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            busno: excelUser.busno
          });

          // Add to notification list for updated users
          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            type: 'updated'
          });
        } else {
          // Create new user with permanent password based on phone and DOB
          const permanentPassword = this.generatePermanentPassword(excelUser.phone, excelUser.dob);
          const hashedPassword = await bcrypt.hash(permanentPassword, 12);

          await pool.execute(
            'INSERT INTO users (name, email, password_hash, role, bus_no, is_active, temp_password) VALUES (?, ?, ?, ?, ?, TRUE, FALSE)',
            [excelUser.name, excelUser.email, hashedPassword, excelUser.role, excelUser.busno]
          );

          results.created.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            busno: excelUser.busno
          });

          // Add to notification list for new users
          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            permanentPassword: permanentPassword,
            type: 'new'
          });
        }
      }

      // Deactivate users who are not in the Excel file but exist in the database
      const excelEmails = users.map(user => user.email);
      const usersToDeactivate = existingEmails.filter(email => !excelEmails.includes(email));

      for (const email of usersToDeactivate) {
        await pool.execute(
          'UPDATE users SET is_active = FALSE WHERE email = ?',
          [email]
        );
        results.skipped.push(email);
      }

      return results;
    } catch (error) {
      throw new Error(`Error processing users: ${error.message}`);
    }
  }

  generatePermanentPassword(phone, dob) {
    // First 4 digits of phone number + year from date of birth
    const phoneDigits = phone.replace(/\D/g, '').substring(0, 4);
    const birthYear = dob.toString();
    return phoneDigits + birthYear;
  }

  generateTempPassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789!@#$%^&*';
    let password = '';
    for (let i = 0; i < 8; i++) {
      password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
  }

  async sendNotifications(emailsToNotify) {
    const notifications = [];

    for (const userData of emailsToNotify) {
      try {
        if (userData.type === 'new') {
          await sendEmail(
            userData.email,
            'Your BTS Account Has Been Created',
            `Hello ${userData.name},

Your BTS (Bus Tracking System) account has been created.

Your permanent password is: ${userData.permanentPassword}

Please log in with this password.

Best regards,
BTS Administration`
          );
        } else if (userData.type === 'updated') {
          await sendEmail(
            userData.email,
            'Your BTS Account Has Been Updated',
            `Hello ${userData.name},

Your BTS (Bus Tracking System) account has been updated.

Best regards,
BTS Administration`
          );
        }
        notifications.push({ email: userData.email, status: 'sent' });
      } catch (error) {
        console.error(`Error sending email to ${userData.email}:`, error.message);
        notifications.push({ email: userData.email, status: 'failed', error: error.message });
      }
    }

    return notifications;
  }
}

module.exports = new ExcelUserService();