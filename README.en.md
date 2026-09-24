# dsh-remote

**English** | [中文](README.md)

Device-authenticated remote access for the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) web UI.
Tap one link on your phone and you're inside DSH — but **devices you never paired cannot get in**, and
read-only devices **cannot send a single command**.

> Status: guard, long-lived links, role enforcement, tunnel supervision, QR entry and the in-DSH panel are all
> implemented and exercised. The suites total **339 assertions** — guard 117 / QR 46 / panel (real DOM) 58 /
> plugin routes 44 / desktop helper 15 / plugin installer 28 / one-command setup 30 / live tunnel 11 — all green. Per-feature evidence is in the
> "Verification log" at the bottom.

---

## Why this exists

All three facts below are DSH's own behavior, not our assumptions:

| Fact | Where it comes from |
|---|---|
| DSH **refuses** to expose its UI to the network: `dsh --host 0.0.0.0` fails outright with "would expose remote code execution to the network"; `@deepseek-ai/dsh-host-webserver` ships **no TLS, no auth, no origin policy** | DSH's own error text and package docs |
| DSH's `/api` is a **full RPC surface that drives a local agent**: `session.prompt` makes the agent run commands, `workspace.delete` deletes sessions, `session.cancel` aborts tasks | Reading the route table in `@deepseek-ai/dsh-host-apiproxy` |
| DSH's `/api` has a **trusted-origin fence**: `Host` must be loopback or allow-listed, and `Origin` must match | `isTrustedApiRequest` in `@deepseek-ai/dsh-client-connection` |

So exposing DSH directly means **handing over control of the machine**, yet using it remotely requires
adding the missing authentication layer yourself — and **without patching DSH**, whose security stance is deliberate.

## What it does

```
phone / tablet / another computer
        │  https (tunnel or LAN)
        ▼
   ┌─────────────┐   no pairing  → 401 + pairing page (leaks nothing about DSH)
   │    guard    │   read-only   → every write is 403 (enforced server-side, by method name)
   │ (this repo) │   paired      → transparent proxy + Host/Origin/Referer rewrite
   └──────┬──────┘
          │  http://127.0.0.1:<local tunnel service port>
          ▼
   ┌─────────────┐
   │ local layer │  e.g. remote.mjs (page injection / attachment shrinking / local endpoints)
   └──────┬──────┘
          ▼
   ┌─────────────┐
   │ DSH Web GUI │  127.0.0.1:<webPort>  (loopback only)
   └─────────────┘
```

**Key design point**: the guard sits **outermost** and neither DSH nor any middle layer knows it's there —
so it works in front of any DSH version and any local reverse proxy.

## Install from scratch (using nothing but this repo)

Prerequisites: **Node ≥ 20**; DSH installed and **started at least once** (so the profile directory
`~/.dsh/profiles/web-desktop` exists).

```bash
# 1)+2) clone and install in one line (run it from inside the repo directory)
git -c http.proxy=http://127.0.0.1:7897 clone https://github.com/laolin2000/dsh-remote.git && cd dsh-remote && node bin/setup.mjs
#   narrow it with --no-tunnel / --no-guard / --dry-run; equivalent script: npm run setup

# 3) restart DSH once (the plugin tree is not hot-reloaded) -> the "手机链接" button appears,
#    bottom-right, directly above the EAC monitor button
```

> Already somewhere else? Run it by **absolute path** — the script locates the repo from its own location,
> not from your cwd: `node "C:\Users\<you>\dsh-remote\bin\setup.mjs"`.
> `Cannot find module .../bin/setup.mjs` means your current directory is not the repo.

What `setup.mjs` does in one go (idempotent, safe to re-run):

| Step | Action |
|---|---|
| 1 | Installs the DSH UI plugin (copy the package, append the mount entry, update the name list, back up first) |
| 2 | Finds cloudflared and writes its path/port/upstream into `guard.json` |
| 3 | Picks the upstream automatically: your local middle layer on 3081 if present, otherwise DSH's own port (50142) |
| 4 | Starts the guard **in the background** (does not hold your terminal; survives closing it) |
| 5 | Brings up the public tunnel and prints the current phone link plus a terminal QR code |

Flags: `--dry-run`, `--no-tunnel`, `--no-guard`, `--port`, `--dsh-port`, `--upstream`, `--cloudflared`, `--profile`.
The last line is a machine-readable `SETUP_OK {...}`.

<details>
<summary>Prefer doing it by hand (or when troubleshooting)</summary>

```bash
node bin/install-plugin.mjs                                   # 1) plugin only
node guard/guard.mjs serve --upstream http://127.0.0.1:50142  # 2) guard in the foreground (easy to watch)
node guard/guard.mjs pair --qr                                # 3) link + QR
node guard/guard.mjs tunnel up --cloudflared "D:/path/to/cloudflared.exe"   # 4) public entry
node guard/guard.mjs status                                   # 5) check listener / upstream / tunnel / devices
```

CLI overrides (all persisted to `guard.json`): `--upstream <url>`, `--port <n>`, `--bind <addr>`,
`--cloudflared <path>`, `--url-file <path>`, `--tunnel-log <path>`, `--inject-panel 0|1`, `--supervise 0|1`.
</details>

> For auto-start at boot see [`docs/deploy/`](docs/deploy/) (Windows Scheduled Task / macOS launchd / Linux
> systemd --user). To remove the plugin: `node bin/install-plugin.mjs --uninstall`.

## Quick start

```bash
# 1) start the guard (defaults: 127.0.0.1:8443 → upstream 127.0.0.1:3081)
node guard/guard.mjs serve

# 2) show the current phone links (one main + one read-only, both long-lived)
node guard/guard.mjs pair
#    script-friendly: the last line is the bare link
node guard/guard.mjs pair --role owner
node guard/guard.mjs pair --role readonly
#    or draw a scannable QR right in the terminal (point the phone camera at it)
node guard/guard.mjs pair --qr
node guard/guard.mjs qr --role readonly        # QR only
node guard/guard.mjs qr --svg > phone.svg      # save it as an image (same code the panel shows)

# 3) send the link to your phone, or scan the QR from the terminal / panel

# 4) let the guard own the public entry (auto-restart, domain written to public-url.txt)
node guard/guard.mjs tunnel up
```

Day-to-day commands:

```bash
node guard/guard.mjs pair --reset        # rotate links; old ones die instantly (already-paired devices keep working)
node guard/guard.mjs pair --code         # one-time credential for a borrowed device (5 min, single use)
node guard/guard.mjs qr [--role X] [--svg]   # print / emit the QR for the current link
node guard/guard.mjs devices             # list authorized devices
node guard/guard.mjs revoke <id|name>    # revoke a device (kills all of its sessions immediately)
node guard/guard.mjs status              # listener / upstream health / tunnel / device count
node guard/guard.mjs tunnel up|down|status   # `down` also clears the auto-restart intent
```

### Link semantics (modeled on ZCode)

- **Long-lived**: one main link and one read-only link, swapped **only** by `--reset`. Resetting invalidates the
  old links immediately, while devices already paired keep working.
- **Reusable**: a link is not single-use. Re-opening it on the same device just refreshes that device's own
  credential — it doesn't pile up duplicate entries in the device list.
- **The read-only link reads the current value**: viewing it never touches the main link.
- Opening flow: server validates the token → sets a 30-day cookie → **302 redirect strips the token from the
  address bar**; responses carry `Referrer-Policy: no-referrer`.
- **Scan to enter**: `pair --qr` draws the QR in the terminal, and the panel's "二维码" button renders it on screen
  (the plugin panel too). The encoder is built in (`guard/qr.mjs`, zero dependencies) and was verified
  module-by-module against a reference implementation — see the verification log.
- **One link = one seat**: redeeming a link reuses **one device record** (matched by name + role), so sharing a
  read-only link means those people share a single record — revoking it logs them all out. Use `--code` when you
  want a separate seat per person.
- **The trade-off**: the token lives in the URL, so it passes through chat apps, browser history and screenshots.
  Rotate deliberately (`--reset`), share the **read-only** link with others, and use `--code` (5 min, single use)
  to lend one device.

Config: `$DSH_HOME/remote/guard.json` (defaults to `~/.dsh/remote/guard.json`; the current link tokens are stored
there in plaintext because the panel has to display them at any time).
Audit: `$DSH_HOME/remote/audit.jsonl` (append-only JSONL). Log: `guard.log`.

## Auth model

- **Pairing**: `pair` on the desktop issues a one-time code (5 minutes, invalidated on use, void after too many
  wrong attempts) → the phone exchanges it for a **device**.
- **Sessions**: pairing sets an `HttpOnly; SameSite=Lax` session cookie (`Secure` added automatically over https).
  The server stores only a **hash** of the token; the plaintext is returned exactly once, at pairing time.
- **Roles**:
  - `owner` — send commands, view images, approve, download; unrestricted;
  - `readonly` — browse sessions, view images, subscribe to event streams; **writes are rejected server-side**.
    Default-deny: there is one allow-list of read-semantics RPC methods, and every other non-GET is a 403, so a
    newly added endpoint can never leak through.
- **CSRF**: `SameSite=Lax` plus an `Origin` check.
- **Revocable**: `revoke` deletes the device and all its sessions immediately, no restart needed.

## Staying connected

- **Tunnel supervision**: the guard checks the tunnel process every 10 s and restarts it with backoff (2 s → 60 s),
  writing the new domain to `urlFile`. Measured: after killing cloudflared, a new tunnel was up in **6 seconds**;
- **Wanting a tunnel is an explicit intent**: `tunnel up` turns it on; `tunnel down` turns it off *and* clears the
  auto-restart intent, so it cannot quietly come back;
- **The guard heals itself too**: the DSH UI plugin checks every 60 s and starts the guard if it is not running
  (the panel also has a "运行状态 / one-click repair" row). This came out of a real report: after a machine or DSH
  restart the guard — a plain background process — stayed dead, which looks like "phone and web page both broke".
- **Queryable domain**: `urlFile` exists for agents/skills to read (this repo writes `public-url.txt` by default),
  so "the domain changed and I don't know the new link" stops being a thing;
- **Visible failures**: unauthorized requests get an actual **pairing page** rather than a blank error; an
  unreachable upstream produces an explicit message; every rejection lands in the audit log.

## Deployment

| Platform | Approach |
|---|---|
| Windows | Scheduled Task / Startup-folder shortcut (`Start-Process -WindowStyle Hidden`) |
| macOS | user-level `launchd` plist (`KeepAlive=true`) |
| Linux | `systemd --user` unit (`Restart=always`) |

> Templates live in [`docs/deploy/`](docs/deploy/). The core rule is one line: **keep `guard.mjs serve` running.**

## Seeing it inside the DSH UI

The guard can inject a panel into pages it serves (the phone path), but the desktop DSH app talks to its own
port directly and never passes through the guard — so the desktop entry point is a separate DSH plugin:
[`plugin/`](plugin/README.en.md). Its README documents the two hard requirements we tripped over
(`exports["./package.json"]` must be exported; client chunks are hand-written `window.__ModuleLoader__.load`).

Install it with one command (copies the package, appends the mount entry, updates the plugin-name list, backs up
whatever it touches — **restart DSH afterwards**):

```bash
node bin/install-plugin.mjs                # or npm run install-plugin
node bin/install-plugin.mjs --uninstall    # remove only what the installer added
node bin/install-plugin.mjs --dry-run      # print the plan
```

The button then sits in the bottom-right corner, directly above the EAC monitor button, in the same column and style.

There's also a plugin-free desktop helper: `bin/phone-link.cmd` (popup with the current link; `--reset` to rotate,
`--role readonly` for the read-only link, `--qr` to open the QR image, `--quiet` to print without a popup).

The panel itself is **one current link + four buttons** (copy / QR / read-only / reset) plus the authorized device
list with per-device revoke. Copying gives real feedback ("已复制 ✓" plus a timestamp), and when the browser blocks
the clipboard it says so instead of pretending it worked.

## Layout

```
guard/guard.mjs      the guard: auth, role enforcement, long-lived links, QR, tunnel supervision (zero dependencies, Node builtins only)
guard/qr.mjs         built-in QR encoder (byte mode / versions 1–10 / L-M-Q-H / best-mask selection, zero deps)
guard/ui.js          the control panel the guard injects into phone-side pages
plugin/              DSH UI plugin (desktop "phone link" panel + control-plane routes)
bin/                 desktop helper scripts (show / reset / QR / copy the link)
test/                tests: selftest(117) qr(46) panel.dom(58) plugin(44) bin(15) install(28) setup(30) tunnel(11)
docs/deploy/         keep-alive templates for Windows / macOS / Linux
```

Running the tests:

```bash
npm test              # guard + QR + plugin + desktop helper (no third-party dependencies)
npm run test:panel    # real-DOM panel behaviour (needs: npm i --no-save jsdom)
npm run test:tunnel   # live cloudflared self-heal / shutdown check (~1–2 min, skips if absent)
```

## Threat model (please read before using)

**What it protects**: an unpaired device can neither see nor change anything in DSH; a read-only device cannot
change anything.

**What it does not protect**:

1. **A paired `owner` device is your computer.** DSH's agent runs commands as you — by design, not a flaw.
2. **Read-only ≠ limiting the agent**: it restricts *who may issue commands*, not *what the agent can do*.
3. **The tunnel is someone else's service** (e.g. Cloudflare Quick Tunnel); its availability and ToS are outside
   this project's control.
4. **The session cookie lives in the browser**: a lost or unlocked phone is an authorized device — use `revoke`.
5. **Cookies travel in the clear over plain HTTP**: always use an https tunnel externally (the `Secure` flag only
   takes effect over https).

**Secure by default**: binds `127.0.0.1` only; with no paired devices, everything except the pairing page and the
health endpoint is refused (fail-closed).

## One trap worth knowing

If your **old tunnel script** points the tunnel straight at the middle layer (e.g. `--url http://127.0.0.1:3081`),
it **bypasses the guard** — and your public entry is naked again. Point the tunnel at the guard's port (8443 by
default): use `guard tunnel up`, or change the old script's target port to 8443.

## Verification log (every feature was exercised, not eyeballed)

Testing turned up these **real** defects — all fixed:

| Feature | What testing found | Fix |
|---|---|---|
| `tunnel down` | it killed the process but not the "want a tunnel" intent → the supervisor brought it back ~10 s later (measured: revived after 12 s) | `down` now also writes `superviseTunnel=false` |
| Cross-origin preflight | the OPTIONS 204 carried no CORS headers → the browser blocked cross-origin POSTs from the DSH page (the panel's fallback reset/revoke failed) | `withLocalCors` merges CORS into every `writeHead` call |
| Plugin fallback reset | the client's direct-to-guard fallback had no endpoint to call (`/__guard/reset` → 404) | added `POST /__guard/reset` and mapped `/dsh-remote/reset`, `/dsh-remote/qr` |
| Tunnel start failure | a failed `spawn` left only an `unhandledRejection` while `tunnel up` reported "waiting for the domain timed out"; `.cmd/.bat` wrappers are refused outright by Node | catch the `error` event, stop waiting early, print the real cause (with a `.cmd`-specific hint) |
| Panel "read-only" button | once opened it could never be collapsed (wrong toggle condition — user-reported) | a real on/off toggle plus a DOM regression test |
| Desktop helper `--reset --role readonly` | `--reset` was silently ignored | pass it through, plus a bin test |
| Built-in QR encoder | ① format-info cells weren't marked as function modules before data placement → the codeword stream had holes and **scanners could not decode it at all**; ② mask 2 tested the row instead of the column; ③ the N4 penalty formula differed from the standard, so auto mask selection chose the wrong mask | all three fixed, then verified module-by-module against a reference implementation: 1332 combinations (text × version × ECC × mask) all identical, plus end-to-end decoding with jsqr |

What the suites cover:

- **guard** — `test/selftest.mjs` (111): fail-closed, pairing codes, long-lived link semantics, read-only boundaries,
  owner control plane, WS allow-list, Origin/CSRF, loopback-trusted vs tunnel-untrusted, page injection + appearance
  keeper, QR endpoint, reset endpoint, tunnel intent, audit.
- **QR** — `test/qr.test.mjs` (46): 6 golden matrices module-by-module, 3 Reed-Solomon vectors, the generator
  polynomial, structural assertions. The golden vectors come from npm's `qrcode`, used on a dev machine to generate
  vectors only — **not a runtime dependency**.
- **panel** — `test/panel.dom.mjs` (33): mounts the real panels in jsdom and clicks through them.
- **plugin routes** — `test/plugin.test.mjs` (29): real handler; `reset` and `qr` really invoke the guard CLI.
- **desktop helper** — `test/bin.test.mjs` (15): temp DSH_HOME, "default leaves the link alone" semantics.
- **tunnel** — `test/tunnel.test.mjs` (11): real cloudflared — domain acquired and written to urlFile, self-heal in
  6–45 s after a kill, and no resurrection 24 s after `down`.

## Roadmap

- Named tunnel / stable domain (the Quick Tunnel domain changes on every restart — the biggest rough edge today)
- `guard.mjs doctor` (upstream reachability, tunnel health, port conflicts in one shot)
- Audit viewer, per-device rate limiting, configurable read-method allow-list for read-only devices
- Completion notifications

## License

MIT
