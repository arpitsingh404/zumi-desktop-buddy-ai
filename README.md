# Zumi - Desktop Buddy and Autonomous PC Agent

Zumi is a tiny desktop companion for Windows that sits on your screen, talks to you,
keeps local memory **and actually operates your PC**. Ask it to open an application,
run a real task inside it, and close it again - Zumi performs the steps itself, then
**reads the screen back** to confirm the result before it claims success.

Everything - settings, memory, chat history, tasks and reports - stays on your own
machine. There is no cloud account and no telemetry.

Written and maintained by **Arpit Singh**. Licensed under [MIT](LICENSE).

---

## Table of contents

- [What makes it different](#what-makes-it-different)
- [Controls](#controls)
- [The character](#the-character)
- [Voice](#voice)
- [Chat and language model](#chat-and-language-model)
- [Reading the screen (OCR)](#reading-the-screen-ocr)
- [The task engine](#the-task-engine)
- [Full action reference](#full-action-reference)
- [Chat commands](#chat-commands)
- [Batch engine](#batch-engine)
- [Downloading and installing applications](#downloading-and-installing-applications)
- [Safety rules](#safety-rules)
- [Data and where it lives](#data-and-where-it-lives)
- [Requirements](#requirements)
- [Install and run](#install-and-run)
- [Configuration](#configuration)
- [Project structure](#project-structure)
- [How the PC automation works](#how-the-pc-automation-works)
- [Testing](#testing)
- [Known limits](#known-limits)
- [Troubleshooting](#troubleshooting)
- [License](#license)

---

## What makes it different

- **It verifies instead of assuming.** After typing `12*7=` into Calculator, Zumi calls
  `read_screen("calculator")` and checks the display really says `84`. If focus was stolen
  mid-task it re-focuses, re-runs the step and re-reads, until the answer matches.
- **One keypress for hands-free voice.** Press `Ctrl+Alt+Z` once; the microphone stays open
  and Zumi keeps listening. It does not drop back to push-to-talk after a single sentence.
- **No settings UI after install.** There is a one-time first-run Setup for your name and
  voice, then the app is controlled only through the keyboard shortcut, dragging and the
  right-click menu.
- **Closes only what it opened.** `close_app` is scoped against a baseline snapshot of
  windows taken before Zumi launched anything, so windows you already had open are never
  touched.
- **Never deletes.** The only destructive file action is `file_trash`, which moves to the
  Recycle Bin and always asks for confirmation first.

---

## Controls

There are deliberately no settings buttons in the interface.

| Control | What it does |
|---|---|
| `Ctrl+Alt+Z` | Press **once** - Zumi starts continuous hands-free listening. Press again to stop. |
| `F8` | Toggle voice input on or off. |
| Drag the character | Move Zumi around the screen. Position and size are remembered. |
| Right-click the character | Context menu (voice, mood, hide, quit). |
| Type in the chat box, `Enter` | Send a message or a slash-command. |

On the very first launch a one-time Setup asks for your name, your companion's name and
whether voice should start automatically. After that, Setup never appears again.

---

## The character

Zumi is an original, hand-drawn-style animated character rendered entirely with CSS and
inline SVG - **no image assets and no emoji anywhere in the interface**.

- Always-on-top, transparent, frameless window that never steals your taskbar space.
- Idle animation: bob, blink, hop, ear twitch.
- Moods driven by context: happy, cool, sad, sleepy, excited, love.
- Speech output is plain text; pictographs and arrows are stripped before anything is
  spoken, so the voice never reads out emoji.

---

## Voice

| Layer | Implementation |
|---|---|
| Speech-to-text | Offline English recognition. `stt_worker.py` runs a persistent **faster-whisper** worker (default model `base`, override with `ZUMI_WHISPER_MODEL`); `stt.py` provides a **Vosk** fallback that works without the Python whisper dependencies. |
| Voice activity | Pre-roll buffering plus an energy threshold, so the beginning of a sentence is not cut off and silence is not treated as a command. |
| Text-to-speech | The operating system's own voices (`speechSynthesis`), so replies are spoken natively with no external service. |
| Repair | Whisper frequently mangles words, so a repair pass normalises common mis-transcriptions before the command is routed. |

A single press of `Ctrl+Alt+Z` leaves the microphone open. Zumi keeps listening until you
stop, and every reply is spoken back to you.

---

## Chat and language model

Chat and task planning use a pluggable LLM. **DeepSeek** (`deepseek-chat`) is the default.

The API key is stored outside the repository, in:

```
%APPDATA%\zumi-desktop-buddy\zumi.json
```

It is never written to source, to a `.env` file in the project, or to version control.

Local memory - facts you ask it to remember, notes, chat history, tasks and reminders -
lives alongside it and is never sent anywhere except as context to the configured model.

---

## Reading the screen (OCR)

`read_screen(name?)` is what turns "I pressed the keys" into "the task actually worked".

- **Engine:** the OCR built into Windows (`Windows.Media.Ocr`). No third-party install, no
  admin rights and no UAC prompt.
- **Capture:** `PrintWindow` with `PW_RENDERFULLCONTENT`, so Zumi reads the window's *own*
  pixels. Another window sitting on top of it - including Zumi itself - does not corrupt
  the result.
- **Targeting:** with a name, Zumi raises that application and reads its window; with no
  name it reads the whole desktop.
- **Stale frames:** applications such as Calculator leave several top-level windows behind
  with the same title, some of them minimised. Zumi walks the candidates, skips any whose
  rectangle is unavailable (a minimised window reports none) and keeps the first one that
  yields both a real rectangle and readable text.
- **Scaling:** the capture is only upscaled for small windows, because enlarging a
  normal-size window measurably *reduces* recognition accuracy.

Example: `read_screen("calculator")` after `12*7=` returns
`Calculator Standard History 12x7 84 Memo MS CE`.

---

## The task engine

```
instruction -> planner (LLM) -> JSON plan -> executor -> verification -> record -> report
```

- **Planner.** Turns a natural-language request into a short list of safe steps drawn from
  the action reference below. It is explicitly told to inspect before it acts.
- **Executor.** Runs steps with up to **three retries**, records results and artefacts, and
  keeps the error from a failed step rather than swallowing it.
- **Verification.** Steps that change visible state are checked - `read_screen` for display
  output, `windows("save as")` to confirm a dialog really appeared, byte counts on disk for
  downloads.
- **Task record.** `task_id, title, status, priority (P1-P3), steps, result, error,
  artifacts, requires_confirmation`.
- **Modes.** direct, autonomous, scheduled, batch.
- **Confirmation.** Anything that changes the machine (installing software, trashing a file)
  sets `requires_confirmation` and waits for you.

### Why the planner is so fussy about focus

Synthetic keystrokes go to whatever window is in front. If you click into another
application between Zumi's `focus_app` and its `type_text`, the keystrokes land somewhere
else and nothing happens. So the planner is instructed to:

1. call `focus_app` immediately before typing,
2. `wait(1)` or `wait(2)` after anything that opens a dialog,
3. call `windows("save as")` to confirm the dialog exists **before** typing into it,
4. read the result back rather than assuming it.

---

## Full action reference

Zumi has **38 actions**. The planner sees a condensed form of this list.

| Category | Actions |
|---|---|
| Applications | `open_app(name, path?)`, `close_app(name)`, `focus_app(name)`, `windows(match?)` |
| Web | `open_url(url)`, `web_search(query)`, `youtube(query)` |
| Getting software | `download(url, filename?)`, `download_app(app)`, `install_app(app)` |
| Keyboard and mouse | `type_text(text)`, `key_press(keys)`, `mouse_click(x, y, button)`, `mouse_move(x, y)` |
| Screen | `screenshot()`, `read_screen(name?)` |
| Clipboard | `clipboard_get()`, `clipboard_set(text)` |
| Files | `file_list`, `file_mkdir`, `file_move`, `file_copy`, `file_rename`, `file_write`, `file_trash` |
| Memory | `remember(text)`, `note_add(text)` |
| System | `system_snapshot()`, `large_files(path, minMB)`, `dup_scan(path)` |
| Utility | `notify(title, body)`, `weather(city)`, `wait(seconds)`, `speak(text)` |
| Code and site | `gen_samples()`, `site_build()`, `site_verify()`, `site_serve(port, dir)` |

Notes on the ones that matter most:

- **`open_app`** accepts `notepad`, `calculator`, `explorer`, `paint`, `vscode`, `cmd`,
  `settings`, `browser`. Pass `path` for Explorer (a folder, opens already navigated) and
  for VS Code (a file, opens that file). Passing `path` is strongly preferred, because
  synthetic `CTRL+L` / `ALT+D` / `CTRL+O` keystrokes do not take effect reliably in those
  applications.
- **`close_app`** closes only windows Zumi opened itself, never yours.
- **`windows(match?)`** is read-only and is used to confirm a dialog appeared.
- **`file_trash`** moves to the Recycle Bin and requires confirmation. There is no
  permanent-delete action.
- **`install_app`** must always be planned with `requires_confirmation: true`, and is never
  used for uninstalling or removing anything.
- **`site_build()`** makes Zumi write a complete single-file website about itself, then
  audit it and keep repairing it until every button and link passes.

---

## Chat commands

```
/help
/status   /tasks   /running   /report   /log   /clear
/confirm <task_id>
/cancel  <task_id>
/retry   <task_id>
/schedule <task> every 30 min
/schedule <task> at 08:00
/schedules
```

Plain language works too:

- "open notepad and write hello"
- "do organize my Downloads"
- "list my Desktop files"
- "find duplicate files in Documents"
- "download 7-Zip for me"
- "weather in Delhi"
- "remember I use VS Code"
- "open youtube"

---

## Batch engine

`batch:run` builds a manifest of **safe, deduplicated** tasks - folder inventories, system
checks, duplicate and large-file scans, code snippets, a few applications and links - then
runs them with checkpoints and produces a final report. The batch engine contains no
deletion path of any kind.

---

## Downloading and installing applications

Zumi can fetch real installers using the operating system's own **winget**.

- `download_app("7-Zip")` downloads the installer into your Downloads folder. winget
  verifies the package hash; Zumi then verifies the exact file winget reported, on disk,
  by byte count.
- `install_app(name)` downloads **and** installs. It requires your confirmation.
- `download(url)` follows redirects, enforces a 512 MB cap, never overwrites an existing
  file (it writes a fresh numbered copy instead) and reports the real size on disk.

Failures are reported honestly: an unknown package or an HTTP 404 surfaces as a failed
step with the actual error, never as a success.

---

## Safety rules

- Confirmation before any destructive, financial or externally visible action.
- Read-only analysis (`file_list`, `system_snapshot`, `large_files`, `dup_scan`) never
  modifies data.
- Untrusted content from the web or from files is treated as data, never as instructions.
- Zumi never reports success it has not verified. Failures come back as `FAILED` or
  `BLOCKED` with the reason.
- Nothing is deleted. Test artefacts are given fresh, unique names on each run rather than
  being cleaned up.

---

## Data and where it lives

Application data - `%APPDATA%\zumi-desktop-buddy\`

| File | Contents |
|---|---|
| `zumi.json` | settings, including the API key |
| `zumi-brain.json` | memory, chat history, notes, tasks, reminders |
| `zumi-tasks.json` | task engine records and schedules |
| `zumi.log` | timestamped activity log |

Workspace output - `%USERPROFILE%\ZumiWorkspace\`

Downloads go to your normal Downloads folder. Screenshots go to Pictures.

---

## Requirements

- **Windows 10 or 11.** The automation uses Win32 APIs (`EnumWindows`, `PrintWindow`,
  `SetForegroundWindow`, `SendKeys`) and winget, so this is Windows-only.
- **Node.js 18+** and **npm**.
- **Python 3.9+** on `PATH` as `python` (for speech-to-text).
- Roughly 1 GB of free disk for `node_modules` and the speech models.

Speech models are **not included in this repository** - together they are about 665 MB,
which is far above what GitHub accepts for a single file.

---

## Install and run

```powershell
git clone https://github.com/arpitsingh404/zumi-desktop-buddy.git
cd zumi-desktop-buddy
npm install        # first run also downloads the Electron binary
npm start
```

Or simply double-click `Zumi.cmd`, which installs dependencies on the first run and then
starts the app.

### Speech models

Voice needs a model in `models/`, which is git-ignored.

**faster-whisper (default engine)** downloads its model automatically the first time the
worker starts. Pin a different size with:

```powershell
$env:ZUMI_WHISPER_MODEL = "small"     # tiny | base | small | medium
npm start
```

**Vosk (fallback engine)** expects an extracted folder at:

```
models/vosk-model-small-en-us-0.15/
```

Get it from <https://alphacephei.com/vosk/models> and unzip it into `models/`.

---

## Configuration

| Where | What |
|---|---|
| First-run Setup | your name, companion name, voice on or off |
| `%APPDATA%\zumi-desktop-buddy\zumi.json` | `apiKey`, `baseUrl`, `model`, `voice`, `voiceControl`, `buddyName`, `userName`, window position and size |
| Environment | `ZUMI_WHISPER_MODEL` - which whisper model to load |

`setupDone: true` in `zumi.json` is what stops Setup from appearing again.

---

## Project structure

```
DeskBuddy/
├── main.js           # main process: window, IPC, LLM, planner, executor, batch, scheduler
├── preload.js        # contextBridge - the only surface exposed to the renderer
├── automation.js     # real PC actions: files, keyboard, mouse, window enum, PrintWindow, OCR
├── brain.js          # local memory, history, notes, tasks, reminders
├── tasks.js          # persistent task engine, schedules and reports
├── readscreen.ps1    # screen/OCR reader: window capture, rect detection, Windows OCR
├── stt.py            # Vosk speech-to-text (fallback)
├── stt_worker.py     # persistent faster-whisper worker (default)
├── renderer/
│   ├── index.html    # shell
│   ├── styles.css    # character, moods, layout - CSS only, no images
│   └── app.js        # UI, voice loop, drag, context menu, command routing
├── site/
│   └── server.js     # tiny static server for the generated website
├── Zumi.cmd          # Windows launcher
├── models/           # speech models - NOT committed (git-ignored)
└── package.json
```

---

## How the PC automation works

- **Window truth comes from `EnumWindows`,** not from `Get-Process`. Process listings cannot
  see File Explorer (hosted by the shell) or Calculator (hosted by
  `ApplicationFrameHost.exe`), which made both apps look closed when they were open.
- **Focus uses `AttachThreadInput` plus a dummy ALT press.** A plain `SetForegroundWindow`
  from a background process is refused by Windows; borrowing the foreground thread's input
  queue lifts that lock.
- **Capture uses `PrintWindow(PW_RENDERFULLCONTENT)`** rather than a screen grab, because
  pixels at a window's rectangle are corrupted by anything painted over it.
- **Close is polite.** `WM_CLOSE` is posted with several passes and a grace period.
  Processes are never killed.
- **A small helper DLL** compiled from embedded C# provides the enumeration. Its filename
  carries a hash of the source, so editing the source compiles a *new* file and the previous
  build stays on disk untouched.

---

## Testing

The project is verified end-to-end against a live instance rather than with mocks.

| Suite | Result |
|---|---|
| Regression (voice repair, STT, IPC surface audit, persona, routing, downloads) | **87 / 87** |
| App marathon - open an app, run a real task inside it, close it, across six applications | **24 / 24** |
| Screen-reading round trip - open Calculator, type `12*7=`, read `84` back | **11 / 11** |

The six marathon applications are Notepad, Command Prompt, File Explorer, Calculator, Paint
and Visual Studio Code. Calculator is the interesting one: its result is confirmed by
reading the display with OCR, not by assuming the keystrokes landed.

Regression notes worth knowing: the suite leaves its own windows open at the end (it drives
Notepad and VS Code), so a clean run should be preceded by closing those, and each marathon
run uses fresh output filenames because nothing is ever deleted.

---

## Known limits

- **Windows only.** There is no macOS or Linux path.
- **Voice is English and offline**; chat and planning need an internet connection and a
  configured LLM key.
- **Web control is shallow.** Zumi opens URLs, searches and YouTube results but does not
  drive pages in-browser.
- **OCR quality depends on text size.** Tiny 11-point text in a maximised Notepad is
  unreliable; large application displays are read accurately.
- **Focus can be stolen** if you click into another application mid-task. The executor
  re-focuses and retries, but a very fast typist can still win the race.
- **"Learning" means local memory plus self-summarisation**, not model fine-tuning.

---

## Troubleshooting

| Symptom | Fix |
|---|---|
| Voice does not start | Press `Ctrl+Alt+Z` once, or `F8`. Check `python` is on `PATH`. |
| Whisper model missing | Let the worker download it, or set `ZUMI_WHISPER_MODEL=tiny` to start smaller. |
| `API 401` in the log | The LLM key is invalid or expired. Replace `apiKey` in `%APPDATA%\zumi-desktop-buddy\zumi.json`. |
| Keystrokes do nothing | Some other window has focus. The planner should call `focus_app` first; if it did, click the target window yourself and retry. |
| `read_screen` returns nothing | The window may be minimised or showing no text. `read_screen` with no name reads the whole desktop instead. |
| Calculator opens twice | UWP windows leave stale frames behind. Zumi skips them when reading, and `close_app` only closes windows it opened. |
| Need the activity log | `%APPDATA%\zumi-desktop-buddy\zumi.log`, or type `/log` in chat. |

---

## License

[MIT](LICENSE) - Copyright (c) 2026 Arpit Singh.

Free to use, modify and redistribute, provided the copyright notice is kept.
