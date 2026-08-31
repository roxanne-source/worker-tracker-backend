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
const admin = require("firebase-admin");

const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// --- Firebase Admin setup (for sending wake-up pushes) ----------------
// Needs a service account key from Firebase Console > Project Settings
// > Service Accounts > Generate new private key. NEVER commit that file
// to git — on Render, paste its full JSON content into an environment
// variable named FIREBASE_SERVICE_ACCOUNT (Render dashboard > your
// service > Environment). Locally, you can instead save it as
// serviceAccountKey.json in this folder (also .gitignored).
let firebaseReady = false;
try {
  const serviceAccount = process.env.FIREBASE_SERVICE_ACCOUNT
    ? JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT)
    : require("./serviceAccountKey.json"); // local dev fallback, gitignored
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  firebaseReady = true;
  console.log("Firebase Admin initialized — wake-up pushes enabled.");
} catch (e) {
  console.log("Firebase Admin NOT initialized (no service account found) — wake-up pushes disabled.", e.message);
}

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
// Simplified to two states: online if we've heard from the phone
// recently, idle otherwise — this stays idle indefinitely until a
// fresh update comes in, no separate "offline" tier. A device that has
// never reported at all is also shown as idle for simplicity.
const ONLINE_MS = 5 * 60 * 1000; // heard from within 5 min -> online, otherwise idle

function computeStatus(d) {
  if (!d || !d.lastHeartbeat) return "idle"; // never reported at all
  const age = Date.now() - d.lastHeartbeat;
  return age <= ONLINE_MS ? "online" : "idle";
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

  const id = b.device_id || b.extras?.device_id || b.tid || b.topic || b.uuid || "unknown-device";
  const name = b.device_name || b.extras?.device_name || null;
  const lat = b.lat ?? b.coords?.latitude;
  const lng = (b.lng ?? b.lon) ?? b.coords?.longitude;
  const accuracy = b.accuracy ?? b.acc ?? b.coords?.accuracy;

  // Battery can arrive as a plain number (our old format, OwnTracks'
  // "batt") OR as an object like { level: 0.72, is_charging: false }
  // (this library's default schema) — checking b.battery's TYPE
  // explicitly avoids assigning that whole object where a number is
  // expected, which is what caused "[object Object]%" on the map.
  let battery = null;
  if (typeof b.battery === "number") {
    battery = b.battery;
  } else if (b.battery && typeof b.battery.level === "number") {
    battery = Math.round(b.battery.level * 100);
  } else if (typeof b.batt === "number") {
    battery = b.batt;
  } else if (typeof b.battery_level === "number") {
    battery = Math.round(b.battery_level * 100);
  }

  if (typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "lat and lng (or lon, or coords.latitude/longitude) are required numbers" });
  }

  const patch = {
    lat,
    lng,
    battery,
    accuracy: accuracy ?? null,
    ts: Date.now(),
    lastHeartbeat: Date.now(),
  };
  // Only update the stored name if a real (non-empty) one was sent —
  // an empty string shouldn't erase a name set on an earlier ping.
  if (name && name.trim()) patch.name = name.trim();

  upsertDevice(id, patch);

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

// --- Task acknowledgment -----------------------------------------------
// A separate, explicit "I acknowledge this task, here's my location
// right now" event, distinct from routine background tracking pings.
// Kept as its own list (not overwriting device history) so you have a
// clear record of when/where each worker acknowledged.
const acknowledgments = []; // { device_id, device_name, lat, lng, battery, ts }

app.post("/api/acknowledge", (req, res) => {
  const b = req.body || {};
  const { device_id, lat, lng } = b;

  if (!device_id || typeof lat !== "number" || typeof lng !== "number") {
    return res.status(400).json({ error: "device_id, lat, and lng are required" });
  }

  const record = {
    device_id,
    device_name: b.device_name || null,
    lat,
    lng,
    battery: typeof b.battery === "number" ? b.battery : null,
    ts: b.ts || Date.now(),
  };
  acknowledgments.push(record);
  console.log(`Task acknowledged by ${b.device_name || device_id} at ${lat}, ${lng}`);

  // Also update the device's live position/status on the map, same as
  // a normal tracking ping, since an acknowledgment IS a fresh, real
  // location reading.
  upsertDevice(device_id, {
    lat,
    lng,
    battery: record.battery,
    ts: Date.now(),
    lastHeartbeat: Date.now(),
    ...(record.device_name ? { name: record.device_name } : {}),
  });

  res.json({ ok: true });
});

// See the full acknowledgment history (most recent first).
app.get("/api/acknowledgments", (req, res) => {
  res.json([...acknowledgments].reverse());
});

// --- Push token registration -----------------------------------------
// The app calls this once on startup (and whenever Firebase rotates
// its token) so we know WHERE to send a wake-up push for this device.
app.post("/api/register-token", (req, res) => {
  const { device_id, fcm_token } = req.body || {};
  if (!device_id || !fcm_token) {
    return res.status(400).json({ error: "device_id and fcm_token are required" });
  }
  upsertDevice(device_id, { fcmToken: fcm_token });
  console.log(`Registered push token for ${device_id}`);
  res.json({ ok: true });
});

// --- Wake-up push logic ------------------------------------------------
// Runs periodically: for any device that has gone IDLE (per the same
// online/idle logic the map uses) and that we haven't already pinged
// recently, send a silent data-only push. The app's background message
// handler (index.js) wakes up just enough to grab a fresh location and
// send it through the normal pipeline — this is the actual "server
// pings the phone" mechanism, and the reason we're trying it: internal
// app timers (heartbeat) proved unreliable once a device goes fully
// idle/backgrounded on this test device, even with every standard and
// advanced Android fix applied.
const PING_COOLDOWN_MS = 3 * 60 * 1000; // don't re-ping the same device more than once per 3 min

async function checkIdleDevicesAndPing() {
  if (!firebaseReady) return;

  const now = Date.now();
  for (const [id, d] of Object.entries(devices)) {
    if (!d.fcmToken) continue;
    if (computeStatus(d) !== "idle") continue; // only nudge devices currently idle
    if (d.lastPingSent && now - d.lastPingSent < PING_COOLDOWN_MS) continue;

    try {
      await admin.messaging().send({
        token: d.fcmToken,
        data: { type: "wake_up_request" }, // data-only = silent, no visible notification
        android: { priority: "high" },
      });
      upsertDevice(id, { lastPingSent: now });
      console.log(`Sent wake-up push to ${id}`);
    } catch (e) {
      console.log(`Wake-up push to ${id} failed: ${e.message}`);
    }
  }
}
setInterval(checkIdleDevicesAndPing, 30 * 1000); // check every 30 sec

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Worker tracker server running on http://localhost:${PORT}`);
});
