const Player = require('../models/Player');
const License = require('../models/License');
const { hashApiKey, makeKeyPreview } = require('./licenseService');
const { loadMlbSeedPlayers } = require('./mlbStatsService');

const DEFAULT_MAX_PLAYER_AGE_MINUTES = 60;
const DEFAULT_MIN_SYNC_COVERAGE_RATIO = 0.8;
let catalogReadyPromise = null;

async function ensurePlayerIndexes() {
  const existingIndexes = await Player.collection.indexes();
  for (const index of existingIndexes) {
    const isSingleFieldMlbPlayerIdIndex =
      index.name !== '_id_' &&
      index.key &&
      Object.keys(index.key).length === 1 &&
      index.key.mlbPlayerId === 1;

    if (isSingleFieldMlbPlayerIdIndex) {
      await Player.collection.dropIndex(index.name);
    }
  }

  await Player.collection.createIndex(
    { mlbPlayerId: 1 },
    {
      unique: true,
      partialFilterExpression: {
        mlbPlayerId: { $type: 'number' },
        isCustom: false,
      },
      name: 'mlbPlayerId_1',
    }
  );
}

async function removeDuplicatePlayers() {
  const duplicates = await Player.aggregate([
    {
      $match: {
        isCustom: { $ne: true },
        mlbPlayerId: { $type: 'number' },
      },
    },
    {
      $sort: {
        lastSyncedAt: -1,
        updatedAt: -1,
        createdAt: -1,
        _id: 1,
      },
    },
    {
      $group: {
        _id: '$mlbPlayerId',
        ids: { $push: '$_id' },
        count: { $sum: 1 },
      },
    },
    {
      $match: {
        count: { $gt: 1 },
      },
    },
  ]);

  let deletedCount = 0;

  for (const duplicate of duplicates) {
    const staleIds = duplicate.ids.slice(1);
    if (!staleIds.length) continue;
    const result = await Player.deleteMany({ _id: { $in: staleIds } });
    deletedCount += result.deletedCount || 0;
  }

  return deletedCount;
}

function requireEnv(key) {
  const value = process.env[key];
  if (!value || !String(value).trim()) {
    throw new Error(`${key} is required`);
  }
  return String(value).trim();
}

function getOptionalEnv(key, fallback) {
  const value = process.env[key];
  if (!value || !String(value).trim()) {
    return fallback;
  }
  return String(value).trim();
}

function getMaxPlayerAgeMs() {
  const raw = process.env.PLAYER_SYNC_MAX_AGE_MINUTES;
  if (!raw || !String(raw).trim()) {
    return DEFAULT_MAX_PLAYER_AGE_MINUTES * 60 * 1000;
  }

  const minutes = Number(raw);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('PLAYER_SYNC_MAX_AGE_MINUTES must be a positive number');
  }

  return Math.floor(minutes * 60 * 1000);
}

function getMinSyncCoverageRatio() {
  const raw = process.env.PLAYER_SYNC_MIN_COVERAGE_RATIO;
  if (!raw || !String(raw).trim()) {
    return DEFAULT_MIN_SYNC_COVERAGE_RATIO;
  }

  const ratio = Number(raw);
  if (!Number.isFinite(ratio) || ratio <= 0 || ratio > 1) {
    throw new Error('PLAYER_SYNC_MIN_COVERAGE_RATIO must be a number between 0 and 1');
  }

  return ratio;
}

async function ensureSeedLicense() {
  const rawApiKey = requireEnv('PLAYER_API_LICENSE_KEY');
  const consumerName = getOptionalEnv('PLAYER_API_LICENSE_CONSUMER', 'DraftKit Web App');
  const keyHash = hashApiKey(rawApiKey);

  const license = await License.findOneAndUpdate(
    { keyHash },
    {
      $set: {
        consumerName,
        keyPreview: makeKeyPreview(rawApiKey),
        isActive: true,
      },
      $setOnInsert: {
        metadata: {
          seeded: true,
        },
      },
    },
    {
      new: true,
      upsert: true,
      setDefaultsOnInsert: true,
    }
  ).lean();

  return {
    licenseId: license._id.toString(),
    consumerName: license.consumerName,
    keyPreview: license.keyPreview,
  };
}

async function getSeedStatus() {
  const existingCount = await Player.countDocuments();
  if (existingCount === 0) {
    return {
      count: 0,
      shouldSeed: true,
      reason: 'empty',
      newestSyncAt: null,
    };
  }

  const newestPlayer = await Player.findOne({ lastSyncedAt: { $exists: true, $ne: null } })
    .sort({ lastSyncedAt: -1 })
    .select('lastSyncedAt')
    .lean();

  if (!newestPlayer?.lastSyncedAt) {
    return {
      count: existingCount,
      shouldSeed: true,
      reason: 'missing-sync-timestamp',
      newestSyncAt: null,
    };
  }

  const newestSyncAt = new Date(newestPlayer.lastSyncedAt);
  const isStale = Date.now() - newestSyncAt.getTime() >= getMaxPlayerAgeMs();

  return {
    count: existingCount,
    shouldSeed: isStale,
    reason: isStale ? 'stale' : 'fresh',
    newestSyncAt: newestSyncAt.toISOString(),
  };
}

async function softReseedPlayers() {
  const result = await loadMlbSeedPlayers();
  const seenIds = [];

  const removedDuplicatesBeforeSync = await removeDuplicatePlayers();
  const previousActiveCount = await Player.countDocuments({
    isCustom: { $ne: true },
    isActiveRoster: true,
  });

  for (const player of result.players) {
    seenIds.push(player.mlbPlayerId);
    await Player.updateOne(
      { mlbPlayerId: player.mlbPlayerId },
      {
        $set: {
          ...player,
          isActiveRoster: true,
          lastSeenInSyncAt: player.lastSeenInSyncAt || player.lastSyncedAt,
        },
      },
      { upsert: true }
    );
  }

  const minCoverageRatio = getMinSyncCoverageRatio();
  const currentSyncCount = result.players.length;
  const isSuspiciousCoverage =
    previousActiveCount > 0 && currentSyncCount / previousActiveCount < minCoverageRatio;

  const deletedStalePlayersResult = isSuspiciousCoverage
    ? { deletedCount: 0 }
    : await Player.deleteMany({
        isCustom: { $ne: true },
        mlbPlayerId: { $nin: seenIds },
      });
  const removedDuplicatesAfterSync = await removeDuplicatePlayers();
  await ensurePlayerIndexes();

  const totalCount = await Player.countDocuments();

  return {
    inserted: result.players.length,
    count: totalCount,
    skipped: false,
    deletedStalePlayers: deletedStalePlayersResult.deletedCount || 0,
    removedDuplicatePlayers: removedDuplicatesBeforeSync + removedDuplicatesAfterSync,
    staleDeletionSkipped: isSuspiciousCoverage,
    syncCoverage: previousActiveCount > 0 ? Number((currentSyncCount / previousActiveCount).toFixed(3)) : 1,
    mlbSeed: {
      enabled: true,
      season: result.season,
      rosterPlayerCount: result.rosterPlayerCount,
    },
  };
}

async function ensureSeedData({ force = false } = {}) {
  const seededLicense = await ensureSeedLicense();

  if (force) {
    const result = await softReseedPlayers();
    return {
      ...result,
      seededLicense,
      reason: 'forced',
    };
  }

  const seedStatus = await getSeedStatus();
  if (!seedStatus.shouldSeed) {
    return {
      inserted: 0,
      count: seedStatus.count,
      skipped: true,
      seededLicense,
      reason: seedStatus.reason,
      newestSyncAt: seedStatus.newestSyncAt,
    };
  }

  const result = await softReseedPlayers();
  return {
    ...result,
    seededLicense,
    reason: seedStatus.reason,
    previousCount: seedStatus.count,
    previousNewestSyncAt: seedStatus.newestSyncAt,
  };
}

async function ensurePlayerCatalogReady() {
  const existingCount = await Player.countDocuments();
  if (existingCount > 0) {
    return { seeded: false, count: existingCount };
  }

  if (!catalogReadyPromise) {
    catalogReadyPromise = ensureSeedData({ force: true }).finally(() => {
      catalogReadyPromise = null;
    });
  }

  const result = await catalogReadyPromise;
  return {
    seeded: true,
    count: result.count,
    result,
  };
}

module.exports = {
  ensurePlayerCatalogReady,
  ensureSeedData,
};
