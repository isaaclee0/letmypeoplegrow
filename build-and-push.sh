#!/bin/bash

# Build and Push Script for Let My People Grow
# Uses Docker Build Cloud for faster builds

set -e

# Configuration
VERSION=${1:-v0.1.1}
REGISTRY="staugustine1"
SERVER_IMAGE="$REGISTRY/letmypeoplegrow-server"
CLIENT_IMAGE="$REGISTRY/letmypeoplegrow-client"

echo "Building and pushing version: $VERSION"

# Use Docker Build Cloud for faster builds
BUILDER="cloud-staugustine1-oneclick"

# Check if builder exists
if ! docker buildx inspect $BUILDER >/dev/null 2>&1; then
    echo "Builder $BUILDER not found. Creating local builder..."
    docker buildx create --use --name cloud-builder --driver docker-container
    BUILDER="cloud-builder"
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
docker buildx build \
    --builder $BUILDER \
    --platform linux/amd64 \
    -t $CLIENT_IMAGE:$VERSION \
    -t $CLIENT_IMAGE:latest \
    -f Dockerfile.client.optimized \
    . \
    --push

echo "✅ Client image built and pushed: $CLIENT_IMAGE:$VERSION"

echo ""
echo "🎉 All images built and pushed successfully!"
echo ""
echo "Available images:"
echo "  Server: $SERVER_IMAGE:$VERSION"
echo "  Client: $CLIENT_IMAGE:$VERSION"
echo ""
echo "To deploy, use:"
echo "  IMAGE_TAG=$VERSION docker-compose -f docker-compose.prod.yml up -d" 