# Move Pilgrim Hill out of Redeemer (2.3.4)

This is a **manual, one-time maintenance operation**. Shipping or starting 2.3.4 does not run it. Do not add it to startup or automated schema migrations.

## Scope

The script requires an explicitly supplied Redeemer church ID and a new Pilgrim Hill ID. It verifies the source is named `Redeemer Christian Church`, then finds these gatherings by name (accepting the existing `Festivall` typo):

- 2025 Pilgrim Artists Festival – Hub
- 2025 Pilgrim Artists Festival – Hall

It moves their sessions, headcounts, attributable audit history, gathering assignments and invitations. Peirce Baehr, Miriam Kewley and Naomi Kewley move entirely to Pilgrim Hill, keeping their current roles. Isaac Lee stays an admin in Redeemer and is added as an admin in Pilgrim Hill; his church-switch identity is linked. Original row IDs, dates and attribution are retained.

Member/family records and other Redeemer gatherings remain in Redeemer. The new church gets the same timezone and country, with fresh default settings; integration credentials, unrelated account preferences, conversations and email configuration are not copied. Automated weekly review emails start disabled. Only the two reviewed attendance preferences are eligible to move.

If an account now has other responsibilities, an unreviewed dependency is found, identities are ambiguous, a roster is attached, or Pilgrim Hill already exists, the operation **stops**. Do not bypass a refusal by deleting records or changing IDs; investigate the new dependency and review the script first.

## Prepare the installed release

Use your actual production Compose file/project and image deployment procedure. The examples below use this repository's `docker-compose.yml`. Run from the deployed checkout, with its normal Compose environment available. The server image must contain 2.3.4; `Dockerfile.server` already includes `server/scripts`.

Inspect available churches read-only:

```sh
docker compose -f docker-compose.yml run --rm --no-deps --entrypoint node server -e 'const D=require("better-sqlite3"); const d=new D("/app/data/registry.sqlite",{readonly:true}); console.table(d.prepare("SELECT church_id, church_name FROM churches ORDER BY church_name").all());'
```

Set `REDEEMER_ID` to the verified live ID from that output. Do **not** assume Dev and live IDs match. Generate a new target ID once and keep it unchanged between rehearsal and apply:

```sh
export REDEEMER_ID='the-verified-live-redeemer-id'
export PILGRIM_ID="pil_$(openssl rand -hex 6)"
```

## Rehearse

```sh
docker compose -f docker-compose.yml run --rm --no-deps --entrypoint node server \
  scripts/split-pilgrim-hill.js \
  --data-dir /app/data --source "$REDEEMER_ID" --target "$PILGRIM_ID"
```

The default is a full rehearsal on copies. It does not change live church rows or login routing. It writes a private `pilgrim-split-*` directory under the data directory with two SQLite backups, `plan.json`, rehearsal databases, and `completed.json` if verification passes. Backups contain private data: keep them out of source control, preserve their restricted permissions, and retain them under your normal backup policy.

Review the printed identities, gathering IDs, roles, session count, headcount count and sum. The original Dev baseline was **26 sessions, 24 headcount entries, sum 482 and 44 audit entries**. Live counts may differ: the script derives them from live data and verifies every selected row, rather than assuming that baseline. The sum is a sum of recorded counts, not unique attendees.

## Apply during maintenance

Stop **all** application replicas, workers, admin services, schedulers and other database writers sharing this volume. These example commands stop the two writers defined by this repository; stop any additional services in your deployment as well. `--maintenance-confirmed` acknowledges this prerequisite; it does not stop services for you.

```sh
docker compose -f docker-compose.yml stop server admin

docker compose -f docker-compose.yml run --rm --no-deps --entrypoint node server \
  scripts/split-pilgrim-hill.js \
  --data-dir /app/data --source "$REDEEMER_ID" --target "$PILGRIM_ID" \
  --apply --maintenance-confirmed
```

Apply takes **fresh backups** and validates the actual data again. It refuses changes between backup and transaction. It uses SQLite rollback journals with full synchronization for a crash-atomic transaction across the source, destination and registry on the same filesystem. The databases must be on a local filesystem supporting SQLite locking and durable writes, not a network share. The app restores its normal WAL mode when it opens them again.

Success prints `"mode": "apply"` and writes `completed.json` in the reported backup directory. All source tables are compared against the expected remainder; moved rows are compared to originals; foreign-key and integrity checks run before commit. If an ordinary error occurs before commit, changes roll back and the unpublished target file is removed. The operation refuses repeat runs rather than duplicating data.

After success:

```sh
docker compose -f docker-compose.yml start server admin
```

Sign in as Isaac, verify switching between Redeemer and Pilgrim Hill, inspect festival history (including other users' counts), and verify the three moved accounts route only to Pilgrim Hill. Production uses its normal verification flow. Restarting all writers also clears stale in-memory church/auth state.

## Failure and recovery

Keep services stopped until the outcome is known. `plan.json` identifies the source, target and backup hashes. `completed.json` records success. A process crash can leave an unpublished empty target file: **do not simply rerun with another ID**. Inspect both church databases and registry first; SQLite may need to recover its journals when opened. A `SPLIT COMMITTED` reporting error means data committed but writing the report failed; do not rerun.

To revert a completed split, while every writer is stopped:

1. Preserve copies of the current source, target, registry and their journal/WAL files for diagnosis.
2. Verify both `*-before.sqlite` backups match the SHA-256 hashes in `plan.json`.
3. Restore `redeemer-before.sqlite` to `churches/<sourceId>.sqlite` and `registry-before.sqlite` to `registry.sqlite`. Clear obsolete `-wal`, `-shm` and `-journal` sidecars for those restored paths only, so newer sidecars cannot replay into restored backups.
4. Remove the new `churches/<targetId>.sqlite` and its sidecars from the active directory after preserving them.
5. Run SQLite integrity and foreign-key checks, then restart all writers and verify Redeemer login and festival history.

Restoring the registry rolls back **all registry changes since that backup**. If services resumed and new activity occurred, stop and reconcile that activity before restoring; do not blindly restore an older backup.

## Tests

```sh
cd server
node --test scripts/split-pilgrim-hill.test.js
```

Tests use temporary SQLite databases and never contact production. Release verification additionally rehearsed both modes on temporary copies of the original pre-split Dev backup.
