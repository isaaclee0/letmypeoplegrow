const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('../config/database');

/**
 * Runs `fn` inside a freshly created, fully-schema'd, disposable church
 * database — real SQLite via the same `Database` class production code
 * uses, but backed by a brand-new `os.tmpdir()` subdirectory that is deleted
 * afterward. Returns (or rethrows) whatever `fn` returns/throws.
 *
 * SAFETY: This always points `Database` at a freshly created
 * `fs.mkdtempSync(os.tmpdir() + '/lmpg-test-')` directory by overriding
 * `process.env.CHURCH_DATA_DIR` before calling `Database.initialize()`.
 * It must NEVER be pointed at a real/shared data directory. Do not remove
 * or "simplify away" the mkdtempSync call — it is the only thing standing
 * between this harness and the real per-church SQLite files under the
 * running server's data directory.
 *
 * Each call:
 *   1. Creates a unique temp dir and a unique churchId (so sequential calls
 *      within the same test process never collide, even though
 *      `Database`'s internal `churchDbs` map is a process-wide singleton).
 *   2. Re-initializes `Database` against that temp dir (`Database.dataDir`
 *      is a module-level variable only ever set inside `initialize()`, and
 *      it reads `process.env.CHURCH_DATA_DIR` fresh every time it's called
 *      — see server/config/database.js `initialize()` — so re-calling it
 *      re-points the singleton at the new temp dir).
 *   3. Creates the church database (schema applied automatically for a new
 *      church id — see the `isNew` branch in `getChurchDb()`).
 *   4. Runs `fn(churchId)` inside `Database.setChurchContext(churchId, ...)`
 *      so any `Database.query(...)` call made by code under test resolves
 *      to this disposable database.
 *   5. In a `finally` block, closes the SQLite handle and deletes the temp
 *      directory recursively, regardless of whether `fn` threw.
 *
 * @param {(churchId: string) => any} fn - work to run against the fresh DB.
 * @param {(info: { churchId: string, tempDir: string }) => void} [onReady] -
 *   INTERNAL: exists solely for `testChurchDb.smoke.test.js` to assert on
 *   the harness's own cleanup behavior (e.g. that `tempDir` really gets
 *   deleted afterward). Real feature tests (e.g. a future `apply.test.js`
 *   DB-integration suite) should never need this — seed data and call
 *   code-under-test from inside `fn`, where the church context is already
 *   active. Note `onReady` fires BEFORE `Database.setChurchContext` is
 *   entered, so calling `Database.query(...)` from inside `onReady` will
 *   throw "No church context set" — it's not a place to run test logic,
 *   only to observe `{ churchId, tempDir }`.
 * @returns {Promise<any>} whatever `fn` returned.
 *
 * KNOWN LIMITATION: `Database`'s module-level `dataDir` (and its singleton
 * registry-db connection) are process-wide, not per-call. Concurrent/
 * overlapping calls to `withTestChurchDb` (e.g. two calls running via
 * Promise.all instead of sequential awaits) can race and point at the
 * wrong temp dir. Only sequential (awaited one-at-a-time) use is supported.
 */
async function withTestChurchDb(fn, onReady) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lmpg-test-'));

  // Belt-and-braces guard: never let this run against a real data directory.
  if (tempDir === '/app/data' || tempDir.startsWith('/app/data/')) {
    throw new Error('Refusing to run test church DB against /app/data');
  }

  const churchId = `test_${Date.now()}_${Math.random().toString(36).slice(2)}`;
  const previousChurchDataDir = process.env.CHURCH_DATA_DIR;

  process.env.CHURCH_DATA_DIR = tempDir;
  try {
    Database.initialize();
    // Explicitly create (rather than rely on an implicit first Database.query)
    // so the schema is applied deterministically before fn runs.
    Database.getChurchDb(churchId);

    if (typeof onReady === 'function') {
      onReady({ churchId, tempDir });
    }

    return await Database.setChurchContext(churchId, () => fn(churchId));
  } finally {
    // closeAll() rather than closeChurchDb(churchId): this harness is
    // sequential-only (see KNOWN LIMITATION above), so at most one church
    // DB is ever open at a time here — closeAll() is equivalent for that
    // one connection, but it also closes and nulls out the singleton
    // `registryDb` connection that `Database.initialize()` opens fresh on
    // every call (see database.js:574-583), which `closeChurchDb` alone
    // would otherwise leak on every `withTestChurchDb` call.
    Database.closeAll();
    fs.rmSync(tempDir, { recursive: true, force: true });

    if (previousChurchDataDir === undefined) {
      delete process.env.CHURCH_DATA_DIR;
    } else {
      process.env.CHURCH_DATA_DIR = previousChurchDataDir;
    }
  }
}

module.exports = { withTestChurchDb };
