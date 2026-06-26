'use strict';

const crypto = require('crypto');

const FAILURE_COOLDOWN_MS = Number(process.env.IG_WORKER_FAILURE_COOLDOWN_MS || 10 * 60 * 1000);
const ACQUIRE_TIMEOUT_MS = Number(process.env.IG_WORKER_ACQUIRE_TIMEOUT_MS || 45 * 1000);
const ACQUIRE_POLL_MS = 500;

let workers = [];
let cursor = 0;

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function safeDecode(value) {
  try { return decodeURIComponent(value); }
  catch { return value; }
}

function normalizeProxy(raw) {
  const value = String(raw || '').trim();
  if (!value) return '';
  if (/^[a-z]+:\/\//i.test(value)) return value;

  const parts = value.split(':');
  if (parts.length >= 4) {
    const [host, port, username, ...passwordParts] = parts;
    const password = passwordParts.join(':');
    return `http://${encodeURIComponent(username)}:${encodeURIComponent(password)}@${host}:${port}`;
  }
  if (parts.length >= 2) return `http://${value}`;
  return value;
}

function workerHash(sessionId, proxyUrl, index) {
  return crypto
    .createHash('sha1')
    .update(`${index}|${sessionId}|${proxyUrl}`)
    .digest('hex')
    .slice(0, 10);
}

function parseWorkerEntry(entry, index) {
  const raw = String(entry || '').trim();
  if (!raw) return null;

  const sep = raw.indexOf('|');
  if (sep === -1) {
    console.warn(`[ig-workers] Skipping worker ${index + 1}: missing session|proxy separator`);
    return null;
  }

  const sessionId = safeDecode(raw.slice(0, sep).trim());
  const proxyUrl = normalizeProxy(raw.slice(sep + 1).trim());
  if (!sessionId || !proxyUrl) {
    console.warn(`[ig-workers] Skipping worker ${index + 1}: missing session or proxy`);
    return null;
  }

  const id = `w${index + 1}-${workerHash(sessionId, proxyUrl, index)}`;
  return {
    id,
    index,
    sessionId,
    dsUserId: sessionId.split(':')[0] || '',
    proxyUrl,
    busy: false,
    failedUntil: 0,
    failures: 0,
    jobs: 0,
    lastUsedAt: 0,
    lastError: ''
  };
}

function loadWorkers() {
  const raw = process.env.IG_WORKERS || '';
  workers = raw
    .split(',')
    .map((entry, index) => parseWorkerEntry(entry, index))
    .filter(Boolean);
  cursor = 0;

  if (workers.length) {
    console.log(`[ig-workers] Loaded ${workers.length} fixed Instagram worker(s)`);
  }
}

function hasWorkers() {
  return workers.length > 0;
}

function isHealthy(worker) {
  return worker && Date.now() >= worker.failedUntil;
}

function pickAvailableWorker() {
  const now = Date.now();
  const available = workers.filter(w => !w.busy && now >= w.failedUntil);
  if (!available.length) return null;

  for (let i = 0; i < workers.length; i++) {
    const candidate = workers[(cursor + i) % workers.length];
    if (!candidate.busy && now >= candidate.failedUntil) {
      cursor = (candidate.index + 1) % workers.length;
      return candidate;
    }
  }

  return available[0];
}

async function acquireWorker(reason = 'request') {
  if (!workers.length) return null;
  const started = Date.now();

  while (Date.now() - started < ACQUIRE_TIMEOUT_MS) {
    const worker = pickAvailableWorker();
    if (worker) {
      worker.busy = true;
      worker.jobs++;
      worker.lastUsedAt = Date.now();
      console.log(`[ig-workers] Acquired ${worker.id} for ${reason}`);
      return worker;
    }
    await sleep(ACQUIRE_POLL_MS);
  }

  console.warn(`[ig-workers] No worker available for ${reason} after ${ACQUIRE_TIMEOUT_MS}ms`);
  return null;
}

function releaseWorker(worker) {
  if (!worker) return;
  worker.busy = false;
}

function markWorkerFailed(worker, reason = 'unknown') {
  if (!worker) return;
  worker.failures++;
  worker.lastError = reason;
  worker.failedUntil = Date.now() + FAILURE_COOLDOWN_MS;
  worker.busy = false;
  console.warn(`[ig-workers] ${worker.id} paused for ${Math.round(FAILURE_COOLDOWN_MS / 60000)} min: ${reason}`);
}

function listWorkers() {
  const now = Date.now();
  return workers.map(w => ({
    id: w.id,
    index: w.index,
    healthy: isHealthy(w),
    busy: w.busy,
    proxy: w.proxyUrl.replace(/\/\/[^:@/]+:[^@/]+@/, '//***:***@'),
    sessionTail: w.sessionId.slice(-8),
    jobs: w.jobs,
    failures: w.failures,
    cooldownMs: Math.max(0, w.failedUntil - now),
    lastError: w.lastError
  }));
}

function configStamp() {
  return crypto
    .createHash('sha256')
    .update(process.env.IG_WORKERS || '')
    .digest('hex')
    .slice(0, 24);
}

loadWorkers();

module.exports = {
  acquireWorker,
  releaseWorker,
  markWorkerFailed,
  hasWorkers,
  listWorkers,
  loadWorkers,
  configStamp,
  normalizeProxy
};
