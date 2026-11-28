const { test } = require('node:test');
const assert = require('node:assert/strict');
const { once } = require('node:events');
const express = require('express');
const { sanitizeInput } = require('./security');

test('routes receive sanitized query values and retain bracket-array parameters', async (t) => {
  const app = express();
  app.set('query parser', 'extended');
  app.use(sanitizeInput);
  app.get('/search', (req, res) => res.json(req.query));

  const server = app.listen(0, '127.0.0.1');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  await once(server, 'listening');

  const query = new URLSearchParams([
    ['q', "  <em>O'Brien</em>  "],
    ['ids[]', '1'],
    ['ids[]', '2'],
    ['filters[city]', '<b>Hobart</b>'],
  ]);
  const response = await fetch(`http://127.0.0.1:${server.address().port}/search?${query}`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    q: "O'Brien",
    ids: ['1', '2'],
    filters: { city: 'Hobart' },
  });
});
