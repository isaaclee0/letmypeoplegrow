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

# Note: docker-compose.prod.yml now uses :latest tags, so no version update needed

# Update client version utility fallback
echo "Updating client/src/utils/version.ts..."
sed -i '' "s/const fallbackVersion = '[0-9]\+\.[0-9]\+\.[0-9]\+';/const fallbackVersion = '$NEW_VERSION';/" client/src/utils/version.ts

# Regenerate service worker with new version
echo "Regenerating service worker..."
cd client && node scripts/generate-sw.js && cd ..

# Update .env.example
echo "Updating .env.example..."
sed -i '' "s/IMAGE_TAG=v[0-9]\+\.[0-9]\+\.[0-9]\+/IMAGE_TAG=v$NEW_VERSION/" .env.example

# Update documentation files
echo "Updating documentation files..."

# Update README.md
if grep -q "### v[0-9]\+\.[0-9]\+\.[0-9]\+ (Current)" README.md; then
    sed -i '' "s/### v[0-9]\+\.[0-9]\+\.[0-9]\+ (Current)/### v$NEW_VERSION (Current)/" README.md
fi

# Update DEPLOYMENT.md
sed -i '' "s/### Current Version: v[0-9]\+\.[0-9]\+\.[0-9]\+/### Current Version: v$NEW_VERSION/" DEPLOYMENT.md
sed -i '' "s/default: v[0-9]\+\.[0-9]\+\.[0-9]\+/default: v$NEW_VERSION/" DEPLOYMENT.md
sed -i '' "s/:v[0-9]\+\.[0-9]\+\.[0-9]\+/:v$NEW_VERSION/g" DEPLOYMENT.md

# Update DOCKER_HUB_DEPLOYMENT.md
sed -i '' "s/- \*\*Current Version\*\*: \`v[0-9]\+\.[0-9]\+\.[0-9]\+\`/- **Current Version**: \`v$NEW_VERSION\`/" DOCKER_HUB_DEPLOYMENT.md
sed -i '' "s/- \*\*Git Tag\*\*: \`v[0-9]\+\.[0-9]\+\.[0-9]\+\`/- **Git Tag**: \`v$NEW_VERSION\`/" DOCKER_HUB_DEPLOYMENT.md
sed -i '' "s/:v[0-9]\+\.[0-9]\+\.[0-9]\+\`/:v$NEW_VERSION\`/g" DOCKER_HUB_DEPLOYMENT.md
sed -i '' "s/IMAGE_TAG=v[0-9]\+\.[0-9]\+\.[0-9]\+/IMAGE_TAG=v$NEW_VERSION/g" DOCKER_HUB_DEPLOYMENT.md

# Update PORTAINER_DEPLOYMENT.md
sed -i '' "s/IMAGE_TAG=v[0-9]\+\.[0-9]\+\.[0-9]\+/IMAGE_TAG=v$NEW_VERSION/g" PORTAINER_DEPLOYMENT.md

# Update MIGRATION_FIX_SUMMARY.md
sed -i '' "s/# Database Migration System Fix - v[0-9]\+\.[0-9]\+\.[0-9]\+/# Database Migration System Fix - v$NEW_VERSION/" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/to use v[0-9]\+\.[0-9]\+\.[0-9]\+/to use v$NEW_VERSION/g" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/:v[0-9]\+\.[0-9]\+\.[0-9]\+/:v$NEW_VERSION/g" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/IMAGE_TAG=v[0-9]\+\.[0-9]\+\.[0-9]\+/IMAGE_TAG=v$NEW_VERSION/g" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/image version to v[0-9]\+\.[0-9]\+\.[0-9]\+/image version to v$NEW_VERSION/" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/- \*\*Previous Version\*\*: v[0-9]\+\.[0-9]\+\.[0-9]\+/- **Previous Version**: v$NEW_VERSION/" MIGRATION_FIX_SUMMARY.md
sed -i '' "s/- \*\*New Version\*\*: v[0-9]\+\.[0-9]\+\.[0-9]\+/- **New Version**: v$NEW_VERSION/" MIGRATION_FIX_SUMMARY.md

# Update server scripts that might contain version references
echo "Updating server scripts..."
find server/scripts -name "*.js" -exec sed -i '' "s/\.\/build-and-push\.sh v[0-9]\+\.[0-9]\+\.[0-9]\+/\.\/build-and-push\.sh v$NEW_VERSION/g" {} \;

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

# Check docker-compose.prod.yml (now uses :latest)
if grep -q "\${IMAGE_TAG:-latest}" docker-compose.prod.yml; then
    echo "  ✅ docker-compose.prod.yml (uses :latest)"
else
    echo "  ❌ docker-compose.prod.yml - not using :latest"
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
echo "  - docker-compose.prod.yml (uses :latest tags)"
echo "  - .env.example"
echo "  - README.md"
echo "  - DEPLOYMENT.md"
echo "  - DOCKER_HUB_DEPLOYMENT.md"
echo "  - PORTAINER_DEPLOYMENT.md"
echo "  - MIGRATION_FIX_SUMMARY.md"
echo "  - server/scripts/*.js"
echo ""
echo "Next steps:"
echo "  1. Commit the changes: git add . && git commit -m \"Update version to $NEW_VERSION\""
echo "  2. Build and push: ./build-and-push.sh v$NEW_VERSION" 