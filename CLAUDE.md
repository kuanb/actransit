# CLAUDE.md

Project context for AI assistants working on this codebase.

## What this project is

AC Transit Live Bus Map — a React/TypeScript single-page app that shows real-time AC Transit bus positions on a MapLibre GL map, deployed to GitHub Pages. A separate Python script runs daily via GitHub Actions to extract GTFS route geometries into a GeoJSON file committed to the repo.

## Node version

Requires Node.js 24 (Active LTS, codename Krypton). Pinned via `.nvmrc`, `.node-version`, and `engines` in `package.json`. Run `nvm use` or `fnm use` to activate.

## Commands

- `nvm use` / `fnm use` — activate the correct Node version
- `npm install` — install dependencies
- `npm run dev` — start Vite dev server (http://localhost:5173)
- `npm run build` — production build to `dist/`
- `npm run build-risky` — production build with `--base=/actransit/` for GitHub Pages
- `npm run lint` — run ESLint
- `python extract_routes.py` — run GTFS extraction (requires `ACTRANSIT_API_TOKEN` env var)

## Architecture

### Frontend (src/)

Single-component React app in `src/App.tsx`. The `ACTransitMap` component owns all state and renders a full-viewport MapLibre map with overlay panels. No routing, no component library, no state management beyond React hooks.

Data sources (all fetched client-side from Val.run endpoints):
- `https://actransit.val.run/bus_locations` — current vehicle positions
- `https://actransit.val.run/bus_locations_history` — recent position history (array of snapshots)
- `https://actransit.val.run/route_stop_predictions` — stop locations and route associations

Map layers: `buses` (current positions as bus icons), `busesHistory` (faded historical positions), `busesHistoryLines` (trail lines), `stops` (stop circles visible at zoom >= 13).

### GTFS Pipeline (extract_routes.py)

Pure Python stdlib script (csv, json, zipfile, urllib). Downloads GTFS zip from AC Transit API, joins shapes → trips → routes, picks the longest shape per route, writes `latest_routes.geojson`. Outputs vintage info to `GITHUB_OUTPUT` for the workflow commit message.

### CI/CD (.github/workflows/)

Two workflows:
- `deploy.yml` — builds and deploys the React app to GitHub Pages on push to main
- `daily_gtfs.yml` — daily cron that runs `extract_routes.py`, commits results, writes a `last_run.txt` heartbeat to prevent GitHub from disabling the scheduled workflow

## Code style

- Commit messages: lowercase type prefix (`feat:`, `fix:`, `chore:`, `ui:`) followed by short description
- TypeScript: strict mode, no unused locals/params
- The app uses inline styles rather than CSS classes for component styling
- ESLint flat config with react-hooks and react-refresh plugins

## Secrets

- `ACTRANSIT_API_TOKEN` — GitHub Actions secret for the GTFS download endpoint. Never hardcoded.
- MapTiler key is embedded in the source (public-facing tile key, not a secret)

## Key files

| File | What it does |
|------|-------------|
| `src/App.tsx` | Entire frontend app (~1200 lines, single component) |
| `extract_routes.py` | GTFS-to-GeoJSON extraction script |
| `.github/workflows/deploy.yml` | GitHub Pages deploy pipeline |
| `.github/workflows/daily_gtfs.yml` | Daily GTFS extraction pipeline |
| `vite.config.ts` | Vite config (base path handling) |
| `latest_routes.geojson` | Generated output — all AC Transit route geometries |
| `last_run.txt` | Heartbeat timestamp from last GTFS pipeline run |
| `.nvmrc` / `.node-version` | Pin Node.js version for local dev and CI |
