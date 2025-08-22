#!/bin/bash

echo "🚀 Deploying Let My People Grow with Nginx..."

# Stop current containers
echo "📴 Stopping current containers..."
ssh wpclick@192.168.193.11 "cd /opt/letmypeoplegrow && docker-compose -f docker-compose.prod.yml down"

# Copy updated files
echo "📁 Copying updated configuration files..."
scp docker-compose.prod.yml wpclick@192.168.193.11:/opt/letmypeoplegrow/
scp nginx.conf wpclick@192.168.193.11:/opt/letmypeoplegrow/

# Deploy new stack
echo "🚀 Deploying new stack with nginx..."
ssh wpclick@192.168.193.11 "cd /opt/letmypeoplegrow && docker-compose -f docker-compose.prod.yml up -d"

# Wait for containers to be ready
echo "⏳ Waiting for containers to be ready..."
sleep 10

# Check container status
echo "🔍 Checking container status..."
ssh wpclick@192.168.193.11 "docker ps | grep church_attendance"

echo ""
echo "✅ Deployment complete!"
echo ""
echo "📋 Next steps:"
echo "1. Update nginx-proxy-manager to point to:"
echo "   - Forward Hostname/IP: 192.168.193.11"
echo "   - Forward Port: 80"
echo "2. Remove the custom /socket.io/ location from nginx-proxy-manager"
echo "3. Test WebSocket connections"
echo ""
echo "🔗 The nginx container will handle all WebSocket proxying internally!"
