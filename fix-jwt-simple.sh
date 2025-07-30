#!/bin/bash

# Simple fix for JWT expiry issue - add clear-expired-token endpoint
# This script adds the endpoint to help users clear their expired tokens

set -e

echo "🔧 Adding clear-expired-token endpoint to fix JWT expiry issue..."

# SSH into the server and add the endpoint
ssh wpclick@192.168.193.11 << 'EOF'

echo "📋 Finding the application container..."
CONTAINER_NAME=$(docker ps --format "table {{.Names}}" | grep -E "(app|server|church|attendance)" | head -1)

if [ -z "$CONTAINER_NAME" ]; then
    echo "❌ Could not find application container"
    docker ps
    exit 1
fi

echo "✅ Found container: $CONTAINER_NAME"

echo "📋 Adding clear-expired-token endpoint to auth.js..."
# Create a temporary file with the new endpoint
cat > /tmp/clear_token_endpoint.js << 'ENDPOINT_CODE'

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

ENDPOINT_CODE

# Copy the endpoint to the container
docker cp /tmp/clear_token_endpoint.js $CONTAINER_NAME:/tmp/clear_token_endpoint.js

# Add the endpoint to auth.js in the container
docker exec $CONTAINER_NAME sh -c '
if ! grep -q "clear-expired-token" /app/routes/auth.js; then
    echo "Adding clear-expired-token endpoint..."
    # Find the line before dev-login and add the new endpoint
    sed -i "/dev-login/i\\
$(cat /tmp/clear_token_endpoint.js)\\
" /app/routes/auth.js
    echo "✅ Endpoint added successfully"
else
    echo "ℹ️  Endpoint already exists"
fi
'

echo "🔄 Restarting the container to pick up changes..."
docker restart $CONTAINER_NAME

echo "⏳ Waiting for container to restart..."
sleep 10

echo "🔍 Checking container status..."
docker ps

echo "✅ JWT expiry fix completed!"
echo ""
echo "📱 Users can now clear their expired tokens by:"
echo "   1. Making a POST request to /api/auth/clear-expired-token"
echo "   2. Or clearing their browser cookies/cache manually"
echo "   3. Then logging in again"

EOF

echo "✅ Remote JWT expiry fix completed!"
echo ""
echo "🔧 The fix includes:"
echo "   - Added clear-expired-token endpoint to the running container"
echo "   - Restarted the container to pick up the changes"
echo ""
echo "📱 Users should now be able to clear their expired tokens and log in again" 