#!/bin/bash

# Database backup script for Let My People Grow (SQLite)
# Usage: ./backup-db.sh [backup_name]
#
# Backs up all SQLite database files (registry + per-church databases)
# from the Docker volume to a local backups/ directory.

BACKUP_NAME=${1:-$(date +%Y%m%d_%H%M%S)}
BACKUP_DIR="backups/backup_${BACKUP_NAME}"

echo "Creating database backup: $BACKUP_DIR"

# Create backup directory
mkdir -p "$BACKUP_DIR"

# Copy the data directory from the server container
docker cp church_attendance_server:/app/data "$BACKUP_DIR/data"

if [ $? -eq 0 ]; then
    echo "Backup created successfully: $BACKUP_DIR"
    echo "Backup size: $(du -sh "$BACKUP_DIR" | cut -f1)"
    echo "Contents:"
    ls -lh "$BACKUP_DIR/data/"
else
    echo "Backup failed!"
    exit 1
fi
