# Mailflare email relay

A small Cloudflare Worker for self-hosted Mailflare installs that want to keep
receiving mail through Cloudflare Email Routing (no port 25, no MX changes).

1. `npm install`, then `npx wrangler secret put MAILFLARE_URL` (your server's
   public URL, e.g. `https://mail.example.com`) and
   `npx wrangler secret put INBOUND_WEBHOOK_SECRET` (the same value as in the
   server's `.env.docker`).
2. `npm run deploy`.
3. In the Cloudflare dashboard, under Email Routing for your zone, route the
   catch-all, or the addresses you want, to the `mailflare-email-relay` Worker.

Each message is posted to `/api/inbound` on your server with an HMAC
signature. The server stores it and replies with the routing decision, so
reject rules and forwarding rules still act at Cloudflare's edge. If the server
is unreachable the message is rejected with a retry hint.
