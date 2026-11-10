// Robot Pépite : tourne une fois par jour sur GitHub Actions.
// 1. Cherche sur YouTube les clips hip-hop FR récents.
// 2. Relève les abonnés de chaque chaîne (nouvelles + déjà suivies) et garde un historique.
// 3. Garde les artistes sous le seuil (100 k abonnés) et calcule le score de percée.
// 4. Ajoute les fans Deezer quand le nom correspond.
// 5. Écrit public/radar.json, que l'appli télécharge.

import fs from 'node:fs/promises';
import path from 'node:path';

const ROOT = process.cwd();
const KEY = process.env.YOUTUBE_API_KEY;
const YT = process.env.YT_API_BASE || 'https://www.googleapis.com/youtube/v3';
const DEEZER = process.env.DEEZER_API_BASE || 'https://api.deezer.com';

const config = JSON.parse(await fs.readFile(path.join(ROOT, 'config/settings.json'), 'utf8'));
const THRESHOLD = config.threshold;          // au-delà : sort du radar
const MIN_SUBS = config.minSubscribers;      // en dessous : trop petit / bruit
const MIN_VIEWS = config.minClipViews;       // vues minimum du clip récent
const SEARCH_DAYS = config.searchDays;       // fenêtre de recherche des clips
const MAX_CLIP_AGE = config.maxClipAgeDays;  // au-delà, le clip ne compte plus
const HISTORY_DAYS = config.historyDays;
const TOP_N = config.radarSize;
const PER_SUBGENRE = config.minPerSubgenre;
const MAX_CATALOG = config.maxCatalog;

const DAY = 86400000;
const now = process.env.PEPITE_NOW ? new Date(process.env.PEPITE_NOW) : new Date();
const today = now.toISOString().slice(0, 10);

if (!KEY) {
  console.error('YOUTUBE_API_KEY manquante : ajoute-la dans Settings > Secrets and variables > Actions.');
  process.exit(1);
}

// ---------- outils ----------
let quota = 0;
async function yt(endpoint, params, cost) {
  const url = new URL(`${YT}/${endpoint}`);
  for (const [k, v] of Object.entries({ ...params, key: KEY })) {
    if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url);
  const json = await res.json().catch(() => ({}));
  quota += cost;
  if (!res.ok || json.error) {
    const msg = json?.error?.message || `HTTP ${res.status}`;
    throw new Error(`YouTube ${endpoint} : ${msg}`);
  }
  return json;
}

function chunks(arr, n) {
  const out = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

function norm(s) {
  return String(s || '')
    .toLowerCase()
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function hasWord(text, words) {
  const t = ` ${norm(text)} `;
  return words.some((w) => t.includes(` ${norm(w)} `));
}

function cleanArtistName(name) {
  return String(name || '')
    .replace(/\s*-\s*topic$/i, '')
    .replace(/\b(official|officiel|officielle|offical|music|musique|tv|vevo)\b/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

function daysBetween(a, b) {
  return Math.max(0, (new Date(b) - new Date(a)) / DAY);
}

function detectSubgenre(text) {
  for (const sg of config.subgenres) {
    if (sg.words.length && hasWord(text, sg.words)) return sg.name;
  }
  return config.defaultSubgenre;
}

function isExcludedChannel(id, title) {
  return config.exclude.channelIds.includes(id) || hasWord(title, config.exclude.channelWords);
}

function isExcludedVideo(title) {
  return hasWord(title, config.exclude.videoWords);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. historique ----------
const historyPath = path.join(ROOT, 'data/history.json');
const history = JSON.parse(await fs.readFile(historyPath, 'utf8'));
history.channels = history.channels || {};

// ---------- 2. recherche des clips récents ----------
const publishedAfter = new Date(now.getTime() - SEARCH_DAYS * DAY).toISOString();
const foundVideoIds = new Set();
for (const q of config.queries) {
  let pageToken;
  for (let page = 0; page < config.pagesPerQuery; page++) {
    const r = await yt('search', {
      part: 'snippet', type: 'video', q, regionCode: 'FR', relevanceLanguage: 'fr',
      videoCategoryId: 10, publishedAfter, order: 'viewCount', maxResults: 50, pageToken
    }, 100);
    for (const it of r.items || []) {
      if (it?.id?.videoId && !isExcludedVideo(it.snippet?.title)) foundVideoIds.add(it.id.videoId);
    }
    pageToken = r.nextPageToken;
    if (!pageToken) break;
  }
}
console.log(`Clips trouvés : ${foundVideoIds.size}`);

// Clips déjà suivis : on rafraîchit leurs vues aussi.
const trackedVideoIds = new Set(
  Object.values(history.channels).map((c) => c.lastVideo?.id).filter(Boolean)
);
const allVideoIds = [...new Set([...foundVideoIds, ...trackedVideoIds])];

const videos = {};
for (const ids of chunks(allVideoIds, 50)) {
  const r = await yt('videos', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 }, 1);
  for (const v of r.items || []) {
    videos[v.id] = {
      id: v.id,
      channelId: v.snippet.channelId,
      title: v.snippet.title,
      text: `${v.snippet.title} ${v.snippet.description || ''} ${(v.snippet.tags || []).join(' ')}`,
      views: Number(v.statistics?.viewCount || 0),
      publishedAt: v.snippet.publishedAt
    };
  }
}

// Meilleur clip récent trouvé aujourd'hui pour chaque chaîne.
const bestNewVideo = {};
for (const id of foundVideoIds) {
  const v = videos[id];
  if (!v) continue;
  const speed = v.views / Math.max(1, daysBetween(v.publishedAt, now));
  const prev = bestNewVideo[v.channelId];
  if (!prev || speed > prev.speed) bestNewVideo[v.channelId] = { ...v, speed };
}

// ---------- 3. abonnés des chaînes ----------
const channelIds = [...new Set([...Object.keys(bestNewVideo), ...Object.keys(history.channels)])];
for (const ids of chunks(channelIds, 50)) {
  const r = await yt('channels', { part: 'snippet,statistics', id: ids.join(','), maxResults: 50 }, 1);
  for (const c of r.items || []) {
    const title = c.snippet?.title || '';
    if (isExcludedChannel(c.id, title)) { delete history.channels[c.id]; continue; }
    if (c.statistics?.hiddenSubscriberCount) continue;
    const subs = Number(c.statistics?.subscriberCount || 0);
    const entry = history.channels[c.id] || { firstSeen: today, points: [] };
    entry.name = cleanArtistName(title) || title;
    entry.handle = c.snippet?.customUrl || null;
    entry.thumb = c.snippet?.thumbnails?.medium?.url || c.snippet?.thumbnails?.default?.url || null;
    entry.subs = subs;
    entry.points = entry.points.filter((p) => p[0] !== today);
    entry.points.push([today, subs]);
    entry.points = entry.points.filter((p) => daysBetween(p[0], now) <= HISTORY_DAYS);

    const fresh = bestNewVideo[c.id];
    const old = entry.lastVideo && videos[entry.lastVideo.id];
    if (fresh) {
      const oldSpeed = old ? old.views / Math.max(1, daysBetween(old.publishedAt, now)) : -1;
      const pick = !old || fresh.speed >= oldSpeed || daysBetween(old.publishedAt, now) > MAX_CLIP_AGE ? fresh : old;
      entry.lastVideo = { id: pick.id, title: pick.title, views: pick.views, publishedAt: pick.publishedAt };
      entry.subgenre = detectSubgenre(pick.text);
      entry.lastSeenInSearch = today;
    } else if (old) {
      entry.lastVideo = { id: old.id, title: old.title, views: old.views, publishedAt: old.publishedAt };
    }
    if (!entry.subgenre) entry.subgenre = config.defaultSubgenre;
    history.channels[c.id] = entry;
  }
}

// Ménage : on oublie les petites chaînes plus vues depuis longtemps,
// mais on garde celles qui ont dépassé le seuil (elles peuvent être des pépites).
for (const [id, c] of Object.entries(history.channels)) {
  const stale = !c.lastSeenInSearch || daysBetween(c.lastSeenInSearch, now) > config.forgetAfterDays;
  if (stale && (c.subs || 0) < THRESHOLD) delete history.channels[id];
}

// ---------- 4. score de percée ----------
function subsDaysAgo(points, days) {
  const target = now.getTime() - days * DAY;
  let best = null;
  for (const [d, s] of points) {
    if (new Date(d).getTime() <= target + DAY / 2) best = [d, s];
  }
  return best;
}

const candidates = [];
for (const [id, c] of Object.entries(history.channels)) {
  const v = c.lastVideo;
  if (!v) continue;
  if (c.subs < MIN_SUBS || c.subs >= THRESHOLD) continue;
  const age = daysBetween(v.publishedAt, now);
  if (age > MAX_CLIP_AGE || v.views < MIN_VIEWS) continue;
  const speed = v.views / Math.max(1, age);
  const ratio = speed / Math.max(200, c.subs);
  const old = subsDaysAgo(c.points, 7);
  const growth7 = old && old[1] > 0 ? (c.subs - old[1]) / Math.max(100, old[1]) : null;
  candidates.push({ id, c, age, speed, ratio, growth7, delta7: old ? c.subs - old[1] : null });
}

function percentiles(list, key) {
  const vals = list.filter((x) => x[key] !== null).map((x) => x[key]).sort((a, b) => a - b);
  return (v) => {
    if (v === null || vals.length < 2) return null;
    let lo = 0;
    while (lo < vals.length && vals[lo] <= v) lo++;
    return (lo - 1) / (vals.length - 1);
  };
}
const pRatio = percentiles(candidates, 'ratio');
const pGrowth = percentiles(candidates, 'growth7');
for (const x of candidates) {
  const r = pRatio(x.ratio) ?? 1;
  const g = pGrowth(x.growth7);
  x.score = Math.round(100 * (g === null ? r : 0.55 * g + 0.45 * r));
}
candidates.sort((a, b) => b.score - a.score || b.ratio - a.ratio);

const picked = new Set(candidates.slice(0, TOP_N).map((x) => x.id));
for (const sg of [...config.subgenres.map((s) => s.name), config.defaultSubgenre]) {
  candidates.filter((x) => x.c.subgenre === sg).slice(0, PER_SUBGENRE).forEach((x) => picked.add(x.id));
}
const radar = candidates.filter((x) => picked.has(x.id));

// ---------- 5. fans Deezer ----------
async function deezerFor(name) {
  try {
    const res = await fetch(`${DEEZER}/search/artist?q=${encodeURIComponent(name)}&limit=5`);
    if (!res.ok) return null;
    const j = await res.json();
    const hit = (j.data || []).find((a) => norm(a.name) === norm(name));
    return hit ? { id: hit.id, fans: hit.nb_fan, link: hit.link } : null;
  } catch {
    return null;
  }
}
for (const x of radar) {
  const c = x.c;
  const fresh = c.deezer && c.deezer.checked && daysBetween(c.deezer.checked, now) < 3;
  if (!fresh) {
    const d = await deezerFor(c.name);
    c.deezer = { ...(d || {}), found: !!d, checked: today };
    await sleep(150);
  }
}

// ---------- 6. écriture ----------
const radarIds = new Set(radar.map((x) => x.id));
const out = {
  version: 1,
  updatedAt: now.toISOString(),
  threshold: THRESHOLD,
  genres: {
    'Hip-hop': {
      subgenres: [config.defaultSubgenre, ...config.subgenres.map((s) => s.name)],
      artists: radar.map((x, i) => ({
        id: x.id,
        rank: i + 1,
        name: x.c.name,
        handle: x.c.handle,
        thumb: x.c.thumb,
        subs: x.c.subs,
        subgenre: x.c.subgenre,
        score: x.score,
        growth7: x.growth7 === null ? null : Math.round(x.growth7 * 1000) / 10,
        delta7: x.delta7,
        video: {
          id: x.c.lastVideo.id,
          title: x.c.lastVideo.title,
          views: x.c.lastVideo.views,
          publishedAt: x.c.lastVideo.publishedAt,
          ageDays: Math.round(x.age)
        },
        deezer: x.c.deezer?.found ? { fans: x.c.deezer.fans, link: x.c.deezer.link } : null,
        history: x.c.points.slice(-30)
      }))
    }
  },
  catalog: Object.entries(history.channels)
    .sort((a, b) => (b[1].subs || 0) - (a[1].subs || 0))
    .slice(0, MAX_CATALOG)
    .map(([id, c]) => ({
      id,
      n: c.name,
      s: c.subs,
      t: c.thumb,
      g: c.subgenre,
      st: radarIds.has(id) ? 'radar' : c.subs >= THRESHOLD ? 'big' : 'small'
    }))
};

await fs.mkdir(path.join(ROOT, 'public'), { recursive: true });
await fs.writeFile(path.join(ROOT, 'public/radar.json'), JSON.stringify(out));
await fs.writeFile(historyPath, JSON.stringify(history));
console.log(`Radar : ${radar.length} artistes · catalogue : ${out.catalog.length} chaînes · quota utilisé ≈ ${quota} / 10 000`);
