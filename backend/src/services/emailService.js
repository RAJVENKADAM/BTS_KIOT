const nodemailer = require('nodemailer');

const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: process.env.EMAIL_USER,
    pass: process.env.EMAIL_PASS
  }
});

async function sendEmail(to, subject, text) {
  try {
    const mailOptions = {
      from: process.env.EMAIL_USER,
      to: to,
      subject: subject,
      text: text
    };

    return await transporter.sendMail(mailOptions);
  } catch (error) {
    console.error('Email delivery failed:', {
      name: error?.name || 'Error',
      code: error?.code || null,
    });
    throw error;
  }
}

module.exports = {
  sendEmail
};