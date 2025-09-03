#!/bin/bash

# Update version script for Let My People Grow
# Usage: ./update-version.sh [new_version]
# Example: ./update-version.sh 0.7.3

if [ $# -eq 0 ]; then
    echo "Usage: $0 [new_version]"
    echo "Example: $0 0.7.3"
    exit 1
fi

NEW_VERSION=$1

echo "Updating version to $NEW_VERSION..."

# Update client package.json
echo "Updating client/package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" client/package.json

# Update server package.json
echo "Updating server/package.json..."
sed -i '' "s/\"version\": \"[^\"]*\"/\"version\": \"$NEW_VERSION\"/" server/package.json

# Update build script default version
echo "Updating build-and-push.sh..."
sed -i '' "s/VERSION=\${1:-v[^}]*}/VERSION=\${1:-v$NEW_VERSION}/" build-and-push.sh

# Update client version utility fallback
echo "Updating client/src/utils/version.ts..."
# Use perl for more reliable regex replacement
perl -pi -e "s/'[0-9]+\.[0-9]+\.[0-9]+'/'$NEW_VERSION'/g" client/src/utils/version.ts

# Regenerate service worker with new version
echo "Regenerating service worker..."
cd client && node scripts/generate-sw.js && cd ..

# Update .env.example
echo "Updating .env.example..."
sed -i '' "s/IMAGE_TAG=v[0-9]\+\.[0-9]\+\.[0-9]\+/IMAGE_TAG=v$NEW_VERSION/" .env.example

# Validate the updates
echo ""
echo "🔍 Validating version updates..."
echo "Checking key files for version $NEW_VERSION:"

# Check package.json files
if grep -q "\"version\": \"$NEW_VERSION\"" client/package.json; then
    echo "  ✅ client/package.json"
else
    echo "  ❌ client/package.json - version not updated"
fi

if grep -q "\"version\": \"$NEW_VERSION\"" server/package.json; then
    echo "  ✅ server/package.json"
else
    echo "  ❌ server/package.json - version not updated"
fi

# Check build script
if grep -q "VERSION=\${1:-v$NEW_VERSION}" build-and-push.sh; then
    echo "  ✅ build-and-push.sh"
else
    echo "  ❌ build-and-push.sh - version not updated"
fi

# Check version utility
if grep -q "const fallbackVersion = '$NEW_VERSION';" client/src/utils/version.ts; then
    echo "  ✅ client/src/utils/version.ts"
else
    echo "  ❌ client/src/utils/version.ts - version not updated"
fi

# Check service worker
if grep -q "const APP_VERSION = '$NEW_VERSION';" client/public/sw.js; then
    echo "  ✅ client/public/sw.js"
else
    echo "  ❌ client/public/sw.js - version not updated"
fi

echo ""
echo "✅ Version updated to $NEW_VERSION in all files!"
echo ""
echo "Files updated:"
echo "  - client/package.json"
echo "  - server/package.json"
echo "  - build-and-push.sh"
echo "  - client/src/utils/version.ts"
echo "  - client/public/sw.js"
echo "  - .env.example"
echo ""
echo "Next steps:"
echo "  1. Commit the changes: git add . && git commit -m \"Update version to $NEW_VERSION\""
echo "  2. Build and push: ./build-and-push.sh v$NEW_VERSION" 