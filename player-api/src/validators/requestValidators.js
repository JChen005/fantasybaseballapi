const mongoose = require('mongoose');
const { AppError } = require('../utils/appError');

function clamp(number, min, max) {
  return Math.min(Math.max(number, min), max);
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function parseLimit(rawLimit, fallback = 200) {
  const parsed = Number(rawLimit ?? fallback);
  if (!Number.isFinite(parsed)) {
    throw new AppError('limit must be a number', 400);
  }
  return clamp(Math.floor(parsed), 1, 500);
}

function parseSeason(rawSeason, fallback = new Date().getFullYear()) {
  if (rawSeason == null || rawSeason === '') return Number(fallback);
  const season = Number(rawSeason);
  if (!Number.isInteger(season) || season < 1900 || season > 3000) {
    throw new AppError('season must be a valid year', 400);
  }
  return season;
}

function parseSearchQuery(query = {}) {
  const includeDrafted = String(query.includeDrafted ?? 'true').toLowerCase() === 'true';
  const includeInactive = String(query.includeInactive ?? '').toLowerCase() === 'true';
  const limit = parseLimit(query.limit, 200);
  const leagueType = parseLeagueType(query.leagueType);
  const raw = String(query.q ?? '').trim();
  const q = raw.length > 80 ? raw.slice(0, 80) : raw;

  return {
    includeDrafted,
    includeInactive,
    limit,
    leagueType,
    q,
    escapedQuery: q ? escapeRegex(q) : '',
  };
}

function parseLeagueType(rawLeagueType) {
  if (rawLeagueType == null || rawLeagueType === '') return null;
  const normalized = String(rawLeagueType).trim().toUpperCase();
  if (normalized === 'MIXED') return null;
  if (normalized !== 'AL' && normalized !== 'NL') {
    throw new AppError('leagueType must be AL, NL, MIXED, or omitted', 400);
  }
  return normalized;
}

function parseIncludeInactive(rawIncludeInactive) {
  return String(rawIncludeInactive ?? '').trim().toLowerCase() === 'true';
}

function validatePlayerId(playerId) {
  const normalized = String(playerId || '').trim();
  if (!normalized) {
    throw new AppError('Invalid player ID', 400);
  }

  if (mongoose.isValidObjectId(normalized)) {
    return normalized;
  }

  const numericId = Number(normalized);
  if (Number.isInteger(numericId) && numericId > 0) {
    return numericId;
  }

  throw new AppError('Invalid player ID', 400);
}

function validateTeamId(teamId) {
  const numericId = Number(teamId);
  if (!Number.isInteger(numericId) || numericId <= 0) {
    throw new AppError('Invalid team ID', 400);
  }
  return numericId;
}

function validatePlayerReference(playerId, fieldName = 'playerId') {
  if (playerId == null || playerId === '') {
    throw new AppError(`Invalid ${fieldName}`, 400);
  }

  const normalized = String(playerId).trim();
  if (!normalized) {
    throw new AppError(`Invalid ${fieldName}`, 400);
  }

  if (mongoose.isValidObjectId(normalized)) {
    return normalized;
  }

  const numericId = Number(normalized);
  if (Number.isInteger(numericId) && numericId > 0) {
    return numericId;
  }

  throw new AppError(`Invalid ${fieldName}`, 400);
}

function parseRosterSlots(rosterSlots) {
  if (!rosterSlots || typeof rosterSlots !== 'object' || Array.isArray(rosterSlots)) {
    throw new AppError('league.rosterSlots is required', 400);
  }

  const normalized = {};
  let totalSlots = 0;

  for (const [slot, rawValue] of Object.entries(rosterSlots)) {
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new AppError(`league.rosterSlots.${slot} must be a non-negative integer`, 400);
    }
    normalized[slot] = parsed;
    totalSlots += parsed;
  }

  if (totalSlots <= 0) {
    throw new AppError('league.rosterSlots must include at least one slot', 400);
  }

  return normalized;
}

function parseDollarablePoolShare(rawValue) {
  if (rawValue == null || rawValue === '') {
    return 0.3;
  }

  const parsed = Number(rawValue);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 1) {
    throw new AppError('league.dollarablePoolShare must be a number between 0 and 1', 400);
  }

  return parsed;
}

function parseFilledSlots(rawFilledSlots, rosterSlots) {
  if (rawFilledSlots == null) {
    return {};
  }

  if (typeof rawFilledSlots !== 'object' || Array.isArray(rawFilledSlots)) {
    throw new AppError('draftState.filledSlots must be an object', 400);
  }

  const normalized = {};
  for (const [slot, rawValue] of Object.entries(rawFilledSlots)) {
    const parsed = Number(rawValue);
    if (!Number.isInteger(parsed) || parsed < 0) {
      throw new AppError(`draftState.filledSlots.${slot} must be a non-negative integer`, 400);
    }
    if (rosterSlots[slot] == null) {
      throw new AppError(`draftState.filledSlots.${slot} is not a valid roster slot`, 400);
    }
    if (parsed > rosterSlots[slot]) {
      throw new AppError(`draftState.filledSlots.${slot} cannot exceed league.rosterSlots.${slot}`, 400);
    }
    normalized[slot] = parsed;
  }

  return normalized;
}

function parseValuationRequest(body = {}) {
  const league = body.league;
  if (!league || typeof league !== 'object' || Array.isArray(league)) {
    throw new AppError('league is required', 400);
  }

  const rawBudget = Number(league.budget);
  if (!Number.isFinite(rawBudget) || rawBudget <= 0) {
    throw new AppError('league.budget must be a positive number', 400);
  }

  const rawTeamCount = Number(league.teamCount);
  if (!Number.isInteger(rawTeamCount) || rawTeamCount <= 0) {
    throw new AppError('league.teamCount must be a positive integer', 400);
  }

  const rosterSlots = parseRosterSlots(league.rosterSlots);
  const dollarablePoolShare = parseDollarablePoolShare(league.dollarablePoolShare);

  const filters = body.filters && typeof body.filters === 'object' && !Array.isArray(body.filters)
    ? body.filters
    : {};
  const search = String(filters.search ?? '').trim();
  if (search.length > 120) {
    throw new AppError('filters.search must be at most 120 characters', 400);
  }

  const excludedPlayersRaw = Array.isArray(body?.draftState?.excludedPlayers)
    ? body.draftState.excludedPlayers
    : [];

  const excludedPlayers = excludedPlayersRaw.map((entry, index) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new AppError(`draftState.excludedPlayers[${index}] must be an object`, 400);
    }

    const status = String(entry.status || '').trim().toUpperCase();
    if (!['DRAFTED', 'KEEPER', 'RESERVE', 'TAXI'].includes(status)) {
      throw new AppError(`draftState.excludedPlayers[${index}].status is invalid`, 400);
    }

    const cost = Number(entry.cost ?? 0);
    if (!Number.isFinite(cost) || cost < 0) {
      throw new AppError(`draftState.excludedPlayers[${index}].cost must be a non-negative number`, 400);
    }

    const countsAgainstBudget = Boolean(entry.countsAgainstBudget);

    return {
      playerId: validatePlayerReference(entry.playerId, `draftState.excludedPlayers[${index}].playerId`),
      status,
      cost,
      countsAgainstBudget,
    };
  });
  const filledSlots = parseFilledSlots(body?.draftState?.filledSlots, rosterSlots);

  return {
    league: {
      budget: rawBudget,
      teamCount: rawTeamCount,
      leagueType: parseLeagueType(league.leagueType),
      rosterSlots,
      dollarablePoolShare,
    },
    filters: {
      limit: parseLimit(filters.limit, 200),
      includeInactive: parseIncludeInactive(filters.includeInactive),
      search,
      escapedSearch: search ? escapeRegex(search) : '',
    },
    draftState: {
      excludedPlayers,
      filledSlots,
    },
  };
}

module.exports = {
  parseIncludeInactive,
  parseLeagueType,
  parseLimit,
  parseSearchQuery,
  parseSeason,
  parseValuationRequest,
  validatePlayerId,
  validatePlayerReference,
  validateTeamId,
};
