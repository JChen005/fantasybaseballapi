const mongoose = require('mongoose');
const Player = require('../models/Player');
const { AppError } = require('../utils/appError');
const {
  getTeamDepthChart: fetchTeamDepthChart,
  upsertPlayerByMlbId,
  upsertPlayersByMlbSearch,
} = require('./mlbStatsService');
const { invalidateCatalogCache } = require('./catalogCache');
const { getValuationSnapshot } = require('./valuationService');
const { getOpenApiDoc } = require('../docs/openApiDoc');

function serializePlayer(player) {
  if (!player || typeof player !== 'object') {
    return player;
  }

  return {
    _id: player._id,
    name: player.name,
    mlbPlayerId: player.mlbPlayerId,
    team: player.team,
    mlbLeague: player.mlbLeague,
    positions: player.positions,
    injuryStatus: player.injuryStatus,
    statsLastYear: player.statsLastYear,
    stats3Year: player.stats3Year,
    baseValue: player.baseValue,
    isCustom: player.isCustom,
    isDrafted: player.isDrafted,
    isMlbRelevant: player.isMlbRelevant,
    isActiveRoster: player.isActiveRoster,
    headshotUrl: player.headshotUrl,
    lastSyncedAt: player.lastSyncedAt,
    transactions: player.transactions,
    createdAt: player.createdAt,
    updatedAt: player.updatedAt,
  };
}

function withLeagueFilter(leagueType) {
  if (!leagueType) return {};
  return { mlbLeague: leagueType };
}

function withActiveFilter(includeInactive) {
  return includeInactive ? {} : { isMlbRelevant: true };
}

function withSearchFilter(escapedQuery) {
  if (!escapedQuery) return {};

  return {
    $or: [
      { name: { $regex: escapedQuery, $options: 'i' } },
      { team: { $regex: escapedQuery, $options: 'i' } },
      { positions: { $regex: escapedQuery, $options: 'i' } },
    ],
  };
}

async function listPlayers({ limit = 200, leagueType = null, includeInactive = false } = {}) {
  // This is the simple catalog listing endpoint used when the client wants a
  // general player sample rather than a team-specific valuation snapshot.
  const players = await Player.find({
    ...withLeagueFilter(leagueType),
    ...withActiveFilter(includeInactive),
  })
    .sort({ baseValue: -1, name: 1 })
    .limit(limit)
    .lean();

  return players.map(serializePlayer);
}

async function searchPlayers({ escapedQuery, includeDrafted, includeInactive = false, limit = 200, leagueType = null }) {
  const query = {
    ...withLeagueFilter(leagueType),
    ...withActiveFilter(includeInactive),
    ...(includeDrafted ? {} : { isDrafted: false }),
    ...withSearchFilter(escapedQuery),
  };

  let players = await Player.find(query)
    .sort({ baseValue: -1, name: 1 })
    .limit(limit)
    .lean();

  if (!players.length && escapedQuery) {
    // Search can trigger an on-demand MLB sync so the UI can find a player who
    // is not yet in our local catalog but does exist upstream.
    const searchText = escapedQuery.replace(/\\(.)/g, '$1');
    const upsertedPlayers = await upsertPlayersByMlbSearch({ query: searchText });
    if (upsertedPlayers.length) {
      invalidateCatalogCache('search:');
      invalidateCatalogCache('players:');
      players = await Player.find(query)
        .sort({ baseValue: -1, name: 1 })
        .limit(limit)
        .lean();
    }
  }

  return players.map(serializePlayer);
}

function buildPlayerLookup(playerId) {
  // The API accepts either Mongo ids or MLB numeric ids depending on caller.
  // The webapp usually uses MLB ids, while some admin flows rely on _id.
  if (typeof playerId === 'number') {
    return { mlbPlayerId: playerId };
  }
  if (mongoose.isValidObjectId(playerId)) {
    return { _id: playerId };
  }
  return { mlbPlayerId: Number(playerId) };
}

async function getPlayerById(playerId) {
  let player = await Player.findOne(buildPlayerLookup(playerId)).lean();
  if (!player && typeof playerId === 'number') {
    // Numeric MLB ids are allowed to lazily hydrate missing players so direct
    // lookup by MLB id still works even if the catalog is slightly stale.
    const upserted = await upsertPlayerByMlbId(playerId);
    if (upserted) {
      invalidateCatalogCache(`player:${playerId}`);
      invalidateCatalogCache('players:');
      invalidateCatalogCache('search:');
      player = await Player.findOne(buildPlayerLookup(playerId)).lean();
    }
  }
  if (!player) {
    throw new AppError('Player not found', 404);
  }
  return serializePlayer(player);
}

async function getPlayerTransactions(playerId) {
  const player = await getPlayerById(playerId);
  return {
    playerId: player.mlbPlayerId,
    playerName: player.name,
    transactions: Array.isArray(player.transactions) ? player.transactions : [],
  };
}

async function getTeamDepthChart(teamId, season) {
  return fetchTeamDepthChart({ teamId, season });
}

module.exports = {
  getOpenApiDoc,
  getPlayerById,
  getPlayerTransactions,
  getTeamDepthChart,
  getValuationSnapshot,
  listPlayers,
  serializePlayer,
  searchPlayers,
};
