const { S3Client, PutObjectCommand, GetObjectCommand, ListObjectsV2Command, DeleteObjectCommand } = require('@aws-sdk/client-s3');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');
const { pipeline } = require('stream/promises');
const cron = require('node-cron');
const Database = require('../config/database');

let s3Client = null;
let backupConfig = null;
let cronJob = null;
let lastBackupResult = null;

function getDataDir() {
  return process.env.CHURCH_DATA_DIR || process.env.DATA_DIR ||
    path.join(__dirname, '..', 'data');
}

function isConfigured() {
  return !!(backupConfig && backupConfig.endpoint && backupConfig.bucket &&
    backupConfig.accessKeyId && backupConfig.secretAccessKey);
}

function configure(config) {
  backupConfig = {
    endpoint: config.endpoint,
    bucket: config.bucket,
    region: config.region || 'us-east-1',
    accessKeyId: config.accessKeyId,
    secretAccessKey: config.secretAccessKey,
    prefix: config.prefix || 'backups',
    retentionDays: config.retentionDays || 30,
    schedule: config.schedule || '0 2 * * *', // daily at 2am
  };

  s3Client = new S3Client({
    endpoint: backupConfig.endpoint,
    region: backupConfig.region,
    credentials: {
      accessKeyId: backupConfig.accessKeyId,
      secretAccessKey: backupConfig.secretAccessKey,
    },
    forcePathStyle: true, // required for Linode/MinIO
  });

  return backupConfig;
}

function loadConfigFromEnv() {
  if (process.env.S3_BACKUP_ENDPOINT) {
    configure({
      endpoint: process.env.S3_BACKUP_ENDPOINT,
      bucket: process.env.S3_BACKUP_BUCKET,
      region: process.env.S3_BACKUP_REGION || 'us-east-1',
      accessKeyId: process.env.S3_BACKUP_ACCESS_KEY,
      secretAccessKey: process.env.S3_BACKUP_SECRET_KEY,
      prefix: process.env.S3_BACKUP_PREFIX || 'backups',
      retentionDays: parseInt(process.env.S3_BACKUP_RETENTION_DAYS) || 30,
      schedule: process.env.S3_BACKUP_SCHEDULE || '0 2 * * *',
    });
    return true;
  }
  return false;
}

function s3Key(subpath) {
  return `${backupConfig.prefix}/${subpath}`;
}

// Backup a single SQLite file using better-sqlite3's .backup() API
async function backupDatabase(dbPath, destPath) {
  const BetterSqlite3 = require('better-sqlite3');
  const sourceDb = new BetterSqlite3(dbPath, { readonly: true });
  try {
    // Checkpoint WAL before backup
    try { sourceDb.pragma('wal_checkpoint(TRUNCATE)'); } catch (_) {}
    await sourceDb.backup(destPath);
  } finally {
    sourceDb.close();
  }
}

// Gzip a file and return the gzipped path
async function gzipFile(filePath) {
  const gzPath = filePath + '.gz';
  const source = fs.createReadStream(filePath);
  const dest = fs.createWriteStream(gzPath);
  const gzip = zlib.createGzip({ level: 6 });
  await pipeline(source, gzip, dest);
  fs.unlinkSync(filePath); // remove uncompressed temp file
  return gzPath;
}

// Upload a file to S3
async function uploadToS3(localPath, key) {
  const body = fs.createReadStream(localPath);
  const stat = fs.statSync(localPath);

  await s3Client.send(new PutObjectCommand({
    Bucket: backupConfig.bucket,
    Key: key,
    Body: body,
    ContentType: 'application/gzip',
    ContentLength: stat.size,
    ServerSideEncryption: 'AES256',
  }));

  return stat.size;
}

// Download a file from S3
async function downloadFromS3(key, destPath) {
  const response = await s3Client.send(new GetObjectCommand({
    Bucket: backupConfig.bucket,
    Key: key,
  }));

  const dest = fs.createWriteStream(destPath);
  await pipeline(response.Body, dest);
}

// Backup a single church
async function backupChurch(churchId) {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);

  if (!fs.existsSync(dbPath)) {
    throw new Error(`Database file not found for church ${churchId}`);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDir = path.join(dataDir, '.backup-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `${churchId}-${timestamp}.sqlite`);

  try {
    await backupDatabase(dbPath, tmpPath);
    const gzPath = await gzipFile(tmpPath);
    const key = s3Key(`churches/${churchId}/${churchId}-${timestamp}.sqlite.gz`);
    const size = await uploadToS3(gzPath, key);
    fs.unlinkSync(gzPath);

    return { churchId, key, size, timestamp: new Date().toISOString() };
  } finally {
    // Clean up any leftover temp files
    for (const f of [tmpPath, tmpPath + '.gz']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

// Backup the registry database
async function backupRegistry() {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, 'registry.sqlite');

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const tmpDir = path.join(dataDir, '.backup-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const tmpPath = path.join(tmpDir, `registry-${timestamp}.sqlite`);

  try {
    await backupDatabase(dbPath, tmpPath);
    const gzPath = await gzipFile(tmpPath);
    const key = s3Key(`registry/registry-${timestamp}.sqlite.gz`);
    const size = await uploadToS3(gzPath, key);
    fs.unlinkSync(gzPath);

    return { key, size, timestamp: new Date().toISOString() };
  } finally {
    for (const f of [tmpPath, tmpPath + '.gz']) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

// Full backup of all churches + registry
async function backupAll() {
  const startTime = Date.now();
  const results = { registry: null, churches: [], errors: [] };

  try {
    results.registry = await backupRegistry();
  } catch (err) {
    results.errors.push({ target: 'registry', error: err.message });
  }

  const churches = Database.listChurches();
  for (const church of churches) {
    try {
      const result = await backupChurch(church.church_id);
      results.churches.push(result);
    } catch (err) {
      results.errors.push({ target: church.church_id, error: err.message });
    }
  }

  results.duration = Date.now() - startTime;
  results.timestamp = new Date().toISOString();
  lastBackupResult = results;

  // Clean up temp directory
  const tmpDir = path.join(getDataDir(), '.backup-tmp');
  if (fs.existsSync(tmpDir)) {
    try { fs.rmdirSync(tmpDir); } catch (_) {}
  }

  return results;
}

// List snapshots for a church (or registry)
async function listSnapshots(target = 'registry') {
  const prefix = target === 'registry'
    ? s3Key('registry/')
    : s3Key(`churches/${target}/`);

  const snapshots = [];
  let continuationToken;

  do {
    const response = await s3Client.send(new ListObjectsV2Command({
      Bucket: backupConfig.bucket,
      Prefix: prefix,
      ContinuationToken: continuationToken,
    }));

    if (response.Contents) {
      for (const obj of response.Contents) {
        const filename = obj.Key.split('/').pop();
        snapshots.push({
          key: obj.Key,
          filename,
          size: obj.Size,
          lastModified: obj.LastModified.toISOString(),
        });
      }
    }

    continuationToken = response.NextContinuationToken;
  } while (continuationToken);

  // Sort newest first
  snapshots.sort((a, b) => b.lastModified.localeCompare(a.lastModified));
  return snapshots;
}

// Restore a church database from a snapshot
async function restoreChurch(churchId, snapshotKey) {
  const dataDir = getDataDir();
  const dbPath = path.join(dataDir, 'churches', `${churchId}.sqlite`);
  const tmpDir = path.join(dataDir, '.backup-tmp');
  fs.mkdirSync(tmpDir, { recursive: true });

  const gzPath = path.join(tmpDir, `restore-${churchId}.sqlite.gz`);
  const restoredPath = path.join(tmpDir, `restore-${churchId}.sqlite`);

  try {
    // Download snapshot
    await downloadFromS3(snapshotKey, gzPath);

    // Decompress
    const source = fs.createReadStream(gzPath);
    const dest = fs.createWriteStream(restoredPath);
    const gunzip = zlib.createGunzip();
    await pipeline(source, gunzip, dest);

    // Verify the restored file is a valid SQLite database
    const BetterSqlite3 = require('better-sqlite3');
    const testDb = new BetterSqlite3(restoredPath, { readonly: true });
    try {
      testDb.prepare('SELECT 1').get();
    } finally {
      testDb.close();
    }

    // Close existing connections
    Database.closeChurchDb(churchId);

    // Create pre-rollback backup
    const preRollbackDir = path.join(dataDir, '.pre-rollback');
    fs.mkdirSync(preRollbackDir, { recursive: true });
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const preRollbackPath = path.join(preRollbackDir, `${churchId}-${timestamp}.sqlite`);

    if (fs.existsSync(dbPath)) {
      fs.copyFileSync(dbPath, preRollbackPath);
    }

    // Remove WAL and SHM files
    for (const suffix of ['-wal', '-shm']) {
      const f = dbPath + suffix;
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }

    // Replace database file
    fs.copyFileSync(restoredPath, dbPath);

    // Re-open the database to verify
    Database.getChurchDb(churchId);

    return {
      churchId,
      restoredFrom: snapshotKey,
      preRollbackBackup: preRollbackPath,
      timestamp: new Date().toISOString(),
    };
  } finally {
    for (const f of [gzPath, restoredPath]) {
      if (fs.existsSync(f)) fs.unlinkSync(f);
    }
  }
}

// Delete old snapshots based on retention policy
async function pruneSnapshots() {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - backupConfig.retentionDays);
  let deleted = 0;

  // Prune registry snapshots
  const registrySnapshots = await listSnapshots('registry');
  for (const snap of registrySnapshots) {
    if (new Date(snap.lastModified) < cutoff) {
      await s3Client.send(new DeleteObjectCommand({
        Bucket: backupConfig.bucket,
        Key: snap.key,
      }));
      deleted++;
    }
  }

  // Prune church snapshots
  const churches = Database.listChurches();
  for (const church of churches) {
    const snapshots = await listSnapshots(church.church_id);
    for (const snap of snapshots) {
      if (new Date(snap.lastModified) < cutoff) {
        await s3Client.send(new DeleteObjectCommand({
          Bucket: backupConfig.bucket,
          Key: snap.key,
        }));
        deleted++;
      }
    }
  }

  return { deleted, cutoffDate: cutoff.toISOString() };
}

// Start scheduled backups
function startSchedule() {
  if (cronJob) {
    cronJob.stop();
  }

  if (!isConfigured()) {
    console.log('Backup: S3 not configured, skipping schedule setup');
    return false;
  }

  if (!cron.validate(backupConfig.schedule)) {
    console.error(`Backup: Invalid cron schedule: ${backupConfig.schedule}`);
    return false;
  }

  cronJob = cron.schedule(backupConfig.schedule, async () => {
    console.log('Backup: Starting scheduled backup...');
    try {
      const results = await backupAll();
      console.log(`Backup: Completed in ${results.duration}ms. ` +
        `${results.churches.length} churches, ${results.errors.length} errors.`);

      // Prune old snapshots after backup
      const pruneResult = await pruneSnapshots();
      if (pruneResult.deleted > 0) {
        console.log(`Backup: Pruned ${pruneResult.deleted} old snapshots.`);
      }
    } catch (err) {
      console.error('Backup: Scheduled backup failed:', err.message);
    }
  });

  console.log(`Backup: Scheduled with cron "${backupConfig.schedule}"`);
  return true;
}

function stopSchedule() {
  if (cronJob) {
    cronJob.stop();
    cronJob = null;
  }
}

function getStatus() {
  return {
    configured: isConfigured(),
    endpoint: backupConfig?.endpoint || null,
    bucket: backupConfig?.bucket || null,
    region: backupConfig?.region || null,
    prefix: backupConfig?.prefix || null,
    retentionDays: backupConfig?.retentionDays || null,
    schedule: backupConfig?.schedule || null,
    schedulerRunning: !!cronJob,
    lastBackup: lastBackupResult,
  };
}

// Test S3 connection
async function testConnection() {
  await s3Client.send(new ListObjectsV2Command({
    Bucket: backupConfig.bucket,
    Prefix: backupConfig.prefix,
    MaxKeys: 1,
  }));
  return true;
}

module.exports = {
  configure,
  loadConfigFromEnv,
  isConfigured,
  backupChurch,
  backupRegistry,
  backupAll,
  listSnapshots,
  restoreChurch,
  pruneSnapshots,
  startSchedule,
  stopSchedule,
  getStatus,
  testConnection,
};
