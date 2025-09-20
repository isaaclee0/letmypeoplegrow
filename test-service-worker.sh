#!/bin/bash

# Test script to verify service worker accessibility
# Usage: ./test-service-worker.sh [domain]

DOMAIN=${1:-"localhost"}
echo "🔍 Testing service worker accessibility for domain: $DOMAIN"
echo ""

echo "1. Testing service worker file accessibility:"
echo "   URL: http://$DOMAIN/sw.js"
curl -I "http://$DOMAIN/sw.js" 2>/dev/null | head -10
echo ""

echo "2. Testing service worker file content:"
echo "   First 10 lines of sw.js:"
curl -s "http://$DOMAIN/sw.js" 2>/dev/null | head -10
echo ""

echo "3. Testing service worker file size:"
curl -s "http://$DOMAIN/sw.js" 2>/dev/null | wc -c | xargs echo "Size: " bytes
echo ""

echo "4. Testing service worker MIME type:"
curl -I "http://$DOMAIN/sw.js" 2>/dev/null | grep -i "content-type"
echo ""

echo "5. Testing if service worker has proper cache headers:"
curl -I "http://$DOMAIN/sw.js" 2>/dev/null | grep -i "cache"
echo ""

echo "✅ Service worker test completed!"
echo ""
echo "Expected results:"
echo "- HTTP 200 status"
echo "- Content-Type: application/javascript or text/javascript"
echo "- Cache-Control: no-cache headers"
echo "- File size > 0 bytes"
echo "- Contains service worker code (self.addEventListener)"
