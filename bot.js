const {
  Client, GatewayIntentBits, EmbedBuilder,
  ActionRowBuilder, ButtonBuilder, ButtonStyle,
  PermissionsBitField, Events,
} = require('discord.js');
const http = require('http');

// ─── RAILWAY KEEP-ALIVE ──────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => { res.writeHead(200); res.end('Bot is alive ✅'); })
  .listen(PORT, () => console.log(`🌐 Keep-alive on port ${PORT}`));

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.GuildInvites,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ─── CONFIG ──────────────────────────────────────────────────────────────────
const CONFIG = {
  TOKEN:                process.env.DISCORD_TOKEN,
  WELCOME_CHANNEL_ID:   process.env.WELCOME_CHANNEL_ID,
  EVENT_CHANNEL_ID:     process.env.EVENT_CHANNEL_ID,
  EVENT_BANNER_URL:     process.env.EVENT_BANNER_URL ?? null,
  ADMIN_ROLE_ID:        process.env.ADMIN_ROLE_ID ?? null,
  PREFIX:               '!',
  SWEEP_LINK_THRESHOLD: 1000,
  SWEEP_AMOUNT:         100,
  SWEEP_MIN_USES:       3,
};

if (!CONFIG.TOKEN) { console.error('❌ DISCORD_TOKEN missing.'); process.exit(1); }

// ─── RUNTIME SETTINGS ────────────────────────────────────────────────────────
const settings = {
  welcomeChannelId: CONFIG.WELCOME_CHANNEL_ID,
  welcomeMessage:   null,
  rulesChannelId:   null,
  generalChannelId: null,
  welcomeColor:     0xFFD700,
  welcomeBanner:    null,
  eventChannelId:   CONFIG.EVENT_CHANNEL_ID,
  logChannelId:     null,
};

// ─── INVITE TRACKING ─────────────────────────────────────────────────────────
const inviteCache  = new Map();
const inviterStats = new Map();
const lastSweepAt  = new Map();

function trackInviter(guildId, userId) {
  if (!inviterStats.has(guildId)) inviterStats.set(guildId, new Map());
  const m = inviterStats.get(guildId);
  m.set(userId, (m.get(userId) ?? 0) + 1);
}

// ─── LOG BUFFER ───────────────────────────────────────────────────────────────
const logBuffer = [];
function addLog(type, description) {
  logBuffer.push({ time: Date.now(), type, description });
  if (logBuffer.length > 50) logBuffer.shift();
}

// ─── SEND TO LOG CHANNEL ─────────────────────────────────────────────────────
async function sendLog(guild, content) {
  if (!settings.logChannelId) return;
  const ch = guild.channels.cache.get(settings.logChannelId);
  if (!ch) return;
  if (typeof content === 'string') {
    await ch.send(content).catch(console.error);
  } else {
    await ch.send({ embeds: [content] }).catch(console.error);
  }
}

// ─── PERMISSION CHECK ─────────────────────────────────────────────────────────
function memberIsAdmin(member) {
  if (member.permissions.has(PermissionsBitField.Flags.Administrator)) return true;
  if (CONFIG.ADMIN_ROLE_ID && member.roles.cache.has(CONFIG.ADMIN_ROLE_ID)) return true;
  return false;
}

// ─── WIZARD STATE ────────────────────────────────────────────────────────────
const wizards = new Map();

const WELCOME_STEPS = [
  {
    key: 'welcomeChannelId', label: 'Welcome Channel',
    prompt:
      '📌 **Step 1/3 — Welcome Channel**\n' +
      'Mention or paste the channel ID where join messages should appear.',
    parse: v => v.replace(/[<#>]/g, '').trim(),
  },
  {
    key: 'welcomeMessage', label: 'Welcome Message',
    prompt:
      '✏️ **Step 2/3 — Welcome Message**\n' +
      'Type the custom text to include in the welcome message.\n' +
      'You can use `{user}` to mention the new member and `{server}` for the server name.\n' +
      'Type `skip` to use the default message.',
    parse: v => v.toLowerCase() === 'skip' ? null : v.trim(),
    optional: true,
  },
  {
    key: '_preview', label: 'Confirm',
    prompt: '👀 **Step 3/3 — Confirm**\nReply `confirm` to save or `cancel` to discard.',
    parse: v => v.trim().toLowerCase(),
    isConfirm: true,
  },
];

const EVENT_STEPS = [
  {
    key: 'eventChannelId', label: 'Event Channel',
    prompt: '📌 **Step 1/2 — Event Channel**\nMention or paste the channel ID to post the event in.',
    parse: v => v.replace(/[<#>]/g, '').trim(),
  },
  {
    key: '_preview', label: 'Confirm',
    prompt: '👀 **Step 2/2 — Ready!**\nReply `confirm` to post the event or `cancel` to exit.',
    parse: v => v.trim().toLowerCase(),
    isConfirm: true,
  },
];

// ─── WELCOME MESSAGE BUILDER (plain text, Apollo-style) ───────────────────────
function buildWelcomeText(member, data, guild, inviterLine) {
  const defaultMsg =
    `📜 Start by reading the rules, then dive into events & giveaways!`;

  let customText = data.welcomeMessage ?? defaultMsg;
  customText = customText
    .replace(/\{user\}/gi, member.toString())
    .replace(/\{server\}/gi, guild.name);

  const lines = [
    customText,
    ``,
    inviterLine ?? null,
  ].filter(l => l !== null);

  return lines.join('\n');
}

// ─── EVENT — COMPONENTS ──────────────────────────────────────────────────────
async function postEventComponents(channel) {
  const innerComponents = [
    {
      type: 10,
      content: '<:buddha:1487034693651267664> Summer BloxFruit Event — **Event Rewards**',
    },
  ];

  if (CONFIG.EVENT_BANNER_URL) {
    innerComponents.push({
      type: 12,
      items: [{ media: { url: CONFIG.EVENT_BANNER_URL } }],
    });
  }

  innerComponents.push(
    { type: 14, divider: true, spacing: 1 },
    {
      type: 10,
      content:
        "<a:announce:1487055874521567272> To celebrate the games activity, we've launched an **OFFICIAL EVENT** where you can earn __FREE__ Permanent fruits & Robux!\n" +
        '<a:flowignsand:1487055896243736658> This is a `limited-time` event and comes to an end <t:1775637000:R> ( <t:1775637000:f> ), so be sure to not miss this opportunity! <a:RobuxANIM:1487057805528666285>',
    },
    { type: 14, divider: true, spacing: 2 },
    {
      type: 10,
      content:
        '<:1442164148908851220:1487058441800519680> **__ EVENT REWARDS:__** <:1442164148908851220:1487058441800519680>\n' +
        '> <:e_fc7201_0280:1487162459805716581> <@&1487126325536886914> <:e_fc7201_8100:1487165177009934346> **Permanent Yeti** <:Yeti:1487166315729780836> / **2,500 Robux** <:e_fc7201_3444:1487166961212330205>\n' +
        '> <:e_f5e50c_6532:1487162569901736037> <@&1487126326749040893> <:e_f5e50c_7750:1487165218298663014> **Permanent Kitsune** <:KitsuneFruit:1487360333952847994> / **5,000 Robux** <:e_f5e50c_8142:1487167022658879520>\n' +
        '> <:e_f8a047_1847:1487164857517342750> <@&1487126328279830710> <:e_f8a047_8717:1487165262863274045> **Permanent Dragon** <:dragon:1487360358409699519> / **7,500 Robux** <:e_f8a047_8533:1487167066057474069>\n' +
        '> <:e_faec69_9471:1487164889213567097> <@&1487126329294983294> <:e_faec69_2107:1487165319389778223> **All Permanent Fruits** <:perm:1487360384552796194> / **10,000 Robux** <:e_faec69_1777:1487167121661104199>',
    },
    { type: 14 },
    {
      type: 10,
      content:
        '<:n1:1491814377538584687><:n2:1491814412770742383><:n3:1491814454999126096><:n4:1491814492613378149><:nrw1:1491815034534367342><:nrw2:1491815068780990525><:rw1:1491811912751517706><:rw2:1491811951788032140><:rw3:1491811989465468989><:rw4:1491812028262907955><:rw5:1491812468803244072><:rw6:1491812512457560174><:rw7:1491812555180609689><:rw8:1491812856948064306><:rw9:1491812898295779560>\n' +
        "<:Easter_egg:1491500838483656880> <:arrow:1491804732312785038> Inviting alternative accounts to the event is strictly __prohibited__. <:hammer:1491820102620938271>\n" +
        "<:Easter_egg:1491500838483656880> <:arrow:1491804732312785038> Failure to follow [Discord's Terms of Service](https://discord.com/terms) and [Roblox Community Guidelines](https://en.help.roblox.com/hc/en-us/articles/115004647846-Roblox-Terms-of-Use) may result in removal from the event.\n\n" +
        "<:pin:1491702917856624670> Once you're completed your invites, contact an <@&1479764099607953532> to redeem! <a:SR_Verified:1491825771373920316>",
    },
    { type: 14 },
        {
          type: 1, style: 5,
          label: 'How to invite?',
          url: 'https://discord.com/channels/1175058945073741895/1487126344440615023',
          emoji: { name: '🐰' },
        },
      ],
    },
  );

  await channel.send({
    flags: 32768,
    components: [
      {
        type: 17,
        accent_color: 16351749,
        spoiler: false,
        components: innerComponents,
      },
    ],
  });
}

// ─── WIZARD STATUS EMBED ──────────────────────────────────────────────────────
function wizardStatusEmbed(steps, currentStep, data, type) {
  return new EmbedBuilder()
    .setColor(0x5865F2)
    .setTitle(`🛠️ ${type} Setup Wizard`)
    .setDescription(`Step **${currentStep + 1}** of **${steps.length}** — type \`cancel\` anytime to exit.`)
    .addFields(
      steps.filter(s => s.key !== '_preview').map(s => ({
        name:  s.label,
        value: data[s.key] != null
          ? (typeof data[s.key] === 'number'
              ? `#${data[s.key].toString(16).toUpperCase()}`
              : String(data[s.key]).slice(0, 80))
          : (s.optional ? '*skipped*' : '⏳ pending'),
        inline: true,
      }))
    )
    .setFooter({ text: 'respond in this channel to continue ↑' });
}

// ─── AUTO-REVOKE SWEEP ────────────────────────────────────────────────────────
async function sweepDeadInvites(guild) {
  try {
    const invites = await guild.invites.fetch();
    const dead    = [...invites.values()]
      .filter(i => i.uses < CONFIG.SWEEP_MIN_USES)
      .sort((a, b) => a.uses - b.uses)
      .slice(0, CONFIG.SWEEP_AMOUNT);

    if (!dead.length) return { swept: 0, codes: [], total: invites.size };

    const codes = [];
    for (const inv of dead) {
      await inv.delete(`Auto-revoke: <${CONFIG.SWEEP_MIN_USES} uses`);
      inviteCache.get(guild.id)?.delete(inv.code);
      codes.push(`\`${inv.code}\` — ${inv.uses} use${inv.uses === 1 ? '' : 's'}`);
    }
    return { swept: codes.length, codes, total: invites.size };
  } catch (err) {
    console.error('Sweep error:', err);
    return { swept: 0, codes: [], total: 0 };
  }
}

// ─── READY ────────────────────────────────────────────────────────────────────
client.once(Events.ClientReady, async () => {
  console.log(`✅ Logged in as ${client.user.tag}`);
  for (const guild of client.guilds.cache.values()) {
    try {
      const inv = await guild.invites.fetch();
      inviteCache.set(guild.id, new Map(inv.map(i => [i.code, i.uses])));
    } catch {}
  }
});

// ─── INVITE CREATED ───────────────────────────────────────────────────────────
client.on(Events.InviteCreate, async inv => {
  const c = inviteCache.get(inv.guild.id) ?? new Map();
  c.set(inv.code, inv.uses);
  inviteCache.set(inv.guild.id, c);

  let totalLinks = '?';
  try { const all = await inv.guild.invites.fetch(); totalLinks = all.size; } catch {}

  const logMsg =
    `📨 **New invite created**\n` +
    `Code: \`${inv.code}\`\n` +
    `Creator: ${inv.inviter ? `<@${inv.inviter.id}>` : 'Unknown'}\n` +
    `Total invites: **${totalLinks}**`;
  addLog('invite_created', logMsg);
  await sendLog(inv.guild, logMsg);

  try {
    const currentCount = typeof totalLinks === 'number' ? totalLinks : 0;
    const lastAt       = lastSweepAt.get(inv.guild.id) ?? 0;
    const crossed      = Math.floor(currentCount / CONFIG.SWEEP_LINK_THRESHOLD);
    const lastCrossed  = Math.floor(lastAt / CONFIG.SWEEP_LINK_THRESHOLD);

    if (crossed > lastCrossed) {
      lastSweepAt.set(inv.guild.id, currentCount);
      console.log(`🧹 [${inv.guild.name}] Hit ${currentCount} invite links — triggering auto-revoke...`);

      const { swept, codes } = await sweepDeadInvites(inv.guild);
      const logCh = inv.guild.channels.cache.get(settings.welcomeChannelId);

      if (swept > 0) {
        const sweepDesc =
          `Triggered at **${currentCount} active invite links**.\n` +
          `Removed **${swept}** link(s) with fewer than **${CONFIG.SWEEP_MIN_USES}** uses:\n\n` +
          codes.join('\n');
        addLog('auto_revoke', sweepDesc);
        const sweepEmbed = new EmbedBuilder()
          .setColor(0xFF4444).setTitle('🧹 Auto-Revoke Complete').setDescription(sweepDesc).setTimestamp();
        if (logCh) await logCh.send({ embeds: [sweepEmbed] });
        await sendLog(inv.guild, sweepEmbed);
      } else {
        const nothingDesc =
          `Hit **${currentCount} active links** but found no links with fewer than **${CONFIG.SWEEP_MIN_USES}** uses.`;
        addLog('auto_revoke', nothingDesc);
        const nothingEmbed = new EmbedBuilder()
          .setColor(0xFFA500).setTitle('🧹 Auto-Revoke Triggered — Nothing Removed').setDescription(nothingDesc).setTimestamp();
        if (logCh) await logCh.send({ embeds: [nothingEmbed] });
        await sendLog(inv.guild, nothingEmbed);
      }
    }
  } catch (err) { console.error('Auto-revoke check error:', err); }
});

// ─── INVITE DELETED ───────────────────────────────────────────────────────────
client.on(Events.InviteDelete, async inv => {
  inviteCache.get(inv.guild.id)?.delete(inv.code);

  let totalLinks = '?';
  try { const all = await inv.guild.invites.fetch(); totalLinks = all.size; } catch {}

  const logMsg =
    `🗑️ **Invite deleted**\n` +
    `Code: \`${inv.code}\`\n` +
    `Channel: ${inv.channel ? `<#${inv.channel.id}>` : 'Unknown'}\n` +
    `Total invites: **${totalLinks}**`;
  addLog('invite_deleted', logMsg);
  await sendLog(inv.guild, logMsg);
});

// ─── MEMBER JOIN ──────────────────────────────────────────────────────────────
client.on(Events.GuildMemberAdd, async member => {
  const guild = member.guild;
  let usedInvite = null;

  try {
    const fresh    = await guild.invites.fetch();
    const oldCache = inviteCache.get(guild.id) ?? new Map();
    for (const inv of fresh.values()) {
      if (inv.uses > (oldCache.get(inv.code) ?? 0)) { usedInvite = inv; break; }
    }
    inviteCache.set(guild.id, new Map(fresh.map(i => [i.code, i.uses])));
    if (usedInvite?.inviter) trackInviter(guild.id, usedInvite.inviter.id);
  } catch (err) { console.error('Invite tracking:', err); }

  const wCh = guild.channels.cache.get(settings.welcomeChannelId);
  if (!wCh) return;

  const inviterLine = usedInvite?.inviter
    ? ``
    : null;

  // ── Plain-text Apollo-style welcome, auto-deletes after 3 seconds ─────────
  const content = buildWelcomeText(member, settings, guild, inviterLine);
  const sent = await wCh.send({ content });
  setTimeout(() => sent.delete().catch(() => {}), 3000);
});

// ─── BUTTONS ──────────────────────────────────────────────────────────────────
client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isButton()) return;
  if (interaction.customId === 'rules_btn')
    return interaction.reply({ content: settings.rulesChannelId ? `📜 <#${settings.rulesChannelId}>` : '📜 Check the rules channel!', ephemeral: true });
  if (interaction.customId === 'events_btn')
    return interaction.reply({ content: settings.eventChannelId ? `🎁 <#${settings.eventChannelId}>` : '🎁 Check the events channel!', ephemeral: true });
  if (interaction.customId === 'p_284704454815518723')
    return interaction.reply({ content: '📖 **How to invite:**\n1. Server Settings → Invites\n2. Create a link\n3. Share it\n4. Hit your goal, then contact staff to claim!', ephemeral: true });
});

// ─── COMMANDS ─────────────────────────────────────────────────────────────────
client.on(Events.MessageCreate, async message => {
  if (message.author.bot) return;

  const wizard = wizards.get(message.author.id);
  if (wizard && message.channel.id === wizard.channelId) {
    const steps = wizard.type === 'welcome' ? WELCOME_STEPS : EVENT_STEPS;
    const step  = steps[wizard.step];

    if (message.content.trim().toLowerCase() === 'cancel') {
      wizards.delete(message.author.id);
      return message.channel.send({ embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Cancelled').setDescription('Nothing was saved.').setTimestamp()] });
    }

    if (step.isConfirm) {
      if (step.parse(message.content) !== 'confirm') {
        wizards.delete(message.author.id);
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0xFF4444).setTitle('❌ Cancelled').setDescription('Nothing was saved.').setTimestamp()] });
      }

      Object.assign(settings, wizard.data);
      wizards.delete(message.author.id);

      if (wizard.type === 'welcome') {
        return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Welcome settings saved!').setTimestamp()] });
      } else {
        const eCh = message.guild.channels.cache.get(wizard.data.eventChannelId ?? settings.eventChannelId);
        if (!eCh) return message.channel.send('⚠️ Channel not found.');
        try {
          await postEventComponents(eCh);
          return message.channel.send({ embeds: [new EmbedBuilder().setColor(0x57F287).setTitle('✅ Event posted!').setDescription(`Posted in <#${eCh.id}>`).setTimestamp()] });
        } catch (err) {
          console.error('postEventComponents error:', err?.rawError ?? err);
          return message.channel.send(`❌ Failed to post event: \`${err?.rawError?.message ?? err.message}\``);
        }
      }
    }

    const parsed = step.parse(message.content);
    if (!parsed && !step.optional)
      return message.channel.send(`⚠️ Invalid input for **${step.label}**, try again.`);
    if (parsed !== null) wizard.data[step.key] = parsed;
    wizard.step++;

    const next = steps[wizard.step];
    if (!next) { wizards.delete(message.author.id); return; }

    if (next.isConfirm) {
      const embeds = [new EmbedBuilder().setColor(0x5865F2).setDescription(next.prompt)];
      embeds.push(wizardStatusEmbed(steps, wizard.step, { ...settings, ...wizard.data }, wizard.type === 'welcome' ? 'Welcome' : 'Event'));
      return message.channel.send({ embeds });
    }

    return message.channel.send({ embeds: [
      new EmbedBuilder().setColor(0x5865F2).setDescription(next.prompt),
      wizardStatusEmbed(steps, wizard.step, { ...settings, ...wizard.data }, wizard.type === 'welcome' ? 'Welcome' : 'Event'),
    ]});
  }

  if (!message.content.startsWith(CONFIG.PREFIX)) return;

  const args = message.content.slice(CONFIG.PREFIX.length).trim().split(/\s+/);
  const cmd  = args.shift().toLowerCase();

  if (!memberIsAdmin(message.member))
    return message.reply('❌ You need **Administrator** permission' + (CONFIG.ADMIN_ROLE_ID ? ' or the admin role' : '') + '.');

  // ── !setwelcome ────────────────────────────────────────────────────────────
  if (cmd === 'setwelcome') {
    if (wizards.has(message.author.id)) return message.reply('⚠️ You have an active wizard. Type `cancel` first.');
    wizards.set(message.author.id, { type: 'welcome', step: 0, data: {}, channelId: message.channel.id });
    return message.channel.send({ embeds: [
      new EmbedBuilder().setColor(0x5865F2).setTitle('🛠️ Welcome Setup').setDescription(
        'Let\'s set up your welcome message in 3 quick steps.\n\n' + WELCOME_STEPS[0].prompt
      ),
      wizardStatusEmbed(WELCOME_STEPS, 0, settings, 'Welcome'),
    ]});
  }

  // ── !setevent ──────────────────────────────────────────────────────────────
  if (cmd === 'setevent') {
    if (wizards.has(message.author.id)) return message.reply('⚠️ You have an active wizard. Type `cancel` first.');
    wizards.set(message.author.id, { type: 'event', step: 0, data: {}, channelId: message.channel.id });
    return message.channel.send({ embeds: [
      new EmbedBuilder().setColor(0xFF8C00).setTitle('🛠️ Event Setup').setDescription('Which channel should the event be posted in?\n\n' + EVENT_STEPS[0].prompt),
      wizardStatusEmbed(EVENT_STEPS, 0, settings, 'Event'),
    ]});
  }

  // ── !setlog #channel ──────────────────────────────────────────────────────
  if (cmd === 'setlog') {
    const chId = args[0]?.replace(/[<#>]/g, '').trim();
    if (!chId) return message.reply('❌ Usage: `!setlog #channel` or `!setlog <channel-id>`');
    const ch = message.guild.channels.cache.get(chId);
    if (!ch) return message.reply('❌ Channel not found. Make sure you mention it or paste the ID.');
    settings.logChannelId = chId;
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor(0x57F287)
        .setTitle('✅ Log Channel Set')
        .setDescription(`Invite logs will now be sent to <#${chId}>.\n\nUse \`!logs\` anytime to view the last 10 entries.`)
        .setTimestamp(),
    ]});
  }

  // ── !logs ─────────────────────────────────────────────────────────────────
  if (cmd === 'logs') {
    if (!logBuffer.length)
      return message.reply('📋 No log entries recorded yet. Logs appear when invites are created/deleted or auto-revoke runs.');

    const typeLabel = {
      invite_created: '📨 Invite Created',
      invite_deleted: '🗑️ Invite Deleted',
      auto_revoke:    '🧹 Auto-Revoke',
    };

    const entries = [...logBuffer].reverse().slice(0, 10);
    const fields  = entries.map(e => ({
      name:  `${typeLabel[e.type] ?? e.type} — <t:${Math.floor(e.time / 1000)}:R>`,
      value: e.description.slice(0, 1020),
    }));

    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor(0x5865F2)
        .setTitle('📋 Recent Logs (last 10 of ' + logBuffer.length + ')')
        .addFields(fields)
        .setFooter({ text: `Log channel: ${settings.logChannelId ? `#${message.guild.channels.cache.get(settings.logChannelId)?.name ?? settings.logChannelId}` : 'not set — use !setlog #channel'}` })
        .setTimestamp(),
    ]});
  }

  // ── !revoke <uses> <amount> ───────────────────────────────────────────────
  if (cmd === 'revoke') {
    const maxUses = parseInt(args[0]);
    const amount  = parseInt(args[1]);
    if (isNaN(maxUses) || isNaN(amount) || amount < 1 || maxUses < 0)
      return message.reply('❌ Usage: `!revoke <uses> <amount>`\nExample: `!revoke 3 100` — deletes up to 100 invites with 3 or fewer uses.');

    try {
      const all     = await message.guild.invites.fetch();
      const targets = [...all.values()].filter(i => i.uses <= maxUses).slice(0, amount);

      if (!targets.length)
        return message.reply(`❌ No invites found with **${maxUses}** or fewer uses.`);

      const working = await message.reply(`⏳ Revoking **${targets.length}** invite(s)...`);

      let deleted = 0, failed = 0;
      const revokedCodes = [];
      for (const inv of targets) {
        try {
          await inv.delete(`Bulk revoke by ${message.author.tag}`);
          inviteCache.get(message.guild.id)?.delete(inv.code);
          revokedCodes.push(`\`${inv.code}\` — ${inv.uses} use${inv.uses === 1 ? '' : 's'}`);
          deleted++;
        } catch { failed++; }
      }

      const revokeDesc =
        `Manual revoke by **${message.author.tag}**\n` +
        `Deleted **${deleted}** link(s) with ≤ **${maxUses}** uses:\n` +
        revokedCodes.slice(0, 20).join('\n') +
        (revokedCodes.length > 20 ? `\n…and ${revokedCodes.length - 20} more` : '');
      addLog('auto_revoke', revokeDesc);
      await sendLog(message.guild, new EmbedBuilder()
        .setColor(0xFF4444).setTitle('🔒 Manual Bulk Revoke').setDescription(revokeDesc).setTimestamp());

      await working.delete().catch(() => {});
      return message.reply({ embeds: [
        new EmbedBuilder()
          .setColor(deleted > 0 ? 0xFF4444 : 0xFFA500)
          .setTitle('🔒 Bulk Revoke Done')
          .addFields(
            { name: 'Requested', value: `${amount}`,         inline: true },
            { name: 'Matched',   value: `${targets.length}`, inline: true },
            { name: 'Deleted',   value: `${deleted}`,        inline: true },
            { name: 'Max Uses',  value: `≤ ${maxUses}`,      inline: true },
            { name: 'Failed',    value: `${failed}`,         inline: true },
            { name: 'By',        value: message.author.tag,  inline: true },
          )
          .setTimestamp(),
      ]});
    } catch (err) {
      console.error(err);
      return message.reply('❌ Something went wrong fetching invites.');
    }
  }

  // ── !invites ──────────────────────────────────────────────────────────────
  if (cmd === 'invites') {
    try {
      const target     = message.mentions.users.first() ?? message.author;
      const guildStats = inviterStats.get(message.guild.id);
      const count      = guildStats?.get(target.id) ?? 0;

      const allInvites = await message.guild.invites.fetch();
      const theirLinks = allInvites.filter(i => i.inviter?.id === target.id);
      const liveUses   = theirLinks.reduce((sum, i) => sum + i.uses, 0);
      const total      = Math.max(count, liveUses);

      const tiers = [
        { req: 1,  label: 'Permanent Yeti',      emoji: '<:Yeti:1487166315729780836>',         robux: '2,500'  },
        { req: 3,  label: 'Permanent Kitsune',    emoji: '<:KitsuneFruit:1487166342497960008>', robux: '5,000'  },
        { req: 6,  label: 'Permanent Dragon',     emoji: '<:dragon:1487166379122626723>',       robux: '7,500'  },
        { req: 10, label: 'All Permanent Fruits', emoji: '<:perm:1487166401797029971>',         robux: '10,000' },
      ];

      const earned  = tiers.filter(t => total >= t.req);
      const current = earned[earned.length - 1] ?? null;
      const next    = tiers.find(t => total < t.req) ?? null;

      const progressBar = (val, max, len = 10) => {
        const filled = Math.min(Math.round((val / max) * len), len);
        return '█'.repeat(filled) + '░'.repeat(len - filled);
      };

      const nextText   = next
        ? `\`${progressBar(total, next.req)}\` **${total}/${next.req}** — ${next.emoji} **${next.label}**`
        : '🏆 All tiers unlocked!';
      const rewardText = current
        ? `${current.emoji} **${current.label}** — **${current.robux} Robux**`
        : '*No reward yet — start inviting!*';

      return message.reply({ embeds: [
        new EmbedBuilder()
          .setColor(0xF9A81D)
          .setAuthor({ name: target.tag, iconURL: target.displayAvatarURL({ dynamic: true }) })
          .setTitle('📨 Invite Stats')
          .addFields(
            { name: '👥 Total Invites',  value: `**${total}**`,           inline: true },
            { name: '🔗 Active Links',   value: `**${theirLinks.size}**`, inline: true },
            { name: '🏅 Current Reward', value: rewardText,               inline: false },
            { name: '⏭️ Next Reward',    value: nextText,                 inline: false },
          )
          .setFooter({ text: `${message.guild.name} • BloxFruit Event`, iconURL: message.guild.iconURL() })
          .setTimestamp(),
      ]});
    } catch (err) {
      console.error(err);
      return message.reply('❌ Could not fetch invite stats.');
    }
  }

  // ── !invitelb ─────────────────────────────────────────────────────────────
  if (cmd === 'invitelb') {
    try {
      const allInvites = await message.guild.invites.fetch();
      const liveMap    = new Map();
      for (const inv of allInvites.values()) {
        if (!inv.inviter) continue;
        liveMap.set(inv.inviter.id, (liveMap.get(inv.inviter.id) ?? 0) + inv.uses);
      }

      const merged = new Map(liveMap);
      const gStats = inviterStats.get(message.guild.id);
      if (gStats) {
        for (const [id, c] of gStats.entries())
          merged.set(id, Math.max(merged.get(id) ?? 0, c));
      }

      if (!merged.size) return message.reply('No invite data yet — nobody has joined via invite.');

      const sorted = [...merged.entries()].sort((a, b) => b[1] - a[1]).slice(0, 10);
      const medals = ['🥇', '🥈', '🥉'];
      const rows   = await Promise.all(sorted.map(async ([id, count], i) => {
        const user  = await client.users.fetch(id).catch(() => null);
        const name  = user ? user.tag : `Unknown (${id})`;
        const medal = medals[i] ?? `**${i + 1}.**`;
        const bar   = '█'.repeat(Math.min(Math.round((count / sorted[0][1]) * 8), 8)) +
                      '░'.repeat(8 - Math.min(Math.round((count / sorted[0][1]) * 8), 8));
        return `${medal} **${name}**\n> \`${bar}\` **${count}** invite${count === 1 ? '' : 's'}`;
      }));

      return message.reply({ embeds: [
        new EmbedBuilder()
          .setColor(0xF9A81D)
          .setTitle('🏆 Invite Leaderboard')
          .setDescription(rows.join('\n\n'))
          .setFooter({ text: `${message.guild.name} • top ${sorted.length} inviters`, iconURL: message.guild.iconURL() })
          .setTimestamp(),
      ]});
    } catch (err) {
      console.error(err);
      return message.reply('❌ Could not build leaderboard.');
    }
  }

  // ── !counts ───────────────────────────────────────────────────────────────
  if (cmd === 'counts') {
    try {
      const all        = await message.guild.invites.fetch();
      const totalUses  = all.reduce((sum, i) => sum + i.uses, 0);
      const totalLinks = all.size;

      const byInviter = new Map();
      for (const inv of all.values()) {
        if (!inv.inviter) continue;
        byInviter.set(inv.inviter.id, {
          tag:   inv.inviter.tag,
          uses:  (byInviter.get(inv.inviter.id)?.uses  ?? 0) + inv.uses,
          links: (byInviter.get(inv.inviter.id)?.links ?? 0) + 1,
        });
      }

      const topInviters = [...byInviter.values()]
        .sort((a, b) => b.uses - a.uses).slice(0, 5)
        .map((v, i) => {
          const medals = ['🥇','🥈','🥉'];
          return `${medals[i] ?? `**${i+1}.**`} **${v.tag}** — **${v.uses}** uses across **${v.links}** link${v.links === 1 ? '' : 's'}`;
        }).join('\n');

      return message.reply({ embeds: [
        new EmbedBuilder()
          .setColor(0xF9A81D)
          .setTitle('📊 Server Invite Count')
          .addFields(
            { name: '🔗 Total Active Links', value: `**${totalLinks}**`,                                                        inline: true },
            { name: '👥 Total Uses',         value: `**${totalUses}**`,                                                         inline: true },
            { name: '📈 Avg Uses per Link',  value: totalLinks > 0 ? `**${(totalUses / totalLinks).toFixed(1)}**` : '**0**',   inline: true },
            { name: '🏅 Top Inviters',       value: topInviters || '*no data yet*',                                             inline: false },
          )
          .setFooter({ text: `${message.guild.name} • live data`, iconURL: message.guild.iconURL() })
          .setTimestamp(),
      ]});
    } catch (err) {
      console.error(err);
      return message.reply('❌ Could not fetch invite data.');
    }
  }

  // ── !help ──────────────────────────────────────────────────────────────────
  if (cmd === 'help') {
    const embed = new EmbedBuilder()
      .setColor(0xF9A81D)
      .setTitle('\u{1F34A} BloxFruit Bot \u2014 Commands')
      .setDescription(
        'All commands require **Administrator** permission' +
        (CONFIG.ADMIN_ROLE_ID ? ' or the configured admin role' : '') +
        '. Prefix: `!`'
      )
      .addFields(
        {
          name: '\u{1F4E8} Invites',
          value:
            '`!invites` \u2014 your personal invite stats + reward progress\n' +
            '`!invites @user` \u2014 check someone else\'s stats\n' +
            '`!invitelb` \u2014 top 10 invite leaderboard\n' +
            '`!counts` \u2014 total invite links & uses across the whole server',
        },
        {
          name: '\u{1F512} Moderation',
          value: '`!revoke <uses> <amount>` \u2014 bulk delete invites\nExample: `!revoke 3 100` deletes up to 100 invites with 3 or fewer uses',
        },
        {
          name: '\u{1F6E0}\uFE0F Setup',
          value:
            '`!setwelcome` \u2014 set welcome channel + custom message (3 steps)\n' +
            '`!setevent` \u2014 post the BloxFruit event embed\n' +
            '`!setlog #channel` \u2014 set the channel for invite & auto-revoke logs',
        },
        {
          name: '\u{1F4CB} Logs',
          value: '`!logs` \u2014 view the last 10 log entries (invite created/deleted + auto-revokes)',
        },
        {
          name: '\u{1F527} Utility',
          value: '`!test` \u2014 full health check on the bot',
        },
        {
          name: '\u2699\uFE0F Auto-Revoke',
          value: '\u{1F9F9} Autorevoke',
        },
      )
      .setFooter({ text: `${message.guild.name} \u2022 BloxFruit Event Bot`, iconURL: message.guild.iconURL() })
      .setTimestamp();

    return message.reply({ embeds: [embed] });
  }

  // ── !test ─────────────────────────────────────────────────────────────────
  if (cmd === 'test') {
    const ping   = client.ws.ping;
    const wCh    = message.guild.channels.cache.get(settings.welcomeChannelId);
    const eCh    = message.guild.channels.cache.get(settings.eventChannelId);
    const lCh    = message.guild.channels.cache.get(settings.logChannelId);
    const cached = inviteCache.get(message.guild.id);
    let canFetch = false;
    try { await message.guild.invites.fetch(); canFetch = true; } catch {}
    let canSend = false;
    if (wCh) {
      const p = wCh.permissionsFor(message.guild.members.me);
      canSend = p?.has('SendMessages') && p?.has('EmbedLinks');
    }

    const checks = [
      { name: '🏓 Latency',            ok: ping < 500,                value: `${ping}ms` },
      { name: '👋 Welcome Channel',    ok: !!wCh,                     value: wCh ? `<#${wCh.id}>` : 'not set — run `!setwelcome`' },
      { name: '✏️ Welcome Message',    ok: true,                      value: settings.welcomeMessage ? `"${settings.welcomeMessage.slice(0, 50)}…"` : 'using default message' },
      { name: '🎁 Event Channel',      ok: !!eCh,                     value: eCh ? `<#${eCh.id}>` : 'not set — run `!setevent`' },
      { name: '📋 Log Channel',        ok: !!lCh,                     value: lCh ? `<#${lCh.id}>` : 'not set — run `!setlog #channel`' },
      { name: '📦 Invite Cache',       ok: !!cached,                  value: cached ? `${cached.size} invite(s) cached` : 'empty — restart may help' },
      { name: '🔑 Invite Permissions', ok: canFetch,                  value: canFetch ? 'can read invites ✓' : 'missing Manage Guild' },
      { name: '✉️ Can Send Welcome',   ok: canSend,                   value: canSend ? 'send + embed ✓' : wCh ? 'missing perms in that channel' : 'channel not set' },
      { name: '🖼️ Event Banner',       ok: !!CONFIG.EVENT_BANNER_URL, value: CONFIG.EVENT_BANNER_URL ? CONFIG.EVENT_BANNER_URL.slice(0, 60) + '…' : 'not set — banner skipped' },
      { name: '⏱️ Welcome Auto-Delete', ok: true,                     value: 'deletes after 3 seconds' },
      { name: '🧹 Auto-Revoke',        ok: true,                      value: `every ${CONFIG.SWEEP_LINK_THRESHOLD} links · removes ${CONFIG.SWEEP_AMOUNT} with <${CONFIG.SWEEP_MIN_USES} uses` },
    ];

    const allGood = checks.every(c => c.ok);
    return message.reply({ embeds: [
      new EmbedBuilder()
        .setColor(allGood ? 0x57F287 : 0xFF4444)
        .setTitle(allGood ? '✅ All Good' : '⚠️ Some Checks Failed')
        .setDescription(checks.map(c => `${c.ok ? '✅' : '❌'} **${c.name}**\n> ${c.value}`).join('\n\n'))
        .setFooter({ text: `checked by ${message.author.tag}` })
        .setTimestamp(),
    ]});
  }
});

client.login(CONFIG.TOKEN);
