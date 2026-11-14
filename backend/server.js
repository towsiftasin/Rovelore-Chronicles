/* =========================================================
   Rovelore Chronicles – Explore backend
   - Mission facts live in data/missions.json
   - Images + videos are fetched from the NASA Image and Video
     Library (https://images-api.nasa.gov, no API key needed),
     cached on disk, and refreshed automatically.
   - Hand-picked media goes in data/overrides.json and always
     wins over the automatic results (see the comments in build() below).
   ========================================================= */
const express = require("express");
const cors = require("cors");
const fs = require("fs");
const path = require("path");

const PORT = process.env.PORT || 3000;
const NASA_API = "https://images-api.nasa.gov";
const REFRESH_MS = 12 * 60 * 60 * 1000;       // re-fetch media every 12 hours
const RETRY_MS = 5 * 60 * 1000;               // after a failed NASA request, try again after 5 minutes
const FIRST_LOAD_WAIT_MS = 45 * 1000;          // on a cold start, wait this long for media before answering
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

async function assetFiles(nasaId) {
  const assets = await getJSON(NASA_API + "/asset/" + encodeURIComponent(nasaId));
  return ((assets.collection && assets.collection.items) || []).map(function (a) { return a.href; });
}

// The search results only give a tiny "~thumb" picture. Ask the asset list for a sharper one
// (medium > small > large), and fall back to the thumbnail if that fails.
async function bestImageUrl(nasaId, fallback) {
  try {
    const files = await assetFiles(nasaId);
    const jpgs = files.filter(function (h) { return /\.jpe?g$/i.test(h); });
    const pick = jpgs.find(function (h) { return /~medium\./i.test(h); }) ||
                 jpgs.find(function (h) { return /~small\./i.test(h); }) ||
                 jpgs.find(function (h) { return /~large\./i.test(h); });
    if (pick) return pick.replace(/^http:/, "https:");
  } catch (e) { /* use the thumbnail */ }
  return fallback.replace(/^http:/, "https:");
}

// the sharper-picture lookups run at the same time (not one after another), so a cold start is much faster
async function fetchImages(query) {
  if (!query) return [];
  const items = await searchNasa(query, "image");
  const picks = [];
  for (const it of items) {
    const meta = (it.data && it.data[0]) || {};
    const link = (it.links || []).find(function (l) { return l.render === "image"; });
    if (!link || !link.href) continue;
    picks.push({ meta: meta, link: link });
    if (picks.length >= MAX_IMAGES) break;
  }
  return Promise.all(picks.map(async function (p) {
    const url = p.meta.nasa_id ? await bestImageUrl(p.meta.nasa_id, p.link.href) : p.link.href.replace(/^http:/, "https:");
    return { url: url, title: p.meta.title || "", nasaId: p.meta.nasa_id || "" };
  }));
}

// turn one NASA video id into { url, title, poster, nasaId } (null if it has no mp4)
async function videoFromId(nasaId, title) {
  const files = await assetFiles(nasaId);
  const mp4s = files.filter(function (h) { return /\.mp4$/i.test(h); });
  const pick = mp4s.find(function (h) { return /~medium\./i.test(h); }) ||
               mp4s.find(function (h) { return /~mobile\./i.test(h); }) ||
               mp4s.find(function (h) { return /~small\./i.test(h); }) || mp4s[0];
  if (!pick) return null;
  const thumb = files.find(function (h) { return /\.jpg$/i.test(h); }) || "";
  return { url: pick.replace(/^http:/, "https:"), title: title || "", poster: thumb.replace(/^http:/, "https:"), nasaId: nasaId };
}

async function fetchVideos(query) {
  if (!query) return [];
  const items = await searchNasa(query, "video");
  const out = [];
  for (const it of items.slice(0, 6)) {
    const meta = (it.data && it.data[0]) || {};
    if (!meta.nasa_id) continue;
    try {
      const v = await videoFromId(meta.nasa_id, meta.title);
      if (v) out.push(v);
    } catch (e) { /* skip this video, try the next */ }
    if (out.length >= MAX_VIDEOS) break;
  }
  return out;
}

// ---------- hand-picked media: resolve NASA ids / titles into real file links ----------
// image id (e.g. "PIA06739") -> best .jpg link
async function resolveImageId(nasaId) {
  const files = await assetFiles(nasaId);
  const jpgs = files.filter(function (h) { return /\.jpe?g$/i.test(h); });
  const pick = jpgs.find(function (h) { return /~large\./i.test(h); }) ||
               jpgs.find(function (h) { return /~medium\./i.test(h); }) ||
               jpgs.find(function (h) { return /~orig\./i.test(h); }) || jpgs[0];
  return pick ? pick.replace(/^http:/, "https:") : "";
}

// a video spec can be:
//   "KSC-04-S-00163"                                  (a NASA id)
//   { "id": "...", "title": "..." }
//   { "search": "words to search", "match": "text the title must contain" }   (match can be a list)
//   { "url": "https://.../clip.mp4", "title": "...", "poster": "..." }       (your own file)
async function resolveVideoSpec(spec) {
  if (typeof spec === "string") spec = { id: spec };
  if (spec.url) return { url: spec.url, title: spec.title || "", poster: spec.poster || "" };
  let id = spec.id, title = spec.title || "";
  if (!id && spec.search) {
    const items = await searchNasa(spec.search, "video");
    const must = [].concat(spec.match || spec.search).map(function (s) { return String(s).toLowerCase(); });
    const hit = items.find(function (it) {
      const t = String((it.data && it.data[0] && it.data[0].title) || "").toLowerCase();
      return must.every(function (s) { return t.indexOf(s) !== -1; });
    });
    if (!hit) return null;
    id = hit.data[0].nasa_id; title = title || hit.data[0].title || "";
  }
  if (!id) return null;
  return videoFromId(id, title);
}

// the cache is refreshed when the hand-picked media OR the search words change
function overrideKey(over, m) {
  return JSON.stringify([over.galleryIds || null, over.galleryUrls || null, over.videoSpecs || null, m.nasaQuery || null, m.nasaVideoQuery || null]);
}

async function resolveCustom(over) {
  const custom = { gallery: [], videos: [] };
  for (const id of over.galleryIds || []) {
    try { const u = await resolveImageId(id); if (u) custom.gallery.push(u); else console.warn("[media] no jpg for " + id); }
    catch (e) { console.warn("[media] image " + id + " failed: " + e.message); }
  }
  (over.galleryUrls || []).forEach(function (u) { custom.gallery.push(u); });
  for (const spec of over.videoSpecs || []) {
    let v = null;
    try { v = await resolveVideoSpec(spec); } catch (e) { console.warn("[media] video failed: " + e.message); }
    if (!v) console.warn("[media] video not found: " + JSON.stringify(spec));
    custom.videos.push(v);     // keep nulls so slot numbers still line up
  }
  return custom;
}

// ---------- cache ----------
let mediaCache = readJSON(CACHE_FILE, {});    // { missionId: { images:[], videos:[], custom:{}, overKey, fetchedAt } }
let refreshing = false;
let firstRefresh = Promise.resolve();

async function refreshMedia(force) {
  if (refreshing) return;
  refreshing = true;
  let needRetry = false;
  try {
    const missions = readJSON(MISSIONS_FILE, []);
    const overrides = readJSON(OVERRIDES_FILE, {});
    for (const m of missions) {
      const over = overrides[m.id] || {};
      const key = overrideKey(over, m);
      const cached = mediaCache[m.id];
      const fresh = cached && (Date.now() - cached.fetchedAt < REFRESH_MS) && cached.overKey === key;
      if (fresh && !force) continue;
      try {
        let images = cached ? cached.images : [], videos = cached ? cached.videos : [];
        let autoOk = true;
        try {
          images = await fetchImages(m.nasaQuery);
          videos = await fetchVideos(m.nasaVideoQuery);
        } catch (e) {
          autoOk = false; needRetry = true;       // NASA failed: keep what we have and try again soon
          console.warn("[media] " + m.id + " auto media failed: " + e.message);
        }
        const custom = await resolveCustom(over);
        // fetchedAt = 0 marks a failed fetch as "not fresh", so it is retried instead of waiting 12 hours
        mediaCache[m.id] = { images: images, videos: videos, custom: custom, overKey: key, fetchedAt: autoOk ? Date.now() : 0 };
        try { fs.writeFileSync(CACHE_FILE, JSON.stringify(mediaCache, null, 2)); }
        catch (e) { console.warn("[media] could not write cache file: " + e.message); }
        console.log("[media] " + m.id + ": " + images.length + " images, " + videos.length + " videos, custom " +
          custom.gallery.length + " images / " + custom.videos.filter(Boolean).length + " videos" + (autoOk ? "" : "  (will retry)"));
      } catch (e) {
        needRetry = true;
        console.warn("[media] " + m.id + " failed: " + e.message);   // keep any older cache
      }
    }
  } finally {
    refreshing = false;      // always reset, even if something unexpected threw
  }
  if (needRetry) setTimeout(function () { refreshMedia(false); }, RETRY_MS);
}

// On a cold start (free hosting wipes the disk) there is no cache yet. Wait (up to a limit) until
// EVERY mission has been fetched, so the first visitor gets pictures instead of empty cards.
async function waitForFirstMedia() {
  const total = readJSON(MISSIONS_FILE, []).length;
  if (Object.keys(mediaCache).length >= total) return;
  await Promise.race([firstRefresh, new Promise(function (r) { setTimeout(r, FIRST_LOAD_WAIT_MS); })]);
}

// ---------- short one-line text for the carousel cards ----------
function shortLine(text) {
  const first = String(text || "").split(/(?<=[.!?])\s/)[0];
  return first.length > 90 ? first.slice(0, 87).trim() + "..." : first;
}

function unique(list) {
  return list.filter(function (x, i) { return x && list.indexOf(x) === i; });
}

/* ---------- build the response for one mission ----------
   overrides.json options per mission (all optional):
     image, gallery[], videos[]        full manual replacement with direct links
     galleryIds[], galleryUrls[]       NASA image ids / direct image links
     galleryMode                       "replace" (default) or "add" (keep the automatic images too)
     videoSpecs[]                      NASA ids, title searches or direct mp4 links (see resolveVideoSpec)
     videoMode                         "replace" (default), "add", or "slots"
     videoSlots[]                      with "slots": which video positions (1,2,3) videoSpecs replace, in order
     videoRemove[]                     video positions (1,2,3) to delete, counted after the changes above
     model, modelCredit, sourceUrl, discoveries
*/
function build(m, overrides) {
  const over = (overrides || {})[m.id] || {};
  const cached = mediaCache[m.id] || { images: [], videos: [] };
  const custom = cached.custom || { gallery: [], videos: [] };

  // images
  const autoImages = cached.images.map(function (i) { return i.url; });
  let gallery;
  if (over.gallery && over.gallery.length) gallery = over.gallery;
  else if (custom.gallery.length) gallery = unique(over.galleryMode === "add" ? autoImages.concat(custom.gallery) : custom.gallery);
  else gallery = autoImages;
  const image = over.image || gallery[0] || "";

  // videos
  let videos;
  if (over.videos && over.videos.length) {
    videos = over.videos.map(function (v) { return typeof v === "string" ? { url: v, title: "", poster: "" } : v; });
  } else {
    videos = cached.videos.slice();
    const found = custom.videos.filter(Boolean);
    const mode = over.videoMode || "replace";
    if (mode === "slots") {
      (over.videoSlots || []).forEach(function (slot, i) {
        const v = custom.videos[i];
        if (!v) return;                                   // not found: keep the automatic video
        if (slot - 1 < videos.length) videos[slot - 1] = v; else videos.push(v);
      });
    } else if (mode === "add") {
      videos = videos.concat(found);
    } else if (found.length) {
      videos = found;
    }
    if (over.videoRemove && over.videoRemove.length) {
      videos = videos.filter(function (v, i) { return over.videoRemove.indexOf(i + 1) === -1; });
    }
    videos = videos.filter(Boolean);
  }

  // fall back to the NASA library page of the first image when no sourceUrl is set
  const first = cached.images[0];
  const sourceUrl = over.sourceUrl || m.sourceUrl ||
    (first && first.nasaId ? "https://images.nasa.gov/details/" + encodeURIComponent(first.nasaId) : "");

  const out = Object.assign({}, m, {
    image: image,
    gallery: gallery,
    videos: videos,
    sourceUrl: sourceUrl,
    tagline: m.tagline || shortLine(m.description),
    model: over.model || m.model || "",
    modelCredit: over.modelCredit || m.modelCredit || "",
    discoveries: (over.discoveries && over.discoveries.length) ? over.discoveries : m.discoveries
  });
  delete out.nasaQuery;
  delete out.nasaVideoQuery;
  return out;
}

// ---------- API ----------
const app = express();
app.use(cors());   // lets your HTML page (any origin / file://) call the API
// 3D model files (.glb) in backend/models are served at http://localhost:3000/models/<file>
app.use("/models", express.static(path.join(__dirname, "models")));

app.get("/", function (req, res) {
  res.json({
    name: "Rovelore Chronicles API",
    ok: true,
    try: ["/api/health", "/api/missions", "/api/missions/sojourner"]
  });
});

app.get("/api/health", function (req, res) {
  res.json({ ok: true, mediaReady: Object.keys(mediaCache).length, refreshing: refreshing });
});

// GET /api/missions?destination=Mars&type=Rover&status=Active&media=Images&q=crater
app.get("/api/missions", async function (req, res) {
  await waitForFirstMedia();
  const q = (req.query.q || "").toLowerCase();
  const overrides = readJSON(OVERRIDES_FILE, {});     // read once per request, not once per mission
  let list = readJSON(MISSIONS_FILE, []).map(function (m) { return build(m, overrides); });
  if (req.query.destination && req.query.destination !== "All") list = list.filter(function (m) { return m.destination === req.query.destination; });
  if (req.query.type)   list = list.filter(function (m) { return m.type === req.query.type; });
  if (req.query.status) list = list.filter(function (m) { return m.status === req.query.status; });
  const media = req.query.media;
  if (media === "Images") list = list.filter(function (m) { return m.gallery.length > 0; });
  if (media === "Videos") list = list.filter(function (m) { return m.videos.length > 0; });
  if (media === "Both")   list = list.filter(function (m) { return m.gallery.length > 0 && m.videos.length > 0; });
  if (media === "3D Model") list = list.filter(function (m) { return !!m.model || (m.viewers && m.viewers.length > 0); });
  if (q) list = list.filter(function (m) {
    return [m.name, m.destination, m.type, m.mission, m.year, m.location, m.description, m.status].join(" ").toLowerCase().indexOf(q) !== -1;
  });
  res.json(list);
});

app.get("/api/missions/:id", async function (req, res) {
  await waitForFirstMedia();
  const m = readJSON(MISSIONS_FILE, []).find(function (x) { return x.id === req.params.id; });
  if (!m) return res.status(404).json({ error: "Mission not found" });
  res.json(build(m, readJSON(OVERRIDES_FILE, {})));
});

// Force a media refresh (handy while developing): POST /api/refresh
app.post("/api/refresh", function (req, res) {
  refreshMedia(true);
  res.json({ started: true });
});

app.listen(PORT, function () {
  console.log("Rovelore API running on http://localhost:" + PORT);
  firstRefresh = refreshMedia(false);
  setInterval(function () { refreshMedia(false); }, REFRESH_MS);
});