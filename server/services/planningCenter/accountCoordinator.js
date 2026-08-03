'use strict';

// Total-orders credential replacement/disconnect with supplementary account
// snapshot writes for one church. Provider reads stay outside this queue; only
// the short local commit boundaries participate.
const churchQueues = new Map();
const churchCredentialEpochs = new Map();
let allChurchCredentialEpoch = 0;

function getCredentialEpoch(churchId) {
  return {
    allChurches: allChurchCredentialEpoch,
    church: churchCredentialEpochs.get(churchId) || 0,
  };
}

function sameCredentialEpoch(left, right) {
  return left?.allChurches === right?.allChurches && left?.church === right?.church;
}

function isCredentialEpochCurrent(churchId, epoch) {
  return sameCredentialEpoch(epoch, getCredentialEpoch(churchId));
}

function invalidateCredentialEpoch(churchId) {
  if (churchId) {
    churchCredentialEpochs.set(churchId, (churchCredentialEpochs.get(churchId) || 0) + 1);
    return;
  }
  allChurchCredentialEpoch += 1;
  churchCredentialEpochs.clear();
}

async function withChurchCoordination(churchId, operation) {
  if (!churchId || typeof operation !== 'function') {
    throw new Error('Planning Center account coordination requires a church and operation');
  }

  const previous = churchQueues.get(churchId) || Promise.resolve();
  let release;
  const current = new Promise((resolve) => { release = resolve; });
  churchQueues.set(churchId, current);
  await previous;
  try {
    return await operation();
  } finally {
    release();
    if (churchQueues.get(churchId) === current) churchQueues.delete(churchId);
  }
}

async function withCredentialMutation(churchId, operation) {
  return withChurchCoordination(churchId, async () => {
    // Advance before entering the credential transaction. Old fetched or
    // cached work queued behind this mutation will fail its epoch check after
    // the credential commit, before it can enter its own apply transaction.
    invalidateCredentialEpoch(churchId);
    return operation();
  });
}

async function captureCredentialEpoch(churchId) {
  return withChurchCoordination(churchId, () => getCredentialEpoch(churchId));
}

async function withSnapshotApplication(churchId, expectedEpoch, operation) {
  return withChurchCoordination(churchId, async () => {
    if (!isCredentialEpochCurrent(churchId, expectedEpoch)) return { stale: true };
    return { stale: false, value: await operation() };
  });
}

module.exports = {
  getCredentialEpoch,
  sameCredentialEpoch,
  invalidateCredentialEpoch,
  captureCredentialEpoch,
  withCredentialMutation,
  withSnapshotApplication,
};
