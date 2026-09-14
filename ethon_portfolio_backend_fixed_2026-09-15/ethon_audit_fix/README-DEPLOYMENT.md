# ETHON Portfolio CMS — Deployment Guide (Node.js)

This project runs on **Node.js + Express** (`server.js`). It is not PHP —
there is no `server.php`, `.htaccess`, or Apache/PHP requirement. All you
need is Node.js 18+ anywhere that can run a long-lived process.

## 1. Environment variables

Set these in your hosting provider's dashboard (or a local `.env` loaded by
your process manager). None are strictly required to boot — see the admin
password note below — but they're recommended for production:

| Variable | Required? | Purpose |
|---|---|---|
| `ADMIN_PASSWORD` | Recommended | Sets the CMS admin login password. If omitted, the server auto-generates a strong random password on first boot and prints it once to the server log (see below). |
| `APP_SECRET` | Recommended | A long random string used to sign admin session tokens. Set this in production so sessions survive restarts/redeploys consistently. |
| `SUPABASE_URL` | Recommended for production | Enables Supabase as the primary shared CMS state store; local `data.json` is retained as a fallback/cache. |
| `SUPABASE_SERVICE_ROLE_KEY` | Required with Supabase | Server-only Supabase service-role key. Never expose it in frontend code. |
| `RESEND_API_KEY` / `RESEND_FROM_EMAIL` | Optional | Enables automatic payment-voucher emails. |

### First-run admin password

If you don't set `ADMIN_PASSWORD`, the server generates a secure random
password the first time it starts, saves its hash into `data.json`, and
prints the plaintext password **once** to the console/log output, e.g.:

```
Admin login password:  Reyo9WmY6XNp
```

Log in at `/admin` with that password, then immediately change it from
**Admin → General Settings → Change Password**. After a password has been
set (via env var or the admin panel), this message will not appear again.

## 2. Local development

```bash
npm install
npm run dev        # runs `node server.js`
```

Then open `http://localhost:3000/` (public site) and `http://localhost:3000/admin` (CMS).

## 3. Running in production

Use any Node process manager so the server stays up and restarts on crash/redeploy:

```bash
npm install --omit=dev
node server.js
```

or with PM2:

```bash
pm2 start server.js --name ethon-portfolio
```

**Important — run a single instance.** This project keeps a small in-memory
cache in front of `data.json` for speed. That's fine for one Node process
(the normal case on Railway, Render, a single VPS, etc.), but if you scale
to multiple instances/replicas without configuring Supabase, writes made on
one instance won't be visible on another. If you need multiple instances,
configure `SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY` so all instances share
the same backing store.

## 4. Docker

A minimal Node Dockerfile is included. Build and run:

```bash
docker build -t ethon-portfolio .
docker run -p 3000:3000 \
  -e ADMIN_PASSWORD=change-me \
  -e APP_SECRET=$(openssl rand -hex 32) \
  -v $(pwd)/data.json:/app/data.json \
  -v $(pwd)/uploads:/app/uploads \
  ethon-portfolio
```

Mounting `data.json` and `uploads/` as volumes keeps your CMS content and
uploaded media across container restarts/redeploys.

## 5. Railway / Render / any Node host

1. Push this repo (or upload the files) to your host.
2. Set the start command to `node server.js` (already the default via `npm start`).
3. Set `ADMIN_PASSWORD` and `APP_SECRET` as environment variables.
4. Make sure the filesystem is persistent (Railway volumes, Render disks,
   etc.) so `data.json` and `uploads/` survive redeploys — otherwise every
   redeploy resets your CMS content to the bundled defaults.

## Payments

Payment endpoints are **payment request** APIs — they record a request and
generate a voucher, they do not charge a card themselves. Configure a real
gateway checkout URL/integration before presenting a transaction as
completed.

### Automatic payment-voucher email
Set `RESEND_API_KEY` and `RESEND_FROM_EMAIL` (a verified sender, e.g.
`Ethon <payments@yourdomain.com>`) to have the server email the client
automatically after a payment request is created. If these aren't set, the
request is still saved and added to the client conversation — email is
simply skipped.

### Currency-aware gateway links
The checkout accepts `USD`, `GBP`, `EUR`, and `BDT`. For real merchant
charging in the selected currency, configure currency-specific gateway URLs
in **Admin → Payments → Currency-specific checkout URLs (JSON)**, e.g.:
`{"STRIPE":{"USD":"...","GBP":"...","EUR":"...","BDT":"..."}}`. If no
currency-specific URL is configured, the generic gateway URL is used; the
selected currency is still stored on the request and voucher either way.


## Production security notes (2026-09-15)
- Server listens on `process.env.PORT` (with 3000 as local fallback), so Railway/container health checks can bind correctly.
- Supabase CMS state is loaded during startup when configured and initialized from local state only when the cloud row does not yet exist.
- Visitor chat now uses a signed HTTP-only chat access cookie; conversation IDs alone cannot read or send chat messages.
- Chat attachments are stored outside the public `/uploads` static directory and require the owning chat session or admin authentication.
- Set a strong `APP_SECRET` in production and keep `SUPABASE_SERVICE_ROLE_KEY` server-side only.
