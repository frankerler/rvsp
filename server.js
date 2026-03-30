const express = require("express");
const Database = require("better-sqlite3");
const nodemailer = require("nodemailer");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const fs = require("fs");

// Load .env
try {
  const env = fs.readFileSync(path.join(__dirname, ".env"), "utf8");
  env.split("\n").forEach((line) => {
    const [key, ...rest] = line.split("=");
    if (key && rest.length) {
      process.env[key.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
    }
  });
} catch {}

const PORT = process.env.PORT || 3000;
const BASE_URL = process.env.BASE_URL || `http://localhost:${PORT}`;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "admin";

// ── Database ──
const dbPath = process.env.RAILWAY_VOLUME_MOUNT_PATH
  ? path.join(process.env.RAILWAY_VOLUME_MOUNT_PATH, "rsvp.db")
  : path.join(__dirname, "rsvp.db");
const db = new Database(dbPath);
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL DEFAULT 'Untitled Event',
    subtitle TEXT DEFAULT '',
    description TEXT DEFAULT '',
    description2 TEXT DEFAULT '',
    event_date TEXT DEFAULT '',
    event_day TEXT DEFAULT '',
    event_time TEXT DEFAULT '',
    doors_time TEXT DEFAULT '',
    location_name TEXT DEFAULT '',
    location_address TEXT DEFAULT '',
    price TEXT DEFAULT 'Free',
    max_spots INTEGER DEFAULT 30,
    is_active INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT DEFAULT ''
  );

  CREATE TABLE IF NOT EXISTS rsvps (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    email TEXT NOT NULL,
    token TEXT NOT NULL UNIQUE,
    status TEXT DEFAULT 'confirmed',
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (event_id) REFERENCES events(id),
    UNIQUE(event_id, email)
  );
`);

// Migration: add status column if missing
try {
  db.prepare("SELECT status FROM rsvps LIMIT 1").get();
} catch {
  db.exec("ALTER TABLE rsvps ADD COLUMN status TEXT DEFAULT 'confirmed'");
  console.log("Migrated: added status column to rsvps");
}

// Seed default settings
const settingsCount = db.prepare("SELECT COUNT(*) as c FROM settings").get();
if (settingsCount.c === 0) {
  const defaults = {
    site_title: "Design & AI",
    page_title: "Upcoming\nEvents",
    page_subtitle: "Find an event, reserve your spot.",
  };
  const insertSetting = db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)");
  for (const [k, v] of Object.entries(defaults)) insertSetting.run(k, v);
}

// Seed a default event if none exist
const eventCount = db.prepare("SELECT COUNT(*) as c FROM events").get();
if (eventCount.c === 0) {
  db.prepare(`INSERT INTO events (slug, title, subtitle, description, description2, event_date, event_day, event_time, doors_time, location_name, location_address, price, max_spots)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    "designing-with-ai",
    "Designing with AI.\nPrototyping & Vibe Coding.",
    "",
    "An evening with product designers who are actively using AI in their prototyping workflow. From generating UI concepts to vibe coding functional prototypes — hear how they actually work with these tools day-to-day.",
    "Expect short talks, live demos, and an open conversation about what works, what doesn't, and where this is all heading. Whether you're already building with AI or just curious — this one's for you.",
    "May 15, 2026",
    "Thursday",
    "6:30 PM",
    "Doors at 6:00",
    "The Design Studio",
    "Torstrasse 123, Berlin",
    "Free",
    30
  );
}

// Prepared statements
const stmts = {
  allSettings: db.prepare("SELECT * FROM settings"),
  getSetting: db.prepare("SELECT value FROM settings WHERE key = ?"),
  upsertSetting: db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value"),
  allEvents: db.prepare("SELECT * FROM events ORDER BY created_at DESC"),
  activeEvents: db.prepare("SELECT * FROM events WHERE is_active = 1 ORDER BY created_at DESC"),
  eventById: db.prepare("SELECT * FROM events WHERE id = ?"),
  eventBySlug: db.prepare("SELECT * FROM events WHERE slug = ?"),
  createEvent: db.prepare(`INSERT INTO events (slug, title, subtitle, description, description2, event_date, event_day, event_time, doors_time, location_name, location_address, price, max_spots, is_active)
    VALUES (@slug, @title, @subtitle, @description, @description2, @event_date, @event_day, @event_time, @doors_time, @location_name, @location_address, @price, @max_spots, @is_active)`),
  updateEvent: db.prepare(`UPDATE events SET
    slug=@slug, title=@title, subtitle=@subtitle, description=@description, description2=@description2,
    event_date=@event_date, event_day=@event_day, event_time=@event_time, doors_time=@doors_time,
    location_name=@location_name, location_address=@location_address,
    price=@price, max_spots=@max_spots, is_active=@is_active
    WHERE id=@id`),
  deleteEvent: db.prepare("DELETE FROM events WHERE id = ?"),
  countConfirmed: db.prepare("SELECT COUNT(*) as count FROM rsvps WHERE event_id = ? AND status = 'confirmed'"),
  countWaitlisted: db.prepare("SELECT COUNT(*) as count FROM rsvps WHERE event_id = ? AND status = 'waitlisted'"),
  insertRsvp: db.prepare("INSERT INTO rsvps (event_id, name, email, token, status) VALUES (?, ?, ?, ?, ?)"),
  findByEmail: db.prepare("SELECT * FROM rsvps WHERE event_id = ? AND email = ?"),
  findByToken: db.prepare("SELECT * FROM rsvps WHERE token = ?"),
  deleteByToken: db.prepare("DELETE FROM rsvps WHERE token = ?"),
  confirmedByEvent: db.prepare("SELECT * FROM rsvps WHERE event_id = ? AND status = 'confirmed' ORDER BY created_at DESC"),
  waitlistedByEvent: db.prepare("SELECT * FROM rsvps WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at ASC"),
  guestsByEvent: db.prepare("SELECT * FROM rsvps WHERE event_id = ? ORDER BY status ASC, created_at ASC"),
  deleteGuestsByEvent: db.prepare("DELETE FROM rsvps WHERE event_id = ?"),
  nextWaitlisted: db.prepare("SELECT * FROM rsvps WHERE event_id = ? AND status = 'waitlisted' ORDER BY created_at ASC LIMIT 1"),
  promoteGuest: db.prepare("UPDATE rsvps SET status = 'confirmed' WHERE id = ?"),
};

// ── Email ──
let transporter = null;
if (process.env.SMTP_HOST && process.env.SMTP_USER && process.env.SMTP_PASS) {
  transporter = nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: parseInt(process.env.SMTP_PORT || "587", 10),
    secure: process.env.SMTP_PORT === "465",
    auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
  });
  console.log("Email configured:", process.env.SMTP_USER);
} else {
  console.log("Email not configured — set SMTP_HOST, SMTP_USER, SMTP_PASS in .env");
}

function emailLayout(heading, intro, event, footerHtml) {
  const title = event.title.replace(/\n/g, " ");
  const mapsUrl = `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(event.location_name + ', ' + event.location_address)}`;
  return `
<!DOCTYPE html>
<html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1.0"></head>
<body style="margin:0;padding:0;background:#faf9f7;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#faf9f7;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="padding:0 0 32px;">
          <p style="margin:0;font-size:13px;font-weight:700;letter-spacing:0.02em;color:#1a1a1a;">DESIGN & AI</p>
        </td></tr>

        <!-- Heading -->
        <tr><td style="padding:0 0 8px;">
          <h1 style="margin:0;font-size:28px;font-weight:700;color:#1a1a1a;line-height:1.2;">${heading}</h1>
        </td></tr>

        <!-- Intro -->
        <tr><td style="padding:0 0 32px;">
          <p style="margin:0;font-size:16px;color:#888;line-height:1.5;">${intro}</p>
        </td></tr>

        <!-- Dark tile -->
        <tr><td style="padding:0 0 32px;">
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#1a1a1a;border-radius:20px;">
            <tr><td style="padding:36px 32px;">

              <!-- Event title -->
              <p style="margin:0 0 24px;font-size:20px;font-weight:700;color:#fff;line-height:1.2;">${title}</p>

              <!-- Details grid -->
              <table width="100%" cellpadding="0" cellspacing="0">
                <tr>
                  <td width="50%" valign="top" style="padding:0 0 20px;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#39ff14;">Date</p>
                    <p style="margin:0;font-size:15px;font-weight:600;color:#fff;">${event.event_date}</p>
                    <p style="margin:2px 0 0;font-size:13px;color:rgba(255,255,255,0.5);">${event.event_day}</p>
                  </td>
                  <td width="50%" valign="top" style="padding:0 0 20px;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#39ff14;">Time</p>
                    <p style="margin:0;font-size:15px;font-weight:600;color:#fff;">${event.event_time}</p>
                    <p style="margin:2px 0 0;font-size:13px;color:rgba(255,255,255,0.5);">${event.doors_time}</p>
                  </td>
                </tr>
                <tr>
                  <td width="50%" valign="top" style="padding:0 0 4px;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#39ff14;">Location</p>
                    <p style="margin:0;font-size:15px;font-weight:600;color:#fff;">${event.location_name}</p>
                    <p style="margin:2px 0 0;font-size:13px;"><a href="${mapsUrl}" style="color:rgba(255,255,255,0.5);text-decoration:underline;">${event.location_address}</a></p>
                  </td>
                  <td width="50%" valign="top" style="padding:0 0 4px;">
                    <p style="margin:0 0 4px;font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#39ff14;">Price</p>
                    <p style="margin:0;font-size:15px;font-weight:600;color:#fff;">${event.price}</p>
                  </td>
                </tr>
              </table>

            </td></tr>
          </table>
        </td></tr>

        <!-- Footer content -->
        ${footerHtml}

        <!-- Brand footer -->
        <tr><td style="padding:32px 0 0;border-top:1px solid #eae8e4;">
          <p style="margin:0;font-size:11px;color:#ccc;text-align:center;">Design & AI</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body></html>`;
}

function sendConfirmation(event, name, email, token) {
  if (!transporter) {
    console.log("Skipping email (not configured) for:", email);
    return Promise.resolve();
  }
  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const title = event.title.replace(/\n/g, " ");

  return transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: `You're in — ${title}`,
    html: emailLayout(
      "You're in.",
      `Hey ${name}, your spot is confirmed. See you there!`,
      event,
      `<tr><td style="padding:0 0 16px;">
        <p style="margin:0;font-size:14px;color:#888;line-height:1.6;">Can't make it? Cancel your RSVP so someone else can take your spot.</p>
      </td></tr>
      <tr><td>
        <a href="${cancelUrl}" style="font-size:14px;font-weight:600;color:#1a1a1a;text-decoration:underline;text-underline-offset:3px;">Cancel my RSVP &rarr;</a>
      </td></tr>`
    ),
  });
}

function sendWaitlistConfirmation(event, name, email, position) {
  if (!transporter) {
    console.log("Skipping waitlist email (not configured) for:", email);
    return Promise.resolve();
  }
  const title = event.title.replace(/\n/g, " ");

  return transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: `You're on the waitlist — ${title}`,
    html: emailLayout(
      "You're on the waitlist.",
      `Hey ${name}, the event is currently full but you're #${position} on the waitlist. We'll email you if a spot opens up.`,
      event,
      `<tr><td>
        <p style="margin:0;font-size:14px;color:#888;line-height:1.6;">Sit tight — we'll let you know as soon as something changes.</p>
      </td></tr>`
    ),
  });
}

function sendPromotionEmail(event, name, email, token) {
  if (!transporter) {
    console.log("Skipping promotion email (not configured) for:", email);
    return Promise.resolve();
  }
  const cancelUrl = `${BASE_URL}/cancel/${token}`;
  const title = event.title.replace(/\n/g, " ");

  return transporter.sendMail({
    from: process.env.EMAIL_FROM || process.env.SMTP_USER,
    to: email,
    subject: `A spot opened up — ${title}`,
    html: emailLayout(
      "You're in!",
      `Hey ${name}, a spot opened up and you've been moved off the waitlist. Your spot is confirmed!`,
      event,
      `<tr><td style="padding:0 0 16px;">
        <p style="margin:0;font-size:14px;color:#888;line-height:1.6;">Can't make it? Cancel your RSVP so someone else can take your spot.</p>
      </td></tr>
      <tr><td>
        <a href="${cancelUrl}" style="font-size:14px;font-weight:600;color:#1a1a1a;text-decoration:underline;text-underline-offset:3px;">Cancel my RSVP &rarr;</a>
      </td></tr>`
    ),
  });
}

// Promote next waitlisted person when a confirmed spot opens
function promoteNextWaitlisted(eventId) {
  const event = stmts.eventById.get(eventId);
  if (!event) return;
  const { count } = stmts.countConfirmed.get(eventId);
  if (count >= event.max_spots) return; // still full

  const next = stmts.nextWaitlisted.get(eventId);
  if (!next) return; // no one on waitlist

  stmts.promoteGuest.run(next.id);
  console.log(`Promoted ${next.email} from waitlist for event ${eventId}`);
  sendPromotionEmail(event, next.name, next.email, next.token).catch((err) =>
    console.error("Promotion email failed:", err.message)
  );
}

// ── Auth ──
function requireAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith("Basic ")) return res.status(401).json({ error: "Unauthorized" });
  try {
    const password = Buffer.from(auth.slice(6), "base64").toString();
    if (password.trim() !== ADMIN_PASSWORD.trim()) return res.status(401).json({ error: "Wrong password" });
    next();
  } catch { return res.status(401).json({ error: "Unauthorized" }); }
}

// ── App ──
const app = express();
app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// ── Public API ──

// Public settings
app.get("/api/settings", (req, res) => {
  const rows = stmts.allSettings.all();
  const settings = {};
  rows.forEach(r => settings[r.key] = r.value);
  res.json(settings);
});

// List active events
app.get("/api/events", (req, res) => {
  const events = stmts.activeEvents.all().map((e) => {
    const { count } = stmts.countConfirmed.get(e.id);
    const { count: waitlisted } = stmts.countWaitlisted.get(e.id);
    return { ...e, taken: count, available: e.max_spots - count, waitlisted };
  });
  res.json(events);
});

// Single event
app.get("/api/events/:slug", (req, res) => {
  const event = stmts.eventBySlug.get(req.params.slug);
  if (!event) return res.status(404).json({ error: "Event not found" });
  const { count } = stmts.countConfirmed.get(event.id);
  const { count: waitlisted } = stmts.countWaitlisted.get(event.id);
  res.json({ ...event, taken: count, available: event.max_spots - count, waitlisted });
});

// RSVP to an event
app.post("/api/events/:slug/rsvp", async (req, res) => {
  const event = stmts.eventBySlug.get(req.params.slug);
  if (!event) return res.status(404).json({ error: "Event not found" });

  const { name, email } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Name and email are required." });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: "Please enter a valid email." });

  const existing = stmts.findByEmail.get(event.id, email);
  if (existing) return res.status(409).json({ error: "This email is already registered." });

  const { count } = stmts.countConfirmed.get(event.id);
  const isFull = count >= event.max_spots;
  const status = isFull ? "waitlisted" : "confirmed";

  const token = uuidv4();
  try { stmts.insertRsvp.run(event.id, name, email, token, status); }
  catch { return res.status(409).json({ error: "This email is already registered." }); }

  if (isFull) {
    const { count: waitlistPos } = stmts.countWaitlisted.get(event.id);
    sendWaitlistConfirmation(event, name, email, waitlistPos).catch((err) =>
      console.error("Waitlist email failed:", err.message)
    );
    const updated = stmts.countConfirmed.get(event.id);
    res.json({ success: true, waitlisted: true, position: waitlistPos, available: event.max_spots - updated.count });
  } else {
    sendConfirmation(event, name, email, token).catch((err) => console.error("Email failed:", err.message));
    const updated = stmts.countConfirmed.get(event.id);
    res.json({ success: true, waitlisted: false, available: event.max_spots - updated.count });
  }
});

// Cancel RSVP
app.delete("/api/rsvp/:token", (req, res) => {
  const rsvp = stmts.findByToken.get(req.params.token);
  if (!rsvp) return res.status(404).json({ error: "RSVP not found or already cancelled." });
  const wasConfirmed = rsvp.status === "confirmed";
  stmts.deleteByToken.run(req.params.token);

  // If a confirmed guest cancelled, promote next from waitlist
  if (wasConfirmed) {
    promoteNextWaitlisted(rsvp.event_id);
  }

  const event = stmts.eventById.get(rsvp.event_id);
  const { count } = stmts.countConfirmed.get(rsvp.event_id);
  res.json({ success: true, available: event ? event.max_spots - count : 0 });
});

// Event page route
app.get("/event/:slug", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "event.html"));
});

// Cancel page route
app.get("/cancel/:token", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "cancel.html"));
});

// Custom admin route
const ADMIN_PATH = process.env.ADMIN_PATH || "/admin.html";
app.get(ADMIN_PATH, (req, res) => {
  res.sendFile(path.join(__dirname, "public", "admin.html"));
});

// ── Admin API ──

// List all events (including inactive)
app.get("/api/admin/events", requireAdmin, (req, res) => {
  const events = stmts.allEvents.all().map((e) => {
    const { count } = stmts.countConfirmed.get(e.id);
    const { count: waitlisted } = stmts.countWaitlisted.get(e.id);
    return { ...e, taken: count, available: e.max_spots - count, waitlisted };
  });
  res.json(events);
});

// Update settings
app.put("/api/admin/settings", requireAdmin, (req, res) => {
  const allowed = ["site_title", "page_title", "page_subtitle"];
  for (const [key, value] of Object.entries(req.body)) {
    if (allowed.includes(key)) stmts.upsertSetting.run(key, value);
  }
  res.json({ success: true });
});

// Create event
app.post("/api/admin/events", requireAdmin, (req, res) => {
  const data = {
    slug: req.body.slug || uuidv4().slice(0, 8),
    title: req.body.title || "Untitled Event",
    subtitle: req.body.subtitle || "",
    description: req.body.description || "",
    description2: req.body.description2 || "",
    event_date: req.body.event_date || "",
    event_day: req.body.event_day || "",
    event_time: req.body.event_time || "",
    doors_time: req.body.doors_time || "",
    location_name: req.body.location_name || "",
    location_address: req.body.location_address || "",
    price: req.body.price || "Free",
    max_spots: req.body.max_spots || 30,
    is_active: req.body.is_active !== undefined ? req.body.is_active : 1,
  };
  try {
    const result = stmts.createEvent.run(data);
    res.json({ success: true, id: result.lastInsertRowid });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Update event
app.put("/api/admin/events/:id", requireAdmin, (req, res) => {
  const existing = stmts.eventById.get(req.params.id);
  if (!existing) return res.status(404).json({ error: "Event not found" });
  const data = { id: parseInt(req.params.id), ...existing, ...req.body };
  try {
    stmts.updateEvent.run(data);
    res.json({ success: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Delete event
app.delete("/api/admin/events/:id", requireAdmin, (req, res) => {
  stmts.deleteGuestsByEvent.run(req.params.id);
  stmts.deleteEvent.run(req.params.id);
  res.json({ success: true });
});

// Guests for an event (confirmed + waitlisted)
app.get("/api/admin/events/:id/guests", requireAdmin, (req, res) => {
  const guests = stmts.guestsByEvent.all(req.params.id);
  res.json(guests);
});

// Add guest to event
app.post("/api/admin/events/:id/guests", requireAdmin, (req, res) => {
  const { name, email, status } = req.body;
  if (!name || !email) return res.status(400).json({ error: "Name and email are required." });
  const existing = stmts.findByEmail.get(req.params.id, email);
  if (existing) return res.status(409).json({ error: "Already registered." });
  const token = uuidv4();
  const guestStatus = status || "confirmed";
  try {
    stmts.insertRsvp.run(req.params.id, name, email, token, guestStatus);
    res.json({ success: true });
  } catch { res.status(409).json({ error: "Already registered." }); }
});

// Remove guest
app.delete("/api/admin/guests/:token", requireAdmin, (req, res) => {
  const rsvp = stmts.findByToken.get(req.params.token);
  if (rsvp && rsvp.status === "confirmed") {
    stmts.deleteByToken.run(req.params.token);
    promoteNextWaitlisted(rsvp.event_id);
  } else {
    stmts.deleteByToken.run(req.params.token);
  }
  res.json({ success: true });
});

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
  console.log(`Admin: http://localhost:${PORT}/admin.html`);
});
