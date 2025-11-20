#!/bin/bash

# Database Backup Script
# 
# Creates automated daily backups of PostgreSQL database
# Features:
# - Compressed backups
# - Retention policy (keep last 30 days)
# - Timestamped filenames
# - Error handling and logging
#
# Usage:
#   ./scripts/backup-database.sh
#   Or add to crontab: 0 2 * * * /path/to/scripts/backup-database.sh

set -euo pipefail

# Configuration
BACKUP_DIR="${BACKUP_DIR:-./backups}"
RETENTION_DAYS="${RETENTION_DAYS:-30}"
TIMESTAMP=$(date +"%Y%m%d_%H%M%S")
BACKUP_FILE="${BACKUP_DIR}/snacktrack_backup_${TIMESTAMP}.sql.gz"

# Database connection (from environment or defaults)
DB_HOST="${DB_HOST:-localhost}"
DB_PORT="${DB_PORT:-5432}"
DB_NAME="${DB_NAME:-snacktrack_dev}"
DB_USER="${DB_USER:-snacktrack}"
DB_PASSWORD="${DB_PASSWORD:-password}"

# Create backup directory if it doesn't exist
mkdir -p "${BACKUP_DIR}"

# Logging function
log() {
    echo "[$(date +'%Y-%m-%d %H:%M:%S')] $1" | tee -a "${BACKUP_DIR}/backup.log"
}

log "Starting database backup..."

# Set PGPASSWORD environment variable for pg_dump
export PGPASSWORD="${DB_PASSWORD}"

# Perform backup
if pg_dump -h "${DB_HOST}" -p "${DB_PORT}" -U "${DB_USER}" -d "${DB_NAME}" \
    --no-password \
    --verbose \
    --format=custom \
    --file="${BACKUP_FILE%.gz}" 2>&1 | tee -a "${BACKUP_DIR}/backup.log"; then
    
    # Compress backup
    log "Compressing backup..."
    gzip "${BACKUP_FILE%.gz}"
    
    # Get backup size
    BACKUP_SIZE=$(du -h "${BACKUP_FILE}" | cut -f1)
    log "Backup completed successfully: ${BACKUP_FILE} (${BACKUP_SIZE})"
    
    # Clean up old backups (keep last N days)
    log "Cleaning up backups older than ${RETENTION_DAYS} days..."
    find "${BACKUP_DIR}" -name "snacktrack_backup_*.sql.gz" -type f -mtime +${RETENTION_DAYS} -delete
    log "Cleanup complete"
    
    # List remaining backups
    BACKUP_COUNT=$(find "${BACKUP_DIR}" -name "snacktrack_backup_*.sql.gz" -type f | wc -l)
    log "Total backups retained: ${BACKUP_COUNT}"
    
    exit 0
else
    log "ERROR: Backup failed!"
    exit 1
fi

