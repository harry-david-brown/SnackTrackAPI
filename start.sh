#!/bin/bash

echo "🍕 Snack Track API - Quick Start"
echo "================================"

# Check if Docker is installed
if ! command -v docker &> /dev/null; then
    echo "❌ Docker is not installed. Please install Docker first."
    echo "   Visit: https://docs.docker.com/get-docker/"
    exit 1
fi

# Check if docker-compose is installed
if ! command -v docker-compose &> /dev/null; then
    echo "❌ Docker Compose is not installed. Please install Docker Compose first."
    echo "   Visit: https://docs.docker.com/compose/install/"
    exit 1
fi

echo "✅ Docker and Docker Compose are installed"

# Check if .env file exists
if [ ! -f .env ]; then
    echo "⚠️  No .env file found. The API will run in DEMO MODE with mock data."
    echo "   This is perfect for testing! You'll see fake receipt data."
    echo ""
    echo "   To use real Gmail data later:"
    echo "   1. Create a .env file with Gmail credentials"
    echo "   2. See README.md for instructions"
    echo ""
else
    echo "✅ .env file found - will use your Gmail credentials"
fi

echo "🚀 Starting Snack Track API..."
echo "   API will be available at: http://localhost:3000"
echo "   Health check: http://localhost:3000/"
echo ""

# Start the application
docker-compose -f docker-compose.prod.yml up --build

echo ""
echo "🎉 Snack Track API is running!"
echo "   Test it: curl http://localhost:3000/"
echo "   See README.md for API usage examples"
