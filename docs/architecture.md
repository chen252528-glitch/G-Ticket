# Flight Price Radar Architecture

## Purpose
Serverless, API-first flight monitoring for:
- UK -> Europe economy fares via structured flight APIs
- long-haul business class deals via RSS + LLM extraction

## Non-Negotiable Constraints
- No HTML scraping (RSS feeds are fetched through the ScraperAPI proxy to get past Cloudflare, but only feed XML is consumed)
- No email parsing
- No local SQLite persistence
- Edge database only
- API-first integrations only

## Stack
- Runtime: TypeScript on Node.js 20+
- Orchestration: GitHub Actions scheduled workflows (an in-memory scheduler exists for local development)
- Validation: Zod
- Database: Turso
- Flight API: SerpApi Google Flights API
- Deal Source: RSS feeds via ScraperAPI
- LLM extraction: OpenAI `gpt-4o-mini`
- Notifications: Discord webhooks

## Module Layout
- `src/config`
  - environment loading and runtime constants
- `src/schemas`
  - Zod schemas for external inputs/outputs and internal DTOs
- `src/types`
  - shared inferred TypeScript types from Zod schemas
- `src/clients`
  - API clients for SerpApi, RSS fetch, LLM extraction, Discord webhook, Turso
- `src/db`
  - SQL strings, repository helpers, migration metadata
- `src/logic`
  - ranking, deduplication, threshold evaluation, embed generation input prep
- `src/jobs`
  - job runners for normal fares and business deals, plus the local scheduler and DB-lease wrapper
- `src/utils`
  - idempotency keys, dates, currency normalization helpers
- `src/notifications`
  - Discord embed builders
- `db/migrations`
  - schema DDL for edge database setup
- `docs`
  - architecture notes, implementation plan
- `discord-interactions`
  - optional Cloudflare Worker exposing Discord slash commands (/price, /track, /scan, /status) against the same Turso database

## Primary Data Interfaces

### `tracked_destinations`
Represents a durable search definition for normal fare polling.
- `id`
- `originAirportCode`
- `destinationAirportCode`
- `tripType`
- `cabinClass`
- optional date windows
- optional `maxStops`
- `currencyCode`
- `locale`
- `isActive`

### `normalizedFareObservation`
Immutable normalized fare snapshot persisted before alert evaluation.
- `trackedDestinationId`
- `observedAt`
- `provider`
- `providerQueryKey`
- route fields
- travel dates
- `priceAmountMinor`
- `currencyCode`
- optional `deepLink`
- `flightFingerprint`
- `rawPayloadJson`

### `businessDealExtraction`
LLM-forced JSON extracted from RSS text.
- `origin`
- `destination`
- `priceText`
- optional `priceAmount`
- optional `currencyCode`
- `cabinClass`
- `isLongHaul`
- optional `isErrorFare`
- `confidence`

### Repository contracts
- `FlightPriceRepository`
  - `listActiveTrackedDestinations()`
  - `insertFareObservation()` -> inserted observation id
  - `listLowestHistoricalFares()`
  - `getAverageDailyLowFare()` - average of per-day lowest fares over a window (used for the cheap/overpriced comparison)
  - `hasSentFareAlert()`
  - `recordFareAlert()`
- `BusinessDealRepository`
  - `hasSeenDealLink()`
  - `insertParsedDeal()`
  - `deleteStaleNonQualifyingDeals()` - prunes old non-qualifying rows while keeping recent ones for dedupe

## Data Flow

### 1. Normal fares
1. GitHub Actions cron (or the local scheduler) launches the normal-fares job; a DB lease in `job_scheduler_state` prevents overlapping runs.
2. Job loads tracked destinations from DB.
3. SerpApi client fetches structured fare snapshots per route/date pattern.
4. Application normalizes and stores fare observations.
5. Ranking logic calculates top-3 historical cheapest fares for each destination.
6. If the new fare enters the top 3 and has not already been alerted, create Discord embed and send notification.
7. Persist alert fingerprint to avoid duplicates.

### 2. Business class deals
1. GitHub Actions cron (or the local scheduler) launches the business-deals job; a DB lease in `job_scheduler_state` prevents overlapping runs.
2. RSS client fetches feeds through ScraperAPI and stores raw item metadata temporarily in memory.
3. Each item is deduplicated by canonical link hash before expensive LLM calls.
4. LLM extractor converts title/summary into forced structured JSON.
5. Validation layer rejects malformed outputs.
6. Logic confirms:
   - business class
   - long-haul
   - below configured threshold
   - not already alerted
7. Discord embed is sent and deal dedupe state is persisted.

## Database Model Summary
- `tracked_destinations`: routes/search settings to poll
- `fare_observations`: immutable structured fare snapshots from API
- `fare_alerts`: sent-alert dedupe for normal fares
- `business_deals`: parsed RSS deals with dedupe + alert state

## Edge Database Schema Notes
- `tracked_destinations` has a uniqueness index on route + cabin + trip/date shape to prevent duplicate polling definitions.
- `fare_observations` stores immutable source payload JSON for auditability and supports historical ranking via `(tracked_destination_id, price_amount_minor, observed_at)`.
- `fare_alerts` stores durable alert fingerprints so Discord retries or reruns do not duplicate messages.
- `business_deals` deduplicates by `source_link_hash` and stores both raw source metadata and parsed JSON fields for later review.

## Design Principles
- Store raw source metadata plus normalized fields for auditability.
- Make dedupe explicit and durable in DB.
- Keep LLM outputs schema-constrained and validated before use.
- Separate external client DTOs from internal domain models.
- Treat notifications as side effects after DB persistence decisions.

## Why GitHub Actions
GitHub Actions scheduled workflows provide:
- scheduled execution without running a server
- manual dispatch for ad-hoc runs
- visibility into failures via run logs
- secrets management for API keys

Overlap and duplicate execution are handled at the application level with a durable DB lease (`job_scheduler_state`), so local runs and CI runs can coexist safely.

