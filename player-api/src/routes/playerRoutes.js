const express = require("express");
const { asyncHandler } = require("../utils/asyncHandler");
const { requireLicense } = require("../middleware/requireLicense");
const {
  parseIncludeInactive,
  parseLeagueType,
  parseLimit,
  parseSearchQuery,
  parseSeason,
  parseValuationRequest,
  validatePlayerId,
  validateTeamId,
} = require("../validators/requestValidators");
const {
  getOpenApiDoc,
  getPlayerById,
  getPlayerTransactions,
  getTeamDepthChart,
  getValuationSnapshot,
  listPlayers,
  searchPlayers,
} = require("../services/playerService");
const { withCatalogCache } = require("../services/catalogCache");
const { ensurePlayerCatalogReady } = require("../services/seedService");

const router = express.Router();
const CACHE_TTLS_MS = {
  players: 5 * 60 * 1000,
  search: 60 * 1000,
  player: 5 * 60 * 1000,
  transactions: 60 * 1000,
  depthChart: 5 * 60 * 1000,
};

// doesn't require licensing/key
router.get("/docs/openapi", (req, res) => {
  res.json(getOpenApiDoc());
});

// endpoints after this do require licensing/key
router.use(requireLicense);

// player catalog is needed for every licensed endpoint
router.use(
  asyncHandler(async (req, res, next) => {
    await ensurePlayerCatalogReady();
    next();
  }),
);

// return list of players from player catalog
router.get(
  "/players",
  asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit, 200);
    const leagueType = parseLeagueType(req.query.leagueType);
    const includeInactive = parseIncludeInactive(req.query.includeInactive);

    // build cache key for this exact request
    const key = `players:${limit}:${leagueType || "MIXED"}:${includeInactive ? "all" : "active"}`;
    // check cache or do the mongo query
    const players = await withCatalogCache(key, CACHE_TTLS_MS.players, () =>
      listPlayers({ limit, leagueType, includeInactive }),
    );
    res.json({ players });
  }),
);

// user enter text to search for players
router.get(
  "/players/search",
  asyncHandler(async (req, res) => {
    const query = parseSearchQuery(req.query);
    const key = `search:${JSON.stringify(query)}`;
    const players = await withCatalogCache(key, CACHE_TTLS_MS.search, () =>
      searchPlayers(query),
    );
    res.json({ players });
  }),
);

// return team-specific valuations for players based on draft context
// two teams can get diff val for same player
// diff moments in time produce diff player values
router.post(
  "/valuations/players",
  asyncHandler(async (req, res) => {
    const valuationRequest = parseValuationRequest(req.body || {});
    const result = await getValuationSnapshot(valuationRequest);
    res.json(result);
  }),
);

// get player transaction history given player id
router.get(
  "/players/:playerId/transactions",
  asyncHandler(async (req, res) => {
    const playerId = validatePlayerId(req.params.playerId);
    const data = await withCatalogCache(
      `transactions:${playerId}`,
      CACHE_TTLS_MS.transactions,
      () => getPlayerTransactions(playerId),
    );
    res.json(data);
  }),
);

// get one player given playerId
router.get(
  "/players/:playerId",
  asyncHandler(async (req, res) => {
    const playerId = validatePlayerId(req.params.playerId);
    const player = await withCatalogCache(
      `player:${playerId}`,
      CACHE_TTLS_MS.player,
      () => getPlayerById(playerId),
    );
    res.json({ player });
  }),
);

// get team depth chart given teamId
router.get(
  "/teams/:teamId/depth-chart",
  asyncHandler(async (req, res) => {
    const teamId = validateTeamId(req.params.teamId);
    const season = parseSeason(req.query.season);
    const key = `depth-chart:${teamId}:${season}`;
    const depthChart = await withCatalogCache(
      key,
      CACHE_TTLS_MS.depthChart,
      () => getTeamDepthChart(teamId, season),
    );
    res.json(depthChart);
  }),
);

module.exports = router;
