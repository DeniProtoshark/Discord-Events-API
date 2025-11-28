import express from "express";
import fetch from "node-fetch";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());

const GUILD_ID = process.env.GUILD_ID;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;

// ===== КЭШ =====
const CACHE_TTL_MS = 15_000; // 60 сек
let cachedEvents = null;
let cachedAt = 0;

// ===== ПРОСТЫЕ СТАТКИ (движок интереса) =====
const interests = {}; // { [eventId]: { going: number, interested: number } }

function getStats(id) {
  if (!interests[id]) {
    interests[id] = { going: 0, interested: 0 };
  }
  return interests[id];
}

// ---------- Тип события по хэштегам ----------
function detectType(name, description) {
  const text = `${name}\n${description || ""}`.toUpperCase();

  if (text.includes("#IRL")) return "irl";
  if (text.includes("#VR") || text.includes("#VIRTUAL")) return "virtual";
  if (text.includes("#RADIO")) return "radio";

  return "other";
}

// ---------- Лейблы для ссылок ----------
function labelForUrl(url) {
  try {
    const u = new URL(url);
    const host = u.hostname.toLowerCase();

    if (host.includes("youtube.com") || host.includes("youtu.be")) return "YouTube";
    if (host.includes("twitch.tv")) return "Twitch";
    if (host.includes("spotify.com")) return "Spotify";
    if (host.includes("soundcloud.com")) return "SoundCloud";
    if (host.includes("mixcloud.com")) return "Mixcloud";
    if (host.includes("bandcamp.com")) return "Bandcamp";
    if (host.includes("tiktok.com")) return "TikTok";
    if (host.includes("facebook.com")) return "Facebook";
    if (host.includes("instagram.com")) return "Instagram";

    // твои радио-домены
    if (
      host.includes("hpsbassline.myftp.biz") ||
      host.includes("azura.hpsbassline.myftp.biz") ||
      host.includes("radio")
    ) {
      return "Radio";
    }

    return host.replace(/^www\./, "");
  } catch {
    return "Link";
  }
}

function extractLinksTags(description) {
  if (!description) return { links: [], tags: [] };

  const urlRegex = /(https?:\/\/[^\s]+)/g;
  const links = [];
  const matches = description.match(urlRegex) || [];

  for (const m of matches) {
    links.push({ url: m, label: labelForUrl(m) });
  }

  const tagMatches = [...description.matchAll(/#(\w+)/g)];
  const tags = tagMatches
    .map((m) => m[1].toUpperCase())
    .filter((t) => !["IRL", "VR", "VIRTUAL", "RADIO"].includes(t));

  return { links, tags };
}

// ---------- Статус события ----------
function getStatus(startIso, endIso) {
  if (!startIso) {
    return { code: "upcoming", label: "Upcoming" };
  }

  const now = Date.now();
  const startMs = new Date(startIso).getTime();
  const endMs = endIso ? new Date(endIso).getTime() : startMs + 3 * 3600_000;

  if (now < startMs) {
    return { code: "upcoming", label: "Upcoming" };
  }

  if (now >= startMs && now <= endMs) {
    return { code: "live", label: "Live" };
  }

  return { code: "past", label: "Past" };
}

// ---------- МОК для локальных тестов (если нет токена/ID) ----------
function getMockEvents() {
  const now = Date.now();

  const mock = [
    {
      id: "1",
      name: "Street Session: Downtown Vibes #IRL #DNB",
      description:
        "Open DJ set in the city center.\n#IRL #DNB\nhttps://hpsbassline.myftp.biz/",
      scheduled_start_time: new Date(now + 30 * 60_000).toISOString(),
      scheduled_end_time: new Date(now + 2 * 3600_000).toISOString(),
      entity_metadata: { location: "Haapsalu" },
      image:
        "https://images.pexels.com/photos/1190298/pexels-photo-1190298.jpeg"
    },
    {
      id: "2",
      name: "VR Club Showcase #VR #HARDCORE",
      description:
        "Immersive VR experience.\n#VR #HARDCORE\nhttps://twitch.tv/hps_bassline",
      scheduled_start_time: new Date(now + 3 * 3600_000).toISOString(),
      scheduled_end_time: null,
      entity_metadata: { location: "VRChat" },
      image:
        "https://images.pexels.com/photos/3404200/pexels-photo-3404200.jpeg"
    }
  ];

  return mock.map((e) => {
    const type = detectType(e.name, e.description);
    const stats = getStats(e.id);
    const { links, tags } = extractLinksTags(e.description);
    const status = getStatus(e.scheduled_start_time, e.scheduled_end_time);

    return {
      id: e.id,
      name: e.name,
      description: e.description,
      image: e.image || null,
      start: e.scheduled_start_time,
      end: e.scheduled_end_time,
      type,
      location: e.entity_metadata?.location || null,
      link: "#",
      links,
      tags,
      status,
      stats
    };
  });
}

// ---------- Получить ивенты из Discord + кэш ----------
async function fetchDiscordEvents({ ignoreCache = false } = {}) {
  if (!GUILD_ID || !DISCORD_TOKEN) {
    console.warn("No GUILD_ID or DISCORD_BOT_TOKEN — using mock data");
    return getMockEvents();
  }

  const now = Date.now();

  if (!ignoreCache && cachedEvents && now - cachedAt < CACHE_TTL_MS) {
    return cachedEvents;
  }

  const res = await fetch(
    `https://discord.com/api/v10/guilds/${GUILD_ID}/scheduled-events`,
    {
      headers: { Authorization: `Bot ${DISCORD_TOKEN}` }
    }
  );

  if (res.status === 429) {
    const data = await res.json().catch(() => ({}));
    console.warn("Discord API rate limited:", data);

    if (cachedEvents) {
      console.log("Returning cached events from cache");
      return cachedEvents;
    }

    throw new Error("Rate limited by Discord and no cache available");
  }

  if (!res.ok) {
    console.error("Discord API error:", await res.text());
    throw new Error("Failed to fetch events from Discord");
  }

  const events = await res.json();

  const mapped = events.map((e) => {
    const type = detectType(e.name, e.description);
    const stats = getStats(e.id);
    const { links, tags } = extractLinksTags(e.description || "");
    const status = getStatus(e.scheduled_start_time, e.scheduled_end_time);

    const imageUrl = e.image
      ? `https://cdn.discordapp.com/guild-events/${e.id}/${e.image}.webp?size=1024`
      : null;

    return {
      id: e.id,
      name: e.name,
      description: e.description,
      image: imageUrl,
      start: e.scheduled_start_time,
      end: e.scheduled_end_time,
      type,
      location: e.entity_metadata?.location || null,
      link: `https://discord.com/events/${GUILD_ID}/${e.id}`,
      links,
      tags,
      status,
      stats
    };
  });

  cachedEvents = mapped;
  cachedAt = now;

  return mapped;
}

// ---------- API: только актуальные ивенты (без прошедших) ----------
app.get("/api/events", async (req, res) => {
  try {
    const filterType = (req.query.type || "").toLowerCase();
    const ignoreCache = req.query.force === "1";

    let events = await fetchDiscordEvents({ ignoreCache });

    // фильтр по типу
    if (filterType) {
      events = events.filter((e) => e.type === filterType);
    }

    // ВАЖНО: выкидываем прошедшие
    events = events.filter((e) => e.status.code !== "past");

    res.json(events);
  } catch (err) {
    console.error(err);

    if (cachedEvents) {
      console.log("Returning cached events due to error (filtered past)");
      return res.json(
        cachedEvents.filter((e) => e.status.code !== "past")
      );
    }

    res.status(500).json({ error: "Failed to load events" });
  }
});

// ---------- API: интерес / going ----------
app.post("/api/events/:id/interest", (req, res) => {
  const id = req.params.id;
  const { action } = req.body || {};

  if (action !== "going" && action !== "interested") {
    return res.status(400).json({ error: "Invalid action" });
  }

  const stats = getStats(id);
  stats[action] += 1;

  return res.json(stats);
});

// ---------- Статика для теста (можно удалить, если не нужен демо-фронт) ----------
app.use(express.static("public"));

app.listen(PORT, () => {
  console.log(`Events API running at http://localhost:${PORT}`);
});
