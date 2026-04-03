const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireLicense } = require('../middleware/requireLicense');
const {
  parseIncludeInactive,
  parseLeagueType,
  parseLimit,
  parseSearchQuery,
  parseSeason,
  parseValuationRequest,
  validatePlayerId,
  validateTeamId,
} = require('../validators/requestValidators');
const {
  getLeagueAverages,
  getOpenApiDoc,
  getPlayerById,
  getPlayerTransactions,
  getTeamDepthChart,
  getValuationSnapshot,
  listPlayers,
  searchPlayers,
} = require('../services/playerService');
const { withCatalogCache } = require('../services/catalogCache');
const { ensurePlayerCatalogReady } = require('../services/seedService');

const router = express.Router();
const CACHE_TTLS_MS = {
  players: 5 * 60 * 1000,
  search: 60 * 1000,
  player: 5 * 60 * 1000,
  transactions: 60 * 1000,
  leagueAverages: 10 * 60 * 1000,
  depthChart: 5 * 60 * 1000,
};

router.get('/docs/openapi', (req, res) => {
  res.json(getOpenApiDoc());
});

router.use(requireLicense);
router.use(asyncHandler(async (req, res, next) => {
  await ensurePlayerCatalogReady();
  next();
}));

router.get('/players', asyncHandler(async (req, res) => {
  const limit = parseLimit(req.query.limit, 200);
  const leagueType = parseLeagueType(req.query.leagueType);
  const includeInactive = parseIncludeInactive(req.query.includeInactive);
  const key = `players:${limit}:${leagueType || 'MIXED'}:${includeInactive ? 'all' : 'active'}`;
  const players = await withCatalogCache(key, CACHE_TTLS_MS.players, () =>
    listPlayers({ limit, leagueType, includeInactive })
  );
  res.json({ players });
}));

router.get('/players/search', asyncHandler(async (req, res) => {
  const query = parseSearchQuery(req.query);
  const key = `search:${JSON.stringify(query)}`;
  const players = await withCatalogCache(key, CACHE_TTLS_MS.search, () => searchPlayers(query));
  res.json({ players });
}));

router.post('/valuations/players', asyncHandler(async (req, res) => {
  const valuationRequest = parseValuationRequest(req.body || {});
  const result = await getValuationSnapshot(valuationRequest);
  res.json(result);
}));

router.get('/players/:playerId/transactions', asyncHandler(async (req, res) => {
  const playerId = validatePlayerId(req.params.playerId);
  const data = await withCatalogCache(`transactions:${playerId}`, CACHE_TTLS_MS.transactions, () =>
    getPlayerTransactions(playerId)
  );
  res.json(data);
}));

router.get('/players/:playerId', asyncHandler(async (req, res) => {
  const playerId = validatePlayerId(req.params.playerId);
  const player = await withCatalogCache(`player:${playerId}`, CACHE_TTLS_MS.player, () =>
    getPlayerById(playerId)
  );
  res.json({ player });
}));

router.get('/teams/:teamId/depth-chart', asyncHandler(async (req, res) => {
  const teamId = validateTeamId(req.params.teamId);
  const season = parseSeason(req.query.season);
  const key = `depth-chart:${teamId}:${season}`;
  const depthChart = await withCatalogCache(key, CACHE_TTLS_MS.depthChart, () =>
    getTeamDepthChart(teamId, season)
  );
  res.json(depthChart);
}));

router.get('/stats/league-averages', asyncHandler(async (req, res) => {
  const result = await withCatalogCache('league-averages', CACHE_TTLS_MS.leagueAverages, () =>
    getLeagueAverages()
  );
  res.json(result);
}));

module.exports = router;
