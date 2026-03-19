# Player API (`@draftkit/player-api`)

Separate Player API service for DraftKit.

This repo serves the licensed player catalog directly from the `player-api` app and is meant to be deployed independently from `fantasybaseballwebapp`.

## What It Needs

- `MONGODB_URI`
- `ADMIN_SECRET`
- `PLAYER_API_LICENSE_KEY`
- `PLAYER_API_LICENSE_CONSUMER` optional, defaults to `DraftKit Web App`
- `AUTO_SEED` optional, defaults to `true`

## Local Run

```bash
cd player-api
npm install
npm run dev
```

## Endpoints

Public:

- `GET /v1/health`
- `GET /v1/docs/openapi`

Licensed:

- `GET /v1/license/status`
- `GET /v1/players`
- `GET /v1/players/search`
- `GET /v1/players/:playerId`
- `GET /v1/players/:playerId/transactions`
- `GET /v1/stats/league-averages`
- `GET /v1/stream/transactions`

Admin:

- `POST /v1/admin/data-refresh`
- `POST /v1/admin/mock-transaction`

## Notes

- Player list/search/detail routes use lightweight in-memory caching to reduce repeated reads on cheap hosting plans.
- Admin mutations invalidate that cache so refreshes and mock transactions stay visible.
