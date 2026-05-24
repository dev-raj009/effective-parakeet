/**
 * ╔══════════════════════════════════════════════════════════════╗
 * ║       CareerWill Dark Universe — Node.js API Server          ║
 * ║                   Powered by Raj  🚀                         ║
 * ╚══════════════════════════════════════════════════════════════╝
 *
 * Endpoints:
 *   GET /api/batches
 *   GET /api/batches/:batchId
 *   GET /api/batches/:batchId/subjects
 *   GET /api/batches/:batchId/topics
 *   GET /api/batches/:batchId/topics/:topicId
 *   GET /api/video?id=VIDEO_ID        (resolves HLS URL via upstream API)
 *   GET /api/search?q=query
 *   GET /api/stats
 */

const express  = require("express");
const cors     = require("cors");
const path     = require("path");
const fs       = require("fs");
const https    = require("https");

const app  = express();
const PORT = process.env.PORT || 3000;

// ─────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────

const DATA_DIR         = path.join(__dirname, "data");
const MASTER_FILE      = path.join(DATA_DIR, "all_batches.json");
const VIDEO_DETAIL_URL = "https://cw-vid-virid.vercel.app/get_video_details?name=";

// ─────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────

app.use(cors());
app.use(express.json());

// Request logger
app.use((req, _res, next) => {
  console.log(`[${new Date().toISOString()}] ${req.method} ${req.originalUrl}`);
  next();
});

// ─────────────────────────────────────────────
//  DATA LOADER (in-memory cache)
// ─────────────────────────────────────────────

let masterIndex  = null;    // all_batches.json content
let batchCache   = {};      // { batchId: batchData }

function loadMaster() {
  try {
    const raw  = fs.readFileSync(MASTER_FILE, "utf-8");
    masterIndex = JSON.parse(raw);
    console.log(`✅ Master index loaded — ${masterIndex.total_batches} batches`);
  } catch (e) {
    console.error("❌ Could not load all_batches.json:", e.message);
    masterIndex = { generated_at: new Date().toISOString(), total_batches: 0, batches: [] };
  }
}

function loadBatch(batchId) {
  if (batchCache[batchId]) return batchCache[batchId];

  // Find the filename from master index
  const meta = masterIndex.batches.find(b => String(b.batch_id) === String(batchId));
  if (!meta) return null;

  const fpath = path.join(DATA_DIR, meta.file);
  try {
    const raw   = fs.readFileSync(fpath, "utf-8");
    const data  = JSON.parse(raw);
    batchCache[batchId] = data;
    return data;
  } catch (e) {
    console.error(`❌ Could not load batch file ${meta.file}:`, e.message);
    return null;
  }
}

// Load on startup
loadMaster();

// ─────────────────────────────────────────────
//  HELPER: resolve video URL from upstream API
// ─────────────────────────────────────────────

function fetchVideoDetail(videoId) {
  return new Promise((resolve) => {
    const url = VIDEO_DETAIL_URL + encodeURIComponent(videoId);
    https.get(url, { timeout: 15000 }, (res) => {
      let body = "";
      res.on("data", chunk => body += chunk);
      res.on("end", () => {
        try {
          const data = JSON.parse(body);
          if (!data.success) return resolve({ video_url: null, hls_url: null, duration_sec: null, size: null });

          const link       = data.data?.link || {};
          const fileUrl    = link.file_url || null;
          const streamUrl  = link.url      || null;
          const directUrl  = fileUrl || streamUrl;

          // Identify HLS (m3u8) URL
          let hlsUrl = null;
          for (const c of [fileUrl, streamUrl]) {
            if (c && c.includes(".m3u8")) { hlsUrl = c; break; }
          }
          if (!hlsUrl) hlsUrl = streamUrl || fileUrl;

          resolve({
            video_url:    directUrl,
            hls_url:      hlsUrl,
            duration_sec: data.data?.duration  || null,
            size:         data.data?.size       || null,
          });
        } catch {
          resolve({ video_url: null, hls_url: null, duration_sec: null, size: null });
        }
      });
    }).on("error", () => {
      resolve({ video_url: null, hls_url: null, duration_sec: null, size: null });
    });
  });
}

// ─────────────────────────────────────────────
//  HELPER: error response
// ─────────────────────────────────────────────

function notFound(res, msg = "Not found") {
  return res.status(404).json({ success: false, error: msg });
}

function serverErr(res, msg = "Internal server error") {
  return res.status(500).json({ success: false, error: msg });
}

// ─────────────────────────────────────────────
//  ROUTE: GET /api/batches
//  Returns list of all batches (index only, no content)
// ─────────────────────────────────────────────

app.get("/api/batches", (req, res) => {
  const batches = masterIndex.batches.map(b => ({
    batch_id:       b.batch_id,
    batch_name:     b.batch_name,
    total_subjects: b.total_subjects || 0,
    total_topics:   b.total_topics   || 0,
    total_videos:   b.total_videos   || 0,
    total_pdfs:     b.total_pdfs     || 0,
    scraped_at:     b.scraped_at     || null,
  }));

  res.json({
    success:      true,
    generated_at: masterIndex.generated_at,
    total:        batches.length,
    batches,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/batches/:batchId
//  Returns full batch data (subjects → topics → videos + PDFs)
// ─────────────────────────────────────────────

app.get("/api/batches/:batchId", (req, res) => {
  const data = loadBatch(req.params.batchId);
  if (!data) return notFound(res, `Batch ${req.params.batchId} not found`);

  res.json({
    success:        true,
    batch_id:       data.batch_id,
    batch_name:     data.batch_name,
    scraped_at:     data.scraped_at,
    total_subjects: data.total_subjects,
    total_topics:   data.total_topics,
    total_videos:   data.total_videos,
    total_pdfs:     data.total_pdfs,
    subjects:       data.subjects,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/batches/:batchId/subjects
//  Returns subject list with topic counts (no content)
// ─────────────────────────────────────────────

app.get("/api/batches/:batchId/subjects", (req, res) => {
  const data = loadBatch(req.params.batchId);
  if (!data) return notFound(res, `Batch ${req.params.batchId} not found`);

  const subjects = data.subjects.map(s => ({
    id:           s.id,
    name:         s.name,
    total_topics: s.total_topics || s.topics?.length || 0,
  }));

  res.json({
    success:    true,
    batch_id:   data.batch_id,
    batch_name: data.batch_name,
    total:      subjects.length,
    subjects,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/batches/:batchId/topics
//  Optional: ?subject_id=10
//  Returns flat topic list with video/pdf counts
// ─────────────────────────────────────────────

app.get("/api/batches/:batchId/topics", (req, res) => {
  const data = loadBatch(req.params.batchId);
  if (!data) return notFound(res, `Batch ${req.params.batchId} not found`);

  const filterSubjectId = req.query.subject_id ? String(req.query.subject_id) : null;

  const topics = [];
  for (const subj of data.subjects) {
    if (filterSubjectId && String(subj.id) !== filterSubjectId) continue;
    for (const topic of (subj.topics || [])) {
      topics.push({
        id:            topic.id,
        name:          topic.name,
        subject_id:    subj.id,
        subject_name:  subj.name,
        total_videos:  topic.total_videos || topic.videos?.length || 0,
        total_pdfs:    topic.total_pdfs   || topic.pdfs?.length   || 0,
      });
    }
  }

  res.json({
    success:   true,
    batch_id:  data.batch_id,
    total:     topics.length,
    topics,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/batches/:batchId/topics/:topicId
//  Returns full topic with all videos + PDFs
// ─────────────────────────────────────────────

app.get("/api/batches/:batchId/topics/:topicId", (req, res) => {
  const data = loadBatch(req.params.batchId);
  if (!data) return notFound(res, `Batch ${req.params.batchId} not found`);

  const topicId = String(req.params.topicId);
  let foundTopic   = null;
  let foundSubject  = null;

  outer:
  for (const subj of data.subjects) {
    for (const topic of (subj.topics || [])) {
      if (String(topic.id) === topicId) {
        foundTopic   = topic;
        foundSubject = subj;
        break outer;
      }
    }
  }

  if (!foundTopic) return notFound(res, `Topic ${topicId} not found in batch ${req.params.batchId}`);

  res.json({
    success:      true,
    batch_id:     data.batch_id,
    batch_name:   data.batch_name,
    subject_id:   foundSubject.id,
    subject_name: foundSubject.name,
    topic: {
      id:           foundTopic.id,
      name:         foundTopic.name,
      total_videos: foundTopic.total_videos || foundTopic.videos?.length || 0,
      total_pdfs:   foundTopic.total_pdfs   || foundTopic.pdfs?.length   || 0,
      videos:       foundTopic.videos || [],
      pdfs:         foundTopic.pdfs   || [],
    },
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/video?id=VIDEO_ID
//  Resolves HLS video URL via upstream API 4
// ─────────────────────────────────────────────

app.get("/api/video", async (req, res) => {
  const videoId = req.query.id;
  if (!videoId) {
    return res.status(400).json({ success: false, error: "?id=VIDEO_ID parameter required" });
  }

  try {
    const detail = await fetchVideoDetail(videoId);
    res.json({
      success:      true,
      video_id:     videoId,
      video_url:    detail.video_url,
      hls_url:      detail.hls_url,
      duration_sec: detail.duration_sec,
      size:         detail.size,
    });
  } catch (e) {
    serverErr(res, "Could not resolve video URL");
  }
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/search?q=query
//  Searches topic names across all batches
//  Optional: &batch_id=1234  (limit to one batch)
// ─────────────────────────────────────────────

app.get("/api/search", (req, res) => {
  const query = (req.query.q || "").trim().toLowerCase();
  if (!query) {
    return res.status(400).json({ success: false, error: "?q=query parameter required" });
  }

  const limitBatchId = req.query.batch_id ? String(req.query.batch_id) : null;
  const results      = [];

  const batchesToSearch = limitBatchId
    ? masterIndex.batches.filter(b => String(b.batch_id) === limitBatchId)
    : masterIndex.batches;

  for (const batchMeta of batchesToSearch) {
    const data = loadBatch(batchMeta.batch_id);
    if (!data) continue;

    for (const subj of (data.subjects || [])) {
      for (const topic of (subj.topics || [])) {
        if (topic.name.toLowerCase().includes(query)) {
          results.push({
            type:         "topic",
            batch_id:     data.batch_id,
            batch_name:   data.batch_name,
            subject_id:   subj.id,
            subject_name: subj.name,
            topic_id:     topic.id,
            topic_name:   topic.name,
            total_videos: topic.total_videos || topic.videos?.length || 0,
            total_pdfs:   topic.total_pdfs   || topic.pdfs?.length   || 0,
          });
        }
      }
    }
  }

  res.json({
    success: true,
    query:   req.query.q,
    total:   results.length,
    results,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/stats
//  Grand totals across all scraped batches
// ─────────────────────────────────────────────

app.get("/api/stats", (req, res) => {
  const totals = masterIndex.grand_totals || (() => {
    let subjects = 0, topics = 0, videos = 0, pdfs = 0;
    for (const b of masterIndex.batches) {
      subjects += b.total_subjects || 0;
      topics   += b.total_topics   || 0;
      videos   += b.total_videos   || 0;
      pdfs     += b.total_pdfs     || 0;
    }
    return { subjects, topics, videos, pdfs };
  })();

  res.json({
    success:        true,
    total_batches:  masterIndex.total_batches || masterIndex.batches.length,
    total_subjects: totals.subjects,
    total_topics:   totals.topics,
    total_videos:   totals.videos,
    total_pdfs:     totals.pdfs,
    generated_at:   masterIndex.generated_at,
  });
});

// ─────────────────────────────────────────────
//  ROUTE: GET /api/reload  (admin — reload cache)
// ─────────────────────────────────────────────

app.get("/api/reload", (req, res) => {
  batchCache  = {};
  loadMaster();
  res.json({ success: true, message: "Cache cleared and master index reloaded." });
});

// ─────────────────────────────────────────────
//  ROUTE: Root health check
// ─────────────────────────────────────────────

app.get("/", (req, res) => {
  res.json({
    name:    "CareerWill Dark Universe API",
    version: "1.0.0",
    status:  "running",
    endpoints: [
      "GET /api/batches",
      "GET /api/batches/:batchId",
      "GET /api/batches/:batchId/subjects",
      "GET /api/batches/:batchId/topics[?subject_id=]",
      "GET /api/batches/:batchId/topics/:topicId",
      "GET /api/video?id=VIDEO_ID",
      "GET /api/search?q=query[&batch_id=]",
      "GET /api/stats",
      "GET /api/reload",
    ],
  });
});

// ─────────────────────────────────────────────
//  404 fallback
// ─────────────────────────────────────────────

app.use((req, res) => {
  res.status(404).json({ success: false, error: `Route '${req.path}' not found` });
});

// ─────────────────────────────────────────────
//  START SERVER
// ─────────────────────────────────────────────

app.listen(PORT, () => {
  console.log(`\n🚀 CareerWill API running on http://localhost:${PORT}`);
  console.log(`   Try: http://localhost:${PORT}/api/batches\n`);
});

module.exports = app;   // Vercel ke liye
