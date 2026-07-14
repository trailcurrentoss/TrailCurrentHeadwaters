#!/bin/bash
set -e

# Build and Save ARM64 Docker Images Script
# Builds each service for ARM64 and saves as tar files for offline deployment
#
# Usage: ./build-and-save-images.sh
#
# Image tags match docker-compose.yml exactly so deploy.sh can use them
# with `docker compose up -d --no-build` after loading.

echo "=========================================="
echo "Building ARM64 Docker Images & Saving Tars"
echo "=========================================="
echo ""

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

# Use a dedicated builder for cross-platform builds (never changes the active builder)
BUILDER_NAME="trailcurrent-arm64"
if ! docker buildx inspect "$BUILDER_NAME" &>/dev/null; then
    echo "Creating cross-platform builder: $BUILDER_NAME"
    docker buildx create --name "$BUILDER_NAME" --platform linux/amd64,linux/arm64
fi

# Clean up any existing tar files from previous builds
if [ -d "images" ] && [ "$(ls -A images/*.tar 2>/dev/null)" ]; then
    echo "Removing old tar files from previous build..."
    rm -f images/*.tar
    echo "  Cleaned up old tar files"
fi

# Create images directory
mkdir -p images

# Services to build locally
# Format: BUILD_DIR|IMAGE_TAG
# IMAGE_TAG must match docker-compose.yml image: directive exactly
SERVICES=(
    "containers/frontend|trailcurrent-in-vehicle-frontend"
    "containers/backend|trailcurrent-in-vehicle-backend"
    "containers/mosquitto|trailcurrent-in-vehicle-mosquitto"
)

# Build and save each service
for service_info in "${SERVICES[@]}"; do
    IFS='|' read -r build_dir image_tag <<< "$service_info"

    # Derive a short name for the tar file from the build directory
    tar_name=$(basename "$build_dir")
    tar_file="images/${tar_name}.tar"

    echo "=========================================="
    echo "Building $image_tag (linux/arm64)..."
    echo "  Context: $build_dir"
    echo "=========================================="

    # Build for ARM64 and write directly to tar (does NOT load into local Docker)
    if docker buildx build --builder "$BUILDER_NAME" --platform linux/arm64 \
        -t "$image_tag:latest" \
        --output "type=docker,dest=$tar_file" \
        "$build_dir/" > /tmp/build.log 2>&1; then
        SIZE=$(du -h "$tar_file" | cut -f1)
        echo "  Built and saved to $tar_file ($SIZE)"
    else
        echo "  Failed to build $image_tag"
        cat /tmp/build.log
        exit 1
    fi

    echo ""
done

# Save MongoDB for truly offline deployment (does NOT load into local Docker)
echo "=========================================="
echo "Saving mongo:7 (linux/arm64)..."
echo "=========================================="

if docker buildx build --builder "$BUILDER_NAME" --platform linux/arm64 \
    -t mongo:7 \
    --output "type=docker,dest=images/mongodb.tar" \
    - <<'DOCKERFILE' > /tmp/build.log 2>&1
FROM mongo:7
DOCKERFILE
then
    SIZE=$(du -h "images/mongodb.tar" | cut -f1)
    echo "  Saved to images/mongodb.tar ($SIZE)"
else
    echo "  Failed to save mongo:7"
    cat /tmp/build.log
    exit 1
fi

# Save Photon — third-party geocoder image used by Phase 3 of the offline-
# maps migration. Pulled from upstream (Docker Hub) at every run of this
# script. NOT digest-pinned by design — QA on the produced CM5 image is
# the gate that catches upstream regressions before release.
echo "=========================================="
echo "Saving rtuszik/photon-docker:2.3 (linux/arm64)..."
echo "=========================================="

if docker buildx build --builder "$BUILDER_NAME" --platform linux/arm64 \
    -t rtuszik/photon-docker:2.3 \
    --output "type=docker,dest=images/photon.tar" \
    - <<'DOCKERFILE' > /tmp/build.log 2>&1
FROM rtuszik/photon-docker:2.3
DOCKERFILE
then
    SIZE=$(du -h "images/photon.tar" | cut -f1)
    echo "  Saved to images/photon.tar ($SIZE)"
else
    echo "  Failed to save rtuszik/photon-docker:2.3"
    cat /tmp/build.log
    exit 1
fi

# Save Valhalla — routing engine for Phase 4. The image ships with a
# tile-serving entrypoint that consumes our pre-built valhalla_tiles/
# directory from data/maps/current/. Same policy as Photon — pulled fresh
# on every run, QA catches upstream drift. Note: the `:latest` tag is
# rebuilt every Saturday from Valhalla master, so runs days apart may
# produce materially different Valhallas.
echo "=========================================="
echo "Saving ghcr.io/nilsnolde/docker-valhalla/valhalla:latest (linux/arm64)..."
echo "=========================================="

if docker buildx build --builder "$BUILDER_NAME" --platform linux/arm64 \
    -t ghcr.io/nilsnolde/docker-valhalla/valhalla:latest \
    --output "type=docker,dest=images/valhalla.tar" \
    - <<'DOCKERFILE' > /tmp/build.log 2>&1
FROM ghcr.io/nilsnolde/docker-valhalla/valhalla:latest
DOCKERFILE
then
    SIZE=$(du -h "images/valhalla.tar" | cut -f1)
    echo "  Saved to images/valhalla.tar ($SIZE)"
else
    echo "  Failed to save ghcr.io/nilsnolde/docker-valhalla/valhalla:latest"
    cat /tmp/build.log
    exit 1
fi

echo ""
echo "=========================================="
echo "Build Complete!"
echo "=========================================="
echo ""
echo "Created tar files:"
ls -lh images/*.tar
echo ""
echo "Next step: Run ./create-deployment-package.sh to create the deployment zip"
echo ""
