# Email & SMS Setup Guide for Development

This guide will help you set up Brevo (email) and Crazytel (SMS) services for development.

## 🚀 Quick Setup

1. **Get API Keys** (see sections below)
2. **Update `server/.env`** with your API keys
3. **Restart the development server**
4. **Test the services**

## 📧 Brevo Email Setup

### Step 1: Create a Brevo Account
1. Go to [Brevo (formerly Sendinblue)](https://www.brevo.com/)
2. Sign up for a free account
3. Verify your email address

### Step 2: Get Your API Key
1. Log into your Brevo account
2. Go to **Settings** → **API Keys**
3. Click **Create a new API key**
4. Give it a name like "Let My People Grow Development"
5. Copy the API key (starts with `xkeysib-`)

### Step 3: Configure Your Environment
Add to `server/.env`:
```env
BREVO_API_KEY=xkeysib-your_api_key_here
```

### Step 4: Test Email Service
```bash
# Test Brevo connectivity
docker-compose -f docker-compose.dev.yml exec server node test-brevo-curl.js

# Test email sending
docker-compose -f docker-compose.dev.yml exec server node test-email-detailed.js
```

## 📱 Crazytel SMS Setup

### Step 1: Create a Crazytel Account
1. Go to [Crazytel SMS](https://sms.crazytel.net.au/)
2. Sign up for an account
3. Verify your account (may require phone verification)

### Step 2: Get Your API Key
1. Log into your Crazytel account
2. Go to **API Settings** or **Developer**
3. Generate a new API key
4. Copy the API key

### Step 3: Get a Sender Number
1. In your Crazytel account, go to **Sender IDs** or **Numbers**
2. Request a sender number (usually your mobile number)
3. Wait for approval (usually instant for personal numbers)
4. Copy the approved sender number

### Step 4: Configure Your Environment
Add to `server/.env`:
```env
CRAZYTEL_API_KEY=your_crazytel_api_key_here
CRAZYTEL_FROM_NUMBER=your_approved_sender_number
```

### Step 5: Test SMS Service
```bash
# Test SMS sending
docker-compose -f docker-compose.dev.yml exec server node test-sms-direct.js
```

## 🔧 Alternative: Twilio SMS Setup

If you prefer Twilio over Crazytel:

### Step 1: Create a Twilio Account
1. Go to [Twilio](https://www.twilio.com/)
2. Sign up for a free account
3. Verify your phone number

### Step 2: Get Your Credentials
1. Go to **Console** → **Account Info**
2. Copy your **Account SID** (starts with `AC`)
3. Copy your **Auth Token**
4. Go to **Phone Numbers** → **Manage** → **Active numbers**
5. Copy your Twilio phone number

### Step 3: Configure Your Environment
Add to `server/.env`:
```env
TWILIO_ACCOUNT_SID=ACyour_account_sid_here
TWILIO_AUTH_TOKEN=your_auth_token_here
TWILIO_FROM_NUMBER=+1234567890
```

## 🧪 Testing Your Setup

### Test Both Services
```bash
# Restart the development server
docker-compose -f docker-compose.dev.yml restart server

# Check service status
docker-compose -f docker-compose.dev.yml logs server | grep -E "(Brevo|Crazytel|External services)"

# Test invitation sending
# Go to the Users page and try to invite a new user
```

### Expected Output
When services are properly configured, you should see:
```
📧 Brevo Email: ✅ Available
📱 Crazytel SMS: ✅ Available
```

### Troubleshooting

#### Email Issues
- **"Brevo not configured"**: Check your `BREVO_API_KEY` in `server/.env`
- **"Invalid API key"**: Verify your API key starts with `xkeysib-`
- **"Rate limit exceeded"**: Free Brevo accounts have daily limits

#### SMS Issues
- **"Crazytel not configured"**: Check your `CRAZYTEL_API_KEY` and `CRAZYTEL_FROM_NUMBER`
- **"Invalid sender number"**: Ensure your sender number is approved in Crazytel
- **"Phone number format"**: Ensure recipient numbers are in international format

## 💰 Cost Information

### Brevo (Email)
- **Free tier**: 300 emails/day
- **Paid plans**: Start at $25/month for 20,000 emails

### Crazytel (SMS)
- **Pricing**: ~$0.05-0.10 per SMS (varies by country)
- **No free tier**: Requires account funding

### Twilio (SMS Alternative)
- **Free trial**: $15-20 credit
- **Paid**: ~$0.0075 per SMS (US numbers)

## 🔒 Security Notes

- **Never commit API keys** to version control
- **Use environment variables** for all sensitive data
- **Rotate API keys** regularly
- **Monitor usage** to avoid unexpected charges

## 📞 Support

- **Brevo**: [Support Center](https://help.brevo.com/)
- **Crazytel**: [Contact Support](https://sms.crazytel.net.au/contact)
- **Twilio**: [Support](https://support.twilio.com/)
