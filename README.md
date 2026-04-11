# AC Transit Live Bus Map

A real-time bus tracker for [AC Transit](https://www.actransit.org/) (Alameda-Contra Costa Transit District), serving the East Bay area of the San Francisco Bay Area. The app shows live vehicle positions on an interactive map, with route filtering, stop overlays, and recent position history trails.

**Live site:** [https://kuanb.github.io/actransit/](https://kuanb.github.io/actransit/)

## Features

- **Real-time bus positions** — vehicle locations update every 30 seconds via AC Transit's API
- **Route filtering** — type a route number to isolate specific buses and their stops (also settable via `?route=51` URL parameter)
- **Stop overlay** — transit stops appear at higher zoom levels; click a stop to filter to its routes
- **Position history** — hover or click a bus to see its recent position trail and connecting line
- **Vehicle details** — click a bus to see route, trip, bearing, speed, data age, and historical average speed
- **Cache age panel** — bottom-right panel shows the age range of cached vehicle positions

## Tech Stack

| Layer | Technology |
|-------|-----------|
| UI | React 19 + TypeScript |
| Map | MapLibre GL JS with MapTiler base tiles |
| Build | Vite |
| Lint | ESLint with typescript-eslint + react-hooks plugins |
| Hosting | GitHub Pages |
| CI/CD | GitHub Actions |
| Backend data | Val.run serverless functions (bus locations, history, stop predictions) |

## Prerequisites

This project requires **Node.js 24** (Active LTS). The repo includes `.nvmrc` and `.node-version` files so version managers pick it up automatically:

```bash
# nvm
nvm install
nvm use

# fnm
fnm install
fnm use

# Or any manager that reads .node-version (mise, asdf, volta, etc.)
```

Verify with `node --version` — you should see `v24.x.x`.

## Local Development

```bash
npm install
npm run dev
```

This starts a Vite dev server with hot module replacement at `http://localhost:5173`.

### Other Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Production build (outputs to `dist/`) |
| `npm run build-risky` | Production build with `/actransit/` base path (used by CI for GitHub Pages) |
| `npm run lint` | Run ESLint |
| `npm run preview` | Preview the production build locally |

## GitHub Pages Deployment

The site is automatically deployed to GitHub Pages on every push to `main`.

### How it works

The deployment is handled by `.github/workflows/deploy.yml` and runs in two jobs:

1. **Build** — checks out the repo, installs Node dependencies (via `bahmutov/npm-install`), and runs `npm run build-risky`. The `build-risky` script uses Vite's `--base=/actransit/` flag so all asset paths are relative to the GitHub Pages subdirectory. The resulting `dist/` folder is uploaded as a build artifact.

2. **Deploy** — downloads the artifact and publishes it to the `gh-pages` branch using `peaceiris/actions-gh-pages`. GitHub Pages serves the content of that branch.

### GitHub Pages configuration

In the repo's **Settings > Pages**, the source should be set to **Deploy from a branch** with the `gh-pages` branch and `/ (root)` directory. The `GITHUB_TOKEN` built into Actions has sufficient permissions — no additional secrets are needed for deployment.

### Base path

Because GitHub Pages serves this repo at `https://kuanb.github.io/actransit/` (a subdirectory, not the root), Vite must be told the base path. The `vite.config.ts` reads `process.env.BASE_URL` and falls back to `/`. The `build-risky` npm script passes `--base=/actransit/` to set this correctly for production.

## Daily GTFS Route Extraction

A separate GitHub Actions workflow (`daily_gtfs.yml`) runs once daily to maintain an always-current GeoJSON of AC Transit's route network.

### What it does

1. Downloads the official GTFS zip from `api.actransit.org` using an API token stored in the `ACTRANSIT_API_TOKEN` repo secret
2. Extracts `shapes.txt`, `trips.txt`, and `routes.txt` from the zip
3. Determines the feed's validity window from `feed_info.txt` (or `calendar.txt` as fallback)
4. Joins shapes to routes via trips, picks the longest shape per route as the representative geometry
5. Writes `latest_routes.geojson` — a GeoJSON FeatureCollection with route LineStrings and metadata (route name, color, type, feed vintage dates)
6. Commits and pushes the file if it changed

### Heartbeat mechanism

GitHub disables scheduled workflows after 60 days of repo inactivity. To prevent this, every run (success or failure) writes a `last_run.txt` timestamp file and commits it. This ensures the repo always has recent activity.

### Output files

| File | Purpose |
|------|---------|
| `latest_routes.geojson` | All AC Transit route geometries, updated daily |
| `last_run.txt` | UTC timestamp of last pipeline run (heartbeat) |

### Required secret

| Secret | Value |
|--------|-------|
| `ACTRANSIT_API_TOKEN` | API token for the AC Transit GTFS download endpoint |

## Project Structure

```
├── src/
│   ├── App.tsx          # Main app component (map, bus tracking, UI)
│   ├── main.tsx         # React entry point
│   └── index.css        # Global styles
├── extract_routes.py    # GTFS route extraction script (Python stdlib only)
├── .github/workflows/
│   ├── deploy.yml       # Build and deploy to GitHub Pages on push to main
│   └── daily_gtfs.yml   # Daily GTFS download and route GeoJSON extraction
├── index.html           # Vite HTML entry point
├── vite.config.ts       # Vite configuration
├── tsconfig.json        # TypeScript project references
├── tsconfig.app.json    # TypeScript config for app source
├── tsconfig.node.json   # TypeScript config for Node tooling
├── eslint.config.js     # ESLint flat config
├── package.json         # Dependencies and scripts
├── .nvmrc               # Node version for nvm / fnm
└── .node-version        # Node version for mise / asdf / volta
```
