/* Zumi local brain — everything stored on THIS PC (userData/zumi-brain.json). */
const fs = require("fs");
const path = require("path");

let file = null;
let archFile = null;
let data = { memory: [], history: [], tasks: [], notes: [], reminders: [], meta: {} };
let saveTimer = null;
let pendingWrite = false;
let needFlush = false;
let writeSeq = 0;
let syncSeq = 0;

function init(userDataDir) {
  file = path.join(userDataDir, "zumi-brain.json");
  archFile = path.join(userDataDir, "zumi-brain-archive.jsonl");
  try {
    const raw = fs.readFileSync(file, "utf8").replace(/^\uFEFF/, "");
    const parsed = JSON.parse(raw);
    data = { ...data, ...parsed };
    data.memory = data.memory || [];
    data.history = data.history || [];
    data.tasks = data.tasks || [];
    data.notes = data.notes || [];
    data.reminders = data.reminders || [];
  } catch { /* first run */ }
}

/* Append-only archive: entries that roll out of the hot lists are kept on disk
   forever (nothing is ever really deleted). */
let archBuf = "";
let archiving = false;
function archive(kind, list) {
  if (!list || !list.length || !archFile) return;
  archBuf += list.map((x) => JSON.stringify({ kind, ...x })).join("\n") + "\n";
  if (archiving) return;
  archiving = true;
  const pump = () => {
    if (!archBuf) { archiving = false; return; }
    const chunk = archBuf; archBuf = "";
    fs.appendFile(archFile, chunk, () => pump());
  };
  pump();
}

/* Async, coalesced save — the old version ran a synchronous JSON.stringify + writeFileSync
   on the main thread every 250 ms while a batch was writing notes/memory. */
function save() {
  needFlush = true;
  if (saveTimer) return;
  saveTimer = setTimeout(() => { saveTimer = null; queueSave(); }, 250);
}
function queueSave() {
  if (pendingWrite || !needFlush || !file) return;
  needFlush = false;
  pendingWrite = true;
  const mySeq = ++writeSeq;
  const payload = JSON.stringify(data, null, 2);
  fs.writeFile(file + ".tmp", payload, (err) => {
    pendingWrite = false;
    if (!err && mySeq > syncSeq) { try { fs.renameSync(file + ".tmp", file); } catch { /* ignore */ } }
    if (needFlush) saveTimer = setTimeout(() => { saveTimer = null; queueSave(); }, 250);
  });
}
function flushSync() {
  if (!file) return;
  if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
  needFlush = false;
  syncSeq = ++writeSeq;
  try { fs.writeFileSync(file + ".tmp", JSON.stringify(data, null, 2)); fs.renameSync(file + ".tmp", file); } catch { /* ignore */ }
}

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

/* ---- memory (facts Zumi learns about the user) ---- */
function memoryAdd(text, tag) {
  const t = String(text || "").trim();
  if (!t) return null;
  const exists = data.memory.find((m) => m.text.toLowerCase() === t.toLowerCase());
  if (exists) return exists;
  const item = { id: uid(), text: t, tag: tag || "", at: Date.now() };
  data.memory.push(item);
  if (data.memory.length > 500) archive("memory", data.memory.splice(0, data.memory.length - 500));
  save();
  return item;
}
function memoryList() { return data.memory.slice(-300); }
function memorySearch(q) {
  const s = String(q || "").toLowerCase();
  if (!s) return [];
  return data.memory.filter((m) => m.text.toLowerCase().includes(s)).slice(-20);
}
function memoryForget(q) {
  const s = String(q || "").toLowerCase().trim();
  const before = data.memory.length;
  const removed = data.memory.filter((m) => m.id === s || m.text.toLowerCase().includes(s));
  data.memory = data.memory.filter((m) => m.id !== s && !m.text.toLowerCase().includes(s));
  archive("memory-forgotten", removed);   // "forget" moves it to the archive — nothing is destroyed
  save();
  return before - data.memory.length;
}

/* ---- history (local chat log) ---- */
function historyAdd(role, content) {
  data.history.push({ role, content: String(content || "").slice(0, 4000), at: Date.now() });
  if (data.history.length > 800) archive("history", data.history.splice(0, data.history.length - 800));
  save();
}
function historyGet(limit = 12) { return data.history.slice(-limit); }
function historyClear() { archive("history-cleared", data.history.slice()); data.history = []; save(); }

/* ---- tasks (to-do) ---- */
function tasksAdd(text) {
  const t = String(text || "").trim(); if (!t) return null;
  const item = { id: uid(), text: t, done: false, at: Date.now() };
  data.tasks.push(item); save(); return item;
}
function tasksList() { return data.tasks; }
function tasksDone(q) {
  const s = String(q || "").toLowerCase().trim();
  const it = data.tasks.find((t) => t.id === s || t.text.toLowerCase().includes(s));
  if (it) { it.done = true; save(); }
  return it || null;
}
function tasksRemove(q) {
  const s = String(q || "").toLowerCase().trim();
  const before = data.tasks.length;
  const removed = data.tasks.filter((t) => t.id === s || t.text.toLowerCase().includes(s));
  data.tasks = data.tasks.filter((t) => t.id !== s && !t.text.toLowerCase().includes(s));
  archive("todo-removed", removed);
  save();
  return before - data.tasks.length;
}
function tasksClearDone() { const done = data.tasks.filter((t) => t.done); archive("todo-done", done); data.tasks = data.tasks.filter((t) => !t.done); save(); }

/* ---- notes ---- */
function notesAdd(text) { const t = String(text || "").trim(); if (!t) return null; const it = { id: uid(), text: t, at: Date.now() }; data.notes.push(it); save(); return it; }
function notesList() { return data.notes.slice(-200); }
function notesClear() { archive("note-cleared", data.notes.slice()); data.notes = []; save(); }

/* ---- reminders (persistent) ---- */
function remindersAdd(text, atMs) { const it = { id: uid(), text: String(text || "").trim(), at: Number(atMs), done: false }; data.reminders.push(it); save(); return it; }
function remindersList() { return data.reminders.filter((r) => !r.done); }
function remindersRemove(q) {
  const s = String(q || "").toLowerCase().trim();
  const before = data.reminders.length;
  const removed = data.reminders.filter((r) => r.id === s || r.text.toLowerCase().includes(s));
  data.reminders = data.reminders.filter((r) => r.id !== s && !r.text.toLowerCase().includes(s));
  archive("reminder-removed", removed);
  save();
  return before - data.reminders.length;
}
function remindersDue(now) { return data.reminders.filter((r) => !r.done && r.at <= now); }
function reminderMarkDone(id) { const r = data.reminders.find((x) => x.id === id); if (r) { r.done = true; save(); } }

function all() { return data; }
function stats() {
  return { memory: data.memory.length, history: data.history.length, tasks: data.tasks.filter((t) => !t.done).length, notes: data.notes.length, reminders: data.reminders.filter((r) => !r.done).length, file };
}

module.exports = {
  init, save, flushSync, all, stats,
  memoryAdd, memoryList, memorySearch, memoryForget,
  historyAdd, historyGet, historyClear,
  tasksAdd, tasksList, tasksDone, tasksRemove, tasksClearDone,
  notesAdd, notesList, notesClear,
  remindersAdd, remindersList, remindersRemove, remindersDue, reminderMarkDone,
};
