/**
 * CreatorLens Proxy Server
 * Deploys to Railway in ~2 minutes.
 * Bridges the artifact (claude.ai) → Apify Instagram scraper.
 *
 * POST /scrape   { username: string, apifyKey: string }
 * GET  /health   → 200 OK
 */

const express = require("express");
const cors    = require("cors");
const app     = express();

app.use(cors());           // allow requests from any origin (claude.ai artifact)
app.use(express.json());

const APIFY_BASE = "https://api.apify.com/v2";
const ACTOR_ID   = "apify~instagram-profile-scraper";
const sleep      = ms => new Promise(r => setTimeout(r, ms));

// ─── Health check ─────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => res.json({ ok: true }));

// ─── Main scrape endpoint ─────────────────────────────────────────────────────
app.post("/scrape", async (req, res) => {
  const { username, apifyKey } = req.body || {};

  if (!username || !apifyKey) {
    return res.status(400).json({ error: "username and apifyKey are required." });
  }

  try {
    // 1. Start Apify run
    const startRes = await fetch(
      `${APIFY_BASE}/acts/${ACTOR_ID}/runs?token=${apifyKey}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ usernames: [username], resultsLimit: 30 }),
      }
    );
    const startBody = await startRes.json();

    if (!startRes.ok) {
      const msg = startBody?.error?.message || startBody?.message || JSON.stringify(startBody).slice(0, 200);
      return res.status(startRes.status).json({ error: `Apify error: ${msg}` });
    }

    const runId     = startBody?.data?.id;
    const datasetId = startBody?.data?.defaultDatasetId;

    if (!runId) {
      return res.status(500).json({ error: "Apify did not return a run ID.", raw: startBody });
    }

    // 2. Poll until SUCCEEDED (max 3 min)
    let status = "RUNNING";
    let attempts = 0;

    while (["RUNNING", "READY", "ABORTING"].includes(status) && attempts < 36) {
      await sleep(5000);
      attempts++;

      const pollRes  = await fetch(`${APIFY_BASE}/actor-runs/${runId}?token=${apifyKey}`);
      const pollBody = await pollRes.json();
      status = pollBody?.data?.status || "UNKNOWN";

      if (["FAILED", "ABORTED", "TIMED-OUT"].includes(status)) {
        return res.status(500).json({
          error: `Apify run ended with status: ${status}`,
          runUrl: `https://console.apify.com/actors/runs/${runId}`,
        });
      }
    }

    if (status !== "SUCCEEDED") {
      return res.status(500).json({ error: `Apify run did not complete. Last status: ${status}` });
    }

    // 3. Fetch dataset
    const itemsRes  = await fetch(`${APIFY_BASE}/datasets/${datasetId}/items?token=${apifyKey}&format=json`);
    const items     = await itemsRes.json();

    if (!itemsRes.ok) {
      return res.status(itemsRes.status).json({ error: "Failed to fetch dataset.", raw: items });
    }

    if (!Array.isArray(items) || !items.length) {
      return res.status(404).json({ error: "No data returned. Account may be private or username is wrong." });
    }

    return res.json({ ok: true, data: items });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: err.message || "Unexpected server error." });
  }
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => console.log(`CreatorLens proxy running on port ${PORT}`));
