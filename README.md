# acp-hydra-browser

A browser-based UI for [acp-hydra](https://github.com/smagnuson/acp-hydra)
sessions. Runs as a hydra extension (or standalone) and serves a small
single-page app on localhost that lists live sessions, mirrors them in real
time, and lets you prompt, approve permission requests, switch modes/models,
spawn fresh sessions, kill old ones, and browse the project files of any
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

- **HTTP routes** at `/api/sessions`, `/api/agents`, `/api/spawn`, `/api/kill`,
  `/api/files/list`, `/api/files/read`, `/api/health`.
- **A WebSocket bridge** at `/ws?session=<id>`. Each browser tab gets its
  own attach to hydra's `/acp` as `controller`; ACP frames flow through
  unchanged in the upstream→browser direction. Browser→upstream traffic is
  method-whitelisted (`session/prompt`, `session/cancel`, `session/set_mode`,
  `session/set_model`, plus permission responses) so a tab can't issue
  arbitrary admin calls.

## Setup

1. **Build.**

   ```sh
   cd ~/dev/acp-hydra-browser
   npm install
   npm run build
   ```

2. **Run as a hydra extension (recommended).** Add an entry to
   `~/.acp-hydra/config.json`:

   ```json
   {
     "extensions": {
       "acp-hydra-browser": {
         "command": ["node", "/home/you/dev/acp-hydra-browser/dist/index.js"]
       }
     }
   }
   ```

   On `acp-hydra daemon start`, hydra spawns the extension with
   `ACP_HYDRA_DAEMON_URL`, `ACP_HYDRA_TOKEN`, `ACP_HYDRA_WS_URL` set.
   The first launch generates `~/.acp-hydra-browser/authkey` and writes
   the open URL (with `?authkey=…`) to `~/.acp-hydra-browser/link`.
   Tail the log to see it:

   ```sh
   acp-hydra extensions logs acp-hydra-browser --follow
   ```

3. **Run standalone (alternative).** Set `HYDRA_TOKEN` in
   `~/.acp-hydra-browser.conf` (or export `ACP_HYDRA_TOKEN`), then:

   ```sh
   npm start
   ```

4. **Open the browser** to the URL printed on stderr. The first request
   sets a cookie; subsequent requests are authenticated by the cookie
   alone. The URL is also at `~/.acp-hydra-browser/link` for convenience.

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
spawn / kill / file browse / mode + model picker. Out of scope:
multi-user UI, image upload from the browser into the agent,
transcript search.

## License

MIT.
