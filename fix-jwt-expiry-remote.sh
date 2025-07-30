#!/bin/bash

# Fix JWT expiry issue on remote server
# This script updates JWT_EXPIRE to 30d and adds the clear-expired-token endpoint

set -e

echo "🔧 Fixing JWT expiry issue on remote server..."

# SSH into the server and run the fixes
ssh wpclick@192.168.193.11 << 'EOF'

echo "📋 Checking current JWT_EXPIRE setting..."
if grep -q "JWT_EXPIRE: 24h" docker-compose.yml; then
    echo "🔄 Updating JWT_EXPIRE from 24h to 30d..."
    sed -i 's/JWT_EXPIRE: 24h/JWT_EXPIRE: 30d/g' docker-compose.yml
    echo "✅ JWT_EXPIRE updated to 30d"
elif grep -q "JWT_EXPIRE: 30d" docker-compose.yml; then
    echo "ℹ️  JWT_EXPIRE already set to 30d"
else
    echo "⚠️  JWT_EXPIRE setting not found, adding it..."
    # Add JWT_EXPIRE to the environment section
    sed -i '/environment:/a\      JWT_EXPIRE: 30d' docker-compose.yml
    echo "✅ JWT_EXPIRE added as 30d"
fi

echo "📋 Checking if clear-expired-token endpoint exists..."
if ! grep -q "clear-expired-token" server/routes/auth.js; then
    echo "🔄 Adding clear-expired-token endpoint..."
    
    # Add the new endpoint before the dev-login route
    cat >> server/routes/auth.js << 'ENDPOINT_ADDITION'

// Clear expired token route - helps users with expired tokens
router.post('/clear-expired-token', (req, res) => {
  try {
    // Clear the auth cookie
    res.clearCookie('authToken', {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'strict',
      path: '/'
    });
    
    res.json({ 
      message: 'Expired token cleared. Please log in again.',
      code: 'TOKEN_CLEARED'
    });
  } catch (error) {
    console.error('Clear expired token error:', error);
    res.status(500).json({ error: 'Failed to clear token.' });
  }
});

ENDPOINT_ADDITION
    
    echo "✅ clear-expired-token endpoint added"
else
    echo "ℹ️  clear-expired-token endpoint already exists"
fi

echo "🔄 Restarting services to pick up changes..."
docker-compose down
docker-compose up -d

echo "⏳ Waiting for services to start..."
sleep 10

echo "🔍 Checking service status..."
docker-compose ps

echo "✅ JWT expiry fix completed!"
echo ""
echo "📱 For users with expired tokens, they can now:"
echo "   1. Visit /clear-token to clear their expired token"
echo "   2. Or clear their browser cookies/cache manually"
echo "   3. Then log in again with their credentials"

EOF

echo "✅ Remote JWT expiry fix completed!"
echo ""
echo "📱 Users can now access the token clear page at:"
echo "   http://192.168.193.11/clear-token"
echo ""
echo "🔧 The fix includes:"
echo "   - Updated JWT_EXPIRE to 30d"
echo "   - Added clear-expired-token endpoint"
echo "   - Restarted services" 