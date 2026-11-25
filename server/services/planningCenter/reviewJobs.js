'use strict';

const { createHash, randomUUID } = require('node:crypto');

// Reviews contain church roster data. Retain results only long enough for the
// initiating admin to collect them, including after reloading the review page.
function createReviewJobs({ timeoutMs = 15 * 60_000, retentionMs = 5 * 60_000, capacity = 128 } = {}) {
  const jobs = new Map();

  function start({ churchId, userId, operation, input, run }) {
    const key = createHash('sha256').update(JSON.stringify([operation, input])).digest('hex');
    let runningForChurch = 0;
    for (const job of jobs.values()) {
      if (job.churchId !== churchId) continue;
      if (job.state === 'running') runningForChurch++;
      const reuseApply = operation === 'applyReviewed' && ['complete', 'timedOut'].includes(job.state);
      if (job.userId === userId && job.key === key && (!job.delivered || reuseApply)) return job.id;
    }
    if (runningForChurch >= 4) return null;

    // Make room from already delivered previews before rejecting new work.
    if (jobs.size >= capacity) {
      const disposable = [...jobs.values()].find(job => job.delivered && job.operation !== 'applyReviewed');
      if (disposable) jobs.delete(disposable.id);
      else return null;
    }
    const job = { id: randomUUID(), churchId, userId, operation, key, state: 'running', delivered: false };
    jobs.set(job.id, job);
    const controller = new AbortController();
    let expiry;
    function expireResult() {
      clearTimeout(expiry);
      expiry = setTimeout(() => jobs.delete(job.id), retentionMs);
      expiry.unref();
    }
    const deadline = setTimeout(() => {
      controller.abort();
      job.state = 'timedOut';
      expireResult();
    }, timeoutMs);
    deadline.unref();

    Promise.resolve().then(() => run({ ...input, signal: controller.signal })).then(result => {
      // A signed apply can commit before its post-commit bookkeeping finishes.
      // Keep its actual result if it arrives after the deadline.
      if (!controller.signal.aborted || operation === 'applyReviewed') {
        job.state = 'complete';
        job.result = result;
      }
    }, error => {
      if (!controller.signal.aborted) {
        job.state = 'failed';
        job.error = error;
      }
    }).finally(() => {
      clearTimeout(deadline);
      expireResult();
    });
    return job.id;
  }

  function get(id, churchId, userId) {
    const job = jobs.get(id);
    if (!job || job.churchId !== churchId || job.userId !== userId) return null;
    if (job.state !== 'running') job.delivered = true;
    return job;
  }

  return { start, get };
}

module.exports = { createReviewJobs };
