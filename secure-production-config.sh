#!/bin/bash

# Production Security Configuration Script
# This script secures the production environment for Let My People Grow

set -e

echo "🔒 Securing Production Configuration..."

# Check if we're in the right directory
if [ ! -f "docker-compose.prod.yml" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

# Backup current configuration
echo "📦 Creating backup of current configuration..."
cp server/.env server/.env.backup.$(date +%Y%m%d_%H%M%S)
cp .env .env.backup.$(date +%Y%m%d_%H%M%S)

# Update server/.env for production
echo "🔧 Updating server/.env for production security..."

# Create a secure server environment file
cat > server/.env << 'EOF'
# Twilio SMS Configuration - REQUIRED FOR SMS AUTHENTICATION
# Set these to actual values for SMS functionality
TWILIO_ACCOUNT_SID=
TWILIO_AUTH_TOKEN=
TWILIO_FROM_NUMBER=

# Brevo API key - REQUIRED FOR EMAIL AUTHENTICATION
# Set this to actual value for email functionality
BREVO_API_KEY=

# PRODUCTION CONFIGURATION
NODE_ENV=production
PORT=3001
CLIENT_URL=http://localhost:3000

# Database Configuration (MariaDB)
DB_HOST=db
DB_PORT=3306
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=church_password

# JWT Configuration - CHANGE THESE IN PRODUCTION
JWT_SECRET=CHANGE_THIS_TO_A_VERY_SECURE_RANDOM_STRING_AT_LEAST_32_CHARACTERS
JWT_EXPIRE=30d

# OTC Configuration
OTC_EXPIRE_MINUTES=10
OTC_RESEND_COOLDOWN_SECONDS=60

# Email Configuration
EMAIL_FROM=hello@letmypeoplegrow.com.au
EMAIL_FROM_NAME="Let My People Grow"
EMAIL_DOMAIN=letmypeoplegrow.com.au
CHURCH_NAME="Let My People Grow"
EOF

# Update root .env for production
echo "🔧 Updating root .env for production security..."

cat > .env << 'EOF'
# Docker Image Configuration
IMAGE_TAG=v0.9.1

# Database Configuration - CHANGE THESE IN PRODUCTION
DB_ROOT_PASSWORD=CHANGE_THIS_TO_A_SECURE_PASSWORD
DB_NAME=church_attendance
DB_USER=church_user
DB_PASSWORD=CHANGE_THIS_TO_A_SECURE_PASSWORD

# Server Configuration
SERVER_PORT=3001
CLIENT_URL=http://localhost:3000

# JWT Configuration - CHANGE THESE IN PRODUCTION
JWT_SECRET=CHANGE_THIS_TO_A_VERY_SECURE_RANDOM_STRING_AT_LEAST_32_CHARACTERS
JWT_EXPIRE=30d

# OTC Configuration
OTC_EXPIRE_MINUTES=10
OTC_RESEND_COOLDOWN_SECONDS=60

# Email Configuration
EMAIL_FROM=hello@letmypeoplegrow.com.au
EMAIL_FROM_NAME="Let My People Grow"
EMAIL_DOMAIN=letmypeoplegrow.com.au
CHURCH_NAME="Let My People Grow"

# Client Configuration
CLIENT_PORT=3000

# Nginx Configuration
NGINX_HTTP_PORT=80
NGINX_HTTPS_PORT=443

# PRODUCTION SECURITY NOTES:
# 1. Set TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_FROM_NUMBER for SMS authentication
# 2. Set BREVO_API_KEY for email authentication
# 3. Change all passwords and secrets to secure values
# 4. Consider using environment variables instead of .env files
# 5. Enable HTTPS in production
EOF

echo "✅ Production configuration files updated!"
echo ""
echo "🔐 CRITICAL SECURITY ACTIONS REQUIRED:"
echo "1. Edit server/.env and set:"
echo "   - NODE_ENV=production"
echo "   - JWT_SECRET=<very_secure_random_string>"
echo "   - TWILIO_ACCOUNT_SID=<your_twilio_sid>"
echo "   - TWILIO_AUTH_TOKEN=<your_twilio_token>"
echo "   - TWILIO_FROM_NUMBER=<your_twilio_number>"
echo "   - BREVO_API_KEY=<your_brevo_key>"
echo ""
echo "2. Edit .env and set:"
echo "   - DB_ROOT_PASSWORD=<secure_password>"
echo "   - DB_PASSWORD=<secure_password>"
echo "   - JWT_SECRET=<very_secure_random_string>"
echo ""
echo "3. Generate a secure JWT secret:"
echo "   openssl rand -base64 32"
echo ""
echo "4. Restart your production containers:"
echo "   docker-compose -f docker-compose.prod.yml down"
echo "   docker-compose -f docker-compose.prod.yml up -d"
echo ""
echo "⚠️  WARNING: Without external services (Twilio/Brevo), authentication will be limited!"
echo "   Users will not be able to receive verification codes." 