const { BrevoClient } = require('@getbrevo/brevo');

// Configure Brevo API
const apiKey = process.env.BREVO_API_KEY || 'your_brevo_api_key_here';

const brevo = new BrevoClient({ apiKey });

const sendEmail = async (to, subject, htmlContent, textContent = null, options = {}) => {
  try {
    // Dev email redirect: if set, redirect all emails to the first listed address
    const allowlist = process.env.DEV_EMAIL_ALLOWLIST;
    if (allowlist) {
      const allowed = allowlist.split(',').map(e => e.trim()).filter(Boolean);
      const redirectTo = allowed[0];
      if (to.toLowerCase() !== redirectTo.toLowerCase()) {
        console.log(`[DEV] Redirecting email from ${to} to ${redirectTo} (subject: ${subject})`);
        to = redirectTo;
      }
    }

    // Anti-spam best practices: Proper sender configuration
    const fromEmail = process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au';
    const fromName = process.env.EMAIL_FROM_NAME || process.env.CHURCH_NAME || 'Let My People Grow';

    const emailData = {
      to: [{ email: to }],
      subject,
      htmlContent,
      sender: {
        email: fromEmail,
        name: fromName
      },
      headers: {
        'List-Unsubscribe': `<mailto:${fromEmail}?subject=unsubscribe>`,
        'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
        'Precedence': 'bulk',
        'X-Auto-Response-Suppress': 'OOF, AutoReply',
        'X-Mailer': 'Let My People Grow'
      }
    };

    if (textContent) {
      emailData.textContent = textContent;
    }

    if (options.replyTo) {
      emailData.replyTo = { email: options.replyTo };
    }

    if (options.messageId) {
      emailData.messageId = options.messageId;
    }

    const response = await brevo.transactionalEmails.sendTransacEmail(emailData);
    console.log('Email sent successfully:', response);
    return { success: true, messageId: response.messageId };
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
};

const sendInvitationEmail = async (email, firstName, lastName, role, loginLink, invitedBy) => {
  console.log('📧 [EMAIL_DEBUG] Starting invitation email send', {
    email,
    firstName,
    lastName,
    role,
    loginLink,
    invitedBy: {
      firstName: invitedBy.first_name || invitedBy.firstName,
      lastName: invitedBy.last_name || invitedBy.lastName
    }
  });

  const churchName = process.env.CHURCH_NAME || 'our organisation';
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
          
          <p>${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join Let My People Grow as a <strong>${role}</strong>.</p>

          <p>This system helps organisations track attendance, manage members, and grow their communities together.</p>
          
          <div style="text-align: center;">
            <a href="${loginLink}" class="button">
              Go to Login
            </a>
          </div>
          
          <div class="security-note">
            <p><strong>How to sign in:</strong> Use your email or mobile number on the Login page. We’ll send you a one-time code to complete sign in.</p>
          </div>
          
          <p>If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.</p>
          
          <p>Blessings,<br>
          <strong>${churchName}</strong></p>
        </div>
        
        <div class="footer">
          <p>This email was sent from Let My People Grow.</p>
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

${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName} has invited you to join Let My People Grow as a ${role}.

This system helps us track attendance, manage members, and grow our community together.

Go to the Login page to sign in: ${loginLink}

How to sign in: Use your email or mobile number and we’ll send you a one-time code.

If you have any questions, please contact ${invitedBy.first_name || invitedBy.firstName} ${invitedBy.last_name || invitedBy.lastName}.

Blessings,
${churchName}

---
This email was sent from Let My People Grow.
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
  const churchName = process.env.CHURCH_NAME || 'Let My People Grow';
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
          <p>You requested a login code for Let My People Grow.</p>
          
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
          <p>This email was sent from Let My People Grow.</p>
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

You requested a login code for Let My People Grow.

Your code is: ${otcCode}

Security Note:
- This code will expire in ${process.env.OTC_EXPIRE_MINUTES || 10} minutes
- Never share this code with anyone
- If you didn't request this code, please ignore this email

Blessings,
${churchName}

---
This email was sent from Let My People Grow.
To unsubscribe, reply to this email with "unsubscribe" in the subject line.
  `;

  return sendEmail(email, subject, htmlContent, textContent, {
    replyTo: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au',
    messageId: `otc-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@${process.env.EMAIL_DOMAIN || 'letmypeoplegrow.com.au'}`
  });
};

const sendNewChurchApprovalEmail = async (churchName, churchId, adminName, adminEmail) => {
  const adminPanelUrl = process.env.ADMIN_PANEL_URL || 'http://localhost:7777';
  const subject = `New organisation pending approval: ${churchName}`;

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
        .header { background-color: #fef3c7; padding: 20px; text-align: center; border-radius: 8px 8px 0 0; }
        .content { background-color: #ffffff; padding: 30px; border: 1px solid #e9ecef; }
        .footer { background-color: #f8f9fa; padding: 20px; text-align: center; border-radius: 0 0 8px 8px; font-size: 12px; color: #6c757d; }
        .detail-row { padding: 8px 0; border-bottom: 1px solid #f0f0f0; }
        .detail-label { font-weight: 600; color: #555; }
        .button { background-color: #16a34a; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block; margin: 20px 0; }
      </style>
    </head>
    <body>
      <div class="container">
        <div class="header">
          <h1 style="margin: 0; color: #92400e;">New Organisation Pending Approval</h1>
        </div>
        <div class="content">
          <p>A new organisation has been registered and is waiting for your approval.</p>
          <div class="detail-row"><span class="detail-label">Organisation Name:</span> ${churchName}</div>
          <div class="detail-row"><span class="detail-label">Organisation ID:</span> <code>${churchId}</code></div>
          <div class="detail-row"><span class="detail-label">Admin:</span> ${adminName}</div>
          <div class="detail-row"><span class="detail-label">Admin Email:</span> ${adminEmail}</div>
          <div style="text-align: center;">
            <a href="${adminPanelUrl}" class="button">Open Admin Panel</a>
          </div>
          <p>Log in to the admin panel to approve or reject this organisation.</p>
        </div>
        <div class="footer">
          <p>Let My People Grow - Admin Notification</p>
        </div>
      </div>
    </body>
    </html>
  `;

  const textContent = `New Organisation Pending Approval

A new organisation has been registered and is waiting for your approval.

Organisation Name: ${churchName}
Organisation ID: ${churchId}
Admin: ${adminName}
Admin Email: ${adminEmail}

Log in to the admin panel to approve or reject this organisation: ${adminPanelUrl}
  `;

  return sendEmail('hello@letmypeoplegrow.app', subject, htmlContent, textContent, {
    messageId: `church-approval-${churchId}-${Date.now()}@${process.env.EMAIL_DOMAIN || 'letmypeoplegrow.com.au'}`
  });
};

const sendWeeklyReviewEmail = async (email, firstName, reviewData, insight) => {
  const churchName = reviewData.churchName;
  const subject = `${churchName} — Weekly Gathering Review`;

  // Build gathering cards HTML
  const gatheringCardsHtml = reviewData.gatherings.map(g => {
    let trendHtml = '';
    if (g.deltaPercent !== null) {
      const arrow = g.deltaPercent > 0 ? '&#9650;' : g.deltaPercent < 0 ? '&#9660;' : '&#9654;';
      const color = g.deltaPercent > 0 ? '#16a34a' : g.deltaPercent < 0 ? '#dc2626' : '#6b7280';
      trendHtml = `<span style="color: ${color}; font-weight: 600;">${arrow} ${Math.abs(g.deltaPercent)}%</span> <span style="color: #6b7280; font-size: 12px;">vs 3-week avg (${g.avgPrevious})</span>`;
    }
    const visitorHtml = g.visitorCount > 0 ? `<div style="font-size: 13px; color: #9ca3af; margin-top: 4px;">${g.visitorCount} visitor${g.visitorCount !== 1 ? 's' : ''}</div>` : '';

    return `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 12px;">
        <tr>
          <td style="background-color: #f5f3ff; border-radius: 8px; padding: 16px; border-left: 4px solid #9B51E0;">
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              <tr>
                <td>
                  <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #1f2937; font-size: 15px;">${g.name}</div>
                  <div style="font-size: 13px; color: #9ca3af; margin-top: 2px;">${g.date}</div>
                </td>
                <td style="text-align: right; vertical-align: top;">
                  <div style="font-size: 28px; font-weight: 700; color: #7c3aed;">${g.count}</div>
                </td>
              </tr>
            </table>
            ${trendHtml ? `<div style="margin-top: 8px;">${trendHtml}</div>` : ''}
            ${visitorHtml}
          </td>
        </tr>
      </table>`;
  }).join('');

  // Insight box
  const insightHtml = insight ? `
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
      <tr>
        <td style="background: linear-gradient(135deg, #f5f3ff 0%, #fdf2f8 100%); border: 1px solid #ddd6fe; padding: 20px; border-radius: 8px;">
          <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 10px; font-size: 14px;">&#10024; Weekly Insight</div>
          <div style="color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6;">${insight}</div>
        </td>
      </tr>
    </table>` : '';

  // Follow-up section
  const appUrl = process.env.CLIENT_URL || 'https://app.letmypeoplegrow.com.au';
  let followUpHtml = '';
  if (!reviewData.gettingStarted && reviewData.followUpPeople && reviewData.followUpPeople.length > 0) {
    const peopleRows = reviewData.followUpPeople.map(p => {
      const gatheringText = p.gatherings.length > 0 ? p.gatherings.join(', ') : 'gatherings';
      return `<tr><td style="padding: 6px 0; color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; border-bottom: 1px solid #f3f4f6;">${p.firstName} ${p.lastName} <span style="color: #9ca3af;">&mdash; used to attend ${gatheringText}</span></td></tr>`;
    }).join('');
    const moreText = reviewData.followUpTotal > reviewData.followUpPeople.length
      ? `<tr><td style="padding: 6px 0; color: #9ca3af; font-size: 13px; font-style: italic;">and ${reviewData.followUpTotal - reviewData.followUpPeople.length} more</td></tr>`
      : '';
    followUpHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 12px; font-size: 15px;">&#128276; People to Follow Up With</div>
            <table width="100%" cellpadding="0" cellspacing="0" border="0">
              ${peopleRows}
              ${moreText}
            </table>
            <div style="margin-top: 12px;"><a href="${appUrl}/app/reports" style="color: #7c3aed; font-weight: 600; font-size: 13px; text-decoration: underline;">View all in Reports &rarr;</a></div>
          </td>
        </tr>
      </table>`;
  }

  // Visitor breakdown section
  let visitorBreakdownHtml = '';
  if (reviewData.weeklyVisitors && (reviewData.weeklyVisitors.firstTime.length > 0 || reviewData.weeklyVisitors.returning.length > 0)) {
    const buildVisitorRows = (visitors) => visitors.map(v => {
      const gatheringText = v.gatherings.length > 0 ? v.gatherings.join(', ') : '';
      return `<tr><td style="padding: 4px 0 4px 12px; color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px;">${v.firstName} ${v.lastName}${gatheringText ? ` <span style="color: #9ca3af;">&mdash; ${gatheringText}</span>` : ''}</td></tr>`;
    }).join('');

    let subSections = '';
    if (reviewData.weeklyVisitors.firstTime.length > 0) {
      subSections += `
        <div style="font-weight: 600; color: #374151; font-size: 13px; margin-top: 8px; margin-bottom: 4px;">First-time</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${buildVisitorRows(reviewData.weeklyVisitors.firstTime)}</table>`;
    }
    if (reviewData.weeklyVisitors.returning.length > 0) {
      subSections += `
        <div style="font-weight: 600; color: #374151; font-size: 13px; margin-top: 12px; margin-bottom: 4px;">Returning</div>
        <table width="100%" cellpadding="0" cellspacing="0" border="0">${buildVisitorRows(reviewData.weeklyVisitors.returning)}</table>`;
    }

    visitorBreakdownHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 16px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 8px; font-size: 15px;">&#128075; This Week's Visitors</div>
            ${subSections}
            <div style="margin-top: 14px; font-style: italic; color: #9ca3af; font-size: 13px; line-height: 1.5;">Research shows that visitors are more likely to return when someone other than the pastor reaches out before Wednesday.</div>
          </td>
        </tr>
      </table>`;
  }

  // Getting started section (new churches only)
  let gettingStartedHtml = '';
  if (reviewData.gettingStarted) {
    const gs = reviewData.gettingStarted;
    const gatheringWord = gs.gatheringCount === 1 ? 'gathering' : 'gatherings';
    const personWord = gs.peopleCount === 1 ? 'person' : 'people';
    const weekWord = gs.weeksTracked === 1 ? 'week' : 'weeks';
    gettingStartedHtml = `
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 24px;">
        <tr>
          <td style="background-color: #ffffff; border-radius: 8px; padding: 20px; border: 1px solid #e5e7eb; border-left: 4px solid #9B51E0;">
            <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #7c3aed; margin-bottom: 12px; font-size: 15px;">&#127793; Your Organisation is Growing</div>
            <div style="color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6;">
              You've set up ${gs.gatheringCount} ${gatheringWord} and added ${gs.peopleCount} ${personWord} &mdash; great start! You've been tracking attendance for ${gs.weeksTracked} ${weekWord} so far.
            </div>
            <div style="color: #6b7280; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; font-size: 14px; line-height: 1.6; margin-top: 10px;">
              Keep it up! As you record more weeks of attendance, this email will start including follow-up suggestions, visitor insights, and AI-powered trends to help your organisation grow.
            </div>
          </td>
        </tr>
      </table>`;
  }

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <!--[if mso]>
      <style>body { font-family: Arial, sans-serif !important; }</style>
      <![endif]-->
    </head>
    <body style="font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #374151; margin: 0; padding: 0; background-color: #f3f4f6;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 20px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%;">
              <!-- Header -->
              <tr>
                <td style="background-color: #7c3aed; padding: 28px 30px; border-radius: 12px 12px 0 0; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 22px; font-weight: 700;">${churchName}</h1>
                  <p style="margin: 6px 0 0; color: #ddd6fe; font-size: 14px; font-weight: 400;">Weekly Review &middot; ${reviewData.weekStartDate} to ${reviewData.weekEndDate}</p>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td style="background-color: #ffffff; padding: 30px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
                  <p style="margin: 0 0 16px; color: #374151; font-size: 15px;">Hi ${firstName},</p>
                  <p style="margin: 0 0 20px; color: #6b7280; font-size: 14px;">Here's how your gatherings went this week:</p>

                  ${gatheringCardsHtml}

                  <!-- Totals -->
                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 16px;">
                    <tr>
                      <td style="background-color: #f5f3ff; border-radius: 8px; padding: 20px; text-align: center; border: 1px solid #ede9fe;">
                        <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 12px; color: #7c3aed; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Weekly Total</div>
                        <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 36px; font-weight: 700; color: #5b21b6; margin: 4px 0;">${reviewData.totalAttendance}</div>
                        <div style="font-size: 13px; color: #7c3aed;">attendance${reviewData.totalVisitors > 0 ? ` &middot; ${reviewData.totalVisitors} visitor${reviewData.totalVisitors !== 1 ? 's' : ''}` : ''}</div>
                      </td>
                    </tr>
                  </table>

                  ${reviewData.gettingStarted ? gettingStartedHtml : `${followUpHtml}${visitorBreakdownHtml}${insightHtml}`}

                  <p style="margin-top: 28px; color: #6b7280; font-size: 14px;">Blessings,<br><strong style="color: #374151;">${churchName}</strong></p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color: #f9fafb; padding: 20px 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
                  <p style="margin: 0; font-size: 12px; color: #9ca3af;">Sent from <span style="color: #7c3aed;">Let My People Grow</span></p>
                  <p style="margin: 8px 0 0; font-size: 11px; color: #9ca3af;">
                    To stop receiving these emails, ask your admin to update your notification preferences.
                  </p>
                </td>
              </tr>
            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  // Plain text version
  const gatheringCardsText = reviewData.gatherings.map(g => {
    let line = `${g.name} (${g.date}): ${g.count} attendees`;
    if (g.deltaPercent !== null) {
      const dir = g.deltaPercent > 0 ? 'up' : g.deltaPercent < 0 ? 'down' : 'flat';
      line += ` (${dir} ${Math.abs(g.deltaPercent)}% vs 3-week avg of ${g.avgPrevious})`;
    }
    if (g.visitorCount > 0) line += `, ${g.visitorCount} visitors`;
    return line;
  }).join('\n');

  // Follow-up plain text
  let followUpText = '';
  if (!reviewData.gettingStarted && reviewData.followUpPeople && reviewData.followUpPeople.length > 0) {
    const lines = reviewData.followUpPeople.map(p => `- ${p.firstName} ${p.lastName} — used to attend ${p.gatherings.join(', ')}`);
    if (reviewData.followUpTotal > reviewData.followUpPeople.length) {
      lines.push(`  ...and ${reviewData.followUpTotal - reviewData.followUpPeople.length} more`);
    }
    followUpText = `\nPeople to Follow Up With:\n${lines.join('\n')}\nView all: ${appUrl}/app/reports\n`;
  }

  // Visitor breakdown plain text
  let visitorBreakdownText = '';
  if (reviewData.weeklyVisitors && (reviewData.weeklyVisitors.firstTime.length > 0 || reviewData.weeklyVisitors.returning.length > 0)) {
    const lines = ['This Week\'s Visitors:'];
    if (reviewData.weeklyVisitors.firstTime.length > 0) {
      lines.push('First-time:');
      reviewData.weeklyVisitors.firstTime.forEach(v => lines.push(`  - ${v.firstName} ${v.lastName}${v.gatherings.length > 0 ? ` — ${v.gatherings.join(', ')}` : ''}`));
    }
    if (reviewData.weeklyVisitors.returning.length > 0) {
      lines.push('Returning:');
      reviewData.weeklyVisitors.returning.forEach(v => lines.push(`  - ${v.firstName} ${v.lastName}${v.gatherings.length > 0 ? ` — ${v.gatherings.join(', ')}` : ''}`));
    }
    lines.push('Tip: Visitors are more likely to return when someone other than the pastor reaches out before Wednesday.');
    visitorBreakdownText = '\n' + lines.join('\n') + '\n';
  }

  const insightText = insight ? `\nWeekly Insight:\n${insight.replace(/<[^>]*>/g, '')}\n` : '';

  // Getting started plain text
  let gettingStartedText = '';
  if (reviewData.gettingStarted) {
    const gs = reviewData.gettingStarted;
    gettingStartedText = `\nYour Organisation is Growing!\nYou've set up ${gs.gatheringCount} gathering(s) and added ${gs.peopleCount} people — great start! You've been tracking attendance for ${gs.weeksTracked} week(s) so far.\n\nKeep it up! As you record more weeks, this email will include follow-up suggestions, visitor insights, and AI-powered trends.\n`;
  }

  const textContent = `
${churchName} Weekly Review
${reviewData.weekStartDate} to ${reviewData.weekEndDate}

Hi ${firstName},

Here's how your gatherings went this week:

${gatheringCardsText}

Total attendance: ${reviewData.totalAttendance}${reviewData.totalVisitors > 0 ? ` | ${reviewData.totalVisitors} visitors` : ''}
${reviewData.gettingStarted ? gettingStartedText : `${followUpText}${visitorBreakdownText}${insightText}`}
Blessings,
${churchName}

---
This email was sent from Let My People Grow.
To stop receiving these emails, ask your admin to update your notification preferences.
  `;

  return sendEmail(email, subject, htmlContent, textContent, {
    replyTo: process.env.EMAIL_FROM || 'hello@letmypeoplegrow.com.au',
    messageId: `weekly-review-${Date.now()}-${Math.random().toString(36).substr(2, 9)}@${process.env.EMAIL_DOMAIN || 'letmypeoplegrow.com.au'}`
  });
};

const sendCaregiverNotificationEmail = async (contact, individual, family, missedCount, gatheringTypeName, churchName) => {
  churchName = churchName || 'your church';
  const subject = `Attendance follow-up: ${individual.first_name} ${individual.last_name}`;
  const gatheringLabel = gatheringTypeName || 'their gathering';
  const weeksText = missedCount === 1 ? '1 week' : `${missedCount} weeks`;

  const htmlContent = `
    <!DOCTYPE html>
    <html>
    <head><meta charset="utf-8"></head>
    <body style="font-family: Arial, sans-serif; color: #333; max-width: 600px; margin: 0 auto; padding: 20px;">
      <p>Hi ${contact.first_name},</p>
      <p>
        Just a heads-up — <strong>${individual.first_name} ${individual.last_name}</strong>
        ${family ? `from the <strong>${family.family_name}</strong> family ` : ''}hasn't attended <strong>${gatheringLabel}</strong> for the past ${weeksText}.
        You may want to check in with them.
      </p>
      <p style="color: #666; font-size: 14px;">— ${churchName}</p>
      <hr style="border: none; border-top: 1px solid #eee; margin: 20px 0;">
      <p style="color: #999; font-size: 12px;">
        You're receiving this because you've been assigned as a caregiver for this family in ${churchName}'s attendance system.
      </p>
    </body>
    </html>
  `;

  const textContent = `Hi ${contact.first_name},\n\nJust a heads-up — ${individual.first_name} ${individual.last_name}${family ? ` from the ${family.family_name} family` : ''} hasn't attended ${gatheringLabel} for the past ${weeksText}. You may want to check in with them.\n\n— ${churchName}`;

  await sendEmail(
    contact.email,
    subject,
    htmlContent,
    textContent
  );
};

/**
 * Weekly caregiver digest email — sent on the same day as the weekly review.
 *
 * @param {string} email
 * @param {string} firstName
 * @param {string} churchName
 * @param {Array} entries - mixed array of family and individual entries from weeklyCaregiverEmail.js
 *   Family: { type:'family', familyName, minStreak, members:[{ name, streak, gatheringName }] }
 *   Individual: { type:'individual', name, familyName, streak, gatheringName }
 */
const sendWeeklyCaregiverDigestEmail = async (email, firstName, churchName, entries) => {
  const subject = `${churchName} — Pastoral follow-up this week`;
  const appUrl = process.env.CLIENT_URL || 'https://app.letmypeoplegrow.com.au';

  const today = new Date();
  const dateLabel = today.toLocaleDateString('en-AU', { day: 'numeric', month: 'long', year: 'numeric' });

  const cardCardsHtml = entries.map(entry => {
    if (entry.type === 'family') {
      // Family card: heading is the family name, list each member with their streak
      const memberRows = entry.members.map(m => {
        const streakText = m.streak === 1 ? '1 absence' : `${m.streak} absences`;
        const gathering = m.gatheringName ? ` &mdash; ${m.gatheringName}` : '';
        return `<tr>
          <td style="padding: 4px 0; font-size: 13px; color: #374151; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; border-bottom: 1px solid #fed7aa;">
            ${m.name}
          </td>
          <td style="padding: 4px 0 4px 12px; font-size: 13px; color: #ea580c; font-weight: 600; white-space: nowrap; text-align: right; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; border-bottom: 1px solid #fed7aa;">
            ${streakText}${gathering ? `<span style="color:#9ca3af;font-weight:400;">${gathering}</span>` : ''}
          </td>
        </tr>`;
      }).join('');

      return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 10px;">
          <tr>
            <td style="background-color: #fff7ed; border-radius: 8px; padding: 14px 16px; border-left: 4px solid #f97316;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #1f2937; font-size: 15px;">${entry.familyName}</div>
                    <div style="font-size: 12px; color: #9ca3af; margin-top: 2px;">${entry.members.length} members missing</div>
                  </td>
                  <td style="text-align: right; vertical-align: top; white-space: nowrap; padding-left: 12px;">
                    <div style="font-size: 22px; font-weight: 700; color: #ea580c; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;">${entry.minStreak}+</div>
                    <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.4px;">in a row</div>
                  </td>
                </tr>
              </table>
              <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 10px;">
                ${memberRows}
              </table>
            </td>
          </tr>
        </table>`;
    } else {
      // Individual card
      const streakText = entry.streak === 1 ? '1 consecutive absence' : `${entry.streak} consecutive absences`;
      const gatheringText = entry.gatheringName ? ` in <strong>${entry.gatheringName}</strong>` : '';
      return `
        <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-bottom: 10px;">
          <tr>
            <td style="background-color: #fff7ed; border-radius: 8px; padding: 14px 16px; border-left: 4px solid #f97316;">
              <table width="100%" cellpadding="0" cellspacing="0" border="0">
                <tr>
                  <td>
                    <div style="font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-weight: 600; color: #1f2937; font-size: 15px;">${entry.name}</div>
                    ${entry.familyName ? `<div style="font-size: 12px; color: #9ca3af; margin-top: 2px;">${entry.familyName}</div>` : ''}
                  </td>
                  <td style="text-align: right; vertical-align: top; white-space: nowrap; padding-left: 12px;">
                    <div style="font-size: 22px; font-weight: 700; color: #ea580c; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;">${entry.streak}</div>
                    <div style="font-size: 11px; color: #9ca3af; text-transform: uppercase; letter-spacing: 0.4px;">in a row</div>
                  </td>
                </tr>
              </table>
              <div style="margin-top: 8px; font-size: 13px; color: #6b7280; font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif;">
                ${streakText}${gatheringText}
              </div>
            </td>
          </tr>
        </table>`;
    }
  }).join('');

  const introText = entries.length === 1
    ? (entries[0].type === 'family' ? 'is a family' : 'is someone')
    : 'are a few people and families';

  const htmlContent = `
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>${subject}</title>
      <!--[if mso]>
      <style>body { font-family: Arial, sans-serif !important; }</style>
      <![endif]-->
    </head>
    <body style="font-family: 'Lato', 'Helvetica Neue', Arial, sans-serif; line-height: 1.6; color: #374151; margin: 0; padding: 0; background-color: #f3f4f6;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #f3f4f6; padding: 20px 0;">
        <tr>
          <td align="center">
            <table width="600" cellpadding="0" cellspacing="0" border="0" style="max-width: 600px; width: 100%;">

              <!-- Header -->
              <tr>
                <td style="background-color: #7c3aed; padding: 28px 30px; border-radius: 12px 12px 0 0; text-align: center;">
                  <h1 style="margin: 0; color: #ffffff; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif; font-size: 22px; font-weight: 700;">${churchName}</h1>
                  <p style="margin: 6px 0 0; color: #ddd6fe; font-size: 14px; font-weight: 400;">Pastoral Follow-up &middot; ${dateLabel}</p>
                </td>
              </tr>

              <!-- Content -->
              <tr>
                <td style="background-color: #ffffff; padding: 30px; border-left: 1px solid #e5e7eb; border-right: 1px solid #e5e7eb;">
                  <p style="margin: 0 0 8px; color: #374151; font-size: 15px;">Hi ${firstName},</p>
                  <p style="margin: 0 0 20px; color: #6b7280; font-size: 14px;">
                    Here ${introText} you're caring for who may need a check-in this week:
                  </p>

                  ${cardCardsHtml}

                  <p style="margin-top: 20px; font-size: 13px; color: #9ca3af; line-height: 1.5; font-style: italic;">
                    Research shows that a personal follow-up from someone who knows them makes a real difference. Even a quick message can go a long way.
                  </p>

                  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin-top: 20px;">
                    <tr>
                      <td>
                        <a href="${appUrl}/app/reports"
                           style="display: inline-block; background-color: #7c3aed; color: #ffffff; text-decoration: none; padding: 10px 20px; border-radius: 6px; font-size: 14px; font-weight: 600; font-family: 'Montserrat', 'Helvetica Neue', Arial, sans-serif;">
                          View attendance reports &rarr;
                        </a>
                      </td>
                    </tr>
                  </table>

                  <p style="margin-top: 28px; color: #6b7280; font-size: 14px;">Blessings,<br><strong style="color: #374151;">${churchName}</strong></p>
                </td>
              </tr>

              <!-- Footer -->
              <tr>
                <td style="background-color: #f9fafb; padding: 20px 30px; border-radius: 0 0 12px 12px; border: 1px solid #e5e7eb; border-top: none; text-align: center;">
                  <p style="margin: 0; font-size: 12px; color: #9ca3af;">Sent from <span style="color: #7c3aed;">Let My People Grow</span></p>
                  <p style="margin: 8px 0 0; font-size: 11px; color: #9ca3af;">
                    You're receiving this because you've been assigned as a caregiver in ${churchName}'s attendance system.
                  </p>
                </td>
              </tr>

            </table>
          </td>
        </tr>
      </table>
    </body>
    </html>
  `;

  const entriesText = entries.map(entry => {
    if (entry.type === 'family') {
      const memberLines = entry.members.map(m => {
        const streakText = m.streak === 1 ? '1 absence' : `${m.streak} absences`;
        return `    - ${m.name}: ${streakText}`;
      }).join('\n');
      return `- ${entry.familyName} (${entry.members.length} members, ${entry.minStreak}+ in a row):\n${memberLines}`;
    }
    const streakText = entry.streak === 1 ? '1 consecutive absence' : `${entry.streak} consecutive absences`;
    const gathering = entry.gatheringName ? ` in ${entry.gatheringName}` : '';
    return `- ${entry.name}${entry.familyName ? ` (${entry.familyName})` : ''}: ${streakText}${gathering}`;
  }).join('\n');

  const textContent = `Hi ${firstName},\n\nHere ${introText} you're caring for who may need a check-in this week:\n\n${entriesText}\n\nResearch shows that a personal follow-up from someone who knows them makes a real difference.\n\nView attendance reports: ${appUrl}/app/reports\n\nBlessings,\n${churchName}\n\n---\nYou're receiving this because you've been assigned as a caregiver in ${churchName}'s attendance system.`;

  await sendEmail(email, subject, htmlContent, textContent);
};

module.exports = {
  sendEmail,
  sendInvitationEmail,
  sendOTCEmail,
  sendNewChurchApprovalEmail,
  sendWeeklyReviewEmail,
  sendCaregiverNotificationEmail,
  sendWeeklyCaregiverDigestEmail,
};