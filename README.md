# acp-hydra-browser

A browser-based UI for [acp-hydra](https://github.com/smagnuson/acp-hydra)
sessions. Runs as a hydra extension (or standalone) and serves a small
single-page app on localhost that lists live sessions, mirrors them in real
time, and lets you prompt, approve permission requests, switch modes/models,
create fresh sessions, kill old ones, and browse the project files of any
session — all from a phone or laptop browser.

The hydra master token never leaves the machine; the browser authenticates
with a separate per-host authkey instead.

## How it works

```
                     hydra REST    +-------------------+         browser
       /v1/sessions   <----------  |                   |  ---->   GET /
                                   |  acp-hydra-browser |  <---->  /ws?session=<id>
       hydra WSS      <----------> |                   |
       /acp                        +-------------------+
                                            |
                                  ~/.acp-hydra-browser/
                                    authkey
                                    link
```

The extension exposes:

- **HTTP routes** at `/api/sessions` (GET list, POST create), `/api/agents`,
  `/api/kill`, `/api/files/list`, `/api/files/read`, `/api/health`.
- **A WebSocket bridge** at `/ws?session=<id>`. Each browser tab gets its
  own attach to hydra's `/acp` as `controller`; ACP frames flow through
  unchanged in the upstream→browser direction. Browser→upstream traffic is
  method-whitelisted (`session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_model`, plus permission responses) so a tab can't issue
  arbitrary admin calls.

## Setup

1. **Install or build.**

   From npm (recommended once published):

   ```sh
   npm install -g @acp-hydra/browser
   ```

   This drops an `acp-hydra-browser` binary on your PATH.

   Or from source:

   ```sh
   git clone https://github.com/smagnuson/acp-hydra-browser.git ~/dev/acp-hydra-browser
   cd ~/dev/acp-hydra-browser
   npm install
   npm run build
   ```

2. **Run as a hydra extension (recommended).** Register the extension
   with hydra. If installed via npm:

   ```sh
   acp-hydra extensions add acp-hydra-browser --command acp-hydra-browser
   ```

   Or pointed at a local build:

   ```sh
   acp-hydra extensions add acp-hydra-browser \
     --command node \
     --args ~/dev/acp-hydra-browser/dist/index.js
   ```

   That writes the equivalent entry into `~/.acp-hydra/config.json`:

   ```json
   {
     "extensions": {
       "acp-hydra-browser": {
         "command": ["node"],
         "args": ["/home/you/dev/acp-hydra-browser/dist/index.js"],
         "enabled": true
       }
     }
   }
   ```

   `extensions add` is config-only — it doesn't spawn anything yet.
   Either bounce the daemon, or, if the daemon is already running,
   kick the extension into life:

   ```sh
   acp-hydra extensions start acp-hydra-browser
   ```

   On startup, hydra spawns acp-hydra-browser with these env vars set:
   `ACP_HYDRA_DAEMON_URL`, `ACP_HYDRA_TOKEN`, `ACP_HYDRA_WS_URL`. The
   first launch generates `~/.acp-hydra-browser/authkey` and writes
   the open URL (with `?authkey=…`) to `~/.acp-hydra-browser/link`.
   Stdout/stderr land in `~/.acp-hydra/extensions/acp-hydra-browser.log`.
   Lifecycle is managed with
   `acp-hydra extensions start|stop|restart acp-hydra-browser` —
   `restart` is the right call after `npm run build`. Tail the log
   with `acp-hydra extensions logs acp-hydra-browser -f` (the open URL
   shows up there on first launch).

3. **Run standalone (alternative).** Set `HYDRA_TOKEN` in
   `~/.acp-hydra-browser.conf` (or export `ACP_HYDRA_TOKEN`), then:

   ```sh
   npm start
   ```

4. **Open the browser** to the URL printed on stderr. The first request
   sets a cookie; subsequent requests are authenticated by the cookie
   alone. The URL is also at `~/.acp-hydra-browser/link` for convenience.

## HTTPS

Optional on `127.0.0.1`, **required** for any non-loopback bind (the server
refuses otherwise — same rule as the hydra daemon). The simplest setup
is a self-signed cert in `~/.acp-hydra-browser/tls/`.

1. **Generate cert + key.** ECDSA P-256, 5-year validity, with a SAN
   covering loopback. Add any extra hostnames you'll hit it from
   (Tailscale name, LAN IP, etc.) to the SAN inline:

   ```sh
   mkdir -p ~/.acp-hydra-browser/tls && chmod 700 ~/.acp-hydra-browser/tls
   cd ~/.acp-hydra-browser/tls

   SAN='subjectAltName=DNS:localhost,DNS:'"$(hostname)"',IP:127.0.0.1,IP:::1'
   #     ^ add ,DNS:my.tailnet.ts.net  or  ,IP:100.64.x.y  if needed.

   openssl req -x509 \
     -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
     -sha256 -days 1825 -nodes \
     -keyout key.pem -out cert.pem \
     -subj "/CN=acp-hydra-browser" \
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

2. **Wire into config.** Append to `~/.acp-hydra-browser.conf`:

   ```sh
   BROWSER_TLS_CERT=~/.acp-hydra-browser/tls/cert.pem
   BROWSER_TLS_KEY=~/.acp-hydra-browser/tls/key.pem
   ```

   To expose beyond loopback, also set:

   ```sh
   BROWSER_HOST=0.0.0.0
   BROWSER_ALLOWED_HOSTS=mybox,mybox.tailnet.ts.net,100.64.1.5
   ```

   Every entry in `BROWSER_ALLOWED_HOSTS` must also be in the cert's SAN.

3. **Apply** with `acp-hydra extensions restart acp-hydra-browser`. The
   log line should now read `listening on https://…` and the
   `Open: https://…/?authkey=…` URL is what you load. The auth cookie
   carries `Secure` automatically when serving HTTPS.

4. **Trust the cert.** Self-signed certs trip browser warnings.
   - **Click-through:** open the URL, accept the warning. Per-site only.
   - **Linux Chrome/Chromium:**
     `certutil -d sql:$HOME/.pki/nssdb -A -t "P,," -n acp-hydra-browser -i ~/.acp-hydra-browser/tls/cert.pem`
   - **macOS:** double-click `cert.pem`, add to System keychain, set
     "Always Trust" in Get Info.
   - **iOS:** AirDrop/email `cert.pem` to the device, install profile
     (Settings → General → VPN & Device Management), then enable under
     Settings → General → About → Certificate Trust Settings.

If you're already on Tailscale, [`tailscale cert`](https://tailscale.com/kb/1153/enabling-https)
issues a real Let's Encrypt cert for `<host>.tailnet.ts.net` — strictly
better than self-signed (no trust prompts, ~30 s setup). Drop the
output paths into `BROWSER_TLS_CERT` / `BROWSER_TLS_KEY` and skip
step 4.

If you flip-flop between HTTP and HTTPS, the `Secure` cookie set under
HTTPS won't be sent over plain HTTP. Run
`acp-hydra-browser --rotate-authkey` to start fresh.

## Configuration keys

`~/.acp-hydra-browser.conf` (KEY=VALUE). All keys are optional unless noted.

| Key                          | Default                                | Notes |
|------------------------------|----------------------------------------|-------|
| `BROWSER_HOST`               | `127.0.0.1`                            | Bind host. Non-loopback requires TLS. |
| `BROWSER_PORT`               | `9099`                                 | Listen port. |
| `BROWSER_TLS_CERT`           | (none)                                 | If set with `BROWSER_TLS_KEY`, listen on HTTPS. |
| `BROWSER_TLS_KEY`            | (none)                                 | Path to TLS key. |
| `BROWSER_AUTHKEY_FILE`       | `~/.acp-hydra-browser/authkey`         | Where the browser-side authkey lives. |
| `BROWSER_LINK_FILE`          | `~/.acp-hydra-browser/link`            | URL written for convenience. |
| `BROWSER_ALLOWED_HOSTS`      | empty                                  | Comma-sep extra Host values for DNS-rebind allowlist (e.g. Tailscale name). |
| `BROWSER_FILE_MAX_BYTES`     | `262144`                               | Upper bound for `/api/files/read`. |
| `HYDRA_DAEMON_URL`           | from env / `http://127.0.0.1:8765`     | `ACP_HYDRA_DAEMON_URL` env wins. |
| `HYDRA_WS_URL`               | derived                                | `ACP_HYDRA_WS_URL` env wins. |
| `HYDRA_TOKEN`                | (required)                             | Same precedence as the slack ext. |
| `DEBUG`                      | `false`                                | Verbose logging. |

## Security

- **Authkey vs. hydra token.** The browser only ever sees a per-host
  authkey (32 bytes, hex). The hydra master token stays on the server.
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
session create / kill / file browse / mode + model picker. Out of scope:
multi-user UI, image upload from the browser into the agent,
transcript search.

## License

MIT.
