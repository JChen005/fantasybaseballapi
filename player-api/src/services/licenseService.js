const crypto = require('crypto');
const License = require('../models/License');

function hashApiKey(apiKey) {
  return crypto.createHash('sha256').update(apiKey).digest('hex');
}

function generateApiKey() {
  return `pk-${crypto.randomBytes(24).toString('hex')}`;
}

function makeKeyPreview(apiKey) {
  if (!apiKey) return '***';
  const normalized = String(apiKey).trim();
  if (normalized.length <= 8) return `${normalized[0] || '*'}***${normalized.at(-1) || '*'}`;
  return `${normalized.slice(0, 4)}...${normalized.slice(-4)}`;
}

async function findActiveLicenseByApiKey(apiKey) {
  const keyHash = hashApiKey(apiKey);
  return License.findOne({ keyHash, isActive: true });
}

async function createLicense({ consumerName, metadata = {} }) {
  const apiKey = generateApiKey();
  const license = await License.create({
    consumerName: String(consumerName || '').trim(),
    keyHash: hashApiKey(apiKey),
    keyPreview: makeKeyPreview(apiKey),
    isActive: true,
    metadata,
  });

  return {
    apiKey,
    license: {
      id: license._id.toString(),
      consumerName: license.consumerName,
      keyPreview: license.keyPreview,
      isActive: license.isActive,
    },
  };
}

module.exports = {
  createLicense,
  generateApiKey,
  hashApiKey,
  makeKeyPreview,
  findActiveLicenseByApiKey,
};
