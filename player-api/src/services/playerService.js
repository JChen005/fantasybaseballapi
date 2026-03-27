const mongoose = require('mongoose');
const Player = require('../models/Player');
const { AppError } = require('../utils/appError');

function withLeagueFilter(leagueType) {
  if (!leagueType) return {};
  return { mlbLeague: leagueType };
}

function withActiveFilter(includeInactive) {
  return includeInactive ? {} : { isActiveRoster: true };
}

async function listPlayers({ limit = 200, leagueType = null, includeInactive = false } = {}) {
  return Player.find({
    ...withLeagueFilter(leagueType),
    ...withActiveFilter(includeInactive),
  })
    .sort({ baseValue: -1, canonicalName: 1, name: 1 })
    .limit(limit)
    .lean();
}

async function searchPlayers({ escapedQuery, includeDrafted, includeInactive = false, limit = 200, leagueType = null }) {
  const query = {
    ...withLeagueFilter(leagueType),
    ...withActiveFilter(includeInactive),
    ...(includeDrafted ? {} : { isDrafted: false }),
    ...(escapedQuery
      ? {
          $or: [
            { name: { $regex: escapedQuery, $options: 'i' } },
            { canonicalName: { $regex: escapedQuery, $options: 'i' } },
            { team: { $regex: escapedQuery, $options: 'i' } },
            { positions: { $regex: escapedQuery, $options: 'i' } },
          ],
        }
      : {}),
  };

  return Player.find(query)
    .sort({ baseValue: -1, canonicalName: 1, name: 1 })
    .limit(limit)
    .lean();
}

function buildPlayerLookup(playerId) {
  if (typeof playerId === 'number') {
    return { mlbPlayerId: playerId };
  }

  if (mongoose.isValidObjectId(playerId)) {
    return { _id: playerId };
  }

  return { mlbPlayerId: Number(playerId) };
}

async function getPlayerById(playerId) {
  const player = await Player.findOne(buildPlayerLookup(playerId)).lean();
  if (!player) {
    throw new AppError('Player not found', 404);
  }
  return player;
}

async function getPlayerTransactions(playerId) {
  const player = await getPlayerById(playerId);
  return {
    playerId: player.mlbPlayerId,
    playerName: player.name,
    transactions: Array.isArray(player.transactions) ? player.transactions : [],
  };
}

async function getLeagueAverages() {
  const players = await Player.find({ isCustom: false, isActiveRoster: true }).select('statsLastYear').limit(500).lean();
  if (players.length === 0) {
    return { averages: null, sampleSize: 0 };
  }

  const toNumber = (value) => (Number.isFinite(Number(value)) ? Number(value) : 0);

  const total = players.reduce(
    (acc, player) => {
      const stats = player.statsLastYear || {};
      acc.hr += toNumber(stats.hr);
      acc.rbi += toNumber(stats.rbi);
      acc.sb += toNumber(stats.sb);
      acc.avg += toNumber(stats.avg);
      return acc;
    },
    { hr: 0, rbi: 0, sb: 0, avg: 0 }
  );

  const sampleSize = players.length;
  return {
    averages: {
      hr: Number((total.hr / sampleSize).toFixed(2)),
      rbi: Number((total.rbi / sampleSize).toFixed(2)),
      sb: Number((total.sb / sampleSize).toFixed(2)),
      avg: Number((total.avg / sampleSize).toFixed(3)),
    },
    sampleSize,
  };
}

function getOpenApiDoc() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'DraftKit Player API',
      version: '0.1.0',
      description:
        'Licensed player and valuation API for DraftKit, including push updates via Server-Sent Events.',
    },
    components: {
      securitySchemes: {
        ApiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'x-api-key',
        },
      },
    },
    paths: {
      '/v1/health': { get: { summary: 'Health check' } },
      '/v1/license/status': { get: { summary: 'License status', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players': { get: { summary: 'List players', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/search': { get: { summary: 'Search players', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}': { get: { summary: 'Player details', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}/transactions': {
        get: { summary: 'Player transactions', security: [{ ApiKeyAuth: [] }] },
      },
      '/v1/stats/league-averages': {
        get: { summary: 'League averages', security: [{ ApiKeyAuth: [] }] },
      },
      '/v1/stream/transactions': {
        get: { summary: 'SSE stream for player transactions', security: [{ ApiKeyAuth: [] }] },
      },
      '/v1/admin/mock-transaction': { post: { summary: 'Publish mock transaction (admin secret)' } },
      '/v1/admin/data-refresh': { post: { summary: 'Refresh seed data' } },
    },
  };
}

module.exports = {
  listPlayers,
  searchPlayers,
  getPlayerById,
  getPlayerTransactions,
  getLeagueAverages,
  getOpenApiDoc,
};
