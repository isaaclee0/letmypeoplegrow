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

echo "✅ Version updated to $NEW_VERSION in all files!"
echo ""
echo "Files updated:"
echo "  - client/package.json"
echo "  - server/package.json"
echo "  - build-and-push.sh"
echo ""
echo "Next steps:"
echo "  1. Commit the changes: git add . && git commit -m \"Update version to $NEW_VERSION\""
echo "  2. Build and push: ./build-and-push.sh v$NEW_VERSION" 