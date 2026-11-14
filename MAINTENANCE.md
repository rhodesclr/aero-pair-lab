# Maintenance note

Short reference so future work doesn't have to rediscover the setup. No secrets are used anywhere in this project.

## What runs where
- **Site:** static files (index.html, app.js, sim.js, live.js, styles.css, sw.js) on GitHub Pages: https://rhodesclr.github.io/aero-pair-lab/
  - No backend, database, logins, user data or AI calls.
  - Tabs: Pair Lab (default), `#sim` (Aero LP Simulator), `#uni` (Uniswap simulator).
- **Hourly job:** `.github/workflows/refresh.yml` (cron at :07 UTC; GitHub usually starts it 30-50 min late, which is normal). It does three things:
  1. Runs `scripts/refresh.sh`. That rebuilds `data.json` from DEX Screener, GeckoTerminal, CoinGecko, Coinbase and public RPCs, then `hist.json` (daily on-chain pool history, `scripts/hist.py`).
  2. Runs `scripts/check.py`, then deploys to Pages.
  3. Commits `data.json`/`hist.json` once the saved copy is 20+ hours old. That keeps `hist.json` complete (each run only backfills 6 missing days) and counts as repo activity, so GitHub doesn't pause the schedule after 60 quiet days.
- **Safety nets:**
  - refresh.sh restores the previous `data.json` if the new one looks wrong (fewer than 60 assets, fewer than 300 pools, or more than 5 stale prices).
  - Scheduled runs only deploy fresh data.
  - The `alert` job opens the GitHub issue "Hourly data refresh is failing" (GitHub emails you) when live data is 3+ hours old, and closes it when things recover.
- **In the browser:**
  - Pool TVL and volume come from DEX Screener every 60 s, but only while the tab is visible.
  - Price history comes from GeckoTerminal, queued at about 1 request per 2.2 s. Failures get two paused retries (15 s, 30 s), and a failed pool can be retried 5 minutes later. Results are cached for 30 min in localStorage.
  - On-chain state comes from public RPCs (Base, OP, Robinhood Chain).

## Costs
- GitHub Actions (standard runners, public repo) and GitHub Pages are free.
- All data APIs are free public tiers with no keys.
- If the repo were made private, the hourly job (~8 min x 24/day) would use paid Actions minutes.

## Known issues / decisions
- Base moved from 2 s to 0.2 s blocks around 2026-11-05. Block lookups use timestamp search (`block_at` in hist.py, `blockAt` in live.js), so don't assume a fixed block time.
- AEROSTRAT prices come from its AEROSTRAT/AERO pool on GeckoTerminal (CoinGecko history is too short).
- Thin tokens (e.g. AEROSTRAT) show low hourly correlation because many hours have no trades.
- GeckoTerminal rate-limit replies lack CORS headers, so the browser sees them as network errors (handled as retryable).
- A run on 2026-11-11 was cancelled after 15 min with no surviving logs. It was a one-off and recovered on its own.
- Chart.js and lightweight-charts load from jsdelivr/unpkg (pinned versions). If those CDNs are down, charts won't draw.

## Routine tasks
- **Check health:** run `python3 scripts/check.py` from the repo root (it needs Node for the JS check).
- **Manual refresh:** Actions -> "Hourly data refresh + deploy" -> Run workflow.
- **Add a stock token:** add it to `STOCKS` in `scripts/build.py`. The job log prints `new_eligible_stocks`.
- **Add a crypto asset:** add it to `C` in `scripts/crypto_pools.py` (plus `GTONLY`/`CGONLY` in build.py if CoinGecko/Coinbase lack history), then add it to a preset in app.js.
- **After changing site files:** bump `CACHE` in sw.js so phones pick up the new version.
- **Leave alone:** the ds.py throttling, the sanity thresholds in refresh.sh, and the deploy/alert conditions in the workflow. Each one fixes a real past failure.

## Restore points
- Git tag `pre-maintenance-2026-11-14` = the site before the Nov 14, 2026 reliability fixes.
- To restore: `git revert <commit>` (or check out the tag's files) and push; the push redeploys.
