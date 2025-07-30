#!/bin/bash

# Fix JWT expiry issue on remote server
# This script updates JWT_EXPIRE to 30d and adds the clear-expired-token endpoint

set -e

echo "🔧 Fixing JWT expiry issue on remote server..."

# SSH into the server and run the fixes
ssh wpclick@192.168.193.11 << 'EOF'

echo "📁 Navigating to project directory..."
cd "/home/wpclick/Let My People Grow" || {
    echo "❌ Could not find project directory"
    exit 1
}

echo "📋 Current directory: $(pwd)"
echo "📋 Checking current JWT_EXPIRE setting..."

# Check docker-compose.yml
if [ -f "docker-compose.yml" ]; then
    if grep -q "JWT_EXPIRE: 24h" docker-compose.yml; then
        echo "🔄 Updating JWT_EXPIRE from 24h to 30d..."
        sed -i 's/JWT_EXPIRE: 24h/JWT_EXPIRE: 30d/g' docker-compose.yml
        echo "✅ JWT_EXPIRE updated to 30d"
    elif grep -q "JWT_EXPIRE: 30d" docker-compose.yml; then
        echo "ℹ️  JWT_EXPIRE already set to 30d"
    else
        echo "⚠️  JWT_EXPIRE setting not found in docker-compose.yml"
    fi
else
    echo "⚠️  docker-compose.yml not found"
fi

# Check docker-compose.prod.yml
if [ -f "docker-compose.prod.yml" ]; then
    if grep -q "JWT_EXPIRE: 24h" docker-compose.prod.yml; then
        echo "🔄 Updating JWT_EXPIRE from 24h to 30d in docker-compose.prod.yml..."
        sed -i 's/JWT_EXPIRE: 24h/JWT_EXPIRE: 30d/g' docker-compose.prod.yml
        echo "✅ JWT_EXPIRE updated to 30d in docker-compose.prod.yml"
    elif grep -q "JWT_EXPIRE: 30d" docker-compose.prod.yml; then
        echo "ℹ️  JWT_EXPIRE already set to 30d in docker-compose.prod.yml"
    else
        echo "⚠️  JWT_EXPIRE setting not found in docker-compose.prod.yml"
    fi
fi

echo "📋 Checking if clear-expired-token endpoint exists..."
if [ -f "server/routes/auth.js" ]; then
    if ! grep -q "clear-expired-token" server/routes/auth.js; then
        echo "🔄 Adding clear-expired-token endpoint..."
        
        # Find the line before dev-login and add the new endpoint
        sed -i '/dev-login/i\
// Clear expired token route - helps users with expired tokens\
router.post('\''/clear-expired-token'\'', (req, res) => {\
  try {\
    // Clear the auth cookie\
    res.clearCookie('\''authToken'\'', {\
      httpOnly: true,\
      secure: process.env.NODE_ENV === '\''production'\'',\
      sameSite: '\''strict'\'',\
      path: '\''/'\''\
    });\
    \
    res.json({ \
      message: '\''Expired token cleared. Please log in again.'\'',\
      code: '\''TOKEN_CLEARED'\''\
    });\
  } catch (error) {\
    console.error('\''Clear expired token error:'\'', error);\
    res.status(500).json({ error: '\''Failed to clear token.'\' });\
  }\
});\
' server/routes/auth.js
        
        echo "✅ clear-expired-token endpoint added"
    else
        echo "ℹ️  clear-expired-token endpoint already exists"
    fi
else
    echo "❌ server/routes/auth.js not found"
fi

echo "🔄 Restarting services to pick up changes..."
if command -v docker-compose &> /dev/null; then
    docker-compose down
    docker-compose up -d
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    docker compose down
    docker compose up -d
else
    echo "❌ docker-compose not found"
    exit 1
fi

echo "⏳ Waiting for services to start..."
sleep 10

echo "🔍 Checking service status..."
if command -v docker-compose &> /dev/null; then
    docker-compose ps
elif command -v docker &> /dev/null && docker compose version &> /dev/null; then
    docker compose ps
fi

echo "✅ JWT expiry fix completed!"
echo ""
echo "📱 For users with expired tokens, they can now:"
echo "   1. Clear their browser cookies/cache manually"
echo "   2. Then log in again with their credentials"
echo "   3. New tokens will have 30-day expiry"

EOF

echo "✅ Remote JWT expiry fix completed!"
echo ""
echo "🔧 The fix includes:"
echo "   - Updated JWT_EXPIRE to 30d in docker-compose files"
echo "   - Added clear-expired-token endpoint"
echo "   - Restarted services"
echo ""
echo "📱 Users should now be able to log in again with 30-day token expiry" 