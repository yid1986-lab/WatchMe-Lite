const axios = require("axios");
const crypto = require("crypto");
const { EmbedBuilder } = require("discord.js");

let appToken = null;
let appTokenExpiresAt = 0;

const TWITCH_OAUTH = "https://id.twitch.tv/oauth2/token";
const HELIX_BASE = "https://api.twitch.tv/helix";

function nowMs() {
  return Date.now();
}

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing env: ${name}`);
  }
  return value;
}

function buildHeaders() {
  return {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${appToken}`,
    "Content-Type": "application/json",
  };
}

function getCallbackUrl() {
  const callbackBase = requireEnv("PUBLIC_URL").replace(/\/+$/, "");
  return `${callbackBase}/twitch`;
}

function isSubUsable(sub) {
  return ["enabled", "webhook_callback_verification_pending"].includes(sub.status);
}

async function getAppToken() {
  const clientId = requireEnv("TWITCH_CLIENT_ID");
  const clientSecret = requireEnv("TWITCH_CLIENT_SECRET");

  const res = await axios.post(TWITCH_OAUTH, null, {
    params: {
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: "client_credentials",
    },
  });

  appToken = res.data.access_token;
  const expiresIn = Number(res.data.expires_in || 0);
  appTokenExpiresAt = nowMs() + Math.max(0, (expiresIn - 60) * 1000);

  console.log("Fetched Twitch app token");
  return appToken;
}

async function ensureToken() {
  if (!appToken || nowMs() >= appTokenExpiresAt) {
    await getAppToken();
  }
}

function parseTwitchLogin(url) {
  try {
    const u = new URL(url.trim());
    const host = u.hostname.toLowerCase();

    if (!host.includes("twitch.tv")) return null;

    const firstPart = u.pathname.split("/").filter(Boolean)[0];
    if (!firstPart) return null;

    const blocked = new Set(["directory", "downloads", "jobs", "p", "products", "settings"]);
    if (blocked.has(firstPart.toLowerCase())) return null;

    return firstPart.toLowerCase();
  } catch {
    return null;
  }
}

function normalizeTwitchUrl(login) {
  return `https://www.twitch.tv/${String(login || "").trim().toLowerCase()}`;
}

function buildTwitchThumbnailUrl(login) {
  const cleanLogin = String(login || "").trim().toLowerCase();
  return `https://static-cdn.jtvnw.net/previews-ttv/live_user_${cleanLogin}-640x360.jpg`;
}

async function lookupUserIdByLogin(login) {
  await ensureToken();

  const res = await axios.get(`${HELIX_BASE}/users`, {
    headers: buildHeaders(),
    params: { login },
  });

  const user = res.data?.data?.[0];
  if (!user) return null;

  return {
    id: user.id,
    display_name: user.display_name,
    login: user.login,
  };
}

async function getStreamDataByUserId(userId) {
  await ensureToken();

  const res = await axios.get(`${HELIX_BASE}/streams`, {
    headers: buildHeaders(),
    params: { user_id: userId },
  });

  return res.data?.data?.[0] || null;
}

async function listSubscriptions() {
  await ensureToken();

  const res = await axios.get(`${HELIX_BASE}/eventsub/subscriptions`, {
    headers: buildHeaders(),
  });

  return res.data?.data || [];
}

async function deleteSubscription(id) {
  await ensureToken();

  return axios.delete(`${HELIX_BASE}/eventsub/subscriptions`, {
    headers: buildHeaders(),
    params: { id },
  });
}

async function createSubscription(type, broadcasterId) {
  await ensureToken();

  const callback = getCallbackUrl();
  const secret = requireEnv("TWITCH_WEBHOOK_SECRET");

  if (secret.length < 10 || secret.length > 100) {
    throw new Error("TWITCH_WEBHOOK_SECRET must be between 10 and 100 characters");
  }

  return axios.post(
    `${HELIX_BASE}/eventsub/subscriptions`,
    {
      type,
      version: "1",
      condition: { broadcaster_user_id: broadcasterId },
      transport: {
        method: "webhook",
        callback,
        secret,
      },
    },
    { headers: buildHeaders() }
  );
}

async function ensureSubscriptions(broadcasterId) {
  const callback = getCallbackUrl();

  const wanted = [
    { type: "stream.online", version: "1" },
    { type: "stream.offline", version: "1" },
  ];

  let subs = [];

  try {
    subs = await listSubscriptions();
  } catch (err) {
    console.error("EventSub list failed:", err?.response?.data?.message || err?.message || err);

    for (const wantedSub of wanted) {
      try {
        await createSubscription(wantedSub.type, broadcasterId);
        console.log(`Created fallback EventSub ${wantedSub.type} for ${broadcasterId}`);
      } catch (createErr) {
        console.error(
          `EventSub fallback failed ${wantedSub.type} for ${broadcasterId}:`,
          createErr?.response?.data?.message || createErr?.message || createErr
        );
      }
    }

    return;
  }

  for (const wantedSub of wanted) {
    const matches = subs.filter((sub) => {
      const condId = sub.condition?.broadcaster_user_id;
      const cb = sub.transport?.callback;

      return (
        sub.type === wantedSub.type &&
        String(sub.version) === String(wantedSub.version) &&
        String(condId) === String(broadcasterId) &&
        String(cb) === String(callback)
      );
    });

    if (matches.some(isSubUsable)) {
      continue;
    }

    for (const match of matches) {
      try {
        await deleteSubscription(match.id);
      } catch (err) {
        console.error(
          `Failed deleting EventSub ${match.id}:`,
          err?.response?.data?.message || err?.message || err
        );
      }
    }

    try {
      await createSubscription(wantedSub.type, broadcasterId);
      console.log(`Created EventSub ${wantedSub.type} for ${broadcasterId}`);
    } catch (err) {
      console.error(
        `Failed creating EventSub ${wantedSub.type} for ${broadcasterId}:`,
        err?.response?.data?.message || err?.message || err
      );
    }
  }
}

function verifyEventSubSignature(req) {
  const secret = process.env.TWITCH_WEBHOOK_SECRET;
  if (!secret || !req.rawBody) return true;

  const msgId = req.header("Twitch-Eventsub-Message-Id") || "";
  const msgTs = req.header("Twitch-Eventsub-Message-Timestamp") || "";
  const theirSig = req.header("Twitch-Eventsub-Message-Signature") || "";

  const hmac = crypto.createHmac("sha256", secret);
  hmac.update(msgId + msgTs);
  hmac.update(req.rawBody);

  const ourSig = `sha256=${hmac.digest("hex")}`;

  try {
    return crypto.timingSafeEqual(Buffer.from(ourSig), Buffer.from(theirSig));
  } catch {
    return false;
  }
}

async function postToFacebookWithThumbnail(message, thumbnailUrl) {
  const pageId = process.env.FB_PAGE_ID;
  const accessToken = process.env.FB_PAGE_ACCESS_TOKEN;

  if (!pageId || !accessToken) {
    console.warn("Facebook posting skipped: missing FB_PAGE_ID or FB_PAGE_ACCESS_TOKEN");
    return null;
  }

  try {
    const res = await axios.post(
      `https://graph.facebook.com/v25.0/${pageId}/photos`,
      null,
      {
        params: {
          url: thumbnailUrl,
          caption: message,
          access_token: accessToken,
        },
      }
    );

    console.log("Facebook photo post created:", res.data?.post_id || res.data?.id);
    return res.data;
  } catch (err) {
    console.error("Facebook post failed:", err?.response?.data || err?.message || err);
    return null;
  }
}

async function sendLiveAlert(client, db, guildId, broadcasterUserId, broadcasterUserName, broadcasterUserLogin) {
  const cfg = db.prepare(`
    SELECT announce_channel_id, fb_enabled
    FROM guild_config
    WHERE guild_id = ?
  `).get(guildId);

  if (!cfg?.announce_channel_id) return;

  const alreadyPosted = db.prepare(`
    SELECT value
    FROM last_announced
    WHERE guild_id = ? AND platform = 'twitch' AND key = ?
  `).get(guildId, broadcasterUserId);

  if (alreadyPosted?.value === "live") {
    return;
  }

  const channel = await client.channels.fetch(cfg.announce_channel_id).catch(() => null);
  if (!channel) return;

  const twitchUrl = normalizeTwitchUrl(broadcasterUserLogin);
  const thumbnailUrl = buildTwitchThumbnailUrl(broadcasterUserLogin);

  let streamData = null;
  try {
    streamData = await getStreamDataByUserId(broadcasterUserId);
  } catch (err) {
    console.error(
      `Failed fetching stream data for ${broadcasterUserLogin}:`,
      err?.response?.data?.message || err?.message || err
    );
  }

  const streamTitle = streamData?.title?.trim() || "No stream title set";
  const gameName = streamData?.game_name?.trim() || "Unknown";

  const embed = new EmbedBuilder()
    .setColor(5793266)
    .setTitle(`${broadcasterUserName} is LIVE on Twitch`)
    .setURL(twitchUrl)
    .setDescription(`🔴 **${broadcasterUserName} is live now!**\n${twitchUrl}`)
    .addFields(
      { name: "Title", value: String(streamTitle).slice(0, 1024), inline: false },
      { name: "Game", value: String(gameName).slice(0, 1024), inline: true }
    )
    .setImage(thumbnailUrl)
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] }).catch((err) => {
    console.error("Discord send failed:", err?.message || err);
  });

  if (Boolean(cfg.fb_enabled)) {
    const facebookMessage = [
      "🔴 LIVE NOW",
      "",
      `${broadcasterUserName} is now live on Twitch!`,
      `Title: ${streamTitle}`,
      `Game: ${gameName}`,
      twitchUrl,
      "",
      "Powered by WatchMe Lite",
    ].join("\n");

    await postToFacebookWithThumbnail(facebookMessage, thumbnailUrl);
  } else {
    console.log(`Facebook posting disabled for guild ${guildId}`);
  }

  db.prepare(`
    INSERT OR REPLACE INTO last_announced
    (guild_id, platform, key, value, updated_at)
    VALUES (?, 'twitch', ?, ?, ?)
  `).run(guildId, broadcasterUserId, "live", nowMs());

  console.log(`Posted live alert for ${broadcasterUserLogin} in guild ${guildId}`);
}

function clearLiveState(db, guildId, broadcasterUserId) {
  db.prepare(`
    DELETE FROM last_announced
    WHERE guild_id = ? AND platform = 'twitch' AND key = ?
  `).run(guildId, broadcasterUserId);
}

function initTwitchWebhook(app, client, db) {
  app.post("/twitch", async (req, res) => {
    const messageType = req.header("Twitch-Eventsub-Message-Type");
    const subType = req.body?.subscription?.type;

    console.log(`Webhook hit: ${messageType} ${subType || ""}`);

    if (!verifyEventSubSignature(req)) {
      console.warn("Signature verification failed");
      return res.sendStatus(403);
    }

    if (messageType === "webhook_callback_verification") {
      const challenge = req.body?.challenge;
      console.log("Webhook verification OK");
      return res.status(200).send(challenge);
    }

    if (messageType !== "notification") {
      return res.sendStatus(200);
    }

    const ev = req.body?.event;
    if (!subType || !ev) {
      return res.sendStatus(400);
    }

    res.sendStatus(200);

    setImmediate(async () => {
      try {
        const twitchUrl = normalizeTwitchUrl(ev.broadcaster_user_login);

        const rows = db.prepare(`
          SELECT guild_id
          FROM members
          WHERE platform = 'twitch' AND TRIM(LOWER(url)) = TRIM(LOWER(?))
        `).all(twitchUrl);

        if (subType === "stream.online") {
          for (const row of rows) {
            await sendLiveAlert(
              client,
              db,
              row.guild_id,
              ev.broadcaster_user_id,
              ev.broadcaster_user_name,
              ev.broadcaster_user_login
            );
          }
        }

        if (subType === "stream.offline") {
          for (const row of rows) {
            clearLiveState(db, row.guild_id, ev.broadcaster_user_id);
          }

          console.log(`Cleared live state for ${ev.broadcaster_user_login}`);
        }
      } catch (err) {
        console.error(
          "Webhook processing error:",
          err?.response?.data?.message || err?.message || err
        );
      }
    });
  });
}

module.exports = {
  getAppToken,
  parseTwitchLogin,
  lookupUserIdByLogin,
  ensureSubscriptions,
  initTwitchWebhook,
  normalizeTwitchUrl,
};