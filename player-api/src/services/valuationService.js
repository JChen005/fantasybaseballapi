const mongoose = require('mongoose');
const Player = require('../models/Player');

// The valuation endpoint is intentionally stateless: the webapp sends the draft
// context on each request and this service computes a fresh snapshot from that.

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
  return includeInactive ? {} : { isMlbRelevant: true };
}

function buildExcludedPlayerFilter(excludedPlayers = []) {
  // The webapp sends every unavailable player in the league. We remove those
  // players from both the displayed result set and the larger valuation pool so
  // price calculations only consider players who are still obtainable.
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

  // Search is intentionally broad because these routes power UI typeaheads.
  // We match across human-friendly fields instead of relying on exact ids.
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
  // Bench spots count toward total roster size, but not toward the starter pool
  // used for replacement level and auction-pool sizing.
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

  // This is team-specific draft context. A slot is "open" only relative to the
  // selected team's current roster state, not the whole league.
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

  // The webapp draft UI and scarcity model both depend on these normalized
  // roster buckets, so this mapping is intentionally conservative.
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

  // Team fit is deliberately simple: we only distinguish between players who
  // can help fill an open slot right now and players who would be surplus.
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
      // Demand comes from league settings. Supply comes from players who are
      // both strong enough to matter and eligible for that slot.
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
  // Scarcity and team fit are separate ideas:
  // 1. scarcity answers "how thin is this position league-wide?"
  // 2. team fit answers "does this player help the requesting team right now?"
  // We dampen overlapping positives so we do not double-count the same signal.
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
  // Replacement level is defined by rank inside a synthetic roster-sized pool.
  // That line becomes the baseline for later market/auction calculations.
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
  // Auction pool answers: "which players are realistically worth draft dollars
  // in this league format?" It is narrower than the overall player catalog.
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
  // Market pool is similar to auction pool but intentionally a bit wider so
  // prices do not become too top-heavy in shallow or unusual league settings.
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
    // Base auction value is the amount of value above the replacement line.
    auctionBaseValue: Math.max(0, Number((Number(player.baseValue || 0) - replacementLevel).toFixed(2))),
    replacementLevel,
  };
}

function toMarketWeight(auctionBaseValue) {
  const normalizedValue = Number(auctionBaseValue) || 0;
  if (normalizedValue <= 0) return 0;
  // Power scaling compresses elite players a bit so one superstar does not
  // consume an unrealistic share of the entire auction economy.
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

  // Below-replacement players still get a small non-zero value so the tail of
  // the pool is usable in the UI and feels like a real auction list.
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

  // This is the main "draft state" adjustment. If a team has more money left
  // per open slot than the original league baseline, valuations should rise.
  const rawFactor = currentDollarsPerSlot / baselineDollarsPerSlot;
  return Math.min(1.25, Math.max(0.65, Number(rawFactor.toFixed(3))));
}

function buildMarketDetailsById(players, marketPool) {
  return new Map(
    players.map((player) => {
      const playerId = String(player._id);
      const rosterable = marketPool.rosterablePlayers.has(playerId);
      const marketAuctionBaseValue = rosterable
        ? Math.max(0, Number((Number(player.baseValue || 0) - marketPool.replacementLevel).toFixed(2)))
        : 0;

      return [playerId, {
        rosterable,
        // Market auction base value uses the wider market pool replacement line,
        // not the tighter auction pool replacement line.
        marketAuctionBaseValue,
      }];
    })
  );
}

function computeRosterBudgetState({ draftState, league, rosterShape }) {
  // Budget state follows the requesting team's exclusions, not filledSlots alone.
  // That mirrors how the webapp tracks keepers/minors/drafted players today.
  const budgetEntries = draftState.excludedPlayers.filter((entry) => entry.countsAgainstBudget);
  const spentBudget = budgetEntries.reduce((sum, entry) => sum + entry.cost, 0);
  const remainingBudget = Math.max(0, league.budget - spentBudget);
  const filledRosterSpots = budgetEntries.length;
  const remainingRosterSpots = Math.max(0, rosterShape.totalSlots - filledRosterSpots);
  const surplusBudget = Math.max(0, remainingBudget - remainingRosterSpots);
  const maxBid = remainingRosterSpots > 0 ? Math.max(0, remainingBudget - (remainingRosterSpots - 1)) : 0;

  return {
    remainingBudget,
    remainingRosterSpots,
    surplusBudget,
    maxBid,
  };
}

function buildValuationRow({
  player,
  auctionDetailsById,
  marketDetailsById,
  marketPool,
  maxRemainingMarketAuctionWeight,
  marketEliteValueTarget,
  budgetAdjustmentFactor,
  maxBid,
  openSlots,
  hasFilledSlots,
  roleScarcityBySlot,
}) {
  const playerId = String(player._id);
  const auctionDetails = auctionDetailsById.get(playerId) || {
    auctionBaseValue: 0,
    rosterable: false,
  };
  const teamFit = getTeamFit(player, openSlots, hasFilledSlots);
  const roleScarcityMultiplier = getRoleScarcityDetails(player, roleScarcityBySlot);
  const combinedFitMultiplier = combineFitMultipliers({
    roleScarcityMultiplier,
    teamFitMultiplier: teamFit.teamFitMultiplier,
  });
  let adjustedValue = 0;
  let marketValue = 0;

  if (auctionDetails.rosterable) {
    const marketDetails = marketDetailsById.get(playerId) || {
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
      // adjustedValue is the final "what should this team pay right now?" value.
      // It starts from market price, then applies draft-state and fit context.
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
    fillsNeed: teamFit.fillsNeed,
    eligibleSlots: teamFit.eligibleSlots,
    maxBid,
    adjustedValue,
  };
}

async function getValuationSnapshot({
  league,
  filters,
  draftState,
}) {
  // We run two related queries:
  // 1. a limited result set to return to the caller
  // 2. a full available-player pool for league-wide valuation math
  // The response list can be filtered/searched, but pricing still needs the
  // broader market context from the entire remaining player pool.
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

  // eligibleRosterSlots is derived once up front and then reused by several
  // later steps (team fit, scarcity, and the returned response fields).
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
  const marketDetailsById = buildMarketDetailsById(poolPlayersWithEligibleSlots, marketPool);

  const maxRemainingMarketAuctionWeight = Number(
    poolPlayers
      .reduce((max, player) => {
        const marketAuctionBaseValue = marketDetailsById.get(String(player._id))?.marketAuctionBaseValue || 0;
        return Math.max(max, toMarketWeight(marketAuctionBaseValue));
      }, 0)
      .toFixed(2)
  );
  const rosterShape = auctionPool.rosterShape;
  const rosterBudgetState = computeRosterBudgetState({ draftState, league, rosterShape });
  const budgetAdjustmentFactor = getBudgetAdjustmentFactor({
    remainingBudget: rosterBudgetState.remainingBudget,
    remainingRosterSpots: rosterBudgetState.remainingRosterSpots,
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

  // The response mirrors what the webapp needs:
  // - valuation: team-level budget context
  // - players: per-player prices and roster-fit signals
  return {
    valuation: {
      remainingBudget: rosterBudgetState.remainingBudget,
      remainingRosterSpots: rosterBudgetState.remainingRosterSpots,
      surplusBudget: rosterBudgetState.surplusBudget,
      maxBid: rosterBudgetState.maxBid,
      startersPerTeam: rosterShape.starterSlots,
      benchPerTeam: rosterShape.benchSlots,
      marketEliteValueTarget,
      budgetAdjustmentFactor,
    },
    players: playersWithEligibleSlots.map((player) => buildValuationRow({
      player,
      auctionDetailsById,
      marketDetailsById,
      marketPool,
      maxRemainingMarketAuctionWeight,
      marketEliteValueTarget,
      budgetAdjustmentFactor,
      maxBid: rosterBudgetState.maxBid,
      openSlots,
      hasFilledSlots,
      roleScarcityBySlot,
    })),
  };
}

module.exports = {
  getValuationSnapshot,
};
