const mongoose = require('mongoose');
const Player = require('../models/Player');
const { AppError } = require('../utils/appError');
const { getTeamDepthChart: fetchTeamDepthChart } = require('./mlbStatsService');

// Default share of rosterable slots treated as dollarable in the auction pool.
const DEFAULT_DOLLARABLE_POOL_SHARE = 0.45;
// Prevent the market pool from getting too narrow even if the auction pool is tighter.
const MIN_MARKET_POOL_SHARE = 0.6;
// Sets the rough top-end target price as a share of total auction budget.
const MARKET_ELITE_BUDGET_SHARE = 0.2;
// Keep reserve-tier players cheap without collapsing the whole tail to exactly $1.
const BELOW_REPLACEMENT_VALUE_FLOOR = 1;
const BELOW_REPLACEMENT_VALUE_CEILING = 9;
// Make the replacement line visible by keeping rosterable players in double digits.
const ABOVE_REPLACEMENT_VALUE_FLOOR = 10;
// Scarcity stays modest: this is the lowest allowed positional multiplier.
const ROLE_SCARCITY_MIN_MULTIPLIER = 0.95;
// Cap positional scarcity so thin roles do not dominate the whole pricing model.
const ROLE_SCARCITY_MAX_MULTIPLIER = 1.12;
// Controls how strongly demand/supply ratio moves the scarcity multiplier.
const ROLE_SCARCITY_WEIGHT = 0.35;
// Count a role as "usable" for scarcity only if it clears this share of elite value.
const ROLE_SCARCITY_USABLE_VALUE_SHARE = 0.3;
// Clamp the final post-scarcity/post-team-fit multiplier to avoid runaway inflation.
const COMBINED_FIT_MIN_MULTIPLIER = 0.78;
const COMBINED_FIT_MAX_MULTIPLIER = 1.22;
// If both scarcity and team fit point the same direction, soften the team-fit bump.
const TEAM_FIT_OVERLAP_DAMPING = 0.65;

function withLeagueFilter(leagueType) {
  if (!leagueType) return {};
  return { mlbLeague: leagueType };
}

function withActiveFilter(includeInactive) {
  return includeInactive ? {} : { isActiveRoster: true };
}

function buildExcludedPlayerFilter(excludedPlayers = []) {
  const objectIds = [];
  const mlbPlayerIds = [];

  for (const entry of excludedPlayers) {
    if (typeof entry.playerId === 'string' && mongoose.isValidObjectId(entry.playerId)) {
      objectIds.push(new mongoose.Types.ObjectId(entry.playerId));
      continue;
    }

    const numericId = Number(entry.playerId);
    if (Number.isInteger(numericId) && numericId > 0) {
      mlbPlayerIds.push(numericId);
    }
  }

  if (!objectIds.length && !mlbPlayerIds.length) {
    return null;
  }

  const clauses = [];
  if (objectIds.length) {
    clauses.push({ _id: { $nin: objectIds } });
  }
  if (mlbPlayerIds.length) {
    clauses.push({ mlbPlayerId: { $nin: mlbPlayerIds } });
  }

  return clauses.length === 1 ? clauses[0] : { $and: clauses };
}

function withSearchFilter(escapedQuery) {
  if (!escapedQuery) return {};

  return {
    $or: [
      { name: { $regex: escapedQuery, $options: 'i' } },
      { canonicalName: { $regex: escapedQuery, $options: 'i' } },
      { team: { $regex: escapedQuery, $options: 'i' } },
      { positions: { $regex: escapedQuery, $options: 'i' } },
    ],
  };
}

function getRosterShape(rosterSlots = {}) {
  const totalSlots = Object.values(rosterSlots).reduce((sum, value) => sum + (Number(value) || 0), 0);
  const benchSlots = Number(rosterSlots.BN) || 0;
  const starterSlots = Math.max(0, totalSlots - benchSlots);

  return {
    totalSlots,
    starterSlots,
    benchSlots,
  };
}

function getOpenSlots(rosterSlots = {}, filledSlots = {}) {
  const openSlots = {};

  for (const [slot, total] of Object.entries(rosterSlots)) {
    openSlots[slot] = Math.max(0, (Number(total) || 0) - (Number(filledSlots[slot]) || 0));
  }

  return openSlots;
}

function normalizePositionToken(position) {
  const normalized = String(position || '').trim().toUpperCase();
  if (normalized === '1B' || normalized === 'B1') return '1B';
  if (normalized === '2B' || normalized === 'B2') return '2B';
  if (normalized === '3B' || normalized === 'B3') return '3B';
  if (normalized === 'SP' || normalized === 'RP' || normalized === 'P') return 'P';
  return normalized;
}

function getEligibleRosterSlots(player) {
  if (Array.isArray(player?.eligibleRosterSlots)) {
    return player.eligibleRosterSlots;
  }

  const rawPositions = Array.isArray(player.positions) ? player.positions : [];
  const normalizedPositions = new Set(
    rawPositions
      .map(normalizePositionToken)
      .filter((position) => ['C', '1B', '2B', '3B', 'SS', 'OF', 'P', 'UTIL', 'TWOWAYPLAYER'].includes(position))
  );

  const eligibleSlots = new Set();
  if (normalizedPositions.has('C')) eligibleSlots.add('C');
  if (normalizedPositions.has('1B')) eligibleSlots.add('1B');
  if (normalizedPositions.has('2B')) eligibleSlots.add('2B');
  if (normalizedPositions.has('3B')) eligibleSlots.add('3B');
  if (normalizedPositions.has('SS')) eligibleSlots.add('SS');
  if (normalizedPositions.has('OF')) eligibleSlots.add('OF');
  if (normalizedPositions.has('P') || normalizedPositions.has('TWOWAYPLAYER')) eligibleSlots.add('P');

  const isHitterEligible = [...normalizedPositions].some((position) => ['C', '1B', '2B', '3B', 'SS', 'OF'].includes(position));
  const isPitcherOnly = eligibleSlots.has('P') && !isHitterEligible;
  if (!isPitcherOnly && (isHitterEligible || normalizedPositions.has('TWOWAYPLAYER') || normalizedPositions.has('UTIL'))) {
    eligibleSlots.add('UTIL');
  }

  return [...eligibleSlots];
}

function getTeamFit(player, openSlots, hasFilledSlots) {
  if (!hasFilledSlots) {
    return {
      fillsNeed: false,
      eligibleSlots: getEligibleRosterSlots(player),
      teamFitMultiplier: 1,
    };
  }

  const eligibleSlots = getEligibleRosterSlots(player);
  const fillsNeed = eligibleSlots.some((slot) => (Number(openSlots[slot]) || 0) > 0);

  return {
    fillsNeed,
    eligibleSlots,
    teamFitMultiplier: fillsNeed ? 1.18 : 0.82,
  };
}

function buildRoleScarcityBySlot(players, league, usableValueThreshold) {
  const rosterSlots = league?.rosterSlots || {};
  const teamCount = Math.max(1, Number(league?.teamCount) || 1);
  const relevantSlots = Object.entries(rosterSlots)
    .filter(([slot, count]) => slot !== 'BN' && slot !== 'UTIL' && Number(count) > 0)
    .map(([slot]) => slot);
  const minimumBaseValue = Math.max(0, Number(usableValueThreshold) || 0);

  return Object.fromEntries(
    relevantSlots.map((slot) => {
      const demand = teamCount * Math.max(0, Number(rosterSlots[slot]) || 0);
      const supply = Math.max(
        1,
        players
          .filter((player) =>
            Number(player?.baseValue || 0) >= minimumBaseValue
            && getEligibleRosterSlots(player).includes(slot)
          )
          .length
      );
      const scarcityRatio = demand / supply;
      const rawMultiplier = 1 + ((scarcityRatio - 1) * ROLE_SCARCITY_WEIGHT);
      const multiplier = Math.min(
        ROLE_SCARCITY_MAX_MULTIPLIER,
        Math.max(ROLE_SCARCITY_MIN_MULTIPLIER, Number(rawMultiplier.toFixed(3)))
      );

      return [slot, multiplier];
    })
  );
}

function getRoleScarcityDetails(player, roleScarcityBySlot = {}) {
  const eligibleSlots = getEligibleRosterSlots(player).filter((slot) => slot in roleScarcityBySlot);

  if (!eligibleSlots.length) {
    return 1;
  }

  let bestSlot = eligibleSlots[0];
  for (const slot of eligibleSlots.slice(1)) {
    if ((roleScarcityBySlot[slot] || 1) > (roleScarcityBySlot[bestSlot] || 1)) {
      bestSlot = slot;
    }
  }

  return roleScarcityBySlot[bestSlot] || 1;
}

function combineFitMultipliers({ roleScarcityMultiplier, teamFitMultiplier }) {
  const scarcityPremium = (Number(roleScarcityMultiplier) || 1) - 1;
  const teamFitPremium = (Number(teamFitMultiplier) || 1) - 1;
  const dampedTeamFitPremium =
    scarcityPremium > 0 && teamFitPremium > 0
      ? teamFitPremium * TEAM_FIT_OVERLAP_DAMPING
      : teamFitPremium;
  const combined = 1 + scarcityPremium + dampedTeamFitPremium;

  return Math.min(
    COMBINED_FIT_MAX_MULTIPLIER,
    Math.max(COMBINED_FIT_MIN_MULTIPLIER, Number(combined.toFixed(3)))
  );
}

function getReplacementLevel(players, slotCount) {
  if (!slotCount || !players.length) return 0;
  const cappedIndex = Math.min(players.length, slotCount) - 1;
  return Math.max(0, Number(players[cappedIndex]?.baseValue) || 0);
}

function buildRankedPool(players, poolSize) {
  const sortedPlayers = [...players].sort((left, right) => right.baseValue - left.baseValue || left.name.localeCompare(right.name));
  const replacementLevel = getReplacementLevel(sortedPlayers, poolSize);
  const rosterablePlayers = new Set(sortedPlayers.slice(0, poolSize).map((player) => String(player._id)));

  return {
    poolSize,
    replacementLevel,
    rosterablePlayers,
  };
}

function buildAuctionPool(players, league) {
  const rosterShape = getRosterShape(league.rosterSlots);
  const dollarablePoolShare = Number.isFinite(Number(league.dollarablePoolShare))
    ? Number(league.dollarablePoolShare)
    : DEFAULT_DOLLARABLE_POOL_SHARE;
  const poolSize = Math.max(1, Math.round(rosterShape.starterSlots * league.teamCount * dollarablePoolShare));

  return {
    rosterShape,
    ...buildRankedPool(players, poolSize),
  };
}

function buildMarketPool(players, league) {
  const rosterShape = getRosterShape(league.rosterSlots);
  const marketPoolShare = Math.max(
    Number.isFinite(Number(league.dollarablePoolShare))
      ? Number(league.dollarablePoolShare)
      : DEFAULT_DOLLARABLE_POOL_SHARE,
    MIN_MARKET_POOL_SHARE
  );
  const poolSize = Math.max(1, Math.round(rosterShape.starterSlots * league.teamCount * marketPoolShare));

  return buildRankedPool(players, poolSize);
}

function computeAuctionBaseValue(player, auctionPool) {
  const playerId = String(player._id);
  const rosterable = auctionPool.rosterablePlayers.has(playerId);

  if (!rosterable) {
    return {
      rosterable: false,
      auctionBaseValue: 0,
      replacementLevel: auctionPool.replacementLevel,
    };
  }

  const replacementLevel = auctionPool.replacementLevel;

  return {
    rosterable: true,
    auctionBaseValue: Math.max(0, Number((Number(player.baseValue || 0) - replacementLevel).toFixed(2))),
    replacementLevel,
  };
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
    ...withSearchFilter(escapedQuery),
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

async function getTeamDepthChart(teamId, season) {
  return fetchTeamDepthChart({ teamId, season });
}

function toMarketWeight(auctionBaseValue) {
  const normalizedValue = Number(auctionBaseValue) || 0;
  if (normalizedValue <= 0) return 0;
  return Math.pow(normalizedValue, 0.6);
}

function getMarketEliteValueTarget(budget) {
  const normalizedBudget = Number(budget) || 0;
  if (normalizedBudget <= 0) return 0;
  return Math.max(10, Math.round(normalizedBudget * MARKET_ELITE_BUDGET_SHARE));
}

function computeBelowReplacementValue({
  player,
  marketReplacementLevel,
  teamFitMultiplier,
  maxBid,
}) {
  const safeReplacementLevel = Number(marketReplacementLevel) || 0;
  const safeBaseValue = Math.max(0, Number(player?.baseValue) || 0);
  const maxTailSpread = BELOW_REPLACEMENT_VALUE_CEILING - BELOW_REPLACEMENT_VALUE_FLOOR;

  if (maxBid <= 0) {
    return 0;
  }

  if (safeReplacementLevel <= 0 || maxTailSpread <= 0) {
    return Math.min(maxBid, BELOW_REPLACEMENT_VALUE_FLOOR);
  }

  const replacementRatio = Math.min(1, safeBaseValue / safeReplacementLevel);
  const rawTailValue = BELOW_REPLACEMENT_VALUE_FLOOR + (replacementRatio * maxTailSpread * teamFitMultiplier);

  return Math.min(
    BELOW_REPLACEMENT_VALUE_CEILING,
    maxBid,
    Math.max(BELOW_REPLACEMENT_VALUE_FLOOR, Math.round(rawTailValue))
  );
}

function getBudgetAdjustmentFactor({ remainingBudget, remainingRosterSpots, budget, totalSlots }) {
  const safeRemainingRosterSpots = Number(remainingRosterSpots) || 0;
  const safeTotalSlots = Number(totalSlots) || 0;
  const safeRemainingBudget = Number(remainingBudget) || 0;
  const safeBudget = Number(budget) || 0;

  if (safeRemainingRosterSpots <= 0 || safeTotalSlots <= 0 || safeRemainingBudget <= 0 || safeBudget <= 0) {
    return 0;
  }

  const currentDollarsPerSlot = safeRemainingBudget / safeRemainingRosterSpots;
  const baselineDollarsPerSlot = safeBudget / safeTotalSlots;
  if (baselineDollarsPerSlot <= 0) return 0;

  const rawFactor = currentDollarsPerSlot / baselineDollarsPerSlot;
  return Math.min(1.25, Math.max(0.65, Number(rawFactor.toFixed(3))));
}

async function getValuationSnapshot({
  league,
  filters,
  draftState,
}) {
  const poolQueryBase = {
    ...withLeagueFilter(league.leagueType),
    ...withActiveFilter(filters.includeInactive),
    isDrafted: false,
  };

  const excludedFilter = buildExcludedPlayerFilter(draftState.excludedPlayers);
  const poolQuery = excludedFilter
    ? { $and: [poolQueryBase, excludedFilter] }
    : poolQueryBase;
  const playerListQuery = filters.escapedSearch
    ? {
        $and: [
          poolQuery,
          withSearchFilter(filters.escapedSearch),
        ],
      }
    : poolQuery;

  const [players, poolPlayers] = await Promise.all([
    Player.find(playerListQuery)
      .sort({ baseValue: -1, canonicalName: 1, name: 1 })
      .limit(filters.limit)
      .lean(),
    Player.find(poolQuery)
      .select({
        _id: 1,
        name: 1,
        baseValue: 1,
        positions: 1,
        eligibility: 1,
      })
      .lean(),
  ]);
  const poolPlayersWithEligibleSlots = poolPlayers.map((player) => ({
    ...player,
    eligibleRosterSlots: getEligibleRosterSlots(player),
  }));
  const playersWithEligibleSlots = players.map((player) => ({
    ...player,
    eligibleRosterSlots: getEligibleRosterSlots(player),
  }));

  const auctionPool = buildAuctionPool(poolPlayersWithEligibleSlots, league);
  const marketPool = buildMarketPool(poolPlayersWithEligibleSlots, league);
  const auctionDetailsById = new Map(
    poolPlayersWithEligibleSlots.map((player) => {
      const details = computeAuctionBaseValue(player, auctionPool);
      return [String(player._id), details];
    })
  );
  const marketDetailsById = new Map(
    poolPlayersWithEligibleSlots.map((player) => {
      const playerId = String(player._id);
      const rosterable = marketPool.rosterablePlayers.has(playerId);
      const marketAuctionBaseValue = rosterable
        ? Math.max(0, Number((Number(player.baseValue || 0) - marketPool.replacementLevel).toFixed(2)))
        : 0;

      return [playerId, {
        rosterable,
        marketAuctionBaseValue,
      }];
    })
  );

  const maxRemainingMarketAuctionWeight = Number(
    poolPlayers
      .reduce((max, player) => {
        const marketAuctionBaseValue = marketDetailsById.get(String(player._id))?.marketAuctionBaseValue || 0;
        return Math.max(max, toMarketWeight(marketAuctionBaseValue));
      }, 0)
      .toFixed(2)
  );
  const spentBudget = draftState.excludedPlayers
    .filter((entry) => entry.countsAgainstBudget)
    .reduce((sum, entry) => sum + entry.cost, 0);
  const remainingBudget = Math.max(0, league.budget - spentBudget);
  const rosterShape = auctionPool.rosterShape;
  const filledRosterSpots = draftState.excludedPlayers.filter((entry) => entry.countsAgainstBudget).length;
  const remainingRosterSpots = Math.max(0, rosterShape.totalSlots - filledRosterSpots);
  const surplusBudget = Math.max(0, remainingBudget - remainingRosterSpots);
  const maxBid = remainingRosterSpots > 0 ? Math.max(0, remainingBudget - (remainingRosterSpots - 1)) : 0;
  const budgetAdjustmentFactor = getBudgetAdjustmentFactor({
    remainingBudget,
    remainingRosterSpots,
    budget: league.budget,
    totalSlots: rosterShape.totalSlots,
  });
  const openSlots = getOpenSlots(league.rosterSlots, draftState.filledSlots);
  const hasFilledSlots = Object.keys(draftState.filledSlots).length > 0;
  const marketEliteValueTarget = getMarketEliteValueTarget(league.budget);
  const roleScarcityUsableValueThreshold = marketEliteValueTarget * ROLE_SCARCITY_USABLE_VALUE_SHARE;
  const roleScarcityBySlot = buildRoleScarcityBySlot(
    poolPlayersWithEligibleSlots,
    league,
    roleScarcityUsableValueThreshold
  );

  return {
    valuation: {
      remainingBudget,
      remainingRosterSpots,
      surplusBudget,
      maxBid,
      startersPerTeam: rosterShape.starterSlots,
      benchPerTeam: rosterShape.benchSlots,
      marketEliteValueTarget,
      budgetAdjustmentFactor,
    },
    players: playersWithEligibleSlots.map((player) => {
      const auctionDetails = auctionDetailsById.get(String(player._id)) || {
        auctionBaseValue: 0,
        rosterable: false,
      };

      let adjustedValue = 0;
      let marketValue = 0;
      const teamFit = getTeamFit(player, openSlots, hasFilledSlots);
      const roleScarcityMultiplier = getRoleScarcityDetails(player, roleScarcityBySlot);
      const combinedFitMultiplier = combineFitMultipliers({
        roleScarcityMultiplier,
        teamFitMultiplier: teamFit.teamFitMultiplier,
      });
      if (auctionDetails.rosterable) {
        const marketDetails = marketDetailsById.get(String(player._id)) || {
          rosterable: false,
          marketAuctionBaseValue: 0,
        };
        if (marketDetails.rosterable) {
          marketValue = ABOVE_REPLACEMENT_VALUE_FLOOR;
          const marketWeight = toMarketWeight(marketDetails.marketAuctionBaseValue);
          if (marketWeight > 0 && maxRemainingMarketAuctionWeight > 0 && marketEliteValueTarget > 0) {
            marketValue = Math.max(
              ABOVE_REPLACEMENT_VALUE_FLOOR,
              Math.round((marketWeight / maxRemainingMarketAuctionWeight) * marketEliteValueTarget)
            );
          }
        }
        if (marketValue > 0 && budgetAdjustmentFactor > 0) {
          adjustedValue = Math.max(
            ABOVE_REPLACEMENT_VALUE_FLOOR,
            Math.round(marketValue * budgetAdjustmentFactor * combinedFitMultiplier)
          );
        }
        adjustedValue = Math.min(adjustedValue, maxBid);
      } else {
        marketValue = computeBelowReplacementValue({
          player,
          marketReplacementLevel: marketPool.replacementLevel,
          teamFitMultiplier: combinedFitMultiplier,
          maxBid,
        });
        adjustedValue = marketValue;
      }

      return {
        ...player,
        marketValue,
        rosterable: auctionDetails.rosterable,
        maxBid,
        adjustedValue,
      };
    }),
  };
}

function getOpenApiDoc() {
  return {
    openapi: '3.0.0',
    info: {
      title: 'DraftKit Player API',
      version: '0.1.0',
      description: 'Licensed player and valuation API for DraftKit, including push updates via Server-Sent Events.',
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
      '/v1/valuations/players': { post: { summary: 'League-aware player valuations', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/search': { get: { summary: 'Search players', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}': { get: { summary: 'Player details', security: [{ ApiKeyAuth: [] }] } },
      '/v1/players/{playerId}/transactions': { get: { summary: 'Player transactions', security: [{ ApiKeyAuth: [] }] } },
      '/v1/stats/league-averages': { get: { summary: 'League averages', security: [{ ApiKeyAuth: [] }] } },
      '/v1/teams/{teamId}/depth-chart': { get: { summary: 'Team depth chart', security: [{ ApiKeyAuth: [] }] } },
      '/v1/stream/transactions': { get: { summary: 'SSE stream for player transactions', security: [{ ApiKeyAuth: [] }] } },
      '/v1/admin/mock-transaction': { post: { summary: 'Publish mock transaction (admin secret)' } },
      '/v1/admin/data-refresh': { post: { summary: 'Refresh seed data' } },
    },
  };
}

module.exports = {
  getLeagueAverages,
  getOpenApiDoc,
  getPlayerById,
  getPlayerTransactions,
  getTeamDepthChart,
  getValuationSnapshot,
  listPlayers,
  searchPlayers,
};
