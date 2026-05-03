const http = require("http");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const { Pool } = require("pg");

const PORT = Number(process.env.PORT || 3000);
const HOST = process.env.HOST || "0.0.0.0";
const DATABASE_URL = process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/nist_resource";

const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const SLOTS = ["09:00 - 10:00", "10:00 - 11:00", "11:15 - 12:15", "12:15 - 01:15", "02:00 - 03:00", "03:00 - 04:00"];

function createDb() {
  const pool = new Pool({
    connectionString: DATABASE_URL,
    ssl: process.env.PGSSL === "false" ? false : { rejectUnauthorized: false },
  });

  const db = (client) => ({
    exec: async (sql) => await client.query(sql),
    get: async (sql, params = []) => (await client.query(sql, params)).rows[0],
    all: async (sql, params = []) => (await client.query(sql, params)).rows,
    run: async (sql, params = []) => (await client.query(sql, params)).rowCount,
  });

  return {
    ...db(pool),
    transaction: async (work) => {
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        const result = await work(db(client));
        await client.query("COMMIT");
        return result;
      } catch (e) {
        await client.query("ROLLBACK");
        throw e;
      } finally {
        client.release();
      }
    },
    close: async () => await pool.end(),
  };
}

const db = createDb();

function uid() { return crypto.randomUUID(); }
function hashPwd(pwd, salt) { return crypto.scryptSync(pwd, salt, 64).toString("hex"); }

async function initDb() {
  await db.exec(`CREATE TABLE IF NOT EXISTS users (id VARCHAR(36) PRIMARY KEY, identifier VARCHAR(100) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, salt VARCHAR(64) DEFAULT '', password_hash VARCHAR(128) DEFAULT '', is_temp INTEGER DEFAULT 1, created_at VARCHAR(50) NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS sessions (token VARCHAR(64) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, expires_at VARCHAR(50) NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS rooms (id VARCHAR(36) PRIMARY KEY, name VARCHAR(50) NOT NULL, building VARCHAR(50) NOT NULL, capacity INTEGER NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS bookings (id VARCHAR(36) PRIMARY KEY, user_id VARCHAR(36) NOT NULL, room_id VARCHAR(36) NOT NULL, day VARCHAR(20) NOT NULL, slot VARCHAR(30) NOT NULL, purpose VARCHAR(255) NOT NULL, status VARCHAR(20) DEFAULT 'PENDING', created_at VARCHAR(50) NOT NULL)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS faculty (id VARCHAR(36) PRIMARY KEY, name VARCHAR(255) NOT NULL, department VARCHAR(50) NOT NULL, user_id VARCHAR(36), is_scheduling_only INTEGER DEFAULT 0)`);
  await db.exec(`CREATE TABLE IF NOT EXISTS schedule (id VARCHAR(36) PRIMARY KEY, day VARCHAR(20) NOT NULL, slot VARCHAR(30) NOT NULL, room_id VARCHAR(36) NOT NULL, faculty_id VARCHAR(36) NOT NULL, subject VARCHAR(100) NOT NULL, section VARCHAR(20) NOT NULL)`);
}

async function seedData() {
  const defaults = [
    { id: "admin001", identifier: "nist@admin", name: "NIST Admin", role: "ADMIN", pwd: "nist@123", temp: 0 },
    { id: "student001", identifier: "202456714", name: "Soumya Ranjan Sahu", role: "STUDENT", pwd: "student@123", temp: 1 }
  ];
  for (const u of defaults) {
    const exists = await db.get("SELECT id FROM users WHERE identifier=?", [u.identifier]);
    if (!exists) {
      const salt = crypto.randomBytes(16).toString("hex");
      await db.run("INSERT INTO users (id, identifier, name, role, salt, password_hash, is_temp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [u.id, u.identifier, u.name, u.role, salt, hashPwd(u.pwd, salt), u.temp, new Date().toISOString()]);
    }
  }
  const room = await db.get("SELECT id FROM rooms LIMIT 1");
  if (!room) {
    const rooms = [["LHC-101", "LHC", 60], ["LHC-102", "LHC", 60], ["ATR-101", "ATR", 80], ["TIFAC-Lab1", "TIFAC", 40]];
    for (const [n, b, c] of rooms) await db.run("INSERT INTO rooms VALUES (?, ?, ?, ?)", [uid(), n, b, c]);
  }
}

async function authenticate(req) {
  const auth = req.headers.authorization || "";
  if (!auth.startsWith("Bearer ")) return null;
  const sess = await db.get("SELECT s.token, u.id, u.identifier, u.name, u.role, u.is_temp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?", [auth.slice(7), new Date().toISOString()]);
  if (sess && sess.role) { sess.role = String(sess.role).toUpperCase(); }
  return sess;
}

async function requireAuth(req, res) {
  const sess = await authenticate(req);
  if (!sess) { json(res, 401, { error: "Unauthorized." }); return null; }
  return sess;
}

async function requireAdmin(req, res) {
  const sess = await requireAuth(req, res);
  if (!sess) return null;
  if (sess.role !== "ADMIN") { json(res, 403, { error: "Admin only." }); return null; }
  return sess;
}

function json(res, code, body) { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }

async function readBody(req) {
  return new Promise((resolve, reject) => { let data = ""; req.on("data", c => { data += c; if (data.length > 1e6) reject(new Error("Too large")); }); req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); });
}

const MIME = { ".html": "text/html", ".css": "text/css", ".js": "application/javascript", ".png": "image/png" };
function serveFile(res, fp) { fs.readFile(fp, (err, buf) => { if (err) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" }); res.end(buf); }); }

async function getAllData() {
  return {
    rooms: await db.all("SELECT * FROM rooms ORDER BY building, name"),
    faculty: await db.all("SELECT * FROM faculty ORDER BY name"),
    schedule: await db.all("SELECT s.id, s.day, s.slot, s.room_id AS roomId, s.faculty_id AS facultyId, s.subject, s.section, r.name AS roomName, r.building, f.name AS facultyName, f.department FROM schedule s JOIN rooms r ON r.id = s.room_id JOIN faculty f ON f.id = s.faculty_id ORDER BY s.day, s.slot"),
    days: DAYS,
    slots: SLOTS
  };
}

async function handleApi(req, res, path_) {
  const m = req.method;
  
  if (m === "POST" && path_ === "/api/login") {
    const { identifier, password } = await readBody(req);
    const user = await db.get("SELECT * FROM users WHERE identifier = ?", [identifier.trim()]);
    if (!user || !user.salt) return json(res, 401, { error: "ID not authorized." });
    if (hashPwd(password, user.salt) !== user.password_hash) return json(res, 401, { error: "Wrong password." });
    const token = crypto.randomBytes(32).toString("hex");
    await db.run("INSERT INTO sessions VALUES (?, ?, ?)", [token, user.id, new Date(Date.now() + 12 * 3600 * 1000).toISOString()]);
    const role = user.role ? String(user.role).toUpperCase() : user.role;
    return json(res, 200, { token, user: { identifier: user.identifier, name: user.name, role: role, is_temp: Boolean(user.is_temp) } });
  }

  if (m === "POST" && path_ === "/api/logout") {
    const s = await authenticate(req);
    if (s) await db.run("DELETE FROM sessions WHERE token = ?", [s.token]);
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && path_ === "/api/me") {
    const s = await requireAuth(req, res);
    if (!s) return;
    return json(res, 200, { identifier: s.identifier, name: s.name, role: s.role, is_temp: Boolean(s.is_temp) });
  }

  if (m === "POST" && path_ === "/api/change-password") {
    const s = await requireAuth(req, res);
    if (!s) return;
    const { new_password } = await readBody(req);
    if (new_password.length < 6) return json(res, 400, { error: "Min 6 chars" });
    const salt = crypto.randomBytes(16).toString("hex");
    await db.run("UPDATE users SET salt = ?, password_hash = ?, is_temp = 0 WHERE id = ?", [salt, hashPwd(new_password, salt), s.id]);
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && path_ === "/api/data") {
    const s = await requireAuth(req, res);
    if (!s) return;
    return json(res, 200, await getAllData());
  }

  if (m === "POST" && path_ === "/api/bookings") {
    const s = await requireAuth(req, res);
    if (!s) return;
    const { roomId, day, slot, purpose } = await readBody(req);
    if (!roomId || !day || !slot || !purpose) return json(res, 400, { error: "All fields required" });
    if (!SLOTS.includes(slot)) return json(res, 400, { error: "Invalid slot" });
    const booked = await db.get("SELECT id FROM bookings WHERE room_id = ? AND day = ? AND slot = ? AND status = ?", [roomId, day, slot, "APPROVED"]);
    if (booked) return json(res, 400, { error: "Room already booked" });
    const reserved = await db.get("SELECT id FROM schedule WHERE room_id = ? AND day = ? AND slot = ?", [roomId, day, slot]);
    if (reserved) return json(res, 400, { error: "Room reserved" });
    await db.run("INSERT INTO bookings (id, user_id, room_id, day, slot, purpose, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [uid(), s.id, roomId, day, slot, purpose.trim().toUpperCase(), "PENDING", new Date().toISOString()]);
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && path_ === "/api/bookings") {
    const s = await requireAuth(req, res);
    if (!s) return;
    return json(res, 200, { bookings: await db.all("SELECT b.id, b.day, b.slot, b.purpose, b.status, b.created_at, r.name AS roomName, r.building FROM bookings b JOIN rooms r ON r.id = b.room_id WHERE b.user_id = ? ORDER BY b.day, b.slot", [s.id]) });
  }

  if (m === "DELETE" && path_.startsWith("/api/bookings/")) {
    const s = await requireAuth(req, res);
    if (!s) return;
    await db.run("DELETE FROM bookings WHERE id = ?", [path_.split("/").pop()]);
    return json(res, 200, { ok: true });
  }

  if (m === "GET" && path_ === "/api/admin/users") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    return json(res, 200, { users: await db.all("SELECT id, identifier, name, role, is_temp, created_at FROM users ORDER BY role, name") });
  }

  if (m === "DELETE" && path_.startsWith("/api/admin/users/")) {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const uid2 = path_.split("/").pop();
    if (uid2 === s.id) return json(res, 400, { error: "Cannot delete yourself" });
    await db.run("DELETE FROM users WHERE id = ?", [uid2]);
    return json(res, 200, await getAllData());
  }

  if (m === "POST" && path_ === "/api/admin/reset-password") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const { user_id } = await readBody(req);
    const pwd = Math.random().toString(36).substring(2, 10);
    const salt = crypto.randomBytes(16).toString("hex");
    await db.run("UPDATE users SET salt = ?, password_hash = ?, is_temp = 1 WHERE id = ?", [salt, hashPwd(pwd, salt), user_id]);
    return json(res, 200, { ok: true, tempPassword: pwd });
  }

  if (m === "POST" && path_ === "/api/admin/rooms") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const { name, building, capacity } = await readBody(req);
    if (!name || !building || !capacity) return json(res, 400, { error: "All fields required" });
    const n = name.trim().toUpperCase(), b = building.trim().toUpperCase();
    if (await db.get("SELECT id FROM rooms WHERE name = ? AND building = ?", [n, b])) return json(res, 400, { error: "Room exists" });
    await db.run("INSERT INTO rooms VALUES (?, ?, ?, ?)", [uid(), n, b, Number(capacity)]);
    return json(res, 200, await getAllData());
  }

  if (m === "DELETE" && path_.startsWith("/api/admin/rooms/")) {
    const s = await requireAdmin(req, res);
    if (!s) return;
    await db.run("DELETE FROM rooms WHERE id = ?", [path_.split("/").pop()]);
    return json(res, 200, await getAllData());
  }

  if (m === "POST" && path_ === "/api/admin/faculty") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const { identifier, name, password } = await readBody(req);
    if (!identifier || !name || !password) return json(res, 400, { error: "All fields required" });
    const id = identifier.trim().toUpperCase(), nm = name.trim().toUpperCase();
    if (await db.get("SELECT id FROM users WHERE identifier = ?", [id])) return json(res, 400, { error: "ID exists" });
    const salt = crypto.randomBytes(16).toString("hex");
    const fid = uid(), uid2 = uid();
    await db.run("INSERT INTO faculty (id, name, department, user_id, is_scheduling_only) VALUES (?, ?, ?, ?, 0)", [fid, nm, "FACULTY", uid2]);
    await db.run("INSERT INTO users (id, identifier, name, role, salt, password_hash, is_temp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [uid2, id, nm, "FACULTY", salt, hashPwd(password, salt), 1, new Date().toISOString()]);
    return json(res, 200, await getAllData());
  }

  if (m === "DELETE" && path_.startsWith("/api/admin/faculty/")) {
    const s = await requireAdmin(req, res);
    if (!s) return;
    await db.run("DELETE FROM faculty WHERE id = ?", [path_.split("/").pop()]);
    return json(res, 200, await getAllData());
  }

  if (m === "POST" && path_ === "/api/admin/students") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const { identifier, name, password } = await readBody(req);
    if (!identifier || !name || !password) return json(res, 400, { error: "All fields required" });
    const id = identifier.trim().toUpperCase(), nm = name.trim().toUpperCase();
    if (await db.get("SELECT id FROM users WHERE identifier = ?", [id])) return json(res, 400, { error: "ID exists" });
    const salt = crypto.randomBytes(16).toString("hex");
    await db.run("INSERT INTO users (id, identifier, name, role, salt, password_hash, is_temp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [uid(), id, nm, "STUDENT", salt, hashPwd(password, salt), 1, new Date().toISOString()]);
    return json(res, 200, { ok: true });
  }

  if (m === "POST" && path_ === "/api/admin/schedule") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const { day, slot, roomId, facultyId, subject, section } = await readBody(req);
    if (!DAYS.includes(day) || !SLOTS.includes(slot) || !roomId || !facultyId || !subject || !section) return json(res, 400, { error: "All fields required" });
    await db.run("INSERT INTO schedule VALUES (?, ?, ?, ?, ?, ?, ?)", [uid(), day, slot, roomId, facultyId, subject.trim().toUpperCase(), section.trim().toUpperCase()]);
    return json(res, 200, await getAllData());
  }

  if (m === "DELETE" && path_.startsWith("/api/admin/schedule/")) {
    const s = await requireAdmin(req, res);
    if (!s) return;
    await db.run("DELETE FROM schedule WHERE id = ?", [path_.split("/").pop()]);
    return json(res, 200, await getAllData());
  }

  if (m === "GET" && path_ === "/api/admin/bookings") {
    const s = await requireAdmin(req, res);
    if (!s) return;
    return json(res, 200, { bookings: await db.all("SELECT b.id, b.day, b.slot, b.purpose, b.status, b.created_at, r.name AS roomName, r.building, u.name AS userName, u.identifier FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC") });
  }

  if (m === "POST" && path_.startsWith("/api/admin/bookings/")) {
    const s = await requireAdmin(req, res);
    if (!s) return;
    const bid = path_.split("/").pop();
    const { status } = await readBody(req);
    if (!["APPROVED", "REJECTED"].includes(status)) return json(res, 400, { error: "Invalid" });
    await db.run("UPDATE bookings SET status = ? WHERE id = ?", [status, bid]);
    return json(res, 200, { ok: true });
  }

  return json(res, 404, { error: "Not found." });
}

const STATIC = { "/": "index.html", "/index.html": "index.html", "/app.js": "app.js", "/styles.css": "styles.css", "/nist.png": "nist.png" };
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try {
    const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`;
    const url = new URL(req.url, baseUrl);
    if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname);
    const file = STATIC[url.pathname];
    if (file) return serveFile(res, path.join(__dirname, file));
    json(res, 404, { error: "Not found." });
  } catch (e) { json(res, 500, { error: e.message }); }
});

server.listen(PORT, HOST, async () => {
  await initDb();
  console.log("Using PostgreSQL");
  await seedData();
  console.log(`NIST RM → http://${HOST}:${PORT}`);
});

module.exports = server;