# Remote Access (LAN + Cloudflare Tunnel) — Design

Date: 2026-07-12
Status: Approved (approach B)

## Problem

Viewer binds `127.0.0.1:8377` only. User wants to run it on a Linux server and open the dashboard from another machine — on the home LAN and optionally over the internet — with minimal setup.

## Approach

Built-in tunnel support: the viewer optionally spawns a locally installed `cloudflared` and prints a ready-to-click URL. No cloudflared bundling, no auto-download, no service management. LAN access is a plain bind-address flag.

## CLI surface

| Flag / env | Default | Effect |
|---|---|---|
| `--host <addr>` | `127.0.0.1` | Bind address. `0.0.0.0` = reachable on LAN at `http://<server-ip>:8377`. |
| `--tunnel` | off | Spawn `cloudflared tunnel --url http://127.0.0.1:<port>` (quick tunnel, free, no account). Parse the `https://*.trycloudflare.com` URL from cloudflared stderr and print it with `?token=` appended. |
| `--tunnel-token <t>` | off | Spawn `cloudflared tunnel run --token <t>` instead (named tunnel: stable URL / custom domain, free CF account). Implies `--tunnel`. |
| `--token <t>` / `CODEX_VIEWER_TOKEN` | auto | Pin the tunnel access token instead of using the persisted auto-generated one. Only meaningful with `--tunnel`. |

If `--tunnel` is requested but `cloudflared` is not on PATH: print an install hint (link to CF docs) and keep serving locally — never fatal.

The spawned cloudflared child is killed on viewer exit (`exit`, `SIGINT`, `SIGTERM`, `/shutdown`).

## Auth

Single shared token, required **only for tunnel traffic**. LAN and localhost are trusted (home network behind firewall — user's explicit call).

- **Tunnel traffic** = request carries a `cf-connecting-ip` header. cloudflared always sets `Cf-Connecting-Ip` and tunnel visitors cannot strip it; the header check is required because cloudflared delivers tunnel traffic from 127.0.0.1, so a plain address check cannot tell tunnel from local. Everything else (localhost, LAN, tray launcher, notify hook) needs no token — existing workflow unchanged.
- **Token generation**: `crypto.randomBytes(16).toString("hex")`, generated once and persisted to `~/.codex/live-viewer-token` (file mode 0600 on POSIX) so printed URLs stay bookmarkable across restarts. `--token`/env overrides without touching the file. Only generated when tunnel mode is active.
- **Token transport**: first request carries `?token=xxx` (that's what the printed URL contains). Server validates, sets an `HttpOnly` cookie with the token, and all subsequent requests — including `EventSource`/SSE — ride the cookie. Either `?token=` or the cookie is accepted on any request.
- **Failure**: tunnel request with missing/wrong token → `401` plain-text "token required".
- Comparison uses `crypto.timingSafeEqual` on equal-length buffers.

## Origin check change

`trustedControlOrigin()` currently hardcodes `http://127.0.0.1:<port>` / `http://localhost:<port>`, which breaks POST endpoints (`/shutdown`, `/kill`, `/open`, `/procs`) behind a tunnel or LAN host. New rule: allow when the `Origin` header is absent, or when the origin's host equals the request's `Host` header. Cross-site abuse remains blocked by the token (browsers can't attach the cookie cross-site with `SameSite` default, and can't read the token).

## Startup output

```
[OK] Codex Live Viewer -> http://localhost:8377
[OK] LAN              -> http://10.30.0.5:8377                            (when --host 0.0.0.0, no token)
[OK] Tunnel           -> https://xyz.trycloudflare.com/?token=abcd1234... (when --tunnel, once URL parsed)
```

## Out of scope (deliberate)

- HTTPS on LAN (tunnel provides TLS; LAN is trusted enough for a dashboard).
- Multi-user / per-user tokens, rate limiting, Cloudflare Access integration (named-tunnel users can add Access in the CF dashboard themselves, zero code).
- Auto-downloading the cloudflared binary.
- Windows tray changes: tray keeps talking to localhost, unaffected (trusted-local).

## Testing

- Unit: token check (no header = open, `cf-connecting-ip` + `?token=` ok, cookie ok, wrong/missing token 401), new origin rule, cloudflared stderr URL parsing.
- Manual: `serve --host 0.0.0.0` from second machine; `serve --tunnel` end-to-end through trycloudflare URL (SSE stream included).
