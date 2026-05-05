# WSUI - West Side Unity Index

Internal simulated U.S. equity index page for the West Side Unity Index.

## Run Locally

```bash
npm install
npm run dev
```

Frontend: `http://127.0.0.1:5173`  
API: `http://127.0.0.1:8787`

## Market Data

Create `.env` from `.env.example` and add:

```bash
FINNHUB_API_KEY=your_key_here
GROUP_PASSWORD=optional_group_password
```

Without `FINNHUB_API_KEY`, the app uses clearly labeled demo quotes so the page can still be viewed.

## Freeze Launch Prices

After adding a real Finnhub key, run this once at the official launch snapshot:

```bash
npm run freeze-baseline
```

That writes real `inceptionPrice` values into `data/fund.json`, making WSUI behave like a target-weight launch basket that drifts with market prices.

## Alpha Engine

Members can submit two different tickers with optional cost basis values. The next WSUI consensus is calculated from:

- 7-day market return
- Return versus each member's cost basis
- Volatility penalty
- Chase-risk penalty when a pick is extended in its recent range
- Contributor influence, updated from relative composite score

The engine previews next-round weights with smoothing and a single-ticker cap. Member picks are stored in `data/picks.json`.
