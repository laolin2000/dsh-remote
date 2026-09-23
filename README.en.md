# dsh-remote

**English** | [中文](README.md)

Device-authenticated remote access for the [DeepSeek Harness](https://github.com/deepseek-ai) (DSH) web UI.
Tap one link on your phone and you're inside DSH — but **devices you never paired cannot get in**, and
read-only devices **cannot send a single command**.

> Status: guard, long-lived links, role enforcement, tunnel supervision and the in-DSH panel are all
> implemented and exercised — 65/65 selftest assertions green. See the roadmap at the bottom for what's left.

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

## Quick start

```bash
# 1) start the guard (defaults: 127.0.0.1:8443 → upstream 127.0.0.1:3081)
node guard/guard.mjs serve

# 2) show the current phone links (one main + one read-only, both long-lived)
node guard/guard.mjs pair
#    script-friendly: the last line is the bare link
node guard/guard.mjs pair --role owner
node guard/guard.mjs pair --role readonly

# 3) send the link to your phone — opening it pairs the device and lands in DSH

# 4) let the guard own the public entry (auto-restart, domain written to public-url.txt)
node guard/guard.mjs tunnel up
```

Day-to-day commands:

```bash
node guard/guard.mjs pair --reset        # rotate links; old ones die instantly (already-paired devices keep working)
node guard/guard.mjs pair --code         # one-time credential for a borrowed device (5 min, single use)
node guard/guard.mjs devices             # list authorized devices
node guard/guard.mjs revoke <id|name>    # revoke a device (kills all of its sessions immediately)
node guard/guard.mjs status              # listener / upstream health / tunnel / device count
node guard/guard.mjs tunnel up|down|status
```

### Link semantics (modeled on ZCode)

- **Long-lived**: one main link and one read-only link, swapped **only** by `--reset`. Resetting invalidates the
  old links immediately, while devices already paired keep working.
- **Reusable**: a link is not single-use. Re-opening it on the same device just refreshes that device's own
  credential — it doesn't pile up duplicate entries in the device list.
- **The read-only link reads the current value**: viewing it never touches the main link.
- Opening flow: server validates the token → sets a 30-day cookie → **302 redirect strips the token from the
  address bar**; responses carry `Referrer-Policy: no-referrer`.
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
  writing the new domain to `urlFile`;
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

There's also a plugin-free desktop helper: `bin/phone-link.cmd` (popup with the current link; `--reset` to rotate,
`--role readonly` for the read-only link).

## Layout

```
guard/guard.mjs      the guard: auth, role enforcement, long-lived links, tunnel supervision (zero dependencies, Node builtins only)
guard/ui.js          the control panel the guard injects into phone-side pages
plugin/              DSH UI plugin (desktop "phone link" panel + control-plane routes)
bin/                 desktop helper scripts (show / reset / copy the link)
test/selftest.mjs    selftest: full auth + role matrix against a fake upstream (65 assertions, never touches a real DSH)
docs/deploy/         keep-alive templates for Windows / macOS / Linux
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

## Roadmap

- Pairing QR code (scan instead of copy-paste)
- `guard.mjs doctor` (upstream reachability, tunnel health, port conflicts in one shot)
- Audit viewer, per-device rate limiting, configurable read-method allow-list for read-only devices
- Completion notifications

## License

MIT
