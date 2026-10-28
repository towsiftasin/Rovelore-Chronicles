/* =========================================================
   Rovelore Chronicles – Explore backend
   - Mission facts live in data/missions.json
   - Images + videos are fetched from the NASA Image and Video
     Library (https://images-api.nasa.gov, no API key needed),
     cached on disk, and refreshed automatically.
   - Hand-picked media can be added in data/overrides.json and
     always wins over the automatic results.
   ========================================================= */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const NASA_API = "https://images-api.nasa.gov";
const REFRESH_MS = 12 * 60 * 60 * 1000;       // re-fetch media every 12 hours
const MAX_IMAGES = 8;
const MAX_VIDEOS = 3;

const DATA_DIR = path.join(__dirname, "data");
const MISSIONS_FILE = path.join(DATA_DIR, "missions.json");
const OVERRIDES_FILE = path.join(DATA_DIR, "overrides.json");   // optional
const CACHE_FILE = path.join(DATA_DIR, "media-cache.json");     // created automatically

function readJSON(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch (e) { return fallback; }
}

// ---------- NASA media helpers ----------
async function getJSON(url) {
  const res = await fetch(url, { headers: { "User-Agent": "RoveloreChronicles/1.0" } });
  if (!res.ok) throw new Error("HTTP " + res.status + " for " + url);
  return res.json();
}

async function searchNasa(query, mediaType) {
  const url = NASA_API + "/search?q=" + encodeURIComponent(query) + "&media_type=" + mediaType;
  const data = await getJSON(url);
  return (data.collection && data.collection.items) || [];
}

async function fetchImages(query) {
  if (!query) return [];
  const items = await searchNasa(query, "image");
  const out = [];
  for (const it of items) {
    const meta = (it.data && it.data[0]) || {};
    const link = (it.links || []).find(function (l) { return l.render === "image"; });
    if (!link || !link.href) continue;
    out.push({ url: link.href, title: meta.title || "", nasaId: meta.nasa_id || "" });
    if (out.length >= MAX_IMAGES) break;
  }
  return out;
}

async function fetchVideos(query) {
  if (!query) return [];
  const items = await searchNasa(query, "video");
  const out = [];
  for (const it of items.slice(0, 6)) {
    const meta = (it.data && it.data[0]) || {};
    if (!meta.nasa_id) continue;
    try {
      const assets = await getJSON(NASA_API + "/asset/" + encodeURIComponent(meta.nasa_id));
      const files = ((assets.collection && assets.collection.items) || []).map(function (a) { return a.href; });
      const mp4s = files.filter(function (h) { return /\.mp4$/i.test(h); });
      const pick = mp4s.find(function (h) { return /~medium\./i.test(h); }) ||
                   mp4s.find(function (h) { return /~mobile\./i.test(h); }) ||
                   mp4s.find(function (h) { return /~small\./i.test(h); }) || mp4s[0];
      if (!pick) continue;
      const thumb = files.find(function (h) { return /\.jpg$/i.test(h); }) || "";
      out.push({ url: pick.replace(/^http:/, "https:"), title: meta.title || "", poster: thumb.replace(/^http:/, "https:"), nasaId: meta.nasa_id });
    } catch (e) { /* skip this video, try the next */ }
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
}

// ---------- cache ----------
let mediaCache = readJSON(CACHE_FILE, {});    // { missionId: { images:[], videos:[], fetchedAt } }
let refreshing = false;

async function refreshMedia(force) {
  if (refreshing) return;
  refreshing = true;
  const missions = readJSON(MISSIONS_FILE, []);
  for (const m of missions) {
    const cached = mediaCache[m.id];
    const fresh = cached && (Date.now() - cached.fetchedAt < REFRESH_MS);
    if (fresh && !force) continue;
    try {
      const images = await fetchImages(m.nasaQuery);
      const videos = await fetchVideos(m.nasaVideoQuery);
      mediaCache[m.id] = { images: images, videos: videos, fetchedAt: Date.now() };
      fs.writeFileSync(CACHE_FILE, JSON.stringify(mediaCache, null, 2));
      console.log("[media] " + m.id + ": " + images.length + " images, " + videos.length + " videos");
    } catch (e) {
      console.warn("[media] " + m.id + " failed: " + e.message);   // keep any older cache
    }
  }
  refreshing = false;
}

// ---------- build the response for one mission ----------
function build(m) {
  const over = (readJSON(OVERRIDES_FILE, {}))[m.id] || {};
  const cached = mediaCache[m.id] || { images: [], videos: [] };

  const autoImages = cached.images.map(function (i) { return i.url; });
  const gallery = (over.gallery && over.gallery.length) ? over.gallery : autoImages;
  const image = over.image || gallery[0] || "";
  const videos = (over.videos && over.videos.length)
    ? over.videos.map(function (v) { return typeof v === "string" ? { url: v, title: "", poster: "" } : v; })
    : cached.videos;

  // fall back to the NASA library page of the first image when no sourceUrl is set
  const first = cached.images[0];
  const sourceUrl = over.sourceUrl || m.sourceUrl ||
    (first && first.nasaId ? "https://images.nasa.gov/details/" + encodeURIComponent(first.nasaId) : "");

  const out = Object.assign({}, m, {
    image: image,
    gallery: gallery,
    videos: videos,
    sourceUrl: sourceUrl,
    discoveries: (over.discoveries && over.discoveries.length) ? over.discoveries : m.discoveries
  });
  delete out.nasaQuery;
  delete out.nasaVideoQuery;
  return out;
}

// ---------- API ----------
const app = express();
app.use(cors());   // lets your HTML page (any origin / file://) call the API

app.get("/api/health", function (req, res) {
  res.json({ ok: true, mediaReady: Object.keys(mediaCache).length, refreshing: refreshing });
});

// GET /api/missions?destination=Mars&type=Rover&status=Active&media=Images&q=crater
app.get("/api/missions", function (req, res) {
  const q = (req.query.q || "").toLowerCase();
  let list = readJSON(MISSIONS_FILE, []).map(build);
  if (req.query.destination && req.query.destination !== "All") list = list.filter(function (m) { return m.destination === req.query.destination; });
  if (req.query.type)   list = list.filter(function (m) { return m.type === req.query.type; });
  if (req.query.status) list = list.filter(function (m) { return m.status === req.query.status; });
  const media = req.query.media;
  if (media === "Images") list = list.filter(function (m) { return m.gallery.length > 0; });
  if (media === "Videos") list = list.filter(function (m) { return m.videos.length > 0; });
  if (media === "Both")   list = list.filter(function (m) { return m.gallery.length > 0 && m.videos.length > 0; });
  if (q) list = list.filter(function (m) {
    return [m.name, m.destination, m.type, m.mission, m.year, m.location, m.description, m.status].join(" ").toLowerCase().indexOf(q) !== -1;
  });
  res.json(list);
});

app.get("/api/missions/:id", function (req, res) {
  const m = readJSON(MISSIONS_FILE, []).find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: "Mission not found" });
  res.json(build(m));
});

// Force a media refresh (handy while developing): POST /api/refresh
app.post("/api/refresh", function (req, res) {
  refreshMedia(true);
  res.json({ started: true });
});

app.listen(PORT, function () {
  console.log("Rovelore API running on http://localhost:" + PORT);
  refreshMedia(false);
  setInterval(function () { refreshMedia(false); }, REFRESH_MS);
});