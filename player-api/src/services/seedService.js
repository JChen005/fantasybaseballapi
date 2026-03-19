const Player = require('../models/Player');
const License = require('../models/License');
const { loadCsvSeedPlayers } = require('../data/csvSeedPlayers');
const { hashApiKey, makeKeyPreview } = require('./licenseService');

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

async function ensureSeedData({ force = false } = {}) {
  const existingCount = await Player.countDocuments();

  if (existingCount > 0 && !force) {
    const hasLeagueField = await Player.exists({ mlbLeague: { $in: ['AL', 'NL'] } });
    const missingRequiredFieldsCount = await Player.countDocuments({
      $or: [
        { canonicalName: { $exists: false } },
        { canonicalName: '' },
        { sourcePlayerKey: { $exists: false } },
        { sourcePlayerKey: '' },
        { statsProjection: { $exists: false } },
      ],
    });

    if (hasLeagueField && missingRequiredFieldsCount === 0) {
      const seededLicense = await ensureSeedLicense();
      return { inserted: 0, count: existingCount, skipped: true, seededLicense };
    }
    force = true;
  }

  if (force) {
    await Player.deleteMany({});
  }

  const seedPlayers = loadCsvSeedPlayers();
  const inserted = await Player.insertMany(seedPlayers);
  const seededLicense = await ensureSeedLicense();
  return {
    inserted: inserted.length,
    count: inserted.length,
    skipped: false,
    seededLicense,
  };
}

module.exports = { ensureSeedData };
