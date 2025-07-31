#!/bin/bash

# Security Audit Script for Let My People Grow
# This script checks the current production authentication configuration

set -e

echo "🔍 Security Audit for Let My People Grow"
echo "========================================"
echo ""

# Check if we're in the right directory
if [ ! -f "docker-compose.prod.yml" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

# Function to check if a file exists and is readable
check_file() {
    if [ -f "$1" ]; then
        echo "✅ $1 exists"
        return 0
    else
        echo "❌ $1 missing"
        return 1
    fi
}

# Function to check environment variable
check_env_var() {
    local file=$1
    local var=$2
    local description=$3
    
    if [ -f "$file" ]; then
        if grep -q "^${var}=" "$file"; then
            local value=$(grep "^${var}=" "$file" | cut -d'=' -f2-)
            if [ -z "$value" ] || [[ "$value" == *"CHANGE_THIS"* ]] || [[ "$value" == *"your_secure"* ]]; then
                echo "⚠️  $description: NOT SET (using default/placeholder)"
                return 1
            else
                echo "✅ $description: SET"
                return 0
            fi
        else
            echo "❌ $description: MISSING from $file"
            return 1
        fi
    else
        echo "❌ $description: Cannot check (file $file missing)"
        return 1
    fi
}

echo "📁 Configuration Files Check:"
echo "-----------------------------"
check_file "server/.env"
check_file ".env"
check_file "docker-compose.prod.yml"
echo ""

echo "🔐 Security Configuration Check:"
echo "--------------------------------"

# Check server environment variables
echo "Server Configuration (server/.env):"
check_env_var "server/.env" "NODE_ENV" "Environment Mode"
check_env_var "server/.env" "JWT_SECRET" "JWT Secret"
check_env_var "server/.env" "TWILIO_ACCOUNT_SID" "Twilio Account SID"
check_env_var "server/.env" "TWILIO_AUTH_TOKEN" "Twilio Auth Token"
check_env_var "server/.env" "TWILIO_FROM_NUMBER" "Twilio Phone Number"
check_env_var "server/.env" "BREVO_API_KEY" "Brevo API Key"
echo ""

# Check root environment variables
echo "Root Configuration (.env):"
check_env_var ".env" "JWT_SECRET" "JWT Secret"
check_env_var ".env" "DB_ROOT_PASSWORD" "Database Root Password"
check_env_var ".env" "DB_PASSWORD" "Database Password"
echo ""

echo "🔧 Docker Configuration Check:"
echo "------------------------------"

# Check if production containers are running
if command -v docker &> /dev/null; then
    if docker ps --format "table {{.Names}}" | grep -q "church_attendance"; then
        echo "✅ Production containers are running"
        
        # Check container environment
        echo "Container Environment Check:"
        if docker exec church_attendance_server printenv NODE_ENV 2>/dev/null | grep -q "production"; then
            echo "✅ Server running in production mode"
        else
            echo "⚠️  Server NOT running in production mode"
        fi
        
        # Check if external services are configured
        if docker exec church_attendance_server printenv TWILIO_ACCOUNT_SID 2>/dev/null | grep -q -v "^$"; then
            echo "✅ Twilio configured in container"
        else
            echo "⚠️  Twilio NOT configured in container"
        fi
        
        if docker exec church_attendance_server printenv BREVO_API_KEY 2>/dev/null | grep -q -v "^$"; then
            echo "✅ Brevo configured in container"
        else
            echo "⚠️  Brevo NOT configured in container"
        fi
        
    else
        echo "⚠️  Production containers are not running"
    fi
else
    echo "⚠️  Docker not available"
fi

echo ""
echo "🌐 Network Security Check:"
echo "-------------------------"

# Check if HTTPS is configured
if [ -f "nginx.conf" ]; then
    if grep -q "ssl" nginx.conf; then
        echo "✅ HTTPS/SSL configuration found in nginx.conf"
    else
        echo "⚠️  No HTTPS/SSL configuration found in nginx.conf"
    fi
else
    echo "⚠️  nginx.conf not found"
fi

# Check if SSL certificates exist
if [ -d "ssl" ]; then
    echo "✅ SSL certificates directory exists"
    if [ "$(ls -A ssl 2>/dev/null)" ]; then
        echo "✅ SSL certificates found"
    else
        echo "⚠️  SSL certificates directory is empty"
    fi
else
    echo "⚠️  SSL certificates directory not found"
fi

echo ""
echo "📊 Security Summary:"
echo "-------------------"

# Count issues
issues=0
warnings=0

# Check critical security issues
if ! check_env_var "server/.env" "NODE_ENV" "Environment Mode" >/dev/null; then
    ((issues++))
fi

if ! check_env_var "server/.env" "JWT_SECRET" "JWT Secret" >/dev/null; then
    ((issues++))
fi

if ! check_env_var "server/.env" "TWILIO_ACCOUNT_SID" "Twilio Account SID" >/dev/null; then
    ((warnings++))
fi

if ! check_env_var "server/.env" "BREVO_API_KEY" "Brevo API Key" >/dev/null; then
    ((warnings++))
fi

echo ""
if [ $issues -eq 0 ] && [ $warnings -eq 0 ]; then
    echo "🎉 SECURITY STATUS: EXCELLENT"
    echo "   All critical security measures are in place."
elif [ $issues -eq 0 ]; then
    echo "✅ SECURITY STATUS: GOOD"
    echo "   Critical security is configured, but some optional features are missing."
else
    echo "🚨 SECURITY STATUS: CRITICAL ISSUES FOUND"
    echo "   Immediate action required to secure the application."
fi

echo ""
echo "📋 Action Items:"
echo "---------------"

if [ $issues -gt 0 ]; then
    echo "🔴 CRITICAL (Fix immediately):"
    echo "   - Set NODE_ENV=production in server/.env"
    echo "   - Change JWT_SECRET to a secure random string"
    echo "   - Change database passwords"
    echo ""
fi

if [ $warnings -gt 0 ]; then
    echo "🟡 RECOMMENDED (For full functionality):"
    echo "   - Configure Twilio for SMS authentication"
    echo "   - Configure Brevo for email authentication"
    echo "   - Enable HTTPS/SSL"
    echo ""
fi

echo "💡 To fix security issues, run:"
echo "   ./secure-production-config.sh"
echo ""
echo "🔍 To test authentication after fixes:"
echo "   node test-token-refresh.js" 