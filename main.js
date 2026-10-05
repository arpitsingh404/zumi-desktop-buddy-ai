const { app, BrowserWindow, ipcMain, screen, desktopCapturer, shell, Menu, session, globalShortcut, clipboard, Notification } = require("electron");
const path = require("path");
const os = require("os");
const fs = require("fs");
const { spawn, execFile } = require("child_process");
const vm = require("vm");
const crypto = require("crypto");
const http = require("http");
const https = require("https");
const { URL } = require("url");
const brain = require("./brain");

const PY = "C:\\InsafeLabs\\tools-venv\\Scripts\\python.exe";
const STT_SCRIPT = path.join(__dirname, "stt.py");
const STT_WORKER_SCRIPT = path.join(__dirname, "stt_worker.py");
const MODELS_DIR = path.join(__dirname, "models");

/* ------------------------------ persistent STT worker (faster-whisper) ------------------------------
   Keeps the model in memory so each utterance transcribes in well under a second.
   Falls back to the original Vosk script if the worker ever misbehaves.        */
let sttProc = null;
let sttReady = false;
let sttBusy = 0;
let sttFails = 0;
let sttStarting = null;
let sttReqId = 0;
const sttWaiters = new Map();

function sttKill() {
  sttReady = false;
  if (sttProc) { try { sttProc.kill(); } catch { /* ignore */ } sttProc = null; }
  for (const [, w] of sttWaiters) { try { w.reject(new Error("stt worker stopped")); } catch { /* ignore */ } }
  sttWaiters.clear();
  sttStarting = null;
}

function sttStart() {
  if (sttReady && sttProc) return Promise.resolve();
  if (sttStarting) return sttStarting;
  sttStarting = new Promise((resolve, reject) => {
    let p;
    try {
      p = spawn(PY, ["-u", STT_WORKER_SCRIPT], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    } catch (e) { sttStarting = null; return reject(e); }
    sttProc = p;
    let buf = "";
    let errBuf = "";
    const timer = setTimeout(() => { if (!sttReady) { appLog("STT worker: start timeout"); sttKill(); reject(new Error("stt worker start timeout")); } }, 45000);
    p.stdout.on("data", (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1);
        if (!line) continue;
        let j = null;
        try { j = JSON.parse(line); } catch { continue; }
        if (j.ready) {
          sttReady = true; sttFails = 0;
          clearTimeout(timer);
          appLog(`STT worker ready (${j.engine}, model ${j.modelMs}ms, pid ${j.pid}, ppid ${j.ppid})`);
          resolve();
          continue;
        }
        if (j.fatal) {
          clearTimeout(timer); sttKill();
          appLog("STT worker fatal: " + j.fatal);
          reject(new Error(j.fatal));
          continue;
        }
        if (j.id != null && sttWaiters.has(j.id)) {
          const w = sttWaiters.get(j.id); sttWaiters.delete(j.id);
          clearTimeout(w.timer);
          if (j.error) { sttFails++; w.reject(new Error(j.error)); }
          else w.resolve(j);
        }
      }
    });
    p.stderr.on("data", (d) => { errBuf = (errBuf + d.toString()).slice(-4000); });
    p.on("error", (e) => { clearTimeout(timer); sttKill(); sttStarting = null; appLog("STT worker spawn error: " + e.message); reject(e); });
    p.on("exit", (code) => {
      clearTimeout(timer);
      const wasReady = sttReady;
      sttReady = false; sttProc = null; sttStarting = null;
      for (const [, w] of sttWaiters) { try { clearTimeout(w.timer); w.reject(new Error("stt worker exited")); } catch { /* ignore */ } }
      sttWaiters.clear();
      if (wasReady) appLog(`STT worker exited (code ${code})${errBuf ? ": " + errBuf.split("\n").filter(Boolean).slice(-2).join(" | ") : ""}`);
      if (!wasReady) reject(new Error("stt worker failed to start"));
    });
    p.stdin.on("error", () => { /* ignore broken pipe during shutdown */ });
  }).finally(() => { sttStarting = null; });
  return sttStarting;
}

function sttAsk(wavPath, lang) {
  return new Promise((resolve, reject) => {
    if (!sttReady || !sttProc) return reject(new Error("stt worker not ready"));
    const id = ++sttReqId;
    const timer = setTimeout(() => { sttWaiters.delete(id); reject(new Error("stt worker timeout")); }, 30000);
    sttWaiters.set(id, { resolve, reject, timer });
    try { sttProc.stdin.write(JSON.stringify({ id, wav: wavPath, lang }) + "\n"); }
    catch (e) { sttWaiters.delete(id); clearTimeout(timer); reject(e); }
  });
}


// allow mic/AudioContext without a user gesture (needed for the global hotkey)
app.commandLine.appendSwitch("autoplay-policy", "no-user-gesture-required");
// some Windows GPUs fail to composite transparent windows — software rendering is reliable
app.disableHardwareAcceleration();

let win = null;
let settingsPath = null;
let dragState = null;

const DEFAULTS = {
  apiKey: "",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-chat",
  buddyName: "Zumi",
  userName: "",
  voice: true,
  voiceName: "",
  voiceControl: true,
  autoMood: true,
  size: 200,
  x: null,
  y: null,
  setupDone: false,
};

let settings = { ...DEFAULTS };
let shortcutOk = false;
let activeHotkey = "";

/* ---------------- app log (voice / chat / renderer errors) ----------------
   Everything worth debugging lands in %APPDATA%\zumi-desktop-buddy\zumi.log.
   Buffered like trace() so logging never blocks the main thread. */
let APP_LOG = null, logBuf = "", logTimer = null, logWriting = false, logRotated = false;
function appLogFile() { if (!APP_LOG) APP_LOG = path.join(app.getPath("userData"), "zumi.log"); return APP_LOG; }
/* Local wall-clock stamp. toISOString() is UTC, which put /logs and zumi.log 5h30m
   behind the clock the user is actually reading them against — useless for
   "what happened at the moment I spoke". */
function logStamp() {
  const d = new Date(), p = (n, w = 2) => String(n).padStart(w, "0");
  return p(d.getHours()) + ":" + p(d.getMinutes()) + ":" + p(d.getSeconds()) + "." + p(d.getMilliseconds(), 3);
}
function logFlush() {
  if (logTimer) { clearTimeout(logTimer); logTimer = null; }
  if (!logBuf || logWriting) return;
  const chunk = logBuf; logBuf = "";
  logWriting = true;
  fs.appendFile(appLogFile(), chunk, () => { logWriting = false; if (logBuf) logFlush(); });
}
function appLog(msg) {
  if (!logRotated) {
    logRotated = true;   // once per session: keep the file small, never lose it silently
    try { const f = appLogFile(); if (fs.existsSync(f) && fs.statSync(f).size > 524288) fs.renameSync(f, f + ".old"); } catch { /* ignore */ }
  }
  logBuf += logStamp() + "  " + msg + "\n";
  if (logBuf.length > 32768) { logFlush(); return; }
  if (!logTimer) logTimer = setTimeout(logFlush, 250);
}
process.on("exit", () => { if (logBuf) { try { fs.appendFileSync(appLogFile(), logBuf); } catch { /* ignore */ } } });
ipcMain.on("log:add", (_e, m) => appLog(String(m == null ? "" : m).slice(0, 500)));
ipcMain.handle("log:read", (_e, n) => {
  try {
    const f = appLogFile();
    if (!fs.existsSync(f)) return [];
    const lines = fs.readFileSync(f, "utf8").split("\n").filter(Boolean);
    return lines.slice(-Math.max(1, Math.min(300, Number(n) || 40)));
  } catch { return []; }
});

function registerHotkeys() {
  const keys = ["Control+Alt+Z", "Control+Shift+Z", "Control+Alt+Space", "Control+Alt+V", "F9"];
  for (const k of keys) {
    try {
      if (globalShortcut.register(k, () => { appLog("hotkey " + k + " -> voice:toggle"); if (win) win.webContents.send("voice:toggle"); })) {
        shortcutOk = true; activeHotkey = k;
        console.log("[zumi] voice hotkey registered:", k);
        break;
      }
    } catch { /* try next */ }
  }
  if (!shortcutOk) console.log("[zumi] could not register any voice hotkey");
}

function loadSettings() {
  try {
    const raw = fs.readFileSync(settingsPath, "utf8").replace(/^\uFEFF/, "");
    settings = { ...DEFAULTS, ...JSON.parse(raw) };
  } catch { /* first run */ }
}
function saveSettings() {
  try { fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2)); } catch { /* ignore */ }
}

function createWindow() {
  const wa = screen.getPrimaryDisplay().workAreaSize;
  const setup = settings.setupDone === false;
  const w = setup ? 500 : Math.max(settings.size + 60, 380);
  const h = setup ? 680 : settings.size + 180;
  const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
  let x = setup ? Math.round((wa.width - w) / 2) : (wa.width - w - 24);
  let y = setup ? Math.max(0, Math.round((wa.height - h) / 2) - 20) : (wa.height - h - 40);
  if (!setup && Number.isFinite(settings.x)) x = clamp(settings.x, 0, Math.max(0, wa.width - w));
  if (!setup && Number.isFinite(settings.y)) y = clamp(settings.y, 0, Math.max(0, wa.height - h));
  win = new BrowserWindow({
    width: w,
    height: h,
    x: Math.round(x),
    y: Math.round(y),
    frame: false,
    transparent: true,
    resizable: true,
    alwaysOnTop: true,
    skipTaskbar: true,
    hasShadow: false,
    fullscreenable: false,
    maximizable: false,
    minimizable: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.setAlwaysOnTop(true, "screen-saver");
  win.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  win.loadFile(path.join(__dirname, "renderer", "index.html"));
  // capture renderer warnings/errors into zumi.log (supports old & new event signatures)
  try {
    win.webContents.on("console-message", (...args) => {
      const a = args.length > 1
        ? { level: args[1], message: args[2], lineNumber: args[3], sourceId: args[4] }
        : (args[0] || {});
      if (Number(a.level) >= 2) appLog(`renderer[${a.level}] ${String(a.message || "").slice(0, 300)} @${String(a.sourceId || "").split(/[\\/]/).pop()}:${a.lineNumber}`);
    });
  } catch { /* ignore */ }
  setTimeout(() => { try { win.show(); win.focus(); win.setAlwaysOnTop(true, "screen-saver"); win.moveTop(); } catch { /* ignore */ } }, 500);
}

app.whenReady().then(() => {
  settingsPath = path.join(app.getPath("userData"), "zumi.json");
  loadSettings();
  brain.init(app.getPath("userData"));
  tasks.init(app.getPath("userData"));
  Menu.setApplicationMenu(null);
  try {
    session.defaultSession.setPermissionRequestHandler((_wc, _permission, callback) => callback(true));
    session.defaultSession.setPermissionCheckHandler(() => true);
  } catch { /* ignore */ }
  createWindow();
  registerHotkeys();
  startReminderLoop();
  startTaskLoop();
  startDailyLoop();
  startSelfTest();
  setInterval(() => { if (win && !win.isDestroyed()) { win.setAlwaysOnTop(true, "screen-saver"); win.moveTop(); } }, 7000);
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("will-quit", () => { try { sttKill(); } catch { /* ignore */ } try { globalShortcut.unregisterAll(); } catch { /* ignore */ } try { tasks.flushSync(); } catch { /* ignore */ } try { brain.flushSync(); } catch { /* ignore */ } });
app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

/* ------------------------------ settings ------------------------------ */
ipcMain.handle("settings:get", () => settings);
ipcMain.handle("settings:set", (_e, patch) => {
  settings = { ...settings, ...patch };
  saveSettings();
  if (win && (patch.size !== undefined)) {
    const w = Math.max(settings.size + 60, 380);
    const h = settings.size + 180;
    win.setSize(w, h);
  }
  return settings;
});

/* ------------------------------ system ------------------------------ */
ipcMain.handle("app:stats", () => {
  const total = os.totalmem();
  const free = os.freemem();
  return {
    platform: os.platform(),
    host: os.hostname(),
    cpus: os.cpus().length,
    memUsedPct: Math.round((1 - free / total) * 100),
    memTotalGB: +(total / 1024 ** 3).toFixed(1),
    uptimeMin: Math.round(os.uptime() / 60),
  };
});

/* ------------------------------ window drag ------------------------------ */
ipcMain.handle("win:move", (_e, { dx, dy }) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  win.setPosition(Math.round(x + dx), Math.round(y + dy));
  return true;
});
ipcMain.handle("win:drag-begin", () => { dragState = screen.getCursorScreenPoint(); return true; });
ipcMain.handle("win:drag-to", () => {
  if (!win) return false;
  const p = screen.getCursorScreenPoint();
  if (dragState) {
    const [x, y] = win.getPosition();
    win.setPosition(x + (p.x - dragState.x), y + (p.y - dragState.y));
  }
  dragState = p;
  return true;
});
ipcMain.handle("win:drag-end", () => {
  dragState = null;
  if (win) {
    const [x, y] = win.getPosition();
    settings.x = x;
    settings.y = y;
    saveSettings();
  }
  return true;
});
ipcMain.handle("win:set-ignore", (_e, ignore) => {
  if (win) win.setIgnoreMouseEvents(!!ignore, { forward: true });
  return true;
});
ipcMain.handle("win:resize", (_e, { w, h }) => { if (win) win.setSize(Math.round(w), Math.round(h)); return true; });
ipcMain.handle("win:restore", () => { if (win) { win.setSize(Math.max(settings.size + 60, 380), settings.size + 180); } return true; });
ipcMain.handle("win:quit", () => { app.quit(); return true; });
ipcMain.handle("win:setup-mode", (_e, on) => {
  if (!win) return false;
  const wa = screen.getPrimaryDisplay().workAreaSize;
  if (on) {
    win.setIgnoreMouseEvents(false);
    win.setSize(500, 680);
    win.setPosition(Math.round((wa.width - 500) / 2), Math.max(0, Math.round((wa.height - 680) / 2) - 20));
    win.show(); win.moveTop(); win.focus();
  } else {
    const w = Math.max(settings.size + 60, 380);
    const h = settings.size + 180;
    const x = wa.width - w - 24;
    const y = wa.height - h - 40;
    win.setSize(w, h);
    win.setPosition(x, y);
    settings.x = x; settings.y = y; saveSettings();
    win.setAlwaysOnTop(true, "screen-saver");
    win.show(); win.moveTop();
  }
  return true;
});
ipcMain.handle("app:menu", () => {
  if (!win) return false;
  const m = Menu.buildFromTemplate([
    { label: "Quit Zumi", click: () => app.quit() },
  ]);
  m.popup({ window: win });
  return true;
});

/* ------------------------------ small tasks ------------------------------ */
const APP_MAP = {
  notepad: "notepad.exe",
  calc: "calc.exe",
  explorer: "explorer.exe",
  paint: "mspaint.exe",
  vscode: "code",
  cmd: "cmd.exe",
  settings: "ms-settings:",
};

ipcMain.handle("app:open", async (_e, name) => {
  if (name === "browser") { shell.openExternal("https://www.google.com"); return true; }
  if (!APP_MAP[name]) return false;
  /* Same path the planner uses: launch it, then confirm a real window appeared,
     so the UI never says "opened" for an app that silently failed to start. */
  try {
    const r = await automation.launchApp(name);
    appLog(`open app ${name} -> ${r.ok ? "ok (" + (r.title || "window") + ")" : "FAILED: " + r.note}`);
    return r.ok;
  } catch (e) {
    appLog(`open app ${name} -> FAILED: ${String((e && e.message) || e)}`);
    return false;
  }
});

ipcMain.handle("app:url", (_e, url) => {
  if (typeof url === "string" && /^https?:\/\//i.test(url)) shell.openExternal(url);
  return true;
});

ipcMain.handle("app:screenshot", async () => {
  const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 900 } });
  if (!sources.length || !sources[0].thumbnail) return null;
  const file = path.join(app.getPath("pictures"), `zumi-${Date.now()}.png`);
  try {
    fs.writeFileSync(file, sources[0].thumbnail.toPNG());
    return file;
  } catch {
    return null;
  }
});

/* ------------------------------ voice (offline STT via Vosk) ------------------------------ */
ipcMain.handle("debug:state", () => ({ shortcutOk, activeHotkey, mic: true }));
ipcMain.handle("voice:transcribe", async (_e, { wav }) => {
  if (!fs.existsSync(PY)) { appLog("STT FAIL: python missing " + PY); throw new Error("Python (tools-venv) not found at " + PY); }
  const tmp = path.join(app.getPath("temp"), `zumi_${Date.now()}.wav`);
  fs.writeFileSync(tmp, Buffer.from(wav, "base64"));
  const t0 = Date.now();
  const cleanup = () => fs.unlink(tmp, () => {});

  // 1) fast path — persistent faster-whisper worker (accurate, model stays warm)
  try {
    await sttStart();
    const r = await sttAsk(tmp, "en");
    cleanup();
    const ms = Date.now() - t0;
    const text = typeof r.text === "string" ? r.text : "";
    appLog(`STT-W ${ms}ms (worker ${r.ms}ms) -> "${text.slice(0, 80)}"`);
    if (sttFails >= 3) { appLog("STT worker failing repeatedly — restarting"); sttKill(); }
    return text;
  } catch (e) {
    appLog("STT-W unavailable (" + String(e.message).slice(0, 120) + ") -> falling back to Vosk");
    sttFails++;
    if (sttFails >= 2) sttKill();
  }

  // 2) fallback — original offline Vosk script
  const modelDir = path.join(MODELS_DIR, "vosk-model-small-en-us-0.15");
  if (!fs.existsSync(modelDir)) { cleanup(); appLog("STT FAIL: model missing " + modelDir); throw new Error("Speech model missing (models/ folder)"); }
  return await new Promise((resolve, reject) => {
    execFile(PY, [STT_SCRIPT, tmp, modelDir], { timeout: 40000, maxBuffer: 1e7 }, (err, stdout) => {
      cleanup();
      const line = (stdout || "").trim().split("\n").filter(Boolean).pop() || "";
      let parsed = null;
      try { parsed = JSON.parse(line); } catch { parsed = null; }
      const ms = Date.now() - t0;
      if (parsed && parsed.error) { appLog(`STT ${ms}ms ERROR: ${parsed.error}`); return reject(new Error(parsed.error)); }
      if (parsed && typeof parsed.text === "string") { appLog(`STT ${ms}ms (vosk) -> "${parsed.text.slice(0, 80)}"`); return resolve(parsed.text); }
      if (err) { appLog(`STT ${ms}ms ERR: ${String(err.message).slice(0, 200)}`); return reject(new Error("STT failed: " + err.message)); }
      appLog(`STT ${ms}ms -> "" (no speech detected)`);
      resolve("");
    });
  });
});

/* ------------------------------ chat (DeepSeek) ------------------------------ */
ipcMain.handle("chat:send", async (_e, messages) => {
  if (!settings.apiKey) { appLog("CHAT FAIL: no API key"); throw new Error("No API key set — open ⚙ Settings and paste your DeepSeek key."); }
  const url = `${(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "")}/chat/completions`;
  const t0 = Date.now();
  let res;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
      body: JSON.stringify({ model: settings.model || DEFAULTS.model, messages, temperature: 0.85, max_tokens: 512 }),
    });
  } catch (e) {
    appLog(`CHAT ${Date.now() - t0}ms network error: ${e.message}`);
    throw new Error(`Network error: ${e.message}. Check your internet connection.`);
  }
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    appLog(`CHAT ${Date.now() - t0}ms API ${res.status}: ${t.slice(0, 200)}`);
    throw new Error(`API ${res.status}: ${t.slice(0, 220)}`);
  }
  const j = await res.json();
  const reply = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "(no reply)";
  appLog(`CHAT ${Date.now() - t0}ms ok (${reply.length} chars)`);
  return reply;
});

/* ------------------------------ local brain (memory / history / tasks / notes / reminders) ------------------------------ */
ipcMain.handle("brain:stats", () => brain.stats());
ipcMain.handle("brain:memory", (_e, q) => (q ? brain.memorySearch(q) : brain.memoryList()));
ipcMain.handle("brain:remember", (_e, { text, tag }) => brain.memoryAdd(text, tag));
ipcMain.handle("brain:forget", (_e, q) => brain.memoryForget(q));
ipcMain.handle("brain:history", (_e, limit) => brain.historyGet(limit || 12));
ipcMain.handle("brain:history-add", (_e, { role, content }) => { brain.historyAdd(role, content); return true; });
ipcMain.handle("brain:history-clear", () => { brain.historyClear(); return true; });
ipcMain.handle("brain:tasks", () => brain.tasksList());
ipcMain.handle("brain:task-add", (_e, text) => brain.tasksAdd(text));
ipcMain.handle("brain:task-done", (_e, q) => brain.tasksDone(q));
ipcMain.handle("brain:task-remove", (_e, q) => brain.tasksRemove(q));
ipcMain.handle("brain:notes", () => brain.notesList());
ipcMain.handle("brain:note-add", (_e, text) => brain.notesAdd(text));
ipcMain.handle("brain:notes-clear", () => { brain.notesClear(); return true; });
ipcMain.handle("brain:reminders", () => brain.remindersList());
ipcMain.handle("brain:reminder-add", (_e, { text, at }) => brain.remindersAdd(text, at));
ipcMain.handle("brain:reminder-remove", (_e, q) => brain.remindersRemove(q));

/* ------------------------------ extra skills ------------------------------ */
ipcMain.handle("clip:get", () => clipboard.readText());
ipcMain.handle("clip:set", (_e, text) => { clipboard.writeText(String(text || "")); return true; });
ipcMain.handle("notify", (_e, { title, body }) => { try { new Notification({ title: title || "Zumi", body: body || "" }).show(); } catch { /* ignore */ } return true; });
ipcMain.handle("openPath", (_e, p) => shell.openPath(String(p || "")));
ipcMain.handle("weather", async (_e, city) => {
  const c = String(city || "").trim() || "New Delhi";
  const geoRes = await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c)}&count=1`);
  const geo = await geoRes.json();
  const place = geo.results && geo.results[0];
  if (!place) throw new Error("City not found: " + c);
  const wxRes = await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}&current=temperature_2m,relative_humidity_2m,wind_speed_10m,weather_code`);
  const wx = await wxRes.json();
  const cur = wx.current || {};
  const codes = { 0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast", 45: "foggy", 48: "foggy", 51: "light drizzle", 53: "drizzle", 55: "drizzle", 61: "light rain", 63: "rain", 65: "heavy rain", 71: "light snow", 73: "snow", 75: "heavy snow", 80: "showers", 81: "showers", 82: "heavy showers", 95: "thunderstorm", 96: "thunderstorm", 99: "thunderstorm" };
  return { city: place.name + (place.country ? ", " + place.country : ""), temp: cur.temperature_2m, humidity: cur.relative_humidity_2m, wind: cur.wind_speed_10m, desc: codes[cur.weather_code] || "—" };
});

/* ------------------------------ task engine: AI planner + executor ------------------------------ */
const tasks = require("./tasks");
const automation = require("./automation");
const { verifySite, repairHtml, hardenScripts, REPAIR_SCRIPT } = require("./sitecheck");

function emit(channel, payload) { try { if (win && !win.isDestroyed()) win.webContents.send(channel, payload); } catch { /* ignore */ } }

/* A child process 'error' event with no listener turns into an uncaught exception, and Electron
   answers that with a blocking main-process error dialog — the app then freezes silently.
   Every spawn goes through spawnSafe(), and the two global handlers below are the safety net. */
function spawnSafe(cmd, args, opts) {
  const hasArgs = Array.isArray(args);
  const options = hasArgs ? (opts || {}) : (args || {});
  const argv = hasArgs ? args : [];
  const child = spawn(cmd, argv, options);
  child.on("error", () => { /* app missing or not executable — never block the UI */ });
  try { child.unref(); } catch { /* ignore */ }
  return child;
}
process.on("uncaughtException", (e) => { trace("UNCAUGHT " + ((e && e.stack) || e)); try { tasks.log("uncaught: " + String((e && e.message) || e).slice(0, 200)); } catch { /* ignore */ } });
process.on("unhandledRejection", (e) => { trace("UNHANDLED " + ((e && e.stack) || e)); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function callLLM(messages, maxTokens) {
  if (!settings.apiKey) throw new Error("No API key set — open setup and paste your DeepSeek key.");
  const url = `${(settings.baseUrl || DEFAULTS.baseUrl).replace(/\/$/, "")}/chat/completions`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${settings.apiKey}` },
    body: JSON.stringify({ model: settings.model || DEFAULTS.model, messages, temperature: 0.6, max_tokens: maxTokens || 900 }),
  });
  if (!res.ok) { const t = await res.text().catch(() => ""); throw new Error(`API ${res.status}: ${t.slice(0, 200)}`); }
  const j = await res.json();
  return (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || "";
}

/* ---- downloads -------------------------------------------------------------
   Zumi could previously only OPEN a url in the browser. These three actions give it
   a real download path: fetch a file by URL, pull an app's installer through winget,
   or install a package. Everything is verified by BYTES ON DISK / winget's own list —
   never by trusting an exit code alone. Nothing is ever deleted: a failed partial
   download is removed only because Zumi created it moments earlier in this same call. */
const DL_MAX = 512 * 1024 * 1024;      // hard cap per file: 512 MB
const DL_TIMEOUT = 180000;             // 3 min per URL download
const WINGET_TIMEOUT = 300000;         // 5 min for winget (first run refreshes sources)

function httpGet(url, redirects = 5) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { return reject(new Error("bad url")); }
    if (u.protocol !== "http:" && u.protocol !== "https:") return reject(new Error("only http and https urls are allowed"));
    const mod = u.protocol === "http:" ? http : https;
    const req = mod.get(u, { headers: { "User-Agent": "Zumi/1.0" }, timeout: DL_TIMEOUT }, (res) => {
      const st = res.statusCode || 0;
      if (st >= 300 && st < 400 && res.headers.location && redirects > 0) {
        res.resume();
        resolve(httpGet(new URL(res.headers.location, url).toString(), redirects - 1));
        return;
      }
      if (st !== 200) { res.resume(); return reject(new Error("HTTP " + st)); }
      resolve(res);
    });
    req.on("timeout", () => req.destroy(new Error("download timed out")));
    req.on("error", reject);
  });
}

/* Never clobber an existing file — if the name is taken, append " (1)", " (2)"... */
function uniquePath(dir, name) {
  const ext = path.extname(name);
  const base = ext ? name.slice(0, name.length - ext.length) : name;
  let dest = path.join(dir, name);
  for (let i = 1; fs.existsSync(dest) && i < 1000; i++) dest = path.join(dir, `${base} (${i})${ext}`);
  return dest;
}

function downloadsDir() {
  let d;
  try { d = app.getPath("downloads"); } catch { d = path.join(os.homedir(), "Downloads"); }
  try { fs.mkdirSync(d, { recursive: true }); } catch { /* ignore */ }
  return d;
}

/* winget is an app-execution alias and works with piped stdio even though this
   process has no console (verified: `winget download` exits 0 and writes the file).
   It still gets a hard timeout so a stuck source refresh can never hang a task. */
function runWinget(args, ms) {
  return new Promise((resolve) => {
    let out = "", done = false, child = null, timer = null;
    const finish = (code, note) => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      resolve({ code, note, out });
    };
    try {
      child = spawn("winget", args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) { return finish(-1, "spawn failed: " + e.message); }
    child.on("error", (e) => finish(-1, "winget error: " + e.message));
    const tap = (d) => { out += d; if (out.length > 60000) out = out.slice(-60000); };
    child.stdout.on("data", tap);
    child.stderr.on("data", tap);
    child.on("close", (c) => finish(c, "exited"));
    timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } finish(-9, "timed out after " + ms + "ms"); }, ms);
  });
}

const wingetTail = (s, n) => s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).slice(-(n || 3)).join(" | ");

async function wingetList(query) {
  const r = await runWinget(["list", "-q", query, "--disable-interactivity"], 120000);
  return r.out.split(/\r?\n/).map((l) => l.trim())
    .filter((l) => l && !/^-{3,}/.test(l) && !/^Name\s+Id\b/i.test(l) && !/^installed packages/i.test(l));
}

const ACTIONS = {
  open_app: async (p) => {
    const nm = String(p.name || "");
    if (nm.toLowerCase() === "browser") { shell.openExternal("https://www.google.com"); return "opened the browser"; }
    /* path is honoured for File Explorer: it opens the folder already navigated,
       which is far more reliable than driving the address bar with keystrokes. */
    const opts = p.path ? { path: String(p.path) } : undefined;
    const r = await automation.launchApp(nm, opts);
    if (!r.ok) throw new Error(r.note || ("could not open " + nm));
    return `opened ${nm}${r.title ? " — window \"" + r.title + "\"" : ""}`;
  },
  focus_app: async (p) => { const r = automation.focusApp(p.name); if (!r.focused) throw new Error(r.note || ("could not focus " + p.name)); return `focused ${r.title || p.name}`; },
  close_app: async (p) => { const r = automation.closeApp(p.name); if (!r.opened_by_zumi && r.note) return r.note; return `closed ${r.closed} of ${r.opened_by_zumi} ${p.name} window(s)` + (r.still_open.length ? " — " + r.still_open.length + " still open: " + r.still_open.join(", ") : ""); },
  open_url: async (p) => { const u = String(p.url || ""); if (!/^https?:\/\//i.test(u)) throw new Error("bad url"); shell.openExternal(u); return "opened " + u; },
  web_search: async (p) => { shell.openExternal("https://www.google.com/search?q=" + encodeURIComponent(p.query || "")); return "searched " + p.query; },
  youtube: async (p) => { shell.openExternal("https://www.youtube.com/results?search_query=" + encodeURIComponent(p.query || "")); return "youtube " + p.query; },

  /* Download a file straight to the user's Downloads folder (follows redirects,
     never overwrites an existing file, verifies the byte count on disk). */
  download: async (p) => {
    const url = String(p.url || "").trim();
    if (!/^https?:\/\//i.test(url)) throw new Error("only http and https urls are allowed");
    const dir = downloadsDir();
    let name = "";
    try { name = path.basename(new URL(url).pathname); } catch { /* ignore */ }
    if (p.filename) name = String(p.filename);
    name = name.replace(/[\\/:*?"<>|]+/g, "_").trim();
    if (!name || name === "." || name === "..") name = "download.bin";
    const dest = uniquePath(dir, name);
    appLog("download start: " + url);
    const res = await httpGet(url);
    const total = Number(res.headers["content-length"] || 0);
    if (total > DL_MAX) { res.resume(); throw new Error(`file too large: ${Math.round(total / 1048576)}MB (limit 512MB)`); }
    try {
      await new Promise((resolve, reject) => {
        const out = fs.createWriteStream(dest);
        let n = 0, last = Date.now(), failed = false;
        const fail = (e) => { if (failed) return; failed = true; res.destroy(); out.destroy(); reject(e); };
        res.on("data", (c) => {
          n += c.length;
          if (n > DL_MAX) return fail(new Error("file too large (limit 512MB)"));
          if (Date.now() - last > 3000) { last = Date.now(); appLog(`download ${name}: ${Math.round(n / 1024)}KB`); }
        });
        res.on("error", fail);
        out.on("error", fail);
        out.on("finish", () => { if (!failed) resolve(); });
        res.pipe(out);
      });
    } catch (e) {
      try { fs.rmSync(dest, { force: true }); } catch { /* ignore */ }   // Zumi's own partial file only
      appLog("download FAILED: " + (e && e.message));
      throw e;
    }
    const size = fs.statSync(dest).size;
    if (!size) throw new Error("download produced an empty file");
    appLog(`download ok: ${name} ${size}B`);
    return `downloaded ${name} -> ${dest} (${(size / 1024).toFixed(0)} KB)`;
  },

  /* Find an app by name or id and download its REAL installer via winget.
     No elevation needed; winget verifies the installer's hash for us.
     winget re-uses the same output path on a repeat run (it overwrites the identical,
     hash-checked file), so a folder diff alone would wrongly claim failure the second
     time. winget prints the final path — we verify THAT file on disk instead. */
  download_app: async (p) => {
    const q = String(p.app || p.query || p.name || p.id || "").trim();
    if (!q) throw new Error("no app name given");
    const dir = downloadsDir();
    const before = new Set(fs.readdirSync(dir));
    appLog("download_app start: " + q);
    const r = await runWinget(
      ["download", "-q", q, "-d", dir, "--accept-package-agreements",
        "--accept-source-agreements", "--disable-interactivity"], WINGET_TIMEOUT);

    const fresh = () => fs.readdirSync(dir).filter((f) => !before.has(f));
    let file = "", size = 0;
    const m = r.out.match(/Installer downloaded:\s*(.+)$/m);
    if (m) { try { size = fs.statSync(m[1].trim()).size; file = m[1].trim(); } catch { size = 0; } }
    if (!size) {
      const added = fresh().map((f) => ({ f: path.join(dir, f), s: fs.statSync(path.join(dir, f)).size }))
        .filter((x) => x.s > 0).sort((a, b) => b.s - a.s);
      if (!added.length) throw new Error(`winget could not download "${q}" (exit ${r.code}): ${wingetTail(r.out)}`);
      file = added[0].f; size = added[0].s;
    }
    const extra = fresh().filter((f) => path.join(dir, f) !== file).length;
    appLog(`download_app ok: ${q} -> ${path.basename(file)} ${size}B`);
    return `downloaded ${q}: ${path.basename(file)} (${(size / 1024).toFixed(0)} KB) into ${path.dirname(file)}` +
      (extra > 0 ? `, plus ${extra} manifest file(s)` : "");
  },

  /* Install a package. Planner must set requires_confirmation for this (security change).
     NOTE: winget exits NON-ZERO (-1978335189) when the package is merely already up to date,
     so the exit code is useless as a success signal. We ask winget what is installed
     afterwards instead — same reason downloads are verified by bytes on disk. */
  install_app: async (p) => {
    const q = String(p.app || p.query || p.name || p.id || "").trim();
    if (!q) throw new Error("no app name given");
    appLog("install_app start: " + q);
    const r = await runWinget(
      ["install", "-q", q, "--silent", "--accept-package-agreements",
        "--accept-source-agreements", "--disable-interactivity"], WINGET_TIMEOUT);
    const found = await wingetList(q);
    const installed = found.length > 0 && found.some((l) => l.toLowerCase().includes(q.toLowerCase()));
    if (!installed) throw new Error(`winget could not install "${q}" (exit ${r.code}): ${wingetTail(r.out, 4)}`);
    appLog(`install_app ok: ${q} -> ${found[0]}`);
    return `winget reports ${q} is installed: ${found.slice(0, 2).join(" ; ")}` +
      (r.code !== 0 ? ` (winget exit ${r.code} just means no upgrade was needed)` : "");
  },

  clipboard_set: async (p) => { clipboard.writeText(String(p.text || "")); return "copied " + String(p.text || "").slice(0, 40); },
  clipboard_get: async () => clipboard.readText().slice(0, 500),
  /* Read-only window listing. Lets the planner CONFIRM that a dialog it just opened
     really exists before typing a path into it — otherwise a save on an already-named
     document (no dialog) or a slow dialog silently swallows the typed path. */
  windows: async (p) => {
    const all = automation.windowList().filter((w) => w.title && !/^program manager$/i.test(w.title));
    const pat = p && (p.match || p.name) ? String(p.match || p.name) : "";
    let list = all;
    if (pat) { const re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i"); list = all.filter((w) => re.test(w.title) || re.test(w.name)); }
    if (!list.length) return "no window matches " + (pat || "(any)");
    return list.slice(0, 20).map((w) => w.name + ": " + w.title).join(" | ");
  },
  type_text: async (p) => { automation.typeText(p.text || ""); return "typed"; },
  key_press: async (p) => {
    const keys = String(p.keys || "ENTER");
    automation.keyPress(keys);
    /* A dialog-opening shortcut raises a NEW window, and it is not up yet when this
       returns. Without this beat, a type_text sent straight afterwards is typed into
       nowhere and silently lost — that is exactly what broke the Paint and VS Code
       save/open steps (the step reported "typed", but no dialog had appeared). */
    if (/^(CTRL\+S|CTRL\+O|CTRL\+L|CTRL\+P|CTRL\+SHIFT\+S|CTRL\+N|CTRL\+A|F5|ALT\+F4)$/i.test(keys.trim()))
      await sleep(900);
    return "pressed " + keys;
  },
  mouse_click: async (p) => { automation.mouseClick(Number(p.x) || 0, Number(p.y) || 0, p.button || "left"); return `clicked ${p.x},${p.y}`; },
  mouse_move: async (p) => { automation.mouseMove(Number(p.x) || 0, Number(p.y) || 0); return `moved ${p.x},${p.y}`; },
  screenshot: async () => { const sources = await desktopCapturer.getSources({ types: ["screen"], thumbnailSize: { width: 1600, height: 900 } }); if (!sources.length) throw new Error("no screen"); const f = path.join(app.getPath("pictures"), `zumi-${Date.now()}.png`); fs.writeFileSync(f, sources[0].thumbnail.toPNG()); return f; },
  /* Read the text currently showing on an app's window (or the whole desktop when no app
     is named). This is how Zumi CHECKS its own work instead of merely reporting that it
     pressed the keys: type 12*7= into Calculator, then read the display back and compare.
     The window is raised first because the capture reads screen pixels at that rectangle,
     so anything drawn on top would be read instead of the app. */
  read_screen: async (p) => {
    const name = p && (p.name || p.app) ? String(p.name || p.app) : "";
    const r = automation.readScreen(name || null);
    if (!r.text) return `nothing readable on ${name || "the screen"} (image kept at ${r.png})`;
    return ((name ? name + ": " : "") + r.text).slice(0, 1500);
  },
  file_list: async (p) => { const r = automation.listDir(p.path); return `${r.dir} (${r.count} items): ` + r.items.slice(0, 30).map((i) => i.name + (i.type === "dir" ? "/" : "")).join(", "); },
  file_mkdir: async (p) => "created " + automation.mkdir(p.path),
  file_move: async (p) => { const r = automation.moveFile(p.from, p.to); return `moved -> ${r.to}`; },
  file_copy: async (p) => { const r = automation.copyFile(p.from, p.to); return `copied -> ${r.to}`; },
  file_rename: async (p) => { const r = automation.renameFile(p.path, p.name); return `renamed -> ${r.to}`; },
  file_write: async (p) => "wrote " + automation.writeText(p.path, p.text || ""),
  file_trash: async (p) => { const r = await automation.trashFile(p.path, shell); return "trashed " + r.trashed; },
  note_add: async (p) => { brain.notesAdd(p.text || ""); return "note saved"; },
  remember: async (p) => { brain.memoryAdd(p.text || "", "task"); return "remembered"; },
  notify: async (p) => { try { new Notification({ title: p.title || "Zumi", body: p.body || "" }).show(); } catch { /* ignore */ } return "notified"; },
  weather: async (p) => { const c = String(p.city || "New Delhi"); const g = await (await fetch(`https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(c)}&count=1`)).json(); const pl = g.results && g.results[0]; if (!pl) throw new Error("city not found"); const w = await (await fetch(`https://api.open-meteo.com/v1/forecast?latitude=${pl.latitude}&longitude=${pl.longitude}&current=temperature_2m,weather_code`)).json(); return `${pl.name}: ${w.current.temperature_2m}°C`; },
  wait: async (p) => { await sleep(Math.min(60000, (Number(p.seconds) || 1) * 1000)); return "waited " + p.seconds + "s"; },
  speak: async (p) => { emit("task:speak", { text: p.text || "" }); return "spoke"; },
  gen_samples: async () => {
    const out = await new Promise((res) => execFile("node", [path.join(__dirname, "gen-samples.js")], { cwd: __dirname, timeout: 60000, windowsHide: true }, (e, so) => res((so || "").toString())));
    return (out.trim().split("\n")[0] || "samples written");
  },
  site_build: async (_p, ctx) => {
    const dir = path.join(WORKSPACE, "website");
    fs.mkdirSync(dir, { recursive: true });
    const think = (msg) => emit("task:thinking", { text: "🤔 Thinking: " + msg, task: (ctx && ctx.task && ctx.task.task_id) || "" });
    const sys = "Write a COMPLETE, polished, self-contained SINGLE-FILE HTML website ABOUT ZUMI (a desktop buddy + autonomous PC agent). ALL TEXT MUST BE IN ENGLISH.\n\n" +
      "STRICT RULES:\n" +
      "- Output ONLY the HTML document, starting with <!doctype html> and ending with </html>. No markdown fences, no explanation.\n" +
      "- Everything inline: CSS inside <style>, JS inside <script>. No external files, no CDNs, no remote images.\n" +
      "- DO NOT USE ANY EMOJI CHARACTERS ANYWHERE. Build every icon using inline SVG or pure CSS shapes (circles, borders, gradients). This is mandatory.\n" +
      "- SIZE BUDGET (critical): you have a HARD limit of ~6500 tokens. Keep CSS compact (short class names, under ~5000 characters), 1-3 sentences of prose per section, and ALWAYS finish with </html>. If you get cut off you FAIL the self-check. A short complete page beats a long truncated one.\n" +
      "- NAVIGATION IDS (exact, non-negotiable): the header nav links MUST be href=\"#about\", \"#features\", \"#how\", \"#tools\", \"#commands\", \"#languages\", \"#privacy\", \"#safety\", \"#faq\", \"#setup\" and each of those ids MUST exist on its own <section> element (e.g. <section id=\"about\">). Any nav link whose target id is missing is a failure.\n" +
      "- Premium dark theme with mint (#5ad6b0) and amber (#facc15) accents, strong typography, generous spacing, subtle borders, hover/focus states.\n\n" +
      "DETAILED SECTIONS (write real, thorough detail — not placeholders):\n" +
      "1. Sticky header: CSS/SVG logo, nav links, language switcher (English + Hindi), theme toggle, mobile menu button.\n" +
      "2. Hero: animated inline-SVG CSS mascot (no emoji), headline, subtitle, primary + secondary buttons.\n" +
      "3. About: what Zumi is, and WHO BUILT IT (Built by Arpit Singh. MIT License, 2026).\n" +
      "4. Features (DETAILED list): describe EVERYTHING Zumi can do — voice control, local memory + self-learning, autonomous task agent (plan/execute/verify/report), file operations (list/move/copy/rename/write), opening apps, web search, YouTube, screenshots, clipboard, notes, to-do tasks, reminders, weather, system stats, unit conversion, moods, batch engine (1000+ tasks), coding batch (write + run code), scheduled tasks.\n" +
      "5. How it works: Think -> Plan -> Execute -> Verify -> Report, with a short paragraph on each.\n" +
      "6. Agent tools: MUST include a section with the heading 'Agent Tools' listing these exact tool names, each with a one-line description: open_app, open_url, web_search, youtube, file_list, file_mkdir, file_move, file_copy, file_rename, file_write, type_text, key_press, mouse_click, screenshot, clipboard_get, clipboard_set, note_add, remember, notify, weather, system_snapshot, large_files, dup_scan, gen_samples, site_build, site_serve.\n" +
      "7. Commands reference: MUST include a section with the heading 'Commands' listing these exact strings with a short description each: /status, /tasks, /running, /report, /cancel, /retry, /schedule, /schedules, /build website, /samples, /serve, /log, /clear.\n" +
      "8. Languages: a grid of many programming languages.\n" +
      "9. Privacy Policy: EXACTLY what data Zumi stores and WHERE — locally on the user's PC only (settings, memory/facts, chat history, notes, tasks, reminders in the app data folder), and that only chat messages are sent to the configured AI provider (DeepSeek). Nothing else leaves the machine.\n" +
      "10. Safety & Security: confirmation required before destructive actions, nothing deleted without consent, authorized-use only, read-only analysis.\n" +
      "11. FAQ: an accordion with 5-6 questions and answers.\n" +
      "12. Setup: install commands in a code block.\n" +
      "13. Footer: credits (Arpit Singh) and license (MIT).\n\n" +
      "INTERACTIVITY — EVERY button/option MUST work, no dead buttons, no console errors:\n" +
      "- smooth-scroll anchor navigation from the header;\n" +
      "- responsive mobile hamburger menu that toggles open/closed;\n" +
      "- language switcher (English + Hindi) that translates visible text via data-i18n + an inline JS dictionary;\n" +
      "- theme toggle (dark/light) persisted in localStorage;\n" +
      "- REQUIRED: a button with id=\"sayHi\" labelled 'Say hi'. Its click handler MUST call speechSynthesis.speak(new SpeechSynthesisUtterance('Hi, I am Zumi!')) and also print the greeting text on the page. Do NOT omit this;\n" +
      "- copy-to-clipboard buttons on every code block with 'Copied!' feedback;\n" +
      "- a tabs OR accordion component (commands / FAQ) that switches correctly;\n" +
      "- back-to-top button that appears after scrolling; focus-visible outlines; semantic HTML.\n\n" +
      "Reply with ONLY the HTML document.";
    const clean = (t) => {
      let s = String(t || "").trim();
      const a = s.indexOf("<!doctype"); if (a > 0) s = s.slice(a);
      const b = s.lastIndexOf("</html>"); if (b !== -1) s = s.slice(0, b + 7);
      if (!/^<!doctype html/i.test(s)) return "";
      // a top-level "const top" (etc.) makes the browser throw and kills every button — isolate it
      s = hardenScripts(s);
      // Zumi uses CSS/SVG icons, not emoji — strip any emoji the model still emitted
      return s.replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0F}\u{1F1E6}-\u{1F1FF}]/gu, "");
    };
    // THINKING MODE: build -> audit -> fix -> re-audit, until the audit is clean
    const MAX_ITER = 4;
    let out = ""; let issues = ["the model returned no usable HTML"]; let iter = 0;
    think("planning the structure of my own website...");
    for (iter = 1; iter <= MAX_ITER; iter++) {
      think(iter === 1 ? "writing draft 1/" + MAX_ITER + " of my website..." : "fixing " + issues.length + " problem(s) — " + issues[0]);
      const user = iter === 1
        ? "Build your own website now. Keep it SHORT and COMPLETE (under 12000 characters) — every required section present, ending with </html>."
        : (iter >= MAX_ITER ? "FINAL ATTEMPT — write a SHORT but COMPLETE page (under 12000 characters) containing every required section, and it MUST end with </html>. " : "") +
          "Your previous attempt FAILED the self-check. Problems found:\n- " + issues.join("\n- ") +
          "\n\nReturn the COMPLETE corrected HTML document — every problem above MUST be fixed. Reply with ONLY the HTML.";
      const raw = await callLLM([{ role: "system", content: sys }, { role: "user", content: user }], 8000);
      const truncated = !/<\/html>/i.test(String(raw || ""));
      let draft = clean(raw);
      if (draft) draft = repairHtml(draft);
      if (draft) { out = draft; issues = verifySite(out).issues; } else { issues = ["the model returned no usable HTML"]; }
      if (truncated) issues.unshift("your previous reply was CUT OFF before </html> — it was too long. Write a SHORTER page (compact CSS, brief copy) that ALWAYS ends with </html>.");
      if (!issues.length) { think("self-check passed on attempt " + iter + "/" + MAX_ITER + " — every button and link works."); break; }
      if (iter === MAX_ITER) think("still " + issues.length + " issue(s) after " + MAX_ITER + " attempts — applying my safety patches.");
    }
    // self-fix: guarantee copy buttons on code blocks
    if (!/clipboard/i.test(out) && !/execCommand\(.copy/i.test(out)) {
      const copyScript = '\n<script>(function(){document.querySelectorAll("pre").forEach(function(pre){if(pre.querySelector(".copybtn"))return;var b=document.createElement("button");b.textContent="Copy";b.className="copybtn";b.style.cssText="position:absolute;top:8px;right:8px;padding:4px 10px;border-radius:8px;border:1px solid #2c3743;background:#0a0f13;color:#5ad6b0;cursor:pointer;font:11px monospace";if(getComputedStyle(pre).position==="static"){pre.style.position="relative";}pre.appendChild(b);b.addEventListener("click",function(){var t=pre.innerText.replace("Copy","").trim();try{navigator.clipboard.writeText(t);}catch(e){}b.textContent="Copied!";setTimeout(function(){b.textContent="Copy";},1200);});});})();</script>\n';
      out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, copyScript + "</body>") : out + copyScript;
    }
    // self-fix: guarantee required interactive features Zumi's LLM may have missed
    if (!/speechSynthesis/.test(out)) {
      const patch = '\n<button id="sayHi" style="position:fixed;left:16px;bottom:16px;z-index:9999;padding:10px 14px;border-radius:12px;border:0;background:#5ad6b0;color:#052019;font-weight:700;cursor:pointer">Say hi 👋</button>\n' +
        '<script>document.getElementById("sayHi").addEventListener("click",function(){try{var u=new SpeechSynthesisUtterance("Hi! I am Zumi, your desktop buddy and PC agent.");speechSynthesis.speak(u);}catch(e){}});</script>\n';
      out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, patch + "</body>") : out + patch;
    }
    // self-fix: guarantee a "Commands" reference section
    if (!/\/status/.test(out)) {
      const rows = [["/status", "show task summary"], ["/tasks", "list tasks"], ["/running", "show running tasks"], ["/report", "daily report"], ["/cancel <id>", "cancel a task"], ["/retry <id>", "retry a task"], ["/schedule <task> every 30 min", "schedule a task"], ["/schedules", "list schedules"], ["/build website", "Zumi rebuilds and serves its website"], ["/samples", "write code samples in many languages"], ["/serve", "serve the website"], ["/log", "task log"], ["/clear", "clear tasks"]];
      const table = rows.map(function (r) { return '<tr><td style="padding:8px;border-bottom:1px solid #22303a;color:#5ad6b0;font-family:monospace">' + r[0] + '</td><td style="padding:8px;border-bottom:1px solid #22303a;color:#cdddd9">' + r[1] + '</td></tr>'; }).join("");
      const sec = '\n<section id="commands" style="max-width:1120px;margin:0 auto;padding:56px 22px"><h2 style="font-size:30px;margin:0 0 16px">Commands</h2><p style="color:#8aa0ac">Type these in the Zumi chat, or just say them.</p><table style="width:100%;border-collapse:collapse;font-size:13.5px"><tbody>' + table + '</tbody></table></section>\n';
      out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, sec + "</body>") : out + sec;
    }
    // self-fix: guarantee an "Agent Tools" section
    if (!/open_app/.test(out)) {
      const tools = [["open_app", "open an application, or an Explorer folder when path is given"], ["close_app", "close an application Zumi opened"], ["focus_app", "bring an application's window to the front before typing"], ["windows", "list open window titles, to confirm a dialog appeared before typing into it"], ["open_url", "open a URL"], ["web_search", "Google search"], ["youtube", "YouTube search"], ["download", "download a file from a URL into the Downloads folder"], ["download_app", "download an app's installer via winget"], ["install_app", "download and install an app via winget (needs confirmation)"], ["file_list", "list a folder"], ["file_mkdir", "create a folder"], ["file_move", "move a file"], ["file_copy", "copy a file"], ["file_rename", "rename a file"], ["file_write", "write a text file"], ["type_text", "type into the focused window"], ["key_press", "press keys (e.g. CTRL+S)"], ["mouse_click", "click at screen coordinates"], ["screenshot", "capture the screen"], ["read_screen", "read text off an app's window to verify a result"], ["clipboard_get", "read the clipboard"], ["clipboard_set", "write the clipboard"], ["note_add", "save a note"], ["remember", "remember a fact"], ["notify", "show a system notification"], ["weather", "current weather"], ["system_snapshot", "CPU / RAM / uptime"], ["large_files", "find big files"], ["dup_scan", "find duplicate files (read-only)"], ["gen_samples", "code samples in many languages"], ["site_build", "write this website"], ["site_serve", "serve the website"]];
      const items = tools.map(function (t) { return '<li style="border:1px solid #22303a;border-radius:12px;padding:10px 12px;background:#111c26"><b style="color:#5ad6b0;font-family:monospace">' + t[0] + '</b><br><span style="color:#8aa0ac;font-size:13px">' + t[1] + '</span></li>'; }).join("");
      const sec = '\n<section id="tools" style="max-width:1120px;margin:0 auto;padding:56px 22px"><h2 style="font-size:30px;margin:0 0 16px">Agent Tools</h2><ul style="list-style:none;padding:0;display:grid;grid-template-columns:repeat(2,1fr);gap:10px">' + items + '</ul></section>\n';
      out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, sec + "</body>") : out + sec;
    }
    if (!out) out = '<!doctype html><html><head><meta charset="utf-8"><title>Zumi</title></head><body><h1>Zumi</h1><p>Desktop buddy &amp; autonomous PC agent.</p></body></html>';
    out = repairHtml(hardenScripts(out));
    const pre = verifySite(out);
    // runtime repair layer — repairs anchors and wires any dead button in the live page
    if (!/zumi-repair/.test(out)) out = /<\/body>/i.test(out) ? out.replace(/<\/body>/i, REPAIR_SCRIPT + "\n</body>") : out + REPAIR_SCRIPT;
    const file = path.join(dir, "index.html");
    fs.writeFileSync(file, out);
    think(pre.ok
      ? "self-check: every nav link and button verified working after " + iter + " attempt(s)."
      : "self-check: " + pre.issues.length + " note(s) — the auto-repair layer is handling them.");
    return `website written: ${file} (${out.length} bytes) · self-check: ` +
      (pre.ok ? "ALL CHECKS PASSED" : pre.issues.length + " note(s) covered by auto-repair") +
      ` · attempts: ${iter}` + (pre.issues.length ? " · " + pre.issues.slice(0, 3).join(" | ") : "");
  },
  site_verify: async () => {
    const file = path.join(WORKSPACE, "website", "index.html");
    if (!fs.existsSync(file)) return "no website yet — run site_build first";
    const v = verifySite(fs.readFileSync(file, "utf8"));
    return v.ok ? `website OK — ${v.bytes} bytes, ${v.ids} ids, ${v.scripts} script block(s), 0 problems`
      : `${v.issues.length} problem(s): ` + v.issues.join(" | ");
  },
  site_serve: async (p) => {
    // never serve anything that is not a folder containing index.html (defaults to Zumi's website)
    let dir = path.join(WORKSPACE, "website");
    if (p.dir) {
      try {
        const d = automation.resolve(p.dir);
        if (d && fs.existsSync(d) && fs.statSync(d).isDirectory() && fs.existsSync(path.join(d, "index.html"))) dir = d;
      } catch { /* ignore */ }
    }
    const port = Number(p.port) || 8080;
    try { spawnSafe("node", [path.join(__dirname, "site", "server.js"), String(port), dir], { detached: true, stdio: "ignore", windowsHide: true }); } catch { /* ignore */ }
    shell.openExternal("http://localhost:" + port + "/");
    return "serving " + dir + " at http://localhost:" + port;
  },
};
const RISKY = new Set(["file_trash"]);

const ACTIONS_DOC = `open_app(name,path?) — name one of: notepad|calculator|explorer|paint|vscode|cmd|settings|browser
                  For File Explorer pass path as a folder (e.g. "C:\\Windows") and it opens already
                  navigated. For VS Code pass path as a file and it opens that file directly.
                  PREFER path over typing: Explorer's CTRL+L / ALT+D and VS Code's CTRL+O do not
                  take effect when sent as keystrokes, so the typed path lands in the file list
                  or nowhere instead of opening what you asked for.
close_app(name) — closes only the window Zumi opened itself; it will NOT close windows you already had open
focus_app(name) — brings that app's window to the front. ALWAYS call this before type_text / key_press,
                  otherwise SendKeys types into whatever window happens to be in front
windows(match?) — read-only list of open window titles (optionally filtered, e.g. windows("save as")).
                  Use it to CONFIRM a dialog actually appeared before you type a path into it
open_url(url)
web_search(query)
youtube(query)
download(url,filename?) — downloads a file from a URL into the Downloads folder; follows redirects,
                  never overwrites an existing file, and reports the real byte count. Use for any direct file link.
download_app(app) — finds an app by name or id (e.g. "7-Zip" or "7zip.7zip") and downloads its real
                  installer into the Downloads folder through winget, with hash verification. No admin rights needed.
install_app(app) — downloads AND installs an app with winget. This changes the machine, so ALWAYS set
                  "requires_confirmation": true when you use it. Never call it for uninstalling or removing things.
clipboard_set(text)
clipboard_get()
type_text(text) — types into the currently focused window
key_press(keys) — e.g. "ENTER", "TAB", "CTRL+S", "ALT+F4"
mouse_click(x,y,button) — button: left|right
mouse_move(x,y)
screenshot() — saves a PNG and returns its path
read_screen(name?) — reads the text currently showing, using the OCR engine built into Windows (no
                  install needed). With a name (e.g. read_screen("calculator")) it raises that app and
                  reads its window; with no name it reads the whole desktop. USE THIS TO VERIFY RESULTS
                  instead of assuming: after typing 12*7= into Calculator, read_screen("calculator")
                  tells you what the display really shows.
file_list(path)
file_mkdir(path)
file_move(from,to)
file_copy(from,to)
file_rename(path,name)
file_write(path,text)
file_trash(path) — moves to Recycle Bin (destructive)
note_add(text)
remember(text)
notify(title,body)
weather(city)
wait(seconds) — ALWAYS use wait(1) or wait(2) after a step that opens a dialog or changes a window
              (CTRL+S, CTRL+O, CTRL+L, ENTER in a file list) and BEFORE typing into it.
              The dialog takes a moment to appear; keystrokes sent too early are silently lost.
              Then call windows("save as") or windows("open") to CONFIRM the dialog really appeared.
              If no dialog appeared, the document already had a name and was saved instantly —
              do NOT type a path: it would be typed straight into the document itself.
speak(text)
gen_samples() — write small "hello" programs in ~50 programming languages to the samples folder
site_build() — Zumi writes a full website ABOUT ITSELF (single-file HTML), then audits it and keeps fixing it until every button and link passes
site_verify() — audit the current website (broken links, dead buttons, JS errors) and report problems
site_serve(port,dir) — serve the website folder on localhost and open it in the browser`;

async function planTask(instruction) {
  emit("task:thinking", { text: "🤔 Thinking: breaking \"" + String(instruction).slice(0, 60) + "\" into safe steps..." });
  const sys = `You are Zumi's task planner for a Windows PC. Convert the user's instruction into a SHORT executable plan.
Use ONLY these actions:
${ACTIONS_DOC}

Rules:
- Use small, safe, reversible steps. Prefer file_list first to inspect before acting.
- NEVER delete unless the user explicitly asks to delete; if so use file_trash and set "requires_confirmation": true.
- Set "requires_confirmation": true for anything destructive, financial, sending messages externally, security changes, or installing software (install_app).
- Never use install_app to remove, uninstall or delete anything. download and download_app are safe and need no confirmation.
- Keep it minimal (usually 1-8 steps). Use ${"~"} or %USERPROFILE% for the home folder if needed.
Reply with ONLY JSON: {"title":"...","priority":"P1|P2|P3","requires_confirmation":false,"steps":[{"action":"...","params":{...},"note":"..."}]}`;
  const out = await callLLM([{ role: "system", content: sys }, { role: "user", content: instruction }]);
  const s = out.indexOf("{"); const e = out.lastIndexOf("}");
  if (s === -1 || e === -1) throw new Error("planner returned no plan");
  const plan = JSON.parse(out.slice(s, e + 1));
  if (!Array.isArray(plan.steps) || !plan.steps.length) throw new Error("empty plan");
  return plan;
}

const runningTasks = new Map();

async function runTask(id, { confirmed = false } = {}) {
  const t = tasks.get(id);
  if (!t) throw new Error("no such task: " + id);
  tasks.update(id, { status: "running", started_at: t.started_at || Date.now(), error: "" });
  runningTasks.set(id, true);
  emit("task:update", { task_id: id, status: "running", title: t.title });
  const needsConfirm = confirmed || !t.requires_confirmation;
  if (!needsConfirm) { tasks.update(id, { status: "waiting", error: "Confirmation required before running." }); emit("task:update", { task_id: id, status: "waiting", title: t.title }); runningTasks.delete(id); return t; }

  for (let i = 0; i < t.steps.length; i++) {
    if (!runningTasks.has(id)) { tasks.update(id, { status: "cancelled", completed_at: Date.now() }); emit("task:update", { task_id: id, status: "cancelled" }); return tasks.get(id); }
    const step = t.steps[i];
    const fn = ACTIONS[step.action];
    if (!fn) { tasks.update(id, { status: "blocked", completed_at: Date.now(), error: "unknown action: " + step.action }); emit("task:update", { task_id: id, status: "blocked", error: "unknown action: " + step.action }); runningTasks.delete(id); return tasks.get(id); }
    let ok = false; let lastErr = "";
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        const r = await fn(step.params || {}, { task: t });
        t.steps[i].result = String(r).slice(0, 400);
        tasks.update(id, { steps: t.steps });
        if (step.action === "screenshot" && r) { t.artifacts = [...(t.artifacts || []), r]; tasks.update(id, { artifacts: t.artifacts }); }
        ok = true;
      } catch (e) { lastErr = (e && e.message) || String(e); if (attempt < 2) await sleep(700 * (attempt + 1)); }
    }
    if (!ok) {
      tasks.update(id, { status: "failed", completed_at: Date.now(), error: `step ${i + 1}/${t.steps.length} (${step.action}) failed: ${lastErr}`, retries: (t.retries || 0) + 1 });
      brain.memoryAdd("Task failure: " + t.title + " — " + step.action + " — " + lastErr, "learn");
      emit("task:update", { task_id: id, status: "failed", error: lastErr, step: i + 1 });
      runningTasks.delete(id);
      return tasks.get(id);
    }
    emit("task:update", { task_id: id, status: "running", step: i + 1, total: t.steps.length, action: step.action });
  }
  tasks.update(id, { status: "completed", completed_at: Date.now(), result: `${t.steps.length} step(s) done` });
  emit("task:update", { task_id: id, status: "completed", title: t.title });
  runningTasks.delete(id);
  return tasks.get(id);
}

ipcMain.handle("task:plan", async (_e, instruction) => {
  const plan = await planTask(instruction);
  const t = tasks.create({ title: plan.title || instruction, priority: plan.priority || "P2", steps: plan.steps, requiresConfirmation: !!plan.requires_confirmation || plan.steps.some((s) => RISKY.has(s.action)) });
  tasks.log("planned " + t.task_id + ": " + t.title);
  return t;
});
ipcMain.handle("task:list", () => tasks.all().tasks.slice(-100).reverse());
ipcMain.handle("task:stats", () => tasks.stats());
ipcMain.handle("task:report", () => tasks.report());
ipcMain.handle("task:run", async (_e, { id, confirmed }) => await runTask(id, { confirmed: !!confirmed }));
ipcMain.handle("task:cancel", (_e, id) => { runningTasks.delete(id); tasks.update(id, { status: "cancelled", completed_at: Date.now() }); return tasks.get(id); });
ipcMain.handle("task:clear", () => { tasks.clear(); return true; });
ipcMain.handle("task:log", (_e, limit) => tasks.logList(limit || 50));
ipcMain.handle("automation:ocr-available", () => automation.ocrAvailable());

/* ---- simple scheduler: interval ("every 30 min") or daily ("08:00") ---- */
function parseSchedule(text) {
  const s = String(text || "").toLowerCase();
  let m = s.match(/every\s+(\d+)\s*(min|minute|minutes|m)\b/);
  if (m) return { type: "interval", ms: parseInt(m[1], 10) * 60000 };
  m = s.match(/every\s+(\d+)\s*(h|hour|hours)\b/);
  if (m) return { type: "interval", ms: parseInt(m[1], 10) * 3600000 };
  m = s.match(/(\d{1,2}):(\d{2})/);
  if (m) return { type: "daily", hh: parseInt(m[1], 10), mm: parseInt(m[2], 10) };
  return null;
}
function nextRun(spec, from) {
  const now = from || Date.now();
  if (spec.type === "interval") return now + spec.ms;
  const d = new Date(now); d.setHours(spec.hh, spec.mm, 0, 0);
  if (d.getTime() <= now) d.setDate(d.getDate() + 1);
  return d.getTime();
}
function startTaskLoop() {
  setInterval(async () => {
    try {
      const due = tasks.scheduleDue(Date.now());
      for (const s of due) {
        const spec = parseSchedule(s.schedule);
        tasks.scheduleSetNext(s.schedule_id, spec ? nextRun(spec) : Date.now() + 3600000);
        try { const t = tasks.create({ title: "Scheduled: " + s.task, priority: "P2", steps: [], mode: "scheduled" }); emit("task:schedule-fire", { schedule: s, task: t.task_id }); }
        catch { /* ignore */ }
      }
    } catch { /* ignore */ }
  }, 30000);
}
ipcMain.handle("sched:add", (_e, { task, schedule }) => { const spec = parseSchedule(schedule); const s = tasks.scheduleAdd({ task, schedule }); if (spec) tasks.scheduleSetNext(s.schedule_id, nextRun(spec)); return tasks.scheduleList(); });
ipcMain.handle("sched:list", () => tasks.scheduleList());
ipcMain.handle("sched:remove", (_e, id) => tasks.scheduleRemove(id));

/* ------------------------------ batch engine (1000 safe tasks) ------------------------------ */
const WORKSPACE = path.join(os.homedir(), "ZumiWorkspace");
// execution trace: if a task ever hangs we can read the last line to see exactly which one.
const BATCH_TRACE = path.join(app.getPath("userData"), "batch-trace.log");
/* The trace used to appendFileSync on the main thread for EVERY task (4 lines per task in a
   5000-task run = 20 000 blocking disk writes). It is now buffered and flushed with one async
   append every 250 ms — same content, zero main-thread stalls. */
let traceBuf = "";
let traceTimer = null;
let traceWriting = false;
function traceFlush() {
  if (traceTimer) { clearTimeout(traceTimer); traceTimer = null; }
  if (!traceBuf || traceWriting) return;
  const chunk = traceBuf; traceBuf = "";
  traceWriting = true;
  fs.appendFile(BATCH_TRACE, chunk, () => { traceWriting = false; if (traceBuf) traceFlush(); });
}
function trace(msg) {
  traceBuf += logStamp() + "  " + msg + "\n";
  if (traceBuf.length > 65536) { traceFlush(); return; }   // hard cap: never let the buffer grow unbounded
  if (!traceTimer) traceTimer = setTimeout(traceFlush, 250);
}
process.on("exit", () => { if (traceBuf) { try { fs.appendFileSync(BATCH_TRACE, traceBuf); } catch { /* ignore */ } } });
function hashFile(p) { return crypto.createHash("md5").update(fs.readFileSync(p)).digest("hex"); }
function walkFiles(dir, limit, out) {
  let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of ents) {
    if (out.length >= limit) return;
    const p = path.join(dir, e.name);
    try { if (e.isDirectory()) walkFiles(p, limit, out); else out.push(p); } catch { /* ignore */ }
  }
}
/* Async, yielding walk — same result as walkFiles but it never blocks the main thread. */
async function walkFilesAsync(dir, limit, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (out.length >= limit) return out;
  let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { return out; }
  let tick = 0;
  for (const e of ents) {
    if (out.length >= limit) break;
    const p = path.join(dir, e.name);
    try {
      if (e.isDirectory()) { if (depth < 12) await walkFilesAsync(p, limit, out, depth + 1); }
      else out.push(p);
    } catch { /* ignore */ }
    if (++tick % 150 === 0) await sleep(0);
  }
  return out;
}
ACTIONS.system_snapshot = async () => { const tot = os.totalmem(), free = os.freemem(); return `CPU ${os.cpus().length} cores · RAM ${Math.round((1 - free / tot) * 100)}% · uptime ${Math.round(os.uptime() / 60)} min · ${os.hostname()}`; };
// cheap, purely local, never touches the clipboard or the disk — safe filler work for big batches
ACTIONS.math_check = async (p) => {
  const n = Math.max(2, Math.min(4000, Number(p.n) || 40));
  let primes = 0, sum = 0;
  for (let v = 2; v <= n; v++) { sum += v; let ok = true; for (let d = 2; d * d <= v; d++) if (v % d === 0) { ok = false; break; } if (ok) primes++; }
  return `verified n=${n} · primes=${primes} · sum=${(n * (n + 1)) / 2}`;
};
ACTIONS.large_files = async (p) => {
  const files = await walkFilesAsync(automation.resolve(p.path || "~"), 900);
  const min = (Number(p.minMB) || 50) * 1048576; const big = [];
  let i = 0;
  for (const f of files) {
    try { const s = fs.statSync(f).size; if (s > min) big.push(path.basename(f) + " (" + Math.round(s / 1048576) + "MB)"); } catch { /* ignore */ }
    if (++i % 100 === 0) await sleep(0);   // keep the window responsive while scanning
  }
  return big.length ? `${big.length} files >${p.minMB || 50}MB: ` + big.slice(0, 20).join(", ") : `no files over ${p.minMB || 50}MB`;
};
ACTIONS.dup_scan = async (p) => {
  const files = await walkFilesAsync(automation.resolve(p.path || "~"), 500);
  const map = {}; let dups = 0; let i = 0;
  for (const f of files) {
    try { const h = hashFile(f); (map[h] = map[h] || []).push(f); } catch { /* ignore */ }
    if (++i % 40 === 0) await sleep(0);    // hashing is CPU work — hand the loop back regularly
  }
  for (const k in map) if (map[k].length > 1) dups += map[k].length - 1;
  return `scanned ${files.length} files · ${dups} duplicate copies found (nothing deleted)`;
};

function snippet(i) {
  const k = i % 5;
  if (k === 0) return { ext: "py", code: `# fib — snapshot #${i}\ndef fib(n):\n    a, b = 0, 1\n    for _ in range(n):\n        a, b = b, a + b\n    return a\n\nprint(fib(${(i % 20) + 5}))\n` };
  if (k === 1) return { ext: "js", code: `// sum 1..${(i % 50) + 1}\nlet s = 0;\nfor (let i = 1; i <= ${(i % 50) + 1}; i++) s += i;\nconsole.log(s);\n` };
  if (k === 2) return { ext: "py", code: `# palindrome check\nword = "malayalam"\nprint(word == word[::-1])\n` };
  if (k === 3) return { ext: "js", code: `// FizzBuzz to ${(i % 30) + 10}\nfor (let i = 1; i <= ${(i % 30) + 10}; i++)\n  console.log(i % 15 ? (i % 5 ? (i % 3 ? i : 'Fizz') : 'Buzz') : 'FizzBuzz');\n` };
  return { ext: "txt", code: `Zumi workspace note #${i}\nAuto-generated by Zumi PC Buddy — safe, nothing deleted.\n` };
}

function buildManifest(count) {
  const list = []; const seen = new Set();
  const add = (title, action, params, priority) => { const key = action + "|" + title + "|" + JSON.stringify(params); if (seen.has(key) || list.length >= count) return; seen.add(key); list.push({ title, action, params, priority: priority || "P3" }); };

  // 1) folder inventory (read-only) — scan common folders, bounded
  const folders = [];
  const cap = Math.floor(count * 0.6);
  const roots = ["Desktop", "Documents", "Downloads", "Pictures", "Music", "Videos"]
    .map((d) => automation.knownFolder(d) || path.join(os.homedir(), d))
  let visited = 0;
  const MAX_VISIT = 4000;
  function walk(dir, depth) {
    if (folders.length >= cap || visited > MAX_VISIT) return;
    let ents; try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      visited++;
      if (folders.length >= cap || visited > MAX_VISIT) break;
      if (!e.isDirectory()) continue;
      const n = e.name;
      if (n.startsWith(".") || ["node_modules", "AppData", "$Recycle.Bin", "Windows", "ProgramData", "System Volume Information", "venv"].includes(n)) continue;
      folders.push(path.join(dir, n));
      if (depth < 2) walk(path.join(dir, n), depth + 1);
    }
  }
  // yield to the event loop between roots so building a 5000-task manifest never freezes the window
  return (async () => {
    for (const r of roots) { try { if (fs.existsSync(r)) walk(r, 0); } catch { /* ignore */ } await sleep(0); }
  for (const f of folders) add("Inspect folder: " + path.basename(f), "file_list", { path: f });

  // 2) system checks
  for (let i = 0; i < 50; i++) add("System check " + (i + 1), "system_snapshot", {});

  // 3) large-file scans
  for (const d of ["Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music"]) add("Large files in " + d, "large_files", { path: "~/" + d, minMB: 50 });

  // 4) duplicate scans (read-only, nothing deleted)
  for (const d of ["Downloads", "Documents", "Desktop", "Pictures"]) add("Duplicate scan: " + d, "dup_scan", { path: "~/" + d });

  // 5) write code + notes into ZumiWorkspace (new files only — nothing deleted)
  const snippetCap = Math.min(1200, Math.floor(count * 0.25));
  for (let i = 1; i <= snippetCap && list.length < count; i++) {
    const s = snippet(i);
    add("Write code snippet #" + i, "file_write", { path: path.join(WORKSPACE, "snippets", String(i).padStart(4, "0") + "-zumi." + s.ext), text: s.code });
  }
  // 5b) notes + memory (local brain, appended — never deletes)
  for (let i = 1; i <= Math.min(300, Math.floor(count * 0.08)) && list.length < count; i++) add("Save note #" + i, "note_add", { text: "Zumi batch note #" + i + " — safe, local, nothing deleted." });
  for (let i = 1; i <= Math.min(200, Math.floor(count * 0.05)) && list.length < count; i++) add("Remember fact #" + i, "remember", { text: "Batch memory #" + i + ": files were inventoried, nothing was removed." });
  // 5c) clipboard reads (read-only) — kept tiny: clipboard.readText() is synchronous and can
  //     block the main thread if another app holds the clipboard, so never pad with it.
  for (let i = 1; i <= 5 && list.length < count; i++) add("Clipboard read #" + i, "clipboard_get", {});
  // 6) a few apps / web (kept minimal — no spam)
  add("Open YouTube music", "open_url", { url: "https://music.youtube.com/" }, "P2");
  add("Search a lofi playlist", "youtube", { query: "lofi study music" }, "P2");
  add("Open VS Code", "open_app", { name: "vscode" }, "P2");
  add("Open Notepad", "open_app", { name: "notepad" }, "P2");
  add("Open Explorer at ZumiWorkspace", "open_app", { name: "explorer" }, "P2");

  // pad with safe, non-blocking local work if still short (guarded, never deletes anything)
  let i = 100; let guard = 0;
  while (list.length < count && guard++ < count * 2 + 500) {
    if (i % 4 === 0) add("Math check " + i, "math_check", { n: (i % 89) + 3 });
    else add("System check " + i, "system_snapshot", {});
    i++;
  }
  return list.slice(0, count);
  })();
}

let batchState = { running: false, done: 0, failed: 0, blocked: 0, total: 0, startedAt: 0, finishedAt: 0, report: "" };

// Dev self-test: run a batch straight from the main process (no CDP, no renderer) so we can
// tell whether a freeze is caused by the batch itself or by the debug tooling. Opt-in only.
function startSelfTest() {
  const mode = String(process.env.ZUMI_SELFTEST || "");
  if (!mode) return;
  const n = Math.max(1, Math.min(5000, Number(process.env.ZUMI_SELFTEST_N || 500)));
  trace("SELFTEST scheduled mode=" + mode + " n=" + n);
  const hb = setInterval(() => trace("HEARTBEAT alive"), 1000);
  setTimeout(() => clearInterval(hb), 120000);
  setTimeout(async () => {
    try {
      trace("SELFTEST begin mode=" + mode);
      if (mode === "manifest") {
        const manifest = await buildManifest(n);
        const created = manifest.map((m) => tasks.create({ title: m.title, priority: m.priority, steps: [{ action: m.action, params: m.params }], mode: "batch" }));
        trace("SELFTEST manifest ok count=" + created.length);
        return;
      }
      let plan = [];
      if (mode === "snap") for (let i = 0; i < n; i++) plan.push({ title: "Snap " + i, action: "system_snapshot", params: {} });
      else if (mode === "list") for (let i = 0; i < n; i++) plan.push({ title: "List " + i, action: "file_list", params: { path: path.join(os.homedir(), "Documents") } });
      else if (mode === "write") for (let i = 1; i <= n; i++) { const s = snippet(i); plan.push({ title: "Write " + i, action: "file_write", params: { path: path.join(WORKSPACE, "selftest", i + "-st." + s.ext), text: s.code } }); }
      else if (mode === "brain") { for (let i = 1; i <= n; i++) plan.push({ title: "Note " + i, action: "note_add", params: { text: "selftest note " + i } }); for (let i = 1; i <= Math.floor(n / 2); i++) plan.push({ title: "Remember " + i, action: "remember", params: { text: "selftest fact " + i } }); }
      else if (mode === "clip") for (let i = 1; i <= n; i++) plan.push({ title: "Clip " + i, action: "clipboard_get", params: {} });
      else if (mode === "scan") for (let i = 0; i < n; i++) { const d = ["Downloads", "Documents", "Desktop", "Pictures", "Videos", "Music"][i % 6]; plan.push({ title: "Scan " + i, action: i % 2 ? "large_files" : "dup_scan", params: { path: "~/" + d, minMB: 50 } }); }
      else if (mode === "apps") { plan.push({ title: "Open URL", action: "open_url", params: { url: "https://music.youtube.com/" } }); plan.push({ title: "YT search", action: "youtube", params: { query: "lofi" } }); plan.push({ title: "Notepad", action: "open_app", params: { name: "notepad" } }); plan.push({ title: "Explorer", action: "open_app", params: { name: "explorer" } }); }
      else if (mode === "vscode") plan.push({ title: "Open VS Code", action: "open_app", params: { name: "vscode" } });
      else { plan = await buildManifest(n); }
      batchState = { running: true, done: 0, failed: 0, blocked: 0, total: plan.length, startedAt: Date.now(), finishedAt: 0, report: "" };
      const created = plan.map((m) => tasks.create({ title: m.title, priority: m.priority || "P3", steps: [{ action: m.action, params: m.params }], mode: "batch" }));
      runBatchAsync(created)
        .then(() => trace("SELFTEST runBatch resolved"))
        .catch((e) => trace("SELFTEST runBatch err " + ((e && e.message) || e)));
    } catch (e) { trace("SELFTEST threw " + ((e && e.message) || e)); }
  }, 4000);
}
ipcMain.handle("batch:status", () => batchState);

async function runBatchAsync(created) {
  trace("batch START total=" + created.length);
  for (const t of created) {
    const step = t.steps[0];
    const fn = ACTIONS[step.action];
    let ok = false, err = "";
    trace("START " + t.title + " [" + step.action + "]");
    if (!fn) { err = "unknown action: " + step.action; }
    else for (let a = 0; a < 3 && !ok; a++) { try { const r = await fn(step.params, { task: t }); t.steps[0].result = String(r).slice(0, 300); ok = true; } catch (e) { err = (e && e.message) || String(e); } }
    trace("END   " + t.title + " " + (ok ? "ok" : "FAIL " + err));
    if (ok) { tasks.update(t.task_id, { status: "completed", started_at: t.created_at, completed_at: Date.now(), steps: t.steps, result: (t.steps[0].result || "").slice(0, 120) }); batchState.done++; }
    else { tasks.update(t.task_id, { status: "failed", completed_at: Date.now(), error: err }); batchState.failed++; }
    batchState.current = t.title;
    const processed = batchState.done + batchState.failed;
    if (processed % 10 === 0 || processed === batchState.total) {
      trace("PROG  " + processed + "/" + batchState.total);
      emit("batch:progress", {
        done: batchState.done, failed: batchState.failed, total: batchState.total,
        percent: Math.round((processed / Math.max(1, batchState.total)) * 100),
        current: t.title, elapsed: Date.now() - batchState.startedAt,
      });
      trace("PROG-SENT " + processed);
    }
    // yield to the event loop (timers + IPC), otherwise a run of thousands of fast tasks
    // keeps one macro-task alive and the whole window stops repainting
    if (processed % 25 === 0) await sleep(0);
  }
  trace("LOOP-DONE ok=" + batchState.done + " fail=" + batchState.failed);
  batchState.running = false; batchState.finishedAt = Date.now();
  batchState.percent = 100;
  batchState.report = tasks.report();
  trace("REPORT ok len=" + String(batchState.report || "").length);
  tasks.log("batch finished: " + batchState.done + " ok, " + batchState.failed + " failed");
  trace("LOGGED");
  emit("batch:done", { done: batchState.done, failed: batchState.failed, total: batchState.total, elapsed: batchState.finishedAt - batchState.startedAt });
  trace("EMITTED done");
}

ipcMain.handle("batch:run", async (_e, count) => {
  const n = Math.max(1, Math.min(5000, Number(count) || 1000));
  trace("batch:run requested n=" + n);
  batchState = { running: true, done: 0, failed: 0, blocked: 0, total: 0, startedAt: Date.now(), finishedAt: 0, report: "" };
  const manifest = await buildManifest(n);
  batchState.total = manifest.length;
  const created = manifest.map((m) => tasks.create({ title: m.title, priority: m.priority, steps: [{ action: m.action, params: m.params }], mode: "batch" }));
  tasks.log("batch started: " + created.length + " tasks");
  runBatchAsync(created).catch(() => { batchState.running = false; });
  return { started: true, total: created.length };
});

/* ------------------------------ coding batch (write + run code) ------------------------------ */
const CODE_DIR = path.join(WORKSPACE, "code");
function execP(cmd, args, opts) { return new Promise((res) => execFile(cmd, args, opts, (err, stdout) => res({ err, stdout: (stdout || "").toString() }))); }

function makeJs(i) {
  const k = i % 8;
  const n = (i % 40) + 3;
  if (k === 0) { const exp = (n * (n + 1)) / 2; return { name: "sum", code: `let s=0;for(let i=1;i<=${n};i++)s+=i;console.log(s);`, expect: String(exp) }; }
  if (k === 1) { let f = 1; for (let j = 1; j <= n; j++) f *= j; return { name: "factorial", code: `let f=1;for(let i=1;i<=${n};i++)f*=i;console.log(f);`, expect: String(f) }; }
  if (k === 2) { let a = 0, b = 1; for (let j = 0; j < n; j++) { const t = a + b; a = b; b = t; } return { name: "fib", code: `let a=0,b=1;for(let i=0;i<${n};i++){let t=a+b;a=b;b=t;}console.log(a);`, expect: String(a) }; }
  if (k === 3) { const m = (i % 17) + 2; let x = n, y = m; while (y) { const t = y; y = x % y; x = t; } return { name: "gcd", code: `let x=${n},y=${m};while(y){let t=y;y=x%y;x=t;}console.log(x);`, expect: String(x) }; }
  if (k === 4) { const e = (i % 10) + 2; return { name: "pow", code: `console.log(Math.pow(2,${e}));`, expect: String(Math.pow(2, e)) }; }
  if (k === 5) { const s = "zumi" + (i % 9); return { name: "reverse", code: `let s="${s}";console.log(s.split("").reverse().join(""));`, expect: s.split("").reverse().join("") }; }
  if (k === 6) { let c = 0; for (let v = 2; v <= n; v++) { let p = true; for (let d = 2; d * d <= v; d++) if (v % d === 0) { p = false; break; } if (p) c++; } return { name: "primes", code: `let c=0;for(let v=2;v<=${n};v++){let p=true;for(let d=2;d*d<=v;d++)if(v%d===0){p=false;break;}if(p)c++;}console.log(c);`, expect: String(c) }; }
  let s = 0; for (let v = 1; v <= n; v++) if (v % 3 !== 0) s += v;
  return { name: "skip3", code: `let s=0;for(let i=1;i<=${n};i++)if(i%3!==0)s+=i;console.log(s);`, expect: String(s) };
}

let codeBatchState = { running: false, total: 0, written: 0, ran: 0, passed: 0, failed: 0, startedAt: 0, finishedAt: 0, dir: "" };
ipcMain.handle("code:status", () => codeBatchState);
ipcMain.handle("code:open-vscode", () => { try { spawnSafe("code", [CODE_DIR], { detached: true, stdio: "ignore", shell: true }); } catch { /* ignore */ } return CODE_DIR; });

/* Run a generated snippet inside the main process with node's `vm` sandbox.
   No child process => no CPU storm => the window keeps rendering at 60 fps. */
function runViaVm(code) {
  const out = [];
  const log = (...a) => { out.push(a.map((x) => String(x)).join(" ")); };
  const sandbox = { console: { log, info: log, warn: log, error: log, debug: log } };
  try {
    const ctx = vm.createContext(sandbox, { name: "zumi-snippet" });
    vm.runInContext(code, ctx, { timeout: 4000, displayErrors: false });
    return { out: out.join("\n"), err: "", needsNode: false };
  } catch (e) {
    const msg = String((e && e.message) || e);
    // snippets that really need node (require/process/...) fall back to a real process
    if (/(require|module|exports|__dirname|__filename|process|Buffer)\s+is not defined/.test(msg)) return { out: out.join("\n"), err: "", needsNode: true };
    return { out: out.join("\n"), err: msg, needsNode: false };
  }
}

async function runCodeBatch(count, doRun, concurrency, dir) {
  fs.mkdirSync(dir, { recursive: true });
  trace("code batch START dir=" + dir + " count=" + count);
  codeBatchState.dir = dir;
  let idx = 0;
  const worker = async () => {
    while (idx < count) {
      const i = ++idx;
      const t = makeJs(i);
      const file = path.join(dir, String(i).padStart(6, "0") + "-" + t.name + ".js");
      try { fs.writeFileSync(file, t.code); codeBatchState.written++; }
      catch { codeBatchState.failed++; continue; }
      if (doRun) {
        // Verified in-process first: spawning `node` for every file (10 workers at once)
        // saturated the CPU and the buddy froze at <1 fps. The sandbox gives identical
        // console output in microseconds; only snippets that need real node APIs spawn.
        const r = runViaVm(t.code);
        let got = r.out;
        if (r.needsNode) {
          const e = await execP("node", [file], { timeout: 8000, windowsHide: true, maxBuffer: 1e6 });
          got = (e.stdout || "").toString();
        }
        codeBatchState.ran++;
        if (String(got).trim() === t.expect) codeBatchState.passed++; else codeBatchState.failed++;
      }
      if (idx % 50 === 0 || idx === count) { trace("code PROG " + codeBatchState.written + "/" + count); emit("code:progress", { written: codeBatchState.written, ran: codeBatchState.ran, passed: codeBatchState.passed, failed: codeBatchState.failed, total: codeBatchState.total, percent: Math.round((idx / Math.max(1, count)) * 100) }); }
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));
  trace("code batch DONE written=" + codeBatchState.written + " passed=" + codeBatchState.passed + " failed=" + codeBatchState.failed);
  codeBatchState.running = false;
  codeBatchState.finishedAt = Date.now();
  emit("code:done", { ...codeBatchState });
  trace("code EMITTED done");
}

ipcMain.handle("code:run", (_e, { count, run, concurrency, sub }) => {
  trace("code:run count=" + count + " sub=" + sub);
  const total = Math.max(1, Math.min(1000000, Number(count) || 1000));
  // cap concurrency below the core count: 20 concurrent `node` processes starved the UI
  // (the buddy went "stuck" while the batch ran). 12 cores -> 10 workers, still very fast.
  const cap = Math.max(2, Math.min(16, os.cpus().length - 2));
  const concurrent = Math.max(2, Math.min(cap, Number(concurrency) || 12));
  // never overwrite an existing run: every run gets its own folder under CODE_DIR
  const safeSub = /^[A-Za-z0-9_-]{1,40}$/.test(String(sub || "")) ? String(sub) : "run-" + Date.now();
  const dir = path.join(CODE_DIR, safeSub);
  codeBatchState = { running: true, total, written: 0, ran: 0, passed: 0, failed: 0, startedAt: Date.now(), finishedAt: 0, dir };
  runCodeBatch(total, run !== false, concurrent, dir).catch(() => { codeBatchState.running = false; });
  return { started: true, total, concurrency: concurrent, run: run !== false, dir };
});

/* ------------------------------ daily report (auto 21:00, or "/daily") ------------------------------ */
const DAILY_FILE = path.join(app.getPath("userData"), "last-daily.txt");
const DAILY_HOUR = 21;

let scanCache = { at: 0, count: 0, bytes: 0 };
async function workspaceScan() {
  if (Date.now() - scanCache.at < 60000) return scanCache;   // the walk is the slow part — cache it
  // Count EVERY file (readdir only) and size a sample to estimate the total — the old code
  // stopped at 4000 files and reported "4000+ files · 1 MB" even with 170 000+ on disk.
  const stack = [WORKSPACE];
  let count = 0, bytes = 0, sampled = 0, dirs = 0;
  while (stack.length) {
    const dir = stack.pop();
    let ents; try { ents = await fs.promises.readdir(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else {
        count++;
        if (sampled < 3000) { sampled++; try { bytes += fs.statSync(p).size; } catch { /* ignore */ } }
      }
    }
    if (++dirs % 40 === 0) await sleep(0);   // hand the loop back while walking a huge tree
  }
  scanCache = { at: Date.now(), count, bytes: sampled ? Math.round((bytes / sampled) * count) : 0, exact: sampled ? bytes : 0 };
  return scanCache;
}
async function buildDailyReport() {
  const bs = brain.stats();
  const ts = tasks.stats();
  const L = [];
  L.push("DAILY REPORT · " + new Date().toLocaleString());
  L.push(`Tasks: ${ts.completed} done · ${ts.failed} failed · ${ts.blocked} blocked · ${ts.queued + ts.running} queued (lifetime ${ts.total})`);
  if (batchState && batchState.total) L.push(`Safe PC batch: ${batchState.done}/${batchState.total} ok · ${batchState.failed} failed${batchState.running ? " · RUNNING" : ""}`);
  if (codeBatchState && codeBatchState.total) L.push(`Code batch: ${codeBatchState.written} written · ${codeBatchState.passed} passed · ${codeBatchState.failed} failed${codeBatchState.running ? " · RUNNING" : ""}`);
  L.push(`Brain: ${bs.memory} memories · ${bs.notes} notes · ${bs.tasks} open to-dos · ${bs.reminders} reminders`);
  let ws = { count: 0, bytes: 0 };
  try { ws = await workspaceScan(); } catch { /* ignore */ }
  L.push(`Workspace: ${ws.count.toLocaleString("en-US")} files · ~${Math.max(1, Math.round(ws.bytes / 1048576))} MB${ws.count >= 4000 ? " (counted, size estimated)" : ""} (${WORKSPACE})`);
  L.push(`PC: ${os.cpus().length} cores · ${Math.round((100 * (os.totalmem() - os.freemem())) / os.totalmem())}% RAM · up ${Math.round(os.uptime() / 60)} min · ${os.hostname()}`);
  L.push("Nothing was deleted — everything stays on this PC.");
  return L.join("\n");
}

ipcMain.handle("daily:report", () => buildDailyReport());

function startDailyLoop() {
  let lastSent = "";
  try { lastSent = fs.readFileSync(DAILY_FILE, "utf8").trim(); } catch { /* first run */ }
  setInterval(() => {
    try {
      const now = new Date();
      const key = now.getFullYear() + "-" + String(now.getMonth() + 1).padStart(2, "0") + "-" + String(now.getDate()).padStart(2, "0");
      if (now.getHours() !== DAILY_HOUR || lastSent === key) return;
      lastSent = key;
      try { fs.writeFileSync(DAILY_FILE, key); } catch { /* ignore */ }
      tasks.log("auto daily report");
      emit("task:speak", { text: "It is 9 PM — here is your daily report." });
      buildDailyReport().then((text) => emit("daily:report", { text })).catch(() => { /* ignore */ });
    } catch { /* ignore */ }
  }, 60000);
}

/* ------------------------------ reminder loop ------------------------------ */
function startReminderLoop() {
  setInterval(() => {
    try {
      const due = brain.remindersDue(Date.now());
      for (const r of due) {
        brain.reminderMarkDone(r.id);
        if (win && !win.isDestroyed()) win.webContents.send("reminder:fire", r);
      }
    } catch { /* ignore */ }
  }, 20000);
}
