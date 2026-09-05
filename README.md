# hydra-acp-browser

A browser-based UI for [hydra-acp](https://github.com/smagnuso/hydra-acp)
sessions. Runs as a hydra extension (or standalone) and serves a small
single-page app on localhost that lists live sessions, mirrors them in real
time, and lets you prompt, approve permission requests, switch modes/models,
create fresh sessions, kill old ones, and browse the project files of any
session — all from a phone or laptop browser.

The hydra master token never leaves the machine; the browser authenticates
you with a password (set via `hydra-acp auth password`) and issues its own
session cookie.

## Install

```sh
npm install -g @hydra-acp/cli @hydra-acp/browser
```

This drops the `hydra-acp` (and `hydra`) CLI plus an `hydra-acp-browser`
binary on your PATH. The CLI dispatches `hydra-acp <name>` to any
`hydra-acp-<name>` binary on PATH, so the browser is also reachable as
`hydra-acp browser`.

Register it as a hydra extension:

```sh
hydra-acp extensions add hydra-acp-browser --command hydra-acp-browser
```

`extensions add` is config-only — it doesn't spawn anything yet. Either
bounce the daemon, or, if the daemon is already running, kick the
extension into life:

```sh
hydra-acp extensions start hydra-acp-browser
```

Set the sign-in password once, on the machine running the daemon:

```sh
hydra-acp auth password
```

On startup, hydra-acp-browser writes the URL to open to
`~/.hydra-acp/browser/link` (and logs it — see `hydra-acp extensions log
hydra-acp-browser -f`). Open that URL and log in with the password you
just set; a successful login sets an `hb_session` cookie and subsequent
requests are authenticated by that cookie alone.

That's the whole setup for local (loopback) use. Building from source
instead, or want it reachable from your phone? Keep reading.

## Access from your phone or over your LAN

Loopback-only access needs nothing extra. Reaching it from another
device means binding to a real interface, which requires HTTPS (the
server refuses a non-loopback bind otherwise — same rule as the hydra
daemon).

If you're on Tailscale, this is one command:

```sh
hydra-acp-browser tailscale setup
```

It mints a real Let's Encrypt cert via `tailscale cert`, binds to your
tailnet IP, and restarts the extension for you. See [HTTPS](#https)
below for the self-signed alternative if you're not on Tailscale, plus
cert-trust steps for iOS/macOS/Linux.

## Building from source

```sh
git clone https://github.com/smagnuso/hydra-acp-browser.git ~/dev/hydra-acp-browser
cd ~/dev/hydra-acp-browser
npm install
npm run build
```

Point the extension at the build instead of the npm binary:

```sh
hydra-acp extensions add hydra-acp-browser \
  --command node \
  --args ~/dev/hydra-acp-browser/dist/index.js
```

That writes the equivalent entry into `~/.hydra-acp/config.json`:

```json
{
  "extensions": {
    "hydra-acp-browser": {
      "command": ["node"],
      "args": ["/home/you/dev/hydra-acp-browser/dist/index.js"],
      "enabled": true
    }
  }
}
```

After a rebuild, `restart` (not `start`) is the right call:

```sh
hydra-acp extensions restart hydra-acp-browser
```

On startup, hydra spawns hydra-acp-browser with these env vars set:
`HYDRA_ACP_DAEMON_URL`, `HYDRA_ACP_TOKEN`, `HYDRA_ACP_WS_URL`.
Stdout/stderr land in `~/.hydra-acp/extensions/hydra-acp-browser.log`.

**Running standalone**, without the hydra extension wrapper: set
`HYDRA_TOKEN` in `~/.hydra-acp/browser.conf` (or export
`HYDRA_ACP_TOKEN`), then:

```sh
npm start
```

## How it works

```
                     hydra REST    +--------------------+         browser
       /v1/sessions   <----------  |                    |  ---->   GET /
                                   |  hydra-acp-browser |  <---->  /ws?session=<id>
       hydra WSS      <----------> |                    |
       /acp                        +--------------------+
                                            |
                                  ~/.hydra-acp/browser/
                                    link
```

The extension exposes:

- **HTTP routes** at `/api/sessions` (GET list, POST create), `/api/agents`,
  `/api/kill`, `/api/files/list`, `/api/files/read`,
  `/api/sessions/:id/export` (GET — download a `*.hydra` bundle),
  `/api/sessions/import` (POST — accept a bundle), `/api/health`.
- **A WebSocket bridge** at `/ws?session=<id>`. Each browser tab gets its
  own attach to hydra's `/acp`; ACP frames flow through unchanged in
  the upstream→browser direction. Browser→upstream traffic is
  method-whitelisted (`session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_model`, plus permission responses) so a tab can't issue
  arbitrary admin calls.

## HTTPS

Optional on `127.0.0.1`, **required** for any non-loopback bind (the server
refuses otherwise — same rule as the hydra daemon).

### On a tailnet (recommended)

```sh
hydra-acp-browser tailscale setup
```

Mints a real Let's Encrypt cert via `tailscale cert`, points
`BROWSER_TLS_CERT`/`BROWSER_TLS_KEY` at it, binds `BROWSER_HOST` to your
tailnet IP specifically (not `0.0.0.0` — your LAN never sees it), adds your
MagicDNS name to `BROWSER_ALLOWED_HOSTS`, and offers to restart the
extension. No trust prompts, no manual SAN wrangling. Certs expire after
~90 days; re-run the same command to renew.

If `tailscale cert` needs root (no `operator` set — see `tailscale set
--operator=$(whoami)` to fix this permanently), the wizard offers to retry
with `sudo` and fixes up file ownership afterward so the server can still
read the key.

### Without Tailscale: self-signed

The simplest setup is a self-signed cert in `~/.hydra-acp/browser/tls/`.

1. **Generate cert + key.** ECDSA P-256, 5-year validity, with a SAN
   covering loopback. Add any extra hostnames you'll hit it from
   (LAN IP, etc.) to the SAN inline:

   ```sh
   mkdir -p ~/.hydra-acp/browser/tls && chmod 700 ~/.hydra-acp/browser/tls
   cd ~/.hydra-acp/browser/tls

   SAN='subjectAltName=DNS:localhost,DNS:'"$(hostname)"',IP:127.0.0.1,IP:::1'

   openssl req -x509 \
     -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
     -sha256 -days 1825 -nodes \
     -keyout key.pem -out cert.pem \
     -subj "/CN=hydra-acp-browser" \
     -addext "$SAN" \
     -addext "extendedKeyUsage=serverAuth"
   chmod 600 key.pem cert.pem
   ```

   Verify the SAN landed:

   ```sh
   openssl x509 -in cert.pem -noout -text | grep -A1 'Subject Alternative Name'
   ```

   The cert's CN doesn't matter to modern browsers — only the SAN does.
   Skipping `-addext "subjectAltName=…"` will make every browser reject
   the cert with `NET::ERR_CERT_COMMON_NAME_INVALID`.

2. **Wire into config.** Append to `~/.hydra-acp/browser.conf`:

   ```sh
   BROWSER_TLS_CERT=~/.hydra-acp/browser/tls/cert.pem
   BROWSER_TLS_KEY=~/.hydra-acp/browser/tls/key.pem
   ```

   To expose beyond loopback, also set:

   ```sh
   BROWSER_HOST=0.0.0.0
   BROWSER_ALLOWED_HOSTS=mybox,100.64.1.5
   ```

   Every entry in `BROWSER_ALLOWED_HOSTS` must also be in the cert's SAN.

3. **Apply** with `hydra-acp extensions restart hydra-acp-browser`. The
   log line should now read `listening on https://…` and the
   `Open: https://…/` URL is what you load. The auth cookie carries
   `Secure` automatically when serving HTTPS.

4. **Trust the cert.** Self-signed certs trip browser warnings.
   - **Click-through:** open the URL, accept the warning. Per-site only.
   - **Linux Chrome/Chromium:**
     `certutil -d sql:$HOME/.pki/nssdb -A -t "P,," -n hydra-acp browser -i ~/.hydra-acp/browser/tls/cert.pem`
   - **macOS:** double-click `cert.pem`, add to System keychain, set
     "Always Trust" in Get Info.
   - **iOS:** AirDrop/email `cert.pem` to the device, install profile
     (Settings → General → VPN & Device Management), then enable under
     Settings → General → About → Certificate Trust Settings.

If you flip-flop between HTTP and HTTPS, the `Secure` cookie set under
HTTPS won't be sent over plain HTTP — clear cookies for the site (or hit
`/logout`) and sign in again.

## Configuration keys

`~/.hydra-acp/browser.conf` (KEY=VALUE). All keys are optional unless noted.

| Key                          | Default                                | Notes |
|------------------------------|----------------------------------------|-------|
| `BROWSER_HOST`               | `127.0.0.1`                            | Bind host. Non-loopback requires TLS. |
| `BROWSER_PORT`               | `5514`                                 | Listen port. |
| `BROWSER_TLS_CERT`           | (none)                                 | If set with `BROWSER_TLS_KEY`, listen on HTTPS. |
| `BROWSER_TLS_KEY`            | (none)                                 | Path to TLS key. |
| `BROWSER_LINK_FILE`          | `~/.hydra-acp/browser/link`            | URL written for convenience. |
| `BROWSER_ALLOWED_HOSTS`      | empty                                  | Comma-sep extra Host values for DNS-rebind allowlist (e.g. Tailscale name). |
| `BROWSER_FILE_MAX_BYTES`     | `262144`                               | Upper bound for `/api/files/read`. |
| `HYDRA_DAEMON_URL`           | from env / `http://127.0.0.1:55514`    | `HYDRA_ACP_DAEMON_URL` env wins. |
| `HYDRA_WS_URL`               | derived                                | `HYDRA_ACP_WS_URL` env wins. |
| `HYDRA_TOKEN`                | (required)                             | Same precedence as the slack ext. |
| `DEBUG`                      | `false`                                | Verbose logging. |

## Security

- **Password vs. hydra token.** The browser only ever sees the session
  token the daemon issues after a password login. The hydra master
  token stays on the server.
- **Loopback or TLS.** The server refuses to bind a non-loopback host
  unless `BROWSER_TLS_CERT` and `BROWSER_TLS_KEY` are configured —
  mirrors hydra's daemon.
- **DNS-rebind protection.** The `Host` header must match
  `127.0.0.1[:port]`, `localhost[:port]`, or an entry in
  `BROWSER_ALLOWED_HOSTS`.
- **CSRF.** State-changing requests check `Origin` (against
  `<scheme>://<allowed-host>:<port>`) and `Sec-Fetch-Site`
  (`same-origin` / `none` only).
- **CSP.** The HTML response carries a per-request nonce; only
  `'self'` and the matching nonce are allowed for scripts/styles.
- **Rate limit.** 10 failed auth attempts in 15 min from a single
  remote IP triggers a `429` until the window rolls.
- **WS method whitelist.** A compromised tab can only send
  `session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_model`, plus responses to permission requests it has
  actually been forwarded.
- **`fs/*` reverse calls** from agents are rejected at the bridge so a
  tab can't accidentally expose the user's filesystem to the agent
  via this surface.

## Tests

```sh
npm test
```

Runs the auth, CSRF, file-traversal, and bridge-whitelist tests
under the built-in Node test runner.

## Status

Experimental. v1 covers list / chat / tool calls / permissions /
session create / kill / file browse / mode + model picker /
session export + import (download a `*.hydra` bundle from any session,
re-import a bundle from disk). Out of scope: multi-user UI, image
upload from the browser into the agent, transcript search.

## License

MIT.
