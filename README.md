# Aero Pair Lab

Correlation, ratio volatility and impermanent-loss stats for Coinbase tokenized stocks and crypto on Aerodrome (Base).

- The site is plain static files (`index.html`, `app.js`, `styles.css`, `data.json`) served by GitHub Pages.
- `.github/workflows/refresh.yml` runs `scripts/refresh.sh` every day (00:45 UTC) and commits a fresh `data.json`. GitHub Pages republishes automatically.
- Run it manually any time: **Actions → Daily data refresh → Run workflow**.
- Add a stock token: append its symbol (e.g. `MRVLc`) to the `STOCKS` list in `scripts/build.py`. The workflow log prints `new_eligible_stocks` (tokens with ≥ $5K Aerodrome liquidity that aren't included yet).
- Note: GitHub pauses scheduled workflows after 60 days with no repository activity. The daily data commit counts as activity, so it should keep itself alive; if it ever stops, re-enable it from the Actions tab.

Data sources: Yahoo Finance (stock prices), Coinbase Exchange (crypto prices), DEX Screener (Aerodrome pools), Coinbase Tokenized Stocks API (token list). Not financial advice.
