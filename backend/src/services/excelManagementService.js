const { v4: uuidv4 } = require('uuid');
const { pool } = require('../config/db');
const ExcelUserService = require('./excelUserService');

class ExcelManagementService {
  // Get all Excel uploads for a superadmin
  async getAllExcelUploads(userId) {
    try {
      const [uploads] = await pool.execute(`
        SELECT 
          eu.id,
          eu.fileName as file_name,
          eu.createdAt as uploaded_at,
          u.name as uploaded_by_name,
          COUNT(usr.id) as user_count
        FROM excel_uploads eu
        JOIN users u ON eu.uploadedBy = u.id
        LEFT JOIN users usr ON usr.excel_upload_id = eu.id
        WHERE eu.uploadedBy = ? AND eu.isActive = 1
        GROUP BY eu.id, eu.fileName, eu.createdAt, u.name
        ORDER BY eu.createdAt DESC
      `, [userId]);
  
      return uploads;
    } catch (error) {
      throw new Error(`Error fetching Excel uploads: ${error.message}`);
    }
  }

  // Get Excel upload by ID
  async getExcelUploadById(uploadId) {
    try {
      const [uploads] = await pool.execute(`
        SELECT 
          eu.id,
          eu.fileName as file_name,
          eu.createdAt as uploaded_at,
          u.name as uploaded_by_name,
          u.id as uploaded_by_id
        FROM excel_uploads eu
        JOIN users u ON eu.uploadedBy = u.id
        WHERE eu.id = ? AND eu.isActive = 1
      `, [uploadId]);

      return uploads[0] || null;
    } catch (error) {
      throw new Error(`Error fetching Excel upload: ${error.message}`);
    }
  }

  // Process Excel upload with tracking - Allow multiple Excel uploads
  async processExcelWithTracking(buffer, fileName, uploadedByUserId) {
    try {
      // Always create new Excel upload record
      const [result] = await pool.execute(
        'INSERT INTO excel_uploads (batchYear, fileName, filePath, uploadedBy, organisationId, isActive, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, NOW(), NOW())',
        ['2024', fileName, 'uploaded', uploadedByUserId, null, 1]
      );
      const excelUploadId = result.insertId;

      // Process users from Excel
      const users = await ExcelUserService.processExcelBuffer(buffer);
      const results = await this.processUsersWithExcelId(users, uploadedByUserId, excelUploadId);

      // Send notifications
      const emailResults = await ExcelUserService.sendNotifications(results.emailsToNotify);

      return {
        excelUploadId,
        results,
        emailResults
      };
    } catch (error) {
      throw new Error(`Error processing Excel with tracking: ${error.message}`);
    }
  }

  // Process users and associate with Excel upload ID
  async processUsersWithExcelId(users, uploadedByUserId, excelUploadId) {
    try {
      const results = {
        created: [],
        updated: [],
        skipped: [], // Users deactivated
        emailsToNotify: []
      };

      // Process each user from the Excel file
      for (const excelUser of users) {
        // First check if user exists in the database (regardless of active status or excel_upload_id)
        const [existingUserResults] = await pool.execute(
          'SELECT id, email, name, role, excel_upload_id, is_active FROM users WHERE email = ?',
          [excelUser.email]
        );
        
        const existingUser = existingUserResults[0];

        if (existingUser) {
          // Update existing user and set excel_upload_id
          await pool.execute(
            'UPDATE users SET name = ?, role = ?, bus_no = ?, excel_upload_id = ?, is_active = TRUE WHERE email = ?',
            [excelUser.name, excelUser.role, excelUser.busno, excelUploadId, excelUser.email]
          );

          results.updated.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            busno: excelUser.busno
          });

          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            type: 'updated'
          });
        } else {
          // Create new user with permanent password based on phone and DOB
          const permanentPassword = ExcelUserService.generatePermanentPassword(excelUser.phone, excelUser.dob);
          const hashedPassword = await require('bcryptjs').hash(permanentPassword, 12);

          await pool.execute(
            'INSERT INTO users (name, email, password_hash, role, bus_no, is_active, temp_password, excel_upload_id) VALUES (?, ?, ?, ?, ?, TRUE, FALSE, ?)',
            [excelUser.name, excelUser.email, hashedPassword, excelUser.role, excelUser.busno, excelUploadId]
          );

          results.created.push({
            email: excelUser.email,
            name: excelUser.name,
            role: excelUser.role,
            busno: excelUser.busno
          });

          results.emailsToNotify.push({
            email: excelUser.email,
            name: excelUser.name,
            permanentPassword: permanentPassword,
            type: 'new'
          });
        }
      }

      // Deactivate users who were created by this Excel upload but are not in the current Excel file
      const excelEmails = users.map(user => user.email);
      const [usersFromThisUpload] = await pool.execute(
        'SELECT email FROM users WHERE excel_upload_id = ? AND is_active = 1',
        [excelUploadId]
      );
      
      const usersToDeactivate = usersFromThisUpload
        .filter(user => !excelEmails.includes(user.email));

      for (const userRecord of usersToDeactivate) {
        await pool.execute(
          'UPDATE users SET is_active = FALSE WHERE email = ?',
          [userRecord.email]
        );
        results.skipped.push(userRecord.email);
      }

      return results;
    } catch (error) {
      throw new Error(`Error processing users with Excel ID: ${error.message}`);
    }
  }

  // Re-upload/Edit Excel file
  async reuploadExcel(uploadId, buffer, fileName, uploadedByUserId) {
    try {
      // Verify the Excel upload belongs to this user
      const existingUpload = await this.getExcelUploadById(uploadId);
      if (!existingUpload) {
        throw new Error('Excel upload not found');
      }
      
      if (existingUpload.uploaded_by_id !== uploadedByUserId) {
        throw new Error('Unauthorized: You can only edit your own Excel uploads');
      }

      // Process new Excel with same upload ID
      const users = await ExcelUserService.processExcelBuffer(buffer);
      const results = await this.processUsersWithExcelId(users, uploadedByUserId, uploadId);

      // Update file name and timestamp
      await pool.execute(
        'UPDATE excel_uploads SET fileName = ?, updatedAt = NOW() WHERE id = ?',
        [fileName, uploadId]
      );

      // Send notifications
      const emailResults = await ExcelUserService.sendNotifications(results.emailsToNotify);

      return {
        message: 'Excel re-upload successful',
        results,
        emailResults
      };
    } catch (error) {
      throw new Error(`Error re-uploading Excel: ${error.message}`);
    }
  }

  // Delete Excel upload (soft delete)
  async deleteExcelUpload(uploadId, userId) {
    try {
      // Verify the Excel upload belongs to this user
      const existingUpload = await this.getExcelUploadById(uploadId);
      if (!existingUpload) {
        throw new Error('Excel upload not found');
      }
      
      if (existingUpload.uploaded_by_id !== userId) {
        throw new Error('Unauthorized: You can only delete your own Excel uploads');
      }

      // Deactivate all users associated with this Excel upload
      const [userResult] = await pool.execute(
        'UPDATE users SET is_active = FALSE, deleted_by_user = FALSE WHERE excel_upload_id = ?',
        [uploadId]
      );

      // Soft delete the Excel upload record by setting isActive to 0
      await pool.execute(
        'UPDATE excel_uploads SET isActive = 0 WHERE id = ?',
        [uploadId]
      );

      return {
        message: 'Excel upload deleted successfully',
        usersDeleted: userResult.affectedRows
      };
    } catch (error) {
      throw new Error(`Error deleting Excel upload: ${error.message}`);
    }
  }

  // Get users associated with an Excel upload
  async getUsersByExcelUpload(uploadId) {
    try {
      const [users] = await pool.execute(`
        SELECT 
          id, name, email, role, bus_no, is_active, created_at
        FROM users 
        WHERE excel_upload_id = ?
        ORDER BY name ASC
      `, [uploadId]);

      return users;
    } catch (error) {
      throw new Error(`Error fetching users by Excel upload: ${error.message}`);
    }
  }
}

module.exports = new ExcelManagementService();