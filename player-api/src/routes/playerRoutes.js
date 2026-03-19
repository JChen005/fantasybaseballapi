const express = require('express');
const { asyncHandler } = require('../utils/asyncHandler');
const { requireLicense } = require('../middleware/requireLicense');
const {
  parseLimit,
  parseSearchQuery,
  parseLeagueType,
  validatePlayerId,
} = require('../validators/requestValidators');
const {
  listPlayers,
  searchPlayers,
  getPlayerById,
  getPlayerTransactions,
  getLeagueAverages,
  getOpenApiDoc,
} = require('../services/playerService');
const { withCatalogCache } = require('../services/catalogCache');

const router = express.Router();
const CACHE_TTLS_MS = {
  players: 5 * 60 * 1000,
  search: 60 * 1000,
  player: 5 * 60 * 1000,
  transactions: 60 * 1000,
  leagueAverages: 10 * 60 * 1000,
};

router.get('/docs/openapi', (req, res) => {
  res.json(getOpenApiDoc());
});

router.use(requireLicense);

router.get(
  '/players',
  asyncHandler(async (req, res) => {
    const limit = parseLimit(req.query.limit, 200);
    const leagueType = parseLeagueType(req.query.leagueType);
    const key = `players:${limit}:${leagueType || 'MIXED'}`;
    const players = await withCatalogCache(key, CACHE_TTLS_MS.players, () =>
      listPlayers({ limit, leagueType })
    );
    res.json({ players });
  })
);

router.get(
  '/players/search',
  asyncHandler(async (req, res) => {
    const query = parseSearchQuery(req.query);
    const key = `search:${JSON.stringify(query)}`;
    const players = await withCatalogCache(key, CACHE_TTLS_MS.search, () => searchPlayers(query));
    res.json({ players });
  })
);

router.get(
  '/players/:playerId/transactions',
  asyncHandler(async (req, res) => {
    const playerId = validatePlayerId(req.params.playerId);
    const data = await withCatalogCache(`transactions:${playerId}`, CACHE_TTLS_MS.transactions, () =>
      getPlayerTransactions(playerId)
    );
    res.json(data);
  })
);

router.get(
  '/players/:playerId',
  asyncHandler(async (req, res) => {
    const playerId = validatePlayerId(req.params.playerId);
    const player = await withCatalogCache(`player:${playerId}`, CACHE_TTLS_MS.player, () =>
      getPlayerById(playerId)
    );
    res.json({ player });
  })
);

router.get(
  '/stats/league-averages',
  asyncHandler(async (req, res) => {
    const result = await withCatalogCache('league-averages', CACHE_TTLS_MS.leagueAverages, () =>
      getLeagueAverages()
    );
    res.json(result);
  })
);

module.exports = router;
