#!/bin/bash

# Fix JWT expiry issue on remote server running in Docker
# This script updates the JWT_EXPIRE environment variable and restarts the container

set -e

echo "🔧 Fixing JWT expiry issue on remote Docker server..."

# SSH into the server and run the fixes
ssh wpclick@192.168.193.11 << 'EOF'

echo "📋 Checking current Docker containers..."
docker ps

echo "📋 Finding the application container..."
CONTAINER_NAME=$(docker ps --format "table {{.Names}}" | grep -E "(app|server|church|attendance)" | head -1)

if [ -z "$CONTAINER_NAME" ]; then
    echo "❌ Could not find application container"
    docker ps
    exit 1
fi

echo "✅ Found container: $CONTAINER_NAME"

echo "📋 Checking current JWT_EXPIRE environment variable..."
docker exec $CONTAINER_NAME env | grep JWT_EXPIRE || echo "JWT_EXPIRE not found in environment"

echo "🔄 Stopping the container..."
docker stop $CONTAINER_NAME

echo "📋 Checking if container is using docker-compose..."
if [ -f "docker-compose.yml" ]; then
    echo "🔄 Using docker-compose to restart with updated environment..."
    
    # Update JWT_EXPIRE in docker-compose.yml if it exists
    if grep -q "JWT_EXPIRE:" docker-compose.yml; then
        sed -i 's/JWT_EXPIRE:.*/JWT_EXPIRE: 30d/g' docker-compose.yml
        echo "✅ Updated JWT_EXPIRE to 30d in docker-compose.yml"
    else
        echo "⚠️  JWT_EXPIRE not found in docker-compose.yml"
    fi
    
    # Restart with docker-compose
    docker-compose up -d
else
    echo "🔄 Restarting container with updated environment..."
    
    # Get the current run command and update JWT_EXPIRE
    docker run --rm $CONTAINER_NAME env | grep -v JWT_EXPIRE > /tmp/env_vars
    echo "JWT_EXPIRE=30d" >> /tmp/env_vars
    
    # Restart the container with the updated environment
    docker run -d --env-file /tmp/env_vars --name ${CONTAINER_NAME}_new $CONTAINER_NAME
    docker rm $CONTAINER_NAME
    docker rename ${CONTAINER_NAME}_new $CONTAINER_NAME
fi

echo "⏳ Waiting for container to start..."
sleep 10

echo "🔍 Checking container status..."
docker ps

echo "📋 Verifying JWT_EXPIRE is set correctly..."
docker exec $CONTAINER_NAME env | grep JWT_EXPIRE

echo "✅ JWT expiry fix completed!"
echo ""
echo "📱 Users should now be able to log in again with 30-day token expiry"
echo "   - Old expired tokens will still need to be cleared from browsers"
echo "   - New logins will have 30-day expiry"

EOF

echo "✅ Remote JWT expiry fix completed!"
echo ""
echo "🔧 The fix includes:"
echo "   - Updated JWT_EXPIRE to 30d in the running container"
echo "   - Restarted the container to pick up the new setting"
echo ""
echo "📱 Users should now be able to log in again with 30-day token expiry" 