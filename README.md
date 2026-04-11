# Fantasy Baseball API

This repo houses the standalone DraftKit Player API service in:

- `player-api/`

It is a separate backend from the webapp. The webapp owns league state and persisted draft state. This repo owns player data, valuation responses, depth charts, licensing, and admin refresh flows.

## Service Boundary

This repo is responsible for:

- player catalog storage
- player search and detail endpoints
- valuation snapshots (`baseValue`, `marketValue`, `adjustedValue`)
- MLB roster and depth-chart ingestion
- transaction streaming
- license enforcement for API consumers

This repo does not own:

- league CRUD
- keeper board state
- persisted draft room state
- draft slot assignment
- webapp-specific roster-fit rules

Those concerns live in the DraftKit webapp backend.

## Repo Layout

```text
player-api/   Express + MongoDB Player API service
```

## Local Development

### Install

```bash
cd /player-api
npm install
```

### Run locally

```bash
cd /player-api
npm run dev
```

Default local port:

- `5050`

### Seed or refresh player data

```bash
cd /player-api
npm run seed
```

## Environment

The exact environment depends on deployment, but the main service expects:

- `MONGODB_URI`
- `PLAYER_API_ADMIN_SECRET`

Common optional flags:

- `AUTO_SEED`
- `SEED_SEASON`
- `PLAYER_SYNC_MAX_AGE_MS`
- `PLAYER_SYNC_MIN_COVERAGE_RATIO`
- `PORT`

## Core Endpoints

### Public

- `GET /v1/health`

### Licensed

- `GET /v1/license/status`
- `GET /v1/players`
- `GET /v1/players/search`
- `POST /v1/valuations/players`
- `GET /v1/players/:playerId`
- `GET /v1/players/:playerId/transactions`
- `GET /v1/stats/league-averages`
- `GET /v1/teams/:teamId/depth-chart`
- `GET /v1/stream/transactions`

### Admin

- `POST /v1/admin/data-refresh`
- `POST /v1/admin/mock-transaction`

## Valuation Model

Current valuation output has three layers:

- `baseValue`: stored player strength score built from synced stats and depth context
- `marketValue`: market-style auction value derived from the player pool
- `adjustedValue`: league-context value derived from market value plus draft context

Request-time draft context is provided by the webapp and includes:

- `league`
- `filters`
- `draftState.excludedPlayers`
- `draftState.filledSlots`

The Player API does not persist draft state internally.

## Main Files

- `player-api/src/app.js`
- `player-api/src/server.js`
- `player-api/api/index.js`
- `player-api/src/services/playerService.js`
- `player-api/src/services/mlbStatsService.js`
- `player-api/src/services/seedService.js`
- `player-api/src/routes/playerRoutes.js`
- `player-api/src/routes/adminRoutes.js`
- `player-api/src/validators/requestValidators.js`

## Related Repo

The corresponding web application lives separately in the DraftKit webapp repo and calls this service over HTTP.
