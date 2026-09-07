# Rack Log

Rack Log is a lightweight workout tracker for recording lifting, cardio, and timed-hold sessions. It includes exercise history, estimated 1RM and PR tracking, a calendar, workout sharing, crew activity, comments, likes, invites, and account sync.

The app is a single-page HTML client backed by a Cloudflare Worker and D1 database.

## Local development

Requirements:

- Node.js 22 or newer
- A Cloudflare account for Worker/D1-backed development

Install dependencies and start the local Worker:

```sh
npm install
npx wrangler dev
```

Wrangler serves the app at the local address it prints, normally `http://localhost:8787`.

Local secrets belong in `.dev.vars` or another ignored local environment file. Use `.env.example` as the list of secret values the Worker may need. Never commit `.env`, `.dev.vars`, or private keys.

## Testing

Run the headless smoke-test suite with:

```sh
node test/run.js
```

The suite exercises the app’s pure functions and rendering paths, including workouts, calendar navigation, sharing, social activity, account flows, invites, syncing, and authentication behavior.

## Deployment

The Worker configuration is in [`wrangler.toml`](wrangler.toml). Production secrets should be stored in Cloudflare, not in Git:

```sh
npx wrangler secret put GOOGLE_CLIENT_SECRET
npx wrangler secret put VAPID_PRIVATE_KEY
```

The GitHub Actions workflow deploys when a version tag beginning with `v` is pushed. Configure the repository secret `CLOUDFLARE_API_TOKEN`, then release with:

```sh
git tag v1.0.0
git push origin v1.0.0
```

## Project layout

- `rack-log.html` — client application and styles
- `worker/index.js` — Cloudflare Worker API and request handling
- `worker/schema.sql` — D1 schema
- `worker/migrate-*.sql` — database migrations
- `worker/icon-*.png` — installable app icons
- `test/run.js` — headless smoke tests
- `wrangler.toml` — Cloudflare Worker and D1 configuration

## Security

Keep credentials out of source control. If a credential is ever committed, revoke or rotate it immediately and remove it from the repository history before sharing the repository further.
