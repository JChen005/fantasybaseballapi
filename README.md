# Player API (`@draftkit/player-api`)

Separate licensed Player API service for DraftKit.

This repo serves the player catalog, valuation engine, depth-chart data, transactions, and API docs from the `player-api` app. It is designed to run independently from `fantasybaseballwebapp`.

## Current Responsibilities

- licensed player catalog access
- stored `baseValue` generation during seed/sync
- valuation endpoint returning `baseValue`, `marketValue`, and `adjustedValue`
- MLB depth-chart ingestion and team depth-chart endpoint
- transaction streaming and admin refresh hooks

The Player API does not persist live draft room state. Draft state lives in the webapp backend and is sent to this service per valuation request.

## Required Environment

- `MONGODB_URI`
- `ADMIN_SECRET`
- `PLAYER_API_LICENSE_KEY`
- `PLAYER_API_LICENSE_CONSUMER` optional, defaults to `DraftKit Web App`
- `AUTO_SEED` optional, defaults to `true`
- `PORT` optional, defaults to `5050`

## Local Run

```bash
cd player-api
npm install
npm run dev
```

To reseed the player catalog:

```bash
cd player-api
npm run seed
```

## Public Endpoints

- `GET /v1/health`
- `GET /v1/docs/openapi`

## Licensed Endpoints

- `GET /v1/license/status`
- `GET /v1/players`
- `GET /v1/players/search`
- `POST /v1/valuations/players`
- `GET /v1/players/:playerId`
- `GET /v1/players/:playerId/transactions`
- `GET /v1/stats/league-averages`
- `GET /v1/teams/:teamId/depth-chart`
- `GET /v1/stream/transactions`

## Admin Endpoints

- `POST /v1/admin/data-refresh`
- `POST /v1/admin/mock-transaction`

## Valuation Model

The current valuation output has three layers:

- `baseValue`: internal strength score built from stats plus depth context
- `marketValue`: room-style auction price estimate
- `adjustedValue`: team-context price estimate using remaining budget and open-slot fit

Request-time draft context comes from the webapp and includes:

- `league`
- `filters`
- `draftState.excludedPlayers`
- `draftState.filledSlots`

The service does not store draft state internally.

## Notes

- Player list/search/detail routes use lightweight in-memory caching to reduce repeated reads on cheaper hosting plans.
- Admin mutations invalidate that cache so refreshes and mock transactions stay visible.
- Player reseed hard-cleans stale non-custom rows, removes duplicate `mlbPlayerId` rows, and enforces one canonical unique `mlbPlayerId` index for synced players.
