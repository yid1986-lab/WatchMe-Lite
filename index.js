require("dotenv").config();

const express = require("express");
const { Client, GatewayIntentBits, EmbedBuilder } = require("discord.js");
const { registerCommands } = require("./commands");
const twitch = require("./twitch");
const db = require("./db");

process.on("unhandledRejection", (err) => {
  console.error("unhandledRejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("uncaughtException:", err);
});

const app = express();

app.get("/", (req, res) => res.status(200).send("OK"));

app.use(
  express.json({
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  })
);

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

async function postToGuild(guildId, live) {
  const cfg = db.prepare(`
    SELECT announce_channel_id, fb_enabled
    FROM guild_config
    WHERE guild_id=?
  `).get(guildId);

  if (!cfg?.announce_channel_id) return;

  const channel = await client.channels.fetch(cfg.announce_channel_id).catch(() => null);
  if (!channel) return;

  const embed = new EmbedBuilder()
    .setColor(5793266)
    .setTitle(`${live.channelTitle || "Streamer"} is LIVE on Twitch`)
    .setURL(live.url)
    .setDescription(`🔴 **${live.channelTitle || "Streamer"} is live now!**\n${live.url}`)
    .setTimestamp(new Date());

  if (live.title) {
    embed.addFields({ name: "Title", value: String(live.title).slice(0, 1024) });
  }

  await channel.send({ embeds: [embed] }).catch(() => null);
}

async function boot() {
  const PORT = process.env.PORT || 3000;

  twitch.initTwitchWebhook(app, client, db);

  app.listen(PORT, () => {
    console.log(`Web server listening on ${PORT}`);
  });

  console.log("Twitch webhook route ready");

  if (!process.env.DISCORD_TOKEN) {
    console.error("Missing DISCORD_TOKEN");
    return;
  }

  try {
    await client.login(process.env.DISCORD_TOKEN);
    console.log(`Logged in as ${client.user.tag}`);

    await registerCommands(client);
    console.log("Slash commands registered");
  } catch (err) {
    console.error("Login/register failed:", err);
  }

  try {
    await twitch.getAppToken();
  } catch (err) {
    console.error("getAppToken failed:", err);
  }
}

boot().catch((err) => {
  console.error("Boot error:", err);
});

module.exports = { postToGuild };