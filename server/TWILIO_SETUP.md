# Twilio SMS Setup for Australia

## Environment Variables

Add these to your `.env` file:

```bash
# SMS Configuration (Twilio) - Australian Setup
TWILIO_ACCOUNT_SID=your_twilio_account_sid
TWILIO_AUTH_TOKEN=your_twilio_auth_token
TWILIO_FROM_NUMBER=+61488839850
```

## Testing SMS Functionality

### 1. Test SMS Sending
Send a test SMS to verify your Twilio setup:

```bash
POST /api/test/sms
Authorization: Bearer <admin_jwt_token>
Content-Type: application/json

{
  "phoneNumber": "+61427906691"  // Optional, defaults to this test number
}
```

**Response (Success):**
```json
{
  "success": true,
  "message": "Test SMS sent successfully!",
  "messageId": "SMxxxxxxxxx",
  "testNumber": "+61427906691",
  "fromNumber": "+61488839850",
  "parseResult": {
    "isValid": true,
    "internationalNumber": "+61427906691",
    "formattedNational": "0427 906 691",
    "country": "AU"
  },
  "note": "Check the target phone for the test message with code: 123456"
}
```

### 2. Test Phone Number Parsing
Test how various Australian phone number formats are parsed:

```bash
GET /api/test/test-au-formats
Authorization: Bearer <admin_jwt_token>
```

This will test formats like:
- `0400 000 000`
- `04 0000 0000`
- `0400000000`
- `+61 400 000 000`
- etc.

### 3. Test Individual Phone Number
Test parsing of a specific phone number:

```bash
POST /api/test/parse-phone
Authorization: Bearer <admin_jwt_token>
Content-Type: application/json

{
  "phoneNumber": "0427 906 691"
}
```

## Supported Australian Phone Number Formats

The system intelligently parses these Australian mobile formats:

✅ **Standard formats:**
- `0400 000 000` (with spaces)
- `04 0000 0000` (alternative spacing)
- `0400000000` (no spaces)

✅ **Without leading zero:**
- `400 000 000`
- `400000000`

✅ **International format:**
- `+61 400 000 000`
- `+61400000000`

✅ **Your test numbers:**
- `0427906691` → `+61427906691`
- `0427 906 691` → `+61427906691`
- `04 2790 6691` → `+61427906691`

## Twilio Routing Notes

Your Twilio number `+61488839850` is configured for **US Regional routing**. This should still work for sending SMS to Australian numbers, but you may want to check:

1. **Delivery rates** - Australian routing might be more reliable
2. **Cost differences** - Regional routing may affect pricing
3. **Compliance** - Some regions have specific requirements

### To Change Twilio Routing:
1. Go to Twilio Console → Phone Numbers
2. Select your number `+61488839850`
3. Check the routing configuration
4. Consider switching to Australian/Asia-Pacific routing if needed

## Error Handling

Common error scenarios and their meanings:

**"SMS service not configured"**
- Missing Twilio credentials in environment variables

**"Invalid phone number format"**
- Number couldn't be parsed as valid Australian mobile

**"pool timeout: failed to retrieve a connection"**
- Database connection issue (MariaDB not running)

**Twilio API errors**
- Check account balance
- Verify number permissions
- Check regional restrictions

## Default Country Settings

The system now defaults to Australia:
- Country code: `AU`
- Timezone: `Australia/Sydney`
- Phone number parsing context: Australian format rules
- Fallback format: `0400 000 000`

All phone number inputs will automatically format according to Australian conventions. 