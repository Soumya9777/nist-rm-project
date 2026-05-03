const http = require("http");
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");

let pool = null;
let useMySQL = !!(process.env.DB_HOST && process.env.DB_USER && process.env.DB_PASSWORD && process.env.DB_NAME);

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = path.join(__dirname, "data");

const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const SLOTS = ["09:00 - 10:00","10:00 - 11:00","11:15 - 12:15","12:15 - 01:15","02:00 - 03:00","03:00 - 04:00"];

let db, raw;
function initSQLite() {
  if (useMySQL) return false;
  const { DatabaseSync } = require("node:sqlite");
  fs.mkdirSync(DATA_DIR, { recursive: true });
  raw = new DatabaseSync(path.join(DATA_DIR, "nist.db"));
  raw.exec("PRAGMA foreign_keys = ON");
  db = { exec: (sql) => raw.exec(sql), get: (sql, p=[]) => raw.prepare(sql).get(...p), all: (sql, p=[]) => raw.prepare(sql).all(...p), run: (sql, p=[]) => { const i = raw.prepare(sql).run(...p); return { changes: i.changes }; } };
  db.exec(`CREATE TABLE IF NOT EXISTS users (id TEXT PRIMARY KEY, identifier TEXT UNIQUE NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL, salt TEXT DEFAULT '', password_hash TEXT DEFAULT '', is_temp INTEGER DEFAULT 1, created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, name TEXT NOT NULL, building TEXT NOT NULL, capacity INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS bookings (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, room_id TEXT NOT NULL, day TEXT NOT NULL, slot TEXT NOT NULL, purpose TEXT NOT NULL, status TEXT DEFAULT 'PENDING', created_at TEXT NOT NULL); CREATE TABLE IF NOT EXISTS faculty (id TEXT PRIMARY KEY, name TEXT NOT NULL, department TEXT NOT NULL, user_id TEXT, is_scheduling_only INTEGER DEFAULT 0); CREATE TABLE IF NOT EXISTS schedule (id TEXT PRIMARY KEY, day TEXT NOT NULL, slot TEXT NOT NULL, room_id TEXT NOT NULL, faculty_id TEXT NOT NULL, subject TEXT NOT NULL, section TEXT NOT NULL); CREATE TABLE IF NOT EXISTS activity (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, action TEXT NOT NULL, details TEXT, created_at TEXT NOT NULL);`);
  return true;
}

async function initMySQL() {
  if (!useMySQL) return;
  const mysql = require("mysql2/promise");
  pool = await mysql.createPool({ host: process.env.DB_HOST, user: process.env.DB_USER, password: process.env.DB_PASSWORD, database: process.env.DB_NAME, waitForConnections: true, connectionLimit: 10 });
  await pool.execute(`CREATE TABLE IF NOT EXISTS users (id VARCHAR(36) PRIMARY KEY, identifier VARCHAR(100) UNIQUE NOT NULL, name VARCHAR(255) NOT NULL, role VARCHAR(50) NOT NULL, salt VARCHAR(64) DEFAULT '', password_hash VARCHAR(128) DEFAULT '', is_temp TINYINT(1) DEFAULT 1, created_at VARCHAR(50) NOT NULL)`);
}

function uid() { return crypto.randomUUID(); }
function hashPwd(pwd, salt) { return crypto.scryptSync(pwd, salt, 64).toString("hex"); }

async function dbGet(sql, params = []) { if (useMySQL) { const [rows] = await pool.execute(sql, params); return rows[0] || null; } return db.get(sql, params); }
async function dbAll(sql, params = []) { if (useMySQL) { const [rows] = await pool.execute(sql, params); return rows; } return db.all(sql, params); }
async function dbRun(sql, params = []) { if (useMySQL) { const [result] = await pool.execute(sql, params); return { changes: result.affectedRows }; } return db.run(sql, params); }

async function seedData() {
  const defaults = [{ id: "admin001", identifier: "nist@admin", name: "NIST Admin", role: "ADMIN", pwd: "nist@123", temp: 0 }, { id: "student001", identifier: "202456714", name: "Soumya Ranjan Sahu", role: "Student", pwd: "student@123", temp: 1 }];
  for (const u of defaults) {
    const exists = await dbGet("SELECT id FROM users WHERE identifier=?", [u.identifier]);
    if (!exists) { const salt = crypto.randomBytes(16).toString("hex"); await dbRun("INSERT INTO users (id, identifier, name, role, salt, password_hash, is_temp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [u.id, u.identifier, u.name, u.role, salt, hashPwd(u.pwd, salt), u.temp, new Date().toISOString()]); }
  }
  const room = await dbGet("SELECT id FROM rooms LIMIT 1");
  if (!room) { const rooms = [["LHC-101","LHC",60],["LHC-102","LHC",60],["ATR-101","ATR",80],["TIFAC-Lab1","TIFAC",40]]; for (const [n,b,c] of rooms) await dbRun("INSERT INTO rooms VALUES (?,?,?,?)", [uid(),n,b,c]); }
}

async function authenticate(req) { const auth = req.headers.authorization || ""; if (!auth.startsWith("Bearer ")) return null; const sess = await dbGet(`SELECT s.token, u.id, u.identifier, u.name, u.role, u.is_temp FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires_at > ?`, [auth.slice(7), new Date().toISOString()]); if (sess) { sess.role = (sess.role || "").toUpperCase(); } return sess; }
async function requireAuth(req, res) { const sess = await authenticate(req); if (!sess) { json(res, 401, { error: "Unauthorized." }); return null; } return sess; }
async function requireAdmin(req, res) { const sess = await requireAuth(req, res); if (!sess) return null; if (sess.role !== "ADMIN") { json(res, 403, { error: "Admin only." }); return null; } return sess; }
function json(res, code, body) { res.writeHead(code, { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }); res.end(JSON.stringify(body)); }

async function readBody(req) {
  return new Promise((resolve, reject) => { let data = ""; req.on("data", c => { data += c; if (data.length > 1e6) reject(new Error("Too large")); }); req.on("end", () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error("Invalid JSON")); } }); req.on("error", reject); });
}

const MIME = { ".html":"text/html", ".css":"text/css", ".js":"application/javascript", ".png":"image/png" };
function serveFile(res, fp) { fs.readFile(fp, (err, buf) => { if (err) return json(res, 404, { error: "Not found" }); res.writeHead(200, { "Content-Type": MIME[path.extname(fp)] || "application/octet-stream" }); res.end(buf); }); }

async function getAllData() { return { rooms: await dbAll("SELECT * FROM rooms ORDER BY building, name"), faculty: await dbAll("SELECT * FROM faculty ORDER BY name"), schedule: await dbAll("SELECT s.id, s.day, s.slot, s.room_id AS roomId, s.faculty_id AS facultyId, s.subject, s.section, r.name AS roomName, r.building, f.name AS facultyName, f.department FROM schedule s JOIN rooms r ON r.id=s.room_id JOIN faculty f ON f.id=s.faculty_id ORDER BY s.day, s.slot"), days: DAYS, slots: SLOTS }; }

async function handleApi(req, res, path_) {
  const m = req.method;
  if (m==="POST" && path_==="/api/login") { const { identifier, password } = await readBody(req); const user = await dbGet("SELECT * FROM users WHERE identifier=?", [identifier.trim()]); if (!user || !user.salt) return json(res, 401, { error: "ID not authorized." }); if (hashPwd(password, user.salt) !== user.password_hash) return json(res, 401, { error: "Wrong password." }); const token = crypto.randomBytes(32).toString("hex"); await dbRun("INSERT INTO sessions VALUES (?,?,?)", [token, user.id, new Date(Date.now()+12*3600*1000).toISOString()]); const role = user.role?.toUpperCase() || user.role; return json(res, 200, { token, user: { identifier: user.identifier, name: user.name, role: role, is_temp: Boolean(user.is_temp) } }); }
  if (m==="POST" && path_==="/api/logout") { const s = await authenticate(req); if (s) await dbRun("DELETE FROM sessions WHERE token=?", [s.token]); return json(res, 200, { ok: true }); }
  if (m==="GET" && path_==="/api/me") { const s = requireAuth(req, res); if (!s) return; return json(res, 200, { identifier: s.identifier, name: s.name, role: s.role, is_temp: Boolean(s.is_temp) }); }
  if (m==="POST" && path_==="/api/change-password") { const s = requireAuth(req, res); if (!s) return; const { new_password } = await readBody(req); if (new_password.length < 6) return json(res, 400, { error: "Min 6 chars" }); const salt = crypto.randomBytes(16).toString("hex"); await dbRun("UPDATE users SET salt=?, password_hash=?, is_temp=0 WHERE id=?", [salt, hashPwd(new_password, salt), s.id]); return json(res, 200, { ok: true }); }
  if (m==="GET" && path_==="/api/data") { const s = requireAuth(req, res); if (!s) return; return json(res, 200, await getAllData()); }
  if (m==="POST" && path_==="/api/bookings") { const s = requireAuth(req, res); if (!s) return; const { roomId, day, slot, purpose } = await readBody(req); if (!roomId || !day || !slot || !purpose) return json(res, 400, { error: "All fields required" }); if (!SLOTS.includes(slot)) return json(res, 400, { error: "Invalid slot" }); const booked = await dbGet("SELECT id FROM bookings WHERE room_id = ? AND day = ? AND slot = ? AND status = ?", [roomId, day, slot, "APPROVED"]); if (booked) return json(res, 400, { error: "Room already booked" }); const reserved = await dbGet("SELECT id FROM schedule WHERE room_id = ? AND day = ? AND slot = ?", [roomId, day, slot]); if (reserved) return json(res, 400, { error: "Room reserved" }); const insertBookingSql = "INSERT INTO bookings (id, user_id, room_id, day, slot, purpose, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)";
  await dbRun(insertBookingSql, [uid(), s.id, roomId, day, slot, purpose.trim().toUpperCase(), "PENDING", new Date().toISOString()]); return json(res, 200, { ok: true }); }
  if (m==="GET" && path_==="/api/bookings") { const s = requireAuth(req, res); if (!s) return; const userId = s.id; const bookingsSql = "SELECT id, day, slot, purpose, status, created_at, room_name, building FROM bookings WHERE user_id = ? ORDER BY day, slot"; const bookings = await dbAll(bookingsSql, [userId]); const rooms = await dbAll("SELECT id, name, building FROM rooms"); const bm = {}; for (const r of rooms) bm[r.id] = r; const result = bookings.map(b => ({ ...b, roomName: bm[b.room_id]?.name || "Unknown", building: bm[b.room_id]?.building || "" })); return json(res, 200, { bookings: result }); }
  if (m==="DELETE" && path_.startsWith("/api/bookings/")) { const s = requireAuth(req, res); if (!s) return; const delId = path_.split("/").pop(); await dbRun("DELETE FROM bookings WHERE id = ?", [delId]); return json(res, 200, { ok: true }); }
  if (m==="GET" && path_==="/api/admin/users") { const s = requireAdmin(req, res); if (!s) return; return json(res, 200, { users: await dbAll("SELECT id,identifier,name,role,is_temp,created_at FROM users ORDER BY role,name") }); }
  if (m==="DELETE" && path_.startsWith("/api/admin/users/")) { const s = requireAdmin(req, res); if (!s) return; const uid = path_.split("/").pop(); if (uid === s.id) return json(res, 400, { error: "Cannot delete yourself" }); await dbRun("DELETE FROM activity WHERE user_id=?", [uid]); await dbRun("DELETE FROM faculty WHERE user_id=?", [uid]); await dbRun("DELETE FROM users WHERE id=?", [uid]); return json(res, 200, await getAllData()); }
  if (m==="POST" && path_==="/api/admin/reset-password") { const s = requireAdmin(req, res); if (!s) return; const { user_id } = await readBody(req); const pwd = Math.random().toString(36).substring(2, 10); const salt = crypto.randomBytes(16).toString("hex"); await dbRun("UPDATE users SET salt=?, password_hash=?, is_temp=1 WHERE id=?", [salt, hashPwd(pwd, salt), user_id]); return json(res, 200, { ok: true, tempPassword: pwd }); }
  if (m==="POST" && path_==="/api/admin/rooms") { const s = requireAdmin(req, res); if (!s) return; const { name, building, capacity } = await readBody(req); if (!name || !building || !capacity) return json(res, 400, { error: "All fields required" }); const n = name.trim().toUpperCase(), b = building.trim().toUpperCase(); if (await dbGet("SELECT id FROM rooms WHERE name=? AND building=?", [n, b])) return json(res, 400, { error: "Room exists" }); await dbRun("INSERT INTO rooms VALUES (?,?,?,?)", [uid(), n, b, Number(capacity)]); return json(res, 200, await getAllData()); }
  if (m==="DELETE" && path_.startsWith("/api/admin/rooms/")) { const s = requireAdmin(req, res); if (!s) return; await dbRun("DELETE FROM rooms WHERE id=?", [path_.split("/").pop()]); return json(res, 200, await getAllData()); }
  if (m==="POST" && path_==="/api/admin/faculty") { const s = requireAdmin(req, res); if (!s) return; const { identifier, name, password } = await readBody(req); if (!identifier || !name || !password) return json(res, 400, { error: "All fields required" }); const id = identifier.trim().toUpperCase(), nm = name.trim().toUpperCase(); if (await dbGet("SELECT id FROM users WHERE identifier=?", [id])) return json(res, 400, { error: "ID exists" }); const salt = crypto.randomBytes(16).toString("hex"); const fid = uid(), uid2 = uid(); await dbRun("INSERT INTO faculty (id, name, department, user_id, is_scheduling_only) VALUES (?, ?, ?, ?, 0)", [fid, nm, "FACULTY", uid2]); await dbRun("INSERT INTO users (id, identifier, name, role, salt, password_hash, is_temp, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)", [uid2, id, nm, "Faculty", salt, hashPwd(password, salt), 1, new Date().toISOString()]); return json(res, 200, await getAllData()); }
  if (m==="DELETE" && path_.startsWith("/api/admin/faculty/")) { const s = requireAdmin(req, res); if (!s) return; await dbRun("DELETE FROM faculty WHERE id=?", [path_.split("/").pop()]); return json(res, 200, await getAllData()); }
  if (m==="POST" && path_==="/api/admin/students") { const s = requireAdmin(req, res); if (!s) return; const { identifier, name, password } = await readBody(req); if (!identifier || !name || !password) return json(res, 400, { error: "All fields required" }); const id = identifier.trim().toUpperCase(), nm = name.trim().toUpperCase(); if (await dbGet("SELECT id FROM users WHERE identifier=?", [id])) return json(res, 400, { error: "ID exists" }); const salt = crypto.randomBytes(16).toString("hex"); await dbRun("INSERT INTO users (id,identifier,name,role,salt,password_hash,is_temp,created_at) VALUES (?,?,?,?,?,?,?,?)", [uid(), id, nm, "Student", salt, hashPwd(password, salt), 1, new Date().toISOString()]); return json(res, 200, { ok: true }); }
  if (m==="POST" && path_==="/api/admin/schedule") { const s = requireAdmin(req, res); if (!s) return; const { day, slot, roomId, facultyId, subject, section } = await readBody(req); if (!DAYS.includes(day) || !SLOTS.includes(slot) || !roomId || !facultyId || !subject || !section) return json(res, 400, { error: "All fields required" }); await dbRun("INSERT INTO schedule VALUES (?,?,?,?,?,?,?)", [uid(), day, slot, roomId, facultyId, subject.trim().toUpperCase(), section.trim().toUpperCase()]); return json(res, 200, await getAllData()); }
  if (m==="DELETE" && path_.startsWith("/api/admin/schedule/")) { const s = requireAdmin(req, res); if (!s) return; await dbRun("DELETE FROM schedule WHERE id=?", [path_.split("/").pop()]); return json(res, 200, await getAllData()); }
  if (m==="GET" && path_==="/api/admin/bookings") { const s = requireAdmin(req, res); if (!s) return; return json(res, 200, { bookings: await dbAll("SELECT b.id, b.day, b.slot, b.purpose, b.status, b.created_at, r.name AS roomName, r.building, u.name AS userName, u.identifier FROM bookings b JOIN rooms r ON r.id = b.room_id JOIN users u ON u.id = b.user_id ORDER BY b.created_at DESC") }); }
  if (m==="POST" && path_.startsWith("/api/admin/bookings/")) { const s = requireAdmin(req, res); if (!s) return; const bid = path_.split("/").pop(); const { status } = await readBody(req); if (!["APPROVED", "REJECTED"].includes(status)) return json(res, 400, { error: "Invalid" }); await dbRun("UPDATE bookings SET status=? WHERE id=?", [status, bid]); return json(res, 200, { ok: true }); }
  return json(res, 404, { error: "Not found." });
}

const STATIC = { "/":"index.html", "/index.html":"index.html", "/app.js":"app.js", "/styles.css":"styles.css", "/nist.png":"nist.png" };
const server = http.createServer(async (req, res) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  try { const baseUrl = process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : `http://localhost:${PORT}`; const url = new URL(req.url, baseUrl); if (url.pathname.startsWith("/api/")) return await handleApi(req, res, url.pathname); const file = STATIC[url.pathname]; if (file) return serveFile(res, path.join(__dirname, file)); json(res, 404, { error: "Not found." }); } catch (e) { json(res, 500, { error: e.message }); }
});

server.listen(PORT, async () => { if (useMySQL) { await initMySQL(); console.log("Using MySQL"); } else { initSQLite(); console.log("Using SQLite"); } await seedData(); console.log(`NIST RM → http://localhost:${PORT}`); });
module.exports = server;