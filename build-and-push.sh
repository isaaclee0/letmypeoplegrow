#!/bin/bash

# Build and push Docker images to Docker Hub
# Usage: ./build-and-push.sh [version]
# If no version is provided, uses the default version

# Default version (change this when releasing new versions)
VERSION=${1:-v1.1.1}

# Configuration
REGISTRY="staugustine1"
SERVER_IMAGE="$REGISTRY/letmypeoplegrow-server"
CLIENT_IMAGE="$REGISTRY/letmypeoplegrow-client"

echo "Building and pushing version: $VERSION"

# Use Docker Build Cloud for faster builds
BUILDER="cloud-staugustine1-oneclick"

# Check if builder exists and is working
if ! docker buildx inspect $BUILDER >/dev/null 2>&1; then
    echo "Builder $BUILDER not found. Creating local builder..."
    docker buildx create --use --name cloud-builder --driver docker-container
    BUILDER="cloud-builder"
else
    # Test if cloud builder is working, fallback to local if not
    if ! docker buildx build --builder $BUILDER --platform linux/amd64 --dry-run . >/dev/null 2>&1; then
        echo "Cloud builder not working. Using local builder..."
        docker buildx create --use --name cloud-builder --driver docker-container
        BUILDER="cloud-builder"
    fi
fi

echo "Using builder: $BUILDER"

# Build and push server image
echo "Building server image..."
docker buildx build \
    --builder $BUILDER \
    --platform linux/amd64 \
    -t $SERVER_IMAGE:$VERSION \
    -t $SERVER_IMAGE:latest \
    -f Dockerfile.server \
    . \
    --push

echo "✅ Server image built and pushed: $SERVER_IMAGE:$VERSION"

# Build and push client image
echo "Building client image..."
echo "  - This will regenerate the service worker with cache busting"
docker buildx build \
    --builder $BUILDER \
    --platform linux/amd64 \
    --build-arg VERSION=$VERSION \
    -t $CLIENT_IMAGE:$VERSION \
    -t $CLIENT_IMAGE:latest \
    -f Dockerfile.client.optimized \
    . \
    --push

echo "✅ Client image built and pushed: $CLIENT_IMAGE:$VERSION"
echo "✅ Service worker updated with new cache version"

echo ""
echo "🎉 All images built and pushed successfully!"
echo ""
echo "Available images:"
echo "  Server: $SERVER_IMAGE:$VERSION"
echo "  Client: $CLIENT_IMAGE:$VERSION"
echo ""
echo "To deploy, use:"
echo "  IMAGE_TAG=$VERSION docker-compose -f docker-compose.prod.yml up -d" 