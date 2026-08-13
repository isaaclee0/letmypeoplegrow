const { test } = require('node:test');
const assert = require('node:assert/strict');
const takeoutRouter = require('./takeout');

test('data export filename uses the church-local calendar date', () => {
  assert.equal(
    takeoutRouter.exportFilename('Australia/Hobart', new Date('2026-08-13T14:30:00Z')),
    'church-data-export-2026-08-14.zip',
  );
});
