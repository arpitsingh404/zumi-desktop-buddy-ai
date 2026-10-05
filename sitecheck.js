"use strict";
/* Zumi website self-check module
   - verifySite(html)  : static audit (broken nav anchors, JS syntax errors, missing sections/features)
   - REPAIR_SCRIPT     : injected into every site Zumi builds; it repairs anchors, wires dead
                         buttons, adds smooth scrolling / menu / theme / say-hi / copy / accordion
                         so the page keeps working even if the generated JS is broken. */

const REQUIRED_HEADINGS = [
  ["About", /\babout\b/i],
  ["Features", /\bfeatures\b/i],
  ["How it works", /how\s+it\s+works/i],
  ["Agent Tools", /agent\s+tools/i],
  ["Commands", /\bcommands\b/i],
  ["Privacy", /privacy/i],
  ["FAQ", /\bfaq\b|frequently\s+asked/i],
  ["Setup", /\bsetup\b|\binstall\b/i],
];

function extractScripts(html) {
  const out = [];
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = re.exec(html))) {
    const attrs = m[1] || "";
    if (/\ssrc\s*=/i.test(attrs)) continue;
    if (/application\/json/i.test(attrs)) continue;
    out.push(m[2]);
  }
  return out;
}

function scriptParses(code) {
  try { new Function(code); return true; } catch { return false; }
}

/* Globals that a top-level const/let/var/function may NOT shadow (the browser throws a
   SyntaxError and the WHOLE script dies — e.g. "const top = ..." kills every button). */
const RESERVED_GLOBALS = new Set([
  "top", "parent", "self", "opener", "length", "name", "origin", "status", "location",
  "history", "screen", "event", "frames", "closed", "window", "document", "navigator",
  "localStorage", "sessionStorage", "locationbar", "menubar", "personalbar",
  "scrollbars", "statusbar", "toolbar", "defaultStatus", "customElements",
]);

function depthMap(code) {
  const d = new Uint8Array(code.length);
  let depth = 0, i = 0, state = "code";
  const n = code.length;
  while (i < n) {
    const c = code[i], c2 = code[i + 1];
    d[i] = depth > 255 ? 255 : depth;
    if (state === "code") {
      if (c === "/" && c2 === "/") { state = "lc"; d[i + 1] = d[i]; i += 2; continue; }
      if (c === "/" && c2 === "*") { state = "bc"; d[i + 1] = d[i]; i += 2; continue; }
      if (c === "'" || c === '"' || c === "`") { state = c; i++; continue; }
      if (c === "{") depth = Math.min(255, depth + 1);
      else if (c === "}") depth = Math.max(0, depth - 1);
      i++; continue;
    }
    if (state === "lc") { if (c === "\n") state = "code"; i++; continue; }
    if (state === "bc") { if (c === "*" && c2 === "/") { state = "code"; i += 2; continue; } i++; continue; }
    // string states
    if (c === "\\") { d[Math.min(n - 1, i + 1)] = d[i]; i += 2; continue; }
    if (c === state) state = "code";
    i++;
  }
  return d;
}

function topLevelReserved(code) {
  const d = depthMap(code);
  const re = /(?:^|[;}\n)])(?:\s*)(?:const|let|var|function)\s+([A-Za-z_$][\w$]*)/g;
  const bad = [];
  let m;
  while ((m = re.exec(code))) {
    const at = m.index + (m[0].length - m[0].replace(/^\s*[;}\n)]/, "").length);
    if (d[m.index] === 0 && RESERVED_GLOBALS.has(m[1]) && !bad.includes(m[1])) bad.push(m[1]);
  }
  return bad;
}

/* Wrap page scripts that would die at global scope in an IIFE so they actually run. */
function hardenScripts(html) {
  const h = String(html || "");
  const re = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let m;
  let out = h;
  let offset = 0;
  while ((m = re.exec(h))) {
    const attrs = m[1] || "";
    const code = m[2];
    if (/\ssrc\s*=|application\/json/i.test(attrs) || code.indexOf("/*zumi-hardened*/") !== -1) continue;
    if (!topLevelReserved(code).length) continue;
    const wrapped = "<script" + attrs + ">(function(){\n/*zumi-hardened*/\n" + code + "\n})();</script>";
    out = out.slice(0, m.index + offset) + wrapped + out.slice(m.index + offset + m[0].length);
    offset += wrapped.length - m[0].length;
  }
  return out;
}

function norm(s) { return String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim(); }
function stripTags(s) { return String(s || "").replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim(); }

/* Deterministic repair: make every nav link resolve and close truncated documents. */
function repairHtml(html) {
  let h = String(html || "");
  if (!h) return h;
  const ids = new Set();
  let m;
  const idRe = /\sid=["']([^"']+)["']/gi;
  while ((m = idRe.exec(h))) ids.add(m[1]);

  // missing anchor targets -> put the id on the matching heading (or its section)
  const missing = [];
  const hrefRe = /href=["']#([^"']+)["']/gi;
  while ((m = hrefRe.exec(h))) if (m[1] && !ids.has(m[1]) && !missing.includes(m[1])) missing.push(m[1]);

  if (missing.length) {
    const heads = [];
    const hre = /<(h[1-4])\b([^>]*)>([\s\S]*?)<\/\1>/gi;
    while ((m = hre.exec(h))) heads.push({ tag: m[1], attrs: m[2], at: m.index, open: h.lastIndexOf("<" + m[1], m.index), text: stripTags(m[3]) });

    for (const id of missing) {
      // what does the link that points here say?
      const are = new RegExp("href=[\"']#" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"'][^>]*>([\\s\\S]{0,120}?)<", "i");
      const am = are.exec(h);
      const linkText = am ? stripTags(am[1]) : "";
      const want = norm(id);
      const wantLink = norm(linkText);
      let best = null;
      for (const hd of heads) {
        const t = norm(hd.text);
        if (!t) continue;
        if (t === want || (want && t.includes(want)) || (want && want.includes(t)) ||
            (wantLink && (t === wantLink || t.includes(wantLink) || wantLink.includes(t)))) { best = hd; break; }
      }
      if (!best) continue;
      const at = h.lastIndexOf("<" + best.tag, best.at);
      if (at === -1) continue;
      const close = h.indexOf(">", at);
      if (close === -1) continue;
      const tag = h.slice(at, close);
      if (/\sid\s*=/i.test(tag)) {
        const real = (/\sid\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
        if (real) h = h.split('href="#' + id + '"').join('href="#' + real + '"');
      } else {
        h = h.slice(0, close) + ' id="' + id + '"' + h.slice(close);
        ids.add(id);
      }
    }

    // pass 2: no heading? find the section that actually CONTAINS the link's text
    const navEnd = Math.max(0, h.toLowerCase().search(/<\/nav>/i));
    const stillMissing = missing.filter((x) => !ids.has(x));
    const enclosing = (from, idx, tags) => {
      let found = null;
      for (const t of tags) {
        const openRe = new RegExp("<" + t + "\\b[^>]*>", "gi");
        let m2;
        while ((m2 = openRe.exec(from))) {
          if (m2.index >= idx) break;
          const closeIdx = from.toLowerCase().indexOf("</" + t, openRe.lastIndex);
          if (closeIdx === -1 || closeIdx > idx) { const last = found ? found.at : -1; if (m2.index > last) found = { at: m2.index, open: m2[0], tag: t }; }
        }
      }
      return found;
    };
    const applyId = (id, at, openTag) => {
      const close = h.indexOf(">", at);
      if (close === -1) return;
      const tag = h.slice(at, close);
      if (/\sid\s*=/i.test(tag)) {
        const real = (/\sid\s*=\s*["']([^"']+)["']/i.exec(tag) || [])[1];
        if (real && real !== id) h = h.split('href="#' + id + '"').join('href="#' + real + '"');
      } else {
        h = h.slice(0, close) + ' id="' + id + '"' + h.slice(close);
        ids.add(id);
      }
    };
    for (const id of stillMissing) {
      if (ids.has(id)) continue;
      if (id === "top") { const b = h.search(/<body\b/i); if (b !== -1 && !/\sid\s*=/.test(h.slice(b, h.indexOf(">", b)))) { applyId(id, b, ""); continue; } }
      const are = new RegExp("href=[\"']#" + id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&") + "[\"'][^>]*>([\\s\\S]{0,120}?)<", "i");
      const am = are.exec(h);
      const text = (am ? stripTags(am[1]) : id).toLowerCase();
      if (!text) continue;
      const idx = h.toLowerCase().indexOf(text, navEnd);
      if (idx === -1) continue;
      const host = enclosing(h, idx, ["section", "article", "main"]);
      if (host) applyId(id, host.at, host.open);
    }

    // pass 3: last resort — pair leftover links with leftover id-less sections in order
    const leftover = missing.filter((x) => !ids.has(x));
    if (leftover.length) {
      const free = [];
      const sre = /<(section|article)\b([^>]*)>/gi;
      let s;
      while ((s = sre.exec(h))) if (!/\sid\s*=/i.test(s[2])) free.push(s.index);
      if (free.length === leftover.length) leftover.forEach((id, i) => applyId(id, free[i], ""));
    }
  }

  // truncated output (model ran out of tokens) -> close the document
  if (!/<\/html>/i.test(h)) {
    if (!/<\/body>/i.test(h)) h += "</body>";
    h += "</html>";
  }
  return h;
}

function verifySite(html) {
  const h = String(html || "");
  const issues = [];
  if (!h.trim()) return { ok: false, issues: ["empty document"], bytes: 0, ids: 0 };

  if (!/<!doctype html/i.test(h)) issues.push("missing <!doctype html>");
  if (!/<\/html>/i.test(h)) issues.push("missing </html> close tag");
  if (!/<nav\b/i.test(h)) issues.push("missing <nav> navigation bar");

  // --- JavaScript syntax: one broken <script> kills every button on the page ---
  const scripts = extractScripts(h);
  let broken = 0;
  scripts.forEach((code, i) => {
    if (!code.trim()) return;
    if (!scriptParses(code)) {
      broken++;
      issues.push(`script block #${i + 1} has a JavaScript syntax error (page buttons will be dead)`);
    }
  });

  // --- anchor links must resolve to real ids ---
  const ids = new Set();
  const idRe = /\sid=["']([^"']+)["']/gi;
  let m;
  while ((m = idRe.exec(h))) ids.add(m[1]);

  const missing = new Set();
  const hrefRe = /href=["']#([^"']+)["']/gi;
  while ((m = hrefRe.exec(h))) if (m[1] && !ids.has(m[1])) missing.add(m[1]);
  if (missing.size) issues.push("nav links point to sections that do not exist: " + [...missing].map((x) => "#" + x).join(", "));

  // --- required sections ---
  for (const [name, re] of REQUIRED_HEADINGS) if (!re.test(h)) issues.push("missing section: " + name);

  // --- script that runs before its elements exist (the classic "nothing is clickable") ---
  const idPos = new Map();
  const ipRe = /\sid=["']([^"']+)["']/gi;
  while ((m = ipRe.exec(h))) if (!idPos.has(m[1])) idPos.set(m[1], m.index);
  const scrRe = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;
  let sm;
  while ((sm = scrRe.exec(h))) {
    const attrs = sm[1] || "";
    if (/\ssrc\s*=|defer|async|type=["']module/i.test(attrs)) continue;
    const at = sm.index;
    const refs = sm[2].matchAll(/getElementById\(\s*["']([^"']+)["']\s*\)/g);
    const premature = [];
    for (const r of refs) {
      const pos = idPos.get(r[1]);
      if (pos !== undefined && pos > at) premature.push(r[1]);
    }
    if (premature.length) {
      issues.push("script runs BEFORE the elements it uses exist (" +
        [...new Set(premature)].slice(0, 6).join(", ") + ") — the code throws and every button stays dead; add defer or wrap it in DOMContentLoaded");
      break;
    }
  }

  // --- required interactivity ---
  if (!/speechSynthesis/.test(h)) issues.push("missing the Say hi speech button");
  if (!/addEventListener\(["']click|onclick\s*=/i.test(h)) issues.push("no click handlers found — every button would be dead");
  if (!/getElementById|querySelector/i.test(h)) issues.push("no DOM wiring found");
  if (!/scrollIntoView|scroll-behavior/i.test(h)) issues.push("smooth scrolling for nav links is missing");
  if (!/data-i18n/.test(h)) issues.push("language switcher (data-i18n) is missing");
  if (!/localStorage/.test(h)) issues.push("preferences are not persisted (localStorage missing)");
  if (!/class=["'][^"']*(hamburger|burger|menu|nav[-_ ]?toggle|navtoggle)/i.test(h) && !/id=["'][^"']*(menu|burger|hamburger|navtoggle|nav[-_ ]?toggle)/i.test(h)) {
    issues.push("no mobile menu toggle button");
  }

  return { ok: issues.length === 0, issues, bytes: h.length, ids: ids.size, scripts: scripts.length, brokenScripts: broken };
}

/* Runtime repair — injected before </body>. Must never contain the literal string "</script>". */
const REPAIR_SCRIPT = `
<style id="zumi-repair-css">html{scroll-behavior:smooth!important}section,article{scroll-margin-top:84px}h1,h2,h3,h4{overflow-wrap:break-word;max-width:100%}img,svg,video,table{max-width:100%}</style>
<script id="zumi-repair">
(function(){
  if(window.__zumiRepair) return; window.__zumiRepair=true;
  function slug(s){return String(s||"").toLowerCase().trim().replace(/[^a-z0-9]+/g,"-").replace(/^-+|-+$/g,"");}
  function all(sel,root){return Array.prototype.slice.call((root||document).querySelectorAll(sel));}
  function classifyScripts(){
    var valid="",dead="",mine=false;
    all("script").forEach(function(s){
      if(s.src||s.id==="zumi-repair"||(s.type&&s.type!=="text/javascript"&&s.type!=="module")) return;
      var c=s.textContent||"";
      var ok=true; try{new Function(c);}catch(e){ok=false;}
      if(ok) valid+=c+"\\n"; else dead+=c+"\\n";
    });
    return {valid:valid,dead:dead};
  }
  function repair(){
    try{
      var S=classifyScripts();
      function wired(el){
        if(!el) return true;
        if(el.hasAttribute&&el.hasAttribute("onclick")) return true;
        var toks=[el.id].concat(typeof el.className==="string"?el.className.split(/\\s+/):[]).filter(Boolean);
        if(!toks.length) return false;
        return toks.some(function(t){return t&&S.valid.indexOf(t)!==-1;});
      }
      /* 1. every section gets an id derived from its heading */
      all("section,article").forEach(function(sec,i){
        if(sec.id) return;
        var h=sec.querySelector("h1,h2,h3");
        var id=h?slug(h.textContent):("section-"+i);
        if(id) sec.id=id;
      });
      /* 2. repair broken anchor targets by matching the link text to a heading */
      all('a[href^="#"]').forEach(function(a){
        var id=(a.getAttribute("href")||"").slice(1); if(!id) return;
        if(document.getElementById(id)) return;
        var txt=slug(a.textContent); if(!txt) return;
        var target=null;
        all("h1,h2,h3").some(function(hh){
          var hs=slug(hh.textContent);
          if(hs&&(hs===txt||hs.indexOf(txt)===0||txt.indexOf(hs)===0)){
            target=hh.closest("section,article,main")||hh.parentElement; return true;
          }
          return false;
        });
        if(target){ if(!target.id) target.id=id; else a.setAttribute("href","#"+target.id); }
      });
      /* 3. smooth scroll + close mobile menu on every anchor click */
      all('a[href^="#"]').forEach(function(a){
        if(a.__zScroll) return; a.__zScroll=true;
        a.addEventListener("click",function(e){
          var id=(a.getAttribute("href")||"").slice(1);
          var t=id?document.getElementById(id):null;
          if(!t) return;
          e.preventDefault();
          t.scrollIntoView({behavior:"smooth",block:"start"});
          try{history.replaceState(null,"","#"+id);}catch(_){}
          var nav=document.querySelector("header nav,.navbar,nav");
          if(nav){nav.classList.remove("open");nav.classList.remove("is-open");nav.classList.remove("z-open");
            if(window.innerWidth<900){nav.style.removeProperty("display");nav.style.removeProperty("position");}}
        },true);
      });
      /* 3b. responsive edge guard — containers with no horizontal padding push text off-screen */
      all(".wrap,.container,.inner,.shell,.hero,.hero-wrap").forEach(function(el){
        var r=el.getBoundingClientRect();
        if(r.width < window.innerWidth-4) return;
        var s=getComputedStyle(el);
        if(parseFloat(s.paddingLeft)>0||parseFloat(s.paddingRight)>0) return;
        el.style.setProperty("padding-left","clamp(16px,4vw,40px)","important");
        el.style.setProperty("padding-right","clamp(16px,4vw,40px)","important");
      });
      /* 4. PROBE what the page really wired (addEventListener is invisible), then fix the rest */
      function pick(re){ return all("button,a,select").filter(function(b){return re.test((b.id||"")+" "+(typeof b.className==="string"?b.className:"")+" "+(b.getAttribute&&b.getAttribute("aria-label")||""));})[0]; }
      function click(el){ try{ el.dispatchEvent(new MouseEvent("click",{bubbles:true,cancelable:true})); }catch(_){ try{ el.click(); }catch(__){} } }
      var root=document.documentElement;
      var list=document.getElementById("navlist")||document.querySelector("nav ul, .navlist, .nav-links");
      var themeBtn=document.getElementById("theme")||pick(/theme[-_ ]?(toggle|btn|button)|toggle[-_ ]?theme|darkmode/i);
      var menuBtn=document.getElementById("menu")||pick(/burger|hamburger|menu[-_ ]?(btn|toggle|button)|nav[-_ ]?toggle/i);
      var topBtn=document.getElementById("top")||pick(/back[-_ ]?to[-_ ]?top|toTop|to-top/i);
      var langEl=document.getElementById("lang")||pick(/lang(uage)?[-_ ]?(toggle|switch|select|btn)/i);
      var sayBtn=document.getElementById("sayHi")||pick(/say[-_ ]?hi|hi[-_ ]?btn/i);

      var themeLive=false;
      if(themeBtn&&!themeBtn.onclick){
        var prevT=root.getAttribute("data-theme");
        root.setAttribute("data-theme","__zprobe");
        click(themeBtn);
        themeLive=root.getAttribute("data-theme")!=="__zprobe";
        if(prevT===null) root.removeAttribute("data-theme"); else root.setAttribute("data-theme",prevT);
      }
      var menuLive=false;
      if(menuBtn&&!menuBtn.onclick&&list){
        list.classList.remove("open");
        click(menuBtn);
        menuLive=list.classList.contains("open");
        list.classList.remove("open");
      }
      var sayLive=false;
      if(sayBtn&&!sayBtn.onclick){
        var hiOut=document.getElementById("hiOut");
        var beforeTxt=hiOut?hiOut.textContent:null;
        if(hiOut) hiOut.textContent="__zprobe__";
        click(sayBtn);
        sayLive=hiOut?hiOut.textContent!=="__zprobe__":!!wired(sayBtn);
        if(hiOut) hiOut.textContent=beforeTxt;
      }
      var langLive=false;
      if(langEl&&!langEl.onchange){
        var i18nNode=document.querySelector("[data-i18n]");
        if(langEl.tagName==="SELECT"&&i18nNode&&langEl.options.length>1){
          var t0=i18nNode.textContent, v0=langEl.value;
          var other=Array.prototype.filter.call(langEl.options,function(o){return o.value!==v0;})[0];
          if(other){
            langEl.value=other.value; langEl.dispatchEvent(new Event("change",{bubbles:true}));
            langLive=i18nNode.textContent!==t0;
            langEl.value=v0; langEl.dispatchEvent(new Event("change",{bubbles:true}));
          }
        } else langLive=!!wired(langEl);
      }

      /* theme fallback — only if the page really does not react */
      if(themeBtn&&!themeLive&&!themeBtn.__z){
        themeBtn.__z=true;
        themeBtn.addEventListener("click",function(){
          var light=root.getAttribute("data-theme")==="light";
          var next=light?"":"light";
          root.setAttribute("data-theme",next);
          root.classList.toggle("light",next==="light");
          document.body.classList.toggle("light",next==="light");
          try{localStorage.setItem("zumi-theme",next==="light"?"light":"dark");localStorage.setItem("zumiTheme",next);}catch(_){}
        });
      }
      /* mobile menu fallback */
      if(menuBtn&&!menuLive&&!menuBtn.__z){
        menuBtn.__z=true;
        menuBtn.addEventListener("click",function(){
          var open=false;
          if(list) open=list.classList.toggle("open");
          var nav=document.querySelector("header nav,.navbar,nav");
          if(!list&&nav&&window.innerWidth<900){
            open=nav.classList.toggle("z-open");
            if(open){
              nav.style.setProperty("display","flex","important");
              nav.style.setProperty("flex-direction","column","important");
              nav.style.setProperty("position","absolute","important");
              nav.style.setProperty("top","64px","important");
              nav.style.setProperty("left","0","important");
              nav.style.setProperty("right","0","important");
              nav.style.setProperty("z-index","999","important");
              nav.style.setProperty("background","#0a0f13","important");
              nav.style.setProperty("padding","14px 18px","important");
              nav.style.setProperty("gap","12px","important");
            }else{
              ["display","flex-direction","position","top","left","right","z-index","background","padding","gap"].forEach(function(p){nav.style.removeProperty(p);});
            }
          }
          if(!list&&!nav) open=menuBtn.getAttribute("aria-expanded")!=="true";
          menuBtn.setAttribute("aria-expanded",open?"true":"false");
        });
      }
      /* back-to-top fallback */
      if(topBtn&&!topBtn.onclick&&!topBtn.__z&&!wired(topBtn)){
        topBtn.__z=true;
        topBtn.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"});});
      }
      /* language switcher fallback */
      if(langEl&&!langLive&&!langEl.__z){
        langEl.__z=true;
        var applyLang=function(l){
          var dict=(typeof D!=="undefined"&&D)||window.I18N||window.translations||null;
          all("[data-i18n]").forEach(function(el){
            var k=el.getAttribute("data-i18n");
            var en=el.getAttribute("data-en");
            if(en===null){ en=el.textContent; el.setAttribute("data-en",en); }
            var hi=el.getAttribute("data-hi")||null;
            if(!hi&&dict&&dict.hi) hi=dict.hi[k];
            if(l==="hi"&&hi) el.textContent=hi; else el.textContent=en;
          });
          root.lang=l;
          try{localStorage.setItem("zumi-lang",l);}catch(_){}
        };
        if(langEl.tagName==="SELECT") langEl.addEventListener("change",function(){ applyLang(langEl.value==="hi"?"hi":"en"); });
        else langEl.addEventListener("click",function(){ applyLang(root.lang==="hi"?"en":"hi"); });
      }
      /* accordion / tabs that never got a handler */
      all('button,[role="tab"]').forEach(function(b){
        if(b.__zAcc) return;
        var cls=(typeof b.className==="string"?b.className:"")+" "+(b.id||"");
        if(b.getAttribute("role")!=="tab"&&!b.hasAttribute("aria-expanded")&&!/accord|faq|tab|question|collapse|panel/i.test(cls)) return;
        if(wired(b)) return;
        b.__zAcc=true;
        b.addEventListener("click",function(){
          var open=b.hasAttribute("aria-expanded")&&b.getAttribute("aria-expanded")==="true";
          if(b.hasAttribute("aria-expanded")) b.setAttribute("aria-expanded",open?"false":"true");
          b.classList.toggle("active");
          if(b.parentElement) b.parentElement.classList.toggle("open");
          var panel=b.nextElementSibling;
          if(panel){
            if(panel.hasAttribute("hidden")) panel.removeAttribute("hidden");
            else if(open) panel.setAttribute("hidden","");
          }
        });
      });
      /* 5. say-hi speech button (only if the page's own handler is not working) */
      var sh=sayBtn||document.getElementById("sayHi");
      if(!sh){
        sh=document.createElement("button"); sh.id="sayHi"; sh.textContent="Say hi";
        sh.style.cssText="position:fixed;left:16px;bottom:16px;z-index:9999;padding:10px 14px;border-radius:12px;border:0;background:#5ad6b0;color:#052019;font-weight:700;cursor:pointer;box-shadow:0 6px 20px rgba(0,0,0,.35)";
        document.body.appendChild(sh);
      }
      if(!sh.__zSpeech&&!sh.onclick&&!sayLive){
        sh.__zSpeech=true;
        sh.addEventListener("click",function(){
          try{
            var u=new SpeechSynthesisUtterance("Hi! I am Zumi, your desktop buddy and PC agent.");
            speechSynthesis.speak(u);
          }catch(e){}
          var log=document.getElementById("zumiSayLog");
          if(!log){log=document.createElement("div");log.id="zumiSayLog";log.style.cssText="position:fixed;left:16px;bottom:64px;z-index:9999;padding:8px 12px;border-radius:10px;background:#111c26;color:#5ad6b0;font:13px system-ui;border:1px solid #22303a";document.body.appendChild(log);}
          log.textContent="Hi! I am Zumi, your desktop buddy and PC agent.";
        });
      }
      /* 6. copy buttons on every code block */
      all("pre").forEach(function(pre){
        if(pre.querySelector(".copybtn")) return;
        var b=document.createElement("button"); b.textContent="Copy"; b.className="copybtn";
        b.style.cssText="position:absolute;top:8px;right:8px;padding:4px 10px;border-radius:8px;border:1px solid #2c3743;background:#0a0f13;color:#5ad6b0;cursor:pointer;font:11px monospace";
        if(getComputedStyle(pre).position==="static") pre.style.position="relative";
        pre.appendChild(b);
        b.addEventListener("click",function(){
          var t=(pre.innerText||"").replace("Copy","").trim();
          try{navigator.clipboard.writeText(t);}catch(e){}
          b.textContent="Copied!"; setTimeout(function(){b.textContent="Copy";},1200);
        });
      });
      /* 7. audit hook — lets Zumi (and anyone) check the page at runtime */
      window.__zumiAudit=function(){
        var anchors=all('a[href^="#"]'),broken=[],dead=[];
        anchors.forEach(function(a){var id=(a.getAttribute("href")||"").slice(1);if(id&&!document.getElementById(id))broken.push("#"+id);});
        all("button").forEach(function(b){var t=(b.textContent||"").trim();if(!t&&!b.getAttribute("aria-label")&&!b.querySelector("svg,i,img"))dead.push(b.id||b.className||"button");});
        return {title:document.title,anchors:anchors.length,brokenAnchors:broken,sections:all("section").length,emptyButtons:dead,repairActive:!!window.__zumiRepair};
      };
    }catch(e){}
  }
  if(document.readyState==="loading") document.addEventListener("DOMContentLoaded",repair); else repair();
})();
</scr` + `ipt>`;

module.exports = { verifySite, repairHtml, hardenScripts, extractScripts, REPAIR_SCRIPT, REQUIRED_HEADINGS };
