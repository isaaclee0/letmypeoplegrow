#!/bin/bash

# Database backup script for Let My People Grow
# Usage: ./backup-db.sh [backup_name]

BACKUP_NAME=${1:-$(date +%Y%m%d_%H%M%S)}
BACKUP_FILE="backup_${BACKUP_NAME}.sql"

echo "Creating database backup: $BACKUP_FILE"

# Create backup directory if it doesn't exist
mkdir -p backups

# Create the backup
docker-compose exec -T church_attendance_db_dev mariadb -u church_user -pchurch_password church_attendance > "backups/$BACKUP_FILE"

if [ $? -eq 0 ]; then
    echo "✅ Backup created successfully: backups/$BACKUP_FILE"
    echo "📊 Backup size: $(du -h "backups/$BACKUP_FILE" | cut -f1)"
else
    echo "❌ Backup failed!"
    exit 1
fi 