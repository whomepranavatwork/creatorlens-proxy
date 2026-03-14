"use strict";

const express = require("express");
const app     = express();

app.use(express.json({ limit: "5mb" }));

const APIFY        = "https://api.apify.com/v2";
const ACTOR        = "apify~instagram-profile-scraper";
const GEMINI_URL   = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
const GEMINI_MODEL = "gemini-1.5-flash";
const PORT         = process.env.PORT || 3001;

const GEMINI_KEY = process.env.GEMINI_API_KEY || "";
if (!GEMINI_KEY) {
  console.error("WARNING: GEMINI_API_KEY is not set.");
} else {
  console.log("GEMINI_API_KEY is set (" + GEMINI_KEY.slice(0, 12) + "...)");
}

// ── Routes ───────────────────────────────────────────────────────────────────

app.get("/health", (_req, res) => {
  res.json({ ok: true, geminiKeySet: !!GEMINI_KEY });
});

app.post("/start", async (req, res) => {
  const { username, apifyKey } = req.body || {};
  if (!username || !apifyKey)
    return res.status(400).json({ error: "[start] username and apifyKey are required." });
  try {
    const r = await fetch(`${APIFY}/acts/${ACTOR}/runs?token=${apifyKey}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], resultsLimit: 30, resultsType: "posts" }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = b?.error?.message || b?.message || JSON.stringify(b).slice(0, 300);
      return res.status(r.status).json({ error: `[start] Apify error ${r.status}: ${msg}` });
    }
    const runId     = b?.data?.id;
    const datasetId = b?.data?.defaultDatasetId;
    if (!runId)
      return res.status(500).json({ error: "[start] Apify returned no runId.", raw: JSON.stringify(b).slice(0, 300) });
    return res.json({ runId, datasetId });
  } catch (e) {
    return res.status(500).json({ error: `[start] ${e.message}` });
  }
});

app.get("/status/:runId", async (req, res) => {
  const { apifyKey } = req.query;
  if (!apifyKey) return res.status(400).json({ error: "[status] apifyKey required." });
  try {
    const r = await fetch(`${APIFY}/actor-runs/${req.params.runId}?token=${apifyKey}`);
    const b = await r.json().catch(() => ({}));
    return res.json({ status: b?.data?.status || "UNKNOWN" });
  } catch (e) {
    return res.status(500).json({ error: `[status] ${e.message}` });
  }
});

app.get("/dataset/:datasetId", async (req, res) => {
  const { apifyKey } = req.query;
  if (!apifyKey) return res.status(400).json({ error: "[dataset] apifyKey required." });
  try {
    const r = await fetch(`${APIFY}/datasets/${req.params.datasetId}/items?token=${apifyKey}&format=json`);
    const items = await r.json().catch(() => null);
    if (!r.ok || !items)
      return res.status(r.status || 500).json({ error: `[dataset] Apify dataset fetch failed (${r.status}).` });
    if (!Array.isArray(items) || !items.length)
      return res.status(404).json({ error: "[dataset] No data returned. Account may be private or username is wrong." });

    const trimmed = items.map(p => ({
      username:       p.username,
      fullName:       p.fullName || p.name,
      biography:      p.biography || p.bio,
      profilePicUrl:  p.profilePicUrl || p.profilePicUrlHD,
      isVerified:     p.isVerified,
      followersCount: p.followersCount,
      followsCount:   p.followsCount,
      postsCount:     p.postsCount || p.mediaCount,
      latestPosts: (p.latestPosts || p.topPosts || p.posts || []).map(x => ({
        timestamp:      x.timestamp,
        likesCount:     x.likesCount,
        commentsCount:  x.commentsCount,
        videoViewCount: x.videoViewCount || x.videoPlayCount || x.playCount,
        type:           x.type || x.productType,
        caption:        (x.caption || "").slice(0, 500),
        url:            x.url,
        shortCode:      x.shortCode,
      })),
    }));

    return res.json({ data: trimmed });
  } catch (e) {
    return res.status(500).json({ error: `[dataset] ${e.message}` });
  }
});

app.post("/analyze", async (req, res) => {
  const { prompt } = req.body || {};
  if (!prompt) return res.status(400).json({ error: "[analyze] prompt is required." });
  if (!GEMINI_KEY)
    return res.status(500).json({ error: "[analyze] GEMINI_API_KEY is not set on the server. Add it in Railway → Variables." });
  try {
    const r = await fetch(`${GEMINI_URL}?key=${GEMINI_KEY}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: { temperature: 0.4, maxOutputTokens: 4000 },
      }),
    });
    const b = await r.json().catch(() => ({}));
    if (!r.ok) {
      const msg = b?.error?.message || JSON.stringify(b).slice(0, 300);
      return res.status(r.status).json({ error: `[analyze] Gemini API error ${r.status}: ${msg}` });
    }
    const raw   = b.candidates?.[0]?.content?.parts?.[0]?.text || "{}";
    const match = raw.match(/\{[\s\S]*\}/);
    const text  = match ? match[0] : "{}";
    let parsed;
    try { parsed = JSON.parse(text); }
    catch (e) {
      return res.status(500).json({ error: "[analyze] Claude returned malformed JSON.", raw: text.slice(0, 400) });
    }
    return res.json({ result: parsed });
  } catch (e) {
    return res.status(500).json({ error: `[analyze] ${e.message}` });
  }
});

// ── Serve HTML ───────────────────────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html; charset=utf-8");
  res.send(getHTML());
});

app.listen(PORT, () => console.log("CreatorLens running on port " + PORT));

// ─────────────────────────────────────────────────────────────────────────────
// HTML + client JS — built with string arrays, zero template-literal escaping
// ─────────────────────────────────────────────────────────────────────────────
function getHTML() {
  var css = [
    "*{box-sizing:border-box;margin:0;padding:0}",
    ":root{--bg:#06060E;--card:#0C0C18;--border:#181830;--amber:#F59E0B;--indigo:#6366F1;--green:#10B981;--red:#EF4444;--pink:#EC4899;--teal:#14B8A6;--text:#EEEEFA;--muted:#565672;--dim:#1E1E30}",
    "body{background:var(--bg);color:var(--text);font-family:'Syne',system-ui,sans-serif;min-height:100vh}",
    ".mono{font-family:'Space Mono',monospace}",
    "input{background:#09091A;border:1px solid var(--dim);border-radius:8px;padding:11px 13px;color:var(--text);font-size:14px;outline:none;width:100%;transition:border-color .2s;font-family:inherit}",
    "input:focus{border-color:var(--amber)}",
    "button{cursor:pointer;font-family:'Syne',system-ui,sans-serif;font-weight:800;border:none;border-radius:8px}",
    ".btn{background:var(--amber);color:#06060E;padding:13px 24px;font-size:14px;width:100%}",
    ".btn-sm{background:var(--amber);color:#06060E;padding:9px 18px;font-size:13px}",
    ".btn-ghost{background:transparent;border:1px solid var(--dim);color:var(--muted);padding:7px 16px;font-size:12px;font-weight:600}",
    ".card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}",
    ".tag{display:inline-flex;align-items:center;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-family:'Space Mono',monospace;white-space:nowrap}",
    ".lbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:7px}",
    ".scr{display:none}",
    ".grid{display:grid;gap:10px}",
    "@keyframes spin{to{transform:rotate(360deg)}}",
    "@keyframes pulse{0%,100%{opacity:.9}50%{opacity:.4}}",
    ".spinner{width:48px;height:48px;border-radius:50%;border:3px solid var(--border);border-top:3px solid var(--amber);animation:spin .9s linear infinite;margin:0 auto 24px}",
    ".bar-track{height:5px;background:var(--border);border-radius:3px}.bar-fill{height:100%;border-radius:3px}",
    "::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--dim);border-radius:3px}",
  ].join("\n");

  var setupHTML = [
    '<div id="s-setup" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="width:100%;max-width:500px">',
    '    <div style="margin-bottom:28px">',
    '      <div style="display:flex;align-items:center;gap:10px;margin-bottom:16px">',
    '        <div style="width:36px;height:36px;background:var(--amber);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#06060E">&#9672;</div>',
    '        <span style="font-size:17px;font-weight:800">CreatorLens</span>',
    '        <span class="tag" style="background:#6366F122;color:var(--indigo);border:1px solid #6366F144">Beta</span>',
    '      </div>',
    '      <h1 style="font-size:32px;font-weight:800;line-height:1.1;letter-spacing:-.03em;margin-bottom:10px">Vet any creator.<br><span style="color:var(--amber)">Fully automated.</span></h1>',
    '      <p style="color:var(--muted);font-size:13px;line-height:1.75">Paste a public Instagram handle and your Apify key. Full scrape + AI analysis runs entirely on the server.</p>',
    '    </div>',
    '    <div class="card" style="padding:26px">',
    '      <div style="margin-bottom:16px">',
    '        <label class="lbl">Instagram Handle or URL</label>',
    '        <input id="i-url" placeholder="@handle or instagram.com/username" autocomplete="off"/>',
    '      </div>',
    '      <div>',
    '        <label class="lbl">Apify API Key</label>',
    '        <input id="i-apify" type="password" placeholder="apify_api_xxxxxxxxxxxxxxxx" class="mono"/>',
    '        <p style="font-size:11px;color:var(--muted);margin-top:5px">Free key: <span style="color:var(--amber)">console.apify.com</span> &#8594; Settings &#8594; Integrations &#8594; API tokens</p>',
    '      </div>',
    '      <div id="setup-err" style="display:none;background:#EF444415;border:1px solid #EF444440;border-radius:8px;padding:11px 14px;margin-top:14px">',
    '        <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:3px">&#9888; Error</div>',
    '        <div id="setup-err-msg" class="mono" style="font-size:12px;color:#FF8080;line-height:1.6;word-break:break-all"></div>',
    '      </div>',
    '      <button class="btn" onclick="startAnalysis()" style="margin-top:18px">Analyze Creator &#8594;</button>',
    '    </div>',
    '  </div>',
    '</div>',
  ].join("\n");

  var loadingHTML = [
    '<div id="s-loading" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="text-align:center;max-width:360px;width:100%">',
    '    <div class="spinner"></div>',
    '    <h2 style="font-size:20px;font-weight:800;margin-bottom:6px">Analyzing creator&#8230;</h2>',
    '    <p id="load-msg" class="mono" style="color:var(--muted);font-size:12px;margin-bottom:28px;animation:pulse 2s ease infinite;min-height:18px"></p>',
    '    <div id="steps" style="text-align:left;max-width:280px;margin:0 auto"></div>',
    '    <p style="color:var(--dim);font-size:11px;margin-top:24px">Apify scrape takes 30&#8211;90s &middot; please wait</p>',
    '  </div>',
    '</div>',
  ].join("\n");

  var errorHTML = [
    '<div id="s-error" class="scr" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">',
    '  <div style="max-width:500px;width:100%;text-align:center">',
    '    <div style="font-size:44px;margin-bottom:14px">&#9888;</div>',
    '    <h2 style="color:var(--red);font-size:22px;font-weight:800;margin-bottom:14px">Analysis Failed</h2>',
    '    <div class="card" style="border-color:#EF444444;margin-bottom:16px;text-align:left">',
    '      <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:6px;text-transform:uppercase">Error Detail</div>',
    '      <div id="err-msg" class="mono" style="font-size:12px;color:#FF9090;line-height:1.7;word-break:break-all"></div>',
    '    </div>',
    '    <div class="card" style="margin-bottom:20px;text-align:left">',
    '      <div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:10px;text-transform:uppercase">What each error means</div>',
    '      <div style="font-size:12px;color:var(--muted);line-height:1.9">',
    '        &middot; <b style="color:var(--text)">[start]</b> &#8212; Apify key wrong or account is private<br>',
    '        &middot; <b style="color:var(--text)">[status]</b> &#8212; Apify run failed, check console.apify.com<br>',
    '        &middot; <b style="color:var(--text)">[dataset]</b> &#8212; No posts found or account went private<br>',
    '        &middot; <b style="color:var(--text)">[analyze]</b> &#8212; GEMINI_API_KEY missing in Railway Variables<br>',
    '        &middot; <b style="color:var(--text)">No label</b> &#8212; Railway server sleeping, retry in 10s',
    '      </div>',
    '    </div>',
    "    <button class=\"btn\" onclick=\"showScreen('setup')\" style=\"width:auto;padding:12px 32px\">&#8592; Try Again</button>",
    '  </div>',
    '</div>',
  ].join("\n");

  var reportHTML = [
    '<div id="s-report" class="scr">',
    '  <div style="background:var(--card);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10">',
    '    <div style="display:flex;align-items:center;gap:8px">',
    '      <div style="width:26px;height:26px;background:var(--amber);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#06060E">&#9672;</div>',
    '      <span style="font-weight:800;font-size:14px">CreatorLens</span>',
    '      <span style="color:var(--dim)">&middot;</span>',
    '      <span id="nav-h" style="color:var(--muted);font-size:13px"></span>',
    '    </div>',
    "    <button class=\"btn-ghost\" onclick=\"showScreen('setup')\">&#8592; New analysis</button>",
    '  </div>',
    '  <div style="max-width:900px;margin:0 auto;padding:28px 20px 60px" id="report"></div>',
    '</div>',
  ].join("\n");

  var clientJS = getClientJS();

  return [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8"/>',
    '<meta name="viewport" content="width=device-width,initial-scale=1"/>',
    '<title>CreatorLens</title>',
    '<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>',
    '<style>' + css + '</style>',
    '</head>',
    '<body>',
    setupHTML,
    loadingHTML,
    errorHTML,
    reportHTML,
    '<script>' + clientJS + '</script>',
    '</body>',
    '</html>',
  ].join("\n");
}

function getClientJS() {
  // Written as a plain string — no nested template literals, no escaping issues.
  // Uses only ES5-compatible syntax inside so older browsers work too.
  var js = "";

  js += "var STEP_LABELS=['Starting Apify run','Scraping Instagram (30-90s)','Fetching scraped data','Calculating metrics','Running AI analysis','Building report'];\n";
  js += "var HOOK_COL={curiosity_gap:'#6366F1',contrarian:'#EF4444',mistake_based:'#F59E0B',number_led:'#10B981',identity_trigger:'#8B5CF6',pain_first:'#EC4899',bold_promise:'#14B8A6',social_proof:'#3B82F6',transformation:'#F97316',question:'#84CC16'};\n";
  js += "var SEV_COL={high:'#EF4444',medium:'#F59E0B',low:'#10B981'};\n";
  js += "var TCOLS=['#F59E0B','#6366F1','#10B981','#EC4899','#F97316'];\n";
  js += "function sleep(ms){return new Promise(function(r){setTimeout(r,ms);});}\n";

  js += "function showScreen(id){\n";
  js += "  ['setup','loading','error','report'].forEach(function(s){\n";
  js += "    document.getElementById('s-'+s).style.display='none';\n";
  js += "  });\n";
  js += "  var el=document.getElementById('s-'+id);\n";
  js += "  el.style.display=(id==='report')?'block':'flex';\n";
  js += "}\n";

  js += "function setStep(n,msg){\n";
  js += "  document.getElementById('load-msg').textContent=msg||'';\n";
  js += "  var h='';\n";
  js += "  for(var i=0;i<STEP_LABELS.length;i++){\n";
  js += "    var bg=i<n?'#10B981':i===n?'#F59E0B':'#1E1E30';\n";
  js += "    var fg=i<=n?'#06060E':'#565672';\n";
  js += "    var tc=i<=n?'var(--text)':'var(--muted)';\n";
  js += "    var lbl=i<n?'&#10003;':String(i+1);\n";
  js += "    h+='<div style=\"display:flex;align-items:center;gap:12px;margin-bottom:10px\">';\n";
  js += "    h+='<div style=\"width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;background:'+bg+';color:'+fg+'\">'+lbl+'</div>';\n";
  js += "    h+='<span style=\"font-size:13px;color:'+tc+'\">'+STEP_LABELS[i]+'</span></div>';\n";
  js += "  }\n";
  js += "  document.getElementById('steps').innerHTML=h;\n";
  js += "}\n";

  js += "function parseUser(s){\n";
  js += "  s=(s||'').trim();\n";
  js += "  try{var u=new URL(s.startsWith('http')?s:'https://'+s);return u.pathname.split('/').filter(Boolean)[0]||'';}\n";
  js += "  catch(e){return s.replace(/^@/,'').split(/[/?#]/)[0];}\n";
  js += "}\n";

  js += "function fmt(n){\n";
  js += "  if(n==null||isNaN(n))return '0';\n";
  js += "  if(n>=1e6)return (n/1e6).toFixed(1)+'M';\n";
  js += "  if(n>=1e3)return (n/1e3).toFixed(1)+'K';\n";
  js += "  return Math.round(n).toLocaleString();\n";
  js += "}\n";

  js += "function pType(t){\n";
  js += "  t=(t||'').toLowerCase();\n";
  js += "  if(t.includes('video')||t==='reel')return 'reel';\n";
  js += "  if(t.includes('sidecar')||t.includes('album')||t==='carousel')return 'carousel';\n";
  js += "  return 'static';\n";
  js += "}\n";

  js += "function gv(p){return p.videoViewCount||p.videoPlayCount||0;}\n";
  js += "function getER(p,F){return F?(((p.likesCount||0)+(p.commentsCount||0))/F)*100:0;}\n";
  js += "function getScore(p,F){\n";
  js += "  var e=(p.likesCount||0)+(p.commentsCount||0)*3,v=gv(p);\n";
  js += "  var a=(Date.now()-+new Date(p.timestamp))/36e5;\n";
  js += "  var r=a<720?1:a<2160?.8:.6;\n";
  js += "  return(F?(e/F)*100*r:0)+(F?(v/F)*20:0);\n";
  js += "}\n";
  js += "function mean(arr,fn){return arr.length?arr.reduce(function(s,x){return s+fn(x);},0)/arr.length:0;}\n";

  js += "function esc(s){\n";
  js += "  return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\"/g,'&quot;');\n";
  js += "}\n";

  js += "function tag(col,txt){return '<span class=\"tag\" style=\"background:'+col+'22;color:'+col+';border:1px solid '+col+'44\">'+txt+'</span>';}\n";

  js += "function sh(lbl,col){\n";
  js += "  col=col||'#F59E0B';\n";
  js += "  return '<div style=\"display:flex;align-items:center;gap:8px;margin-bottom:14px\">'\n";
  js += "    +'<div style=\"width:3px;height:16px;background:'+col+';border-radius:2px\"></div>'\n";
  js += "    +'<span style=\"font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)\">'+lbl+'</span></div>';\n";
  js += "}\n";

  js += "function stCard(l,v,sub,col){\n";
  js += "  col=col||'#F59E0B';\n";
  js += "  return '<div class=\"card\" style=\"flex:1;min-width:120px\">'\n";
  js += "    +'<div style=\"font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:5px\">'+l+'</div>'\n";
  js += "    +'<div class=\"mono\" style=\"font-size:20px;color:'+col+';font-weight:700;line-height:1.1\">'+v+'</div>'\n";
  js += "    +(sub?'<div style=\"font-size:11px;color:var(--muted);margin-top:3px\">'+sub+'</div>':'')\n";
  js += "    +'</div>';\n";
  js += "}\n";

  js += "function fBar(lbl,pct,col,right){\n";
  js += "  return '<div style=\"margin-bottom:14px\">'\n";
  js += "    +'<div style=\"display:flex;justify-content:space-between;margin-bottom:5px\"><span style=\"font-size:13px\">'+lbl+'</span><span class=\"mono\" style=\"font-size:12px;color:var(--muted)\">'+right+'</span></div>'\n";
  js += "    +'<div class=\"bar-track\"><div class=\"bar-fill\" style=\"width:'+Math.min(pct,100)+'%;background:'+col+'\"></div></div>'\n";
  js += "    +'<div style=\"font-size:10px;color:var(--muted);margin-top:2px\">'+pct+'% of content</div></div>';\n";
  js += "}\n";

  js += "function buildMetrics(raw){\n";
  js += "  var p=raw[0];\n";
  js += "  var rawP=(p.latestPosts||p.topPosts||p.posts||[]).filter(function(x){return x&&x.timestamp;});\n";
  js += "  var F=p.followersCount||1;\n";
  js += "  var N=rawP.length||1;\n";
  js += "  var scored=rawP.map(function(x){\n";
  js += "    return Object.assign({},x,{\n";
  js += "      _v:gv(x),_sc:getScore(x,F),_er:getER(x,F),_type:pType(x.type),\n";
  js += "      _hook:((x.caption||'').split('\\n')[0]||'').trim().slice(0,200),\n";
  js += "      _url:x.url||(x.shortCode?'https://instagram.com/p/'+x.shortCode:'#'),\n";
  js += "    });\n";
  js += "  }).sort(function(a,b){return b._sc-a._sc;});\n";
  js += "  var rl=scored.filter(function(x){return x._type==='reel';});\n";
  js += "  var ca=scored.filter(function(x){return x._type==='carousel';});\n";
  js += "  var st=scored.filter(function(x){return x._type==='static';});\n";
  js += "  var avgV=mean(rl,function(x){return x._v;});\n";
  js += "  var avgER=mean(scored,function(x){return x._er;});\n";
  js += "  var ts=rawP.map(function(x){return +new Date(x.timestamp);}).filter(Boolean).sort(function(a,b){return b-a;});\n";
  js += "  var span=ts.length>=2?(ts[0]-ts[ts.length-1])/864e5:7;\n";
  js += "  return{\n";
  js += "    handle:p.username||'unknown',name:p.fullName||p.username||'',bio:p.biography||'',\n";
  js += "    pic:p.profilePicUrl||'',verified:!!p.isVerified,followers:F,\n";
  js += "    avgER:avgER.toFixed(2),avgViews:Math.round(avgV),vfr:((avgV/F)*100).toFixed(1),\n";
  js += "    cadence:((N/Math.max(span,1))*7).toFixed(1)+'/wk',total:N,\n";
  js += "    top5:scored.slice(0,5),\n";
  js += "    hooks:scored.map(function(x){return x._hook;}).filter(Boolean).slice(0,20),\n";
  js += "    fmt:{\n";
  js += "      reel:{pct:Math.round(rl.length/N*100),avgViews:Math.round(avgV),avgER:mean(rl,function(x){return x._er;}).toFixed(2)},\n";
  js += "      carousel:{pct:Math.round(ca.length/N*100),avgER:mean(ca,function(x){return x._er;}).toFixed(2)},\n";
  js += "      static:{pct:Math.round(st.length/N*100),avgER:mean(st,function(x){return x._er;}).toFixed(2)},\n";
  js += "    },\n";
  js += "  };\n";
  js += "}\n";

  js += "function buildPrompt(m){\n";
  js += "  var lines=[\n";
  js += "    'You are a brand-side social media analyst vetting Instagram creators for a men\\'s health brand (Man Matters - hair loss, testosterone, fitness).',\n";
  js += "    '',\n";
  js += "    'CREATOR: @'+m.handle+' ('+m.name+')'+(m.verified?' verified':''),\n";
  js += "    'BIO: '+(m.bio||'N/A'),\n";
  js += "    'FOLLOWERS: '+m.followers.toLocaleString()+' | AVG ER: '+m.avgER+'% | AVG REEL VIEWS: '+fmt(m.avgViews)+' | VFR: '+m.vfr+'% | CADENCE: '+m.cadence,\n";
  js += "    'FORMAT: '+m.fmt.reel.pct+'% Reels / '+m.fmt.carousel.pct+'% Carousels / '+m.fmt.static.pct+'% Static | POSTS: '+m.total,\n";
  js += "    '','TOP 5 POSTS:',\n";
  js += "  ];\n";
  js += "  m.top5.forEach(function(p,i){\n";
  js += "    lines.push((i+1)+'. ['+p._type.toUpperCase()+'] ER:'+p._er.toFixed(2)+'% Views:'+fmt(p._v)+' Likes:'+fmt(p.likesCount)+' Hook: \"'+p._hook+'\"');\n";
  js += "  });\n";
  js += "  lines.push('','ALL CAPTION HOOKS:');\n";
  js += "  m.hooks.forEach(function(h,i){lines.push((i+1)+'. \"'+h+'\"');});\n";
  js += "  lines.push('');\n";
  js += "  lines.push('Return ONLY raw JSON (no markdown, no backticks, no extra text) matching this shape:');\n";
  js += "  lines.push('{\"hookAnalysis\":[{\"rank\":1,\"hook\":\"text\",\"type\":\"mistake_based\",\"label\":\"Mistake-Based\",\"strength\":8,\"why\":\"one sentence\"}],\"patterns\":[{\"name\":\"n\",\"freq\":4,\"pct\":40,\"signature\":\"one sentence\",\"examples\":[\"a\",\"b\"]}],\"themes\":[{\"name\":\"n\",\"pct\":35,\"desc\":\"one sentence\",\"keywords\":[\"a\",\"b\"]}],\"frameworks\":[{\"name\":\"n\",\"usage\":\"~40%\",\"structure\":\"1) step 2) step 3) step\",\"example\":\"example\"}],\"generatedHooks\":[{\"hook\":\"text\",\"type\":\"mistake_based\",\"angle\":\"Hair loss\",\"note\":\"one sentence\"}],\"flags\":[{\"flag\":\"n\",\"severity\":\"high\",\"implication\":\"one sentence\"}],\"verdict\":{\"score\":7.5,\"strengths\":[\"a\"],\"concerns\":[\"a\"],\"bestUse\":\"sentence\",\"formats\":[\"Reel\"]}}');\n";
  js += "  lines.push('Counts: hookAnalysis=5, patterns=3-4, themes=3-5, frameworks=2-3, generatedHooks=10, flags=2-5.');\n";
  js += "  lines.push('Types: curiosity_gap|contrarian|mistake_based|number_led|identity_trigger|pain_first|bold_promise|social_proof|transformation|question');\n";
  js += "  return lines.join('\\n');\n";
  js += "}\n";

  js += "async function startAnalysis(){\n";
  js += "  var url=document.getElementById('i-url').value.trim();\n";
  js += "  var apifyKey=document.getElementById('i-apify').value.trim();\n";
  js += "  var errEl=document.getElementById('setup-err');\n";
  js += "  var errMsg=document.getElementById('setup-err-msg');\n";
  js += "  errEl.style.display='none';\n";
  js += "  var username=parseUser(url);\n";
  js += "  if(!username){errMsg.textContent='Enter a valid Instagram URL or @handle.';errEl.style.display='block';return;}\n";
  js += "  if(!apifyKey){errMsg.textContent='Apify API key is required.';errEl.style.display='block';return;}\n";
  js += "  showScreen('loading');\n";
  js += "  setStep(0,'Starting Apify run...');\n";
  js += "  try{\n";
  js += "    var sr=await fetch('/start',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({username:username,apifyKey:apifyKey})});\n";
  js += "    var sb=await sr.json();\n";
  js += "    if(!sr.ok)throw new Error(sb.error||'Start failed ('+sr.status+')');\n";
  js += "    var runId=sb.runId,datasetId=sb.datasetId;\n";
  js += "    setStep(1,'Scraping Instagram...');\n";
  js += "    var status='RUNNING',elapsed=0;\n";
  js += "    while(['STARTING','READY','RUNNING','ABORTING'].indexOf(status)!==-1){\n";
  js += "      await sleep(5000);\n";
  js += "      elapsed+=5;\n";
  js += "      setStep(1,'Scraping... ('+elapsed+'s elapsed)');\n";
  js += "      var pr=await fetch('/status/'+runId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "      var pb=await pr.json();\n";
  js += "      status=pb.status||'UNKNOWN';\n";
  js += "      if(['FAILED','ABORTED','TIMED-OUT'].indexOf(status)!==-1)throw new Error('[status] Apify run ended with status: '+status+'. Check console.apify.com.');\n";
  js += "      if(elapsed>180)throw new Error('[status] Scrape timed out after 3 minutes.');\n";
  js += "    }\n";
  js += "    setStep(2,'Fetching scraped data...');\n";
  js += "    var dr=await fetch('/dataset/'+datasetId+'?apifyKey='+encodeURIComponent(apifyKey));\n";
  js += "    var db=await dr.json();\n";
  js += "    if(!dr.ok)throw new Error(db.error||'Dataset fetch failed ('+dr.status+')');\n";
  js += "    if(!Array.isArray(db.data)||!db.data.length)throw new Error('[dataset] No posts returned. Account may be private.');\n";
  js += "    setStep(3,'Calculating engagement metrics...');\n";
  js += "    var d=buildMetrics(db.data);\n";
  js += "    await sleep(200);\n";
  js += "    setStep(4,'Running AI analysis...');\n";
  js += "    var ar=await fetch('/analyze',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({prompt:buildPrompt(d)})});\n";
  js += "    var ab=await ar.json();\n";
  js += "    if(!ar.ok)throw new Error(ab.error||'AI analysis failed ('+ar.status+')');\n";
  js += "    var ai=ab.result;\n";
  js += "    setStep(5,'Building report...');\n";
  js += "    await sleep(200);\n";
  js += "    renderReport(d,ai);\n";
  js += "    showScreen('report');\n";
  js += "  }catch(e){\n";
  js += "    document.getElementById('err-msg').textContent=e.message||String(e);\n";
  js += "    showScreen('error');\n";
  js += "  }\n";
  js += "}\n";

  js += "function renderReport(d,ai){\n";
  js += "  document.getElementById('nav-h').textContent='@'+d.handle;\n";
  js += "  var sc=(ai&&ai.verdict&&ai.verdict.score)?ai.verdict.score:0;\n";
  js += "  var fc=sc>=7?'#10B981':sc>=5?'#F59E0B':'#EF4444';\n";
  js += "  var h='';\n";

  js += "  h+='<div style=\"display:flex;gap:16px;align-items:center;margin-bottom:28px;flex-wrap:wrap\">';\n";
  js += "  if(d.pic)h+='<img src=\"'+d.pic+'\" onerror=\"this.style.display=\\'none\\'\" style=\"width:60px;height:60px;border-radius:50%;border:2px solid var(--amber);object-fit:cover;flex-shrink:0\"/>';\n";
  js += "  h+='<div style=\"flex:1;min-width:0\"><h1 style=\"font-size:22px;font-weight:800;margin-bottom:3px\">'+esc(d.name||'@'+d.handle)+'</h1>';\n";
  js += "  h+='<div style=\"font-size:12px;color:var(--muted);line-height:1.6\">'+esc((d.bio||'').slice(0,120))+((d.bio||'').length>120?'&hellip;':'')+'</div></div>';\n";
  js += "  if(ai&&ai.verdict){h+='<div class=\"card\" style=\"text-align:center;padding:12px 20px;flex-shrink:0;border-color:'+fc+'55\"><div style=\"font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px\">Brand Fit</div><div class=\"mono\" style=\"font-size:30px;font-weight:700;line-height:1;color:'+fc+'\">'+sc+'<span style=\"font-size:13px;color:var(--muted)\">/10</span></div></div>';}\n";
  js += "  h+='</div>';\n";

  js += "  h+='<div style=\"margin-bottom:28px\">'+sh('Creator Overview')+'<div style=\"display:flex;flex-wrap:wrap;gap:10px\">';\n";
  js += "  h+=stCard('Followers',fmt(d.followers));\n";
  js += "  h+=stCard('Avg ER',d.avgER+'%',d.avgER>=3?'Strong':d.avgER>=1.5?'Average':'Weak',d.avgER>=3?'#10B981':d.avgER>=1.5?'#F59E0B':'#EF4444');\n";
  js += "  h+=stCard('Avg Reel Views',fmt(d.avgViews));\n";
  js += "  h+=stCard('Views/Follower',d.vfr+'%',d.vfr>=30?'Excellent':d.vfr>=10?'Good':'Weak',d.vfr>=30?'#10B981':d.vfr>=10?'#F59E0B':'#EF4444');\n";
  js += "  h+=stCard('Cadence',d.cadence,d.total+' posts');\n";
  js += "  h+='</div></div>';\n";

  js += "  h+='<div style=\"margin-bottom:28px\">'+sh('Format Performance','#6366F1')+'<div class=\"card\">';\n";
  js += "  h+=fBar('Reels',d.fmt.reel.pct,'#F59E0B',fmt(d.fmt.reel.avgViews)+' avg views &middot; '+d.fmt.reel.avgER+'% ER');\n";
  js += "  h+=fBar('Carousels',d.fmt.carousel.pct,'#6366F1',d.fmt.carousel.avgER+'% avg ER');\n";
  js += "  h+=fBar('Static',d.fmt.static.pct,'#565672',d.fmt.static.avgER+'% avg ER');\n";
  js += "  h+='</div></div>';\n";

  js += "  h+='<div style=\"margin-bottom:28px\">'+sh('Top 5 Posts by Performance','#F59E0B');\n";
  js += "  d.top5.forEach(function(p,i){\n";
  js += "    var hi=ai&&ai.hookAnalysis?ai.hookAnalysis.find(function(x){return x.rank===i+1;}):null;\n";
  js += "    var tc=p._type==='reel'?'#F59E0B':p._type==='carousel'?'#6366F1':'#565672';\n";
  js += "    h+='<div class=\"card\" style=\"display:flex;gap:14px;margin-bottom:10px\">';\n";
  js += "    h+='<div style=\"flex-shrink:0;padding-top:2px;font-size:'+(i===0?'22':'16')+'px;font-weight:700;color:'+(i===0?'#F59E0B':'var(--muted)')+'\">'+String(i+1)+'</div>';\n";
  js += "    h+='<div style=\"flex:1;min-width:0\"><div style=\"display:flex;flex-wrap:wrap;gap:6px;margin-bottom:8px\">';\n";
  js += "    h+=tag(tc,p._type);\n";
  js += "    if(hi){h+=tag(HOOK_COL[hi.type]||'#F59E0B',hi.label);h+=tag('#14B8A6',hi.strength+'/10 hook');}\n";
  js += "    h+=tag('#10B981',p._er.toFixed(2)+'% ER');\n";
  js += "    if(p._v>0)h+=tag('#EC4899',fmt(p._v)+' views');\n";
  js += "    h+='</div><p style=\"margin:0 0 6px;font-size:14px;line-height:1.6\"><b style=\"color:#F59E0B\">Hook: </b>'+esc(p._hook||'(no caption)')+'</p>';\n";
  js += "    if(hi&&hi.why)h+='<p style=\"margin:0 0 8px;font-size:12px;color:var(--muted);font-style:italic;line-height:1.5\">'+esc(hi.why)+'</p>';\n";
  js += "    h+='<div style=\"display:flex;gap:10px\"><span style=\"font-size:12px;color:var(--muted)\">&#9829; '+fmt(p.likesCount)+'</span><span style=\"font-size:12px;color:var(--muted)\">&#128172; '+fmt(p.commentsCount)+'</span>';\n";
  js += "    if(p._url&&p._url!=='#')h+='<a href=\"'+p._url+'\" target=\"_blank\" style=\"font-size:12px;color:#6366F1;text-decoration:none\">View &#8599;</a>';\n";
  js += "    h+='</div></div></div>';\n";
  js += "  });\n";
  js += "  h+='</div>';\n";

  js += "  if(ai&&ai.patterns&&ai.patterns.length){\n";
  js += "    h+='<div style=\"margin-bottom:28px\">'+sh('Hook Pattern Clusters','#6366F1')+'<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(240px,1fr))\">';\n";
  js += "    ai.patterns.forEach(function(p){\n";
  js += "      h+='<div class=\"card\"><div style=\"display:flex;justify-content:space-between;margin-bottom:8px\"><b style=\"font-size:14px\">'+esc(p.name)+'</b><span class=\"mono\" style=\"font-size:22px;color:#F59E0B;font-weight:700\">'+p.pct+'%</span></div>';\n";
  js += "      h+='<div class=\"bar-track\" style=\"margin-bottom:10px\"><div class=\"bar-fill\" style=\"width:'+Math.min(p.pct,100)+'%;background:#F59E0B\"></div></div>';\n";
  js += "      h+='<p style=\"font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px\">'+esc(p.signature)+'</p>';\n";
  js += "      (p.examples||[]).slice(0,2).forEach(function(e){h+='<div style=\"font-size:11px;color:var(--muted);font-style:italic;margin-bottom:4px;padding-left:8px;border-left:2px solid var(--border)\">&quot;'+esc(e)+'&quot;</div>';});\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  js += "  if(ai&&ai.themes&&ai.themes.length){\n";
  js += "    h+='<div style=\"margin-bottom:28px\">'+sh('Content Themes','#10B981')+'<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(210px,1fr))\">';\n";
  js += "    ai.themes.forEach(function(t,i){\n";
  js += "      var c=TCOLS[i%TCOLS.length];\n";
  js += "      h+='<div class=\"card\" style=\"border-top:2px solid '+c+'\"><div style=\"display:flex;justify-content:space-between;margin-bottom:6px\"><b style=\"font-size:14px\">'+esc(t.name)+'</b><span class=\"mono\" style=\"color:'+c+';font-size:13px\">'+t.pct+'%</span></div>';\n";
  js += "      h+='<p style=\"font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px\">'+esc(t.desc)+'</p><div style=\"display:flex;flex-wrap:wrap;gap:6px\">';\n";
  js += "      (t.keywords||[]).forEach(function(k){h+='<span style=\"background:'+c+'22;color:'+c+';border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700\">'+esc(k)+'</span>';});\n";
  js += "      h+='</div></div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  js += "  if(ai&&ai.frameworks&&ai.frameworks.length){\n";
  js += "    h+='<div style=\"margin-bottom:28px\">'+sh('Repeatable Frameworks','#EC4899');\n";
  js += "    ai.frameworks.forEach(function(fw){\n";
  js += "      var steps=(fw.structure||'').split(/[0-9]\\)/).filter(function(s){return s.trim();});\n";
  js += "      h+='<div class=\"card\" style=\"margin-bottom:10px\"><div style=\"display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap\"><b style=\"font-size:15px\">'+esc(fw.name)+'</b>'+tag('#EC4899',fw.usage)+'</div>';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:10px\">';\n";
  js += "      steps.forEach(function(s,j){h+='<div style=\"background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--muted)\"><span style=\"color:#EC4899;font-weight:700\">'+(j+1)+'</span> '+esc(s.trim())+'</div>';});\n";
  js += "      h+='</div>';\n";
  js += "      if(fw.example)h+='<div style=\"font-size:12px;color:var(--muted);font-style:italic;border-left:2px solid #EC4899;padding-left:10px\">&quot;'+esc(fw.example)+'&quot;</div>';\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div>';\n";
  js += "  }\n";

  js += "  if(ai&&ai.generatedHooks&&ai.generatedHooks.length){\n";
  js += "    h+='<div style=\"margin-bottom:28px\">'+sh('10 Generated Hook Ideas','#F59E0B')+'<div class=\"grid\" style=\"grid-template-columns:repeat(auto-fill,minmax(320px,1fr))\">';\n";
  js += "    ai.generatedHooks.forEach(function(hk,i){\n";
  js += "      var c=HOOK_COL[hk.type]||'#F59E0B';\n";
  js += "      h+='<div class=\"card\" style=\"border-left:3px solid '+c+'\"><div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:8px;align-items:center\">';\n";
  js += "      h+='<span class=\"mono\" style=\"color:var(--muted);font-size:10px;font-weight:700\">#'+(i<9?'0':'')+(i+1)+'</span>';\n";
  js += "      h+=tag(c,(hk.type||'').replace(/_/g,' '));\n";
  js += "      if(hk.angle)h+='<span style=\"font-size:11px;color:var(--muted)\">'+esc(hk.angle)+'</span>';\n";
  js += "      h+='</div><p style=\"margin:0 0 8px;font-weight:700;font-size:14px;line-height:1.6\">&quot;'+esc(hk.hook)+'&quot;</p>';\n";
  js += "      if(hk.note)h+='<p style=\"margin:0;font-size:11px;color:var(--muted);font-style:italic\">'+esc(hk.note)+'</p>';\n";
  js += "      h+='</div>';\n";
  js += "    });\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  js += "  if((ai&&ai.flags&&ai.flags.length)||(ai&&ai.verdict)){\n";
  js += "    h+='<div style=\"margin-bottom:28px\">'+sh('Brand Fit Assessment','#EF4444')+'<div style=\"display:grid;grid-template-columns:1fr 1fr;gap:12px\"><div>';\n";
  js += "    h+='<div style=\"font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px\">Vetting Flags</div>';\n";
  js += "    (ai.flags||[]).forEach(function(f){\n";
  js += "      var c=SEV_COL[f.severity]||'#565672';\n";
  js += "      h+='<div class=\"card\" style=\"margin-bottom:8px;border-left:3px solid '+c+'\"><div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-bottom:5px;align-items:center\">'+tag(c,f.severity)+'<b style=\"font-size:13px\">'+esc(f.flag)+'</b></div>';\n";
  js += "      h+='<p style=\"margin:0;font-size:12px;color:var(--muted);line-height:1.5\">'+esc(f.implication)+'</p></div>';\n";
  js += "    });\n";
  js += "    h+='</div>';\n";
  js += "    if(ai.verdict){\n";
  js += "      h+='<div><div style=\"font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px\">Verdict</div><div class=\"card\">';\n";
  js += "      h+='<div style=\"font-size:11px;color:#10B981;font-weight:700;margin-bottom:5px\">&#10003; Strengths</div>';\n";
  js += "      (ai.verdict.strengths||[]).forEach(function(s){h+='<div style=\"font-size:12px;color:var(--muted);margin-bottom:3px\">&middot; '+esc(s)+'</div>';});\n";
  js += "      h+='<div style=\"font-size:11px;color:#EF4444;font-weight:700;margin:12px 0 5px\">&#10007; Concerns</div>';\n";
  js += "      (ai.verdict.concerns||[]).forEach(function(c){h+='<div style=\"font-size:12px;color:var(--muted);margin-bottom:3px\">&middot; '+esc(c)+'</div>';});\n";
  js += "      h+='<div style=\"margin:14px 0 0;padding:11px 13px;background:var(--bg);border-radius:8px\"><div style=\"font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase\">Best Use Case</div><div style=\"font-size:13px;color:#F59E0B;line-height:1.6\">'+esc(ai.verdict.bestUse||'')+'</div></div>';\n";
  js += "      h+='<div style=\"display:flex;flex-wrap:wrap;gap:8px;margin-top:10px\">';\n";
  js += "      (ai.verdict.formats||[]).forEach(function(f){h+=tag('#6366F1',f);});\n";
  js += "      h+='</div></div></div>';\n";
  js += "    }\n";
  js += "    h+='</div></div>';\n";
  js += "  }\n";

  js += "  h+='<div style=\"border-top:1px solid var(--border);padding-top:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px\">';\n";
  js += "  h+='<span style=\"font-size:11px;color:var(--muted)\">CreatorLens &middot; Apify + Claude &middot; '+d.total+' posts analyzed</span>';\n";
  js += "  h+='<button class=\"btn-sm\" onclick=\"showScreen(\\'setup\\')\">Analyze Another &#8594;</button></div>';\n";
  js += "  document.getElementById('report').innerHTML=h;\n";
  js += "}\n";

  js += "showScreen('setup');\n";

  return js;
}
