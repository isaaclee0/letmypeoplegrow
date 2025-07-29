const brevo = require('@getbrevo/brevo');

// Configure Brevo API
const apiKey = process.env.BREVO_API_KEY || 'your_brevo_api_key_here';

const transactionalEmailsApi = new brevo.TransactionalEmailsApi();
transactionalEmailsApi.setApiKey(brevo.TransactionalEmailsApiApiKeys.apiKey, apiKey);

const sendEmail = async (to, subject, htmlContent, textContent = null, options = {}) => {
  try {
    const sendSmtpEmail = new brevo.SendSmtpEmail();
    sendSmtpEmail.to = [{ email: to }];
    sendSmtpEmail.subject = subject;
    sendSmtpEmail.htmlContent = htmlContent;
    if (textContent) {
      sendSmtpEmail.textContent = textContent;
    }
    
    // Anti-spam best practices: Proper sender configuration
    const fromEmail = process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au';
    const fromName = process.env.EMAIL_FROM_NAME || process.env.CHURCH_NAME || 'Let My People Grow';
    
    sendSmtpEmail.sender = { 
      email: fromEmail,
      name: fromName
    };

    // Anti-spam best practices: Add proper headers
    sendSmtpEmail.headers = {
      'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
      'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
      'Precedence': 'bulk',
      'X-Auto-Response-Suppress': 'OOF, AutoReply',
      'X-Mailer': 'Let My People Grow Church Management System'
    };

    // Anti-spam best practices: Add reply-to header
    if (options.replyTo) {
      sendSmtpEmail.replyTo = { email: options.replyTo };
    }

    // Anti-spam best practices: Add message ID for tracking
    if (options.messageId) {
      sendSmtpEmail.messageId = options.messageId;
    }

    const response = await transactionalEmailsApi.sendTransacEmail(sendSmtpEmail);
    console.log('Email sent successfully:', response);
    return { success: true, messageId: response.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
};

const sendInvitationEmail = async (email, firstName, lastName, role, invitationLink, invitedBy) => {
  console.log('📧 [EMAIL_DEBUG] Starting invitation email send', {
    email,
    firstName,
    lastName,
    role,
    invitationLink,
    invitedBy: {
      firstName: invitedBy.first_name || invitedBy.firstName,
      lastName: invitedBy.last_name || invitedBy.lastName
    }
  });

  const churchName = process.env.CHURCH_NAME || 'our church';
  const subject = `You're invited to join ${churchName}!`;
  
  // Anti-spam best practices: Create a proper HTML structure with better formatting
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #ffffff; padding: 30px; border: 1px solid #e9ecef; }
        .footer { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #6c757d; }
        .button { background-color: #007bff; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 20px 0; }
        .button:hover { background-color: #0056b3; }
        .security-note { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .unsubscribe { font-size: 11px; color: #6c757d; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; color: #333;">Welcome to ${churchName}!</h1>
        </div>
        
        <div class="content">
          <p>Hi ${firstName},</p>
          
          <p>${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join the Let My People Grow church management system as a <strong>${role}</strong>.</p>
          
          <p>This system helps churches track attendance, manage members, and grow their communities together.</p>
          
          <div style="text-align: center;">
            <a href="${invitationLink}" class="button">
              Accept Invitation
            </a>
          </div>
          
          <div class="security-note">
            <p><strong>Important:</strong> This invitation link will expire in 7 days for security reasons.</p>
          </div>
          
          <p>If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.</p>
          
          <p>Blessings,<br>
          <strong>${churchName}</strong></p>
        </div>
        
        <div class="footer">
          <p>This email was sent from the Let My People Grow church management system.</p>
          <p class="unsubscribe">
            If you no longer wish to receive emails from ${churchName}, please reply to this email with "unsubscribe" in the subject line.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  // Anti-spam best practices: Clean, simple text version
  const textContent = `
Welcome to ${churchName}!

Hi ${firstName},

${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join our church management system as a ${role}.

This system helps us track attendance, manage members, and grow our community together.

Accept your invitation here: ${invitationLink}

Important: This invitation link will expire in 7 days for security reasons.

If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.

Blessings,
${churchName}

---
This email was sent from the Let My People Grow church management system.
To unsubscribe, reply to this email with "unsubscribe" in the subject line.
  `;
  
  console.log('📧 [EMAIL_DEBUG] Email content prepared', {
    subject,
    htmlLength: htmlContent.length,
    textLength: textContent.length
  });
  
  try {
    const result = await sendEmail(email, subject, htmlContent, textContent, {
      replyTo: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au',
      messageId: `invitation-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@${process.env.EMAIL_DOMAIN || 'letmypeoplegrow.com.au'}`
    });
    console.log('✅ [EMAIL_DEBUG] Invitation email sent successfully', result);
    return result;
  } catch (error) {
    console.error('❌ [EMAIL_DEBUG] Failed to send invitation email', error);
    throw error;
  }
};

const sendOTCEmail = async (email, otcCode) => {
  const churchName = process.env.CHURCH_NAME || 'church management system';
  const subject = `Your login code for ${churchName}`;
  
  // Anti-spam best practices: Create a proper HTML structure with better formatting
  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <style>
        body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; margin: 0; padding: 0; }
        .container { max-width: 600px; margin: 0 auto; padding: 20px; }
        .header { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #ffffff; padding: 30px; border: 1px solid #e9ecef; }
        .footer { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #6c757d; }
        .code-display { background-color: #f8f9fa; padding: 20px; border-radius: 8px; text-align: center; margin: 20px 0; border: 2px dashed #dee2e6; }
        .code { font-size: 32px; font-weight: bold; letter-spacing: 4px; color: #333; margin: 0; }
        .security-note { background-color: #fff3cd; border: 1px solid #ffeaa7; padding: 15px; border-radius: 4px; margin: 20px 0; }
        .unsubscribe { font-size: 11px; color: #6c757d; margin-top: 20px; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; color: #333;">Your Login Code</h1>
        </div>
        
        <div class="content">
          <p>You requested a login code for the Let My People Grow church management system.</p>
          
          <div class="code-display">
            <div class="code">${otcCode}</div>
          </div>
          
          <div class="security-note">
            <p><strong>Security Note:</strong></p>
            <ul style="margin: 10px 0; padding-left: 20px;">
              <li>This code will expire in ${process.env.OTC_EXPIRE_MINUTES || 10} minutes</li>
              <li>Never share this code with anyone</li>
              <li>If you didn't request this code, please ignore this email</li>
            </ul>
          </div>
          
          <p>Blessings,<br>
          <strong>${churchName}</strong></p>
        </div>
        
        <div class="footer">
          <p>This email was sent from the Let My People Grow church management system.</p>
          <p class="unsubscribe">
            If you no longer wish to receive emails from ${churchName}, please reply to this email with "unsubscribe" in the subject line.
          </p>
        </div>
      </div>
    </body>
    </html>
  `;
  
  // Anti-spam best practices: Clean, simple text version
  const textContent = `
Your Login Code

You requested a login code for the Let My People Grow church management system.

Your code is: ${otcCode}

Security Note:
- This code will expire in ${process.env.OTC_EXPIRE_MINUTES || 10} minutes
- Never share this code with anyone
- If you didn't request this code, please ignore this email

Blessings,
${churchName}

---
This email was sent from the Let My People Grow church management system.
To unsubscribe, reply to this email with "unsubscribe" in the subject line.
  `;
  
  return sendEmail(email, subject, htmlContent, textContent, {
    replyTo: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au',
    messageId: `otc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@${process.env.EMAIL_DOMAIN || 'letmypeoplegrow.com.au'}`
  });
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendOTCEmail
}; 