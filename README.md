# DC-Analytics

Minimal Discord server member & online tracker using the public Discord Invite API (`with_counts=true`), SQLite, Bun, and Chart.js.

## Start

```bash
bun run start
```

Open `http://localhost:47391` and add a public Discord invite code (e.g. `minecraft` or `https://discord.gg/minecraft`).

## Docker / Coolify

```bash
docker compose up -d --build
```

The SQLite database is stored in `/app/data/analytics.db` (persisted via Docker volume `dc_analytics_data` across stops, rebuilds, and redeploys). If deploying only via `Dockerfile` in Coolify, mount a persistent storage volume to `/app/data`.

## Environment Variables

- `PORT` (default `47391`)
- `COLLECT_INTERVAL_MIN` (default `15`, minimum `5`)
- `DB_PATH` (default `./data/analytics.db`)
- `INVITE_CODES` (optional comma-separated invite codes to seed on startup)
