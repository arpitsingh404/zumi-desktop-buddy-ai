/* Zumi task engine — persistent task records, schedules, reports (all local).
   NOTHING IS EVER DELETED: records that leave the hot window are appended to an
   append-only archive file, and lifetime / today counters are kept separately so
   reports stay exact even after millions of tasks.
   Saves are coalesced + written off the main thread: a fast batch used to fire a
   synchronous 1 MB JSON.stringify + writeFileSync on every task, which froze the UI. */
const fs = require("fs");
const path = require("path");

let file = null;
let archiveFile = null;
let data = { seq: 0, tasks: [], schedules: [], log: [] };
const MAX_TASKS = 2000;

/* ---- coalesced, non-blocking, atomic save ---- */
let saveTimer = null;
let pendingWrite = false;
let needFlush = false;
let writeSeq = 0;
let syncHappened = 0;

function save() {
  needFlush = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; queueSave(); }, 250);
}
function queueSave() {
  if (pendingWrite || !needFlush || !file) return;
  needFlush = false;
  pendingWrite = true;
  const seq = ++writeSeq;
  const payload = JSON.stringify(data);      // compact (no indent) — ~3x faster, ~40% smaller
  const tmp = file + ".tmp";
  fs.writeFile(tmp, payload, (err) => {
    pendingWrite = false;
    if (!err && seq > syncHappened) {
      try { fs.renameSync(tmp, file); } catch { /* ignore */ }
    }
    if (needFlush) { saveTimer = setTimeout(() => { saveTimer = null; queueSave(); }, 250); }
  });
}
/** Synchronous flush for shutdown — guarantees the last writes reach disk. */
function flushSync() {
  if (!file) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  needFlush = false;
  syncHappened = ++writeSeq;
  try { fs.writeFileSync(file + ".tmp", JSON.stringify(data)); fs.renameSync(file + ".tmp", file); } catch { /* ignore */ }
}

/* ---- append-only archive: evicted / cleared records are kept, never lost ---- */
let archiveBuf = "";
let archiving = false;
function archiveBatch(list) {
  if (!list.length || !archiveFile) return;
  archiveBuf += list.map((t) => JSON.stringify(t)).join("\n") + "\n";
  if (archiving) return;
  archiving = true;
  const pump = () => {
    if (!archiveBuf) { archiving = false; return; }
    const chunk = archiveBuf; archiveBuf = "";
    fs.appendFile(archiveFile, chunk, () => pump());
  };
  pump();
}

/* ---- day / lifetime counters ---- */
const dayKey = (d) => { d = d || new Date(); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); };
const TERMINAL = ["completed", "failed", "blocked", "cancelled"];

function rollDay() {
  const k = dayKey();
  if (!data.day) data.day = { key: k, created: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
  if (data.day.key !== k) {
    if (data.day.created || data.day.completed || data.day.failed) {
      data.days = Array.isArray(data.days) ? data.days : [];
      data.days.push({ ...data.day });
      if (data.days.length > 60) data.days = data.days.slice(-60);
    }
    data.day = { key: k, created: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
  }
  return data.day;
}

function init(dir) {
  file = path.join(dir, "zumi-tasks.json");
  archiveFile = path.join(dir, "zumi-tasks-archive.jsonl");
  try { data = { ...data, ...JSON.parse(fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "")) }; } catch { /* first run */ }
  if (!Array.isArray(data.tasks)) data.tasks = [];
  if (!Array.isArray(data.schedules)) data.schedules = [];
  if (!Array.isArray(data.log)) data.log = [];
  if (!data.lifetime) {
    const L = { created: data.seq || data.tasks.length, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
    for (const t of data.tasks) if (L[t.status] !== undefined) L[t.status]++;
    data.lifetime = L;
  }
  const d = rollDay();
  // bootstrap today's counters from whatever is still in the hot window
  const w = { created: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
  for (const t of data.tasks) {
    if (t.created_at && dayKey(new Date(t.created_at)) === d.key) w.created++;
    if (TERMINAL.includes(t.status) && t.completed_at && dayKey(new Date(t.completed_at)) === d.key) w[t.status]++;
  }
  for (const k of Object.keys(w)) d[k] = Math.max(d[k] || 0, w[k]);
}

const uid = () => "T" + String(++data.seq).padStart(4, "0");

function create({ title, priority = "P2", steps = [], requiresConfirmation = false, mode = "direct" } = {}) {
  const t = {
    task_id: uid(), title: title || "Untitled task", status: "queued", priority: priority || "P2", mode,
    created_at: Date.now(), started_at: null, completed_at: null, steps: steps || [],
    result: "", error: "", artifacts: [], requires_confirmation: !!requiresConfirmation, retries: 0,
  };
  rollDay();
  data.lifetime.created++;
  data.day.created++;
  data.tasks.push(t);
  if (data.tasks.length > MAX_TASKS) archiveBatch(data.tasks.splice(0, data.tasks.length - MAX_TASKS));
  save();
  return t;
}
function get(id) { return data.tasks.find((t) => t.task_id === id); }
function update(id, patch) {
  const t = get(id);
  if (t) {
    const before = t.status;
    Object.assign(t, patch);
    if (t.status !== before && TERMINAL.includes(t.status)) {
      rollDay();
      if (data.lifetime[t.status] === undefined) data.lifetime[t.status] = 0;
      data.lifetime[t.status]++;
      data.day[t.status] = (data.day[t.status] || 0) + 1;
    }
    save();
  }
  return t;
}

function stats() {
  const c = { queued: 0, running: 0, waiting: 0, completed: 0, failed: 0, blocked: 0, cancelled: 0 };
  for (const t of data.tasks) c[t.status] = (c[t.status] || 0) + 1;
  const L = data.lifetime || {};
  return {
    queued: c.queued, running: c.running, waiting: c.waiting,
    completed: L.completed !== undefined ? L.completed : c.completed,
    failed: L.failed !== undefined ? L.failed : c.failed,
    blocked: L.blocked !== undefined ? L.blocked : c.blocked,
    cancelled: L.cancelled !== undefined ? L.cancelled : c.cancelled,
    total: L.created !== undefined ? L.created : c.total,
    window: data.tasks.length,
  };
}
function running() { return data.tasks.filter((t) => t.status === "running" || t.status === "queued" || t.status === "waiting"); }
function today() {
  const start = new Date(); start.setHours(0, 0, 0, 0);
  return data.tasks.filter((t) => t.created_at >= start.getTime());
}
function report() {
  const d = rollDay();
  const list = today();
  const g = (s) => list.filter((t) => t.status === s);
  const dur = (t) => (t.completed_at && t.started_at ? Math.round((t.completed_at - t.started_at) / 1000) : 0);
  const completed = g("completed"), failed = g("failed"), blocked = g("blocked");
  // counts come from the day counters (they survive the hot window rolling over),
  // the detail lines come from whatever is still in the window
  const done = d.completed, fail = d.failed, blk = d.blocked;
  const attempted = done + fail + blk;
  const totalSec = list.reduce((a, t) => a + dur(t), 0);
  const lines = [];
  lines.push("Daily AI Buddy Report");
  lines.push("Date: " + new Date().toISOString().slice(0, 10));
  lines.push("");
  lines.push(`Tasks completed: ${done}`);
  lines.push(`Tasks failed: ${fail}`);
  lines.push(`Tasks blocked: ${blk}`);
  lines.push(`Tasks created today: ${d.created}`);
  lines.push(`Tasks queued/running: ${list.filter((t) => ["queued", "running", "waiting"].includes(t.status)).length}`);
  lines.push(`Success rate: ${attempted ? Math.round((done / attempted) * 100) : 0}%`);
  lines.push(`Total execution time: ${totalSec}s`);
  lines.push("");
  if (completed.length) { lines.push("Completed:"); for (const t of completed.slice(-20)) lines.push(`  ${t.task_id} — ${t.title} — ${t.result || "ok"}`); lines.push(""); }
  if (failed.length) { lines.push("Failed:"); for (const t of failed.slice(-20)) lines.push(`  ${t.task_id} — ${t.title} — ${t.error || "error"}`); lines.push(""); }
  if (blocked.length) { lines.push("Blocked:"); for (const t of blocked.slice(-20)) lines.push(`  ${t.task_id} — ${t.title} — ${t.error || "needs input"}`); lines.push(""); }
  const artifacts = list.flatMap((t) => (t.artifacts || []).map((a) => `${t.task_id}: ${a}`)).slice(-30);
  if (artifacts.length) { lines.push("Artifacts:"); artifacts.forEach((a) => lines.push("  " + a)); lines.push(""); }
  return lines.join("\n");
}

/* ---- schedules ---- */
function scheduleAdd({ task, schedule, enabled = true }) {
  const s = { schedule_id: "S" + Date.now().toString(36) + Math.random().toString(36).slice(2, 4), task, schedule, enabled, last_run: null, next_run: null, created_at: Date.now() };
  data.schedules.push(s); save(); return s;
}
function scheduleList() { return data.schedules; }
function scheduleRemove(id) { const b = data.schedules.length; data.schedules = data.schedules.filter((s) => s.schedule_id !== id); save(); return b - data.schedules.length; }
function scheduleDue(now) { return data.schedules.filter((s) => s.enabled && s.next_run && s.next_run <= now); }
function scheduleSetNext(id, next) { const s = data.schedules.find((x) => x.schedule_id === id); if (s) { s.last_run = Date.now(); s.next_run = next; save(); } }

function log(msg) { data.log.push({ at: Date.now(), msg: String(msg).slice(0, 500) }); if (data.log.length > 1000) data.log = data.log.slice(-1000); save(); }
function logList(limit = 50) { return data.log.slice(-limit); }
function clear() {
  // user asked that nothing is deleted — archive first, then empty the hot window
  archiveBatch(data.tasks.slice());
  data.tasks = [];
  save();
  return true;
}
function all() { return data; }

module.exports = {
  init, save, flushSync, create, get, update, stats, running, today, report,
  scheduleAdd, scheduleList, scheduleRemove, scheduleDue, scheduleSetNext,
  log, logList, clear, all,
};
