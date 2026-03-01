# Courtyard EV Tracker

Live expected value tracker for Courtyard.io packs, pulling data directly from the Polygon blockchain.

## What it does
- Polls the Polygon blockchain every 30 seconds for new card mints
- Shows a live EV Ratio chart over time
- Live feed of recent pulls with card name, tier, and estimated value
- Calibrated odds breakdown per tier (Common → Chase)
- Pack selector for Pokémon, Basketball, Sports, Vintage packs

## Optional: Get a free Alchemy API key (recommended)

The app works out of the box with a demo key, but for reliable uptime:

1. Go to [alchemy.com](https://alchemy.com) and create a free account
2. Create a new app → select **Polygon** as the network
3. Copy your API key
4. In `src/App.jsx`, replace `demo` in these two lines at the top:
   ```
   const RPC_URL = "https://polygon-mainnet.g.alchemy.com/v2/YOUR_KEY_HERE";
   const NFT_API = "https://polygon-mainnet.g.alchemy.com/nft/v3/YOUR_KEY_HERE";
   ```

## Deploy to Vercel (free)

1. Push this folder to a GitHub repo
2. Go to [vercel.com](https://vercel.com) → New Project → Import from GitHub
3. Click Deploy — done. You'll get a free URL like `your-app.vercel.app`

Vercel auto-redeploys every time you push a change to GitHub.
