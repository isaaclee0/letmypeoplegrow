# Migrate MariaDB data to per-church SQLite

This guide migrates an existing MariaDB database (single-tenant or multi-tenant by `church_id`) into the new structure: one SQLite file per church plus a registry.

## Architecture

After migration the application uses:

- `server/data/registry.sqlite` — maps emails/phones to church IDs for login routing
- `server/data/churches/{church_id}.sqlite` — one database per church with all its data

MariaDB is no longer required. The `db` and `phpmyadmin` Docker services have been removed.

## 1. Put your MariaDB dump in place

Place your `.sql` dump in the `sqldumps` folder (create it if needed), for example:

- `sqldumps/backup.sql`
- or use an existing dump like `database/dev_database_backup.sql`

## 2. Start a temporary MariaDB and restore the dump (Docker)

From the **project root**:

```bash
docker run -d --name mariadb_migrate \
  -p 3307:3306 \
  -e MYSQL_ROOT_PASSWORD=root \
  -e MYSQL_DATABASE=church_attendance \
  mariadb:10.6

sleep 10

docker exec -i mariadb_migrate mariadb -u root -proot church_attendance < sqldumps/backup.sql
```

## 3. Run the migration script

### Option A: From host (recommended)

```bash
cd server
DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root DB_NAME=church_attendance \
  node scripts/migrate-mariadb-to-sqlite.js
```

Or with `npm run`:

```bash
cd server
DB_HOST=127.0.0.1 DB_PORT=3307 DB_USER=root DB_PASSWORD=root DB_NAME=church_attendance \
  npm run migrate:mariadb
```

Output is written to:

- `server/data/registry.sqlite` (registry: churches + user lookup for login)
- `server/data/churches/{church_id}.sqlite` (one file per church)

If your MariaDB has no `church_id` column (single-tenant), the script uses a single default church ID (`devch1` unless you set `MIGRATION_DEFAULT_CHURCH_ID`).

### Option B: From Docker (using server container)

```bash
docker-compose -f docker-compose.dev.yml run --rm \
  -e DB_HOST=host.docker.internal \
  -e DB_PORT=3307 \
  -e DB_USER=root \
  -e DB_PASSWORD=root \
  -e DB_NAME=church_attendance \
  server node scripts/migrate-mariadb-to-sqlite.js
```

On Linux you may need to use the MariaDB container's name and the dev network instead of `host.docker.internal`.

The script writes to `/app/data` in the container, which is the `server_data_dev` volume.

## 4. Stop the temporary MariaDB

```bash
docker stop mariadb_migrate && docker rm mariadb_migrate
```

## 5. Start the app

```bash
docker-compose -f docker-compose.dev.yml up -d
```

## Environment variables for the migration script

| Variable | Description |
|----------|-------------|
| `DB_HOST` | MariaDB host (default: localhost) |
| `DB_PORT` | MariaDB port (default: 3306) |
| `DB_USER` | MariaDB user |
| `DB_PASSWORD` | MariaDB password |
| `DB_NAME` | MariaDB database name (default: church_attendance) |
| `CHURCH_DATA_DIR` or `DATA_DIR` | Output directory for registry and churches (default: server/data) |
| `MIGRATION_DEFAULT_CHURCH_ID` | Church ID when source has no church_id (default: devch1) |

## Fresh start (no migration)

If you don't have existing data and want to start fresh, just start the app. The SQLite databases are created automatically on first run:

```bash
docker-compose -f docker-compose.dev.yml up -d
```

The first user registration or dev-bypass login will create the church database.

## Notes

- **Column mapping**: Only columns that exist in both the MariaDB source and the SQLite schema are copied. MariaDB-specific columns not in the SQLite schema are silently skipped.
- **Multi-tenant**: If your MariaDB has a `church_id` column on `users`, the script creates one SQLite file per distinct `church_id` and populates the registry accordingly.
- **Single-tenant**: If there is no `church_id`, all data is migrated into one church (default ID: `devch1`).
- **Idempotent**: Running the script again will overwrite existing SQLite files.
- **Backups**: SQLite databases are regular files. Back up by copying the `data/` directory.
