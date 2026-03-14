/**
 * CreatorLens — all-in-one server
 * GET  /        → serves the full CreatorLens web app
 * GET  /health  → {"ok":true}
 * POST /scrape  → calls Apify, polls, returns data
 *
 * Deploy to Railway, then open your Railway URL in any browser.
 * No CORS issues, no local file problems — everything same-origin.
 */

const express = require("express");
const app     = express();
app.use(express.json());

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID   = "apify~instagram-profile-scraper";
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// ─── Health ───────────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── Scrape endpoint ──────────────────────────────────────────────────────────
app.post("/scrape", async (req, res) => {
  const { username, apifyKey } = req.body || {};
  if (!username || !apifyKey)
    return res.status(400).json({ error: "username and apifyKey are required." });

  try {
    // 1. Start run
    const startRes  = await fetch(`${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${apifyKey}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ usernames: [username], resultsLimit: 30 }),
    });
    const startBody = await startRes.json();
    if (!startRes.ok) {
      const msg = startBody?.error?.message || startBody?.message || JSON.stringify(startBody).slice(0,200);
      return res.status(startRes.status).json({ error: `Apify error: ${msg}` });
    }
    const runId     = startBody?.data?.id;
    const datasetId = startBody?.data?.defaultDatasetId;
    if (!runId) return res.status(500).json({ error: "Apify did not return a run ID.", raw: startBody });

    // 2. Poll
    let status = "RUNNING", attempts = 0;
    while (["RUNNING","READY","ABORTING"].includes(status) && attempts < 36) {
      await sleep(5000); attempts++;
      const pb = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${apifyKey}`).then(r=>r.json());
      status = pb?.data?.status || "UNKNOWN";
      if (["FAILED","ABORTED","TIMED-OUT"].includes(status))
        return res.status(500).json({ error: `Apify run ${status}.`, runUrl: `https://console.apify.com/actors/runs/${runId}` });
    }
    if (status !== "SUCCEEDED")
      return res.status(500).json({ error: `Apify run did not complete. Last status: ${status}` });

    // 3. Fetch dataset
    const itemsRes = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${apifyKey}&format=json`);
    const items    = await itemsRes.json();
    if (!itemsRes.ok) return res.status(itemsRes.status).json({ error: "Failed to fetch dataset.", raw: items });
    if (!Array.isArray(items) || !items.length)
      return res.status(404).json({ error: "No data returned. Account may be private or username is wrong." });

    return res.json({ ok: true, data: items });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Unexpected server error." });
  }
});

// ─── Serve the full CreatorLens UI ────────────────────────────────────────────
app.get("/", (_req, res) => {
  res.setHeader("Content-Type", "text/html");
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>CreatorLens</title>
<link rel="preconnect" href="https://fonts.googleapis.com"/>
<link href="https://fonts.googleapis.com/css2?family=Syne:wght@600;700;800&family=Space+Mono:wght@400;700&display=swap" rel="stylesheet"/>
<style>
  *{box-sizing:border-box;margin:0;padding:0}
  :root{
    --bg:#06060E;--card:#0C0C18;--border:#181830;
    --amber:#F59E0B;--indigo:#6366F1;--green:#10B981;
    --red:#EF4444;--pink:#EC4899;--teal:#14B8A6;--orange:#F97316;
    --text:#EEEEFA;--muted:#565672;--dim:#1E1E30;
  }
  body{background:var(--bg);color:var(--text);font-family:'Syne',system-ui,sans-serif;min-height:100vh}
  .mono{font-family:'Space Mono',monospace}
  input{background:#09091A;border:1px solid var(--dim);border-radius:8px;padding:11px 13px;color:var(--text);font-size:14px;outline:none;width:100%;transition:border-color .2s;font-family:'Syne',system-ui,sans-serif}
  input:focus{border-color:var(--amber)}
  button{cursor:pointer;font-family:'Syne',system-ui,sans-serif;font-weight:800;border:none;border-radius:8px}
  .btn{background:var(--amber);color:#06060E;padding:13px 24px;font-size:14px;width:100%}
  .btn-ghost{background:transparent;border:1px solid var(--dim);color:var(--muted);padding:7px 16px;font-size:12px;font-weight:600}
  .card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:18px}
  .tag{display:inline-flex;align-items:center;border-radius:5px;padding:2px 8px;font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.05em;font-family:'Space Mono',monospace;white-space:nowrap}
  .lbl{font-size:11px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;display:block;margin-bottom:7px}
  .screen{display:none}
  @keyframes spin{to{transform:rotate(360deg)}}
  @keyframes pulse{0%,100%{opacity:.9}50%{opacity:.4}}
  .spinner{width:48px;height:48px;border-radius:50%;border:3px solid var(--border);border-top:3px solid var(--amber);animation:spin .9s linear infinite;margin:0 auto 24px}
  .bar-track{height:5px;background:var(--border);border-radius:3px}
  .bar-fill{height:100%;border-radius:3px;transition:width .8s ease}
  .flex{display:flex}.wrap{flex-wrap:wrap}.g10{gap:10px}.g12{gap:12px}
  .grid{display:grid;gap:10px}
  ::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:var(--bg)}::-webkit-scrollbar-thumb{background:var(--dim);border-radius:3px}
</style>
</head>
<body>

<!-- SETUP -->
<div id="s-setup" class="screen" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="width:100%;max-width:520px">
    <div style="margin-bottom:28px">
      <div class="flex" style="align-items:center;gap:10px;margin-bottom:16px">
        <div style="width:36px;height:36px;background:var(--amber);border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:18px;font-weight:800;color:#06060E">◈</div>
        <span style="font-size:17px;font-weight:800">CreatorLens</span>
        <span class="tag" style="background:#6366F122;color:var(--indigo);border:1px solid #6366F144">Beta</span>
      </div>
      <h1 style="font-size:32px;font-weight:800;line-height:1.1;letter-spacing:-.03em;margin-bottom:10px">
        Vet any creator.<br><span style="color:var(--amber)">Fully automated.</span>
      </h1>
      <p style="color:var(--muted);font-size:13px;line-height:1.75">
        Enter an Instagram handle and your Apify key. The tool scrapes, calculates metrics, and runs full AI analysis automatically.
      </p>
    </div>
    <div class="card" style="padding:26px">
      <div style="margin-bottom:16px">
        <label class="lbl">Instagram Handle or URL</label>
        <input id="i-url" placeholder="@handle  or  instagram.com/username" autocomplete="off"/>
      </div>
      <div style="margin-bottom:4px">
        <label class="lbl">Apify API Key</label>
        <input id="i-apify" type="password" placeholder="apify_api_xxxxxxxxxxxxxxxx" class="mono"/>
        <p style="font-size:11px;color:var(--muted);margin-top:5px">Get free key → <span style="color:var(--amber)">console.apify.com</span> → Settings → Integrations → API tokens</p>
      </div>
      <div id="setup-err" style="display:none;background:#EF444415;border:1px solid #EF444440;border-radius:8px;padding:11px 14px;margin-top:14px">
        <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:3px">⚠ Error</div>
        <div id="setup-err-msg" class="mono" style="font-size:12px;color:#FF8080;line-height:1.6;word-break:break-all"></div>
      </div>
      <button class="btn" onclick="startAnalysis()" style="margin-top:18px">Analyze Creator →</button>
    </div>
  </div>
</div>

<!-- LOADING -->
<div id="s-loading" class="screen" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="text-align:center;max-width:360px;width:100%">
    <div class="spinner"></div>
    <h2 style="font-size:20px;font-weight:800;margin-bottom:6px">Analyzing creator…</h2>
    <p id="load-msg" class="mono" style="color:var(--muted);font-size:12px;margin-bottom:28px;animation:pulse 2s ease infinite;min-height:18px"></p>
    <div id="steps" style="text-align:left;max-width:280px;margin:0 auto"></div>
    <p style="color:var(--dim);font-size:11px;margin-top:24px">Apify scrape takes 30–90s · please wait</p>
  </div>
</div>

<!-- ERROR -->
<div id="s-error" class="screen" style="min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px">
  <div style="max-width:500px;width:100%;text-align:center">
    <div style="font-size:44px;margin-bottom:14px">⚠</div>
    <h2 style="color:var(--red);font-size:22px;font-weight:800;margin-bottom:14px">Analysis Failed</h2>
    <div class="card" style="border-color:#EF444444;margin-bottom:20px;text-align:left">
      <div style="font-size:11px;color:var(--red);font-weight:700;margin-bottom:6px;text-transform:uppercase">Error Detail</div>
      <div id="err-msg" class="mono" style="font-size:12px;color:#FF9090;line-height:1.7;word-break:break-all"></div>
    </div>
    <div class="card" style="margin-bottom:20px;text-align:left">
      <div style="font-size:11px;color:var(--muted);font-weight:700;margin-bottom:10px;text-transform:uppercase">Common fixes</div>
      <div style="font-size:12px;color:var(--muted);line-height:1.9">
        · <b style="color:var(--text)">Apify key expired</b> — regenerate at console.apify.com → Settings → Integrations<br>
        · <b style="color:var(--text)">Account is private</b> — only public Instagram profiles work<br>
        · <b style="color:var(--text)">Apify credits exhausted</b> — check usage dashboard<br>
        · <b style="color:var(--text)">Username typo</b> — double-check the handle on Instagram
      </div>
    </div>
    <button class="btn" onclick="show('setup')" style="max-width:200px">← Try Again</button>
  </div>
</div>

<!-- REPORT -->
<div id="s-report" class="screen">
  <div style="background:var(--card);border-bottom:1px solid var(--border);padding:12px 24px;display:flex;justify-content:space-between;align-items:center;position:sticky;top:0;z-index:10">
    <div class="flex" style="align-items:center;gap:8px">
      <div style="width:26px;height:26px;background:var(--amber);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:11px;font-weight:800;color:#06060E">◈</div>
      <span style="font-weight:800;font-size:14px">CreatorLens</span>
      <span style="color:var(--dim)">·</span>
      <span id="nav-h" style="color:var(--muted);font-size:13px"></span>
    </div>
    <button class="btn-ghost" onclick="show('setup')">← New analysis</button>
  </div>
  <div style="max-width:900px;margin:0 auto;padding:28px 20px 60px" id="report"></div>
</div>

<script>
const CLAUDE_URL = "https://api.anthropic.com/v1/messages";
const MODEL = "claude-sonnet-4-20250514";
const STEP_LABELS = ["Calling Apify scraper","Scraping Instagram profile","Waiting for scrape to finish","Calculating metrics","Running AI analysis","Building report"];
const HOOK_COL={curiosity_gap:"#6366F1",contrarian:"#EF4444",mistake_based:"#F59E0B",number_led:"#10B981",identity_trigger:"#8B5CF6",pain_first:"#EC4899",bold_promise:"#14B8A6",social_proof:"#3B82F6",transformation:"#F97316",question:"#84CC16"};
const SEV_COL={high:"#EF4444",medium:"#F59E0B",low:"#10B981"};
const TCOLS=["#F59E0B","#6366F1","#10B981","#EC4899","#F97316"];
const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function show(id){
  ["setup","loading","error","report"].forEach(s=>{
    const el=document.getElementById("s-"+s);
    el.style.display="none";
  });
  document.getElementById("s-"+id).style.display="flex";
  if(id==="report") document.getElementById("s-report").style.display="block";
}

function setStep(n,msg){
  document.getElementById("load-msg").textContent=msg||"";
  document.getElementById("steps").innerHTML=STEP_LABELS.map((s,i)=>
    \`<div style="display:flex;align-items:center;gap:12px;margin-bottom:10px">
      <div style="width:22px;height:22px;border-radius:50%;flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:10px;font-weight:700;
        background:\${i<n?"#10B981":i===n?"#F59E0B":"#1E1E30"};color:\${i<=n?"#06060E":"#565672"}">
        \${i<n?"✓":i+1}
      </div>
      <span style="font-size:13px;color:\${i<=n?"var(--text)":"var(--muted)"}">\${s}</span>
    </div>\`).join("");
}

function parseUser(s){
  s=(s||"").trim();
  try{const u=new URL(s.startsWith("http")?s:"https://"+s);return u.pathname.split("/").filter(Boolean)[0]||"";}
  catch{return s.replace(/^@/,"").split(/[/?#]/)[0];}
}
function fmt(n){
  if(n==null||isNaN(n))return"0";
  if(n>=1e6)return(n/1e6).toFixed(1)+"M";
  if(n>=1e3)return(n/1e3).toFixed(1)+"K";
  return Math.round(n).toLocaleString();
}
function pType(t=""){
  t=t.toLowerCase();
  if(t.includes("video")||t==="reel")return"reel";
  if(t.includes("sidecar")||t.includes("album")||t==="carousel")return"carousel";
  return"static";
}
function gv(p){return p.videoViewCount||p.videoPlayCount||p.playCount||0;}
function er(p,F){return F?(((p.likesCount||0)+(p.commentsCount||0))/F)*100:0;}
function sc(p,F){const e=(p.likesCount||0)+(p.commentsCount||0)*3,v=gv(p),a=(Date.now()-+new Date(p.timestamp))/36e5,r=a<720?1:a<2160?.8:.6;return(F?(e/F)*100*r:0)+(F?(v/F)*20:0);}
function mean(a,f){return a.length?a.reduce((s,x)=>s+f(x),0)/a.length:0;}

function buildMetrics(raw){
  const p=raw[0],rawP=(p.latestPosts||p.posts||(p.username?[]:raw)).filter(x=>x&&(x.timestamp||x.likesCount!=null));
  const F=p.followersCount||1,N=rawP.length||1;
  const scored=rawP.map(x=>({...x,_v:gv(x),_sc:sc(x,F),_er:er(x,F),_type:pType(x.type||x.productType||""),
    _hook:((x.caption||"").split("\\n")[0]||"").trim().slice(0,200),
    _url:x.url||(x.shortCode?"https://instagram.com/p/"+x.shortCode:"#")})).sort((a,b)=>b._sc-a._sc);
  const by=t=>scored.filter(x=>x._type===t),rl=by("reel"),ca=by("carousel"),st=by("static");
  const avgV=mean(rl,x=>x._v),avgER=mean(scored,x=>x._er);
  const ts=rawP.map(x=>+new Date(x.timestamp)).filter(Boolean).sort((a,b)=>b-a);
  const span=ts.length>=2?(ts[0]-ts[ts.length-1])/864e5:7;
  return{handle:p.username||"unknown",name:p.fullName||p.name||p.username||"",bio:p.biography||p.bio||"",
    pic:p.profilePicUrl||"",verified:!!p.isVerified,followers:F,
    avgER:avgER.toFixed(2),avgViews:Math.round(avgV),vfr:((avgV/F)*100).toFixed(1),
    cadence:((N/Math.max(span,1))*7).toFixed(1)+"/wk",total:N,top5:scored.slice(0,5),
    hooks:scored.map(x=>x._hook).filter(Boolean).slice(0,20),
    fmt:{reel:{n:rl.length,pct:Math.round(rl.length/N*100),avgViews:Math.round(avgV),avgER:mean(rl,x=>x._er).toFixed(2)},
      carousel:{n:ca.length,pct:Math.round(ca.length/N*100),avgER:mean(ca,x=>x._er).toFixed(2)},
      static:{n:st.length,pct:Math.round(st.length/N*100),avgER:mean(st,x=>x._er).toFixed(2)}}};
}

function buildPrompt(m){
  return \`You are a brand-side social media analyst vetting Instagram creators for a men's health brand (Man Matters — hair loss, testosterone, fitness).

CREATOR: @\${m.handle} (\${m.name})\${m.verified?" ✓":""}
BIO: \${m.bio||"N/A"}
FOLLOWERS: \${m.followers.toLocaleString()} | AVG ER: \${m.avgER}% | AVG REEL VIEWS: \${fmt(m.avgViews)} | VFR: \${m.vfr}% | CADENCE: \${m.cadence}
FORMAT: \${m.fmt.reel.pct}% Reels · \${m.fmt.carousel.pct}% Carousels · \${m.fmt.static.pct}% Static | POSTS ANALYZED: \${m.total}

TOP 5 POSTS:
\${m.top5.map((p,i)=>\`\${i+1}. [\${p._type.toUpperCase()}] ER:\${p._er.toFixed(2)}% | Views:\${fmt(p._v)} | ♥\${fmt(p.likesCount)} 💬\${fmt(p.commentsCount)}\\n   Hook: "\${p._hook}"\`).join("\\n")}

ALL CAPTION HOOKS:
\${m.hooks.map((h,i)=>\`\${i+1}. "\${h}"\`).join("\\n")}

Return ONLY raw JSON, no markdown, no backticks:
{"hookAnalysis":[{"rank":1,"hook":"text","type":"mistake_based","label":"Mistake-Based","strength":8,"why":"one sentence"}],"patterns":[{"name":"name","freq":4,"pct":40,"signature":"one sentence","examples":["a","b"]}],"themes":[{"name":"name","pct":35,"desc":"one sentence","keywords":["a","b"]}],"frameworks":[{"name":"name","usage":"~40%","structure":"1) step 2) step 3) step","example":"example"}],"generatedHooks":[{"hook":"text","type":"mistake_based","angle":"Hair loss","note":"one sentence"}],"flags":[{"flag":"name","severity":"high","implication":"one sentence"}],"verdict":{"score":7.5,"strengths":["a","b"],"concerns":["a","b"],"bestUse":"sentence","formats":["Reel"]}}
Counts: hookAnalysis=5,patterns=3-4,themes=3-5,frameworks=2-3,generatedHooks=10,flags=2-5.
Types: curiosity_gap|contrarian|mistake_based|number_led|identity_trigger|pain_first|bold_promise|social_proof|transformation|question\`;
}

function tag(col,txt){return \`<span class="tag" style="background:\${col}22;color:\${col};border:1px solid \${col}44">\${txt}</span>\`;}
function sh(lbl,col){col=col||"#F59E0B";return \`<div style="display:flex;align-items:center;gap:8px;margin-bottom:14px"><div style="width:3px;height:16px;background:\${col};border-radius:2px"></div><span style="font-size:11px;font-weight:700;text-transform:uppercase;letter-spacing:.12em;color:var(--muted)">\${lbl}</span></div>\`;}
function sc2(l,v,sub,col){col=col||"#F59E0B";return \`<div class="card" style="flex:1;min-width:120px"><div style="font-size:10px;font-weight:700;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:5px">\${l}</div><div class="mono" style="font-size:20px;color:\${col};font-weight:700;line-height:1.1">\${v}</div>\${sub?\`<div style="font-size:11px;color:var(--muted);margin-top:3px">\${sub}</div>\`:""}</div>\`;}
function fb(lbl,pct,col,right){return \`<div style="margin-bottom:14px"><div class="flex" style="justify-content:space-between;margin-bottom:5px"><span style="font-size:13px">\${lbl}</span><span class="mono" style="font-size:12px;color:var(--muted)">\${right}</span></div><div class="bar-track"><div class="bar-fill" style="width:\${Math.min(pct,100)}%;background:\${col}"></div></div><div style="font-size:10px;color:var(--muted);margin-top:2px">\${pct}% of content mix</div></div>\`;}
function esc(s){return String(s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");}

async function startAnalysis(){
  const url=document.getElementById("i-url").value.trim();
  const apifyKey=document.getElementById("i-apify").value.trim();
  const errEl=document.getElementById("setup-err"),errMsg=document.getElementById("setup-err-msg");
  const showErr=msg=>{errMsg.textContent=msg;errEl.style.display="block";};
  errEl.style.display="none";
  const username=parseUser(url);
  if(!username)return showErr("Enter a valid Instagram URL or @handle.");
  if(!apifyKey)return showErr("Apify API key is required.");

  show("loading"); setStep(0,"Calling Apify scraper…");

  try{
    // 1. Scrape via same-origin /scrape endpoint
    setStep(0,"Starting Apify scraper…");
    const scrapeRes=await fetch("/scrape",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,apifyKey})});
    setStep(1,"Scraping Instagram profile…");
    const scrapeBody=await scrapeRes.json().catch(()=>({}));
    if(!scrapeRes.ok) throw new Error(scrapeBody.error||"Scrape failed: "+scrapeRes.status);
    setStep(2,"Processing scraped data…");
    const items=scrapeBody.data;
    if(!Array.isArray(items)||!items.length) throw new Error("No data returned. Account may be private or username is wrong.");

    // 2. Metrics
    setStep(3,"Calculating engagement metrics…");
    const d=buildMetrics(items);
    await sleep(300);

    // 3. Claude
    setStep(4,"Running AI hook & content analysis…");
    const cr=await fetch(CLAUDE_URL,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({model:MODEL,max_tokens:4000,messages:[{role:"user",content:buildPrompt(d)}]})});
    const cd=await cr.json();
    if(!cr.ok) throw new Error("Claude API error ("+cr.status+"): "+(cd?.error?.message||JSON.stringify(cd).slice(0,150)));
    const txt=(cd.content?.[0]?.text||"{}").replace(/\`\`\`json|\`\`\`/g,"").trim();
    let ai;
    try{ai=JSON.parse(txt);}catch(e){throw new Error("AI returned malformed JSON — retry. "+e.message);}

    // 4. Render
    setStep(5,"Building report…");
    await sleep(300);
    renderReport(d,ai);
    show("report");

  }catch(e){
    document.getElementById("err-msg").textContent=e.message||String(e);
    show("error");
  }
}

function renderReport(d,ai){
  document.getElementById("nav-h").textContent="@"+d.handle;
  const fc=ai?.verdict?.score>=7?"#10B981":ai?.verdict?.score>=5?"#F59E0B":"#EF4444";
  let h="";

  // Header
  h+=\`<div style="display:flex;gap:16px;align-items:center;margin-bottom:28px;flex-wrap:wrap">
    \${d.pic?\`<img src="\${d.pic}" onerror="this.style.display='none'" style="width:60px;height:60px;border-radius:50%;border:2px solid var(--amber);object-fit:cover;flex-shrink:0"/>\`:""}
    <div style="flex:1;min-width:0">
      <h1 style="font-size:22px;font-weight:800;margin-bottom:3px;letter-spacing:-.02em">\${esc(d.name||"@"+d.handle)}</h1>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;max-width:460px">\${esc((d.bio||"").slice(0,120))}\${(d.bio?.length||0)>120?"…":""}</div>
    </div>
    \${ai?.verdict?\`<div class="card" style="text-align:center;padding:12px 20px;flex-shrink:0;border-color:\${fc}55">
      <div style="font-size:10px;color:var(--muted);text-transform:uppercase;letter-spacing:.1em;margin-bottom:2px">Brand Fit</div>
      <div class="mono" style="font-size:30px;font-weight:700;line-height:1;color:\${fc}">\${ai.verdict.score}<span style="font-size:13px;color:var(--muted)">/10</span></div>
    </div>\`:""}
  </div>\`;

  // Stats
  h+=\`<div style="margin-bottom:28px">\${sh("Creator Overview")}
    <div class="flex wrap g10">
      \${sc2("Followers",fmt(d.followers))}
      \${sc2("Avg ER",d.avgER+"%",d.avgER>=3?"Strong":d.avgER>=1.5?"Average":"Weak",d.avgER>=3?"#10B981":d.avgER>=1.5?"#F59E0B":"#EF4444")}
      \${sc2("Avg Reel Views",fmt(d.avgViews))}
      \${sc2("Views/Follower",d.vfr+"%",d.vfr>=30?"Excellent":d.vfr>=10?"Good":"Weak",d.vfr>=30?"#10B981":d.vfr>=10?"#F59E0B":"#EF4444")}
      \${sc2("Cadence",d.cadence,d.total+" posts")}
    </div></div>\`;

  // Formats
  h+=\`<div style="margin-bottom:28px">\${sh("Format Performance","#6366F1")}<div class="card">
    \${fb("🎬 Reels",d.fmt.reel.pct,"#F59E0B",fmt(d.fmt.reel.avgViews)+" avg views · "+d.fmt.reel.avgER+"% ER")}
    \${fb("📸 Carousels",d.fmt.carousel.pct,"#6366F1",d.fmt.carousel.avgER+"% avg ER")}
    \${fb("🖼 Static",d.fmt.static.pct,"#1E1E30",d.fmt.static.avgER+"% avg ER")}
  </div></div>\`;

  // Top 5
  h+=\`<div style="margin-bottom:28px">\${sh("Top 5 Posts by Performance Score","#F59E0B")}\`;
  d.top5.forEach((p,i)=>{
    const hi=ai?.hookAnalysis?.find(x=>x.rank===i+1),tc=p._type==="reel"?"#F59E0B":p._type==="carousel"?"#6366F1":"#565672";
    h+=\`<div class="card flex" style="gap:14px;margin-bottom:10px">
      <div class="mono" style="font-size:22px;font-weight:700;color:\${i===0?"#F59E0B":"#1E1E30"};width:26px;flex-shrink:0;padding-top:2px">\${i+1}</div>
      <div style="flex:1;min-width:0">
        <div class="flex wrap g10" style="margin-bottom:8px">
          \${tag(tc,p._type)}\${hi?tag(HOOK_COL[hi.type]||"#F59E0B",hi.label)+""+tag("#14B8A6",hi.strength+"/10 hook"):""}\${tag("#10B981",p._er.toFixed(2)+"% ER")}\${p._v>0?tag("#EC4899",fmt(p._v)+" views"):""}
        </div>
        <p style="margin:0 0 6px;font-size:14px;line-height:1.6"><b style="color:#F59E0B">Hook: </b>\${esc(p._hook||"(no caption)")}</p>
        \${hi?.why?\`<p style="margin:0 0 8px;font-size:12px;color:var(--muted);font-style:italic;line-height:1.5">\${esc(hi.why)}</p>\`:""}
        <div class="flex g10"><span style="font-size:12px;color:var(--muted)">♥ \${fmt(p.likesCount)}</span><span style="font-size:12px;color:var(--muted)">💬 \${fmt(p.commentsCount)}</span>\${p._url&&p._url!="#"?\`<a href="\${p._url}" target="_blank" style="font-size:12px;color:#6366F1;text-decoration:none">View ↗</a>\`:""}</div>
      </div></div>\`;
  });
  h+=\`</div>\`;

  // Hook patterns
  if(ai?.patterns?.length){
    h+=\`<div style="margin-bottom:28px">\${sh("Hook Pattern Clusters","#6366F1")}<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(240px,1fr))">\`;
    ai.patterns.forEach(p=>{h+=\`<div class="card"><div class="flex" style="justify-content:space-between;margin-bottom:8px"><b style="font-size:14px;line-height:1.3">\${esc(p.name)}</b><span class="mono" style="font-size:22px;color:#F59E0B;font-weight:700;margin-left:8px">\${p.pct}%</span></div><div class="bar-track" style="margin-bottom:10px"><div class="bar-fill" style="width:\${Math.min(p.pct,100)}%;background:#F59E0B"></div></div><p style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px">\${esc(p.signature)}</p>\${(p.examples||[]).slice(0,2).map(e=>\`<div style="font-size:11px;color:var(--dim);font-style:italic;margin-bottom:4px;padding-left:8px;border-left:2px solid var(--border);line-height:1.5">"\${esc(e)}"</div>\`).join("")}</div>\`;});
    h+=\`</div></div>\`;
  }

  // Themes
  if(ai?.themes?.length){
    h+=\`<div style="margin-bottom:28px">\${sh("Content Themes","#10B981")}<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(210px,1fr))">\`;
    ai.themes.forEach((t,i)=>{const c=TCOLS[i%TCOLS.length];h+=\`<div class="card" style="border-top:2px solid \${c}"><div class="flex" style="justify-content:space-between;margin-bottom:6px"><b style="font-size:14px">\${esc(t.name)}</b><span class="mono" style="color:\${c};font-size:13px">\${t.pct}%</span></div><p style="font-size:12px;color:var(--muted);line-height:1.6;margin-bottom:10px">\${esc(t.desc)}</p><div class="flex wrap g10">\${(t.keywords||[]).map(k=>\`<span style="background:\${c}18;color:\${c};border-radius:4px;padding:2px 7px;font-size:10px;font-weight:700">\${esc(k)}</span>\`).join("")}</div></div>\`;});
    h+=\`</div></div>\`;
  }

  // Frameworks
  if(ai?.frameworks?.length){
    h+=\`<div style="margin-bottom:28px">\${sh("Repeatable Content Frameworks","#EC4899")}\`;
    ai.frameworks.forEach(fw=>{const steps=(fw.structure||"").split(/\\d\\)/).filter(s=>s.trim());h+=\`<div class="card" style="margin-bottom:10px"><div class="flex" style="justify-content:space-between;align-items:center;margin-bottom:10px;gap:10px;flex-wrap:wrap"><b style="font-size:15px">\${esc(fw.name)}</b>\${tag("#EC4899",fw.usage)}</div><div class="flex wrap g10" style="margin-bottom:10px">\${steps.map((s,j)=>\`<div style="background:var(--bg);border:1px solid var(--border);border-radius:6px;padding:5px 10px;font-size:12px;color:var(--muted)"><span style="color:#EC4899;font-weight:700">\${j+1}</span> \${esc(s.trim())}</div>\`).join("")}</div>\${fw.example?\`<div style="font-size:12px;color:var(--dim);font-style:italic;border-left:2px solid #EC4899;padding-left:10px;line-height:1.6">"\${esc(fw.example)}"</div>\`:""}</div>\`;});
    h+=\`</div>\`;
  }

  // Generated hooks
  if(ai?.generatedHooks?.length){
    h+=\`<div style="margin-bottom:28px">\${sh("10 Hook Ideas — Adapted for Man Matters","#F59E0B")}<div class="grid" style="grid-template-columns:repeat(auto-fill,minmax(350px,1fr))">\`;
    ai.generatedHooks.forEach((hk,i)=>{const c=HOOK_COL[hk.type]||"#F59E0B";h+=\`<div class="card" style="border-left:3px solid \${c}"><div class="flex wrap g10" style="margin-bottom:8px;align-items:center"><span class="mono" style="color:var(--dim);font-size:10px;font-weight:700">#\${String(i+1).padStart(2,"0")}</span>\${tag(c,(hk.type||"").replace(/_/g," "))}\${hk.angle?\`<span style="font-size:11px;color:var(--muted)">\${esc(hk.angle)}</span>\`:""}</div><p style="margin:0 0 8px;font-weight:700;font-size:14px;line-height:1.6">"\${esc(hk.hook)}"</p>\${hk.note?\`<p style="margin:0;font-size:11px;color:var(--muted);font-style:italic;line-height:1.5">\${esc(hk.note)}</p>\`:""}</div>\`;});
    h+=\`</div></div>\`;
  }

  // Brand fit
  if(ai?.flags?.length||ai?.verdict){
    h+=\`<div style="margin-bottom:28px">\${sh("Brand Fit Assessment","#EF4444")}<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px"><div><div style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Vetting Flags</div>\`;
    (ai.flags||[]).forEach(f=>{const c=SEV_COL[f.severity]||"#565672";h+=\`<div class="card" style="margin-bottom:8px;border-left:3px solid \${c}"><div class="flex wrap g10" style="margin-bottom:5px;align-items:center">\${tag(c,f.severity)}<b style="font-size:13px">\${esc(f.flag)}</b></div><p style="margin:0;font-size:12px;color:var(--muted);line-height:1.5">\${esc(f.implication)}</p></div>\`;});
    h+=\`</div>\`;
    if(ai.verdict){h+=\`<div><div style="font-size:11px;color:var(--muted);font-weight:700;text-transform:uppercase;letter-spacing:.08em;margin-bottom:8px">Verdict</div><div class="card"><div style="font-size:11px;color:#10B981;font-weight:700;margin-bottom:5px">✓ Strengths</div>\${(ai.verdict.strengths||[]).map(s=>\`<div style="font-size:12px;color:var(--muted);margin-bottom:3px;line-height:1.5">· \${esc(s)}</div>\`).join("")}<div style="font-size:11px;color:#EF4444;font-weight:700;margin:12px 0 5px">✗ Concerns</div>\${(ai.verdict.concerns||[]).map(c=>\`<div style="font-size:12px;color:var(--muted);margin-bottom:3px;line-height:1.5">· \${esc(c)}</div>\`).join("")}<div style="margin:14px 0 0;padding:11px 13px;background:var(--bg);border-radius:8px"><div style="font-size:10px;color:var(--muted);margin-bottom:4px;text-transform:uppercase;letter-spacing:.08em">Best Use Case</div><div style="font-size:13px;color:#F59E0B;line-height:1.6">\${esc(ai.verdict.bestUse||"")}</div></div><div class="flex wrap g10" style="margin-top:10px">\${(ai.verdict.formats||[]).map(f=>tag("#6366F1",f)).join("")}</div></div></div>\`;}
    h+=\`</div></div>\`;
  }

  h+=\`<div style="border-top:1px solid var(--border);padding-top:18px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:10px">
    <span style="font-size:11px;color:var(--dim)">CreatorLens · Apify + Claude · \${d.total} posts analyzed</span>
    <button class="btn" onclick="show('setup')" style="width:auto;padding:9px 18px;font-size:13px">Analyze Another →</button>
  </div>\`;

  document.getElementById("report").innerHTML=h;
}

show("setup");
</script>
</body>
</html>`);
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CreatorLens running on port ${PORT}`));
