const { test } = require('node:test');
const assert = require('node:assert/strict');

const {
  createElvantoClient,
  serializeQueryParams,
  ElvantoError,
  ELVANTO_AUTH,
  ELVANTO_UNAVAILABLE,
  ELVANTO_RESPONSE,
  ELVANTO_PAGINATION,
} = require('./httpClient');

function basicAuthFor(apiKey) {
  return `Basic ${Buffer.from(`${apiKey}:x`).toString('base64')}`;
}

function okPeoplePage({ page = 1, perPage = 1000, total = 1, person = { id: 'p1' } } = {}) {
  return { status: 200, data: { status: 'ok', people: { page, per_page: perPage, total, person } } };
}

// ─── Production transport serialization ─────────────────────────────────────

test('production transport serializes array params as repeated fields in insertion order', () => {
  const query = serializeQueryParams({
    'fields[]': ['firstname', 'lastname', 'email'],
    page: 2,
    page_size: 100,
    search: 'Ada Lovelace',
    omittedNull: null,
    omittedUndefined: undefined,
    omittedEmptyArray: [],
  });

  assert.equal(
    query,
    'fields%5B%5D=firstname&fields%5B%5D=lastname&fields%5B%5D=email&page=2&page_size=100&search=Ada+Lovelace'
  );
});

// ─── Auth header ────────────────────────────────────────────────────────────

test('get() sends HTTP Basic auth with the API key as username and "x" as password', async () => {
  let seenHeaders;
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ headers }) => {
      seenHeaders = headers;
      return { status: 200, data: { status: 'ok' } };
    },
  });

  await client.get('/people/getInfo.json', { id: 'p1' });

  assert.equal(seenHeaders.Authorization, basicAuthFor('key'));
});

// ─── Timeout ────────────────────────────────────────────────────────────────

test('get() passes a sane default timeout through to the injected request', async () => {
  let seenTimeout;
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ timeoutMs }) => {
      seenTimeout = timeoutMs;
      return { status: 200, data: { status: 'ok' } };
    },
  });

  await client.get('/people/getInfo.json', {});

  assert.equal(seenTimeout, 30000);
});

test('createElvantoClient accepts a custom timeoutMs and passes it through', async () => {
  let seenTimeout;
  const client = createElvantoClient({
    apiKey: 'key',
    timeoutMs: 5000,
    request: async ({ timeoutMs }) => {
      seenTimeout = timeoutMs;
      return { status: 200, data: { status: 'ok' } };
    },
  });

  await client.get('/people/getInfo.json', {});

  assert.equal(seenTimeout, 5000);
});

// ─── Happy path ─────────────────────────────────────────────────────────────

test('get() resolves to the parsed response body on success', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 200, data: { status: 'ok', people: { total: 1, person: { id: 'p1' } } } }),
  });

  const result = await client.get('/people/getInfo.json', { id: 'p1' });

  assert.deepEqual(result, { status: 'ok', people: { total: 1, person: { id: 'p1' } } });
});

// ─── Status / body errors ───────────────────────────────────────────────────

test('get() throws ELVANTO_AUTH on a 401 response', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 401, data: { status: 'error' } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.ok(err instanceof ElvantoError);
      assert.equal(err.code, ELVANTO_AUTH);
      return true;
    }
  );
});

test('get() throws ELVANTO_AUTH on a 403 response', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 403, data: { status: 'error' } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_AUTH);
      return true;
    }
  );
});

test('get() throws ELVANTO_UNAVAILABLE on a non-2xx, non-auth status', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 500, data: { status: 'error' } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      return true;
    }
  );
});

test('get() throws ELVANTO_RESPONSE when the body status is not ok', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 200, data: { status: 'error', error: { message: 'Bad request' } } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_RESPONSE);
      assert.match(err.message, /Bad request/);
      return true;
    }
  );
});

test('get() throws ELVANTO_RESPONSE when the body is malformed', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 200, data: 'not-json-object' }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_RESPONSE);
      return true;
    }
  );
});

test('get() throws ELVANTO_UNAVAILABLE when the transport rejects', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => { throw new Error('socket hang up'); },
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      return true;
    }
  );
});

// ─── Secret redaction ───────────────────────────────────────────────────────

test('ElvantoError never leaks a bare base64 auth blob lacking the "Basic " prefix', async () => {
  const apiKey = 'super-secret-key';
  const bareBase64 = Buffer.from(`${apiKey}:x`).toString('base64');
  const client = createElvantoClient({
    apiKey,
    request: async () => { throw new Error(`upstream proxy logged credential ${bareBase64} on the wire`); },
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      assert.ok(!err.message.includes(bareBase64), 'message must not contain the bare base64 auth blob');
      return true;
    }
  );
});

test('ElvantoError never leaks the API key from an underlying transport error message', async () => {
  const apiKey = 'super-secret-key';
  const authHeader = basicAuthFor(apiKey);
  const client = createElvantoClient({
    apiKey,
    request: async () => { throw new Error(`connection refused (sent auth ${authHeader})`); },
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      assert.ok(!err.message.includes(apiKey), 'message must not contain the raw API key');
      assert.ok(!err.message.includes(authHeader), 'message must not contain the Authorization header value');
      assert.ok(!JSON.stringify(err.details).includes(apiKey), 'details must not contain the raw API key');
      return true;
    }
  );
});

test('ElvantoError never leaks the API key echoed back in an Elvanto error body', async () => {
  const apiKey = 'super-secret-key';
  const client = createElvantoClient({
    apiKey,
    request: async () => ({ status: 200, data: { status: 'error', error: { message: `Rejected key ${apiKey}` } } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.equal(err.code, ELVANTO_RESPONSE);
      assert.ok(!err.message.includes(apiKey), 'message must not contain the raw API key');
      return true;
    }
  );
});

test('ElvantoError details never carry the request headers or full response body', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => ({ status: 401, data: { status: 'error', people: { person: { id: 'p1', firstname: 'Secret' } } } }),
  });

  await assert.rejects(
    () => client.get('/people/getAll.json', {}),
    (err) => {
      assert.ok(!('headers' in err.details));
      assert.ok(!('data' in err.details));
      assert.ok(!JSON.stringify(err.details).includes('Secret'));
      return true;
    }
  );
});

// ─── Single-object normalization ────────────────────────────────────────────

test('getAll() normalizes a single-object collection into a one-element array', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ headers }) => {
      assert.equal(headers.Authorization, basicAuthFor('key'));
      return {
        status: 200,
        data: { status: 'ok', people: { page: 1, per_page: 1000, total: 1, person: { id: 'p1' } } },
      };
    },
  });

  const result = await client.getAll('/people/getAll.json', {}, 'people', 'person');

  assert.deepEqual(result.items, [{ id: 'p1' }]);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 1);
  assert.equal(result.total, 1);
});

// ─── Page size ──────────────────────────────────────────────────────────────

test('getAll() defaults to a page_size of 1000 when the caller does not specify one', async () => {
  let seenParams;
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ params }) => {
      seenParams = params;
      return okPeoplePage();
    },
  });

  await client.getAll('/people/getAll.json', {}, 'people', 'person');

  assert.equal(seenParams.page_size, 1000);
});

test('getAll() rejects a page_size below 10', async () => {
  const client = createElvantoClient({ apiKey: 'key', request: async () => okPeoplePage() });

  await assert.rejects(
    () => client.getAll('/people/getAll.json', { page_size: 9 }, 'people', 'person'),
    (err) => {
      assert.equal(err.code, ELVANTO_PAGINATION);
      return true;
    }
  );
});

test('getAll() rejects a page_size above 1000', async () => {
  const client = createElvantoClient({ apiKey: 'key', request: async () => okPeoplePage() });

  await assert.rejects(
    () => client.getAll('/people/getAll.json', { page_size: 1001 }, 'people', 'person'),
    (err) => {
      assert.equal(err.code, ELVANTO_PAGINATION);
      return true;
    }
  );
});

// ─── Termination by total ───────────────────────────────────────────────────

test('getAll() paginates until the cumulative total is reached, then stops', async () => {
  const allPeople = Array.from({ length: 25 }, (_, i) => ({ id: `p${i + 1}` }));
  let callCount = 0;

  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ params }) => {
      callCount += 1;
      const pageSize = 10;
      const start = (params.page - 1) * pageSize;
      const pagePeople = allPeople.slice(start, start + pageSize);
      return {
        status: 200,
        data: {
          status: 'ok',
          people: { page: params.page, per_page: pageSize, total: allPeople.length, person: pagePeople },
        },
      };
    },
  });

  const result = await client.getAll('/people/getAll.json', { page_size: 10 }, 'people', 'person');

  assert.equal(callCount, 3);
  assert.deepEqual(result.items, allPeople);
  assert.equal(result.complete, true);
  assert.equal(result.pages, 3);
  assert.equal(result.total, 25);
});

test('getAll() stops requesting once a page returns fewer items than total with no more pages needed', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async () => okPeoplePage({ total: 1 }),
  });

  const result = await client.getAll('/people/getAll.json', {}, 'people', 'person');

  assert.equal(result.items.length, 1);
  assert.equal(result.pages, 1);
});

// ─── 1000-page cap ──────────────────────────────────────────────────────────

test('getAll() stops after 1000 pages and raises ELVANTO_PAGINATION instead of looping forever', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ params }) => ({
      status: 200,
      data: {
        status: 'ok',
        people: { page: params.page, per_page: 1, total: Number.MAX_SAFE_INTEGER, person: { id: `p${params.page}` } },
      },
    }),
  });

  await assert.rejects(
    () => client.getAll('/people/getAll.json', { page_size: 10 }, 'people', 'person'),
    (err) => {
      assert.equal(err.code, ELVANTO_PAGINATION);
      return true;
    }
  );
});

// ─── Abort on partial-page failure ──────────────────────────────────────────

test('getAll() aborts on a partial-page failure and never resolves with accumulated partial items', async () => {
  let call = 0;
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ params }) => {
      call += 1;
      if (params.page === 1) {
        return {
          status: 200,
          data: { status: 'ok', people: { page: 1, per_page: 1, total: 2, person: { id: 'p1' } } },
        };
      }
      throw new Error('network blip');
    },
  });

  await assert.rejects(
    () => client.getAll('/people/getAll.json', { page_size: 10 }, 'people', 'person'),
    (err) => {
      assert.equal(err.code, ELVANTO_UNAVAILABLE);
      return true;
    }
  );
  assert.equal(call, 2);
});

test('getAll() aborts when a later page reports a bad body status, never resolving with partial items', async () => {
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ params }) => {
      if (params.page === 1) {
        return {
          status: 200,
          data: { status: 'ok', people: { page: 1, per_page: 1, total: 2, person: { id: 'p1' } } },
        };
      }
      return { status: 200, data: { status: 'error', error: { message: 'server error' } } };
    },
  });

  await assert.rejects(
    () => client.getAll('/people/getAll.json', { page_size: 10 }, 'people', 'person'),
    (err) => {
      assert.equal(err.code, ELVANTO_RESPONSE);
      return true;
    }
  );
});

// ─── post() ─────────────────────────────────────────────────────────────────

test('post() sends the body with method POST and returns the parsed response', async () => {
  let seenBody;
  let seenMethod;
  const client = createElvantoClient({
    apiKey: 'key',
    request: async ({ method, body }) => {
      seenMethod = method;
      seenBody = body;
      return { status: 200, data: { status: 'ok', people: { total: 0 } } };
    },
  });

  const result = await client.post('/people/save.json', { id: 'p1', firstname: 'Test' });

  assert.equal(seenMethod, 'POST');
  assert.deepEqual(seenBody, { id: 'p1', firstname: 'Test' });
  assert.deepEqual(result, { status: 'ok', people: { total: 0 } });
});
