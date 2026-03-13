const {
  SlashCommandBuilder,
  PermissionFlagsBits,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  EmbedBuilder,
} = require("discord.js");

const db = require("./db");
const twitch = require("./twitch");

const MAX_CREATORS = 5;

function isManager(interaction) {
  return interaction.memberPermissions?.has(PermissionFlagsBits.ManageGuild);
}

function getGuildConfig(guildId) {
  const row = db.prepare(`
    SELECT guild_id, announce_channel_id, fb_enabled
    FROM guild_config
    WHERE guild_id = ?
  `).get(guildId);

  if (!row) return null;

  return {
    ...row,
    fb_enabled: Boolean(row.fb_enabled),
  };
}

function getCreators(guildId) {
  return db.prepare(`
    SELECT id, url, external_id
    FROM members
    WHERE guild_id = ? AND platform = 'twitch'
    ORDER BY url
  `).all(guildId);
}

function ensureGuildConfigRow(guildId) {
  db.prepare(`
    INSERT INTO guild_config (guild_id, announce_channel_id, fb_enabled)
    VALUES (?, '', 0)
    ON CONFLICT(guild_id) DO NOTHING
  `).run(guildId);
}

function setAlertChannel(guildId, channelId) {
  db.prepare(`
    INSERT INTO guild_config (guild_id, announce_channel_id, fb_enabled)
    VALUES (?, ?, 0)
    ON CONFLICT(guild_id)
    DO UPDATE SET announce_channel_id = excluded.announce_channel_id
  `).run(guildId, channelId);
}

function setFacebookEnabled(guildId, enabled) {
  ensureGuildConfigRow(guildId);

  db.prepare(`
    UPDATE guild_config
    SET fb_enabled = ?
    WHERE guild_id = ?
  `).run(enabled ? 1 : 0, guildId);
}

function toggleFacebookEnabled(guildId) {
  const cfg = getGuildConfig(guildId);

  if (!cfg) {
    ensureGuildConfigRow(guildId);
    setFacebookEnabled(guildId, true);
    return true;
  }

  const nextValue = !cfg.fb_enabled;
  setFacebookEnabled(guildId, nextValue);
  return nextValue;
}

function buildPanelEmbed(guildId) {
  const cfg = getGuildConfig(guildId);
  const creators = getCreators(guildId);

  const channelText = cfg?.announce_channel_id
    ? `<#${cfg.announce_channel_id}>`
    : "`Not set`";

  const fbStatus = cfg?.fb_enabled ? "Enabled ✅" : "Disabled ❌";

  const creatorLines = creators.length
    ? creators.map((row, index) => `${index + 1}. ${row.url}`).join("\n")
    : "No creators saved.";

  return new EmbedBuilder()
    .setColor(5793266)
    .setTitle("WatchMe Lite Control Panel")
    .setDescription("Manage Twitch alerts for this server.")
    .addFields(
      { name: "Alert Channel", value: channelText, inline: false },
      { name: "Facebook Posting", value: fbStatus, inline: false },
      { name: "Creators", value: `${creators.length}/${MAX_CREATORS}`, inline: true },
      { name: "Saved Twitch Creators", value: creatorLines.slice(0, 1024), inline: false }
    )
    .setTimestamp(new Date());
}

function buildPanelComponents(guildId) {
  const creators = getCreators(guildId);
  const cfg = getGuildConfig(guildId);
  const fbEnabled = Boolean(cfg?.fb_enabled);

  return [
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("wme:add_channel")
        .setLabel("Add Channel")
        .setStyle(ButtonStyle.Primary),

      new ButtonBuilder()
        .setCustomId("wme:add_creator")
        .setLabel("Add Creator")
        .setStyle(ButtonStyle.Success),

      new ButtonBuilder()
        .setCustomId("wme:remove_creator")
        .setLabel("Remove Creator")
        .setStyle(ButtonStyle.Danger)
        .setDisabled(creators.length === 0),

      new ButtonBuilder()
        .setCustomId("wme:test_channel")
        .setLabel("Test Channel")
        .setStyle(ButtonStyle.Secondary),

      new ButtonBuilder()
        .setCustomId("wme:toggle_fb")
        .setLabel(fbEnabled ? "FB Post: ON" : "FB Post: OFF")
        .setStyle(fbEnabled ? ButtonStyle.Success : ButtonStyle.Secondary)
    ),
    new ActionRowBuilder().addComponents(
      new ButtonBuilder()
        .setCustomId("wme:refresh")
        .setLabel("Refresh")
        .setStyle(ButtonStyle.Secondary)
    ),
  ];
}

function buildRemoveMenu(guildId) {
  const creators = getCreators(guildId);

  const options = creators.slice(0, 25).map((row) => ({
    label: row.url.replace("https://www.twitch.tv/", "").slice(0, 100),
    description: row.url.slice(0, 100),
    value: String(row.id),
  }));

  const menu = new StringSelectMenuBuilder()
    .setCustomId("wme:remove_select")
    .setPlaceholder("Choose a creator to remove")
    .addOptions(options);

  return new ActionRowBuilder().addComponents(menu);
}

async function safeReply(interaction, payload) {
  if (interaction.deferred || interaction.replied) {
    return interaction.editReply(payload).catch(() => null);
  }
  return interaction.reply(payload).catch(() => null);
}

async function sendPanel(interaction) {
  const guildId = interaction.guildId;

  if (!guildId) {
    return safeReply(interaction, {
      content: "❌ This command can only be used inside a server.",
      ephemeral: true,
    });
  }

  return safeReply(interaction, {
    embeds: [buildPanelEmbed(guildId)],
    components: buildPanelComponents(guildId),
    ephemeral: true,
  });
}

async function addCreator(guildId, urlRaw) {
  const cfg = getGuildConfig(guildId);

  if (!cfg?.announce_channel_id) {
    return {
      ok: false,
      message: "❌ Set an alert channel first.",
    };
  }

  const countRow = db.prepare(`
    SELECT COUNT(*) AS total
    FROM members
    WHERE guild_id = ? AND platform = 'twitch'
  `).get(guildId);

  if ((countRow?.total || 0) >= MAX_CREATORS) {
    return {
      ok: false,
      message: `❌ This Lite version supports only ${MAX_CREATORS} Twitch creators per server.`,
    };
  }

  const login = twitch.parseTwitchLogin((urlRaw || "").trim());

  if (!login) {
    return { ok: false, message: "❌ Bad Twitch URL." };
  }

  const user = await twitch.lookupUserIdByLogin(login);

  if (!user) {
    return { ok: false, message: "❌ Twitch user not found." };
  }

  const normalized = `https://www.twitch.tv/${String(user.login).toLowerCase()}`;

  try {
    db.prepare(`
      INSERT INTO members (guild_id, platform, url, external_id, added_at)
      VALUES (?, 'twitch', ?, ?, ?)
    `).run(guildId, normalized, user.id, Date.now());

    await twitch.ensureSubscriptions(user.id);

    return {
      ok: true,
      message: `✅ Added Twitch creator: ${normalized}`,
    };
  } catch {
    return {
      ok: false,
      message: "ℹ️ That Twitch creator is already saved.",
    };
  }
}

function removeCreatorById(guildId, memberId) {
  const row = db.prepare(`
    SELECT id, url
    FROM members
    WHERE id = ? AND guild_id = ? AND platform = 'twitch'
  `).get(memberId, guildId);

  if (!row) {
    return {
      ok: false,
      message: "ℹ️ That creator no longer exists.",
    };
  }

  db.prepare(`
    DELETE FROM members
    WHERE id = ? AND guild_id = ? AND platform = 'twitch'
  `).run(memberId, guildId);

  return {
    ok: true,
    message: `✅ Removed Twitch creator: ${row.url}`,
  };
}

async function sendTestAlert(client, guildId) {
  const cfg = getGuildConfig(guildId);

  if (!cfg?.announce_channel_id) {
    return {
      ok: false,
      message: "❌ Set an alert channel first.",
    };
  }

  const channel = await client.channels.fetch(cfg.announce_channel_id).catch(() => null);

  if (!channel) {
    return {
      ok: false,
      message: "❌ I could not access the configured alert channel.",
    };
  }

  const embed = new EmbedBuilder()
    .setColor(5793266)
    .setTitle("Test Live Alert")
    .setURL("https://www.twitch.tv/watchme")
    .setDescription("🔴 **WatchMe test alert**\nThis is how a Twitch live alert will look.")
    .addFields(
      { name: "Title", value: "Test stream title" },
      { name: "Game", value: "Just Chatting" }
    )
    .setTimestamp(new Date());

  await channel.send({ embeds: [embed] });

  return {
    ok: true,
    message: `✅ Test alert sent to <#${cfg.announce_channel_id}>`,
  };
}

function buildCommands() {
  return [
    new SlashCommandBuilder()
      .setName("wme")
      .setDescription("Open the WatchMe Lite control panel")
      .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),
  ].map((command) => command.toJSON());
}

async function syncCommands(client) {
  const commands = buildCommands();
  await client.application.commands.set(commands);
  console.log("WME command synced");
}

async function handleChatInput(interaction) {
  if (interaction.commandName !== "wme") return;

  if (!isManager(interaction)) {
    return safeReply(interaction, {
      content: "❌ You need Manage Server to use this.",
      ephemeral: true,
    });
  }

  return sendPanel(interaction);
}

async function handleButton(interaction, client) {
  if (!isManager(interaction)) {
    return safeReply(interaction, {
      content: "❌ You need Manage Server to use this.",
      ephemeral: true,
    });
  }

  const guildId = interaction.guildId;

  if (!guildId) {
    return safeReply(interaction, {
      content: "❌ This can only be used inside a server.",
      ephemeral: true,
    });
  }

  if (interaction.customId === "wme:add_channel") {
    const modal = new ModalBuilder()
      .setCustomId("wme:add_channel_modal")
      .setTitle("Set Alert Channel");

    const channelInput = new TextInputBuilder()
      .setCustomId("channel_id")
      .setLabel("Channel ID")
      .setPlaceholder("Paste the Discord channel ID")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(channelInput));
    return interaction.showModal(modal);
  }

  if (interaction.customId === "wme:add_creator") {
    const modal = new ModalBuilder()
      .setCustomId("wme:add_creator_modal")
      .setTitle("Add Twitch Creator");

    const urlInput = new TextInputBuilder()
      .setCustomId("url")
      .setLabel("Twitch URL")
      .setPlaceholder("https://twitch.tv/streamername")
      .setStyle(TextInputStyle.Short)
      .setRequired(true);

    modal.addComponents(new ActionRowBuilder().addComponents(urlInput));
    return interaction.showModal(modal);
  }

  if (interaction.customId === "wme:remove_creator") {
    const creators = getCreators(guildId);

    if (!creators.length) {
      return safeReply(interaction, {
        content: "ℹ️ There are no saved creators to remove.",
        ephemeral: true,
      });
    }

    return safeReply(interaction, {
      content: "Choose a creator to remove:",
      components: [buildRemoveMenu(guildId)],
      ephemeral: true,
    });
  }

  if (interaction.customId === "wme:test_channel") {
    await interaction.deferReply({ ephemeral: true });

    const result = await sendTestAlert(client, guildId);

    return safeReply(interaction, {
      content: result.message,
      ephemeral: true,
    });
  }

  if (interaction.customId === "wme:toggle_fb") {
    const enabled = toggleFacebookEnabled(guildId);

    return interaction.update({
      content: `Facebook posting is now ${enabled ? "enabled ✅" : "disabled ❌"}.`,
      embeds: [buildPanelEmbed(guildId)],
      components: buildPanelComponents(guildId),
    });
  }

  if (interaction.customId === "wme:refresh") {
    return interaction.update({
      embeds: [buildPanelEmbed(guildId)],
      components: buildPanelComponents(guildId),
    });
  }
}

async function handleSelectMenu(interaction) {
  if (!isManager(interaction)) {
    return safeReply(interaction, {
      content: "❌ You need Manage Server to use this.",
      ephemeral: true,
    });
  }

  if (interaction.customId !== "wme:remove_select") {
    return;
  }

  const guildId = interaction.guildId;
  const selectedId = Number(interaction.values?.[0]);
  const result = removeCreatorById(guildId, selectedId);

  return interaction.update({
    content: result.message,
    embeds: [],
    components: [],
  });
}

async function handleModal(interaction) {
  if (!isManager(interaction)) {
    return safeReply(interaction, {
      content: "❌ You need Manage Server to use this.",
      ephemeral: true,
    });
  }

  if (interaction.customId === "wme:add_channel_modal") {
    const guildId = interaction.guildId;
    const channelId = interaction.fields.getTextInputValue("channel_id").trim();

    setAlertChannel(guildId, channelId);

    return safeReply(interaction, {
      content: `✅ Alert channel set to <#${channelId}>`,
      ephemeral: true,
    });
  }

  if (interaction.customId === "wme:add_creator_modal") {
    await interaction.deferReply({ ephemeral: true });

    const guildId = interaction.guildId;
    const url = interaction.fields.getTextInputValue("url");
    const result = await addCreator(guildId, url);

    return safeReply(interaction, {
      content: result.message,
      ephemeral: true,
    });
  }
}

async function registerCommands(client) {
  await syncCommands(client);

  if (client.__wmeInteractionHandlerAttached) {
    return;
  }

  client.__wmeInteractionHandlerAttached = true;

  client.on("interactionCreate", async (interaction) => {
    try {
      if (interaction.isChatInputCommand()) {
        return await handleChatInput(interaction);
      }

      if (interaction.isButton()) {
        return await handleButton(interaction, client);
      }

      if (interaction.isStringSelectMenu()) {
        return await handleSelectMenu(interaction);
      }

      if (interaction.isModalSubmit()) {
        return await handleModal(interaction);
      }
    } catch (err) {
      console.error("Interaction error:", err);

      const message = err?.message
        ? `❌ Error: ${err.message}`
        : "❌ Error: Unknown error";

      if (interaction.deferred || interaction.replied) {
        return interaction.editReply(message).catch(() => null);
      }

      return interaction.reply({
        content: message,
        ephemeral: true,
      }).catch(() => null);
    }
  });
}

module.exports = { registerCommands };