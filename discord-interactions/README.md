# Discord Slash Commands (Cloudflare Worker)

A small Cloudflare Worker that lets you interact with flight-price-radar directly from Discord:

| Command | What it does |
|---|---|
| `/price origin destination [cabin]` | Compares the current cheapest fare against the average of daily lows over the last 60 days and tells you whether it is cheap (便宜) or overpriced (溢價) |
| `/track add origin destination depart [return] [cabin] [trip]` | Start tracking a route for the given travel dates (YYYY-MM-DD); re-adding updates the dates |
| `/track remove origin destination [cabin]` | Stop tracking a route |
| `/track list` | List active tracked routes |
| `/scan job` | Trigger the `normal-fares` / `business-deals` GitHub Actions workflow now |
| `/status` | Show when each job last ran, succeeded, or failed |

The Worker verifies Discord's Ed25519 signature, immediately defers the reply (Discord's 3-second rule), then reads/writes the same Turso database the main app uses. No always-on server is needed.

## Setup

### 1. Create the Discord application

1. Go to https://discord.com/developers/applications → **New Application**.
2. On **General Information**, note the **Application ID** and **Public Key**.
3. On **Bot**, note the **Token** (used only for registering commands).
4. On **Installation** (or OAuth2 → URL Generator), install the app to your server with the `applications.commands` scope.

### 2. Deploy the Worker

```bash
cd discord-interactions
npm install
npx wrangler login

# Secrets
npx wrangler secret put DISCORD_PUBLIC_KEY
npx wrangler secret put DATABASE_URL          # same libsql:// URL as the main app
npx wrangler secret put DATABASE_AUTH_TOKEN
npx wrangler secret put GITHUB_TOKEN          # optional, enables /scan (PAT with Actions read/write)

npm run deploy
```

Edit `wrangler.toml` first and set `GITHUB_REPOSITORY` (e.g. `your-name/flight-radar`) if you want `/scan`.

`npm run deploy` prints the Worker URL, e.g. `https://flight-radar-discord.<your-subdomain>.workers.dev`.

### 3. Point Discord at the Worker

On the application's **General Information** page, paste the Worker URL into **Interactions Endpoint URL** and save. Discord sends a signed PING to verify the endpoint — if saving fails, check the `DISCORD_PUBLIC_KEY` secret.

### 4. Register the slash commands

```bash
DISCORD_APPLICATION_ID=... DISCORD_BOT_TOKEN=... DISCORD_GUILD_ID=... npm run register-commands
```

With `DISCORD_GUILD_ID` (your server ID) the commands appear immediately; without it they are registered globally and can take up to an hour.

## Notes

- Anyone who can see the commands in your server can use them. Restrict access per-command under **Server Settings → Integrations → your app** if needed.
- `/price` compares the cheapest fare of the latest scan day against the average of each prior day's cheapest fare within 60 days (the latest day is excluded from the average). Verdict thresholds: ±5%.
- `/track add` writes to `tracked_destinations` with the given travel dates and defaults `GBP` / `en-GB`; the next scheduled scan picks it up automatically. The scanner skips routes without a departure date or whose departure date has passed (`/track list` flags them).
- Logs: `npx wrangler tail` while testing.
