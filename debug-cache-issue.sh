#!/bin/bash

# Debug script to help diagnose caching issues
# Usage: ./debug-cache-issue.sh [domain]

DOMAIN=${1:-"localhost"}
echo "🔍 Debugging cache issues for domain: $DOMAIN"
echo ""

echo "📋 Checking HTTP headers for key files:"
echo ""

# Check index.html headers
echo "1. Index.html headers:"
curl -I "http://$DOMAIN/index.html" 2>/dev/null | grep -E "(HTTP|Cache-Control|ETag|Last-Modified|Expires|Pragma|Date)" || echo "Failed to fetch index.html"
echo ""

# Check service worker headers
echo "2. Service Worker headers:"
curl -I "http://$DOMAIN/sw.js" 2>/dev/null | grep -E "(HTTP|Cache-Control|ETag|Last-Modified|Expires|Pragma|Date)" || echo "Failed to fetch sw.js"
echo ""

# Check main JS file headers (if available)
echo "3. Main JS file headers (checking for any .js file):"
JS_FILE=$(curl -s "http://$DOMAIN" | grep -o 'src="[^"]*\.js[^"]*"' | head -1 | sed 's/src="//' | sed 's/"//')
if [ ! -z "$JS_FILE" ]; then
    echo "Found JS file: $JS_FILE"
    curl -I "http://$DOMAIN$JS_FILE" 2>/dev/null | grep -E "(HTTP|Cache-Control|ETag|Last-Modified|Expires|Pragma|Date)" || echo "Failed to fetch $JS_FILE"
else
    echo "No JS files found in index.html"
fi
echo ""

# Check if there are multiple service workers registered
echo "4. Checking for multiple service worker registrations:"
echo "   Open Developer Tools > Application > Service Workers"
echo "   Look for multiple registrations with different scopes"
echo ""

# Check for CDN or proxy caching
echo "5. Checking for CDN/Proxy headers:"
curl -I "http://$DOMAIN/" 2>/dev/null | grep -E "(HTTP|Cache-Control|ETag|Last-Modified|Expires|Pragma|Date|X-Cache|X-Served-By|CF-Cache-Status)" || echo "Failed to fetch root"
echo ""

echo "📊 Browser cache debugging tips:"
echo "1. Open Developer Tools (F12)"
echo "2. Go to Network tab"
echo "3. Check 'Disable cache' checkbox"
echo "4. Reload the page"
echo "5. Look for files with status '304 Not Modified' (cached)"
echo "6. Look for files with status '200 OK' (fresh from server)"
echo ""

echo "🔧 Service Worker debugging:"
echo "1. Open Developer Tools (F12)"
echo "2. Go to Application tab"
echo "3. Click on 'Service Workers' in the left sidebar"
echo "4. Check if service worker is registered and active"
echo "5. Look for multiple service workers (old versions)"
echo "6. Click 'Unregister' on old service workers if found"
echo ""

echo "🧹 Manual cache clearing:"
echo "1. Hard refresh: Ctrl+Shift+R (Windows/Linux) or Cmd+Shift+R (Mac)"
echo "2. Clear browser cache: Ctrl+Shift+Delete (Windows/Linux) or Cmd+Shift+Delete (Mac)"
echo "3. Clear site data: Developer Tools > Application > Storage > Clear site data"
echo ""

echo "✅ Expected behavior after fixes:"
echo "- All files should have 'no-cache' headers"
echo "- Only one service worker should be registered"
echo "- All refresh types should show the same version"
echo ""
