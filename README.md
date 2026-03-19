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

## Deployment

The repo includes a Render Blueprint at [`render.yaml`](./render.yaml).

Recommended production setup:

- Deploy `player-api` as a separate Render web service.
- Point `MONGODB_URI` at a hosted MongoDB instance such as Atlas.
- Set the shared `PLAYER_API_LICENSE_KEY` in both the Player API and the DraftKit backend.
- Set `PLAYER_API_LICENSE_CONSUMER` to the DraftKit app name you want stored in the local license record.

The service seeds player data from the CSV files under `player-api/data/nl` on startup when `AUTO_SEED=true`.

## Notes

- Player list/search/detail routes use lightweight in-memory caching to reduce repeated reads on cheap hosting plans.
- Admin mutations invalidate that cache so refreshes and mock transactions stay visible.
