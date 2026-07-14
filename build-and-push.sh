#!/bin/bash
# Build and push Docker images to Docker Hub with multi-architecture support
# Usage: ./build-and-push.sh
# (Version argument is optional - images are tagged as :latest for testing)
#
# Supports: linux/amd64, linux/arm64
# Note: Uses docker buildx for multi-architecture builds

set -e

# Version argument is optional (for documentation purposes)
# Images will be tagged as :latest only for testing
VERSION=${1:-"latest"}
CURRENT_VERSION="latest"  # Only use :latest tag for testing
REGISTRY="docker.io"

# Configure your Docker Hub username below
# Change "trailcurrent" to your own Docker Hub username
# Alternatively, set DOCKER_HUB_USERNAME environment variable before running this script
DOCKER_USERNAME="${DOCKER_HUB_USERNAME:-trailcurrent}"

PLATFORMS="linux/amd64,linux/arm64"

# Verify Docker is available
if ! command -v docker &> /dev/null; then
    echo "Error: Docker is not installed or not in PATH"
    exit 1
fi

# Verify docker buildx is available
if ! docker buildx version &> /dev/null; then
    echo "Error: Docker buildx is not available"
    echo "Install Docker Desktop or enable buildx: docker buildx create --use"
    exit 1
fi

# Use a dedicated builder for multi-arch builds (never changes the active builder)
BUILDER_NAME="trailcurrent-multiarch"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
    echo "Creating multi-arch builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --platform linux/amd64,linux/arm64
fi

# Verify user is logged in to Docker Hub
if ! docker info | grep -q "Username:"; then
    echo "Error: Not logged in to Docker Hub"
    echo "Run: docker login"
    exit 1
fi

echo "=========================================="
echo "Building Docker images (multi-arch)"
echo "Tag: latest (testing)"
echo "Platforms: $PLATFORMS"
echo "=========================================="
echo ""

# Array of images to build and push
declare -a IMAGES=(
    "frontend"
    "backend"
    "mosquitto"
)

# Build and push each image
for IMAGE in "${IMAGES[@]}"; do
    IMAGE_NAME="$IMAGE"

    echo "-------------------------------------------"
    echo "Building: trailcurrent-$IMAGE_NAME:latest"
    echo "-------------------------------------------"

    case $IMAGE in
        frontend)
            CONTEXT="containers/frontend"
            DOCKERFILE="containers/frontend/Dockerfile"
            ;;
        backend)
            CONTEXT="containers/backend"
            DOCKERFILE="containers/backend/Dockerfile"
            ;;
        mosquitto)
            CONTEXT="containers/mosquitto"
            DOCKERFILE="containers/mosquitto/Dockerfile"
            ;;
    esac

    # Build and push with buildx (multi-architecture)
    # Only tag as :latest for testing
    docker buildx build \
        --builder "$BUILDER_NAME" \
        --platform "$PLATFORMS" \
        -f "$DOCKERFILE" \
        -t "$REGISTRY/$DOCKER_USERNAME/trailcurrent-$IMAGE_NAME:latest" \
        --push \
        "$CONTEXT"

    echo "✓ Successfully pushed trailcurrent-$IMAGE_NAME:$VERSION (multi-arch)"
    echo ""
done

echo "=========================================="
echo "✓ All images built and pushed successfully!"
echo "=========================================="
echo ""
echo "Published images (all architectures):"
for IMAGE in "${IMAGES[@]}"; do
    echo "  - $REGISTRY/$DOCKER_USERNAME/trailcurrent-$IMAGE:latest"
done
echo ""
echo "Architectures: linux/amd64, linux/arm64"
echo "Tag: :latest (for testing)"
echo ""
echo "View on Docker Hub:"
echo "  https://hub.docker.com/u/$DOCKER_USERNAME"
