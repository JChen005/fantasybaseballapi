const Player = require('../models/Player');
const License = require('../models/License');
const { hashApiKey, makeKeyPreview } = require('./licenseService');
const { loadMlbSeedPlayers } = require('./mlbStatsService');

const DEFAULT_MAX_PLAYER_AGE_MINUTES = 60;

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

  const inactiveResult = await Player.updateMany(
    { mlbPlayerId: { $nin: seenIds } },
    {
      $set: {
        isActiveRoster: false,
        lastSyncedAt: new Date(),
      },
    }
  );

  const totalCount = await Player.countDocuments();

  return {
    inserted: result.players.length,
    count: totalCount,
    skipped: false,
    markedInactive: inactiveResult.modifiedCount,
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

module.exports = { ensureSeedData };
