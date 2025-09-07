#!/bin/bash

# Fix Login Issues Script
# This script addresses the cookie and authentication issues in production

set -e

echo "🔧 Fixing Login Issues in Production..."

# Check if we're in the right directory
if [ ! -f "docker-compose.prod.yml" ]; then
    echo "❌ Error: Please run this script from the project root directory"
    exit 1
fi

echo "📋 Issues identified and fixed:"
echo "1. ✅ Changed NODE_ENV from development to production in stack.env"
echo "2. ✅ Added COOKIE_DOMAIN configuration"
echo "3. ✅ Updated nginx.conf to properly forward cookies"
echo "4. ✅ Extended JWT_EXPIRE to 30d for consistency"
echo ""

echo "🔄 Restarting production containers to apply fixes..."

# Stop the current containers
echo "Stopping current containers..."
docker-compose -f docker-compose.prod.yml down

# Pull latest images (optional, but recommended)
echo "Pulling latest images..."
docker-compose -f docker-compose.prod.yml pull

# Start the containers with the new configuration
echo "Starting containers with fixed configuration..."
docker-compose -f docker-compose.prod.yml up -d

echo ""
echo "✅ Login issues should now be resolved!"
echo ""
echo "🔍 What was fixed:"
echo "- Production environment now properly configured (NODE_ENV=production)"
echo "- Cookie domain configuration added for proper cookie handling"
echo "- Nginx now properly forwards cookies for both API and WebSocket connections"
echo "- JWT expiration extended to 30 days for consistency"
echo ""
echo "🧪 Test the fixes:"
echo "1. Try logging in with a user account"
echo "2. Check that WebSocket connections work properly"
echo "3. Verify that API calls no longer return 401 errors"
echo ""
echo "📊 Monitor the logs:"
echo "docker-compose -f docker-compose.prod.yml logs -f server"
echo ""
echo "⚠️  If you're still having issues:"
echo "1. Check that your domain is properly configured in COOKIE_DOMAIN"
echo "2. Ensure your SSL certificates are properly configured if using HTTPS"
echo "3. Verify that your external services (Brevo, Crazytel) are properly configured"

