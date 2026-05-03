const myTabId = sessionStorage.getItem("my-tab-id");
const storedTabId = sessionStorage.getItem("auth-tab-id");
if (!myTabId) { sessionStorage.setItem("my-tab-id", String(Date.now()) + Math.random()); sessionStorage.removeItem("nist-rm-token"); }

const S = { token: (storedTabId === myTabId) ? sessionStorage.getItem("nist-rm-token") || "" : "", user: null, data: { rooms: [], faculty: [], schedule: [], days: [], slots: [] } };
const DAYS = ["Monday","Tuesday","Wednesday","Thursday","Friday","Saturday"];
const SLOTS = ["09:00 - 10:00","10:00 - 11:00","11:15 - 12:15","12:15 - 01:15","02:00 - 03:00","03:00 - 04:00"];

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;");

function autoCapitalize(e) { const start = e.target.selectionStart, end = e.target.selectionEnd; e.target.value = e.target.value.toUpperCase(); e.target.setSelectionRange(start, end); }
function setupAutoCapitalize() { ["mr-name","mr-bldg","mt-name","mt-dept","as-subject","as-section"].forEach(id => { const el = $(id); if (el) el.addEventListener("input", autoCapitalize); }); }

async function api(method, path, body) {
  const opts = { method, headers: { "Content-Type": "application/json", ...(S.token ? { Authorization: `Bearer ${S.token}` } : {}) } };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || "Request failed.");
  return data;
}

function timeToMins(val) { const [h, m] = (val||"").split(":").map(Number); if (isNaN(h) || isNaN(m)) return null; return h * 60 + m; }
function overlap(aS, aE, bS, bE) { return aS < bE && aE > bS; }
function slotToMins(slot) { const [a, b] = slot.split(" - "); const aM = timeToMins(a); let bM = timeToMins(b); if (bM <= aM) bM += 12 * 60; return { s: aM, e: bM }; }

function setMsg(id, msg, ok=false) { const el = $(id); if (!el) return; el.textContent = msg; el.className = "msg " + (ok ? "msg-ok" : "msg-err"); }
function clearMsg(id) { const el=$(id); if(el){el.textContent="";el.className="msg";} }

const VIEW_TITLES = { dashboard:"Dashboard", rooms:"Room Availability", teachers:"Teacher Availability", mybookings:"My Bookings", bookings:"Room Bookings", "add-schedule":"Add Time Table", manage:"Manage Resources", users:"Manage Users" };

function nav(id) {
  document.querySelectorAll(".view").forEach(v => v.classList.remove("active"));
  document.querySelectorAll(".nav-btn").forEach(b => b.classList.remove("active"));
  const view = $("v-" + id);
  if (view) view.classList.add("active");
  document.querySelectorAll(`[data-view="${id}"]`).forEach(b => b.classList.add("active"));
  $("topbar-title").textContent = VIEW_TITLES[id] || id;
  if (id === "users") loadUsers();
  if (id === "add-schedule") { renderScheduleTable(); populateAdminSelects(); }
  if (id === "manage") renderRoomsList();
  if (id === "bookings") loadAdminBookings();
  if (id === "rooms") { loadData(); startRealTime(); }
  if (id === "mybookings") loadMyBookings();
  history.replaceState(null, "", "#" + id);
}

window.addEventListener("hashchange", () => { const id = location.hash.slice(1) || "dashboard"; nav(id); });

function initNav() { const id = location.hash.slice(1) || "dashboard"; nav(id); }

function showApp() {
  $("login-screen").classList.add("hidden");
  $("app").classList.remove("hidden");
  $("user-name").textContent = S.user.name;
  $("user-role").textContent = S.user.identifier + " · " + S.user.role;
  setupAutoCapitalize();
  const isAdmin = S.user.role === "ADMIN";
  ["admin-label","nav-add-schedule","nav-manage","nav-users","nav-bookings"].forEach(id => { const el = $(id); if (el) { el.style.display = isAdmin ? "" : "none"; el.classList.toggle("hidden", !isAdmin); } });
}

function showLogin() { $("login-screen").classList.remove("hidden"); $("app").classList.add("hidden"); $("pw-modal").classList.add("hidden"); }

let statsInterval, clockInterval;
async function logout() {
  try { await api("POST", "/api/logout"); } catch {}
  S.token = ""; S.user = null;
  sessionStorage.removeItem("nist-rm-token");
  sessionStorage.removeItem("nist-rm-tab-id");
  clearInterval(statsInterval); clearInterval(clockInterval); clearInterval(S._roomInt);
  showLogin();
}

$("login-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const id_ = $("f-id").value.trim(), pwd = $("f-pwd").value;
  try {
    const d = await api("POST", "/api/login", { identifier: id_, password: pwd });
    S.token = d.token; S.user = d.user;
    sessionStorage.setItem("nist-rm-token", d.token);
    sessionStorage.setItem("auth-tab-id", sessionStorage.getItem("my-tab-id"));
    if (d.user.is_temp) { $("pw-modal").classList.remove("hidden"); $("login-screen").classList.add("hidden"); }
    else { showApp(); await loadData(); initNav(); statsInterval = setInterval(() => { if (document.querySelector(".view.active")?.id === "v-dashboard") updateStats(); }, 60000); clockInterval = setInterval(updateClock, 1000); updateClock(); }
    setMsg("login-msg", "", true);
  } catch (err) { setMsg("login-msg", err.message); }
});

$("pw-form").addEventListener("submit", async (e) => {
  e.preventDefault();
  const np = $("pw-new").value, cp = $("pw-confirm").value;
  if (np !== cp) { setMsg("pw-msg","Passwords do not match."); return; }
  try { await api("POST", "/api/change-password", { new_password: np }); S.user.is_temp = false; $("pw-modal").classList.add("hidden"); showApp(); await loadData(); initNav(); } catch (err) { setMsg("pw-msg", err.message); }
});

async function loadData() { try { S.data = await api("GET", "/api/data"); updateStats(); populateAdminSelects(); } catch (err) { console.error("loadData:", err); } }

function updateClock() {
  const now = new Date();
  const time = now.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const date = now.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" });
  const el = $("clock-date");
  if (el) el.innerHTML = `<span class="clock-time">${time}</span><span class="clock-date-text">${date}</span>`;
}

function updateStats() {
  $("s-rooms").textContent = S.data.rooms.length;
  $("s-faculty").textContent = S.data.faculty.length;
  const today = new Date().toLocaleDateString("en-US", { weekday: "long" });
  const todayClasses = S.data.schedule.filter(e => e.day === today).length;
  $("s-today").textContent = todayClasses;
  $("s-today-day").textContent = today + "'s classes";
  const now = new Date(), nowMins = now.getHours() * 60 + now.getMinutes();
  const busyRooms = new Set(S.data.schedule.filter(e => { if (e.day !== today) return false; const { s, e: end } = slotToMins(e.slot); return nowMins >= s && nowMins < end; }).map(e => e.roomId));
  $("s-free").textContent = S.data.rooms.length - busyRooms.size;
}

function searchRooms() {
  const day = $("r-day").value;
  const fromM = timeToMins($("r-from").value), toM = timeToMins($("r-to").value);
  if (!day) { $("room-results").innerHTML=`<p class="msg-err" style="margin-top:8px">Select a day.</p>`; return; }
  if (fromM===null||toM===null||toM<=fromM) { $("room-results").innerHTML=`<p class="msg-err" style="margin-top:8px">Invalid time.</p>`; return; }
  const occupied = new Set(S.data.schedule.filter(e => { if (e.day !== day) return false; const { s, e: end } = slotToMins(e.slot); return overlap(fromM, toM, s, end); }).map(e => e.roomId));
  const free = S.data.rooms.filter(r => !occupied.has(r.id));
  if (!free.length) { $("room-results").innerHTML = `<div class="empty-state"><div class="icon">🚫</div><p>No free rooms.</p></div>`; return; }
  $("room-results").innerHTML = `<p style="color:var(--muted);margin-bottom:16px">${free.length} rooms available</p><div class="results-grid">` + free.map(r => `<div class="result-card"><strong>${esc(r.name)}</strong><p>${esc(r.building)}</p><p>${r.capacity} seats</p><span class="badge badge-free">✓ Free</span><button class="btn btn-primary btn-sm" style="margin-top:8px" onclick="quickBook('${esc(r.id)}','${esc(r.name)}','${esc(day)}','${esc($("r-from").value)}','${esc($("r-to").value)}')">Book</button></div>`).join("") + `</div>`;
}

async function quickBook(roomId, roomName, day, from, to) {
  const purpose = prompt(`Book ${roomName} for ${day} ${from}-${to}\nEnter purpose:`);
  if (!purpose) return;
  const slot = `${from} - ${to}`;
  try { await api("POST", "/api/bookings", { roomId, day, slot, purpose }); alert("Booking submitted!"); searchRooms(); } catch (err) { alert(err.message); }
}

function searchTeachers() {
  const day = $("t-day").value, fromM = timeToMins($("t-from").value), toM = timeToMins($("t-to").value);
  if (!day) { $("teacher-results").innerHTML=`<p class="msg-err">Select a day.</p>`; return; }
  if (fromM===null||toM===null||toM<=fromM) { $("teacher-results").innerHTML=`<p class="msg-err">Invalid time.</p>`; return; }
  const busyFac = new Set(S.data.schedule.filter(e => { if (e.day !== day) return false; const { s, e: end } = slotToMins(e.slot); return overlap(fromM, toM, s, end); }).map(e => e.facultyId));
  const free = S.data.faculty.filter(f => !busyFac.has(f.id));
  if (!free.length) { $("teacher-results").innerHTML = `<div class="empty-state"><div class="icon">🚫</div><p>No free teachers.</p></div>`; return; }
  $("teacher-results").innerHTML = `<p style="color:var(--muted);margin-bottom:16px">${free.length} teachers available</p><div class="results-grid">` + free.map(f => `<div class="result-card"><strong>${esc(f.name)}</strong><p>${esc(f.department)}</p><span class="badge badge-free">✓ Free</span></div>`).join("") + `</div>`;
}

function populateAdminSelects() {
  const facSel = $("as-faculty"), roomSel = $("as-room");
  if (!facSel || !roomSel) return;
  facSel.innerHTML = `<option value="">Select Teacher</option>` + S.data.faculty.map(f=>`<option value="${esc(f.id)}">${esc(f.name)}</option>`).join("");
  roomSel.innerHTML = `<option value="">Select Room</option>` + S.data.rooms.map(r=>`<option value="${esc(r.id)}">${esc(r.name)} (${esc(r.building)})</option>`).join("");
}

async function addSchedule() {
  clearMsg("as-msg");
  const day = $("as-day").value, startTime = $("as-start-time").value, endTime = $("as-end-time").value, facultyId = $("as-faculty").value, roomId = $("as-room").value, subject = $("as-subject").value, section = $("as-section").value;
  if (!day || !startTime || !endTime || !facultyId || !roomId || !subject || !section) { setMsg("as-msg", "All fields required."); return; }
  const slot = `${startTime} - ${endTime}`;
  try { S.data = await api("POST", "/api/admin/schedule", { day, slot, roomId, facultyId, subject, section }); setMsg("as-msg", "Added.", true); renderScheduleTable(); $("as-day").value = $("as-subject").value = $("as-section").value = ""; } catch (err) { setMsg("as-msg", err.message); }
}

function renderScheduleTable() {
  const el = $("schedule-table");
  if (!el) return;
  if (!S.data.schedule.length) { el.innerHTML = `<p>No entries.</p>`; return; }
  el.innerHTML = `<table><thead><tr><th>Day</th><th>Slot</th><th>Teacher</th><th>Room</th><th>Subject</th><th>Section</th><th>Action</th></tr></thead><tbody>` + S.data.schedule.map(e => `<tr><td>${esc(e.day)}</td><td>${esc(e.slot)}</td><td>${esc(e.facultyName)}</td><td>${esc(e.roomName)}</td><td>${esc(e.subject)}</td><td>${esc(e.section)}</td><td><button class="btn btn-danger btn-sm" onclick="deleteSchedule('${esc(e.id)}')">Delete</button></td></tr>`).join("") + `</tbody></table>`;
}

async function deleteSchedule(id) {
  if (!confirm("Delete?")) return;
  try { S.data = await api("DELETE", `/api/admin/schedule/${id}`); renderScheduleTable(); } catch (err) { alert(err.message); }
}

async function addRoom() {
  clearMsg("mr-msg");
  try { S.data = await api("POST", "/api/admin/rooms", { name: $("mr-name").value, building: $("mr-bldg").value, capacity: $("mr-cap").value }); setMsg("mr-msg", "Room added.", true); $("mr-name").value = $("mr-bldg").value = $("mr-cap").value = ""; updateStats(); populateAdminSelects(); } catch (err) { setMsg("mr-msg", err.message); }
}

function renderRoomsList() {
  const el = $("rooms-list");
  if (!el) return;
  if (!S.data.rooms.length) { el.innerHTML = `<p>No rooms.</p>`; return; }
  el.innerHTML = S.data.rooms.map(r => `<div style="display:flex;justify-content:space-between;padding:8px;background:var(--surface);border:1px solid var(--border);border-radius:6px;margin-bottom:6px"><span>${esc(r.name)} - ${esc(r.building)} (${r.capacity})</span><button class="btn btn-danger btn-sm" onclick="deleteRoom('${esc(r.id)}','${esc(r.name)}')">Delete</button></div>`).join("");
}

async function deleteRoom(id, name) { if (!confirm(`Delete ${name}?`)) return; try { S.data = await api("DELETE", `/api/admin/rooms/${id}`); renderRoomsList(); updateStats(); } catch (err) { alert(err.message); } }

async function addTeacher() {
  clearMsg("mt-msg");
  try { S.data = await api("POST", "/api/admin/faculty", { identifier: $("mt-eid").value, name: $("mt-name").value, password: $("mt-pwd").value }); setMsg("mt-msg", "Teacher added.", true); $("mt-eid").value = $("mt-name").value = $("mt-pwd").value = ""; populateAdminSelects(); } catch (err) { setMsg("mt-msg", err.message); }
}

let allUsers = [];
async function loadUsers() { $("users-table").innerHTML = "Loading..."; try { const d = await api("GET", "/api/admin/users"); allUsers = d.users || []; renderUsersTable(allUsers); } catch (err) { $("users-table").innerHTML = `<p class="msg-err">${err.message}</p>`; } }
function renderUsersTable(users) { if (!users.length) { $("users-table").innerHTML = `<p>No users.</p>`; return; } $("users-table").innerHTML = `<table><thead><tr><th>Name</th><th>ID</th><th>Role</th><th>Password</th><th>Action</th></tr></thead><tbody>` + users.map(u => `<tr><td>${esc(u.name)}</td><td>${esc(u.identifier)}</td><td>${esc(u.role)}</td><td><span class="badge ${u.is_temp?'badge-busy':'badge-free'}">${u.is_temp?'Temp':'Secure'}</span></td><td>${u.role!=="ADMIN"?`<button class="btn btn-secondary btn-sm" onclick="resetPwd('${esc(u.id)}','${esc(u.name)}')">Reset</button>`:""} ${S.user.id!==u.id?`<button class="btn btn-danger btn-sm" onclick="deleteUser('${esc(u.id)}','${esc(u.name)}')">Delete</button>`:""}</td></tr>`).join("") + `</tbody></table>`; }
function filterUsers() { const q = $("user-search").value.toUpperCase(); renderUsersTable(q ? allUsers.filter(u => u.name.toUpperCase().includes(q) || u.identifier.toUpperCase().includes(q)) : allUsers); }
async function resetPwd(id, name) { if (!confirm(`Reset password for ${name}?`)) return; try { const d = await api("POST", "/api/admin/reset-password", { user_id: id }); setMsg("users-msg", `Password: ${d.tempPassword}`, true); loadUsers(); } catch (err) { setMsg("users-msg", err.message); } }
async function deleteUser(id, name) { if (!confirm(`Delete ${name}?`)) return; try { await api("DELETE", `/api/admin/users/${id}`); setMsg("users-msg", "Deleted.", true); loadUsers(); } catch (err) { setMsg("users-msg", err.message); } }

async function loadMyBookings() { const el = $("my-bookings-table"); if (!el) return; try { const d = await api("GET", "/api/bookings"); if (!d.bookings.length) { el.innerHTML = `<p>No bookings.</p>`; return; } el.innerHTML = `<table><thead><tr><th>Room</th><th>Day</th><th>Slot</th><th>Purpose</th><th>Status</th></tr></thead><tbody>` + d.bookings.map(b => `<tr><td>${esc(b.roomName)}</td><td>${esc(b.day)}</td><td>${esc(b.slot)}</td><td>${esc(b.purpose)}</td><td><span class="badge ${b.status==='APPROVED'?'badge-free':b.status==='REJECTED'?'badge-busy':'badge-busy'}">${esc(b.status)}</span></td></tr>`).join("") + `</tbody></table>`; } catch (err) { el.innerHTML = `<p class="msg-err">${err.message}</p>`; } }

async function loadAdminBookings() { const el = $("admin-bookings-table"); if (!el) return; try { const d = await api("GET", "/api/admin/bookings"); if (!d.bookings.length) { el.innerHTML = `<p>No bookings.</p>`; return; } el.innerHTML = `<table><thead><tr><th>User</th><th>Room</th><th>Day</th><th>Slot</th><th>Purpose</th><th>Status</th><th>Action</th></tr></thead><tbody>` + d.bookings.map(b => `<tr><td>${esc(b.userName)}<br><small>${esc(b.identifier)}</small></td><td>${esc(b.roomName)}</td><td>${esc(b.day)}</td><td>${esc(b.slot)}</td><td>${esc(b.purpose)}</td><td><span class="badge ${b.status==='APPROVED'?'badge-free':b.status==='REJECTED'?'badge-busy':'badge-busy'}">${esc(b.status)}</span></td><td>${b.status==='PENDING'?`<button class="btn btn-primary btn-sm" onclick="respondBooking('${esc(b.id)}','APPROVED')">Approve</button> <button class="btn btn-danger btn-sm" onclick="respondBooking('${esc(b.id)}','REJECTED')">Reject</button>`:'—'}</td></tr>`).join("") + `</tbody></table>`; } catch (err) { el.innerHTML = `<p class="msg-err">${err.message}</p>`; } }
async function respondBooking(id, status) { try { await api("POST", `/api/admin/bookings/${id}`, { status }); setMsg("bookings-msg", status === "APPROVED" ? "Approved." : "Rejected.", true); loadAdminBookings(); } catch (err) { setMsg("bookings-msg", err.message); } }

async function startRealTime() { clearInterval(S._roomInt); async function poll() { if (!S.token) return; try { await api("GET", "/api/data"); loadData(); if ($("v-bookings")?.classList.contains("active")) loadAdminBookings(); } catch {} } S._roomInt = setInterval(poll, 5000); }

async function init() {
  if (!S.token) return;
  try { S.user = await api("GET", "/api/me"); if (S.user.is_temp) { $("login-screen").classList.add("hidden"); $("pw-modal").classList.remove("hidden"); } else { showApp(); await loadData(); initNav(); statsInterval = setInterval(() => { if (document.querySelector(".view.active")?.id === "v-dashboard") updateStats(); }, 60000); clockInterval = setInterval(updateClock, 1000); updateClock(); } } catch { S.token = ""; sessionStorage.removeItem("nist-rm-token"); showLogin(); }
}
init();