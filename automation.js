/* Zumi automation — real PC actions (files + GUI), all local. */
const fs = require("fs");
const path = require("path");
const os = require("os");
const { spawnSync, spawn } = require("child_process");
const crypto = require("crypto");

function ps(script) {
  const r = spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", script], { encoding: "utf8", timeout: 25000 });
  return { out: (r.stdout || "") + (r.stderr || ""), code: r.status };
}

/* ------------------------------ files ------------------------------ */
function home() { return os.homedir(); }

/* Windows "known folders" can be redirected (OneDrive moves Desktop/Documents/Pictures
   to %USERPROFILE%\OneDrive\...). os.homedir() does NOT know that, so ~/Desktop would
   point at a folder that does not exist. Read the real locations from the registry once. */
const KNOWN_NAMES = {
  desktop: "desktop", documents: "documents", downloads: "downloads",
  pictures: "pictures", music: "music", videos: "videos",
  desktopdir: "desktop", personal: "documents",
};
let _knownFolders = null;
function knownFolders() {
  if (_knownFolders) return _knownFolders;
  _knownFolders = {};
  try {
    // registry value name -> canonical lowercase key
    const names = {
      "Desktop": "desktop", "Personal": "documents",
      "My Pictures": "pictures", "My Music": "music", "My Video": "videos",
      "{374DE290-123F-4565-9164-39C4925E467B}": "downloads",
    };
    const r = spawnSync("reg", ["query", "HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\User Shell Folders"], { encoding: "utf8", timeout: 5000 });
    if (r.status === 0 && r.stdout) {
      for (const line of String(r.stdout).split(/\r?\n/)) {
        // e.g. "    Desktop    REG_EXPAND_SZ    C:\Users\x\OneDrive\Desktop"
        const m = line.match(/^\s*([^\s]+(?:\s[^\s]+?)?)\s+REG_\w+\s+(.+?)\s*$/);
        if (!m) continue;
        const key = m[1].trim();
        if (!(key in names)) continue;
        let v = m[2].trim().replace(/^"|"$/g, "");
        v = v.replace(/%(\w+)%/g, (mm, k) => process.env[k] || mm);
        if (v) _knownFolders[names[key]] = v;
      }
    }
  } catch { /* fall back to homedir layout below */ }
  return _knownFolders;
}

/* Map a path that lives under home() onto the redirected known-folder location,
   but ONLY when the original does not exist and the redirected one does. */
function redirectKnown(s) {
  try {
    if (!s || fs.existsSync(s)) return s;
    const h = home();
    const rel = path.relative(h, s);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return s;
    const seg = rel.split(/[\\/]/);
    const first = seg[0].toLowerCase();
    if (!(first in KNOWN_NAMES)) return s;
    const base = knownFolders()[KNOWN_NAMES[first]];
    if (!base) return s;
    const cand = path.join(base, ...seg.slice(1));
    return fs.existsSync(cand) ? cand : s;
  } catch { return s; }
}

function resolve(p) {
  if (!p) throw new Error("path required");
  let s = String(p).trim().replace(/^~(?=$|[\\/])/, home());
  s = s.replace(/%(\w+)%/g, (m, k) => process.env[k] || m);
  if (!path.isAbsolute(s)) s = path.join(home(), s);
  return redirectKnown(s);
}
function listDir(p) {
  const dir = resolve(p);
  const items = fs.readdirSync(dir, { withFileTypes: true }).map((e) => {
    let size = null;
    try { if (e.isFile()) size = fs.statSync(path.join(dir, e.name)).size; } catch { /* ignore */ }
    return { name: e.name, type: e.isDirectory() ? "dir" : "file", size };
  });
  return { dir, count: items.length, items: items.slice(0, 300) };
}
function mkdir(p) { const d = resolve(p); fs.mkdirSync(d, { recursive: true }); return d; }
function uniqueName(dest) {
  if (!fs.existsSync(dest)) return dest;
  const dir = path.dirname(dest); const ext = path.extname(dest); const base = path.basename(dest, ext);
  let i = 1; let cand;
  do { cand = path.join(dir, `${base} (${i})${ext}`); i++; } while (fs.existsSync(cand) && i < 999);
  return cand;
}
function moveFile(src, dest) {
  const s = resolve(src);
  let d = resolve(dest);
  if (!fs.existsSync(s)) throw new Error("source not found: " + s);
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) d = path.join(d, path.basename(s));
  d = uniqueName(d); // never overwrite
  fs.mkdirSync(path.dirname(d), { recursive: true });
  fs.renameSync(s, d);
  return { from: s, to: d };
}
function copyFile(src, dest) {
  const s = resolve(src); let d = resolve(dest);
  if (!fs.existsSync(s)) throw new Error("source not found: " + s);
  if (fs.existsSync(d) && fs.statSync(d).isDirectory()) d = path.join(d, path.basename(s));
  d = uniqueName(d);
  fs.copyFileSync(s, d);
  return { from: s, to: d };
}
function renameFile(src, name) {
  const s = resolve(src);
  const d = path.join(path.dirname(s), String(name));
  fs.renameSync(s, d);
  return { from: s, to: d };
}
async function trashFile(p, shellMod) {
  const s = resolve(p);
  if (!fs.existsSync(s)) throw new Error("not found: " + s);
  if (shellMod && shellMod.trashItem) { await shellMod.trashItem(s); return { trashed: s }; }
  fs.rmSync(s, { recursive: true, force: true });
  return { deleted: s };
}
function writeText(p, text) { const d = resolve(p); fs.mkdirSync(path.dirname(d), { recursive: true }); fs.writeFileSync(d, String(text)); return d; }
function readText(p) { return fs.readFileSync(resolve(p), "utf8").slice(0, 20000); }

/* ------------------------------ GUI (keyboard / mouse) ------------------------------ */
/* Quote for PowerShell's SINGLE-quoted string rules, not JSON's.
   This matters: PowerShell does not treat backslash as an escape, so JSON.stringify
   used to hand it "C:\\Users\\..." — which SendKeys then typed literally, doubling every
   separator. Windows rejected the result ("The file name is not valid"), which is why
   every typed save/open path failed while the dialog itself worked fine.
   In a single-quoted string only ' is special (escaped by doubling). */
function psQuote(s) { return "'" + String(s).replace(/'/g, "''") + "'"; }
function sendKeys(combo) {
  const script = `Add-Type -AssemblyName System.Windows.Forms;[System.Windows.Forms.SendKeys]::SendWait(${psQuote(combo)})`;
  const r = ps(script);
  if (r.code !== 0) throw new Error("SendKeys failed: " + r.out.slice(0, 160));
  return true;
}
const KEYMAP = { ENTER: "{ENTER}", TAB: "{TAB}", ESC: "{ESC}", ESCAPE: "{ESC}", BACKSPACE: "{BACKSPACE}", DELETE: "{DEL}", DEL: "{DEL}", UP: "{UP}", DOWN: "{DOWN}", LEFT: "{LEFT}", RIGHT: "{RIGHT}", HOME: "{HOME}", END: "{END}", PAGEUP: "{PGUP}", PAGEDOWN: "{PGDN}", SPACE: " ", F1: "{F1}", F2: "{F2}", F3: "{F3}", F4: "{F4}", F5: "{F5}", F6: "{F6}", F7: "{F7}", F8: "{F8}", F9: "{F9}", F10: "{F10}", F11: "{F11}", F12: "{F12}" };
const MODS = { CTRL: "^", CONTROL: "^", ALT: "%", SHIFT: "+" };
function keyPress(keys) {
  const parts = String(keys).toUpperCase().split("+").map((s) => s.trim()).filter(Boolean);
  let combo = "";
  for (const p of parts) { if (MODS[p]) combo += MODS[p]; else combo += KEYMAP[p] || ("{" + p + "}"); }
  return sendKeys(combo);
}
function typeText(text) {
  // escape SendKeys special chars
  const escaped = String(text).replace(/([+^%~(){}\[\]])/g, "{$1}");
  return sendKeys(escaped);
}
const CSHARP = 'using System;using System.Runtime.InteropServices;public class ZM{[DllImport("user32.dll")]public static extern bool SetCursorPos(int x,int y);[DllImport("user32.dll")]public static extern void mouse_event(uint f,uint dx,uint dy,uint d,int e);}';
function mouseMove(x, y) { const r = ps(`Add-Type -TypeDefinition '${CSHARP}';[ZM]::SetCursorPos(${Math.round(x)},${Math.round(y)})`); return true; }
function mouseClick(x, y, button) {
  const flag = button === "right" ? [0x0008, 0x0010] : button === "middle" ? [0x0020, 0x0040] : [0x0002, 0x0004];
  const script = `Add-Type -TypeDefinition '${CSHARP}';[ZM]::SetCursorPos(${Math.round(x)},${Math.round(y)});Start-Sleep -Milliseconds 80;[ZM]::mouse_event(0x${flag[0].toString(16)},0,0,0,0);[ZM]::mouse_event(0x${flag[1].toString(16)},0,0,0,0)`;
  ps(script); return true;
}

/* ------------------------------ screen text (OCR) ------------------------------
   Reads text with the OCR engine that ships inside Windows (Windows.Media.Ocr): no
   third-party install, no admin rights, no PATH entry. The previous implementation
   shelled out to `tesseract`, so every read died with "install Tesseract" on a machine
   that did not have it - which is why the Calculator and Paint results could never be
   verified, only "keys delivered". */
const READSCREEN_PS1 = path.join(__dirname, "readscreen.ps1");
let ocrProbe = null;

function runReadScreen(args) {
  const r = spawnSync("powershell",
    ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", READSCREEN_PS1].concat(args),
    { encoding: "utf8", timeout: 45000, windowsHide: true });
  const body = (String(r.stdout || "") + String(r.stderr || "")).replace(/\r\n/g, "\n");
  const png = ((body.match(/^##PNG=(.*)$/m) || [])[1] || "").trim();
  const rect = ((body.match(/^##RECT=(.*)$/m) || [])[1] || "").trim();
  const src = ((body.match(/^##SRC=(.*)$/m) || [])[1] || "").trim();
  const text = body.split("\n").filter((l) => !/^##(PNG|RECT|SRC)=/.test(l)).join("\n").trim();
  if (r.error) throw new Error("screen read failed: " + r.error.message);
  if (r.status !== 0 && !png) throw new Error("screen read failed: " + body.trim().slice(0, 300));
  return { text: text, png: png, rect: rect, src: src };
}

function ocrAvailable() {
  if (ocrProbe !== null) return ocrProbe;
  if (process.platform !== "win32" || !fs.existsSync(READSCREEN_PS1)) { ocrProbe = false; return false; }
  const r = ps("$ErrorActionPreference='Stop'; Add-Type -AssemblyName System.Runtime.WindowsRuntime; " +
    "$null=[Windows.Media.Ocr.OcrEngine,Windows.Foundation,ContentType=WindowsRuntime]; " +
    "$null=[Windows.Globalization.Language,Windows.Globalization,ContentType=WindowsRuntime]; " +
    "$e=$null; try { $e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() } catch { }; " +
    "if (-not $e) { try { $l=New-Object Windows.Globalization.Language 'en-US'; " +
    "$e=[Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($l) } catch { } }; " +
    "if ($e) { 'yes' } else { 'no' }");
  const last = r.out.trim().split(/\r?\n/).filter(Boolean).pop() || "";
  ocrProbe = last === "yes";
  return ocrProbe;
}

function ocr(imagePath) {
  if (!ocrAvailable()) throw new Error("OCR unavailable - this PC has no Windows screen-reading engine.");
  const p = resolve(imagePath);
  if (!fs.existsSync(p)) throw new Error("image not found: " + p);
  return runReadScreen(["-Image", p]).text;
}

/* Read what is currently showing on an app's window.
   An app can own SEVERAL top-level windows with the same title - Calculator leaves a
   stale, minimised ApplicationFrameHost frame behind next to the live one, and both are
   handed back by EnumWindows. Taking wins[0] blindly reads the dead frame: PrintWindow
   still returns success, but the rectangle is unavailable (Rect() is empty for a
   minimised window, which is what "##RECT=FULL" means here) and the pixels are blank.
   So walk the candidates and keep the first one that produced BOTH a real rectangle and
   readable text, falling back to the first window with a real rectangle (a genuinely
   text-less window such as a blank Paint canvas is a valid answer, not a retry). */
function readScreen(name) {
  if (!fs.existsSync(READSCREEN_PS1)) throw new Error("readscreen.ps1 is missing");
  let focused = true;
  let hwnds = [""];
  if (name) {
    const f = focusApp(name);
    focused = !!(f && f.focused);
    const wins = appWindows(name);
    if (!wins.length) throw new Error("no " + name + " window open to read");
    hwnds = wins.slice(0, 4).map((w) => String(w.hwnd));
  }
  let best = null;      // first candidate that had a usable rectangle
  let last = null;
  for (let i = 0; i < hwnds.length; i++) {
    const h = hwnds[i];
    const out = path.join(os.tmpdir(), "zumi-ocr-" + Date.now() + "-" + i +
      Math.random().toString(36).slice(2, 7) + ".png");
    const args = ["-Out", out];
    if (h) args.push("-Dll", ZWIN_DLL, "-Hwnd", h, "-Settle", "500");
    let r;
    try { r = runReadScreen(args); } catch (e) { if (i === hwnds.length - 1) throw e; continue; }
    r.focused = focused;
    r.hwnd = h;
    last = r;
    if (!h) return r;                                   // whole desktop: one shot
    if (r.rect !== "FULL") {                            // rectangle was usable
      if (!best) best = r;
      if (r.text) return r;                             // and it had readable content
    }
  }
  return best || last;
}

/* ---------------- app lifecycle (open / close) ----------------
   Get-Process' MainWindowTitle is NOT good enough to see the desktop:
     - File Explorer windows live inside the shell explorer process, whose
       MainWindowHandle points at the desktop (title = ''), so they are invisible.
     - Calculator is ApplicationFrameHost.exe, which also hosts Telegram and
       Settings, so a process name alone would close the wrong app.
   So we enumerate real top-level windows with EnumWindows (ZWin below) and match
   on process name AND window title.

   Closing is scoped two ways:
     - Snapshot the matching windows that existed BEFORE Zumi opened the app, and
       only ever touch the ones that appeared afterwards.
     - Close by HWND with WM_CLOSE (not by killing the process), so an app with
       unsaved work prompts instead of losing it, and sibling windows belonging to
       other apps that share a process are never hit. */
const spawnedPids = new Map();
const preOpen = new Map();          // appKey -> Set of hwnd strings pre-dating Zumi's open

/* The voice path opens with APP_MAP keys ("calc", "code") while the planner uses
   its own words ("calculator", "vscode"). Both must land on ONE bucket. */
const APP_ALIASES = {
  calc: "calculator", calculator: "calculator",
  files: "explorer", folder: "explorer", explorer: "explorer",
  code: "vscode", vscode: "vscode",
  terminal: "cmd", cmd: "cmd",
  notepad: "notepad", paint: "paint", settings: "settings", browser: "browser",
};
/* How to recognise each app's windows: which processes may own them, which titles
   are acceptable (required when several apps share one process), and which to skip. */
const APP_WIN = {
  notepad:    { proc: ["notepad"], title: /notepad/i },
  calculator: { proc: ["applicationframehost", "calculator", "calc"], title: /calculator/i },
  /* PopupHost is Explorer's address-bar autocomplete dropdown (same process, but a
     transient popup). With title:null it was treated as a real folder window, so
     focus_app("explorer") could grab the popup instead of the folder — and keys sent
     to a popup never navigate. Never target it. */
  explorer:   { proc: ["explorer"], title: null, skip: /^(program manager|popuphost)$/i },
  paint:      { proc: ["mspaint"], title: /paint|save as/i },
  vscode:     { proc: ["code"], title: /visual studio code/i },
  cmd:        { proc: ["windowsterminal", "conhost", "cmd"], title: /cmd\.exe|command prompt/i },
  settings:   { proc: ["systemsettings", "applicationframehost"], title: /settings/i },
};
function appKey(name) {
  const k = String(name || "").toLowerCase().replace(/\s+/g, "");
  return APP_ALIASES[k] || k;
}

/* --- EnumWindows helper: build once, reuse the DLL afterwards ---------------- */
const ZUMI_DATA = path.join(process.env.APPDATA || os.homedir(), "zumi-desktop-buddy");
const ZWIN_CS = path.join(ZUMI_DATA, "winenum.cs");
const ZWIN_SRC = `using System;
using System.Text;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Diagnostics;
public class ZWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll")] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool PostMessage(IntPtr h, uint msg, IntPtr w, IntPtr l);
  [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int n);
  [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] static extern bool BringWindowToTop(IntPtr h);
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr hwnd, IntPtr hdc, uint flags);
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte sc, uint flags, UIntPtr extra);
  [DllImport("user32.dll")] static extern bool AttachThreadInput(uint a, uint b, bool attach);
  [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
  public static string[] Run() {
    var res = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr l) {
      if (!IsWindowVisible(h)) return true;
      var sb = new StringBuilder(1024);
      GetWindowText(h, sb, 1024);
      string t = sb.ToString();
      if (t.Length == 0) return true;
      uint pid; GetWindowThreadProcessId(h, out pid);
      string name = "?";
      try { name = Process.GetProcessById((int)pid).ProcessName; } catch { }
      res.Add(pid + "|" + name + "|" + h.ToInt64() + "|" + t);
      return true;
    }, IntPtr.Zero);
    return res.ToArray();
  }
  /* Screen rectangle of one window, "L,T,R,B". Empty when it is hidden, minimised or
     degenerate — the caller must focus/restore first, because the screen capture that
     follows reads whatever is currently painted at those coordinates. */
  public static string Rect(long h) {
    try {
      IntPtr w = new IntPtr(h);
      if (!IsWindowVisible(w) || IsIconic(w)) return "";
      RECT r;
      if (!GetWindowRect(w, out r)) return "";
      if (r.Right - r.Left < 8 || r.Bottom - r.Top < 8) return "";
      return r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom;
    } catch { return ""; }
  }
  public static string Close(long h) {
    try { return PostMessage(new IntPtr(h), 0x0010, IntPtr.Zero, IntPtr.Zero) ? "posted" : "refused"; }
    catch { return "refused"; }
  }
  /* Read a window's OWN pixels straight out of it with PrintWindow. A screen grab at the
     window's rectangle is fragile: anything painted on top is what gets read (Zumi itself
     is always-on-top), and the grab can catch a frame that has not repainted yet after
     being raised. PW_RENDERFULLCONTENT (2) is the flag that makes this work for
     GPU-composited windows such as the UWP Calculator - flag 0 comes back all black.
     Returns the path on success, "" when there were no usable pixels. */
  public static string Capture(long h, string path) {
    try {
      IntPtr w = new IntPtr(h);
      RECT r;
      if (!GetWindowRect(w, out r)) return "";
      int width = r.Right - r.Left, height = r.Bottom - r.Top;
      if (width < 8 || height < 8) return "";
      using (var bmp = new System.Drawing.Bitmap(width, height)) {
        using (var g = System.Drawing.Graphics.FromImage(bmp)) {
          IntPtr hdc = g.GetHdc();
          bool ok = PrintWindow(w, hdc, 2);
          g.ReleaseHdc(hdc);
          if (!ok) return "";
        }
        var box = new System.Drawing.Rectangle(0, 0, width, height);
        var bd = bmp.LockBits(box, System.Drawing.Imaging.ImageLockMode.ReadOnly,
                              System.Drawing.Imaging.PixelFormat.Format32bppArgb);
        byte[] buf = new byte[Math.Abs(bd.Stride) * height];
        System.Runtime.InteropServices.Marshal.Copy(bd.Scan0, buf, 0, buf.Length);
        bmp.UnlockBits(bd);
        long lit = 0;
        for (int i = 0; i + 2 < buf.Length; i += 4)
          if (buf[i] > 12 || buf[i + 1] > 12 || buf[i + 2] > 12) lit++;
        if (lit < (long)width * height / 100) return "";   // under 1% non-black = blank
        bmp.Save(path, System.Drawing.Imaging.ImageFormat.Png);
      }
      return path;
    } catch { return ""; }
  }
  /* Windows refuses a plain background->foreground steal (foreground-lock rules),
     which is exactly why focus_app used to abort every task. Work around it:
     restore if minimised, then SetForegroundWindow, then borrow the input queue of
     the window that currently has focus, then a dummy ALT press to lift the lock. */
  public static string Focus(long h) {
    IntPtr w = new IntPtr(h);
    try {
      if (IsIconic(w)) ShowWindow(w, 9);                       // SW_RESTORE
      if (GetForegroundWindow() == w) return "focused";
      if (SetForegroundWindow(w) && GetForegroundWindow() == w) return "focused";
      IntPtr fg = GetForegroundWindow();
      if (fg != IntPtr.Zero) {
        uint ignore; uint fgThread = GetWindowThreadProcessId(fg, out ignore);
        uint me = GetCurrentThreadId();
        if (fgThread != 0 && fgThread != me) {
          AttachThreadInput(me, fgThread, true);
          BringWindowToTop(w);
          SetForegroundWindow(w);
          AttachThreadInput(me, fgThread, false);
          if (GetForegroundWindow() == w) return "focused";
        }
      }
      keybd_event(0xA4, 0, 0, UIntPtr.Zero);                  // ALT down
      keybd_event(0xA4, 0, 2, UIntPtr.Zero);                  // ALT up
      SetForegroundWindow(w);
      BringWindowToTop(w);
      return GetForegroundWindow() == w ? "focused" : "refused";
    } catch { return "refused"; }
  }
}`;

/* The DLL name carries a hash of the C# source above. Editing the source therefore makes
   the app COMPILE A NEW FILE instead of overwriting the existing one, so an earlier build
   is left untouched on disk — nothing is ever replaced or removed. */
const ZWIN_DLL = path.join(ZUMI_DATA, "winenum-" +
  crypto.createHash("sha1").update(ZWIN_SRC, "utf8").digest("hex").slice(0, 8) + ".dll");

function ensureWinEnum() {
  if (fs.existsSync(ZWIN_DLL)) return true;
  try {
    fs.mkdirSync(ZUMI_DATA, { recursive: true });
    fs.writeFileSync(ZWIN_CS, ZWIN_SRC, "utf8");
    /* System.Drawing has to be named explicitly: Capture() saves a Bitmap, and the
       default reference set Add-Type uses does not include it - the build fails with
       "'System.Drawing.Bitmap' does not exist" unless it is listed here. */
    const r = ps(`Add-Type -Path '${ZWIN_CS}' -OutputAssembly '${ZWIN_DLL}' -ReferencedAssemblies System.Drawing -ErrorAction Stop; 'BUILT'`);
    return r.code === 0 && fs.existsSync(ZWIN_DLL);
  } catch { return false; }
}

/* Every visible top-level window: {pid, name, hwnd, title} */
function windowList() {
  if (!ensureWinEnum()) return [];
  const r = ps(`[Reflection.Assembly]::LoadFrom('${ZWIN_DLL}') | Out-Null; [ZWin]::Run()`);
  return String(r.out || "").split(/\r?\n/).map((s) => s.trim()).filter(Boolean).map((line) => {
    const a = line.indexOf("|"), b = line.indexOf("|", a + 1), c = line.indexOf("|", b + 1);
    if (a < 0 || b < 0 || c < 0) return null;
    return { pid: Number(line.slice(0, a)), name: line.slice(a + 1, b).toLowerCase(), hwnd: line.slice(b + 1, c), title: line.slice(c + 1) };
  }).filter((x) => x && Number.isFinite(x.pid));
}

/* Windows that belong to this app. */
function appWindows(name) {
  const rule = APP_WIN[appKey(name)];
  if (!rule) return [];
  return windowList().filter((w) =>
    rule.proc.includes(w.name) &&
    (!rule.title || rule.title.test(w.title)) &&
    (!rule.skip || !rule.skip.test(w.title)));
}

/* Call immediately BEFORE spawning: first open in the session fixes the baseline. */
function notePreOpen(name) {
  const k = appKey(name);
  if (preOpen.has(k)) return;                     // never re-snapshot over our own window
  preOpen.set(k, new Set(appWindows(name).map((w) => w.hwnd)));
}
function trackSpawn(name, pid) {
  if (!pid) return 0;
  const k = appKey(name);
  if (!spawnedPids.has(k)) spawnedPids.set(k, []);
  const list = spawnedPids.get(k);
  list.push(pid);
  while (list.length > 16) list.shift();
  return pid;
}
function spawnedPidsFor(name) { return (spawnedPids.get(appKey(name)) || []).slice(); }

/* Which of the app's windows did Zumi itself open? */
function ownedWindows(name) {
  const base = preOpen.get(appKey(name));
  if (!base) return { baseline: false, all: appWindows(name), mine: [] };
  const all = appWindows(name);
  return { baseline: true, all, mine: all.filter((w) => !base.has(w.hwnd)) };
}

function closeApp(name) {
  const { baseline, all, mine } = ownedWindows(name);
  if (!baseline) {
    return { opened_by_zumi: 0, closed: 0, still_open: all.map((w) => w.title),
             note: "I didn't open that one myself, so I left it alone." };
  }
  if (!all.length) {
    preOpen.delete(appKey(name)); spawnedPids.set(appKey(name), []);
    return { opened_by_zumi: 0, closed: 0, still_open: [], note: "nothing is open for that app" };
  }
  if (!mine.length) {
    return { opened_by_zumi: 0, closed: 0, still_open: all.map((w) => w.title),
             note: "only windows you already had open — I left them alone." };
  }
  /* Closing an app can raise a dialog ("Save as?") that keeps it alive, and some
     apps (VS Code) ignore WM_CLOSE outright while they are not the active window,
     so raise the window first and keep posting for several passes. */
  const total = mine.length;
  for (let rounds = 0; rounds < 8; rounds++) {
    const open = ownedWindows(name);
    if (!open.mine.length) break;
    const ids = open.mine.map((w) => w.hwnd);
    ps(`[Reflection.Assembly]::LoadFrom('${ZWIN_DLL}') | Out-Null; `
      + ids.map((h) => `[void][ZWin]::Focus(${h}); [void][ZWin]::Close(${h})`).join("; ")
      + `; Start-Sleep -Milliseconds 1300`);
  }
  const after = ownedWindows(name);
  const left = after.mine.length;
  if (left) {
    /* Keep the ownership record when some windows survive (typically an unsaved-document
       prompt swallowed the WM_CLOSE). Dropping it here made Zumi forget it ever opened
       them, so a later close_app refused to touch its own windows and they leaked. */
    return {
      opened_by_zumi: total,
      closed: total - left,
      still_open: after.mine.map((w) => w.title),
      note: `${total - left} closed, ${left} still open`,
    };
  }
  preOpen.delete(appKey(name)); spawnedPids.set(appKey(name), []);
  return { opened_by_zumi: total, closed: total, still_open: [], note: `closed ${total}` };
}

/* Focus the window that belongs to this app — SendKeys/types go to whatever is in
   front, so without this a planner step can type into the wrong window.
   Prefer the window Zumi opened itself; EnumWindows returns Z-order, so [0] is the
   topmost one, which is normally the window that was just raised. */
function focusApp(name) {
  const owned = ownedWindows(name);
  const list = owned.baseline && owned.mine.length ? owned.mine : owned.all;
  if (!list.length) return { focused: false, note: "no window to focus" };
  const target = list[0];
  const r = ps(`[Reflection.Assembly]::LoadFrom('${ZWIN_DLL}') | Out-Null; [ZWin]::Focus(${target.hwnd})`);
  const ok = /focused/.test(String(r.out || ""));
  return { focused: ok, title: target.title,
           note: ok ? `focused "${target.title}"` : `could not bring "${target.title}" to the front` };
}

/* Electron's main process has NO console, so spawn(cmd) gives console apps no
   window at all: cmd.exe exits instantly (stdio EOF) or runs windowless, and
   `code` is a .cmd that Node refuses to run without a shell. Launch per app. */
const CODE_CMD_CANDIDATES = () => [
  path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "bin", "code.cmd"),
  path.join(process.env.ProgramFiles || "", "Microsoft VS Code", "bin", "code.cmd"),
  path.join(process.env["ProgramFiles(x86)"] || "", "Microsoft VS Code", "bin", "code.cmd"),
];
function resolveCodeCmd() {
  for (const p of CODE_CMD_CANDIDATES()) if (p && fs.existsSync(p)) return p;
  const r = ps("$c = Get-Command code -ErrorAction SilentlyContinue; if ($c) { $c.Source }");
  const s = String(r.out || "").trim().split(/\r?\n/)[0] || "";
  return /\.(cmd|bat)$/i.test(s) && fs.existsSync(s) ? s : "";
}

/* The executable behind code.cmd. Preferred because code.cmd is a batch file:
   Start-Process gives it a real console, and WindowsTerminal kept that window open
   after the CLI exited — so every Zumi "open VS Code" left an empty terminal behind. */
function resolveCodeExe() {
  const cmd = resolveCodeCmd();
  if (cmd) {
    const exe = path.resolve(path.dirname(cmd), "..", "Code.exe");
    if (fs.existsSync(exe)) return exe;
  }
  const guess = path.join(process.env.LOCALAPPDATA || "", "Programs", "Microsoft VS Code", "Code.exe");
  return fs.existsSync(guess) ? guess : "";
}

async function launchApp(name, opts) {
  const k = appKey(name);
  if (k === "browser") return { ok: false, note: "browser is opened by the OS, not by me" };
  notePreOpen(k);
  let detail = "";
  try {
    if (k === "cmd") {
      /* Start-Process hands the console its own visible window; spawn() does not. */
      const r = ps("Start-Process -FilePath cmd.exe -WindowStyle Normal; 'STARTED'");
      if (!/STARTED/.test(r.out)) throw new Error("Start-Process failed");
      detail = "Start-Process cmd.exe";
    } else if (k === "vscode") {
      /* Launch Code.exe directly (no batch shim, so no console window is created).
         With a path, --new-window gives the file its own window so VS Code's session
         restore cannot swap the active tab out from under the title we just reported. */
      const exe = resolveCodeExe();
      const target = exe || resolveCodeCmd();
      if (!target) throw new Error("VS Code not found");
      let arg = "";
      if (opts && opts.path) {
        const quoted = '"' + String(opts.path).replace(/["\r\n]/g, "") + '"';
        arg = ` -ArgumentList '--new-window ${quoted.replace(/'/g, "''")}'`;
      }
      const r = ps(`Start-Process -FilePath '${target}'${arg}; 'STARTED'`);
      if (!/STARTED/.test(r.out)) throw new Error("Start-Process VS Code failed");
      detail = target + (opts && opts.path ? " " + opts.path : "");
    } else if (k === "explorer" && opts && opts.path) {
      /* Opening a folder directly beats driving the address bar: Explorer's CTRL+L /
         ALT+D shortcuts do NOT take focus when sent as synthetic input, so typing a
         path afterwards lands in the file list instead (it becomes type-to-select).
         explorer.exe <folder> opens the window already navigated. */
      const p = String(opts.path).replace(/'/g, "''");
      const r = ps(`Start-Process -FilePath explorer.exe -ArgumentList '${p}'; 'STARTED'`);
      if (!/STARTED/.test(r.out)) throw new Error("Start-Process explorer failed");
      detail = "explorer.exe " + opts.path;
    } else {
      const m = { notepad: "notepad.exe", calculator: "calc.exe", explorer: "explorer.exe", paint: "mspaint.exe", settings: "ms-settings:" };
      const cmd = m[k];
      if (!cmd) throw new Error("unknown app: " + name);
      const child = spawn(cmd, [], { detached: true, stdio: "ignore", shell: false });
      child.on("error", () => { /* reported by the window check below */ });
      try { child.unref(); } catch { /* ignore */ }
      trackSpawn(k, child.pid);
      detail = cmd;
    }
  } catch (e) {
    return { ok: false, note: "could not start " + k + " — " + String(e.message || e).slice(0, 90) };
  }
  /* VS Code with a path: open that file straight through the CLI. Its Ctrl+O does not
     raise the Open dialog when the keystroke is sent synthetically (same class of
     failure as Explorer's Ctrl+L), and the file may land inside an already-open
     window, so verify by TITLE rather than by counting new windows. */
  if (k === "vscode" && opts && opts.path) {
    const base = path.basename(String(opts.path)).toLowerCase();
    const t0 = Date.now();
    let seen = 0;
    for (;;) {
      const found = appWindows(k).find((w) => String(w.title).toLowerCase().includes(base));
      /* Require it twice in a row: a single sample can catch the brief moment before
         VS Code's session restore swaps the active tab and the title changes again. */
      if (found) { if (++seen >= 2) return { ok: true, detail, title: found.title }; }
      else seen = 0;
      /* Generous: on a loaded machine VS Code can sit on its splash for a while
         before the window title picks up the file name. */
      if (Date.now() - t0 > 45000)
        return { ok: false, note: `started vscode, but ${base} never showed up in a window title` };
      await new Promise((r) => setTimeout(r, 600));
    }
  }
  /* Only claim success once a real window exists — no more "opened X" when nothing opened. */
  const t0 = Date.now();
  for (;;) {
    const owned = ownedWindows(k);
    if (owned.mine.length) {
      /* A window existing is NOT the same as the app being ready: VS Code surfaces a
         restored window while it is still loading, and any accelerator sent during
         that window (CTRL+O in particular) is swallowed without error. Hold until the
         window list stops changing. */
      if (k === "vscode") {
        let last = "", stable = 0;
        const t1 = Date.now();
        while (Date.now() - t1 < 9000) {
          const now = ownedWindows(k).mine.map((w) => w.title).join("|");
          if (now && now === last) { if (++stable >= 3) break; } else stable = 0;
          last = now;
          await new Promise((r) => setTimeout(r, 500));
        }
      }
      const after = ownedWindows(k);
      const w = after.mine.length ? after.mine[after.mine.length - 1] : owned.mine[owned.mine.length - 1];
      return { ok: true, detail, title: w.title };
    }
    if (Date.now() - t0 > 10000) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  return { ok: false, note: `started ${k}, but no window appeared` };
}

module.exports = {
  resolve, listDir, mkdir, moveFile, copyFile, renameFile, trashFile, writeText, readText,
  typeText, keyPress, mouseMove, mouseClick, ocr, ocrAvailable, readScreen,
  trackSpawn, spawnedPidsFor, closeApp, notePreOpen, launchApp, focusApp,
  windowList, appWindows, ownedWindows,
  knownFolder: (name) => knownFolders()[KNOWN_NAMES[String(name).toLowerCase()] || name] || null,
  homeFolders: () => Object.values(knownFolders()),
};
