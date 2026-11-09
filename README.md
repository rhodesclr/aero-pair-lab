# Aero Pair Lab

Correlation, ratio volatility and impermanent-loss stats for Coinbase tokenized stocks and crypto on Aero (Base), the Aerodrome + Velodrome merger that launched Oct 22, 2026. New Aero pools are shown by default; old Aerodrome pools can be included with a checkbox.

- The site is plain static files (`index.html`, `app.js`, `styles.css`, `data.json`) served by GitHub Pages.
- `.github/workflows/refresh.yml` runs `scripts/refresh.sh` every hour, then deploys the site to GitHub Pages. Once a day (00:xx UTC) it also commits `data.json`.
- In the browser, pool price, TVL and volume refresh live from DEX Screener every 60s; the LP Simulator also reads pool price, active liquidity and the dynamic fee from the Base pool contract every 15s (`live.js`).
- `scripts/hist.py` (run by `refresh.sh`) reads Aero's LP Sugar contract at each day's 00:00 UTC block and keeps `hist.json`: per-pool AERO emissions, staked and active liquidity, and reserves, from Oct 24, 2026 onward. Blocks are found from real block timestamps (Base moved from 2s to 0.2s blocks in Nov 2026). Each run refreshes today and backfills up to 6 missing days.
- If a scheduled refresh fails, the deploy step is skipped so the last good data stays live, and the `alert` job opens an issue ("Hourly data refresh is failing") once the live data is 3+ hours old, then closes it when a refresh succeeds. The site also shows a banner when its data is more than 3 hours old.
- Run it manually any time: **Actions → Hourly data refresh + deploy → Run workflow**.
- Add a stock token: append its symbol (e.g. `MRVLc`) to the `STOCKS` list in `scripts/build.py`. The workflow log prints `new_eligible_stocks` (tokens with ≥ $5K Aerodrome liquidity that aren't included yet).
- Note: GitHub pauses scheduled workflows after 60 days with no repository activity. The daily data commit counts as activity, so it should keep itself alive; if it ever stops, re-enable it from the Actions tab.

Data sources: Yahoo Finance (stock prices), Coinbase Exchange (crypto prices), DEX Screener (Aerodrome pools), Coinbase Tokenized Stocks API (token list). Not financial advice.

## LP Simulator

`sim.js`: pick any Aero pool, set min/max price (type it, use presets, or drag the handles on the chart), and backtest up to 1 year: time in range, exits, fees, IL, net vs holding, plus a range optimizer. Share links keep the pool and range in the URL (`#sim?pool=…&lo=…&hi=…`).

- Price path: each pool's own GeckoTerminal OHLC bars (hourly for 7D–90D, daily for 180D–1Y), then other pools of the same pair, then the two tokens' USD feeds (scaled to meet the pool price) for anything older than about 6 months.
- Fees: each bar's real volume × fee × your share of that day's on-chain active liquidity × the part of the bar spent in range (from its high/low).
- AERO: each day's actual emissions and staked liquidity from `hist.json`, priced at that day's AERO price.
- Optional re-centering when price leaves the range (immediately or after N hours), charging pool fee + slippage on the swapped amount + gas.
- "Check against a real position": enter an LP NFT ID (Aero / old Aerodrome Slipstream or Uniswap v3, Base and OP). `Live.positionCheck` finds the mint and stake blocks by binary search over historical state and computes actual fees and AERO from the pool's fee-growth and reward-growth counters, then runs the backtest over the same window with the same ticks and starting tokens.
