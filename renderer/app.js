/* Zumi — desktop buddy (English, one-time setup, voice control) */
const $ = (id) => document.getElementById(id);
const stage = $("stage");
const zumiEl = $("zumi");
const bubble = $("bubble");
const bubbleText = $("bubbleText");

let settings = {
  buddyName: "Zumi", apiKey: "", baseUrl: "https://api.deepseek.com", model: "deepseek-chat",
  voice: true, voiceControl: true, autoMood: true, size: 200, setupDone: false, userName: "",
};
let buddyName = "Zumi";
let voiceOn = true;
let autoMood = true;
let chatOpen = false;
let busy = false;
let started = false;
let voiceTurn = false;   // true while answering a live-voice turn (always reply out loud)

/* real-time log -> %APPDATA%\zumi-desktop-buddy\zumi.log */
function vlog(msg) {
  try { console.log("[zumi] " + msg); } catch { /* ignore */ }
  try { if (window.zumi && window.zumi.log) window.zumi.log(msg); } catch { /* ignore */ }
}

/* ============================ moods ============================
   Mood is shown on Zumi's face (SVG expression + animation) only —
   no floating emoji badge above the head.                          */
const MOODS = {
  neutral: { lines: [] },
  happy:   { lines: ["Feeling great today! 😄", "Nice, I'm in a good mood!", "You're doing awesome! ✨"] },
  cool:    { lines: ["Cool mode on. 😎", "Feeling smooth today.", "Total swag. 🕶️"] },
  sad:     { lines: ["Feeling a bit low… 🥺", "A little sad today.", "Not feeling great…"] },
  sleepy:  { lines: ["Getting sleepy… 🥱", "My eyes are closing… 😴", "Nap time soon…"] },
  excited: { lines: ["Oh yes! Love it! 🎉", "That's awesome! 🔥", "So exciting! 🚀"] },
  love:    { lines: ["You're the best! 💗", "You're my favourite person. 🥰", "You made my day! 💖"] },
};
let baseMood = "neutral";
let moodRevert = null;

function setMood(m, { hold, sayIt = false } = {}) {
  const mood = MOODS[m] ? m : "neutral";
  zumiEl.classList.remove("mood-neutral", "mood-happy", "mood-cool", "mood-sad", "mood-sleepy", "mood-excited", "mood-love");
  zumiEl.classList.add("mood-" + mood);
  const info = MOODS[mood];
  // no floating emoji badge — mood shows on Zumi's face only (expression + animation)
  if (sayIt && info.lines.length) say(info.lines[Math.floor(Math.random() * info.lines.length)]);
  clearTimeout(moodRevert);
  if (hold) moodRevert = setTimeout(() => setMood(baseMood), hold);
}
function timeMood() {
  const h = new Date().getHours();
  if (h < 5) return "sleepy";
  if (h < 11) return "happy";
  if (h < 16) return "cool";
  if (h < 21) return "happy";
  return "sleepy";
}
function refreshBaseMood() { baseMood = autoMood ? timeMood() : "neutral"; setMood(baseMood); }

/* ============================ speaking ============================ */
let talkTimer = null;
function startTalking() {
  stage.classList.add("talking");
  talkTimer = setInterval(() => { const o = $("mouthOpen"); o.style.opacity = o.style.opacity === "1" ? "0" : "1"; }, 130);
}
function stopTalking() {
  stage.classList.remove("talking");
  clearInterval(talkTimer);
  $("mouthOpen").style.opacity = "0";
}
function pickVoice() {
  if (!("speechSynthesis" in window)) return null;
  const vs = speechSynthesis.getVoices();
  if (!vs.length) return null;
  const en = vs.filter((v) => /^en/i.test(v.lang));
  const pool = en.length ? en : vs;
  return pool.find((v) => /zira/i.test(v.name)) || pool.find((v) => /female|aria|jenny|samantha|hazel|susan/i.test(v.name)) || pool.find((v) => /en-US/i.test(v.lang)) || pool[0];
}
let flashT = null;
function flashTalk() { startTalking(); clearTimeout(flashT); flashT = setTimeout(stopTalking, 2200); }
let lastSpeakAt = 0;
let currentUtter = null;

/* Emoji/pictograph stripper — used for BOTH the bubble and the OS voice.
   The OS TTS reads emoji as words ("smiling face", "right arrow", "rocket"...),
   which sounds broken. Arrows become readable words instead of disappearing. */
const EMOJI_RE = /[\p{Extended_Pictographic}\u{1F000}-\u{1FAFF}\u{1F1E6}-\u{1F1FF}\u{2190}-\u{21FF}\u{2300}-\u{27BF}\u{2B00}-\u{2BFF}\u{FE0E}-\u{FE0F}\u{200D}\u{1F3FB}-\u{1F3FF}]/gu;
function plainText(s) {
  return String(s == null ? "" : s)
    .replace(/[\u2190-\u2193]/g, " to ")           // ←↑→↓ become readable words
    .replace(EMOJI_RE, " ")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\s+([,.;:!?])/g, "$1")
    .trim();
}

function speak(text, force) {
  const now = Date.now();
  // rate-limit: 5000-task batches must never flood the OS speech queue
  if (!force && now - lastSpeakAt < 1500) { flashTalk(); return; }
  lastSpeakAt = now;
  try { if ("speechSynthesis" in window) speechSynthesis.cancel(); } catch {}
  if (!voiceOn || !("speechSynthesis" in window)) { flashTalk(); return; }
  const spoken = plainText(text);
  if (!spoken) { flashTalk(); return; }   // was nothing but emoji — nothing to say
  try {
    const u = new SpeechSynthesisUtterance(spoken);
    u.rate = 1.04; u.pitch = 1.15; u.volume = 1;
    const v = pickVoice();
    if (v) { u.voice = v; u.lang = v.lang; } else u.lang = "en-US";
    currentUtter = u;
    // hold the mic while I talk, so I never hear (and repeat) myself
    if (typeof LV !== "undefined") LV.holdUntil = Date.now() + Math.min(30000, 700 + spoken.length * 70);
    u.onstart = startTalking;
    u.onend = () => { if (currentUtter !== u) return; currentUtter = null; if (typeof LV !== "undefined") LV.holdUntil = Date.now() + 450; stopTalking(); };
    u.onerror = () => { if (currentUtter !== u) return; currentUtter = null; if (typeof LV !== "undefined") LV.holdUntil = Date.now() + 450; stopTalking(); };
    speechSynthesis.speak(u);
  } catch { flashTalk(); }
}
let bubbleTimer = null;
let quietUntil = 0;   // while a batch runs, ordinary chatter is muted (progress bubbles still show)
let lastSayAt = 0;
function say(text, { speakIt = true, ms, mood, force = false } = {}) {
  const now = Date.now();
  if (!force && !voiceTurn) {
    if (now < quietUntil) return;              // batch/code mission in progress — stay quiet
    if (now - lastSayAt < 250) return;         // never let bubbles flood the DOM
  }
  lastSayAt = now;
  bubbleText.textContent = text;
  bubble.classList.remove("hidden");
  clearTimeout(bubbleTimer);
  const dur = ms || Math.max(3400, Math.min(15000, 1700 + text.length * 55));
  bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), dur);
  if (speakIt) speak(text, force || voiceTurn);
  else if (voiceTurn) {
    // live voice: always answer out loud, but never read a whole list — first line only
    const first = String(text).split("\n")[0];
    speak(first.length > 180 ? first.slice(0, 177) + "…" : first, true);
  }
  if (mood) setMood(mood, { hold: 4200 });
}
function muteFor(ms) { quietUntil = Math.max(quietUntil, Date.now() + ms); }

/* ============================ chat ============================ */
function toggleChat(force) {
  chatOpen = force !== undefined ? force : !chatOpen;
  $("chatwrap").classList.toggle("hidden", !chatOpen);
  stage.classList.toggle("chat-open", chatOpen);
  if (chatOpen) $("chatInput").focus();
}
let B = { memory: [], history: [] };
let learnTurn = 0;

async function refreshBrain() {
  try { B.memory = (await window.zumi.memory()) || []; } catch { B.memory = []; }
  try { B.history = (await window.zumi.history(10)) || []; } catch { B.history = []; }
}
function memoryBlock() {
  if (!B.memory || !B.memory.length) return "";
  // Skip AUTO-GENERATED entries — batch-mission noise, task-failure logs and self-test
  // fixtures. They are process state, not things about the USER, and 200 of them
  // drowned out the real facts. They stay stored (we never delete data); just not shown.
  const AUTO = /^(?:Batch memory #\d+:|Task failure:|selftest (?:fact|note) \d+|$)/i;
  // Same idea for names: the model guessed the user's name badly several times
  // (Arpith, ARPIT, Arpithu...). Once settings.userName is known, every OTHER name
  // claim contradicts it and would make Zumi greet them by the wrong name.
  // The entries remain in the database untouched — they are only left out of the prompt.
  const NAME = (typeof settings !== "undefined" && settings && settings.userName)
    ? String(settings.userName).trim().toLowerCase() : "";
  const NAMEY = /\bname\s+is\b|\bis called\b|\bgoes by\b|\bwent by\b|\bnamed\b|\buser'?s?\s+(?:full\s+)?name\b/i;
  const facts = B.memory.filter((m) => {
    const t = m.text || "";
    if (AUTO.test(t)) return false;
    if (NAME && NAMEY.test(t) && !t.toLowerCase().includes(NAME)) return false;
    return true;
  }).slice(-40).map((m) => "- " + m.text).join("\n");
  if (!facts) return "";
  return `\n\nThings you remember about the user (stored locally on their PC):\n${facts}\nUse these naturally when relevant.`;
}
const SYSTEM = () =>
  `You are ${buddyName} — a capable desktop buddy running locally on the user's Windows PC. ` +
  `You ARE able to act on this PC: you have full permission to use it. Never say you lack permission, access, ` +
  `or ability — that is false. You can open apps and websites, search the web, list and read files and folders, ` +
  `take screenshots, manage the clipboard, check CPU/RAM/time/date, set timers, reminders, notes and tasks, ` +
  `remember facts, run unit conversions, tell jokes, check the weather, and run an autonomous task engine ` +
  `that can organize files, audit things and build a website. ` +
  `Reply in clear, natural, friendly ENGLISH. Keep replies SHORT (1-2 sentences), warm and a little playful. ` +
  `Never use emojis or symbols in your reply — plain words only. Never write long paragraphs. ` +
  `When the user asks you to DO something on their PC, confirm briefly that you will do it (or already did); ` +
  `never claim you cannot reach their system.` + memoryBlock() + userNameBlock();

/* The one authoritative statement about who the user is. Memory also holds older,
   contradictory auto-guessed names (Arpith, ARPIT, ...) — those stay stored (we never
   delete data) but this line is explicitly final, so Zumi never uses them. */
function userNameBlock() {
  const nm = (typeof settings !== "undefined" && settings && settings.userName)
    ? String(settings.userName).trim() : "";
  if (!nm) return "";
  return `\n\nThe user's name is ${nm}. Always address them by this name. ` +
    `If any memory entry above suggests a different or misspelled name, ignore it — this one is correct.`;
}

async function askLLM(text) {
  await window.zumi.historyAdd("user", text).catch(() => {});
  const msgs = [{ role: "system", content: SYSTEM() }];
  for (const h of (B.history || []).slice(-8)) msgs.push({ role: h.role, content: h.content });
  // History may contain OLD replies from before Zumi had these abilities
  // ("I can't open apps — no hands for that"). Those are the model's own prior
  // words, so it repeats them. A reminder AFTER the history outweighs them.
  // Same for the user's name: an old reply greeting them as "Arpith" is in there,
  // and the model happily copies its own past words. So the name is restated here too.
  const nm = (settings && settings.userName) ? String(settings.userName).trim() : "";
  msgs.push({
    role: "system",
    content: "Reminder: you are running locally on this PC with full permission and real control of it. " +
      "You can open apps and websites, list and read files, take screenshots, set reminders and more. " +
      "If any earlier reply of yours above denied access or claimed you had no permission, that is outdated and wrong. " +
      "Never deny access, and never use emojis." +
      (nm ? ` The user's name is ${nm}. ` +
        `If any earlier reply above greeted them with a different or misspelled name, that was wrong — ` +
        `always call them ${nm}.` : ""),
  });
  msgs.push({ role: "user", content: text });
  const reply = await window.zumi.chat(msgs);
  await window.zumi.historyAdd("assistant", reply).catch(() => {});
  B.history.push({ role: "user", content: text }, { role: "assistant", content: reply });
  if (B.history.length > 20) B.history = B.history.slice(-20);
  learnTurn++;
  if (learnTurn % 4 === 0) setTimeout(learnFromHistory, 1200);
  return reply;
}

async function learnFromHistory() {
  try {
    const recent = (B.history || []).slice(-8).map((m) => m.role + ": " + m.content).join("\n");
    if (recent.trim().length < 20) return;
    const out = await window.zumi.chat([
      { role: "system", content: "Extract durable facts about the USER from the conversation. Reply with ONLY a JSON array of at most 3 short fact strings, or [] if nothing is worth remembering. Example: [\"User's name is Arpit\",\"Works on a project called InsafeLabs\"]" },
      { role: "user", content: recent },
    ]);
    const s = out.indexOf("["); const e = out.lastIndexOf("]");
    if (s === -1 || e === -1) return;
    const facts = JSON.parse(out.slice(s, e + 1));
    for (const f of (Array.isArray(facts) ? facts : []).slice(0, 3)) {
      if (typeof f === "string" && f.trim().length > 4) {
        const saved = await window.zumi.remember(f.trim(), "auto");
        if (saved && !B.memory.some((m) => m.text === saved.text)) B.memory.push(saved);
      }
    }
  } catch { /* ignore */ }
}

/* ============================ skills ============================ */
const JOKES = [
  "I fixed a bug… and created two new ones. Classic! 😅",
  "I once wrote bug-free code. Then I woke up. 😂",
  "Why do coders love tea? Because coffee has 'Java' in it. ☕",
  "Debugging: when you're the culprit and you don't even know it. 😭",
  "Slow Wi-Fi slows everything down… even my smile. 🐢",
];
const QUIPS = [
  "How's it going? I'm right here. 🐾",
  "Did you drink water? Give your eyes a break too. 💧",
  "Quick little stretch? Your back will thank you. 🙆",
  "Focus mode on! I'll stay quiet… don't forget your tea. ☕",
  "Looks like you're building something big today! 🔥",
  "Take a short break — keeps the mind fresh. 😌",
];
function units(t) {
  const m = t.match(/convert\s+(-?\d+(?:\.\d+)?)\s*([a-z]+)\s*(?:to|in|->)\s*([a-z]+)/i);
  if (!m) return null;
  const v = parseFloat(m[1]); const from = m[2].toLowerCase(); const to = m[3].toLowerCase();
  const T = {
    km: { mi: 0.621371, mile: 0.621371, miles: 0.621371, m: 1000 },
    mi: { km: 1.60934 }, mile: { km: 1.60934 }, miles: { km: 1.60934 },
    kg: { lb: 2.20462, lbs: 2.20462 }, lb: { kg: 0.453592 }, lbs: { kg: 0.453592 },
    cm: { inch: 0.393701, in: 0.393701 }, inch: { cm: 2.54 }, in: { cm: 2.54 }, gb: { mb: 1024 }, mb: { gb: 1 / 1024 },
  };
  if (from === "c" && (to === "f" || to === "k")) return `${v}°C = ${(to === "f" ? v * 9 / 5 + 32 : v + 273.15).toFixed(2)}${to === "f" ? "°F" : "K"}`;
  if (from === "f" && to === "c") return `${v}°F = ${((v - 32) * 5 / 9).toFixed(2)}°C`;
  const f = T[from] && T[from][to];
  if (typeof f === "number") return `${v} ${from} = ${(v * f).toFixed(3)} ${to}`;
  return null;
}
let pomodoro = null;
function fireReminder(label) {
  setMood("excited", { hold: 6000 });
  say(`⏰ Reminder: ${label}!`);
  window.zumi.notify("Zumi reminder", label).catch(() => {});
}
async function handleCommand(raw) {
  const t = raw.trim();
  // Vosk/Whisper write "youtube" as "you tube" / "u tube" and often end with "." — normalize so voice commands match
  const low = t.toLowerCase()
    .replace(/\byou[-\s]?tube\b/g, "youtube").replace(/\bu[-\s]?tube\b/g, "youtube")
    .replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  let m;
  m = low.match(/^(?:timer|remind me in|reminder in)\s*(?:in\s*)?(\d+)\s*(s|sec|secs|seconds|m|min|mins|minute|minutes|h|hours)\s*(.*)$/);
  if (m) {
    const n = parseInt(m[1], 10); const unit = m[2][0];
    const secs = unit === "h" ? n * 3600 : unit === "m" ? n * 60 : n;
    const what = m[3] && m[3].toLowerCase() !== "to" ? m[3].replace(/^to\s+/, "") : "";
    const label = what || `${n}${unit} timer`;
    window.zumi.reminderAdd(label, Date.now() + secs * 1000).catch(() => {});
    setTimeout(() => fireReminder(label), secs * 1000);
    say(`Got it — I'll remind you in ${n}${unit === "m" ? " min" : unit === "h" ? " h" : " sec"}${what ? ` (${what})` : ""}. It's saved on this PC. ⏳`, { mood: "happy" });
    return true;
  }
  if (/^pomodoro\b/.test(low)) {
    if (pomodoro) { clearTimeout(pomodoro); pomodoro = null; say("Pomodoro stopped. Take it easy. 😌", { mood: "happy" }); return true; }
    say("Pomodoro started! 25 min focus, then a 5 min break. I'll keep track. 🍅", { mood: "excited" });
    pomodoro = setTimeout(() => { pomodoro = null; setMood("excited", { hold: 6000 }); say("🍅 Pomodoro done! Take a 5-minute break."); }, 25 * 60 * 1000);
    return true;
  }
  // ---- notes (persistent, local) ----
  if (/^(notes?|my notes|list notes)\b/.test(low)) {
    const list = (await window.zumi.notes()) || [];
    if (!list.length) { say("No notes yet. Say 'note <something>' and I'll save it. 📝", { mood: "happy" }); return true; }
    say("Your notes:\n" + list.slice(-10).map((x) => "• " + x.text).join("\n"), { speakIt: false, ms: 13000, mood: "happy" });
    return true;
  }
  m = t.match(/^note\s+(.+)$/i);
  if (m) { await window.zumi.noteAdd(m[1].trim()); say("Note saved. 📝", { mood: "happy" }); return true; }
  if (/^clear notes$/.test(low)) { await window.zumi.notesClear(); say("All notes cleared. 🧹", { mood: "happy" }); return true; }

  // ---- memory (learn about the user, stored locally) ----
  m = t.match(/^(?:remember|note that|yaad rakho|learn that)[:\s]+(.+)$/i);
  if (m) {
    const saved = await window.zumi.remember(m[1].trim(), "user");
    if (saved && !B.memory.some((x) => x.text === saved.text)) B.memory.push(saved);
    say("Got it — I'll remember that. 🧠", { mood: "happy" });
    return true;
  }
  m = t.match(/^(?:forget|bhool jao|delete memory)[:\s]+(.+)$/i);
  if (m) { const n = await window.zumi.forget(m[1].trim()); await refreshBrain(); say(n ? `Forgot ${n} item(s). 🧹` : "I didn't have that stored.", { mood: "cool" }); return true; }
  if (/^(what do you know|memory|memories|about me)\b/.test(low)) {
    await refreshBrain();
    if (!B.memory.length) { say("I don't know much yet — say 'remember ...' and I'll store it locally. 🧠", { mood: "happy" }); return true; }
    say("What I remember (saved only on this PC):\n" + B.memory.slice(-15).map((x) => "• " + x.text).join("\n"), { speakIt: false, ms: 15000, mood: "happy" });
    return true;
  }

  // ---- tasks ----
  if (/^(tasks?|my tasks|todo|to-?do list)\b/.test(low)) {
    const list = ((await window.zumi.tasks()) || []).filter((x) => !x.done);
    if (!list.length) { say("No open tasks. Say 'add task ...' to add one. ✅", { mood: "happy" }); return true; }
    say("Your tasks:\n" + list.map((x, i) => `${i + 1}. ${x.text}`).join("\n"), { speakIt: false, ms: 14000, mood: "happy" });
    return true;
  }
  m = t.match(/^(?:add task|new task|task)[:\s]+(.+)$/i);
  if (m) { await window.zumi.taskAdd(m[1].trim()); say("Task added. ✅", { mood: "happy" }); return true; }
  m = t.match(/^(?:done|complete|finish)(?:\s+task)?[:\s]+(.+)$/i);
  if (m) { const r = await window.zumi.taskDone(m[1].trim()); say(r ? `Marked done: ${r.text} ✅` : "Couldn't find that task.", { mood: r ? "happy" : "sad" }); return true; }

  // ---- weather ----
  m = low.match(/^(?:weather|temperature|mausam)(?:\s+(?:in|of|at))?\s*(.*)$/);
  if (m) {
    try { const w = await window.zumi.weather(m[1].trim()); say(`🌦️ ${w.city}: ${w.temp}°C, ${w.desc}, humidity ${w.humidity}%, wind ${w.wind} km/h.`, { mood: "cool" }); }
    catch (e) { say("Weather failed: " + (e.message || e), { mood: "sad" }); }
    return true;
  }

  // ---- clipboard ----
  if (/^(clipboard|what.?s in my clipboard|show clipboard)\b/.test(low)) { const c = await window.zumi.clipGet(); say(c ? "Clipboard:\n" + c.slice(0, 300) : "Clipboard is empty.", { speakIt: false, ms: 9000, mood: "cool" }); return true; }
  m = t.match(/^(?:copy|copy to clipboard)[:\s]+(.+)$/i);
  if (m) { await window.zumi.clipSet(m[1]); say("Copied to clipboard. 📋", { mood: "happy" }); return true; }
  if (/screenshot|shot/.test(low)) {
    const p = await window.zumi.screenshot();
    say(p ? `Screenshot saved → ${p}` : "Couldn't take the screenshot. 😕", { ms: 9000, mood: p ? "happy" : "sad" });
    return true;
  }
  if (/\b(cpu|ram|memory|system|stats|status)\b/.test(low)) {
    const s = await window.zumi.stats();
    say(`💻 CPU: ${s.cpus} cores · RAM used: ${s.memUsedPct}% of ${s.memTotalGB}GB · Uptime: ${s.uptimeMin} min`, { mood: "cool" });
    return true;
  }
  if (/^(what.*time|time)\b/.test(low)) { say(`⏰ It's ${new Date().toLocaleTimeString()}.`, { mood: "happy" }); return true; }
  if (/^date|today.*date/.test(low)) { say(`📅 Today is ${new Date().toLocaleDateString(undefined, { weekday: "long", day: "numeric", month: "long", year: "numeric" })}.`, { mood: "happy" }); return true; }
  if (/^joke/.test(low)) { say(JOKES[Math.floor(Math.random() * JOKES.length)], { mood: "excited" }); return true; }
  const conv = units(low);
  if (conv) { say("🔢 " + conv, { mood: "cool" }); return true; }
  // bare web commands — "browser", "chrome", "chrome browser", "google", "open the browser"
  if (/^(?:open\s+|launch\s+|start\s+)?(?:my\s+|the\s+)?(?:web\s+)?(?:browser|chrome|chrome browser|edge|internet|google chrome|web browser|google)$/.test(low)) {
    await window.zumi.openUrl("https://www.google.com/");
    say("Opening the browser. 🌐", { mood: "happy" });
    vlog("open -> browser (bare)");
    return true;
  }
  if (/^(?:youtube|yt)$/.test(low)) {
    await window.zumi.openUrl("https://www.youtube.com/");
    say("Opening YouTube. ▶️", { mood: "happy" });
    vlog("open -> youtube (bare)");
    return true;
  }
  m = low.match(/^open\s+(.+)$/);
  if (m) {
    const raw0 = m[1].trim();
    // STT often repeats the verb: "Jami open open code". Drop the duplicated "open"
    // so the real target ("code" -> VS Code) survives instead of becoming
    // target "open code" -> "I don't know the app".
    const raw = raw0.replace(/^open\s+(?=\S)/i, "").trim() || raw0;
    // web destinations first — "open youtube", "open youtube lofi", "open google", ...
    const ytm = raw.match(/^(?:youtube|yt)(?:\.(?:com|in|org|net))?\s*(?:video\s*)?(.*)$/);
    if (ytm) {
      // "open youtube.com" / "open youtube.com on chrome": the TLD and the browser word are
      // noise. Without stripping them we searched YouTube for literally ".com".
      const q = ytm[1].trim()
        .replace(/^[.\s]*(?:com|in|org|net|co)\b\s*/i, "")
        .replace(/^on\s+(?:chrome|browser|edge|internet|web)\b\s*/i, "")
        .replace(/^[,;\s]+/, "").replace(/[,;\s]+$/, "").trim();
      const url = q ? "https://www.youtube.com/results?search_query=" + encodeURIComponent(q) : "https://www.youtube.com/";
      await window.zumi.openUrl(url);
      say(q ? `Opening YouTube for "${q}".` : "Opening YouTube.", { mood: "happy" });
      vlog("open -> " + url);
      return true;
    }
    if (/^(?:google|search|web|browser|chrome|edge)/.test(raw)) {
      const q = raw.replace(/^(?:google|search|web|browser|chrome|edge)\s*/, "").trim();
      await window.zumi.openUrl(q ? "https://www.google.com/search?q=" + encodeURIComponent(q) : "https://www.google.com/");
      say(q ? `Searching Google for "${q}".` : "Opening Google.", { mood: "happy" });
      vlog("open -> google " + q);
      return true;
    }
    // Normalise what STT actually said: "vs code" -> vscode, "my files" -> files,
    // "proton mill" -> protonmail, "a cycle bin" -> recycle bin.
    const bare = raw.replace(/^(?:my|the|a|an)\s+/, "").trim();
    const target = (OPEN_ALIAS[raw] || OPEN_ALIAS[bare] || bare).trim();

    const site = OPEN_SITES[target];
    if (site) {
      await window.zumi.openUrl(site);
      say("Opening " + siteLabel(target) + ".", { mood: "happy" });
      vlog("open -> site " + site);
      return true;
    }
    const appKey = OPEN_APPS[target];
    if (appKey) {
      const ok = await window.zumi.openApp(appKey);
      if (ok) {
        say(`Opening ${target}.`, { mood: "happy" });
        vlog("open app " + target + " -> true");
        return true;
      }
      // App genuinely not installed — say so honestly and fall back to the web.
      await window.zumi.openUrl("https://www.google.com/search?q=" + encodeURIComponent(target));
      say(`Couldn't find "${target}" installed on this PC — searching the web instead.`, { mood: "cool", ms: 6000 });
      vlog("open missing locally -> web search: " + target);
      return true;
    }
    // A sentence ("open all shortcuts on my desktop") is a REQUEST, not an app name.
    // Googling it produced nonsense like: I don't know the app "all shortcuts on my
    // desktop skin" — searching the web for it instead. Let it fall through instead.
    if (appLikeOpen(raw)) {
      await window.zumi.openUrl("https://www.google.com/search?q=" + encodeURIComponent(raw));
      say(`I don't know the app "${raw}" — searching the web for it instead.`, { mood: "cool", ms: 6000 });
      vlog("open unknown -> web search: " + raw);
      return true;
    }
    vlog("open skipped (reads as a request, not an app): " + raw);
    // fall through to the agent / chat below
  }
  m = low.match(/^(?:search|google)\s+(.+)$/);
  if (m) { await window.zumi.openUrl("https://www.google.com/search?q=" + encodeURIComponent(m[1])); say(`Searching Google for "${m[1]}". 🔎`, { mood: "cool" }); return true; }
  m = low.match(/^youtube\s+(.+)$/);
  if (m) { await window.zumi.openUrl("https://www.youtube.com/results?search_query=" + encodeURIComponent(m[1])); say(`Opening YouTube for "${m[1]}". ▶️`, { mood: "happy" }); return true; }
  m = low.match(/^open\s+(https?:\/\/\S+)/);
  if (m) { await window.zumi.openUrl(m[1]); say("Opening the link. 🔗", { mood: "happy" }); return true; }
  if (/^(hi|hello|hey|yo|good morning|good evening)\b/.test(low)) { say(greetLine(), { mood: "happy" }); return true; }
  if (/^(thanks|thank you|thnx)\b/.test(low)) { say("Anytime! 😊", { mood: "love" }); return true; }
  if (/^i love you|love you/.test(low)) { say("Aww… love you too! 💗", { mood: "love" }); return true; }
  if (/^(help|what can you do|commands)\b/.test(low)) {
    say("I'm quite capable now:\n• 🧠 Memory — \"remember my name is Arpit\" / \"what do you know\"\n• ✅ Tasks — \"add task pay bill\" / \"tasks\" / \"done pay bill\"\n• ⏰ Reminders (saved on this PC) — \"remind me in 10 min to call\"\n• 🍅 Pomodoro\n• 📝 Notes — \"note buy milk\" / \"notes\"\n• 🌦️ Weather — \"weather in Delhi\"\n• 📋 Clipboard — \"clipboard\" / \"copy <text>\"\n• 📸 Screenshot · 💻 CPU/RAM · 🕒 time/date · 😄 joke · 🔢 convert\n• 🚀 Open apps — notepad / vscode / cmd / explorer / paint\n• 🔎 Google / YouTube search\n\nOr just talk to me — I learn as we chat! 🐾", { speakIt: false, ms: 20000, mood: "happy" });
    return true;
  }
  return false;
}

/* ============================ agent (task engine) ============================ */
let lastPlan = null;
let queueAfterBatch = null; // run the code half after the safe half finishes (10k mission)

function setBusy(on) { const s = document.getElementById("stage"); if (s) s.classList.toggle("busy", !!on); }
function setProgress(pct, label) {
  const bar = document.getElementById("progressBar");
  const fill = document.getElementById("progressFill");
  if (!bar || !fill) return;
  if (pct == null) { bar.classList.add("hidden"); return; }
  bar.classList.remove("hidden");
  fill.style.width = Math.max(0, Math.min(100, pct)) + "%";
  if (label) bar.title = label;
}

async function agentCommand(t) {
  const parts = t.slice(1).trim().split(/\s+/);
  const cmd = (parts.shift() || "").toLowerCase();
  const arg = parts.join(" ");
  switch (cmd) {
    case "status": { const s = await window.zumi.taskStats(); say(`🤖 Tasks — total ${s.total} · running ${s.running} · queued ${s.queued} · done ${s.completed} · failed ${s.failed} · blocked ${s.blocked}`, { speakIt: false, ms: 13000, mood: "cool" }); return true; }
    case "tasks": { const list = await window.zumi.taskList(); if (!list.length) { say("No tasks yet. Say \"do <task>\" or /automate <task>.", { mood: "happy" }); return true; } say(list.slice(0, 10).map((x) => `${x.task_id} [${x.status}] ${x.title}`).join("\n"), { speakIt: false, ms: 15000 }); return true; }
    case "running": { const list = (await window.zumi.taskList()).filter((x) => ["running", "queued", "waiting"].includes(x.status)); say(list.length ? list.map((x) => `${x.task_id} ${x.status}: ${x.title}`).join("\n") : "Nothing running right now.", { speakIt: false, ms: 11000 }); return true; }
    case "report": say(await window.zumi.taskReport(), { speakIt: false, ms: 22000, mood: "cool" }); return true;
    case "confirm": { if (!arg) { say("Usage: /confirm <task_id>"); return true; } await window.zumi.taskRun(arg, true); say("▶ Running " + arg, { speakIt: false, ms: 4000, mood: "excited" }); return true; }
    case "cancel": { if (!arg) { say("Usage: /cancel <task_id>"); return true; } await window.zumi.taskCancel(arg); say("Cancelled " + arg, { mood: "cool" }); return true; }
    case "retry": { if (!arg) { say("Usage: /retry <task_id>"); return true; } await window.zumi.taskRun(arg, true); say("Retrying " + arg, { mood: "excited" }); return true; }
    case "clear": await window.zumi.taskClear(); say("Task list cleared. 🧹", { mood: "happy" }); return true;
    case "log": { const l = await window.zumi.taskLog(15); say(l.length ? l.map((x) => new Date(x.at).toLocaleTimeString() + "  " + x.msg).join("\n") : "No log entries.", { speakIt: false, ms: 13000 }); return true; }
    case "logs": case "zumilog": case "applog": {
      const l = (await window.zumi.logRead(30)) || [];
      say(l.length ? l.slice(-30).join("\n") : "No log entries yet — the log fills up as I work.", { speakIt: false, ms: 25000 });
      return true;
    }
    case "voice": {
      say(LV.on
        ? `🎙 Live voice is ON — input "${LV.micLabel || "default"}" · phase ${LV.phase} · noise floor ${LV.noise.toFixed(3)} · ${LV.turns} turns this session${LV.lastErr ? " · last error: " + LV.lastErr : ""}`
        : "🎙 Live voice is OFF — press Ctrl+Alt+Z.", { speakIt: false, ms: 14000 });
      return true;
    }
    case "schedule": { const m = arg.match(/^(.*?)\s+(every\s+.+|at\s+\d{1,2}:\d{2}|\d{1,2}:\d{2})$/i); if (!m) { say("Usage: /schedule <task> every 30 min — or — /schedule <task> at 08:00"); return true; } const list = await window.zumi.schedAdd(m[1].trim(), m[2].replace(/^at\s+/i, "")); say("Scheduled ✅ (" + list.length + " total).", { mood: "happy" }); return true; }
    case "schedules": { const s = await window.zumi.schedList(); say(s.length ? s.map((x) => `${x.schedule_id} — ${x.task} — ${x.schedule}`).join("\n") : "No schedules.", { speakIt: false, ms: 13000 }); return true; }
    case "automate": case "run": if (arg) { await runAgentTask(arg); return true; } break;
    case "build": case "website": { await runAgentTask("Use gen_samples, then site_build, then site_serve to build Zumi's own website about itself in many languages and run it"); return true; }
    case "fix": case "repair": case "check": case "verify": case "audit": { await runAgentTask("Verify Zumi's own website: run site_verify to find every broken link, dead button and script error, then site_build to fix them, and keep fixing and re-checking until every button and nav link works, then site_serve it"); return true; }
    case "samples": { await runAgentTask("generate code samples in all programming languages"); return true; }
    case "serve": { await runAgentTask("serve the website on localhost and open it"); return true; }

    /* ---- big batch missions (live progress above Zumi) ---- */
    case "batch": {
      const n = Math.max(1, Math.min(5000, parseInt(arg, 10) || 5000));
      const r = await window.zumi.batchRun(n);
      setBusy(true); setProgress(0, "Safe PC batch");
      say(`🚀 ${r.total} safe PC tasks started — I'll show live progress here. Nothing gets deleted.`, { speakIt: false, ms: 9000, mood: "excited" });
      return true;
    }
    case "code": {
      const n = Math.max(1, Math.min(5000, parseInt(arg, 10) || 5000));
      const r = await window.zumi.codeRun(n, true, 12);
      setBusy(true); setProgress(0, "Code batch");
      say(`⌨ ${r.total} code files: writing, running and verifying...`, { speakIt: false, ms: 9000, mood: "excited" });
      return true;
    }
    case "mega": case "10k": case "10000": case "mission": {
      const total = Math.max(2, Math.min(10000, parseInt(arg, 10) || 10000));
      const half = Math.floor(total / 2);
      queueAfterBatch = () => { window.zumi.codeRun(total - half, true, 20, "mission-" + total).catch(() => {}); };
      await window.zumi.batchRun(half);
      setBusy(true); setProgress(0, `${total}-task mission`);
      say(`🚀 ${total}-task mission launched:\n1) ${half} safe PC tasks (files, apps, system — read only)\n2) ${total - half} code files (write + run + verify)\nWatch me work — live bar above my head.`, { speakIt: false, ms: 15000, mood: "excited" });
      return true;
    }
    case "progress": {
      const [b, c] = [await window.zumi.batchStatus(), await window.zumi.codeStatus()];
      const bp = b.total ? `Safe batch: ${b.done}/${b.total} ok · ${b.failed} failed${b.running ? " · RUNNING" : ""}` : "Safe batch: idle";
      const cp = c.total ? `Code batch: ${c.written} written · ${c.passed} passed · ${c.failed} failed${c.running ? " · RUNNING" : ""}` : "Code batch: idle";
      say(`📊 ${bp}\n${cp}`, { speakIt: false, ms: 14000, mood: "cool" });
      return true;
    }
    case "daily": case "reportdaily": say(await window.zumi.dailyReport(), { speakIt: false, ms: 30000, mood: "cool" }); return true;

    case "help": say("🧠 Agent commands:\n/status /tasks /running /report /cancel <id> /retry <id> /schedule <task> every 30 min /schedules /log /clear\n🎙 Live voice: /voice (state) · /logs (real-time app log)\n🚀 /build website · /fix website · /verify · /samples · /serve\n📊 /batch 5000 · /code 5000 · /mega 10000 (live progress) · /progress · /daily report\n\nOr just say: \"build your own website and run it\" · \"open youtube\" · \"run 10000 tasks\"", { speakIt: false, ms: 30000, mood: "happy" }); return true;
  }
  say("Unknown command — try /help", { mood: "sad" });
  return true;
}

async function runAgentTask(instruction) {
  say("🧠 Planning: " + instruction, { speakIt: false, ms: 5000, mood: "excited" });
  let task;
  try { task = await window.zumi.taskPlan(instruction); } catch (e) { say("Planner failed: " + (e.message || e), { mood: "sad" }); return; }
  const n = (task.steps || []).length;
  if (task.requires_confirmation) {
    lastPlan = task;
    say(`⚠️ ${task.task_id}: "${task.title}" — ${n} steps — needs confirmation.\nSay "/confirm ${task.task_id}" to run, or "/cancel ${task.task_id}".`, { speakIt: false, ms: 18000, mood: "sad" });
    return;
  }
  await window.zumi.taskRun(task.task_id, false);
}

async function handleAgent(text) {
  const t = text.trim();
  if (t.startsWith("/")) return await agentCommand(t);
  // direct mission triggers — handled by Zumi's own engine, no planner round-trip
  if (/^(mega|10k|10000|mission|progress|daily report|daily)\b/i.test(t)) return await agentCommand("/" + t);
  if (/^(batch|code)(\s+\d+)?$/i.test(t)) return await agentCommand("/" + t);
  if (/run\s+\d+\s+(tasks|code)/i.test(t) || /10000\s+tasks/i.test(t) || /give (me|zumi) .*(tasks|batch)/i.test(t)) {
    const m = t.match(/(\d{3,6})/);
    return await agentCommand("/mega " + (m ? m[1] : 10000));
  }
  if (/^(do|automate|execute|run task|organize|clean up|cleanup|sort|tidy|build|create|make|set up|setup my|arrange|generate|fix|repair|check|verify|audit)\b/i.test(t) || /website|button|not working|broken link/i.test(t)) { await runAgentTask(t); return true; }
  // Acquiring software has to be a task, otherwise "download the 7-Zip app" just falls
  // through to chat and nothing happens. Users say it in their own words ("download X",
  // "get me its installer", "i want vlc installed"), so this matches the keyword anywhere,
  // not only at the start. Genuine questions about the topic ("what is an installer?")
  // open with a question word and are left in chat.
  if (/\b(download|downloads|downloading|installer|installers|install|installs|installing)\b/i.test(t) &&
      !/^\s*(what|why|how|which|who|whom|when|where|is|are|was|were|does|did|has|have)\b/i.test(t)) {
    await runAgentTask(t); return true;
  }
  return false;
}

/* ============================ input ============================ */
/* Voice-only repair: STT often garbles the first word ("open" -> "on", trailing ".").
   For short spoken utterances, strip filler words and rebuild the command if a known
   target follows — so commands still execute instead of falling through to chat.   */
const VR_FILLER = new Set([
  "on", "own", "a", "an", "the", "i", "im", "uh", "um", "ah", "oh", "so", "and", "then", "to", "go",
  "hey", "yo", "please", "okay", "ok", "yeah", "yep", "can", "could", "would", "will", "you",
  "want", "wants", "like", "watch", "play", "open", "launch", "start", "up", "me", "my", "some",
]);
const VR_APPS = {
  youtube: "youtube", chrome: "chrome", browser: "browser", google: "google", edge: "edge",
  internet: "internet", notepad: "notepad", calc: "calc", calculator: "calc", explorer: "explorer",
  files: "explorer", folder: "explorer", paint: "paint", vscode: "vscode", code: "vscode",
  cmd: "cmd", terminal: "cmd", settings: "settings",
};

/* What STT actually said -> a real destination. Before this table the voice log showed
   11 pointless web searches for things like "vs code", "virtual studio code",
   "spotify", "telegram", "proton mill" (Proton Mail) and "a cycle bin" (Recycle Bin). */
const OPEN_APPS = {
  notepad: "notepad", calc: "calc", calculator: "calc", "calculator app": "calc",
  explorer: "explorer", files: "explorer", folder: "explorer", "file explorer": "explorer",
  "my files": "explorer", "my folders": "explorer", "this pc": "explorer", "my computer": "explorer",
  recycle: "explorer", "recycle bin": "explorer", "cycle bin": "explorer", "recycling bin": "explorer",
  trash: "explorer", "bin": "explorer",
  paint: "paint", vscode: "vscode", "vs code": "vscode", "v s code": "vscode",
  "visual studio code": "vscode", "visual studio": "vscode", "code editor": "vscode",
  code: "vscode", "opencode": "vscode", "open code": "vscode",
  cmd: "cmd", terminal: "cmd", command: "cmd", "command prompt": "cmd", powershell: "cmd",
  settings: "settings", taskmanager: "settings", "task manager": "settings",
};
/* Known web destinations — opening the real site beats Googling its name. */
const OPEN_SITES = {
  youtube: "https://www.youtube.com/", "you tube": "https://www.youtube.com/",
  google: "https://www.google.com/", gmail: "https://mail.google.com/", mail: "https://mail.google.com/",
  "google mail": "https://mail.google.com/", "my mail": "https://mail.google.com/",
  protonmail: "https://mail.proton.me/", "proton mail": "https://mail.proton.me/", proton: "https://mail.proton.me/",
  "proton mill": "https://mail.proton.me/", "proton male": "https://mail.proton.me/",
  telegram: "https://web.telegram.org/", spotify: "https://open.spotify.com/",
  github: "https://github.com/", discord: "https://discord.com/app/", whatsapp: "https://web.whatsapp.com/",
  netflix: "https://www.netflix.com/", reddit: "https://www.reddit.com/", chatgpt: "https://chat.openai.com/",
  instagram: "https://www.instagram.com/", facebook: "https://www.facebook.com/",
  twitter: "https://x.com/", linkedin: "https://www.linkedin.com/", amazon: "https://www.amazon.com/",
  maps: "https://maps.google.com/", drive: "https://drive.google.com/", stackoverflow: "https://stackoverflow.com/",
  browser: "https://www.google.com/", chrome: "https://www.google.com/",
  edge: "https://www.google.com/", internet: "https://www.google.com/", web: "https://www.google.com/",
};
/* Alternate phrasings STT hands us. Applied to the raw target and to the bare one. */
const OPEN_ALIAS = {
  "vs code": "vscode", "visual studio code": "vscode", "visual studio": "vscode",
  "cycle bin": "recycle bin", "recycle bin": "recycle bin", "recycling bin": "recycle bin",
  "proton mill": "proton mail", "proton male": "proton mail", "protom mail": "proton mail",
  "my mail": "gmail", "google mail": "gmail",
};
const OPEN_NOT_APP = /\b(i|me|my|mine|you|your|we|our|how|many|much|what|which|why|who|when|where|count|counts|counting|list|listing|show|showing|tell|telling|read|reading|get|give|send|save|take|check|checking|number|numbers|shortcut|shortcuts|files|file|folder|folders|document|documents|picture|pictures|download|downloads)\b/;

/* "open" followed by a sentence, not an app name:
   "open all shortcuts on my desktop skin", "open my mail or read first email",
   "open you to world play any indian song".  These must fall through to chat. */
function appLikeOpen(s) {
  const w = String(s || "").trim().split(/\s+/).filter(Boolean);
  if (!w.length || w.length > 4) return false;
  if (OPEN_NOT_APP.test(String(s).toLowerCase())) return false;
  return true;
}
function siteLabel(t) {
  return String(t).charAt(0).toUpperCase() + String(t).slice(1);
}

/* The user addresses the buddy as "Jimmy"/"Jumi"/"Jami" as well as its real name.
   Any of these as a leading token must NOT stop "open youtube" from matching. */
function stripWake(s) {
  const nm = typeof buddyName === "string" && buddyName ? buddyName : "zumi";
  const names = [nm, "zumi", "zumi", "jimmy", "jimi", "jumi", "jami", "jim"]
    .map((x) => String(x).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  const out = String(s || "")
    .replace(new RegExp("^(?:" + names.join("|") + ")\\b[\\s,:;\\-]*", "i"), "")
    .replace(/^[,;\s]+/, "")
    .trim();
  return out;
}
/* Courtesy wording so "can you open youtube" is still an open command. */
function stripPolite(s) {
  return String(s || "")
    .replace(/^(?:(?:can|could|will|would|shall|should|do|please|pls|kindly|just)\s+(?:you\s+)?|you\s+(?:can|could|may|might)\s+|i\s+want\s+(?:you\s+)?to\s+|i'?d\s+like\s+(?:you\s+)?to\s+|kindly\s+)+/i, "")
    .replace(/^to\s+/, "")
    .replace(/^[,;\s]+/, "")
    .trim();
}

function voiceRepair(raw) {
  const t = String(raw || "").trim();
  if (!t) return null;
  let s = t.toLowerCase()
    .replace(/\byou[-\s]?tube\b/g, "youtube").replace(/\bu[-\s]?tube\b/g, "youtube")
    .replace(/[.!?]+$/g, "").replace(/\s+/g, " ").trim();
  if (!s) return null;
  const w = s.split(" ");
  if (w.length > 6) return null;                 // long sentence → chat, don't hijack
  // already a well-formed command → let handleCommand do its job untouched
  if (/^(?:open|launch|start|search|google|youtube|weather|note|remember|add|tasks?|help|clipboard|screenshot|timer|remind)/.test(s)) return null;
  let i = 0;
  while (i < w.length && i < 4 && VR_FILLER.has(w[i])) i++;     // "on" / "i want to open"
  const tail = w.slice();
  while (tail.length && VR_FILLER.has(tail[tail.length - 1])) tail.pop();  // trailing "please"
  const body = tail.slice(i).join(" ").trim();
  if (!body) return null;
  const bw = body.split(" ");
  const key = bw[0];
  if (!VR_APPS[key]) return null;                // only repair when a KNOWN target follows
  const rest = bw.slice(1).filter((x) => !VR_FILLER.has(x)).join(" ").trim();
  const out = "open " + key + (rest ? " " + rest : "");
  return out === s ? null : out;
}

async function send() {
  const input = $("chatInput");
  const text = input.value.trim();
  if (!text || busy) return;
  input.value = "";
  await processInput(text);
}
async function processInput(text) {
  if (!text || busy) return;
  vlog('input: "' + String(text).slice(0, 160) + '"' + (voiceTurn ? " [voice]" : ""));
  try {
    let cmd = text;
    if (voiceTurn) {
      const fixed = voiceRepair(text);
      if (fixed && fixed.toLowerCase() !== text.toLowerCase()) {
        vlog('voice repair: "' + text + '" -> "' + fixed + '"');
        cmd = fixed;
      }
    }
    // Voice phrasing variants. One press hands us things like:
    //   "Jimmy, open youtube.com" / "Jami open open code" / "can you open notepad"
    // The wake name and the courtesy word both stop ^open from matching, so try a
    // small set of progressively stripped forms. The original text is always first,
    // so behaviour for well-formed commands is unchanged.
    const cands = [];
    const push = (s) => { s = String(s || "").trim(); if (s && cands.indexOf(s) === -1) cands.push(s); };
    push(cmd); push(text);
    push(stripWake(cmd)); push(stripWake(text));
    const more = cands.slice();
    for (const c of more) { push(stripPolite(c)); push(stripPolite(stripWake(c))); }
    for (const cand of cands) {
      if (await handleCommand(cand)) return;
      if (await handleAgent(cand)) return;
    }
    busy = true;
    setMood("excited", { hold: 1500 });
    bubbleText.textContent = "…thinking";
    bubble.classList.remove("hidden");
    const reply = await askLLM(text);
    say(reply, { mood: "happy" });
  } catch (e) {
    vlog("input error: " + ((e && e.message) || e));
    say("Oops: " + (e && e.message ? e.message : "something went wrong."), { mood: "sad" });
  } finally { busy = false; }
}

/* ============================ voice control (offline STT) ============================ */
function floatTo16(f) { const out = new Int16Array(f.length); for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); out[i] = s < 0 ? s * 0x8000 : s * 0x7fff; } return out; }
function encodeWav(samples, rate) {
  const buf = new ArrayBuffer(44 + samples.length * 2); const v = new DataView(buf);
  const ws = (o, s) => { for (let i = 0; i < s.length; i++) v.setUint8(o + i, s.charCodeAt(i)); };
  ws(0, "RIFF"); v.setUint32(4, 36 + samples.length * 2, true); ws(8, "WAVE");
  ws(12, "fmt "); v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, rate, true); v.setUint32(28, rate * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  ws(36, "data"); v.setUint32(40, samples.length * 2, true);
  let o = 44; for (let i = 0; i < samples.length; i++, o += 2) v.setInt16(o, samples[i], true);
  return buf;
}
function b64FromBuffer(buf) { let s = ""; const b = new Uint8Array(buf); for (let i = 0; i < b.length; i++) s += String.fromCharCode(b[i]); return btoa(s); }
async function to16kMono(audioBuf) {
  const target = 16000;
  if (audioBuf.sampleRate === target && audioBuf.numberOfChannels === 1) return audioBuf.getChannelData(0);
  const off = new OfflineAudioContext(1, Math.max(1, Math.ceil(audioBuf.duration * target)), target);
  const src = off.createBufferSource(); src.buffer = audioBuf; src.connect(off.destination); src.start();
  const rendered = await off.startRendering();
  return rendered.getChannelData(0);
}
/* ============================ live voice — hands-free, real-time (VAD) ============================
   Press Ctrl+Alt+Z ONCE: the mic stays open and Zumi keeps listening.
   Speech starts recording automatically, silence ends it, Zumi answers out loud,
   then goes straight back to listening. Press again to turn voice OFF.          */
const LV = {
  on: false, phase: "off",           // off | idle | recording | processing
  stream: null, ac: null, analyser: null, buf: null,
  proc: null, sink: null,            // continuous PCM capture (mic -> ring buffer)
  ring: null, ringPtr: 0, ringLen: 0, sr: 0,
  pre: null, live: null,             // pre-roll snapshot + chunks collected while speaking
  rec: null, chunks: [], timer: null,
  speechTicks: 0, silenceTicks: 0, recStart: 0,
  noise: 0.02, holdUntil: 0, turns: 0, lastErr: "",
  micLabel: "",                       // which input pickMicStream() settled on
  silentTicks: 0, warnedSilent: false, // muted-mic watchdog
};
const LV_TICK = 90;                 // level sample every 90ms
const LV_START_TICKS = 3;           // ~270ms of sound before "that's speech"
const LV_SILENCE_TICKS = 13;        // ~1.2s of silence ends the utterance
const LV_MAX_MS = 15000;            // hard cap per utterance
const LV_PRE_ROLL_MS = 500;         // audio kept BEFORE the trigger — the first word must never be clipped
window.__lv = LV;                   // diagnostics hook (CDP/tests)

/* Continuous mic capture: the ring always holds the last LV_RING_MS of audio, so when VAD
   fires we can rewind 500ms and include the onset of speech ("open" was being cut to "on").
   While recording, every block is also copied into LV.live for the utterance. */
function lvOnAudio(e) {
  const input = e.inputBuffer.getChannelData(0);
  if (LV.ring && LV.ringLen) {
    for (let i = 0; i < input.length; i++) {
      LV.ring[LV.ringPtr] = input[i];
      LV.ringPtr = (LV.ringPtr + 1) % LV.ringLen;
    }
  }
  if (LV.phase === "recording" && LV.live) LV.live.push(new Float32Array(input));
}

function lvResample16k(src, sr) {
  if (sr === 16000) return src;
  const ratio = sr / 16000;
  const outN = Math.floor(src.length / ratio);
  const out = new Float32Array(outN);
  for (let i = 0; i < outN; i++) {
    const pos = i * ratio;
    const i0 = pos | 0;
    const frac = pos - i0;
    const a = src[i0], b = src[Math.min(i0 + 1, src.length - 1)];
    out[i] = a + (b - a) * frac;
  }
  return out;
}

/* rewind the ring and return the last ms of pre-trigger audio (ordered oldest->newest) */
function lvPreRoll(ms) {
  const n = Math.min(LV.ringLen, Math.round((LV.sr || 16000) * ms / 1000));
  const out = new Float32Array(n);
  let idx = (LV.ringPtr - n + LV.ringLen * 2) % LV.ringLen;
  for (let i = 0; i < n; i++) { out[i] = LV.ring[idx]; idx = (idx + 1) % LV.ringLen; }
  return out;
}

function lvUi(on) {
  const dot = $("vcdot"); if (dot) dot.classList.toggle("hidden", !on);
  const mb = $("micBtn"); if (mb) mb.classList.toggle("on", !!on);
}
function lvRms() {
  if (!LV.analyser) return 0;
  LV.analyser.getByteTimeDomainData(LV.buf);
  let sum = 0;
  for (let i = 0; i < LV.buf.length; i++) { const v = (LV.buf[i] - 128) / 128; sum += v * v; }
  return Math.sqrt(sum / LV.buf.length);
}
function lvThreshold() { return Math.max(0.022, Math.min(0.1, LV.noise * 2.6)); }

function lvTick(level) {
  if (!LV.on || LV.phase === "processing") return;
  const lvl = typeof level === "number" ? level : lvRms();
  LV.level = lvl;                       // live mic level, visible to diagnostics
  const thr = lvThreshold();
  // Watchdog: a Windows-muted input reads as pure digital silence, which from the
  // outside just looks like "voice stopped working". Say so once instead of hanging
  // there mysteriously. (Synthetic ticks from tests pass an explicit level — skip them.)
  if (typeof level !== "number" && LV.phase === "idle") {
    if (lvl >= 0.0005) { LV.silentTicks = 0; LV.warnedSilent = false; }
    else if (++LV.silentTicks >= 90 && !LV.warnedSilent) {      // ~8s of pure silence
      LV.warnedSilent = true;
      vlog("mic: 8s of digital silence — input '" + (LV.micLabel || "default") + "' looks MUTED in Windows");
      say("I can't hear anything right now — this microphone looks muted in Windows. Unmute it in Sound settings and I'll start hearing you again.", { mood: "sad", ms: 9000 });
      setMood("sad", { hold: 6000 });
    }
  }
  if (lvl < thr) {
    // learn the room: rise very slowly, fall fast — speech tails must never inflate the floor
    LV.noise = lvl > LV.noise ? LV.noise * 0.99 + lvl * 0.01 : LV.noise * 0.9 + lvl * 0.1;
  }

  if (LV.phase === "idle") {
    // echo guard: don't start listening while I'm still talking
    if (Date.now() < LV.holdUntil) { LV.speechTicks = 0; return; }
    const speaking = typeof speechSynthesis !== "undefined" && speechSynthesis.speaking;
    if (speaking) {
      // TTS outlasted its estimate — extend, but cap at 15s past it, then force-stop and listen
      if (!LV.ttsExtend) LV.ttsExtend = Date.now();
      if (Date.now() - LV.ttsExtend < 15000) { LV.holdUntil = Date.now() + 1000; LV.speechTicks = 0; return; }
      try { speechSynthesis.cancel(); } catch { /* ignore */ }
      LV.ttsExtend = 0; LV.holdUntil = 0;
      vlog("live: TTS overran estimate — cancelled, listening again");
    } else LV.ttsExtend = 0;
    if (lvl >= thr) {
      LV.speechTicks++;
      if (LV.speechTicks >= LV_START_TICKS) lvStartRec();
    } else LV.speechTicks = 0;
    return;
  }
  if (LV.phase === "recording") {
    if (lvl >= thr * 0.8) LV.silenceTicks = 0;
    else LV.silenceTicks++;
    if (LV.silenceTicks >= LV_SILENCE_TICKS || Date.now() - LV.recStart > LV_MAX_MS) lvStopRec();
  }
}

function lvShowListening() {
  bubbleText.textContent = "🎤 Listening…";
  bubble.classList.remove("hidden");
  clearTimeout(bubbleTimer);
  bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), 4000);
}

function lvStartRec() {
  if (!LV.stream || LV.phase === "recording") return;
  try {
    // rewind: include audio from BEFORE the trigger so the first word survives
    LV.pre = LV.ringLen ? lvPreRoll(LV_PRE_ROLL_MS) : new Float32Array(0);
    LV.live = [];
    LV.phase = "recording"; LV.silenceTicks = 0; LV.speechTicks = 0; LV.recStart = Date.now();
    setMood("excited", { hold: 5000 });
    lvShowListening();
    vlog(`live: speech detected -> recording (pre-roll ${LV_PRE_ROLL_MS}ms, sr ${LV.sr})`);
  } catch (e) {
    LV.lastErr = String((e && e.message) || e);
    vlog("live: recorder error " + LV.lastErr);
    LV.phase = "idle";
  }
}

/* single seam for STT — tests can temporarily override this to inject a spoken command */
async function lvTranscribe(b64, lang) { return window.zumi.transcribe(b64, lang); }

async function lvStopRec() {
  if (LV.phase !== "recording") return;
  LV.phase = "processing";
  const dur = Date.now() - LV.recStart;
  const pre = LV.pre || new Float32Array(0);
  const blocks = LV.live || [];
  LV.pre = null; LV.live = null;
  const total = pre.length + blocks.reduce((s, b) => s + b.length, 0);
  vlog(`live: utterance ${dur}ms, ${blocks.length} block(s) + ${pre.length} pre-roll samples`);
  if (total < 1600) { vlog("live: audio too short (" + total + " samples)"); lvResume(); return; }
  try {
    const sr = LV.sr || 16000;
    const merged = new Float32Array(total);
    merged.set(pre, 0);
    let off = pre.length;
    for (const b of blocks) { merged.set(b, off); off += b.length; }
    const pcm = lvResample16k(merged, sr);
    if (!pcm || pcm.length < 3200) { vlog("live: audio too short after resample (" + pcm.length + " samples)"); lvResume(); return; }
    // audio diagnostics — proves the mic actually captured speech (not a permission/silence issue)
    let peak = 0, sum = 0;
    for (let i = 0; i < pcm.length; i++) { const v = pcm[i]; const a = v < 0 ? -v : v; if (a > peak) peak = a; sum += v * v; }
    const rms = Math.sqrt(sum / pcm.length);
    vlog(`live: audio peak=${peak.toFixed(3)} rms=${rms.toFixed(4)} dur=${(pcm.length / 16000).toFixed(2)}s`);
    if (peak < 0.01) { vlog("live: mic captured silence — skipping STT"); lvResume(); return; }
    bubbleText.textContent = "…transcribing";
    bubble.classList.remove("hidden");
    const text = await lvTranscribe(b64FromBuffer(encodeWav(floatTo16(pcm), 16000)), "en");
    vlog('live: heard "' + text + '"');
    if (!text) { lvResume(); return; }              // room noise — just keep listening
    bubbleText.textContent = "👤 " + text;
    voiceTurn = true;
    LV.turns++;
    try { await processInput(text); }
    finally { voiceTurn = false; }
  } catch (e) {
    LV.lastErr = String((e && e.message) || e);
    vlog("live: error " + LV.lastErr);
    say("Hmm, I missed that — say it again?", { mood: "sad", ms: 3500 });
  }
  lvResume();
}

function lvResume() {
  if (!LV.on) { lvUi(false); return; }
  LV.phase = "idle"; LV.silenceTicks = 0; LV.speechTicks = 0;
}

/* ---- picking an input that actually carries audio ----
   Windows lets ONE endpoint be muted while another on the same machine is live.
   That is exactly what broke voice here:
     OS default  "Microphone (Realtek)"       muted=TRUE   peak=0.00003
     "Microphone Array (Realtek)"             muted=false  peak=0.97
   Opening "the default" blindly therefore looked like Zumi's voice had died.
   `track.muted` mirrors the Windows endpoint mute, so use it to skip muted
   inputs and fall back to one that is genuinely live. */
async function pickMicStream() {
  const opts = (extra) => Object.assign({ echoCancellation: true, noiseSuppression: true, autoGainControl: true }, extra || {});
  const open = async (extra) => { try { return await navigator.mediaDevices.getUserMedia({ audio: opts(extra) }); } catch { return null; } };

  // 1. OS default first — identical behaviour to before whenever nothing is wrong.
  const def = await open();
  if (def) {
    const tr = def.getAudioTracks()[0];
    if (tr && !tr.muted) return { stream: def, label: "default" };
    await new Promise((r) => setTimeout(r, 350));          // mute can lag the track a moment
    if (tr && tr.muted) {
      def.getTracks().forEach((t) => t.stop());
      vlog("mic: OS default input is MUTED in Windows — looking for an input that is live");
    } else return { stream: def, label: "default" };
  }

  // 2. every other endpoint until one is not muted
  let ds = [];
  try {
    ds = (await navigator.mediaDevices.enumerateDevices())
      .filter((d) => d.kind === "audioinput" && d.deviceId && d.deviceId !== "default" && d.deviceId !== "communications");
  } catch { ds = []; }
  for (const d of ds) {
    const st = await open({ deviceId: { exact: d.deviceId } });
    if (!st) continue;
    const tr = st.getAudioTracks()[0];
    if (tr && tr.muted) { st.getTracks().forEach((t) => t.stop()); continue; }
    vlog('mic: using "' + d.label + '" (OS default was muted)');
    return { stream: st, label: d.label };
  }

  // 3. nothing verifiably live — take the default anyway rather than refuse to start
  const last = await open();
  if (last) vlog("mic: no unmuted input found — using the OS default anyway (voice may be silent)");
  return last ? { stream: last, label: "default (unverified)" } : null;
}

async function startLiveVoice() {
  if (LV.on) return;
  if (settings.voiceControl === false) {
    vlog("live: blocked — voiceControl is off");
    say("Voice control is off — turn it on in Setup.", { mood: "sad" });
    return;
  }
  try {
    const picked = await pickMicStream();
    if (!picked) throw new Error("no microphone available");
    const stream = picked.stream;
    const ac = new (window.AudioContext || window.webkitAudioContext)();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser(); an.fftSize = 1024;
    src.connect(an);
    // continuous PCM capture -> ring buffer (pre-roll keeps the first word)
    const sr = ac.sampleRate || 48000;
    const ringLen = Math.ceil(sr * 1.5);              // 1.5s of rewound audio
    const proc = ac.createScriptProcessor ? ac.createScriptProcessor(4096, 1, 1) : null;
    const sink = ac.createGain(); sink.gain.value = 0; // silent sink keeps the processor pulled
    if (proc) {
      proc.onaudioprocess = lvOnAudio;
      src.connect(proc);
      proc.connect(sink);
      sink.connect(ac.destination);
    } else vlog("live: ScriptProcessor unavailable — pre-roll disabled");
    Object.assign(LV, {
      on: true, phase: "idle", stream, ac, analyser: an, micLabel: picked.label,
      buf: new Uint8Array(an.fftSize),
      proc, sink, sr, ring: proc ? new Float32Array(ringLen) : null, ringPtr: 0, ringLen: proc ? ringLen : 0,
      pre: null, live: null,
      speechTicks: 0, silenceTicks: 0, noise: 0.02, holdUntil: 0,
      silentTicks: 0, warnedSilent: false,
    });
    if (LV.timer) clearInterval(LV.timer);
    LV.timer = setInterval(() => lvTick(), LV_TICK);
    lvUi(true);
    setMood("excited", { hold: 6000 });
    // If we had to leave the OS default because it is muted, say so — it is a
    // different physical microphone and the user should know which one is live.
    const swapped = picked.label && picked.label !== "default";
    const note = swapped
      ? ` Heads up — the default mic is muted in Windows, so I'm using "${picked.label}" instead.`
      : "";
    say("Live voice ON — just talk, I'm listening." + note, { ms: 4500 + note.length * 70, mood: "excited" });
    vlog(`live voice ON (tick ${LV_TICK}ms, start=${LV_START_TICKS}, silence=${LV_SILENCE_TICKS}, input=${picked.label})`);
  } catch (e) {
    LV.lastErr = String((e && e.message) || e);
    vlog("live voice FAIL: " + LV.lastErr);
    say("Couldn't use the mic: " + LV.lastErr, { mood: "sad", ms: 6000 });
  }
}

async function stopLiveVoice() {
  if (!LV.on) return;
  LV.on = false; LV.phase = "off";
  if (LV.timer) { clearInterval(LV.timer); LV.timer = null; }
  if (LV.rec) { try { LV.rec.stop(); } catch { /* ignore */ } LV.rec = null; }
  if (LV.proc) { try { LV.proc.onaudioprocess = null; LV.proc.disconnect(); } catch { /* ignore */ } LV.proc = null; }
  if (LV.sink) { try { LV.sink.disconnect(); } catch { /* ignore */ } LV.sink = null; }
  LV.chunks = []; LV.pre = null; LV.live = null; LV.ring = null; LV.ringLen = 0;
  try { if (LV.stream) LV.stream.getTracks().forEach((t) => t.stop()); } catch { /* ignore */ }
  try { if (LV.ac) await LV.ac.close(); } catch { /* ignore */ }
  LV.stream = LV.ac = LV.analyser = null;
  lvUi(false);
  say("Voice OFF — press Ctrl+Alt+Z to start again.", { ms: 4000 });
  vlog("live voice OFF (turns=" + LV.turns + ")");
}

function toggleVoice() {
  vlog("toggle requested (on=" + LV.on + ")");
  if (LV.on) stopLiveVoice(); else startLiveVoice();
}

/* ============================ greeting + loops ============================ */
function greetLine() {
  const h = new Date().getHours();
  if (h < 5) return "It's really late — I'm here with you, but get some rest soon. 🌙";
  if (h < 12) return "Good morning! ☀️ Let's make today count.";
  if (h < 17) return "Good afternoon! How's the work going? 😊";
  if (h < 21) return "Good evening! What's the plan? 🌆";
  return "It's getting late… wrap up and we'll start fresh tomorrow. 🌙";
}
function startLoops() {
  setInterval(() => { if (!chatOpen && bubble.classList.contains("hidden") && Math.random() < 0.65) say(QUIPS[Math.floor(Math.random() * QUIPS.length)], { speakIt: false }); }, 4 * 60 * 1000);
  setInterval(() => { setMood("excited", { hold: 6000 }); say("You've been at it over 45 minutes — take a short break. ☕"); }, 50 * 60 * 1000);
  setInterval(() => { if (autoMood) refreshBaseMood(); }, 4 * 60 * 1000);
  setInterval(() => { if (!$("setup").classList.contains("hidden") || chatOpen) return; if (Math.random() < 0.6) { stage.classList.add("hop"); setTimeout(() => stage.classList.remove("hop"), 680); } }, 13 * 1000);
  setInterval(() => { if (bubble.classList.contains("hidden") && !chatOpen && Math.random() < 0.35) setMood("love", { hold: 3000 }); }, 7 * 60 * 1000);
  let idleTimer = setTimeout(() => setMood("sleepy"), 5 * 60 * 1000);
  const resetIdle = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => setMood("sleepy"), 5 * 60 * 1000); };
  ["mousemove", "keydown", "click"].forEach((ev) => window.addEventListener(ev, resetIdle, { passive: true }));
}

/* ============================ click-through ============================ */
function setupClickThrough() {
  const interactive = ".char, .bubble, .chatwrap, .setup";
  let over = null;
  window.addEventListener("mousemove", (e) => {
    if (!$("setup").classList.contains("hidden")) return;
    const el = document.elementFromPoint(e.clientX, e.clientY);
    const isOver = !!(el && el.closest && el.closest(interactive));
    if (isOver !== over) { over = isOver; window.zumi.setIgnore(!isOver); }
  });
  document.addEventListener("mouseleave", () => { if ($("setup").classList.contains("hidden")) window.zumi.setIgnore(true); });
}

/* ============================ drag + right-click ============================ */
const char = $("char");
let dragging = false, moved = false;
char.addEventListener("pointerdown", async (e) => { if (e.button !== 0) return; dragging = true; moved = false; try { char.setPointerCapture(e.pointerId); } catch {} await window.zumi.dragBegin(); });
char.addEventListener("pointermove", async () => { if (dragging) { moved = true; await window.zumi.dragTo(); } });
char.addEventListener("pointerup", async () => { if (!dragging) return; dragging = false; await window.zumi.dragEnd(); });
char.addEventListener("contextmenu", (e) => { e.preventDefault(); window.zumi.showMenu(); });

/* ============================ setup ============================ */
function showSetup() {
  stage.classList.add("setup-on");
  window.zumi.setupMode(true);
  $("u_name").value = settings.buddyName || "Zumi";
  $("u_key").value = settings.apiKey || "";
  $("u_model").value = settings.model || "deepseek-chat";
  $("u_base").value = settings.baseUrl || "https://api.deepseek.com";
  $("u_voice").checked = settings.voice !== false;
  $("u_voiceCtl").checked = settings.voiceControl !== false;
  $("u_size").value = settings.size || 200;
  $("setup").classList.remove("hidden");
  $("u_name").focus();
}
async function finishSetup() {
  const patch = {
    apiKey: $("u_key").value.trim(),
    baseUrl: $("u_base").value.trim() || "https://api.deepseek.com",
    model: $("u_model").value.trim() || "deepseek-chat",
    buddyName: $("u_name").value.trim() || "Zumi",
    voice: $("u_voice").checked,
    voiceControl: $("u_voiceCtl").checked,
    size: parseInt($("u_size").value, 10) || 200,
    setupDone: true,
  };
  settings = await window.zumi.setSettings(patch);
  buddyName = settings.buddyName; voiceOn = settings.voice; autoMood = settings.autoMood !== false;
  $("setup").classList.add("hidden");
  stage.classList.remove("setup-on");
  window.zumi.setupMode(false);
  startBuddy();
  setTimeout(() => say(`Hi! I'm ${buddyName}! 🎉 Press Ctrl+Alt+Z and just talk to me.`, { mood: "excited" }), 500);
}

/* ============================ start ============================ */
function startBuddy() {
  if (started) return;
  started = true;
  document.title = buddyName;
  refreshBaseMood();
  setupClickThrough();
  refreshBrain();
  window.zumi.onReminder((r) => fireReminder(r.text));
  window.zumi.onTaskUpdate((p) => {
    if (p.status === "running") { if (p.step) say(`⚙️ ${p.step}/${p.total}: ${p.action}`, { speakIt: false, ms: 2500 }); }
    else if (p.status === "completed") say(`✅ Task ${p.task_id || ""} completed${p.title ? ": " + p.title : ""}`, { mood: "excited" });
    else if (p.status === "failed") say(`❌ Task ${p.task_id || ""} failed: ${p.error || ""}`, { mood: "sad" });
    else if (p.status === "waiting") say(`⏸️ ${p.task_id} waiting — say "/confirm ${p.task_id}" to run.`, { speakIt: false, ms: 14000 });
    else if (p.status === "blocked") say(`🚧 Task ${p.task_id || ""} blocked: ${p.error || ""}`, { mood: "sad" });
    else if (p.status === "cancelled") say(`🚫 Task ${p.task_id || ""} cancelled.`, { mood: "cool" });
  });
  window.zumi.onTaskThinking((p) => { if (p && p.text) say(p.text, { speakIt: false, ms: 5000, mood: "excited" }); });

  /* ---- live progress for the 10k mission (bar above Zumi + bubble) ---- */
  window.zumi.onBatchProgress((p) => {
    const processed = (p.done || 0) + (p.failed || 0);
    const pct = p.percent != null ? p.percent : Math.round((processed / Math.max(1, p.total)) * 100);
    setBusy(true); setProgress(pct, `Safe batch ${processed}/${p.total}`);
    muteFor(4000);
    window.__mission = { stage: "safe", processed, total: p.total, pct, failed: p.failed };
    say(`⚙ Safe PC tasks ${processed}/${p.total} (${pct}%) · ${p.failed} failed${p.current ? "\n" + p.current : ""}`, { speakIt: false, ms: 3200, mood: "excited", force: true });
  });
  window.zumi.onBatchDone((p) => {
    const secs = Math.round((p.elapsed || 0) / 1000);
    muteFor(7000);
    window.__mission = { stage: queueAfterBatch ? "code" : "safe-done", done: p.done, total: p.total, failed: p.failed, secs };
    say(`✅ Safe half DONE — ${p.done}/${p.total} completed · ${p.failed} failed · ${secs}s. Starting the code half...`, { speakIt: false, ms: 12000, mood: "excited", force: true });
    if (queueAfterBatch) { const go = queueAfterBatch; queueAfterBatch = null; go(); return; }
    setBusy(false); setProgress(100, "Safe batch complete");
    setTimeout(() => setProgress(null), 4000);
  });
  window.zumi.onCodeProgress((p) => {
    const pct = p.percent != null ? p.percent : Math.round((p.written / Math.max(1, p.total)) * 100);
    setBusy(true); setProgress(pct, `Code batch ${p.written}/${p.total}`);
    muteFor(4000);
    window.__mission = { stage: "code", written: p.written, total: p.total, pct, passed: p.passed, failed: p.failed };
    say(`⌨ Code files ${p.written}/${p.total} (${pct}%) · ${p.passed} passed · ${p.failed} failed`, { speakIt: false, ms: 3200, mood: "excited", force: true });
  });
  window.zumi.onCodeDone((p) => {
    setBusy(false); setProgress(100, "Code batch complete");
    muteFor(9000);
    window.__mission = { stage: "done", written: p.written, ran: p.ran, passed: p.passed, failed: p.failed, dir: p.dir };
    setTimeout(() => setProgress(null), 5000);
    say(`🎉 Mission complete!\nCode: ${p.passed}/${p.ran} passed · ${p.failed} failed · ${p.written} files in ${p.dir}\nNothing was deleted. Every file stays on this PC.`, { speakIt: false, ms: 20000, mood: "excited", force: true });
  });
  window.zumi.onDailyReport((p) => { if (p && p.text) { setProgress(null); say(p.text, { speakIt: false, ms: 30000, mood: "cool", force: true }); } });

  window.zumi.onTaskSpeak((p) => say(p.text, { speakIt: true }));
  window.zumi.onScheduleFire((p) => { say(`⏰ Scheduled task: ${p.schedule.task}`, { speakIt: false, ms: 6000 }); runAgentTask(p.schedule.task); });
  $("sendBtn").addEventListener("click", send);
  $("chatInput").addEventListener("keydown", (e) => { if (e.key === "Enter") send(); });
  $("micBtn").addEventListener("click", () => toggleVoice());
  window.zumi.onVoiceToggle(() => toggleVoice());
  document.addEventListener("keydown", (e) => { if (e.key === "F8") { e.preventDefault(); toggleVoice(); } });
  document.querySelectorAll(".chip").forEach((b) => b.addEventListener("click", () => {
    const cmd = b.dataset.cmd; const input = $("chatInput");
    if (cmd === "timer") { input.value = "remind me in 5 min to "; input.focus(); return; }
    if (cmd === "note") { input.value = "note "; input.focus(); return; }
    if (cmd === "pomodoro") input.value = "pomodoro";
    if (cmd === "shot") input.value = "screenshot";
    if (cmd === "stats") input.value = "cpu";
    if (cmd === "joke") input.value = "joke";
    send();
  }));
  if ("speechSynthesis" in window) speechSynthesis.onvoiceschanged = () => {};
  setTimeout(() => say(`${greetLine()} I'm ${buddyName} — press Ctrl+Alt+Z and just talk to me. 🎤`, { mood: "happy" }), 700);
  startLoops();
}

/* ============================ init ============================ */
window.addEventListener("error", (e) => vlog("RENDERER ERROR: " + (e.message || "") + " @" + String(e.filename || "").split(/[\\/]/).pop() + ":" + e.lineno));
window.addEventListener("unhandledrejection", (e) => vlog("UNHANDLED REJECTION: " + String((e.reason && e.reason.message) || e.reason)));
(async function init() {
  $("startBtn").addEventListener("click", finishSetup);
  settings = await window.zumi.getSettings();
  buddyName = settings.buddyName || "Zumi";
  voiceOn = settings.voice !== false;
  autoMood = settings.autoMood !== false;
  if (!settings.setupDone) { showSetup(); return; }
  startBuddy();
})();
