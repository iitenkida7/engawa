# engawa

**English** ｜ [日本語](./README.ja.md)

**A virtual office for your team, running in nothing but a browser.**

🌐 **Landing page: [iitenkida7.github.io/engawa](https://iitenkida7.github.io/engawa/)（[日本語](https://iitenkida7.github.io/engawa/ja/)）**　｜　📖 [Engineering notes](https://iitenkida7.github.io/engawa/reader/en.html)（[日本語](https://iitenkida7.github.io/engawa/reader/)）　｜　🗺️ [Map JSON spec](https://iitenkida7.github.io/engawa/map/en.html)（[日本語](https://iitenkida7.github.io/engawa/map/)）

Walk an avatar around a 2D map. Get close to someone and voice, video and screen share
connect on their own — walk away and they drop. It goes after the part of an office that
remote work loses, the minute of talk you never scheduled, and keeps it light and cheap.

```
        ┌──────────────────────────────────────────────┐
        │  . . . . . . . . . . . . . . . . . . . . . . │
        │     (•‿•) ──── walk closer ────→ (^_^)       │
        │      you                        Tanaka       │
        │  . . . . . . . . . . . . . . . . . . . . . . │
        └──────────────────────────────────────────────┘
```

---

## 🍵 Where the name comes from

> An *engawa* is the wooden strip of floor along the edge of a Japanese house, between the
> inside and the garden. You could sit on it without an errand, and trade a few words with
> whoever happened to walk past — that kind of place.
>
> engawa is that edge of the office: somewhere you can be next to someone without a meeting.

---

## ✨ What it does

| | Feature | Notes |
|---|---|---|
| 🚶 | Move around | Arrow keys, `h` `j` `k` `l` (vim) or `w` `a` `s` `d`. Click a tile to walk there |
| 🔊 | Proximity voice | Audio connects by itself within a radius, and drops when you leave |
| 📷 | Video | Turn the camera on to show your face. Whoever is speaking gets a lit border |
| 🖥 | Screen share | One click. Switch between a small window, a side panel and full screen |
| 🪟 | Faces stay visible while sharing | Their camera tile mirrors into an always-on-top window (Chrome / Edge, for single-display setups). Off by default — tick "🪟 Face in a small window while screen sharing" in the ⋯ menu |
| ⏺ | Recording | Records the whole screen (floor + screen share + every camera) with everyone's audio, in the browser. **The file downloads when you press ■ stop.** While recording, a "REC + elapsed" badge sits top-right and the tab title shows "● REC"; closing the tab without stopping saves what was recorded so far (filename gets `-autosave`) |
| 🟢 | Status | Online / busy / away |
| 🔔 | Proximity chime | A light sound when someone arrives or leaves |
| 🚪 | Leaving a room turns media off | Walking out of a meeting room or lounge switches mic, camera and screen share off (recording continues; coming back does not turn them on again) |
| 🔒 | Entry password | Set `ACCESS_PASSWORD` and the office asks for it at the door (optional — open by default) |
| 👥 | Calls that hold up | Two or more people go through the SFU by default, so a crowd scales (needs Cloudflare Realtime SFU; without it everyone is P2P) |
| 📲 | Installable | Installs as a PWA on desktop Chrome / Edge — its own window, parked in the Dock or taskbar |

---

## 🎮 Using it

1. Open the app in a browser
2. Enter a name (and a password, if the office has one)
3. Move with the **arrow keys**, or **`h` `j` `k` `l`** if your hands live on the home row
4. **Walk up to someone** — that is the whole act of starting a call

The toolbar has mic, camera, screen share, recording and status.

### ⌨ Keys

There is one line to remember: **a bare key does something only you notice, `Shift` does
something everyone notices** (screen share, recording).

All three movement dialects work as they are.

| Key | Action |
|---|---|
| `←` `↓` `↑` `→` | Move (arrows) |
| `h` `j` `k` `l` | Move (vim) |
| `w` `a` `s` `d` | Move (WASD) |

| Key | Action |
|---|---|
| `m` | Mic on/off |
| `c` | Camera on/off |
| `v` | Meeting view ⇄ map view |
| `z` | Zoom to yourself ⇄ whole floor |
| `p` | Participant list |
| `1`–`6` | Reactions |
| `Shift` + `S` | Screen share on/off |
| `Shift` + `R` | Start/stop recording |
| `?` | Key reference |
| `Esc` | Back out of a maximized panel |

Keys do nothing while the cursor is in a text field. The same reference is under
**⋯ → Keyboard shortcuts** in the toolbar.

> With `ACCESS_PASSWORD` set, a password screen comes before the name screen.

> **Install it as an app**: on desktop Chrome / Edge, the install icon in the address bar
> (or "Install app" in the menu) gives it its own window with no browser chrome.

---

## 🚀 Running it (development)

Everything goes through Docker. `docker-compose.yml` and the `Makefile` sit at the
repository root.

```bash
cp .env.example .env   # optional — only to set TURN or a password
make up                # start in the background
```

Development runs behind **Caddy, which terminates HTTPS**:

- **App: https://engawa.localhost** ← this is the way in
- The first visit warns about the certificate, because Caddy's local CA isn't trusted yet.
  See "Trusting the local CA" below.

> `.localhost` resolves to `127.0.0.1` on its own, so there is no hosts file to edit.

| Command | What it does |
|---|---|
| `make up` | Start (`docker compose up -d`) |
| `make down` | Stop |
| `make restart` | Restart |
| `make test` | Run the tests (server and client) |
| `make build` | Type-check and build the client for production |

> WebRTC only runs on **HTTPS or localhost**. The app carries no TLS of its own: **terminating
> TLS is the reverse proxy's job**. In production, terminate HTTPS (including `wss://`) at your
> own proxy — Caddy, nginx, a cloud load balancer, whatever you already run.

### Trusting the local CA

`tls internal` issues certificates signed by a local CA. To silence the warning, install that
CA's root certificate:

```bash
# Take the CA root certificate out of the Caddy container
docker compose cp caddy:/data/caddy/pki/authorities/local/root.crt ./caddy-root.crt
```

- **macOS**: double-click `caddy-root.crt`, then set it to "Always Trust" in Keychain Access
- **Windows**: import into "Trusted Root Certification Authorities"
- **Linux**: drop it in `/usr/local/share/ca-certificates/` and run `sudo update-ca-certificates`

### Testing from a phone on the same LAN

WebRTC on another device needs HTTPS, and `tls internal` certificates aren't trusted there by
default, so:

1. Find the host machine's LAN IP (say `192.168.1.10`)
2. Add `192.168.1.10 engawa.localhost` to the other device's hosts file — the certificate is
   issued for `engawa.localhost`, so open that name rather than the bare IP
   - On iOS and anything else without an editable hosts file, you need an alternative such as
     resolving the same name through an internal DNS server
3. Copy `caddy-root.crt` to that device and install and trust it
4. Open **https://engawa.localhost** there

> These steps (hosts, distributing the CA) depend on your own devices. This repository carries
> no deployment configuration tied to a particular host.

---

## 🧱 Stack

**Server**
- [Bun](https://bun.sh/) with the standard WebSocket — close to no dependencies
- Its whole job: sync positions, relay WebRTC signaling, decide and publish each group's
  transport (mesh/SFU), and proxy the TURN/SFU control plane. Media never passes through it

**Client**
- TypeScript + [Vite](https://vitejs.dev/)
- Drawing is the plain Canvas 2D API — no UI framework
- WebRTC through [simple-peer](https://github.com/feross/simple-peer) (P2P mesh) plus
  Cloudflare Realtime SFU (crowds and meeting rooms, with simulcast layers)

**Infrastructure**
- STUN: Google's public servers
- TURN: Cloudflare Realtime, used only when a direct path can't be found
- SFU: Cloudflare Realtime SFU, for meeting rooms and larger groups. Without it, everything
  falls back to a P2P mesh

---

## 🏗 Architecture

Media — audio, video, screen share — **never travels through the engawa server**. Two or more
people go through Cloudflare Realtime SFU by default (raise `SFU_PROMOTE_AT` and small groups
stay on a P2P mesh); with no SFU configured, every group is a mesh. Either way your own server
stays media-free. What it does is introduce people, sync positions, and decide the transport.

```
[browser A]                 [server (Bun)]                   [browser B]
   │  WebSocket  ←───────→  ├ broadcast positions  ←────────→  │  WebSocket
   │                        ├ relay WebRTC signaling (mesh)     │
   │                        ├ decide + publish mesh/SFU groups  │
   │                        ├ /api/turn-credentials             │
   │                        └ /api/sfu/* (SFU control proxy)    │
   │                                                            │
   ├── two or more people (default): via Cloudflare Realtime SFU ┤
   └── no SFU configured / below the threshold: WebRTC P2P mesh ─┘
          media never passes through engawa (P2P or Cloudflare only)
```

### What the server is responsible for
1. **Serving static files**
2. **Position sync** — take each client's coordinates and broadcast them
3. **WebRTC signaling relay** — forward offer / answer / ICE candidates (mesh)
4. **Deciding and publishing groups** — derive proximity groups from positions and meeting-room
   zones, pick mesh or SFU, and tell everyone
5. **Issuing and proxying TURN / SFU** — call the Cloudflare API for short-lived credentials and
   relay SFU control requests (the API keys stay on the server)

---

## 📁 Layout

```
engawa/
├ client/                   # Vite + TypeScript front end
│  └ src/
│     ├ core/               # orchestration and plumbing (app.ts's game loop, network.ts, proximity.ts)
│     ├ rtc/                # the media paths (webrtc.ts = P2P mesh, sfu.ts = Cloudflare SFU, sdp.ts)
│     ├ media/              # capture, processing, recording (media.ts, recorder.ts, noise.ts, vbg.ts)
│     ├ world/              # drawing and walking the 2D map (canvas.ts, tilemap.ts, pathfind.ts)
│     └ ui/                 # DOM panels and controls (toolbar.ts, remote-media.ts, roster.ts)
├ server/
│  └ src/
│     ├ index.ts            # Bun server entry — wiring only
│     ├ http.ts             # HTTP routing (/api/* and static files)
│     ├ websocket.ts        # WS message handlers
│     ├ logic.ts            # pure logic (coordinates, proximity grouping, entry checks)
│     ├ map.ts              # loading and validating the map
│     ├ settings.ts         # settings from a control plane (optional)
│     ├ entry.ts            # signing and verifying entry tickets (ENTRY_MODE=token)
│     ├ turn.ts             # Cloudflare TURN credentials
│     ├ sfu.ts              # proxy for the Cloudflare Realtime SFU control plane
│     └ events.ts           # event webhook (optional — docs/webhook.md)
└ maps/                     # the map format (map-def.ts) and bundled maps (*.json), shared by both
```

---

## ⚙️ Configuration

`.env` (copy `.env.example`):

```bash
PORT=3000

# Cloudflare TURN (optional — without it, STUN only)
CLOUDFLARE_TURN_TOKEN_ID=
CLOUDFLARE_TURN_TOKEN_SECRET=

# Cloudflare Realtime SFU (optional — without it, everyone is on a P2P mesh)
CLOUDFLARE_REALTIME_APP_ID=
CLOUDFLARE_REALTIME_APP_TOKEN=

# Group size at which calls move to the SFU (optional — default 2, i.e. every call)
SFU_PROMOTE_AT=

# Entry password (optional — without it the office is open)
ACCESS_PASSWORD=

# Which map to use (optional — a bundled preset name or a URL; default office_medium)
MAP=

# Event webhook (optional — POSTs arrivals, departures and conversations as JSON)
EVENT_WEBHOOK_URL=
EVENT_WEBHOOK_SECRET=
EVENT_INCLUDE_NAMES=
```

- For **TURN**, create a token under Cloudflare Dashboard → Realtime → TURN.
- For the **SFU**, create an app under Cloudflare Dashboard → Realtime → SFU and set the app id
  and token. Everything still works without it, on a mesh — only scaling to a crowd is limited.
- **SFU_PROMOTE_AT** is the group size at which an open-floor call moves to the SFU (default `2`,
  so even a pair goes through it — chosen for how reliably it connects). Set it to `4` and groups
  of two or three stay P2P, saving a hop of latency and the SFU's bandwidth. Meeting-room zones
  always use the SFU whatever the headcount. Ignored when no SFU is configured.
- **ACCESS_PASSWORD** puts a password in front of the name screen. Unset, the office is open.
- **ENTRY_MODE=token** hands the question of who may enter to **a control plane**. Instead of a
  shared password, people arrive through a link carrying a short-lived **entry ticket** signed by
  whoever runs the office (`/?t=…`), and **the display name comes from the ticket**, so it cannot
  be faked (which makes transcripts and recordings attributable). Verification happens **inside the
  office** using `CONTROL_PLANE_TOKEN` — nothing is asked of an outside service. See
  [`docs/entry-token.md`](./docs/entry-token.md)（[日本語](./docs/entry-token.ja.md)）. Unset,
  `ACCESS_PASSWORD` behaves as before.
- **CONTROL_PLANE_URL** makes the server **fetch the settings above from an HTTP endpoint**,
  periodically. It is for running engawa on someone's behalf and changing settings without a
  restart, which would disconnect everyone. See
  [`docs/control-plane.md`](./docs/control-plane.md)（[日本語](./docs/control-plane.ja.md)）.
  Unset, only the environment is read — the normal self-hosted case.
- **MAP** picks the map: a bundled preset (`office_medium` / `office_small`) or the URL of a map
  JSON. Default `office_medium`. Mount your own at `/maps` in the container and name it, or pass a
  URL. The format is in the [Map JSON spec](https://iitenkida7.github.io/engawa/map/en.html)
  （[日本語](https://iitenkida7.github.io/engawa/map/)）. A map that fails validation stops the
  server from starting.
- **EVENT_WEBHOOK_URL** POSTs arrivals, departures and the start and end of conversations as JSON
  (for meeting statistics, say). The server only sends; it stores nothing. Participants are
  anonymous ids by default, or display names with `EVENT_INCLUDE_NAMES=true`. `EVENT_WEBHOOK_SECRET`
  signs the body. The contract is in [`docs/webhook.md`](./docs/webhook.md)
  （[日本語](./docs/webhook.ja.md)）, and a receiver that files everything into a Google Sheet is in
  [`examples/webhook-gas/`](./examples/webhook-gas/README.md).

---

## 🐳 Deploying (container)

A **host-agnostic container image** comes with the repository (`Dockerfile`). The Bun server
serves the built client out of `./public`, so static files, `/ws` and `/api` all sit behind a
**single port and a single origin**.

```bash
docker build -t engawa .
docker run -p 3000:3000 \
  -e CLOUDFLARE_TURN_TOKEN_ID=xxx -e CLOUDFLARE_TURN_TOKEN_SECRET=yyy \
  -e CLOUDFLARE_REALTIME_APP_ID=zzz -e CLOUDFLARE_REALTIME_APP_TOKEN=www \
  engawa
```

Pushing a `v*` tag has GitHub Actions (`.github/workflows/release.yml`) publish the image to
**GHCR**: `ghcr.io/<owner>/engawa`.

### A production sample with Caddy ([`production_sample/docker_compose/`](./production_sample/docker_compose/))

[`production_sample/docker_compose/`](./production_sample/docker_compose/) holds a sample you can
drop on a VPS as it is. **Caddy terminates HTTPS with Let's Encrypt** and reverse-proxies to the
published GHCR image.

```bash
# on a host with a real domain pointed at it, ports 80/443 reachable:
cd production_sample/docker_compose
cp .env.example .env   # set ENGAWA_DOMAIN / ACME_EMAIL / TURN and so on
docker compose up -d
```

- Point `ENGAWA_DOMAIN`'s DNS at the host and open ports **80/443**; Caddy obtains and renews the
  certificate on its own.
- `ENGAWA_IMAGE` picks the image (default `ghcr.io/iitenkida7/engawa:latest`). In production,
  **pin a version tag** such as `:vX.Y.Z`.
- The server container publishes no port to the host — it is reachable **only through Caddy**,
  which keeps static files, `/ws` and `/api` on one origin.
- For the details, see
  [`production_sample/docker_compose/README.md`](./production_sample/docker_compose/README.md).
  It is a different thing from the development `docker-compose.yml` / `Caddyfile` at the repository
  root (`tls internal`, `engawa.localhost`).

Worth knowing:

- **Terminating TLS belongs to your reverse proxy or your platform's edge.** The app has no TLS of
  its own, and **configuration tied to a particular host does not live in this repository**
  (`fly.toml` and the like belong in your own environment).
- ⚠️ **Run exactly one instance.** Position sync and signaling live in one process's memory;
  scaled horizontally, people on different instances stop seeing each other. (Media is P2P, so it
  doesn't care how many instances there are.)
- Don't bake TURN tokens or `ACCESS_PASSWORD` into the image — pass them as **runtime environment
  variables or secrets**.

---

## 🧭 Design invariants

1. **Audio, video and screen share never pass through the engawa server** — only P2P / TURN or
   Cloudflare Realtime SFU. Even with the SFU, your own server stays media-free.
2. **The signaling server holds no state** — no database. Group information and the SFU's
   temporary state live in memory and may be thrown away on restart.
3. **Cloudflare API keys (TURN and SFU alike) stay on the server** — the browser only ever gets
   short-lived credentials, or access through the proxy.
4. **HTTPS is required** (localhost development aside).

---

## 🎨 Credits

The avatar sprites (the character creator) come from **LPC
([Universal-LPC-Spritesheet-Character-Generator](https://github.com/LiberatedPixelCup/Universal-LPC-Spritesheet-Character-Generator))**.

- Author, license and source URL are recorded per part in
  [`engawa/client/src/assets/lpc/CREDITS.csv`](./engawa/client/src/assets/lpc/CREDITS.csv). The full
  text of every license sits in the same directory (`LICENSE-CC-BY-SA-3.0.txt` /
  `LICENSE-CC-BY-3.0.txt` / `LICENSE-CC-BY-4.0.txt` / `LICENSE-OGA-BY-3.0.txt` /
  `LICENSE-CC0-1.0.txt` / `LICENSE-GPL-3.0.txt` / `LICENSE-GPL-2.0.txt`).
- LPC art is a mix of **CC-BY-SA 3.0 / CC-BY 3.0 / CC-BY 4.0 / OGA-BY 3.0 / GPL 2.0 / GPL 3.0 /
  CC0**, part by part (see [License](#-license)). The character creator also carries an
  "Art: LPC · credits" link at the bottom.
- The map tiles are **[Kenney](https://kenney.nl)'s Roguelike Indoors (CC0)**
  ([`engawa/client/src/assets/KENNEY-roguelike-indoors-LICENSE.txt`](./engawa/client/src/assets/KENNEY-roguelike-indoors-LICENSE.txt)).
- **These asset licenses are a separate matter from engawa's own code (MIT).**

---

## 🤝 Contributing

- Commit messages and code comments are written in English.
- TypeScript strict mode, semicolons, single quotes, two-space indentation.
- Anything touching the app (building, testing, adding dependencies) goes through Docker.

The rules in full are in [`CLAUDE.md`](./CLAUDE.md).

---

## 📄 License

engawa's **source code is under the [MIT License](./LICENSE)**.

The **bundled art is third-party work** under its own licenses, which are a separate matter from
the code.

| | License |
|---|---|
| Source code | **MIT** |
| Map tiles (Kenney "Roguelike Indoors") | **CC0** (no conditions) |
| Avatar art (LPC) | per part: **CC0 / OGA-BY 3.0 / CC-BY 3.0 / CC-BY 4.0 / CC-BY-SA 3.0 / GPL 2.0 / GPL 3.0** |

Three things about the LPC art are easy to misread, so to save you the trouble:

- **No part is GPL-only.** The `;` separators in
  [`CREDITS.csv`](./engawa/client/src/assets/lpc/CREDITS.csv) list licenses you may **choose
  between** — that is the LPC convention, not a conjunction. Every part that offers GPL also offers
  a Creative Commons license, so **the avatar art cannot pull engawa's code into the GPL**.
- **ShareAlike binds only a few parts.** Seven hairstyles are CC-BY-SA 3.0 with no alternative. If
  you **modify and redistribute** an avatar image containing them, that image has to go out under
  CC-BY-SA 3.0. (Hosting engawa as it is, for your own people, doesn't enter into it.)
- **Attribution is required.** OGA-BY, CC-BY and CC-BY-SA all ask for the author's name. engawa
  shows it in three places: CREDITS.csv, this README, and the character creator. If you
  redistribute with the art still in it, leave those three in place.

To be free of asset licensing altogether, replace `engawa/client/src/assets/` with your own art.
