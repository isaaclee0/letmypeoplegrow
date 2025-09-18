#!/bin/bash

# Helper script to clear user preferences for testing
# Usage: ./clear-user-preferences.sh <email>
# Example: ./clear-user-preferences.sh isaac+test1@leemail.com.au

if [ $# -eq 0 ]; then
    echo "❌ Please provide an email address"
    echo "Usage: ./clear-user-preferences.sh <email>"
    echo "Examples:"
    echo "  ./clear-user-preferences.sh isaac+test1@leemail.com.au"
    echo "  ./clear-user-preferences.sh admin@example.com"
    exit 1
fi

EMAIL="$1"

echo "🧹 Clearing user preferences for: $EMAIL"
echo "Running via Docker..."

docker-compose -f docker-compose.dev.yml exec server node delete-user-preferences.js "$EMAIL"

echo "✅ Done!"
