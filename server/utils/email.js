const brevo = require('@getbrevo/brevo');

// Configure Brevo API
const apiKey = process.env.BREVO_API_KEY || 'your_brevo_api_key_here';

const transactionalEmailsApi = new brevo.TransactionalEmailsApi();
transactionalEmailsApi.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);

const sendEmail = async (to, subject, htmlContent, textContent = null) => {
  try {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    if (textContent) {
      sendSmtpEmail.textContent = textContent;
    }
    sendSmtpEmail.sender = { email: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au' };

    const response = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('Email sent successfully:', response);
    return { success: true, messageId: response.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
};

const sendInvitationEmail = async (email, firstName, lastName, role, invitationLink, invitedBy) => {
  const subject = `You're invited to join ${process.env.CHURCH_NAME || 'our church'}!`;
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Welcome to ${process.env.CHURCH_NAME || 'our church'}!</h2>
      
      <p>Hi ${firstName},</p>
      
      <p>${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join our church management system as a <strong>${role}</strong>.</p>
      
      <p>This system helps us track attendance, manage members, and grow our community together.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <a href="${invitationLink}" 
           style="background-color: #4CAF50; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">
          Accept Invitation
        </a>
      </div>
      
      <p><strong>Important:</strong> This invitation link will expire in 7 days for security reasons.</p>
      
      <p>If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.</p>
      
      <p>Blessings,<br>
      ${process.env.CHURCH_NAME || 'Your Church Team'}</p>
    </div>
  `;
  
  const textContent = `
Welcome to ${process.env.CHURCH_NAME || 'our church'}!

Hi ${firstName},

${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join our church management system as a ${role}.

This system helps us track attendance, manage members, and grow our community together.

Accept your invitation here: ${invitationLink}

Important: This invitation link will expire in 7 days for security reasons.

If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.

Blessings,
${process.env.CHURCH_NAME || 'Your Church Team'}
  `;
  
  return sendEmail(email, subject, htmlContent, textContent);
};

const sendOTCEmail = async (email, otcCode) => {
  const subject = `Your login code for ${process.env.CHURCH_NAME || 'church management system'}`;
  
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto;">
      <h2 style="color: #333;">Your Login Code</h2>
      
      <p>You requested a login code for the church management system.</p>
      
      <div style="text-align: center; margin: 30px 0;">
        <div style="background-color: #f5f5f5; padding: 20px; border-radius: 8px; display: inline-block;">
          <h1 style="color: #333; margin: 0; font-size: 32px; letter-spacing: 4px;">${otcCode}</h1>
        </div>
      </div>
      
      <p><strong>Security Note:</strong></p>
      <ul>
        <li>This code will expire in 10 minutes</li>
        <li>Never share this code with anyone</li>
        <li>If you didn't request this code, please ignore this email</li>
      </ul>
      
      <p>Blessings,<br>
      ${process.env.CHURCH_NAME || 'Your Church Team'}</p>
    </div>
  `;
  
  const textContent = `
Your Login Code

You requested a login code for the church management system.

Your code is: ${otcCode}

Security Note:
- This code will expire in 10 minutes
- Never share this code with anyone
- If you didn't request this code, please ignore this email

Blessings,
${process.env.CHURCH_NAME || 'Your Church Team'}
  `;
  
  return sendEmail(email, subject, htmlContent, textContent);
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendOTCEmail
}; 