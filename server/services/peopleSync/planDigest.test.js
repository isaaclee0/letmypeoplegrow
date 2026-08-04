const { test } = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');

const {
  digestPlan,
  digestReviewToken,
  createReviewToken,
  verifyReviewToken,
  verifyReviewTokenLineage,
} = require('./planDigest');

function plan(overrides = {}) {
  return {
    provider: 'elvanto', authoritative: true,
    snapshot: { fetchedAt: '2026-07-25T01:00:00.000Z', watermark: 'wm-1', mode: 'full' },
    linkPeople: [], linkFamilies: [],
    addPeople: [{ id: 'addPeople:e1', externalPersonId: 'e1', firstName: 'Ada', selected: true }],
    addFamilies: [], updateManagedFields: [], promoteToRegular: [], demoteToLocalVisitor: [],
    archive: [], reactivate: [], moveFamily: [], renameFamily: [], addToGathering: [],
    removeFromGathering: [], ambiguousPeople: [], familyConflicts: [],
    unmatchedLocalRegulars: [], skipped: [],
    ...overrides,
  };
}

function withSecret(value, callback) {
  const previousReview = process.env.SYNC_REVIEW_SECRET;
  const previousJwt = process.env.JWT_SECRET;
  if (value === null) {
    delete process.env.SYNC_REVIEW_SECRET;
    delete process.env.JWT_SECRET;
  } else {
    process.env.SYNC_REVIEW_SECRET = value;
    delete process.env.JWT_SECRET;
  }
  try {
    return callback();
  } finally {
    if (previousReview === undefined) delete process.env.SYNC_REVIEW_SECRET;
    else process.env.SYNC_REVIEW_SECRET = previousReview;
    if (previousJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = previousJwt;
  }
}

function atUnixSecond(second, callback) {
  const original = Date.now;
  Date.now = () => second * 1000;
  try {
    return callback();
  } finally {
    Date.now = original;
  }
}

test('digest is deterministic across recursive object key order', () => {
  const left = plan({
    metadata: { z: 2, nested: { b: false, a: true }, a: 1 },
  });
  const right = {
    metadata: { a: 1, nested: { a: true, b: false }, z: 2 },
    skipped: [], unmatchedLocalRegulars: [], familyConflicts: [], ambiguousPeople: [],
    removeFromGathering: [], addToGathering: [], renameFamily: [], moveFamily: [],
    reactivate: [], archive: [], demoteToLocalVisitor: [], promoteToRegular: [],
    updateManagedFields: [], addFamilies: [],
    addPeople: [{ selected: true, firstName: 'Ada', externalPersonId: 'e1', id: 'addPeople:e1' }],
    linkFamilies: [], linkPeople: [],
    snapshot: { mode: 'full', watermark: 'wm-1', fetchedAt: '2026-07-25T01:00:00.000Z' },
    authoritative: true, provider: 'elvanto',
  };

  assert.equal(digestPlan(left), digestPlan(right));
  assert.match(digestPlan(left), /^[a-f0-9]{64}$/);
});

test('digest removes only volatile snapshot, run, display, and cache metadata', () => {
  const first = plan({
    runId: 11,
    display: { generatedAt: '2026-07-25T01:00:00.000Z', title: 'Review' },
    metadataCache: { cachedAt: '2026-07-25T01:00:00.000Z', values: ['group-1'] },
  });
  const later = plan({
    // fetchedAt AND watermark both differ from `first` (and mode is
    // repeated as the same value here only because it never actually
    // varies in practice — see planDigest.js's own VOLATILE_PATHS
    // comment) — none of these three snapshot fields may affect the
    // digest, since only actual plan bucket content should ever trigger a
    // stale-plan re-review.
    snapshot: { fetchedAt: '2026-07-25T02:00:00.000Z', watermark: 'wm-2', mode: 'full' },
    runId: 99,
    display: { generatedAt: '2026-07-25T02:00:00.000Z', title: 'Review' },
    metadataCache: { cachedAt: '2026-07-25T02:00:00.000Z', values: ['group-1'] },
  });

  assert.equal(digestPlan(first), digestPlan(later));
});

test('a fetch watermark change alone never makes a re-fetched plan look stale', () => {
  // A provider's watermark (e.g. Elvanto's max(date_modified) across every
  // fetched person) can legitimately advance from an edit to a field LMPG
  // doesn't even track (a phone number, say) — that alone must never make
  // an otherwise-identical re-fetched plan register as changed.
  const baseline = digestPlan(plan());
  const watermarkOnly = digestPlan(plan({ snapshot: { fetchedAt: 'later', watermark: 'wm-2', mode: 'full' } }));
  assert.equal(watermarkOnly, baseline);
});

test('volatile pruning is exact-path and retains durable cachedAt action values', () => {
  const first = plan({
    snapshot: { fetchedAt: '2026-07-25T01:00:00.000Z', watermark: 'wm-1', mode: 'full' },
    updateManagedFields: [{ id: 'update:e1', externalPersonId: 'e1',
      changes: [{ field: 'attributes', localValue: { cachedAt: 'durable-1' }, externalValue: {} }] }],
  });
  const displayOnly = plan({
    snapshot: { fetchedAt: '2026-07-25T02:00:00.000Z', watermark: 'wm-1', mode: 'full' },
    updateManagedFields: [{ id: 'update:e1', externalPersonId: 'e1',
      changes: [{ field: 'attributes', localValue: { cachedAt: 'durable-1' }, externalValue: {} }] }],
  });
  const durableChanged = plan({
    snapshot: { fetchedAt: '2026-07-25T02:00:00.000Z', watermark: 'wm-1', mode: 'full' },
    updateManagedFields: [{ id: 'update:e1', externalPersonId: 'e1',
      changes: [{ field: 'attributes', localValue: { cachedAt: 'durable-2' }, externalValue: {} }] }],
  });

  assert.equal(digestPlan(first), digestPlan(displayOnly));
  assert.notEqual(digestPlan(first), digestPlan(durableChanged));
});

test('presence projection is bound into the plan digest', () => {
  const baseline = plan({ presenceProjection: { completeFullSnapshot: true, updates: [
    { externalPersonId: 'e1', individualId: 1, previousMissingFullSyncCount: 0,
      nextMissingFullSyncCount: 1, seen: false },
  ] } });
  const changed = plan({ presenceProjection: { completeFullSnapshot: true, updates: [
    { externalPersonId: 'e1', individualId: 1, previousMissingFullSyncCount: 1,
      nextMissingFullSyncCount: 2, seen: false },
  ] } });

  assert.notEqual(digestPlan(baseline), digestPlan(changed));
});

test('source context snapshots are digested in numeric batch order and bind source review inputs', () => {
  const sourceContext = {
    connectionGeneration: 17,
    activeRevision: 7,
    draftDigest: 'd'.repeat(64),
    snapshots: [
      { batchId: 20, sourceKind: 'elvanto_group', sourceExternalId: 'twenty', snapshotDigest: '2'.repeat(64) },
      { batchId: 3, sourceKind: 'elvanto_group', sourceExternalId: 'three', snapshotDigest: '3'.repeat(64) },
    ],
  };
  const baseline = digestPlan(plan({ sourceContext }));
  const reordered = digestPlan(plan({ sourceContext: { ...sourceContext, snapshots: [...sourceContext.snapshots].reverse() } }));
  assert.equal(reordered, baseline);

  for (const changed of [
    { ...sourceContext, connectionGeneration: 18 },
    { ...sourceContext, activeRevision: 8 },
    { ...sourceContext, draftDigest: 'e'.repeat(64) },
    { ...sourceContext, snapshots: [{ ...sourceContext.snapshots[0], sourceExternalId: 'changed' }, sourceContext.snapshots[1]] },
    { ...sourceContext, snapshots: [{ ...sourceContext.snapshots[0], snapshotDigest: '4'.repeat(64) }, sourceContext.snapshots[1]] },
  ]) {
    assert.notEqual(digestPlan(plan({ sourceContext: changed })), baseline);
  }
});

test('authority source context canonicalizes promotions by batch ID', () => {
  const promotions = [
    { batchId: 20, expectedBaseRevision: 7, expectedDraftDigest: '2'.repeat(64) },
    { batchId: 3, expectedBaseRevision: 4, expectedDraftDigest: '3'.repeat(64) },
  ];
  const baseline = digestPlan(plan({ sourceContext: {
    participatingBatchSourceDigest: 'a'.repeat(64),
    promotions,
    snapshots: [],
  } }));
  const reordered = digestPlan(plan({ sourceContext: {
    participatingBatchSourceDigest: 'a'.repeat(64),
    promotions: [...promotions].reverse(),
    snapshots: [],
  } }));

  assert.equal(reordered, baseline);
  assert.notEqual(digestPlan(plan({ sourceContext: {
    participatingBatchSourceDigest: 'b'.repeat(64),
    promotions,
    snapshots: [],
  } })), baseline);
});

test('canonical JSON rejects non-finite numbers instead of collapsing them to null', () => {
  assert.throws(() => digestPlan(plan({ updateManagedFields: [{ id: 'bad', localValue: NaN }] })),
    /finite number/i);
  assert.throws(() => digestPlan(plan({ updateManagedFields: [{ id: 'bad', localValue: Infinity }] })),
    /finite number/i);
  assert.throws(() => digestPlan(plan({ updateManagedFields: [{ id: 'bad', localValue: -Infinity }] })),
    /finite number/i);
});

test('digest retains action values, IDs, selections, and conflicts', () => {
  const baseline = digestPlan(plan());
  const changed = [
    plan({ addPeople: [{ id: 'addPeople:e1', externalPersonId: 'e1', firstName: 'Grace', selected: true }] }),
    plan({ addPeople: [{ id: 'addPeople:e2', externalPersonId: 'e1', firstName: 'Ada', selected: true }] }),
    plan({ addPeople: [{ id: 'addPeople:e1', externalPersonId: 'e1', firstName: 'Ada', selected: false }] }),
    plan({ ambiguousPeople: [{ id: 'ambiguousPeople:e2:duplicate_name', externalPersonId: 'e2',
      candidateIndividualIds: [1, 2], reason: 'duplicate_name' }] }),
  ];

  assert.deepEqual(changed.map((value) => digestPlan(value) === baseline), [false, false, false, false]);
});

test('review token is bound to church, provider, batch, and plan digest', () => withSecret('review-secret', () => {
  atUnixSecond(2_000_000_000, () => {
    const planDigest = digestPlan(plan());
    const token = createReviewToken({
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest, expiresInSeconds: 900,
    });
    const expected = {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3, planDigest,
    };

    assert.equal(verifyReviewToken(token, expected).ok, true);
    assert.deepEqual(verifyReviewToken(token, { ...expected, churchId: 'c2' }), {
      ok: false, code: 'SYNC_REVIEW_INVALID',
    });
    assert.deepEqual(verifyReviewToken(token, { ...expected, provider: 'planning_center' }), {
      ok: false, code: 'SYNC_REVIEW_INVALID',
    });
    assert.deepEqual(verifyReviewToken(token, { ...expected, batchId: 4 }), {
      ok: false, code: 'SYNC_REVIEW_INVALID',
    });
    assert.deepEqual(verifyReviewToken(token, { ...expected, planDigest: digestPlan(plan({ archive: [{ id: 'archive:e1:1' }] })) }), {
      ok: false, code: 'SYNC_PLAN_STALE',
    });
  });
}));

test('review token is bound to its operation kind', () => withSecret('review-secret', () => {
  const planDigest = 'a'.repeat(64);
  const token = createReviewToken({
    operationKind: 'people_import', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest, expiresInSeconds: 60,
  });

  assert.equal(verifyReviewToken(token, {
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest,
  }).ok, false);
  assert.equal(verifyReviewToken(token, {
    operationKind: 'people_import', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest,
  }).ok, true);

  const authorityToken = createReviewToken({
    operationKind: 'authority_switch', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest, expiresInSeconds: 60,
  });
  assert.equal(verifyReviewToken(authorityToken, {
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest,
  }).ok, false);
  assert.equal(verifyReviewToken(authorityToken, {
    operationKind: 'authority_switch', churchId: 'c1', provider: 'elvanto',
    batchId: null, planDigest,
  }).ok, true);
}));

test('a corrected review token signs the base-plan lineage used to classify apply-time projection errors', () => withSecret('review-secret', () => {
  atUnixSecond(2_000_000_000, () => {
    const basePlanDigest = digestPlan(plan());
    const correctedPlanDigest = digestPlan(plan({
      updateManagedFields: [{ id: 'update:corrected', individualId: 20 }],
    }));
    const baseToken = createReviewToken({
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest: basePlanDigest,
      expiresInSeconds: 900,
    });
    const rootReviewTokenDigest = digestReviewToken(baseToken);
    const token = createReviewToken({
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest: correctedPlanDigest,
      basePlanDigest,
      rootReviewTokenDigest,
      expiresInSeconds: 900,
    });
    const lineage = {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3, basePlanDigest,
    };

    const verification = verifyReviewToken(token, {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest: correctedPlanDigest,
    });
    assert.equal(verification.ok, true);
    assert.equal(verification.payload.rootReviewTokenDigest, rootReviewTokenDigest);
    assert.equal(verifyReviewTokenLineage(token, lineage).ok, true);
    assert.deepEqual(verifyReviewTokenLineage(token, {
      ...lineage,
      basePlanDigest: digestPlan(plan({ archive: [{ id: 'archive:changed' }] })),
    }), { ok: false, code: 'SYNC_PLAN_STALE' });
  });
}));

test('an ordinary base token is its own valid lineage root', () => withSecret('review-secret', () => {
  atUnixSecond(2_000_000_000, () => {
    const basePlanDigest = digestPlan(plan());
    const token = createReviewToken({
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest: basePlanDigest,
      expiresInSeconds: 900,
    });

    assert.equal(verifyReviewTokenLineage(token, {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3, basePlanDigest,
    }).ok, true);
  });
}));

test('separate reviews of the same plan receive distinct one-time token identities', () => withSecret('review-secret', () => {
  atUnixSecond(2_000_000_000, () => {
    const planDigest = digestPlan(plan());
    const context = {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
      planDigest, expiresInSeconds: 900,
    };
    const first = createReviewToken(context);
    const second = createReviewToken(context);

    assert.notEqual(first, second);
    assert.equal(verifyReviewToken(first, context).ok, true);
    assert.equal(verifyReviewToken(second, context).ok, true);
  });
}));

test('tokens issued immediately before the one-time identity rollout remain verifiable', () => withSecret('review-secret', () => {
  atUnixSecond(2_000_000_000, () => {
    const expected = {
      churchId: 'c1', provider: 'elvanto', batchId: 3, planDigest: digestPlan(plan()),
    };
    const payloadPart = Buffer.from(JSON.stringify({
      ...expected,
      exp: 2_000_000_900,
    })).toString('base64url');
    const signature = crypto.createHmac('sha256', 'review-secret').update(payloadPart).digest('base64url');

    assert.equal(verifyReviewToken(`${payloadPart}.${signature}`, expected).ok, true);
    assert.equal(verifyReviewToken(`${payloadPart}.${signature}`, {
      ...expected, operationKind: 'people_sync',
    }).ok, false);
  });
}));

test('review token expires exactly at its exp boundary', () => withSecret('review-secret', () => {
  const token = atUnixSecond(1000, () => createReviewToken({
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()), expiresInSeconds: 10,
  }));
  const expected = {
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()),
  };

  assert.equal(atUnixSecond(1009, () => verifyReviewToken(token, expected).ok), true);
  assert.deepEqual(atUnixSecond(1010, () => verifyReviewToken(token, expected)), {
    ok: false, code: 'SYNC_REVIEW_EXPIRED',
  });
}));

test('signature tampering and malformed user input return typed invalid results without throwing', () => withSecret('review-secret', () => {
  const token = createReviewToken({
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()), expiresInSeconds: 900,
  });
  const expected = {
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()),
  };
  const tampered = `${token.slice(0, -1)}${token.endsWith('a') ? 'b' : 'a'}`;
  const malformed = [null, '', 'one-part', 'a.b.c', '.x', 'e30.invalid', 42, {}, `${'a'.repeat(10000)}.x`];

  assert.deepEqual(verifyReviewToken(tampered, expected), { ok: false, code: 'SYNC_REVIEW_INVALID' });
  for (const value of malformed) {
    assert.doesNotThrow(() => verifyReviewToken(value, expected));
    assert.deepEqual(verifyReviewToken(value, expected), { ok: false, code: 'SYNC_REVIEW_INVALID' });
  }
}));

test('missing signing secret fails closed for creation and verification', () => withSecret(null, () => {
  assert.throws(() => createReviewToken({
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()), expiresInSeconds: 900,
  }), /review signing secret/i);
  assert.deepEqual(verifyReviewToken('e30.c2ln', {
    operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: 3,
    planDigest: digestPlan(plan()),
  }), { ok: false, code: 'SYNC_REVIEW_INVALID' });
}));

test('JWT_SECRET is the fallback signing key when no dedicated review secret exists', () => {
  const oldReview = process.env.SYNC_REVIEW_SECRET;
  const oldJwt = process.env.JWT_SECRET;
  delete process.env.SYNC_REVIEW_SECRET;
  process.env.JWT_SECRET = 'jwt-fallback';
  try {
    const planDigest = digestPlan(plan());
    const token = createReviewToken({
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: null,
      planDigest, expiresInSeconds: 60,
    });
    assert.equal(verifyReviewToken(token, {
      operationKind: 'people_sync', churchId: 'c1', provider: 'elvanto', batchId: null, planDigest,
    }).ok, true);
  } finally {
    if (oldReview === undefined) delete process.env.SYNC_REVIEW_SECRET;
    else process.env.SYNC_REVIEW_SECRET = oldReview;
    if (oldJwt === undefined) delete process.env.JWT_SECRET;
    else process.env.JWT_SECRET = oldJwt;
  }
});
