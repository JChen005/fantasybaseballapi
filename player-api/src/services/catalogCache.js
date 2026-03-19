const caches = new Map();
const inFlight = new Map();
const versions = new Map();

function now() {
  return Date.now();
}

function isFresh(entry) {
  return entry && now() <= entry.expiresAt;
}

function getCache(key) {
  const entry = caches.get(key);
  if (!isFresh(entry)) {
    if (entry) {
      caches.delete(key);
    }
    return null;
  }

  return entry.value;
}

function getVersion(key) {
  return versions.get(key) || 0;
}

function bumpVersion(key) {
  versions.set(key, getVersion(key) + 1);
}

function setCache(key, value, ttlMs) {
  const version = getVersion(key);
  caches.set(key, {
    expiresAt: now() + ttlMs,
    version,
    value,
  });
}

async function withCatalogCache(key, ttlMs, factory) {
  const cached = getCache(key);
  if (cached != null) {
    return cached;
  }

  const existing = inFlight.get(key);
  if (existing) {
    return existing;
  }

  const version = getVersion(key);
  const promise = Promise.resolve()
    .then(factory)
    .then((value) => {
      if (getVersion(key) === version) {
        setCache(key, value, ttlMs);
      }
      return value;
    });

  inFlight.set(key, promise);

  try {
    return await promise;
  } finally {
    inFlight.delete(key);
  }
}

function invalidateCatalogCache(prefix = '') {
  if (!prefix) {
    caches.clear();
    inFlight.clear();
    versions.clear();
    return;
  }

  for (const key of new Set([...caches.keys(), ...inFlight.keys(), ...versions.keys()])) {
    if (key.startsWith(prefix)) {
      bumpVersion(key);
      caches.delete(key);
      inFlight.delete(key);
    }
  }
}

module.exports = {
  withCatalogCache,
  invalidateCatalogCache,
};
