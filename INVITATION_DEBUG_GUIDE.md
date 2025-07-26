# Invitation System Debug Guide

This guide provides comprehensive debugging tools and information for troubleshooting the user invitation system in Let My People Grow.

## 🐛 Debug Features Added

### 1. Frontend Debug Panel
- **Toggle Debug Mode**: Click the bug icon in the top navigation bar
- **Real-time Logs**: View detailed logs in the debug panel at the bottom of the screen
- **Category Filtering**: Filter logs by category (Invitation, UsersPage, etc.)
- **Expandable Interface**: Collapse/expand the debug panel as needed

### 2. Backend Enhanced Logging
- **Comprehensive Logging**: Detailed logs for every step of the invitation process
- **Error Tracking**: Full error stack traces and context
- **Email/SMS Debugging**: Separate logging for email and SMS services
- **Database Transaction Logging**: Track all database operations

### 3. Settings Page
- **Debug Mode Toggle**: Enable/disable debug mode from settings
- **System Information**: View browser and system details
- **Live Log Display**: See debug logs in real-time
- **User Information**: Display current user details

## 🔧 How to Use Debug Mode

### Enabling Debug Mode
1. Click the bug icon (🐛) in the top navigation bar
2. The icon will turn red when debug mode is active
3. A debug panel will appear at the bottom of the screen

### Using the Debug Panel
1. **View Logs**: All application actions are logged with timestamps
2. **Filter by Category**: Use the dropdown to filter logs by category
3. **Expand Details**: Click "View Data" to see detailed information
4. **Clear Logs**: Use the trash icon to clear all logs

### Debug Categories
- **Invitation**: All invitation-related operations
- **UsersPage**: User management page operations
- **Email**: Email service operations
- **SMS**: SMS service operations
- **API**: API request/response logging

## 🧪 Testing the Invitation System

### Using the Test Script
```bash
# Run the comprehensive test script
node server/test-invitation-debug.js

# Set environment variables for testing
export TEST_EMAIL="test@example.com"
export TEST_PHONE="+61412345678"
export BASE_URL="http://localhost:3001/api"
```

### Manual Testing Steps
1. **Enable Debug Mode** in the frontend
2. **Navigate to Users Page** (/app/users)
3. **Click "Invite User"** button
4. **Fill out the form** with test data
5. **Submit the invitation**
6. **Check Debug Panel** for detailed logs
7. **Check Server Logs** for backend debugging information

## 📊 Debug Information Available

### Frontend Debug Data
- Form validation results
- API request/response details
- Error messages and stack traces
- User actions and state changes

### Backend Debug Data
- Request validation results
- Database query results
- Email/SMS service responses
- Error details and stack traces
- Environment configuration status

### System Information
- Browser details
- Network connectivity
- Screen resolution
- Timezone information
- Cookie and storage status

## 🔍 Common Issues and Solutions

### 1. Email Not Sending
**Debug Steps:**
- Check `BREVO_API_KEY` environment variable
- Verify `EMAIL_FROM` address is configured
- Look for email service errors in debug logs
- Test email service independently

**Common Solutions:**
- Ensure Brevo API key is valid and active
- Check email sending limits
- Verify sender email is authorized

### 2. SMS Not Sending
**Debug Steps:**
- Check Twilio configuration in debug logs
- Verify phone number format
- Look for SMS service errors
- Test SMS service independently

**Common Solutions:**
- Ensure Twilio credentials are correct
- Verify phone number is in international format
- Check Twilio account balance
- Verify sender phone number is approved

### 3. Database Errors
**Debug Steps:**
- Check database connection in debug logs
- Verify table structure
- Look for SQL errors
- Test database connectivity

**Common Solutions:**
- Ensure database is running and accessible
- Verify database credentials
- Check table permissions
- Run database migrations if needed

### 4. Validation Errors
**Debug Steps:**
- Check form validation in debug logs
- Verify required fields are provided
- Look for format validation errors
- Test with different input data

**Common Solutions:**
- Ensure all required fields are filled
- Check email format is valid
- Verify phone number format for your country
- Ensure role selection is valid

## 📝 Debug Log Format

### Log Entry Structure
```json
{
  "id": "unique-log-id",
  "timestamp": "2024-01-01T12:00:00.000Z",
  "level": "info|warn|error|debug",
  "category": "Invitation|UsersPage|Email|SMS",
  "message": "Human readable message",
  "data": {
    // Additional context data
  }
}
```

### Log Levels
- **info**: General information about operations
- **warn**: Warning messages for potential issues
- **error**: Error messages with full context
- **debug**: Detailed debugging information

## 🛠️ Environment Variables to Check

### Email Configuration
```bash
BREVO_API_KEY=your_brevo_api_key
EMAIL_FROM=noreply@yourchurch.org
CHURCH_NAME=Your Church Name
```

### SMS Configuration
```bash
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+1234567890
```

### Database Configuration
```bash
DB_HOST=localhost
DB_PORT=3306
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=church_password
```

## 🚀 Production Considerations

### Disabling Debug Mode
- Debug mode should be disabled in production
- Debug logs may contain sensitive information
- Performance impact of logging should be considered

### Security Notes
- Debug information may expose system details
- Logs should not be shared publicly
- Consider log rotation and cleanup

## 📞 Getting Help

If you're still experiencing issues after using the debug tools:

1. **Collect Debug Information**:
   - Enable debug mode
   - Reproduce the issue
   - Copy all relevant logs
   - Include system information

2. **Check Common Issues**:
   - Review the common issues section above
   - Verify all environment variables
   - Test services independently

3. **Contact Support**:
   - Include debug logs and system information
   - Describe the exact steps to reproduce
   - Mention any error messages seen

## 🔄 Recent Changes

### Added Features
- Comprehensive debug logging system
- Real-time debug panel in frontend
- Enhanced error tracking and reporting
- System information display
- Test script for invitation API

### Improved Debugging
- Detailed backend logging for invitation process
- Email and SMS service debugging
- Database transaction logging
- Form validation debugging
- API request/response logging

This debugging system should help you quickly identify and resolve any issues with the invitation system. 