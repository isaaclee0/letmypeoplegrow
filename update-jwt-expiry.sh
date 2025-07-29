#!/bin/bash

# Script to update JWT expiration time in production
# This fixes the login issue where tokens were expiring after 24 hours

echo "🔧 Updating JWT expiration time to 30 days..."

# Check if we're in a Docker environment
if [ -f "docker-compose.prod.yml" ]; then
    echo "📦 Detected Docker Compose production setup"
    
    # Update the docker-compose.prod.yml file
    if grep -q "JWT_EXPIRE: \${JWT_EXPIRE:-24h}" docker-compose.prod.yml; then
        sed -i '' 's/JWT_EXPIRE: ${JWT_EXPIRE:-24h}/JWT_EXPIRE: ${JWT_EXPIRE:-30d}/g' docker-compose.prod.yml
        echo "✅ Updated docker-compose.prod.yml"
    else
        echo "ℹ️  JWT_EXPIRE already updated in docker-compose.prod.yml"
    fi
    
    # Update the main docker-compose.yml file
    if grep -q "JWT_EXPIRE: 24h" docker-compose.yml; then
        sed -i '' 's/JWT_EXPIRE: 24h/JWT_EXPIRE: 30d/g' docker-compose.yml
        echo "✅ Updated docker-compose.yml"
    else
        echo "ℹ️  JWT_EXPIRE already updated in docker-compose.yml"
    fi
    
    # Update the development docker-compose file
    if grep -q "JWT_EXPIRE: 24h" docker-compose.dev.yml; then
        sed -i '' 's/JWT_EXPIRE: 24h/JWT_EXPIRE: 30d/g' docker-compose.dev.yml
        echo "✅ Updated docker-compose.dev.yml"
    else
        echo "ℹ️  JWT_EXPIRE already updated in docker-compose.dev.yml"
    fi
    
    echo ""
    echo "🚀 To apply these changes in production:"
    echo "1. Rebuild and redeploy your containers:"
    echo "   ./build-and-push.sh <version>"
    echo ""
    echo "2. Or if using Docker Compose directly:"
    echo "   docker-compose -f docker-compose.prod.yml down"
    echo "   docker-compose -f docker-compose.prod.yml up -d --build"
    echo ""
    echo "3. Or if using Portainer:"
    echo "   - Update your stack with the new docker-compose.prod.yml"
    echo "   - Redeploy the stack"
    
elif [ -f "portainer-stack.yml" ]; then
    echo "🐳 Detected Portainer stack setup"
    echo "ℹ️  Please update your JWT_EXPIRE environment variable in Portainer to '30d'"
    echo "   This can be done in the Portainer web interface under your stack's environment variables."
    
else
    echo "❓ Could not detect deployment method"
    echo "Please manually update your JWT_EXPIRE environment variable to '30d'"
fi

echo ""
echo "📝 Summary of changes:"
echo "- JWT tokens now expire after 30 days instead of 24 hours"
echo "- Added automatic token refresh on the client side"
echo "- Improved error handling for expired tokens"
echo "- Added periodic token refresh every 23 hours"
echo ""
echo "✅ Update complete! Users should now be able to stay logged in for 30 days." 