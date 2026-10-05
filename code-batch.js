/* Zumi coding batch — writes code files, VERIFIES them, reports results.
 * Usage: node code-batch.js <count> [concurrency]
 * Writes to %USERPROFILE%\ZumiWorkspace\code  and a report to CODE_REPORT.md
 * Nothing is ever deleted.
 *
 * v2 — verified in-process with node's `vm` sandbox instead of spawning one
 * `node.exe` per file. The old build spawned 16 processes in a loop, which kept
 * the CPU churning for hours and made the buddy window freeze. Same checks,
 * same files, same report — no child processes, so the PC stays responsive.
 * It also RESUMES: it picks up from the highest file index already on disk.
 */
const fs = require("fs");
const path = require("path");
const os = require("os");
const vm = require("vm");

const CODE_DIR = path.join(os.homedir(), "ZumiWorkspace", "code");
const REPORT = path.join(os.homedir(), "ZumiWorkspace", "CODE_REPORT.md");
const count = Math.max(1, Math.min(1000000, parseInt(process.argv[2] || "1000", 10)));
const concurrency = Math.max(1, Math.min(16, parseInt(process.argv[3] || "4", 10)));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeJs(i) {
  const k = i % 8;
  const n = (i % 40) + 3;
  if (k === 0) { const e = (n * (n + 1)) / 2; return { name: "sum", code: `let s=0;for(let i=1;i<=${n};i++)s+=i;console.log(s);`, expect: String(e) }; }
  if (k === 1) { let f = 1; for (let j = 1; j <= n; j++) f *= j; return { name: "factorial", code: `let f=1;for(let i=1;i<=${n};i++)f*=i;console.log(f);`, expect: String(f) }; }
  if (k === 2) { let a = 0, b = 1; for (let j = 0; j < n; j++) { const t = a + b; a = b; b = t; } return { name: "fib", code: `let a=0,b=1;for(let i=0;i<${n};i++){let t=a+b;a=b;b=t;}console.log(a);`, expect: String(a) }; }
  if (k === 3) { const m = (i % 17) + 2; let x = n, y = m; while (y) { const t = y; y = x % y; x = t; } return { name: "gcd", code: `let x=${n},y=${m};while(y){let t=y;y=x%y;x=t;}console.log(x);`, expect: String(x) }; }
  if (k === 4) { const e = (i % 10) + 2; return { name: "pow", code: `console.log(Math.pow(2,${e}));`, expect: String(Math.pow(2, e)) }; }
  if (k === 5) { const s = "zumi" + (i % 9); return { name: "reverse", code: `let s="${s}";console.log(s.split("").reverse().join(""));`, expect: s.split("").reverse().join("") }; }
  if (k === 6) { let c = 0; for (let v = 2; v <= n; v++) { let p = true; for (let d = 2; d * d <= v; d++) if (v % d === 0) { p = false; break; } if (p) c++; } return { name: "primes", code: `let c=0;for(let v=2;v<=${n};v++){let p=true;for(let d=2;d*d<=v;d++)if(v%d===0){p=false;break;}if(p)c++;}console.log(c);`, expect: String(c) }; }
  let s = 0; for (let v = 1; v <= n; v++) if (v % 3 !== 0) s += v;
  return { name: "skip3", code: `let s=0;for(let i=1;i<=${n};i++)if(i%3!==0)s+=i;console.log(s);`, expect: String(s) };
}

/* run a snippet in-process: identical console output, zero child processes */
function runVm(code) {
  const out = [];
  const log = (...a) => out.push(a.map((x) => String(x)).join(" "));
  try {
    const ctx = vm.createContext({ console: { log, info: log, warn: log, error: log, debug: log } });
    vm.runInContext(code, ctx, { timeout: 4000, displayErrors: false });
    return out.join("\n");
  } catch (e) {
    const msg = String((e && e.message) || e);
    if (/(require|module|exports|__dirname|__filename|process|Buffer)\s+is not defined/.test(msg)) return "__NEEDS_NODE__";
    return "ERR:" + msg;
  }
}

async function main() {
  fs.mkdirSync(CODE_DIR, { recursive: true });

  /* resume: find the highest index already written, re-check a small tail in case
     the previous run was interrupted mid-write, then continue from there. */
  let maxIndex = 0;
  for (const n of fs.readdirSync(CODE_DIR)) {
    const m = /^(\d{7})-/.exec(n);
    if (m) { const v = parseInt(m[1], 10); if (v > maxIndex) maxIndex = v; }
  }
  const startAt = Math.max(1, Math.min(count, maxIndex > 0 ? maxIndex - 99 : 1));
  console.log(`Zumi code batch: target ${count} · resume from #${startAt} (highest on disk: ${maxIndex}) · ${concurrency} worker(s) · verify=vm`);

  const t0 = Date.now();
  let idx = startAt - 1, written = 0, existed = 0, ran = 0, passed = 0, failed = 0, bytes = 0;
  const samples = [];
  const worker = async () => {
    while (true) {
      const i = ++idx;
      if (i > count) break;
      const t = makeJs(i);
      const file = path.join(CODE_DIR, String(i).padStart(7, "0") + "-" + t.name + ".js");
      let src;
      if (fs.existsSync(file)) { existed++; src = safeRead(file); if (src === null || src !== t.code) { src = t.code; try { fs.writeFileSync(file, src); written++; bytes += src.length; } catch { failed++; continue; } } }
      else { src = t.code; try { fs.writeFileSync(file, src); written++; bytes += src.length; } catch { failed++; continue; } }

      let out = runVm(src);
      if (out === "__NEEDS_NODE__") out = await runExternal(file);
      ran++;
      if (out.trim() === t.expect) { passed++; if (samples.length < 5) samples.push(`  ${path.basename(file)} → ${out.trim()} (expected ${t.expect}) pass`); }
      else { failed++; if (samples.length < 8) samples.push(`  ${path.basename(file)} → ${out.trim()} (expected ${t.expect}) FAIL`); }

      const done = i - startAt + 1;
      if (done % 1000 === 0) {
        const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
        process.stdout.write(`\r  ${i}/${count} written=${written} ran=${ran} passed=${passed} failed=${failed} (${Math.round(done / secs)}/s)   `);
      }
      if (done % 400 === 0) await sleep(8);   // be polite: never hog a whole core for hours
    }
  };
  await Promise.all(Array.from({ length: concurrency }, worker));

  const secs = Math.max(1, Math.round((Date.now() - t0) / 1000));
  console.log("");
  const report = [
    "# Zumi Coding Batch Report",
    "Date: " + new Date().toISOString().slice(0, 10),
    "",
    `Tasks (code files): ${count}`,
    `Resumed from index: ${startAt} (files already on disk: ${existed})`,
    `Written this run: ${written}`,
    `Ran (verified in-process with node vm): ${ran}`,
    `Passed (output verified): ${passed}`,
    `Failed: ${failed}`,
    `Bytes written: ${bytes}`,
    `Duration: ${secs}s (${Math.round(ran / secs)} files/s)`,
    `Folder: ${CODE_DIR}`,
    "",
    "## Sample verifications",
    ...samples,
    "",
    "Nothing was deleted — every file stays on this PC.",
    "",
  ].join("\n");
  try { fs.writeFileSync(REPORT, report); } catch { /* ignore */ }
  console.log("done: " + JSON.stringify({ written, ran, passed, failed, secs, report: REPORT }));
}

function safeRead(f) { try { return fs.readFileSync(f, "utf8"); } catch { return null; } }

/* fallback for snippets that really need node APIs (none do today) */
const { execFile } = require("child_process");
function runExternal(file) {
  return new Promise((res) => execFile(process.execPath, [file], { timeout: 8000, windowsHide: true, maxBuffer: 1e6 }, (err, stdout) => res((stdout || "").toString())));
}

main().catch((e) => { console.error("FATAL", e); process.exit(1); });
