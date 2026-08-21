// server.js
//
// This is the "brain" that receives location pings from phones and
// remembers, per worker, when we last heard from them.
//
// Think of it like a PLC scan loop: every incoming message updates a
// register (the device's last-known state). We never trust a single
// missed reading as "failure" -- we only decide someone is
// offline/stale after enough time has passed without an update.

const express = require("express");
const path = require("path");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- In-memory store -------------------------------------------------
// For "get it working now" this lives in RAM. Swap this object for a
// real database (Postgres, SQLite, etc.) once you move past the demo
// stage -- the rest of the code doesn't need to change, just these
// three functions.
const devices = {}; // deviceId -> { lat, lng, ts, battery, acc, lastHeartbeat }

function upsertDevice(id, patch) {
  devices[id] = { ...(devices[id] || {}), ...patch };
}

function getAllDevices() {
  return Object.entries(devices).map(([id, d]) => ({ id, ...d, status: computeStatus(d) }));
}

// --- Status logic ------------------------------------------------------
// This is the fix for the "unknown/offline" problem you mentioned with
// Traccar. Instead of one vague flag, we compute status from *time
// since last contact*, and we separate "we heard from the phone at all"
// (heartbeat) from "we have a fresh GPS fix" (location).
const ONLINE_MS = 2 * 60 * 1000;   // heard from within 2 min -> online
const STALE_MS = 10 * 60 * 1000;   // heard from within 10 min -> stale
// anything older than STALE_MS -> offline

function computeStatus(d) {
  if (!d || !d.lastHeartbeat) return "unknown"; // never reported at all
  const age = Date.now() - d.lastHeartbeat;
  if (age <= ONLINE_MS) return "online";
  if (age <= STALE_MS) return "stale";
  return "offline";
}

// --- Ingest endpoint -----------------------------------------------
// Accepts several shapes so different clients can point straight at
// this endpoint without extra glue code:
//  1) Our own simple format:      { device_id, lat, lng, battery, accuracy }
//  2) OwnTracks' native format:   { _type: "location", tid, lat, lon, batt, acc, tst }
//  3) react-native-background-geolocation's default format:
//       { location: { coords: { latitude, longitude, accuracy }, battery: { level }, uuid, timestamp } }
//     (or the top-level body itself shaped like that "location" object,
//     depending on SDK version/config)
app.post("/api/location", (req, res) => {
  const raw = req.body || {};
  console.log("Received /api/location:", JSON.stringify(raw));

  // OwnTracks also sends non-location messages (e.g. "_type":"status" with
  // battery/permission info, no coordinates). We just acknowledge those
  // without treating them as an error.
  if (raw._type && raw._type !== "location") {
    return res.status(200).json([]);
  }

  // Unwrap react-native-background-geolocation's envelope, whichever
  // shape it arrives in.
  const b = raw.location || (Array.isArray(raw.locations) ? raw.locations[0] : null) || raw;

  const id = b.device_id || b.tid || b.topic || b.uuid || "unknown-device";
  const lat = b.lat ?? b.coords?.latitude;
  const lng = (b.lng ?? b.lon) ?? b.coords?.longitude;
  const accuracy = b.accuracy ?? b.acc ?? b.coords?.accuracy;

  let battery = b.battery ?? b.batt ?? null;
  if (battery == null && typeof b.battery_level === "number") battery = Math.round(b.battery_level * 100);
  if (battery == null && typeof b.battery?.level === "number") battery = Math.round(b.battery.level * 100);

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng (or lon, or coords.latitude/longitude) are required numbers" });
  }

  upsertDevice(id, {
    lat,
    lng,
    battery,
    accuracy: accuracy ?? null,
    ts: Date.now(),
    lastHeartbeat: Date.now(),
  });

  // OwnTracks expects a 200 with a JSON array back (can be empty);
  // react-native-background-geolocation just needs any 2xx response.
  res.status(200).json([]);
});

// A super lightweight "I'm alive" ping that doesn't need GPS.
// Useful for your own future custom app: send this every minute even
// if the location hasn't changed, so a stopped heartbeat clearly means
// "connectivity/app problem" rather than "location problem."
app.post("/api/heartbeat", (req, res) => {
  const id = req.body?.device_id;
  if (!id) return res.status(400).json({ error: "device_id required" });
  upsertDevice(id, { lastHeartbeat: Date.now() });
  res.json({ ok: true });
});

// --- Read endpoint for the frontend map -----------------------------
app.get("/api/devices", (req, res) => {
  res.json(getAllDevices());
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker tracker server running on http://localhost:${PORT}`);
});
