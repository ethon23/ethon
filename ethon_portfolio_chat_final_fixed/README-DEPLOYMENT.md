# ETHON Portfolio CMS — Portable Server Edition

This build is no longer dependent on Node.js for the web server. The public site and CMS use the same REST API contract, served by `server.php`.

## Shared hosting / cPanel / Apache

1. Upload the project files.
2. Make sure PHP 8.1+ is enabled (PHP 8.3 recommended).
3. Ensure `uploads/` and `runtime/` are writable by PHP.
4. Set these environment/config values in your hosting environment when available:
   - `ADMIN_PASSWORD` — required; there is no fallback/default password.
   - `APP_SECRET` — optional but recommended, a long random secret.
   - `SUPABASE_URL` — optional.
   - `SUPABASE_SERVICE_ROLE_KEY` — optional.
   - `SUPABASE_STORAGE_BUCKET` — optional, defaults to `portfolio`.
5. The included `.htaccess` routes API requests through `server.php` while allowing real assets to be served directly.

## Render

Use the included `Dockerfile` as a Docker deployment. Set the same environment variables in Render. The container runs Apache + PHP.

## Local PHP server

```bash
php -S 127.0.0.1:8080 server.php
```

Then open `http://127.0.0.1:8080/` and `/admin`.

## Supabase

Run `supabase.sql` once. If Supabase variables are not configured, the CMS uses the bundled `data.json` and local `uploads/` directory.

## Important

Payment endpoints are preserved as **payment request** APIs. They do not pretend to charge a card. Configure a real gateway checkout URL/integration before presenting a transaction as completed.
