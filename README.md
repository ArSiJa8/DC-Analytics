# DC-Analytics

Discord member & online tracker using public invite counts, SQLite, Bun, and ApexCharts.

## Run

```bash
bun run start
```

URL: `http://localhost:47391`

## Docker / Coolify

```bash
docker compose up -d --build
```

- DB volume: `/app/data` (`dc_analytics_data`)
- `PORT`: `47391`
- `ADMIN_PASSWORD`: password required to add, sync, or remove servers (read-only is public)
- `COLLECT_INTERVAL_MIN`: `15` (min `5`)
- `DB_PATH`: `./data/analytics.db` (`/app/data/analytics.db` in Docker)
- `INVITE_CODES`: comma-separated startup seeds
