const xlsx = require('xlsx');
const User = require('../models/User');
const { sendEmail } = require('../services/emailService');

class ExcelUserService {
  async processExcelBuffer(buffer) {
    try {
      const workbook = xlsx.read(buffer, { type: 'buffer' });
      const sheetName = workbook.SheetNames[0];
      const worksheet = workbook.Sheets[sheetName];
      const jsonData = xlsx.utils.sheet_to_json(worksheet);

      return this.validateAndNormalizeData(jsonData);
    } catch (error) {
      throw new Error(`Error processing Excel: ${error.message}`);
    }
  }

  validateAndNormalizeData(jsonData) {
    try {
      const requiredColumns = ['name', 'email', 'busno', 'role', 'mobile_no', 'date_of_year'];
      const headers = Object.keys(jsonData[0] || {});

      for (const col of requiredColumns) {
        if (!headers.includes(col)) {
          throw new Error(`Missing required column: ${col}`);
        }
      }

      const normalizedData = jsonData.map(row => ({
        name: row.name?.toString().trim(),
        email: row.email?.toString().toLowerCase().trim(),
        bus_no: row.busno?.toString().trim() || null,
        role: this.normalizeRole(row.role?.toString().trim()),
        phone: row.mobile_no?.toString().trim(),
        dob: row.date_of_year?.toString().trim()
      }));

      for (const user of normalizedData) {
        if (!this.isValidEmail(user.email)) {
          throw new Error(`Invalid email: ${user.email}`);
        }
        if (!user.name || user.name.length < 2) {
          throw new Error(`Invalid name: ${user.name}`);
        }
        if (!user.role) {
          throw new Error(`Invalid role: ${user.role}`);
        }
      }

      const emailCounts = {};
      for (const user of normalizedData) {
        emailCounts[user.email] = (emailCounts[user.email] || 0) + 1;
      }
      const duplicates = Object.keys(emailCounts).filter(email => emailCounts[email] > 1);
      if (duplicates.length > 0) {
        throw new Error(`Duplicate emails in Excel: ${duplicates.join(', ')}`);
      }

      return normalizedData;
    } catch (error) {
      throw new Error(`Error validating Excel: ${error.message}`);
    }
  }

  normalizeRole(role) {
    const roles = ['student', 'primary_admin', 'superadmin'];
    const normalizedRole = (role || '').toLowerCase().trim();
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

      // Get all existing active users
      const existingUsers = await User.find({ is_active: true });
      const existingEmails = existingUsers.map(user => user.email.toLowerCase());

      // Process each user
      for (const excelUser of users) {
        const existingUser = existingUsers.find(user => user.email === excelUser.email);

        if (existingUser) {
          // Update existing user
          await User.updateOne(
            { email: excelUser.email },
            { 
              name: excelUser.name,
              role: excelUser.role,
              bus_no: excelUser.bus_no 
            }
          );

          results.updated.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            bus_no: excelUser.bus_no
          });

          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            type: 'updated'
          });
        } else {
          // Create new user
          const permanentPassword = this.generatePermanentPassword(excelUser.phone, excelUser.dob);
          
          await User.create({
            name: excelUser.name,
            email: excelUser.email,
            password_hash: permanentPassword,  // Will be hashed by pre-save middleware
            role: excelUser.role,
            bus_no: excelUser.bus_no,
            is_active: true
          });

          results.created.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            bus_no: excelUser.bus_no
          });

          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            permanentPassword: permanentPassword,
            type: 'new'
          });
        }
      }

      // Deactivate users not in Excel
      const excelEmails = users.map(user => user.email);
      const usersToDeactivate = existingEmails.filter(email => !excelEmails.includes(email));

      for (const email of usersToDeactivate) {
        await User.updateOne(
          { email },
          { is_active: false }
        );
        results.skipped.push(email);
      }

      return results;
    } catch (error) {
      throw new Error(`Error processing users: ${error.message}`);
    }
  }

  generatePermanentPassword(phone, dob) {
    const phoneDigits = phone.replace(/\D/g, '').substring(0, 4);
    const birthYear = dob.toString();
    return phoneDigits + birthYear;
  }

  async sendNotifications(emailsToNotify) {
    const notifications = [];

    for (const userData of emailsToNotify) {
      try {
        if (userData.type === 'new') {
          await sendEmail(
            userData.email,
            'Your BTS Account Created',
            `Hello ${userData.name},

Your BTS account has been created.
Password: ${userData.permanentPassword}

Best regards,
BTS Team`
          );
        } else if (userData.type === 'updated') {
          await sendEmail(
            userData.email,
            'Your BTS Account Updated',
            `Hello ${userData.name},

Your BTS account has been updated.

Best regards,
BTS Team`
          );
        }
        notifications.push({ email: userData.email, status: 'sent' });
      } catch (error) {
        console.error(`Error sending email to ${userData.email}:`, error.message);
        notifications.push({ email: userData.email, status: 'failed' });
      }
    }

    return notifications;
  }
}

module.exports = new ExcelUserService();
