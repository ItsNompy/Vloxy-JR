// Vloxy JR — Vloxora Ticket Bot
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const cors = require('cors');

// ── Supabase client (optional — for persistent invite tracking) ──
let supa = null;
try {
    const { createClient } = require('@supabase/supabase-js');
    const supaUrl = process.env.SUPABASE_URL || 'https://xluffxwtjtkthfkgnddh.supabase.co';
    const supaKey = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_KEY || '';
    if (supaUrl && supaKey) {
        supa = createClient(supaUrl, supaKey);
        console.log('✅ Supabase connected for invite tracking');
    } else {
        console.warn('⚠️ Supabase key not set — invite stats will be in-memory only');
    }
} catch (e) {
    console.warn('⚠️ @supabase/supabase-js not installed — invite stats will be in-memory only. Run: npm install @supabase/supabase-js');
}

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.GuildInvites,
        GatewayIntentBits.MessageContent
    ]
});

const app = express();

// Allow requests from vloxora.com
app.use(cors({
    origin: ['https://vloxora.com', 'https://www.vloxora.com'],
    methods: ['GET', 'POST', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization']
}));

app.use(express.json());

const CONFIG = {
    GUILD_ID: '1478513220405690408',
    TICKET_CATEGORY_ID: '1493872085993525340',
    STAFF_ROLE_ID: '1493771410227593317',
    DEALS_CHANNEL_ID: '1493789475489189898',
    DEALS_ROLE_ID: '1493867173683400865',
    CHANGES_CHANNEL_ID: '1494041831263043684',
    CHANGES_ROLE_ID: '1493867314565877831',
    GIVEAWAY_CHANNEL_ID: '1493779765184692406',
    VOUCH_ROLE_ID: '1494151986436903142',
    VOUCH_CHANNEL_ID: '1478513277276258324',
    VOTE_CHANNEL_ID: '1493791636159729684',
    API_SECRET: process.env.API_SECRET || 'vloxora-secret-2026',
    VERIFIED_ROLE_ID: '1493831773585412136'
};

client.once('clientReady', async () => {
    console.log(`✅ Vloxy JR online as ${client.user.tag}`);
    console.log(`🎫 Ticket system ready`);

    // Register slash commands
    const commands = [
        new SlashCommandBuilder()
            .setName('close')
            .setDescription('Close and delete this ticket channel')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('add')
            .setDescription('Add a user to this ticket')
            .addUserOption(opt => opt.setName('user').setDescription('User to add').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('remove')
            .setDescription('Remove a user from this ticket')
            .addUserOption(opt => opt.setName('user').setDescription('User to remove').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('giveaway')
            .setDescription('Start a giveaway in the giveaways channel')
            .addStringOption(opt => opt.setName('prize').setDescription('What are you giving away?').setRequired(true))
            .addStringOption(opt => opt.setName('duration').setDescription('Duration e.g. 10m, 1h, 2d').setRequired(true))
            .addIntegerOption(opt => opt.setName('winners').setDescription('Number of winners').setRequired(true).setMinValue(1).setMaxValue(10))
            .addStringOption(opt => opt.setName('hosted_by').setDescription('Who is hosting? (defaults to your name)').setRequired(false))
            .addStringOption(opt => opt.setName('image').setDescription('Image URL to display on the giveaway (optional)').setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('vouch')
            .setDescription('Give a user the Vouch In Progress role so they can type in the vouches channel')
            .addUserOption(opt => opt.setName('user').setDescription('The user to give the vouch role to').setRequired(true))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('invites')
            .setDescription('Check how many server invites you (or another user) have')
            .addUserOption(opt => opt.setName('user').setDescription('Check another user\'s invites (optional)').setRequired(false))
            .toJSON(),
        new SlashCommandBuilder()
            .setName('invites-leaderboard')
            .setDescription('Show the top inviters in the server')
            .toJSON(),
        new SlashCommandBuilder()
            .setName('add-invites')
            .setDescription('[Admin] Manually add invite credits to a user')
            .addUserOption(opt => opt.setName('user').setDescription('User to give invites to').setRequired(true))
            .addIntegerOption(opt => opt.setName('amount').setDescription('Number of invites to add (use negative to remove)').setRequired(true))
            .addStringOption(opt => opt.setName('reason').setDescription('Reason for the adjustment').setRequired(false))
            .toJSON(),
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (err) {
        console.error('Failed to register commands:', err);
    }

    // Cache all existing invites for invite tracking
    try {
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        await cacheGuildInvites(guild);
        await loadJoinedByFromDB(); // rebuild who-invited-who from persistent DB
    } catch (e) {
        console.warn('Could not fetch guild for invite cache:', e.message);
    }
});

// ═══════════════════════════════════════════════════════════
// GIVEAWAY STATE
// ═══════════════════════════════════════════════════════════

// messageId → { prize, endsAt, winnersCount, hostedBy, channelId,
//               entrants: Map<userId, { tag, entries }>,
//               timerInterval, endTimeout }
const activeGiveaways = new Map();

const GIVEAWAY_ROLE_ID  = '1495289844598046720';
const BOOSTER_ROLE_ID   = '1480291522401271985';

// ═══════════════════════════════════════════════════════════
// INVITE TRACKING — PERSISTENT (Supabase backed)
// ═══════════════════════════════════════════════════════════
// inviteCache: code → { uses, inviterId, inviterTag }
const inviteCache = new Map();

// joinedBy: memberId → inviterId  (in-memory for current session, rebuilt from DB on restart)
const joinedBy = new Map();

const ACCOUNT_AGE_MIN_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

// ── DB helpers ──
// ── In-memory fallback for when Supabase unavailable ──
const _memStats = new Map();
function _memGetStats(userId) {
    if (!_memStats.has(userId)) _memStats.set(userId, { user_id: userId, total: 0, left_count: 0, fake: 0, bonus: 0 });
    return _memStats.get(userId);
}

async function dbGetStats(userId) {
    if (!supa) return _memGetStats(userId);
    try {
        const { data } = await supa.from('invite_stats').select('*').eq('user_id', userId).maybeSingle();
        return data || { user_id: userId, total: 0, left_count: 0, fake: 0, bonus: 0 };
    } catch (e) { return _memGetStats(userId); }
}

async function dbIncrementField(userId, field, amount = 1) {
    if (!supa) { const s = _memGetStats(userId); s[field] = (s[field] || 0) + amount; return s[field]; }
    try {
        const current = await dbGetStats(userId);
        const newVal  = (current[field] || 0) + amount;
        await supa.from('invite_stats').upsert({
            user_id:    userId,
            total:      field === 'total'      ? newVal : (current.total      || 0),
            left_count: field === 'left_count' ? newVal : (current.left_count || 0),
            fake:       field === 'fake'       ? newVal : (current.fake       || 0),
            bonus:      field === 'bonus'      ? newVal : (current.bonus      || 0),
        }, { onConflict: 'user_id' });
        return newVal;
    } catch (e) { const s = _memGetStats(userId); s[field] = (s[field] || 0) + amount; return s[field]; }
}

async function dbSetBonus(userId, bonus) {
    if (!supa) { _memGetStats(userId).bonus = bonus; return; }
    try {
        const current = await dbGetStats(userId);
        await supa.from('invite_stats').upsert({
            user_id: userId, total: current.total || 0,
            left_count: current.left_count || 0, fake: current.fake || 0, bonus
        }, { onConflict: 'user_id' });
    } catch (e) { _memGetStats(userId).bonus = bonus; }
}

async function dbRecordJoin(memberId, inviterId) {
    if (!supa) return;
    try {
        await supa.from('invite_joins').upsert({
            member_id: memberId, inviter_id: inviterId,
            joined_at: new Date().toISOString(), active: true
        }, { onConflict: 'member_id' });
    } catch (e) { console.warn('dbRecordJoin:', e.message); }
}

async function dbRecordLeave(memberId) {
    if (!supa) return;
    try {
        await supa.from('invite_joins').update({ active: false, left_at: new Date().toISOString() }).eq('member_id', memberId);
    } catch (e) { console.warn('dbRecordLeave:', e.message); }
}

async function getRealTotalFromDB(userId) {
    const s = await dbGetStats(userId);
    return Math.max(0, (s.total || 0) + (s.bonus || 0) - (s.left_count || 0));
}

async function loadJoinedByFromDB() {
    if (!supa) return;
    try {
        const { data } = await supa.from('invite_joins').select('member_id, inviter_id').eq('active', true);
        if (data) { data.forEach(row => joinedBy.set(row.member_id, row.inviter_id)); console.log(`📊 Loaded ${data.length} invite relationships from DB`); }
    } catch (e) { console.warn('loadJoinedByFromDB:', e.message); }
}


// getStats / getRealTotal — kept for leaderboard compat, reads from DB
function getStats(userId) {
    // Sync version returns empty — async callers use dbGetStats directly
    return { total: 0, left_count: 0, fake: 0, bonus: 0 };
}

function getRealTotal(stats) {
    return Math.max(0, (stats.total || 0) + (stats.bonus || 0) - (stats.left_count || 0));
}

async function cacheGuildInvites(guild) {
    try {
        const invites = await guild.invites.fetch();
        inviteCache.clear();
        invites.forEach(inv => {
            inviteCache.set(inv.code, {
                uses:       inv.uses,
                inviterId:  inv.inviter?.id,
                inviterTag: inv.inviter?.username || 'Unknown'
            });
        });
        console.log(`📨 Cached ${inviteCache.size} invites`);
    } catch (e) {
        console.warn('Could not cache invites:', e.message);
    }
}

function parseDuration(str) {
    const match = str.trim().match(/^(\d+)\s*(s|m|h|d)$/i);
    if (!match) return null;
    const n    = parseInt(match[1]);
    const unit = match[2].toLowerCase();
    const ms   = { s: 1000, m: 60000, h: 3600000, d: 86400000 }[unit];
    return n * ms;
}

function formatTimeRemaining(ms) {
    if (ms <= 0) return 'Ended';
    const s = Math.floor(ms / 1000);
    const m = Math.floor(s / 60);
    const h = Math.floor(m / 60);
    const d = Math.floor(h / 24);
    if (d > 0) return `${d}d ${h % 24}h ${m % 60}m`;
    if (h > 0) return `${h}h ${m % 60}m ${s % 60}s`;
    if (m > 0) return `${m}m ${s % 60}s`;
    return `${s}s`;
}

function totalEntries(entrantsMap) {
    let t = 0;
    for (const e of entrantsMap.values()) t += e.entries;
    return t;
}

function buildGiveawayRow(active = true) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('giveaway_enter')
            .setLabel(active ? 'Enter Giveaway' : 'Giveaway Ended')
            .setStyle(active ? ButtonStyle.Primary : ButtonStyle.Secondary)
            .setDisabled(!active),
        new ButtonBuilder()
            .setCustomId('giveaway_participants')
            .setLabel('Participants')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(false)
    );
}

function buildGiveawayEmbed(gw, ended = false) {
    const remaining   = gw.endsAt - Date.now();
    const uniqueCount = gw.entrants.size;
    const ticketCount = totalEntries(gw.entrants);

    const embed = new EmbedBuilder()
        .setAuthor({
            name: 'Vloxora Giveaway',
            iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
        })
        .setTitle(gw.prize)
        .setColor(ended ? 0x374151 : 0x6366f1)
        .setDescription(
            ended
                ? `This giveaway has ended. Thank you to everyone who entered!`
                : `Press **Enter Giveaway** to join.`
        )
        .addFields(
            {
                name: ended ? 'Status' : 'Time Remaining',
                value: ended ? 'Ended' : formatTimeRemaining(remaining),
                inline: true
            },
            { name: 'Winners',       value: `${gw.winnersCount}`, inline: true },
            { name: 'Hosted By',     value: gw.hostedBy,          inline: true },
            { name: 'Participants',  value: `${uniqueCount}`,     inline: true },
            { name: 'Total Entries', value: `${ticketCount}`,     inline: true },
            { name: '\u200b',        value: '\u200b',             inline: true }
        )
        .setFooter({ text: ended ? 'Ended at' : 'Ends at' })
        .setTimestamp(ended ? Date.now() : gw.endsAt);

    if (gw.image) embed.setThumbnail(gw.image);

    return embed;
}

async function endGiveaway(messageId) {
    const gw = activeGiveaways.get(messageId);
    if (!gw) return;

    clearInterval(gw.timerInterval);
    clearTimeout(gw.endTimeout);
    activeGiveaways.delete(messageId);

    try {
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const ch    = await guild.channels.fetch(gw.channelId);
        const msg   = await ch.messages.fetch(messageId);

        // Build weighted pool — boosters already have 2 entries recorded
        const pool = [];
        for (const [userId, data] of gw.entrants) {
            for (let i = 0; i < data.entries; i++) pool.push(userId);
        }

        const winnerIds = [];
        const poolCopy  = [...pool];
        const count     = Math.min(gw.winnersCount, [...gw.entrants.keys()].length);
        const picked    = new Set();
        while (picked.size < count && poolCopy.length > 0) {
            const idx    = Math.floor(Math.random() * poolCopy.length);
            const winner = poolCopy.splice(idx, 1)[0];
            if (!picked.has(winner)) { picked.add(winner); winnerIds.push(winner); }
        }

        // Edit original message to ended state
        await msg.edit({
            embeds:     [buildGiveawayEmbed(gw, true)],
            components: [buildGiveawayRow(false)]
        });

        if (winnerIds.length === 0) {
            await ch.send({
                content: `**${gw.prize}** — Nobody entered so there are no winners this time.`,
                reply: { messageReference: messageId }
            });
        } else {
            const mentions = winnerIds.map(id => `<@${id}>`).join(', ');
            await ch.send({
                content: `${mentions}\n\nCongratulations, you won **${gw.prize}**! The Giveaway Host will message you so you can claim your prize!`,
                reply: { messageReference: messageId }
            });
        }

        console.log(`✅ Giveaway ended: "${gw.prize}" — winners: ${winnerIds.join(', ') || 'none'}`);
    } catch (err) {
        console.error('❌ Error ending giveaway:', err);
    }
}

// Handle slash commands and buttons
client.on('interactionCreate', async (interaction) => {

    // ── Giveaway: Enter / Leave ──────────────────────────────
    if (interaction.isButton() && interaction.customId === 'giveaway_enter') {
        const gw = activeGiveaways.get(interaction.message.id);
        if (!gw) return interaction.reply({ content: 'This giveaway has already ended.', ephemeral: true });

        const userId   = interaction.user.id;
        const isBooster = interaction.member?.roles?.cache?.has(BOOSTER_ROLE_ID) ?? false;
        const entries  = isBooster ? 2 : 1;

        if (gw.entrants.has(userId)) {
            gw.entrants.delete(userId);
            await interaction.reply({ content: 'You have left the giveaway.', ephemeral: true });
        } else {
            gw.entrants.set(userId, { tag: interaction.user.tag, entries });
            const boosterNote = isBooster ? ' You have **2× entries** as a Server Booster.' : '';
            await interaction.reply({ content: `You're in! Good luck.${boosterNote}`, ephemeral: true });
        }

        try {
            await interaction.message.edit({
                embeds:     [buildGiveawayEmbed(gw)],
                components: [buildGiveawayRow(true)]
            });
        } catch (e) { console.error('Embed update error:', e); }
        return;
    }

    // ── Giveaway: View Participants ──────────────────────────
    if (interaction.isButton() && interaction.customId === 'giveaway_participants') {
        const msgId = interaction.message.id;
        // Check both active and (recently) ended — find the message context
        const gw = activeGiveaways.get(msgId);

        // If giveaway is gone from memory, we can't list — still respond gracefully
        if (!gw) {
            return interaction.reply({ content: 'Participant data is no longer available for this giveaway.', ephemeral: true });
        }

        if (gw.entrants.size === 0) {
            return interaction.reply({ content: 'No one has entered yet.', ephemeral: true });
        }

        const lines = [];
        let i = 1;
        for (const [userId, data] of gw.entrants) {
            const boosterTag = data.entries === 2 ? ' ⭐' : '';
            lines.push(`${i}. <@${userId}>${boosterTag} — ${data.entries} entr${data.entries === 1 ? 'y' : 'ies'}`);
            i++;
        }

        // Discord ephemeral messages cap at 2000 chars — chunk if needed
        const chunks = [];
        let current  = `**Participants — ${gw.prize}** (${gw.entrants.size} unique · ${totalEntries(gw.entrants)} total entries)\n\n`;
        for (const line of lines) {
            if ((current + line + '\n').length > 1900) {
                chunks.push(current);
                current = '';
            }
            current += line + '\n';
        }
        if (current) chunks.push(current);

        await interaction.reply({ content: chunks[0], ephemeral: true });
        return;
    }

    // Handle close button
    if (interaction.isButton() && interaction.customId === 'close_ticket') {
        const member = interaction.member;
        const isStaff = member.roles.cache.has(CONFIG.STAFF_ROLE_ID);

        if (!isStaff) {
            return interaction.reply({ content: '❌ Only staff can close tickets.', ephemeral: true });
        }

        await interaction.reply('✅ Closing ticket in 5 seconds...');
        setTimeout(async () => {
            try { await interaction.channel.delete(); } catch (err) { console.error(err); }
        }, 5000);
        return;
    }

    if (!interaction.isChatInputCommand()) return;

    const member  = interaction.member;
    const isStaff = member.roles.cache.has(CONFIG.STAFF_ROLE_ID);
    const isVerified = member.roles.cache.has(CONFIG.VERIFIED_ROLE_ID);

    // Commands any verified member (or staff) can use — no blanket block
    const publicCommands = ['invites', 'invites-leaderboard'];
    const isPublic = publicCommands.includes(interaction.commandName);

    // Block non-staff from staff-only commands
    if (!isPublic && !isStaff) {
        return interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true });
    }

    // /close — close the ticket
    if (interaction.commandName === 'close') {
        const channel = interaction.channel;

        const isTicketChannel = channel.name.startsWith('order-') || channel.name.startsWith('cashout-');
        if (!isTicketChannel) {
            return interaction.reply({ content: '❌ This command can only be used in a ticket or cashout channel.', ephemeral: true });
        }

        await interaction.reply('✅ Closing ticket in 5 seconds...');

        setTimeout(async () => {
            try {
                await channel.delete();
            } catch (err) {
                console.error('Failed to delete channel:', err);
            }
        }, 5000);
    }

    // /add — add a user to the ticket
    if (interaction.commandName === 'add') {
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.create(user, {
            ViewChannel: true,
            SendMessages: true,
            ReadMessageHistory: true
        });
        await interaction.reply(`✅ Added ${user} to the ticket.`);
    }

    // /remove — remove a user from the ticket
    if (interaction.commandName === 'remove') {
        const user = interaction.options.getUser('user');
        await interaction.channel.permissionOverwrites.delete(user);
        await interaction.reply(`✅ Removed ${user} from the ticket.`);
    }

    // /vouch — give a user the Vouch In Progress role
    if (interaction.commandName === 'vouch') {
        const targetUser   = interaction.options.getUser('user');
        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);

        if (!targetMember) {
            return interaction.reply({ content: '❌ Could not find that user in the server.', ephemeral: true });
        }

        if (targetMember.roles.cache.has(CONFIG.VOUCH_ROLE_ID)) {
            return interaction.reply({ content: `${targetUser} already has the Vouch In Progress role.`, ephemeral: true });
        }

        await targetMember.roles.add(CONFIG.VOUCH_ROLE_ID);
        console.log(`✅ Vouch In Progress role given to ${targetUser.tag} by ${interaction.user.tag}`);
        await interaction.reply({ content: `✅ ${targetUser} has been given the Vouch In Progress role and can now type in the vouches channel.`, ephemeral: true });
    }

    // ── /invites — check your own or another user's invite count ──
    if (interaction.commandName === 'invites') {
        if (!isVerified && !isStaff) {
            return interaction.reply({ content: '❌ You need the Verified role to use this command.', ephemeral: true });
        }
        await interaction.deferReply();

        const targetUser = interaction.options.getUser('user') || interaction.user;
        const stats      = await dbGetStats(targetUser.id);
        const realTotal  = getRealTotal(stats);
        const isSelf     = targetUser.id === interaction.user.id;

        let activeLinks = 0;
        inviteCache.forEach(inv => { if (inv.inviterId === targetUser.id) activeLinks++; });

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Invite Tracker', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle(isSelf ? 'Your Invites' : `${targetUser.username}'s Invites`)
            .setColor(0x6366f1)
            .setThumbnail(targetUser.displayAvatarURL({ dynamic: true }))
            .setDescription(isSelf
                ? `You have **${realTotal}** valid invite${realTotal !== 1 ? 's' : ''}.`
                : `**${targetUser.username}** has **${realTotal}** valid invite${realTotal !== 1 ? 's' : ''}.`)
            .addFields(
                { name: 'Valid Joins',      value: `**${stats.total || 0}**`,  inline: true },
                { name: 'Left Server',      value: `**${stats.left_count  || 0}**`,  inline: true },
                { name: 'Fake Accounts',    value: `**${stats.fake  || 0}**`,  inline: true },
                { name: 'Bonus (Admin)',    value: `**${stats.bonus || 0}**`,  inline: true },
                { name: 'Active Links',     value: `**${activeLinks}**`,        inline: true },
                { name: 'Net Total',        value: `**${realTotal}**`,          inline: true }
            )
            .setFooter({ text: 'Persisted across restarts • Only accounts 7d+ count • Vloxora' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }

    // ── /invites-leaderboard — top inviters (verified+ can use) ──
    if (interaction.commandName === 'invites-leaderboard') {
        if (!isVerified && !isStaff) {
            return interaction.reply({ content: '❌ You need the Verified role to use this command.', ephemeral: true });
        }
        await interaction.deferReply();

        // Fetch top 10 from Supabase ordered by net invites
        const { data: rows } = await supa.from('invite_stats')
            .select('user_id, total, left, fake, bonus')
            .order('total', { ascending: false })
            .limit(25);

        if (!rows || rows.length === 0) {
            return interaction.editReply({ content: 'No invite data yet — counts build as members join and are accepted.' });
        }

        // Calculate real totals and filter out zeros
        const withReal = rows
            .map(r => ({ ...r, real: Math.max(0, (r.total||0) + (r.bonus||0) - (r.left_count||0)) }))
            .filter(r => r.real > 0)
            .sort((a, b) => b.real - a.real)
            .slice(0, 10);

        if (withReal.length === 0) {
            return interaction.editReply({ content: 'No one has valid invites yet.' });
        }

        const medals = ['🥇', '🥈', '🥉'];
        const lines = await Promise.all(withReal.map(async (row, i) => {
            let name = `<@${row.user_id}>`;
            try { const m = await interaction.guild.members.fetch(row.user_id); name = m.displayName; } catch (e) {}
            const medal = medals[i] || `\`${i + 1}.\``;
            return `${medal} **${name}** — ${row.real} invite${row.real !== 1 ? 's' : ''}`;
        }));

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Invite Tracker', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle('Top Inviters')
            .setColor(0x6366f1)
            .setDescription(lines.join('\n'))
            .setFooter({ text: 'Persisted across restarts • Only accounts 7d+ count • Vloxora' })
            .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
    }

    // ── /add-invites — admin only manual invite adjustment ──
    if (interaction.commandName === 'add-invites') {
        const isStaffCheck = interaction.member.roles.cache.has(CONFIG.STAFF_ROLE_ID);
        if (!isStaffCheck) {
            return interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true });
        }

        const targetUser = interaction.options.getUser('user');
        const amount     = interaction.options.getInteger('amount');
        const reason     = interaction.options.getString('reason') || 'No reason provided';

        const statsBefore = await dbGetStats(targetUser.id);
        const before      = getRealTotal(statsBefore);
        const newBonus    = (statsBefore.bonus || 0) + amount;
        await dbSetBonus(targetUser.id, newBonus);
        const statsAfter  = await dbGetStats(targetUser.id);
        const after       = getRealTotal(statsAfter);

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Invite Tracker', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle('Invites Adjusted')
            .setColor(amount >= 0 ? 0x22c55e : 0xef4444)
            .addFields(
                { name: 'User',   value: `${targetUser} (@${targetUser.username})`, inline: false },
                { name: 'Change', value: `${amount >= 0 ? '+' : ''}${amount}`,       inline: true },
                { name: 'Before', value: `${before}`,                                inline: true },
                { name: 'After',  value: `**${after}**`,                             inline: true },
                { name: 'Reason', value: reason,                                     inline: false }
            )
            .setFooter({ text: `Adjusted by ${interaction.user.username} • Saved to database` })
            .setTimestamp();

        await interaction.reply({ embeds: [embed] });
        console.log(`✅ Admin ${interaction.user.username} adjusted ${targetUser.username}'s bonus by ${amount} (now ${after} net). Reason: ${reason}`);
    }

    // /giveaway — start a giveaway
    if (interaction.commandName === 'giveaway') {
        const prize        = interaction.options.getString('prize');
        const durationRaw  = interaction.options.getString('duration');
        const winnersCount = interaction.options.getInteger('winners');
        const hostedBy     = interaction.options.getString('hosted_by') || interaction.member.displayName;
        const image        = interaction.options.getString('image') || null;

        const durationMs = parseDuration(durationRaw);
        if (!durationMs || durationMs < 10000) {
            return interaction.reply({ content: '❌ Invalid duration. Use formats like `30m`, `1h`, `2d`. Minimum is 10s.', ephemeral: true });
        }
        if (durationMs > 14 * 24 * 3600000) {
            return interaction.reply({ content: '❌ Maximum giveaway duration is 14 days.', ephemeral: true });
        }

        const endsAt = Date.now() + durationMs;
        const guild  = await client.guilds.fetch(CONFIG.GUILD_ID);
        const ch     = await guild.channels.fetch(CONFIG.GIVEAWAY_CHANNEL_ID);

        const gwData = {
            prize,
            hostedBy,
            winnersCount,
            endsAt,
            image,
            entrants: new Map(),
            channelId: ch.id,
            timerInterval: null,
            endTimeout: null
        };

        const msg = await ch.send({
            content: `<@&${GIVEAWAY_ROLE_ID}>`,
            embeds:     [buildGiveawayEmbed(gwData)],
            components: [buildGiveawayRow(true)]
        });

        // Live timer — update every 5s (safe Discord rate-limit floor)
        gwData.timerInterval = setInterval(async () => {
            try {
                await msg.edit({
                    embeds:     [buildGiveawayEmbed(gwData)],
                    components: [buildGiveawayRow(true)]
                });
            } catch (e) { console.error('Timer update error:', e); }
        }, 5000);

        // End the giveaway after duration
        gwData.endTimeout = setTimeout(() => endGiveaway(msg.id), durationMs);

        activeGiveaways.set(msg.id, gwData);

        console.log(`✅ Giveaway started: "${prize}" for ${formatTimeRemaining(durationMs)} by ${hostedBy}`);
        await interaction.reply({ content: `✅ Giveaway started in <#${ch.id}>!`, ephemeral: true });
    }
});

// ═══════════════════════════════════════════════════════════
// VOUCH ROLE AUTO-REMOVE
// Removes Vouch In Progress role once the user sends a message
// in the vouches channel
// ═══════════════════════════════════════════════════════════
// ═══════════════════════════════════════════════════════════
// INVITE TRACKING EVENTS
// Supports apply-to-join servers via pendingInvites + guildMemberUpdate
// ═══════════════════════════════════════════════════════════

// pendingInvites: memberId → { inviterId, inviterTag, ageDays, isFake }
// Attribution stored when member clicks link, confirmed when they pass screening
const pendingInvites = new Map();

client.on('inviteCreate', invite => {
    inviteCache.set(invite.code, {
        uses:       invite.uses || 0,
        inviterId:  invite.inviter?.id,
        inviterTag: invite.inviter?.username || 'Unknown'
    });
    console.log(`📨 Invite created: ${invite.code} by ${invite.inviter?.username}`);
});

client.on('inviteDelete', invite => {
    inviteCache.delete(invite.code);
});

// Fires when someone clicks the invite link to apply
client.on('guildMemberAdd', async member => {
    if (member.guild.id !== CONFIG.GUILD_ID) return;
    try {
        const accountAge = Date.now() - member.user.createdTimestamp;
        const isFake     = accountAge < ACCOUNT_AGE_MIN_MS;
        const ageDays    = Math.floor(accountAge / 86400000);

        const freshInvites = await member.guild.invites.fetch();
        let usedInvite = null;

        freshInvites.forEach(inv => {
            const cached = inviteCache.get(inv.code);
            if (cached && inv.uses > cached.uses) usedInvite = inv;
        });

        // Update cache immediately so next join comparison is accurate
        freshInvites.forEach(inv => {
            inviteCache.set(inv.code, {
                uses:       inv.uses,
                inviterId:  inv.inviter?.id,
                inviterTag: inv.inviter?.username || 'Unknown'
            });
        });

        if (!usedInvite?.inviter) {
            console.log(`👋 ${member.user.username} applied — invite undetermined`);
            return;
        }

        const inviterId  = usedInvite.inviter.id;
        const inviterTag = usedInvite.inviter.username;

        if (member.pending) {
            // Apply-to-join: store attribution, credit after screening passes
            pendingInvites.set(member.id, { inviterId, inviterTag, ageDays, isFake });
            console.log(`⏳ ${member.user.username} applied via ${inviterTag} — awaiting screening`);
        } else {
            // No screening gate — credit immediately
            creditInvite(member, inviterId, inviterTag, ageDays, isFake);
        }
    } catch (e) {
        console.warn('guildMemberAdd invite tracking error:', e.message);
    }
});

// Fires when a member passes screening (pending true → false)
client.on('guildMemberUpdate', (oldMember, newMember) => {
    if (newMember.guild.id !== CONFIG.GUILD_ID) return;
    if (!oldMember.pending || newMember.pending) return; // only on screening cleared

    const pending = pendingInvites.get(newMember.id);
    if (!pending) {
        console.log(`✅ ${newMember.user.username} passed screening — no pending invite to credit`);
        return;
    }

    pendingInvites.delete(newMember.id);
    creditInvite(newMember, pending.inviterId, pending.inviterTag, pending.ageDays, pending.isFake);
});

async function creditInvite(member, inviterId, inviterTag, ageDays, isFake) {
    if (isFake) {
        await dbIncrementField(inviterId, 'fake');
        console.log(`🚫 ${member.user.username} accepted but account only ${ageDays}d old — NOT counted for ${inviterTag}`);
    } else {
        const newTotal = await dbIncrementField(inviterId, 'total');
        await dbRecordJoin(member.id, inviterId);
        joinedBy.set(member.id, inviterId);
        const realTotal = await getRealTotalFromDB(inviterId);
        console.log(`✅ ${member.user.username} (${ageDays}d old) accepted — ${inviterTag} now has ${realTotal} invites (${newTotal} total)`);
    }
}

client.on('guildMemberRemove', async member => {
    if (member.guild.id !== CONFIG.GUILD_ID) return;
    try {
        pendingInvites.delete(member.id);
        const inviterId = joinedBy.get(member.id);
        if (inviterId) {
            await dbIncrementField(inviterId, 'left_count');
            await dbRecordLeave(member.id);
            joinedBy.delete(member.id);
            const realTotal = await getRealTotalFromDB(inviterId);
            console.log(`👋 ${member.user.username} left — their inviter now has ${realTotal} valid invites`);
        }
    } catch (e) {
        console.warn('guildMemberRemove invite tracking error:', e.message);
    }
});


client.on('messageCreate', async (message) => {
    if (message.author.bot) return;

    // ── Auto-react with win/flat/loss votes ──
    if (message.channel.id === CONFIG.VOTE_CHANNEL_ID) {
        try {
            await message.react('🟢');
            await message.react('🟡');
            await message.react('🔴');
        } catch (err) {
            console.error('❌ Failed to react to vote message:', err);
        }
        return;
    }

    // ── Vouch role auto-remove ──
    if (message.channel.id !== CONFIG.VOUCH_CHANNEL_ID) return;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    if (!member.roles.cache.has(CONFIG.VOUCH_ROLE_ID)) return;

    try {
        await member.roles.remove(CONFIG.VOUCH_ROLE_ID);
        console.log(`✅ Vouch In Progress role removed from ${message.author.tag} after posting in vouches channel`);
    } catch (err) {
        console.error('❌ Failed to remove vouch role:', err);
    }
});

app.post('/create-ticket', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { discordId, discordUsername, userId, items, total } = req.body;

        if (!discordId && !discordUsername) {
            return res.status(400).json({ error: 'Missing Discord info' });
        }

        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'No items in order' });
        }

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        if (!guild) {
            return res.status(500).json({ error: 'Bot is not in the server' });
        }

        await guild.members.fetch();

        let member = null;

        if (discordId) {
            try {
                member = await guild.members.fetch(discordId);
            } catch (e) {}
        }

        if (!member && discordUsername) {
            member = guild.members.cache.find(m =>
                m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
                m.user.globalName?.toLowerCase() === discordUsername.toLowerCase()
            );
        }

        if (!member) {
            return res.status(404).json({
                error: 'not_in_server',
                message: `Could not find "${discordUsername}" in the server. Please join the Vloxora Discord first!`
            });
        }

        const ticketNumber = Date.now().toString().slice(-6);
        const safeName = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        const channelName = `order-${safeName}-${ticketNumber}`;

        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            parent: CONFIG.TICKET_CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                {
                    id: member.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                },
                {
                    id: CONFIG.STAFF_ROLE_ID,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
                },
                {
                    id: client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                }
            ]
        });

        const itemsList = items.map(item =>
            `${item.name}  ×${item.quantity}  —  $${Number(item.price).toLocaleString()}`
        ).join('\n');

        const embed = new EmbedBuilder()
            .setAuthor({
                name: 'Vloxora Shop',
                iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
            })
            .setTitle('New Order')
            .setColor(0x6366f1)
            .addFields(
                { name: 'Customer', value: `${member} (@${member.user.username})`, inline: false },
                { name: 'Items',    value: itemsList,                              inline: false },
                { name: 'Total',    value: `$${Number(total).toLocaleString()}`,   inline: true  },
                { name: 'Order ID', value: `#${ticketNumber}`,                     inline: true  },
                { name: 'Date',     value: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), inline: true }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.STAFF_ROLE_ID}>`,
            embeds: [embed]
        });

        await channel.send(
            `Hey ${member}!\n\n` +
            `Thanks for your order. An owner will be with you shortly.\n\n` +
            `**What happens next:**\n` +
            `1. Your order will be confirmed and verified\n` +
            `2. Payment will be arranged\n` +
            `3. You'll receive your items in-game\n\n` +
            `Please stay here and sit tight!`
        );

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('Close Ticket')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({ components: [row] });

        console.log(`✅ Ticket created: #${channelName} for ${member.user.username} — $${total}`);

        res.json({ success: true, channelId: channel.id, channelName: channel.name, ticketNumber });

    } catch (error) {
        console.error('❌ Error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/', (req, res) => {
    res.json({ status: 'online', service: 'Vloxy JR' });
});

// ═══════════════════════════════════════════════════════════
// VALUE CHANGE ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-value-change', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { itemName, itemImage, itemRarity, reason, changedBy } = req.body;
        const oldValue  = Number(req.body.oldValue)  || 0;
        const newValue  = Number(req.body.newValue)  || 0;
        const oldDemand = Number(req.body.oldDemand) || 0;
        const newDemand = Number(req.body.newDemand) || 0;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.CHANGES_CHANNEL_ID);

        const valueChanged  = oldValue  !== newValue;
        const demandChanged = oldDemand !== newDemand;

        // Green if anything went up, red if anything went down, grey if neutral
        const valueUp  = valueChanged  && newValue  > oldValue;
        const valueDown = valueChanged && newValue  < oldValue;
        const demandUp  = demandChanged && newDemand > oldDemand;
        const demandDown = demandChanged && newDemand < oldDemand;
        const anyUp   = valueUp  || demandUp;
        const anyDown = valueDown || demandDown;
        const color = anyUp && !anyDown ? 0x22c55e   // all gains → green
                    : anyDown && !anyUp ? 0xef4444   // all losses → red
                    : anyUp && anyDown  ? 0xf59e0b   // mixed → amber
                    : 0x818cf8;                      // no change → indigo

        // Demand label mapping (1–5 → text)
        const demandLabel = (n) => {
            const map = { 5: 'Fantastic', 4: 'Good', 3: 'Medium', 2: 'Low', 1: 'Poor' };
            return map[n] || 'None';
        };

        const fields = [];

        if (valueChanged) {
            fields.push({
                name: 'Value',
                value: `${(oldValue || 0).toLocaleString()}  →  **${(newValue || 0).toLocaleString()}** tokens`,
                inline: true
            });
        }

        if (demandChanged) {
            fields.push({
                name: 'Demand',
                value: `${demandLabel(oldDemand)}  →  **${demandLabel(newDemand)}**`,
                inline: true
            });
        }

        fields.push({
            name: 'Reasoning',
            value: reason || 'No reason provided.',
            inline: false
        });

        fields.push({
            name: '\u200b',
            value: '[View on vloxora.com](https://vloxora.com)',
            inline: false
        });

        const embed = new EmbedBuilder()
            .setAuthor({
                name: 'Vloxora Value Changes',
                iconURL: `https://cdn.discordapp.com/emojis/1493842549289386074.png`
            })
            .setTitle(itemName)
            .setColor(color)
            .addFields(...fields)
            .setThumbnail(itemImage || null)
            .setFooter({ text: `Updated by ${changedBy || 'Admin'}` })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.CHANGES_ROLE_ID}>`,
            embeds: [embed]
        });

        console.log(`✅ Value change announced: ${itemName} by ${changedBy}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Value change error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// NEW DEAL ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-deal', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { itemName, itemImage, originalPrice, dealPrice, discount, stock } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        // Both arrive as token values — convert at $3/1k, ceil to whole dollar, min $1
        const dealUSD = Math.max(1, Math.ceil(Number(dealPrice) * 0.003));
        const origUSD = Math.max(1, Math.ceil(Number(originalPrice) * 0.003));

        const embed = new EmbedBuilder()
            .setAuthor({
                name: 'Vloxora Shop',
                iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
            })
            .setTitle(itemName)
            .setColor(0xf59e0b)
            .setDescription(`A limited time deal is now live on **[vloxora.com](https://vloxora.com)**`)
            .addFields(
                { name: 'Deal Price',  value: `$${dealUSD.toLocaleString()}`,     inline: true },
                { name: 'Original',    value: `~~$${origUSD.toLocaleString()}~~`,  inline: true },
                { name: 'You Save',    value: `${discount}% off`,                  inline: true },
                { name: 'Stock',       value: `${stock} available`,                inline: true }
            )
            .setThumbnail(itemImage || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# 🔥 NEW DEAL — ${itemName.toUpperCase()}`,
            embeds: [embed]
        });

        console.log(`✅ Deal announced: ${itemName} at $${dealUSD}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Deal announcement error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// DEAL SOLD OUT
// ═══════════════════════════════════════════════════════════

app.post('/announce-soldout', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { itemName, itemImage } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const embed = new EmbedBuilder()
            .setAuthor({
                name: 'Vloxora Shop',
                iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
            })
            .setTitle(itemName)
            .setColor(0x6b7280)
            .setDescription(`~~This deal has sold out.~~ Stay tuned — more deals drop regularly on **[vloxora.com](https://vloxora.com)**`)
            .addFields(
                { name: 'Status', value: 'Sold Out', inline: true }
            )
            .setThumbnail(itemImage || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# SOLD OUT — ${itemName.toUpperCase()}`,
            embeds: [embed]
        });

        console.log(`✅ Deal sold out announced: ${itemName}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Sold out error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// STOCK ADDED ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-stock', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { name, image, rarity, category, value, qty, addedBy } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const rarityColors = {
            legend: 0xff9900,
            epic:   0xa855f7,
            rare:   0xef4444,
            basic:  0x3b82f6
        };
        const color  = rarityColors[(rarity || '').toLowerCase()] || 0x34d399;
        const priceUSD = value ? `$${Math.max(1, Math.ceil(Number(value) * 0.003))}` : null;

        const fields = [
            { name: 'Rarity',   value: rarity || 'Unknown',   inline: true },
            { name: 'Category', value: category || 'Unknown', inline: true },
        ];
        if (priceUSD) fields.push({ name: 'Price', value: priceUSD, inline: true });
        fields.push({ name: 'Qty', value: `${qty} available`, inline: true });

        const embed = new EmbedBuilder()
            .setAuthor({
                name: 'Vloxora Shop',
                iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
            })
            .setTitle(name)
            .setColor(color)
            .setDescription(`Now available on **[vloxora.com](https://vloxora.com)**`)
            .addFields(...fields)
            .setThumbnail(image || null)
            .setFooter({ text: `Added by ${addedBy || 'Admin'} • Vloxora Shop` })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# New Stock — ${name}`,
            embeds: [embed]
        });

        console.log(`✅ Stock announced: ${name} x${qty}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Stock announcement error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// BULK STOCK SESSION ANNOUNCEMENT (one ping for all changes)
// ═══════════════════════════════════════════════════════════

app.post('/announce-stock-session', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { added, removed, addedBy } = req.body;

        if ((!added || added.length === 0) && (!removed || removed.length === 0)) {
            return res.json({ success: true, message: 'Nothing to announce' });
        }

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const rarityColors = { legend: 0xff9900, epic: 0xa855f7, rare: 0xef4444, basic: 0x3b82f6 };
        const embeds = [];

        // One embed per added item
        if (added && added.length > 0) {
            for (const item of added) {
                const color    = rarityColors[(item.rarity || '').toLowerCase()] || 0x34d399;
                const priceUSD = item.value ? `$${Math.max(1, Math.ceil(Number(item.value) * 0.003))}` : null;

                const fields = [
                    { name: 'Rarity',   value: item.rarity || 'Unknown',   inline: true },
                    { name: 'Category', value: item.category || 'Unknown', inline: true },
                ];
                if (priceUSD) fields.push({ name: 'Price', value: priceUSD, inline: true });
                fields.push({ name: 'Qty', value: `${item.qty} available`, inline: true });

                const embed = new EmbedBuilder()
                    .setAuthor({
                        name: 'Vloxora Shop',
                        iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
                    })
                    .setTitle(item.name)
                    .setColor(color)
                    .setDescription(`Now available on **[vloxora.com](https://vloxora.com)**`)
                    .addFields(...fields)
                    .setThumbnail(item.image || null)
                    .setFooter({ text: `Added by ${addedBy || 'Admin'} • Vloxora Shop` })
                    .setTimestamp();

                embeds.push(embed);
            }
        }

        // One embed for all removed items
        if (removed && removed.length > 0) {
            const embed = new EmbedBuilder()
                .setAuthor({
                    name: 'Vloxora Shop',
                    iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png'
                })
                .setTitle('Removed from Stock')
                .setColor(0x6b7280)
                .setDescription(removed.map(name => `~~${name}~~`).join('\n'))
                .setFooter({ text: `Removed by ${addedBy || 'Admin'} • Vloxora Shop` })
                .setTimestamp();

            embeds.push(embed);
        }

        // Build content message
        const addedText   = added?.length   ? `**Added:** ${added.map(i => i.name).join(', ')}` : '';
        const removedText = removed?.length ? `\n**Removed:** ${removed.join(', ')}` : '';

        const content =
            `<@&${CONFIG.DEALS_ROLE_ID}>\n` +
            `# Stock Update\n` +
            `${addedText}${removedText}\n` +
            `**[Shop now → vloxora.com](https://vloxora.com)**`;

        // Discord allows max 10 embeds per message — chunk if needed
        const chunkSize = 10;
        for (let i = 0; i < embeds.length; i += chunkSize) {
            const chunk = embeds.slice(i, i + chunkSize);
            await channel.send({
                content: i === 0 ? content : '',
                embeds: chunk
            });
        }

        console.log(`✅ Stock session announced: +${added?.length || 0} added, -${removed?.length || 0} removed by ${addedBy}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Stock session error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// TOKEN SUPPLY ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-tokens', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { oldTokens, newTokens, addedBy } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const added = newTokens > oldTokens;
        const diff  = Math.abs(newTokens - oldTokens);
        const color = newTokens === 0 ? 0x6b7280 : added ? 0x34d399 : 0xf59e0b;

        const embed = new EmbedBuilder()
            .setTitle(newTokens === 0
                ? '<:Token:1495134289728110622>  TOKENS SOLD OUT'
                : added
                    ? '<:Token:1495134289728110622>  TOKENS RESTOCKED'
                    : '<:Token:1495134289728110622>  TOKEN SUPPLY UPDATED')
            .setColor(color)
            .setDescription(
                newTokens === 0
                    ? `> Tokens are currently **sold out**.\n> Check back soon!\n\u200b`
                    : `> Token supply has been updated on **[vloxora.com](https://vloxora.com)**\n\u200b`
            )
            .addFields(
                { name: '\u200b', value: `<:Token:1495134289728110622>  **New Supply**\n${newTokens.toLocaleString()} tokens`, inline: false },
                { name: '\u200b', value: `${added ? '📈' : '📉'}  **${added ? 'Added' : 'Reduced'}**\n${diff.toLocaleString()} tokens`, inline: false },
                { name: '\u200b', value: `💲  **Rate**\n$3 / 1k tokens`, inline: false },
                { name: '\u200b', value: `👤  **Updated By**\n${addedBy || 'Admin'}`, inline: false },
                { name: '\u200b', value: '> 🛒 **[Shop now → vloxora.com](https://vloxora.com)**', inline: false }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: newTokens === 0
                ? `<@&${CONFIG.DEALS_ROLE_ID}>\n# <:Token:1495134289728110622> TOKENS SOLD OUT`
                : `<@&${CONFIG.DEALS_ROLE_ID}>\n# <:Token:1495134289728110622> ${newTokens.toLocaleString()} TOKENS NOW AVAILABLE ($3/1k Tokens)`,
            embeds: [embed]
        });

        console.log(`✅ Token supply announced: ${oldTokens} → ${newTokens} by ${addedBy}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Token announce error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/announce-stockout', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { name, image, rarity, addedBy } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const rarityColors = {
            legend: 0xff9900,
            epic:   0xa855f7,
            rare:   0xef4444,
            basic:  0x3b82f6
        };
        const color = rarityColors[(rarity || '').toLowerCase()] || 0x6b7280;

        const embed = new EmbedBuilder()
            .setTitle('📭  O U T  O F  S T O C K')
            .setColor(0x6b7280)
            .setDescription(
                `## ~~${name}~~\n` +
                `> This item has been removed from stock on **[vloxora.com](https://vloxora.com)**\n` +
                `> Check back soon for restocks!\n\u200b`
            )
            .addFields(
                { name: '📭  Status', value: '**OUT OF STOCK**', inline: true },
                { name: '✨  Rarity', value: `**${rarity || 'Unknown'}**`, inline: true },
                { name: '👤  Removed By', value: `**${addedBy || 'Admin'}**`, inline: true },
                { name: '\u200b', value: '> 👀 **[Browse available stock → vloxora.com](https://vloxora.com)**', inline: false }
            )
            .setThumbnail(image || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# 📭 OUT OF STOCK — ${name.toUpperCase()}`,
            embeds: [embed]
        });

        console.log(`✅ Stock out announced: ${name}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Stock out error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.get('/health', (req, res) => {
    res.json({ status: 'online', bot: client.user?.tag || 'starting...', uptime: Math.floor(process.uptime()) + 's' });
});

// ═══════════════════════════════════════════════════════════
// CREATE CASHOUT TICKET
// ═══════════════════════════════════════════════════════════
const CASHOUT_CATEGORY_ID = '1495518295187525722';

app.post('/create-cashout', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { discordId, discordUsername, userId, items, total } = req.body;

        if (!discordId && !discordUsername) {
            return res.status(400).json({ error: 'Missing Discord info' });
        }
        if (!items || items.length === 0) {
            return res.status(400).json({ error: 'No items in cashout' });
        }

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        if (!guild) return res.status(500).json({ error: 'Bot not in server' });

        await guild.members.fetch();

        let member = null;
        if (discordId) {
            try { member = await guild.members.fetch(discordId); } catch (e) {}
        }
        if (!member && discordUsername) {
            member = guild.members.cache.find(m =>
                m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
                m.user.globalName?.toLowerCase() === discordUsername.toLowerCase()
            );
        }
        if (!member) {
            return res.status(404).json({
                error: 'not_in_server',
                message: `Could not find "${discordUsername}" in the server.`
            });
        }

        const ticketNumber = Date.now().toString().slice(-6);
        const safeName = member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '');
        const channelName = `cashout-${safeName}-${ticketNumber}`;

        const channel = await guild.channels.create({
            name: channelName,
            type: 0,
            parent: CASHOUT_CATEGORY_ID,
            permissionOverwrites: [
                { id: guild.id, deny: [PermissionFlagsBits.ViewChannel] },
                {
                    id: member.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                },
                {
                    id: CONFIG.STAFF_ROLE_ID,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.ManageMessages]
                },
                {
                    id: client.user.id,
                    allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.ReadMessageHistory]
                }
            ]
        });

        const itemsList = (() => {
            const lines = items.map(item =>
                item.price > 0
                    ? `${item.name}  ×${item.quantity}  —  asking **$${Number(item.price).toLocaleString()}**`
                    : `${item.name}  ×${item.quantity}  —  *N/A (open to offer)*`
            );
            // Discord embed field max is 1024 chars — truncate gracefully
            let result = '';
            for (const line of lines) {
                const next = result ? result + '\n' + line : line;
                if (next.length > 1000) { result += `\n*(+ ${lines.length - lines.indexOf(line)} more items)*`; break; }
                result = next;
            }
            return result || 'No items listed';
        })();

        const totalStr = (total > 0)
            ? `$${Number(total).toLocaleString()}`
            : '*Open to offers*';

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Cashout', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle('New Cashout Request')
            .setColor(0x22c55e)
            .addFields(
                { name: 'Seller',                value: `${member} (@${member.user.username})`, inline: false },
                { name: 'Items & Asking Prices', value: itemsList,                              inline: false },
                { name: 'Total Requested',       value: totalStr,   inline: true },
                { name: 'Request ID',            value: `#${ticketNumber}`, inline: true },
                { name: 'Date',                  value: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), inline: true }
            )
            .setFooter({ text: 'Vloxora Cashout • Vloxy JR' })
            .setTimestamp();

        // Send embed — catch separately so a Discord formatting error doesn't break the whole ticket
        try {
            await channel.send({ content: `<@&${CONFIG.STAFF_ROLE_ID}>`, embeds: [embed] });
        } catch (embedErr) {
            console.error('❌ Cashout embed send failed:', embedErr.message);
            // Fallback: send a plain-text summary instead
            const plain = `**New Cashout Request** — ${member} (@${member.user.username})\n\n${items.map(i => `• ${i.name} ×${i.quantity}${i.price > 0 ? ' — $' + Number(i.price).toLocaleString() : ' — open to offer'}`).join('\n')}\n\n**Total requested:** ${totalStr}\n**ID:** #${ticketNumber}`;
            await channel.send({ content: `<@&${CONFIG.STAFF_ROLE_ID}>\n${plain}` });
        }

        try {
            await channel.send(
                `Hey ${member}!\n\n` +
                `Thanks for your cashout request. An owner will review it shortly.\n\n` +
                `**What happens next:**\n` +
                `1. A staff member will review your items and confirm the offer\n` +
                `2. Once agreed, you'll send the items in-game\n` +
                `3. You'll receive your payment\n\n` +
                `Please sit tight!`
            );

            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('close_ticket')
                    .setLabel('Close Ticket')
                    .setStyle(ButtonStyle.Danger)
            );
            await channel.send({ components: [row] });
        } catch (msgErr) {
            console.warn('⚠️ Cashout welcome message failed (non-fatal):', msgErr.message);
        }

        console.log(`✅ Cashout ticket: #${channelName} for ${member.user.username} — est. $${total}`);
        res.json({ success: true, channelId: channel.id, channelName: channel.name, ticketNumber });

    } catch (error) {
        console.error('❌ Cashout error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// BUNDLE ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-bundle', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { bundleName, tagline, itemNames, originalTokens, dealTokens, discount, isNew, postedBy } = req.body;

        const guild   = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const origUSD = Math.max(1, Math.ceil(Number(originalTokens) * 0.003));
        const dealUSD = Math.max(1, Math.ceil(Number(dealTokens)     * 0.003));

        const fields = [
            { name: 'Items',    value: (itemNames || []).join('\n') || '—',       inline: true  },
            { name: 'Price',    value: `$${dealUSD.toLocaleString()}`,            inline: true  },
            { name: 'Tokens',   value: `${Number(dealTokens).toLocaleString()}`,  inline: true  },
        ];

        if (discount > 0) {
            fields.push({ name: 'You Save', value: `${discount}% off  ($${(origUSD - dealUSD).toLocaleString()})`, inline: true });
        }

        fields.push({ name: '\u200b', value: '[Browse all bundles → vloxora.com/bundles](https://vloxora.com/bundles)', inline: false });

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Bundles', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle(bundleName)
            .setColor(0x6366f1)
            .setDescription(tagline || `A new bundle is now available on **[vloxora.com](https://vloxora.com)**`)
            .addFields(...fields)
            .setFooter({ text: `${isNew ? 'Added' : 'Updated'} by ${postedBy || 'Admin'} • Vloxora Shop` })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# ${isNew ? 'New Bundle' : 'Bundle Updated'} — ${bundleName}`,
            embeds: [embed]
        });

        console.log(`✅ Bundle announced: "${bundleName}" by ${postedBy}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Bundle announce error:', error);
        res.status(500).json({ error: error.message });
    }
});

app.post('/announce-bundle-removed', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { bundleName, removedBy } = req.body;

        const guild   = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        const embed = new EmbedBuilder()
            .setAuthor({ name: 'Vloxora Bundles', iconURL: 'https://cdn.discordapp.com/emojis/1493842549289386074.png' })
            .setTitle(bundleName)
            .setColor(0x374151)
            .setDescription(`~~This bundle has been removed.~~ Check **[vloxora.com/bundles](https://vloxora.com/bundles)** for available packs.`)
            .setFooter({ text: `Removed by ${removedBy || 'Admin'} • Vloxora Shop` })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# Bundle Removed — ${bundleName}`,
            embeds: [embed]
        });

        console.log(`✅ Bundle removal announced: "${bundleName}" by ${removedBy}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Bundle remove announce error:', error);
        res.status(500).json({ error: error.message });
    }
});

const PORT = parseInt(process.env.PORT) || 3000;
console.log(`🔌 Starting server on port ${PORT}...`);

// Start HTTP server first
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Vloxy JR API running on port ${PORT}`);
    // Login bot after server is confirmed listening
    client.login(process.env.DISCORD_TOKEN).catch(err => {
        console.error('Failed to login bot:', err);
    });
});

server.on('error', (err) => {
    console.error('Server error:', err);
});

process.on('uncaughtException', (err) => {
    console.error('Uncaught Exception:', err);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

client.on('error', (err) => {
    console.error('Discord client error:', err);
});
