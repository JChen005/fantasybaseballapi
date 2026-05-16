# Fantasy Baseball API

This repo houses the standalone DraftKit Player API service in:

- `player-api/`

It is a separate backend from the DraftKit webapp. The webapp owns league state and persisted draft state. This repo owns player catalog data, valuation responses, depth charts, licensing, and admin refresh flows.

## Service Boundary

This repo is responsible for:

- player catalog storage
- player search and detail endpoints
- valuation snapshots (`baseValue`, `marketValue`, `adjustedValue`)
- MLB roster and depth-chart ingestion
- player transaction history storage on player records
- license enforcement for API consumers
- catalog refresh and admin utilities

This repo does not own:

- league CRUD
- keeper board state
- persisted draft room state
- draft slot assignment
- long-horizon roster optimization

Those concerns live in the DraftKit webapp backend.

## Repo Layout

```text
player-api/   Express + MongoDB Player API service
```

## Local Development

### Install

```bash
cd player-api
npm install
```

### Run locally

```bash
cd player-api
npm run dev
```

Default local port:

- `5050`

### Seed or refresh player data

```bash
cd player-api
npm run seed
```

### Tests

```bash
cd player-api
npm test
```

Optional verbose valuation fixture output:

```bash
cd player-api
npm run test:verbose
```

## Environment

Required:

- `MONGODB_URI`
- `ADMIN_SECRET`

Common optional flags:

- `AUTO_SEED`
- `PLAYER_SYNC_MAX_AGE_MINUTES`
- `PLAYER_SYNC_MIN_COVERAGE_RATIO`
- `PORT`

Notes:

- `ADMIN_SECRET` protects the admin routes under `/v1/admin/*`.
- `AUTO_SEED=true` enables automatic player sync on service startup.
- `PLAYER_SYNC_MAX_AGE_MINUTES` controls when an existing catalog is treated as stale.

## Core Endpoints

### Public

- `GET /v1/health`
- `GET /v1/docs/openapi`

### Licensed

- `GET /v1/license/status`
- `GET /v1/players`
- `GET /v1/players/search`
- `POST /v1/valuations/players`
- `GET /v1/players/:playerId`
- `GET /v1/players/:playerId/transactions`
- `GET /v1/teams/:teamId/depth-chart?season=YYYY`

### Admin

- `POST /v1/admin/licenses`
- `POST /v1/admin/data-refresh`
- `POST /v1/admin/mock-transaction`

## Valuation Model

Current valuation output has three layers:

- `baseValue`: stored player strength score built from synced stats and depth context
- `marketValue`: market-style auction value derived from the player pool
- `adjustedValue`: league-context value derived from market value plus draft context

The valuation endpoint is stateless. The caller provides draft context on each request, including:

- `league.budget`
- `league.teamCount`
- `league.rosterSlots`
- `league.leagueType`
- `league.dollarablePoolShare`
- `filters`
- `draftState.excludedPlayers`
- `draftState.filledSlots`

High-level valuation flow:

1. Start from stored `baseValue` on each player.
2. Remove unavailable players from the remaining market.
3. Build an auction pool and a wider market pool.
4. Compute replacement levels from those pools.
5. Convert above-replacement strength into `marketValue`.
6. Adjust `marketValue` for team budget state, team fit, scarcity, and `maxBid`.

The Player API does not persist draft-room state internally.

## Player Catalog Shape

Stored player records currently keep the fields the app still uses:

- identity and team: `name`, `mlbPlayerId`, `team`, `mlbLeague`
- roster fit inputs: `positions`, `injuryStatus`, `isActiveRoster`
- valuation inputs: `statsLastYear`, `stats3Year`, `baseValue`
- catalog flags: `isCustom`, `isDrafted`, `isMlbRelevant`
- presentation and history: `headshotUrl`, `transactions`
- sync bookkeeping: `lastSeenInSyncAt`, `lastSyncedAt`, `createdAt`, `updatedAt`

## Catalog And Sync Behavior

The player catalog is backed by MongoDB and refreshed from MLB roster and depth-chart data.

Important implementation behaviors:

- the service can auto-seed an empty catalog on first licensed request
- the service can force-refresh the catalog through `/v1/admin/data-refresh`
- player search can lazily hydrate missing MLB players on demand
- duplicate non-custom players with the same `mlbPlayerId` are cleaned up during reseed/index maintenance
- if old player documents still contain removed fields from a previous schema version, reseeding from a cleared player collection is the expected cleanup path

## Caching

Catalog-backed licensed endpoints use an in-process cache with per-route TTLs.

Current cache buckets in `playerRoutes.js`:

- players: 5 minutes
- search: 1 minute
- player detail: 5 minutes
- transactions: 1 minute
- depth chart: 5 minutes

Valuation responses are computed fresh per request and are not cached at the route layer.

## Main Files

- `player-api/src/app.js`
- `player-api/src/server.js`
- `player-api/api/index.js`
- `player-api/src/services/playerService.js`
- `player-api/src/services/valuationService.js`
- `player-api/src/services/mlbStatsService.js`
- `player-api/src/services/depthChartService.js`
- `player-api/src/services/seedService.js`
- `player-api/src/services/catalogCache.js`
- `player-api/src/routes/playerRoutes.js`
- `player-api/src/routes/adminRoutes.js`
- `player-api/src/routes/licenseRoutes.js`
- `player-api/src/routes/healthRoutes.js`
- `player-api/src/validators/requestValidators.js`
- `player-api/src/models/Player.js`

## Related Repo

The corresponding web application lives separately in the DraftKit webapp repo and calls this service over HTTP.
