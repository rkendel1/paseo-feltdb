#!/bin/bash

set -e

echo "🐳 Paseo Docker Setup"
echo "===================="
echo ""

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "   Visit: https://www.docker.com/products/docker-desktop"
    exit 1
fi

# Check if Docker daemon is running
if ! docker info > /dev/null 2>&1; then
    echo "❌ Docker daemon is not running. Please start Docker."
    exit 1
fi

echo "✅ Docker is installed and running"
echo ""

# Build the daemon image
echo "📦 Building Paseo daemon image..."
docker-compose build --no-cache

echo ""
echo "✅ Build complete!"
echo ""
echo "🚀 To start the daemon, run:"
echo "   docker-compose up -d"
echo ""
echo "📋 To view logs:"
echo "   docker-compose logs -f paseo-daemon"
echo ""
echo "🛑 To stop the daemon:"
echo "   docker-compose down"
echo ""
echo "📊 To check daemon status:"
echo "   curl http://localhost:6767/health || echo 'Daemon not ready'"
echo ""
echo "💡 Connect your desktop app:"
echo "   1. Open Paseo desktop app"
echo "   2. Add Server → localhost:6767"
echo "   3. Click 'Connect'"
echo ""
