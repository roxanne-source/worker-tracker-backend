# Worker Live Location Tracker (starter version)

A minimal working system: a backend that receives phone location
pings, and a live map that shows each worker color-coded by status.
No database yet — data lives in memory, so it resets if the server
restarts. That's fine for testing; swap in a real database later.

## Files

- `server.js` — the backend (Node.js + Express)
- `public/index.html` — the live map (Leaflet.js, loads from CDN)

## How to run it

1. Install Node.js (v18+) if you don't have it: https://nodejs.org
2. In this folder, run:
   ```
   npm install
   node server.js
   ```
3. Open http://localhost:3000 in your browser — you'll see an empty map.
4. Send a test location (in a second terminal):
   ```
   curl -X POST localhost:3000/api/location \
     -H "Content-Type: application/json" \
     -d '{"device_id":"worker_01","lat":1.3521,"lng":103.8198,"battery":85}'
   ```
   Refresh the map — you'll see a green dot appear.

## Point your OwnTracks app at it (fastest way to get REAL phone data)

In OwnTracks: Settings → Connection →
- Mode: **HTTP**
- Host: your computer/server's address (e.g. `http://192.168.1.X:3000` on
  your local network, or a public URL once deployed)
- Path: `/api/location`

OwnTracks sends its own JSON shape (`tid`, `lat`, `lon`, `batt`, `acc`,
`tst`) — the server already understands that format alongside our
own simpler one, so no extra setup needed.

## How the "unknown/offline" fix works

Every device has a `lastHeartbeat` timestamp (updated on every ping).
Status is computed live from *how long ago* that was:

| Time since last ping | Status  |
|-----------------------|---------|
| < 2 minutes           | online  |
| 2–10 minutes          | stale   |
| > 10 minutes          | offline |
| never reported        | unknown |

This is deliberately simple right now. The next real upgrades (see
our conversation) would be:
- A separate lightweight `/api/heartbeat` ping sent every minute even
  with no GPS movement, so you can tell "phone alive, GPS delayed"
  apart from "phone/app actually dead."
- Local queueing on the phone so a temporarily offline worker's points
  get backfilled once they reconnect, instead of just showing a gap.
- Swapping the in-memory store for Postgres (or similar) so data
  survives restarts and you can query location history.

## Endpoints

- `POST /api/location` — phone sends a location ping
- `POST /api/heartbeat` — lightweight "I'm alive" ping (no GPS needed)
- `GET /api/devices` — returns all known devices with live-computed status
