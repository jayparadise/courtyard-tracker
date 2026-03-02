# Pulld — Courtyard EV Tracker v2

Real EV tracking for Courtyard.io packs using pool depletion model.

## Deploy
1. Push to GitHub
2. Connect to Vercel — it will auto-detect Vite and deploy

## How it works
- Polls Polygon blockchain every 25s for new card mints
- Fetches card metadata (name, grade, buyback price) from IPFS via Alchemy
- Uses **actual Courtyard buyback prices** from NFT metadata when available
- Tracks rolling 50-pull window to model pool depletion
- EV ratio = avg(recent buyback prices) / pack price
- Rising EV = commons depleting from pool → higher-value cards more likely

## Update your Alchemy key
In `src/App.jsx` line 7: `const ALCHEMY_KEY = "your-key-here";`
