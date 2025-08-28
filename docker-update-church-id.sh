#!/bin/bash
# Docker wrapper script to update church ID inside the container
# Usage: ./docker-update-church-id.sh "enjoychurch" "enjoy church"

if [ $# -ne 2 ]; then
    echo "Usage: ./docker-update-church-id.sh <old-church-id> <church-name>"
    echo "Example: ./docker-update-church-id.sh \"enjoychurch\" \"enjoy church\""
    exit 1
fi

OLD_CHURCH_ID="$1"
CHURCH_NAME="$2"

echo "🐳 Running church ID update inside Docker container..."
echo "📋 Old ID: $OLD_CHURCH_ID"
echo "📋 Church Name: $CHURCH_NAME"
echo ""

# Run the update script inside the server container
docker-compose -f docker-compose.dev.yml exec server node update-church-id.js "$OLD_CHURCH_ID" "$CHURCH_NAME"

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Church ID update completed successfully!"
    echo "🔄 You may need to restart the containers for changes to take full effect:"
    echo "   docker-compose -f docker-compose.dev.yml restart"
else
    echo ""
    echo "❌ Church ID update failed. Check the error messages above."
    exit 1
fi
