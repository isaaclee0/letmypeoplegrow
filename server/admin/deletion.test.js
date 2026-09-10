const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const Database = require('../config/database');
const { withTestChurchDb } = require('../test-helpers/testChurchDb');

// Run the actual route bodies without starting the admin listener or backup jobs.
function route(method, url) {
  const source = fs.readFileSync(path.join(__dirname, 'index.js'), 'utf8');
  const start = source.indexOf(`app.${method}('${url}'`);
  const end = source.indexOf('\n});', start) + 4;
  let handler;
  vm.runInNewContext(source.slice(start, end), {
    app: { [method]: (_url, callback) => { handler = callback; } },
    Database, fs, path, process, __dirname, console,
  });
  return async (params, query = {}, body = {}) => {
    const response = { statusCode: 200, status(code) { this.statusCode = code; return this; }, json(data) { this.body = data; return this; } };
    await handler({ params, query, body }, response);
    return response;
  };
}

async function fixtures(fn) {
  await withTestChurchDb(async (first) => {
    const second = `${first}_other`;
    Database.ensureChurch(first, 'A Church');
    Database.ensureChurch(second, 'B Church');
    for (const churchId of [first, second]) {
      await Database.queryForChurch(churchId, `INSERT INTO users (id, email, first_name, last_name, role, church_id) VALUES (1, 'same@example.com', 'Test', 'User', 'admin', ?)`, [churchId]);
      Database.registerUserLookup(1, 'same@example.com', null, churchId);
    }
    await fn(first, second);
  });
}
const user = async (churchId) => (await Database.queryForChurch(churchId, 'SELECT * FROM users WHERE id = 1'))[0];

test('hard deletion targets the specified organisation and removes only its lookup', async () => {
  await fixtures(async (first, second) => {
    const response = await route('delete', '/api/users/:userId')({ userId: '1' }, { hard: 'true', churchId: second });
    assert.equal(response.statusCode, 200);
    assert.ok(await user(first));
    assert.equal(await user(second), undefined);
    assert.deepEqual(Database.lookupAllChurchesByEmail('same@example.com').map(x => x.church_id), [first]);
  });
});

test('missing or unknown organisation never falls back to another user', async () => {
  await fixtures(async (first, second) => {
    const remove = route('delete', '/api/users/:userId');
    assert.equal((await remove({ userId: '1' }, { hard: 'true' })).statusCode, 400);
    assert.equal((await remove({ userId: '1' }, { hard: 'true', churchId: 'missing' })).statusCode, 404);
    assert.ok(await user(first)); assert.ok(await user(second));
  });
});

test('deactivate and reactivate affect only the selected organisation', async () => {
  await fixtures(async (first, second) => {
    await route('delete', '/api/users/:userId')({ userId: '1' }, { churchId: second });
    assert.equal((await user(first)).is_active, 1);
    assert.equal((await user(second)).is_active, 0);
    await Database.queryForChurch(first, 'UPDATE users SET is_active = 0 WHERE id = 1');
    assert.equal((await route('post', '/api/users/:userId/reactivate')({ userId: '1' }, { churchId: second })).statusCode, 200);
    assert.equal((await user(first)).is_active, 0);
    assert.equal((await user(second)).is_active, 1);
  });
});

test('permanent deletion preserves attendance history and explains deactivation', async () => {
  await fixtures(async (first) => {
    const db = Database.getChurchDb(first);
    db.prepare("INSERT INTO gathering_types (id, name, church_id) VALUES (1, 'Sunday', ?)").run(first);
    db.prepare("INSERT INTO attendance_sessions (gathering_type_id, session_date, created_by, church_id) VALUES (1, '2026-09-11', 1, ?)").run(first);
    const response = await route('delete', '/api/users/:userId')({ userId: '1' }, { hard: 'true', churchId: first });
    assert.equal(response.statusCode, 409);
    assert.match(response.body.error, /deactivate/i);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM attendance_sessions').get().n, 1);
    assert.ok(await user(first));
    assert.equal(Database.lookupAllChurchesByEmail('same@example.com').length, 2);
  });
});

test('church deletion requires confirmation and preserves the other organisation', async () => {
  await fixtures(async (first, second) => {
    const remove = route('delete', '/api/churches/:churchId');
    assert.equal((await remove({ churchId: second }, {}, { confirmChurchId: first })).statusCode, 400);
    assert.ok(await user(second));
    assert.equal((await remove({ churchId: second }, {}, { confirmChurchId: second })).statusCode, 200);
    assert.ok(await user(first));
    assert.equal(Database.listChurches().some(x => x.church_id === second), false);
    assert.deepEqual(Database.lookupAllChurchesByEmail('same@example.com').map(x => x.church_id), [first]);
    assert.equal(fs.existsSync(path.join(process.env.CHURCH_DATA_DIR, 'churches', `${second}.sqlite`)), false);
    assert.equal((await remove({ churchId: 'missing' }, {}, { confirmChurchId: 'missing' })).statusCode, 404);
  });
});

test('admin UI includes organisation in both user action requests', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const start = source.indexOf('    async function deleteUser(');
  const end = source.indexOf('\n    async function ', source.indexOf('    async function reactivateUser(', start) + 5);
  const requests = [];
  const context = { document: { querySelector: () => null }, confirm: () => true, alert: () => {}, loadAllUsers: () => {}, loadActiveUsers: () => {}, loadStats: () => {}, usersPage: 1,
    fetch: async (url) => { requests.push(url); return { ok: true, json: async () => ({}) }; } };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  await context.deleteUser(1, 'same@example.com', true, 'selected_church');
  await context.reactivateUser(1, 'same@example.com', 'selected_church');
  for (const url of requests) assert.equal(new URL(url, 'http://example.com').searchParams.get('churchId'), 'selected_church');
  assert.equal(requests.length, 2);
});

test('failed account deletion rolls back contact changes and login cleanup', async () => {
  await fixtures(async (first) => {
    const db = Database.getChurchDb(first);
    db.prepare("INSERT INTO contacts (first_name, last_name, created_by, church_id) VALUES ('Contact', 'One', 1, ?)").run(first);
    db.exec("CREATE TRIGGER refuse_user_delete BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const response = await route('delete', '/api/users/:userId')({ userId: '1' }, { hard: 'true', churchId: first });
    assert.equal(response.statusCode, 500);
    assert.ok(await user(first));
    assert.equal(db.prepare('SELECT created_by FROM contacts').get().created_by, 1);
    assert.equal(Database.lookupAllChurchesByEmail('same@example.com').length, 2);
    assert.equal(db.prepare('PRAGMA database_list').all().some(x => x.name === 'admin_registry'), false);
  });
});

test('permanent deletion clears old codes and invitations only in selected organisation', async () => {
  await fixtures(async (first, second) => {
    for (const churchId of [first, second]) {
      const db = Database.getChurchDb(churchId);
      db.prepare(`INSERT INTO otc_codes (contact_identifier, contact_type, code, expires_at, church_id)
        VALUES ('same@example.com', 'email', '123456', '2099-01-01', ?)`).run(churchId);
      db.prepare(`INSERT INTO user_invitations (email, first_name, last_name, role, invited_by, invitation_token, expires_at, church_id)
        VALUES ('same@example.com', 'Test', 'User', 'admin', 1, 'token', '2099-01-01', ?)`).run(churchId);
    }
    assert.equal((await route('delete', '/api/users/:userId')({ userId: '1' }, { hard: 'true', churchId: second })).statusCode, 200);
    for (const table of ['otc_codes', 'user_invitations']) {
      assert.equal(Database.getChurchDb(first).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 1);
      assert.equal(Database.getChurchDb(second).prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n, 0);
    }
  });
});

test('failed church registry removal restores its database and registry records', async () => {
  await fixtures(async (first, second) => {
    Database.getRegistryDb().exec("CREATE TRIGGER refuse_church_delete BEFORE DELETE ON churches BEGIN SELECT RAISE(ABORT, 'test failure'); END");
    const response = await route('delete', '/api/churches/:churchId')({ churchId: second }, {}, { confirmChurchId: second });
    assert.equal(response.statusCode, 500);
    assert.ok(await user(first)); assert.ok(await user(second));
    assert.equal(Database.listChurches().length, 2);
    assert.equal(Database.lookupAllChurchesByEmail('same@example.com').length, 2);
    const files = fs.readdirSync(path.join(process.env.CHURCH_DATA_DIR, 'churches'));
    assert.equal(files.some(x => x.includes('.deleting-')), false);
  });
});

test('rendered buttons target the row organisation in the list and details modal', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const users = [
    { id: 1, email: 'same@example.com', church_id: 'first', is_active: 1 },
    { id: 1, email: 'same@example.com', church_id: 'second', is_active: 0 },
  ];
  const table = {};
  let modal = '';
  const calls = [];
  const context = {
    fetchJSON: async (url) => url.startsWith('/api/users')
      ? { users, pagination: { pages: 1, total: 2 } }
      : { users, gatherings: [], recent_sessions: [] },
    document: { getElementById: () => table, body: { insertAdjacentHTML: (_position, html) => { modal = html; } } },
    escapeHtml: String, escapeJsAttr: String, formatDate: () => '', formatRelative: () => '',
    alert: (error) => { throw new Error(error); }, closeModal: () => {},
    deleteUser: (...args) => { calls.push(args); }, reactivateUser: (...args) => { calls.push(args); },
  };
  vm.createContext(context);
  for (const [name, next] of [['loadAllUsers', '// Load audit log'], ['viewChurchDetails', '// Close modal']]) {
    const start = source.indexOf(`    async function ${name}(`);
    vm.runInContext(source.slice(start, source.indexOf(next, start)), context);
  }
  await context.loadAllUsers();
  for (const match of table.innerHTML.matchAll(/onclick="((?:deleteUser|reactivateUser)[^"]+)"/g)) vm.runInContext(match[1], context);
  assert.deepEqual(calls.map(args => args.at(-1)), ['first', 'first', 'second', 'second']);
  calls.length = 0;
  await context.viewChurchDetails('selected');
  // The user action itself must carry the modal organisation even without a church_id in each returned user.
  for (const match of modal.matchAll(/onclick="((?:deleteUser|reactivateUser)[^;"\n]+)[^"]*"/g)) vm.runInContext(match[1], context);
  assert.deepEqual(calls.map(args => args.at(-1)), ['selected', 'selected']);
});

test('invalid user identifiers and missing users cannot mutate another account', async () => {
  await fixtures(async (first, second) => {
    for (const [method, url] of [['delete', '/api/users/:userId'], ['post', '/api/users/:userId/reactivate']]) {
      const action = route(method, url);
      for (const userId of ['0', '-1', '1oops', '9007199254740993']) {
        assert.equal((await action({ userId }, { churchId: second, hard: 'true' })).statusCode, 400);
      }
      assert.equal((await action({ userId: '99' }, { churchId: second, hard: 'true' })).statusCode, 404);
    }
    assert.ok(await user(first)); assert.ok(await user(second));
  });
});

test('user actions refresh open details only after successful completion', async () => {
  const source = fs.readFileSync(path.join(__dirname, 'public/index.html'), 'utf8');
  const start = source.indexOf('    async function deleteUser(');
  const end = source.indexOf('\n    async function ', source.indexOf('    async function reactivateUser(', start) + 5);
  let finish;
  const refreshed = [];
  const context = { document: { querySelector: () => null }, confirm: () => true, alert: () => {}, loadAllUsers: () => {}, loadActiveUsers: () => {}, loadStats: () => {}, usersPage: 1,
    document: { querySelector: () => ({}) }, closeModal: () => {}, viewChurchDetails: async (id) => refreshed.push(id),
    fetch: () => new Promise(resolve => { finish = resolve; }),
  };
  vm.createContext(context);
  vm.runInContext(source.slice(start, end), context);
  const pending = context.deleteUser(1, 'same@example.com', false, 'selected');
  assert.deepEqual(refreshed, []);
  finish({ ok: true, json: async () => ({}) });
  await pending;
  assert.deepEqual(refreshed, ['selected']);
  const failed = context.reactivateUser(1, 'same@example.com', 'selected');
  finish({ ok: false, json: async () => ({ error: 'Failed' }) });
  await failed;
  assert.deepEqual(refreshed, ['selected']);
});
