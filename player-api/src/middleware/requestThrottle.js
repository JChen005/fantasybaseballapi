const { AppError } = require('../utils/appError');

const buckets = new Map();
const DEFAULT_WINDOW_MS = 60_000;
const DEFAULT_MAX_REQUESTS = 10_000;

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getThrottleOptions() {
  return {
    windowMs: parsePositiveInteger(process.env.REQUEST_THROTTLE_WINDOW_MS, DEFAULT_WINDOW_MS),
    maxRequests: parsePositiveInteger(process.env.REQUEST_THROTTLE_MAX, DEFAULT_MAX_REQUESTS),
  };
}

function pruneExpiredBuckets(now, windowMs) {
  for (const [key, bucket] of buckets.entries()) {
    if (now - bucket.startedAt > windowMs) {
      buckets.delete(key);
    }
  }
}

function requestThrottle(req, res, next) {
  const { windowMs, maxRequests } = getThrottleOptions();
  const now = Date.now();
  pruneExpiredBuckets(now, windowMs);

  const key = req.license?.id || req.ip || 'anonymous';
  const current = buckets.get(key);
  const bucket = current && now - current.startedAt <= windowMs
    ? current
    : { count: 0, startedAt: now };

  bucket.count += 1;
  buckets.set(key, bucket);

  const remaining = Math.max(0, maxRequests - bucket.count);
  res.setHeader('RateLimit-Limit', String(maxRequests));
  res.setHeader('RateLimit-Remaining', String(remaining));
  res.setHeader('RateLimit-Reset', String(Math.ceil((bucket.startedAt + windowMs) / 1000)));

  if (bucket.count > maxRequests) {
    res.setHeader('Retry-After', String(Math.ceil((bucket.startedAt + windowMs - now) / 1000)));
    return next(new AppError('Request limit exceeded for this API key', 429));
  }

  return next();
}

function resetThrottleBuckets() {
  buckets.clear();
}

module.exports = {
  requestThrottle,
  resetThrottleBuckets,
  getThrottleOptions,
};
