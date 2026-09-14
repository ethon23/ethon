# ETHON Portfolio — Backend Audit & Fixes

Date: 2026-09-15

## Fixed
- Railway/container port now uses `process.env.PORT` with a local 3000 fallback.
- Express trusts one reverse proxy so secure cookies work correctly behind Railway/HTTPS.
- Supabase CMS state is loaded at startup when configured.
- If the Supabase `cms_state` row does not exist, local state initializes it.
- Existing local state remains a fallback if Supabase is temporarily unavailable.
- Visitor chat now uses a signed, HTTP-only 30-day chat access cookie.
- Chat conversation IDs alone cannot read or send visitor messages.
- Admins can still access all conversations through the existing admin session.
- Chat attachments are stored separately from public CMS uploads.
- Chat attachment viewing/downloading requires the owning chat session or admin authentication.
- Legacy chat attachment URLs referenced by stored conversations are migrated into private chat storage on startup.
- Public `/uploads` remains available for normal portfolio/project/media assets.
- Visitor chat frontend handles expired/unauthorized chat sessions by asking the visitor to start again.

## Intentionally unchanged
- Existing visual/UI design and public portfolio content.
- Existing admin CRUD structure.
- Payment request/voucher flow.
- Resend email integration.

## Remaining deployment requirements
Set these environment variables in production:
- `APP_SECRET` — long random secret.
- `ADMIN_PASSWORD` — initial admin password (optional after a password is stored, but recommended for first deployment).
- `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` — recommended for persistent/shared CMS state.
- `RESEND_API_KEY` and `RESEND_FROM_EMAIL` — required only for voucher email delivery.

## Payment note
The current payment buttons remain payment-request/gateway-link based. Real automatic payment verification requires provider-specific API/webhook integration and is not silently represented as implemented by this patch.
