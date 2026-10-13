# TrolaSpy

Live position and battery page for our Nissan e-NV200 ("Trola"), fed directly by
[LeafSpy Pro](https://leafspy.com/) on the Android tablet in the van. Runs on
Cloudflare's free tier.

```
LeafSpy (tablet) ──GET every 10 s──▶ trolaspy-ingest Worker ──▶ D1 database (kept forever)
                                                                   │
you (browser) ──▶ Cloudflare Access (email code) ──▶ trolaspy Worker ─┘  map + stats
```

- **`ingest/`** – public Worker LeafSpy uploads to. Checks the LeafSpy ID/password,
  stores one row per upload and replies `"status":"0"`. Readings are kept forever;
  set `RETENTION_DAYS` in `ingest/wrangler.toml` to delete older ones daily (D1 free: 500 MB
  per database, 5 GB per account; roughly 2 MB a day even with nonstop 10 s uploads). The
  admin card's Data tab shows the space used by the database and the photos.
- **`web/`** – the map page (Leaflet + OpenStreetMap) and its small JSON API
  (`/api/latest`, `/api/track?hours=24`). Must sit behind Cloudflare Access.
- **`public/`** – the public "Where's Trola" page (Worker `trola`, no login): a rough area
  (a 5 km or 1.5 km grid cell, `shared/public.js`), on the road / parked / charging, km totals
  and optionally the photo pins, optionally some hours late. Blank until switched on in the
  admin card's Public tab. Must stay outside Cloudflare Access.
- **`bridge/`** – TrolaSpy Bridge, a small Android app for the same tablet. It listens for the
  Victron SmartSolar and Orion Smart chargers' Bluetooth "Instant readout" broadcasts for 30 s
  every 5 minutes (no connection, so VictronConnect keeps working) and POSTs the newest one from
  each to `trolaspy-ingest/bridge`, logged in with LeafSpy's ID/password. The broadcasts
  are encrypted; the keys are saved in the admin card's Solar tab and `shared/victron.js` reads
  them. Readings go to the `victron` table (a row when something changes, else every 15 min)
  and show in the Solar and DC-DC charger cards. Built by `.github/workflows/bridge.yml` and published as the
  latest GitHub release (`trolaspy-bridge.apk`); its signing key is kept in R2 (`private/`).
- **`schema.sql`** – the D1 tables (readings, photos, charges, daily, settings, victron).
- **Monthly summary** (everyone) and **admin tools** (the ADMIN_EMAIL account): phone alerts
  as notifications from TrolaSpy itself (Web Push, `shared/push.js`; turned on per phone in the
  admin card; charged to X %, charging finished, battery low),
  battery health over time (daily SOH / Hx / AHr), and backup (CSV download), restore and
  delete of readings. Day summaries live in the `daily` table (`shared/stats.js`); alert
  rules run on each upload in the ingest Worker (`shared/alerts.js`).
- **`shared/charges.js`** – charging sessions worked out from readings (charging readings
  less than 15 min apart form one session; energy is pack volts × amps over time, so add-on
  chargers count). The daily job copies finished sessions into `charges` before old readings
  are deleted, so charger pins and their stats are kept for good.
- **Photo pins** – the admin uploads photos from the map page; the browser reads EXIF GPS
  (or matches the photo time to Trola's track, or lets you tap the map), shrinks the photo
  to ~2000px plus a thumbnail, and the Worker stores them in R2 (`trolaspy-photos`).

Free-tier fit: one upload every 10 s is about 8,600 Worker requests and D1 row
writes a day (limits: 100,000 each).

## One-time setup

You need a free Cloudflare account and Node 20+.

1. **Install and log in**
   ```sh
   npm install
   npx wrangler login
   ```
2. **Create the database** and paste the printed `database_id` into both
   `ingest/wrangler.toml` and `web/wrangler.toml`:
   ```sh
   npx wrangler d1 create trolaspy
   npm run db:init
   ```
3. **Pick a LeafSpy ID and password** and store them as secrets:
   ```sh
   npx wrangler secret put LEAFSPY_USER -c ingest/wrangler.toml
   npx wrangler secret put LEAFSPY_PASS -c ingest/wrangler.toml
   ```
4. **Deploy both Workers**
   ```sh
   npm run deploy
   ```
   Note the two URLs, e.g. `trolaspy-ingest.<you>.workers.dev` and
   `trolaspy.<you>.workers.dev`.
5. **Lock the map page with an email code (Cloudflare Access, free up to 50 users)**
   - Dashboard → Workers & Pages → `trolaspy` → **Access** (or Settings →
     Domains & Routes → workers.dev) → protect **All traffic**.
   - Policy: allow the email addresses that may see the van (yours, family).
     Login method: one-time PIN by email.
   - Open `trolaspy.<you>.workers.dev`: you should get the email-code login. Without
     Access in front, the Worker answers `403 Forbidden` on purpose.
   - Do **not** protect `trolaspy-ingest`; LeafSpy can't log in. Its ID/password is
     its protection.
6. **Point LeafSpy at it** (LeafSpy Pro → ≡ → Settings → Server):
   - `Enable` ✓, Send interval **10 s**
   - Pick a free slot (e.g. **B**; keep leaf-status.com in its slot) → `Enable` ✓
   - `ID` / `PW`: the values from step 3
   - `URL`: `trolaspy-ingest.<you>.workers.dev` (no `http://` prefix)
7. Drive around the block and watch the page.

### Deploy from GitHub (no terminal needed)

`.github/workflows/deploy.yml` runs tests on every push to `main` and then deploys:
it creates the `trolaspy` D1 database if needed, applies `schema.sql`, deploys both
Workers and sets the LeafSpy login. The deploy job skips itself until these repo
secrets exist (Settings → Secrets and variables → Actions):

| Secret | Value |
| --- | --- |
| `CLOUDFLARE_API_TOKEN` | API token with Account → Workers Scripts: Edit, D1: Edit, Account Settings: Read |
| `CLOUDFLARE_ACCOUNT_ID` | Your account ID (Workers & Pages overview, right-hand side) |
| `LEAFSPY_USER` | The ID you'll type into LeafSpy |
| `LEAFSPY_PASS` | The password you'll type into LeafSpy |
| `ADMIN_EMAIL` | Email that may add/delete photo pins (comma-separate several) |

Photo pins need R2 enabled on the account and the token to also have
Account → Workers R2 Storage: Edit; the workflow creates the `trolaspy-photos` bucket.

Then run Actions → Deploy → Run workflow. Steps 5–7 above (Access, LeafSpy,
test drive) are still done by hand.

### Optional: extra Access check

If Worker-level Access doesn't populate `ctx.access` (for example when you use a
self-hosted Access app on a custom domain instead), fill `ACCESS_TEAM_DOMAIN`
(`<team>.cloudflareaccess.com`) and `ACCESS_AUD` in `web/wrangler.toml`; the Worker
then verifies the `Cf-Access-Jwt-Assertion` token itself.

## Local development

```sh
printf 'LEAFSPY_USER=trola\nLEAFSPY_PASS=secret\n' > ingest/.dev.vars
printf 'DEV_NO_AUTH=1\n' > web/.dev.vars
npx wrangler d1 execute trolaspy --local --persist-to .wrangler/state --file schema.sql -c ingest/wrangler.toml
npx wrangler dev -c ingest/wrangler.toml --port 8787 --persist-to .wrangler/state
npx wrangler dev -c web/wrangler.toml --port 8788 --inspector-port 9339 --persist-to .wrangler/state
curl "localhost:8787/?user=trola&pass=secret&Lat=46.05&Long=14.5&SOC=80&Gids=200&PwrSw=1"
open http://localhost:8788
```

`npm test` runs the LeafSpy parser tests.

## LeafSpy fields stored

`Lat`, `Long`, `Elv`, `Speed`, `SOC`, `Gids`, `SOH`, `AHr`, `Hx`, `BatVolts`,
`BatAmps`, `BatTemp`, `Amb` (converted to °C if `Tunits=F`), `PlugState`,
`ChrgMode`, `ChrgPwr`, `PwrSw`, `Odo`, `Trip`, `Seq`, `DevBat`, `RPM`.
The VIN is not stored.
