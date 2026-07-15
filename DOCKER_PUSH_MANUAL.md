# Manual Docker Image Build & Push Guide

This guide explains how to build Docker images locally and push them to Docker Hub.

## Quick Start

```bash
# 1. Configure your Docker Hub username in build-and-push.sh
# (Edit the DOCKER_USERNAME variable)

# 2. Log in to Docker Hub (one time)
docker login

# 3. Build and push all images
./build-and-push.sh

# That's it! All 3 custom images are now on Docker Hub with :latest tag.
# (Third-party images — mongo, photon, valhalla — are pulled from their
# upstream registries at build-and-save-images.sh time, not pushed by us.)
```

## Prerequisites

- Docker Desktop installed (includes buildx) or Docker with buildx enabled
- Docker Hub account (you'll configure your username in the build script)
- Run `docker login` once to authenticate

## Configuration

Before running the build script, configure your Docker Hub username:

1. Edit `build-and-push.sh`
2. Find the line with `DOCKER_USERNAME` and change it to your Docker Hub username:
   ```bash
   DOCKER_USERNAME="your-dockerhub-username"
   ```

Alternatively, set the environment variable before running the script:
```bash
export DOCKER_HUB_USERNAME="your-dockerhub-username"
./build-and-push.sh
```

### Enable Docker Buildx (if needed)

If you get an error about buildx not being available:

```bash
# Create a buildx builder instance
docker buildx create --use

# Verify it's working
docker buildx version
```

## How It Works

The `build-and-push.sh` script uses **Docker Buildx** to:
1. Build all 4 Docker images for **multiple architectures**:
   - `linux/amd64` (your development machine, servers)
   - `linux/arm64` (Raspberry Pi CM5, modern ARM devices)
2. Tag them as `:latest` for testing
3. Push to Docker Hub (all architectures in one push)

**Note:** The builds take longer than single-architecture builds, but creates images that work on ARM Raspberry Pis AND traditional x86 machines.

**Architecture Support:**
- `linux/amd64` - x86-64 servers and development machines
- `linux/arm64` - 64-bit ARM (Raspberry Pi CM5, modern ARM devices)

## Usage

### Basic Usage

```bash
./build-and-push.sh
```

This will build and push all 3 custom images to Docker Hub with the `:latest` tag:
- Build and push `<username>/trailcurrent-frontend:latest`
- Build and push `<username>/trailcurrent-backend:latest`
- Build and push `<username>/trailcurrent-mosquitto:latest`

(Where `<username>` is your Docker Hub username configured in `build-and-push.sh`)

**Third-party images we ship but don't own:**
- `mongo:7` — Docker Hub official
- `rtuszik/photon-docker:2.3` — community-maintained Docker packaging of Photon geocoder ([source](https://github.com/rtuszik/photon-docker))
- `ghcr.io/nilsnolde/docker-valhalla/valhalla:latest` — community-maintained Docker packaging of Valhalla routing engine ([source](https://github.com/nilsnolde/docker-valhalla))

These are pulled fresh from their upstream registries by `build-and-save-images.sh` at package-build time and shipped as tarballs inside the deployment package. They do NOT go into our Docker Hub. See `THIRD_PARTY_LICENSES.md` for licensing.

## Step-by-Step Setup

### 1. Create Docker Hub Repositories

Create these **public** repositories on [Docker Hub](https://hub.docker.com):
- `trailcurrent-frontend`
- `trailcurrent-backend`
- `trailcurrent-mosquitto`

(Just create empty repos, the script will populate them.)

### 2. Log In to Docker Hub

```bash
docker login
# Enter your Docker Hub username and password
```

### 3. Build and Push Images

```bash
./build-and-push.sh
```

Monitor the output - it will build and push all 3 custom images with the `:latest` tag.

## Verifying Success

After pushing, verify on Docker Hub:

1. Go to https://hub.docker.com/u/<your-username>
2. Click each repository
3. Check "Tags" - you should see `:latest` with multi-architecture support

Or verify from command line:

```bash
# Pull an image to verify it's available
docker pull <username>/trailcurrent-frontend:latest
```

(Replace `<username>` with your Docker Hub username)

## Manual Build & Push (Advanced)

If you prefer to build images individually:

```bash
# Build a single image (for your local architecture)
docker build -f containers/frontend/Dockerfile \
  -t <username>/trailcurrent-frontend:latest \
  containers/frontend

# Push the image
docker push <username>/trailcurrent-frontend:latest
```

**Note:** For multi-architecture builds (amd64 + arm64), use the `build-and-push.sh` script instead, as it uses `docker buildx` for cross-platform compilation.

## Understanding Docker Buildx

**What is buildx?**
- Docker Buildx enables building images for multiple architectures (AMD64, ARM64)
- Single command builds for all architectures and pushes to registry
- Required for Raspberry Pi CM5 support

**Why it's needed:**
- Regular `docker build` only builds for your current machine's architecture
- Buildx cross-compiles and creates multi-architecture images
- Users on Raspberry Pi CM5 automatically get the correct ARM64 image

**Performance notes:**
- Building for multiple architectures takes longer (15-30 minutes vs 2-5 minutes)
- Layer caching helps subsequent builds
- Each push includes all architectures automatically

## Troubleshooting

### "Docker buildx is not available"
```bash
# Install buildx (usually included with Docker Desktop)
docker buildx create --use
docker buildx version
```

### "Not logged in to Docker Hub"
```bash
docker login
```

### "Permission denied"
- Verify you own the Docker Hub repositories
- Check your `DOCKER_USERNAME` in `build-and-push.sh` matches your Docker Hub account
- Verify you ran `docker login` with the correct credentials

### "Build failed"
- Check Dockerfiles exist in correct paths
- Verify all dependencies are available
- Check Docker daemon is running: `docker ps`
- For buildx-specific issues:
  ```bash
  docker buildx ls  # List builders
  docker buildx use default  # Switch to default builder if needed
  ```

### "Push failed"
- Verify repositories exist on Docker Hub
- Check you have push permissions
- Verify network connection
- Ensure `--push` flag is working (requires Docker Hub login)

## Workflow Example

```bash
# 1. Make changes to code
git commit -m "Add new feature"

# 2. Test locally
docker compose up -d --build
# ... test thoroughly ...
docker compose down

# 3. When ready to test on Docker Hub
# Build and push to Docker Hub with :latest tag
./build-and-push.sh

# 4. Verify images are available on Docker Hub
docker pull <username>/trailcurrent-frontend:latest

# 5. When ready for formal release
# You can create a git tag and update version numbering if desired
git tag v1.0.0
git push origin v1.0.0
```

## Deployment

To use published Docker Hub images in production:

```bash
# Pull the latest version
docker pull <username>/trailcurrent-frontend:latest

# Or update docker-compose.yml to pull instead of build
# Change from:
#   image: trailcurrent-in-vehicle-frontend:latest
#   build: ./containers/frontend
# To:
#   image: <username>/trailcurrent-frontend:latest
```

(Replace `<username>` with your Docker Hub username)

## Notes

- **No GitHub secrets needed** - You control when to push
- **Simple and transparent** - Easy to see what's being built
- **Local builds first** - Test locally before pushing
- **Manual control** - You decide when to release
