const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Sqlite = require('better-sqlite3');
const { restoreChurchDatabase } = require('./restoreDatabase');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'restore-test-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { dir, source: path.join(dir, 'source.sqlite'), destination: path.join(dir, 'destination.sqlite') };
}

test('restore removes OAuth and legacy tokens, preserves data and API keys, and leaves source intact including WAL', async (t) => {
  const { source, destination } = fixture(t);
  const db = new Sqlite(source);
  t.after(() => db.close());
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE integration_connections (provider TEXT, auth_type TEXT, credential_ciphertext TEXT);
    INSERT INTO integration_connections VALUES ('planning_center', 'oauth', 'encrypted-token'), ('elvanto', 'api_key', 'api-key');
    CREATE TABLE user_preferences (preference_key TEXT, preference_value TEXT);
    INSERT INTO user_preferences VALUES ('planning_center_tokens', 'legacy-token'), ('theme', 'dark');
    CREATE TABLE individuals (id INTEGER, planning_center_id TEXT);
    INSERT INTO individuals VALUES (1, 'pco-123');
    CREATE TABLE people_sync_settings (authority_provider TEXT);
    INSERT INTO people_sync_settings VALUES ('planning_center');
  `);
  await restoreChurchDatabase(source, destination);
  const restored = new Sqlite(destination);
  try {
    assert.deepEqual(restored.prepare('SELECT * FROM integration_connections').all(), [{ provider: 'elvanto', auth_type: 'api_key', credential_ciphertext: 'api-key' }]);
    assert.deepEqual(restored.prepare('SELECT * FROM user_preferences').all(), [{ preference_key: 'theme', preference_value: 'dark' }]);
    assert.deepEqual(restored.prepare('SELECT * FROM individuals').all(), [{ id: 1, planning_center_id: 'pco-123' }]);
    assert.equal(restored.prepare('SELECT authority_provider FROM people_sync_settings').get().authority_provider, 'planning_center');
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM integration_connections').get().n, 2);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM user_preferences').get().n, 2);
  } finally { restored.close(); }
});

for (const legacy of [false, true]) {
  test(`restores older backup without integration tables (legacy tokens: ${legacy})`, async (t) => {
    const { source, destination } = fixture(t);
    const db = new Sqlite(source);
    db.exec('CREATE TABLE individuals (id INTEGER); INSERT INTO individuals VALUES (42)');
    if (legacy) db.exec("CREATE TABLE user_preferences (preference_key TEXT); INSERT INTO user_preferences VALUES ('planning_center_tokens')");
    db.close();
    await restoreChurchDatabase(source, destination);
    const restored = new Sqlite(destination);
    try {
      assert.equal(restored.prepare('SELECT id FROM individuals').get().id, 42);
      if (legacy) assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM user_preferences').get().n, 0);
    } finally { restored.close(); }
  });
}

test('sanitization failure leaves existing destination untouched and cleans staging files', async (t) => {
  const { dir, source, destination } = fixture(t);
  const db = new Sqlite(source);
  db.exec('CREATE TABLE integration_connections (unexpected_column TEXT)');
  db.close();
  fs.writeFileSync(destination, 'existing destination');
  await assert.rejects(restoreChurchDatabase(source, destination));
  assert.equal(fs.readFileSync(destination, 'utf8'), 'existing destination');
  assert.deepEqual(fs.readdirSync(dir).sort(), ['destination.sqlite', 'source.sqlite']);
});

test('sanitizes a downloaded snapshot in place before cloud restore installs it', async (t) => {
  const { source } = fixture(t);
  const db = new Sqlite(source);
  db.exec(`CREATE TABLE integration_connections (auth_type TEXT, credential_ciphertext TEXT);
    INSERT INTO integration_connections VALUES ('oauth', 'old-token');
    CREATE TABLE individuals (id INTEGER); INSERT INTO individuals VALUES (7);`);
  db.close();
  await restoreChurchDatabase(source, source);
  const restored = new Sqlite(source);
  try {
    assert.equal(restored.prepare('SELECT COUNT(*) AS n FROM integration_connections').get().n, 0);
    assert.equal(restored.prepare('SELECT id FROM individuals').get().id, 7);
  } finally { restored.close(); }
});
