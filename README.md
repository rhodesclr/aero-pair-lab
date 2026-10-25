# Aero Pair Lab

Correlation, ratio volatility and impermanent-loss stats for Coinbase tokenized stocks and crypto on Aero (Base), the Aerodrome + Velodrome merger that launched Oct 22, 2026. New Aero pools are shown by default; old Aerodrome pools can be included with a checkbox.

- The site is plain static files (`index.html`, `app.js`, `styles.css`, `data.json`) served by GitHub Pages.
- `.github/workflows/refresh.yml` runs `scripts/refresh.sh` every hour, then deploys the site to GitHub Pages. Once a day (00:xx UTC) it also commits `data.json`.
- In the browser, pool price, TVL and volume refresh live from DEX Screener every 60s; the LP Simulator also reads pool price, active liquidity and the dynamic fee from the Base pool contract every 15s (`live.js`).
- Run it manually any time: **Actions → Hourly data refresh + deploy → Run workflow**.
- Add a stock token: append its symbol (e.g. `MRVLc`) to the `STOCKS` list in `scripts/build.py`. The workflow log prints `new_eligible_stocks` (tokens with ≥ $5K Aerodrome liquidity that aren't included yet).
- Note: GitHub pauses scheduled workflows after 60 days with no repository activity. The daily data commit counts as activity, so it should keep itself alive; if it ever stops, re-enable it from the Actions tab.

Data sources: Yahoo Finance (stock prices), Coinbase Exchange (crypto prices), DEX Screener (Aerodrome pools), Coinbase Tokenized Stocks API (token list). Not financial advice.

## LP Simulator

`sim.js`: pick any Aero pool, set min/max price (type it, use presets, or drag the handles on the chart), and backtest up to 1 year: time in range, exits, fees, IL, net vs holding, plus a range optimizer. Share links keep the pool and range in the URL (`#sim?pool=…&lo=…&hi=…`).
