// Vloxy JR — Vloxora Ticket Bot
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express');
const cors = require('cors');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages
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
    API_SECRET: process.env.API_SECRET
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
    ];

    try {
        const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
        await rest.put(Routes.applicationGuildCommands(client.user.id, CONFIG.GUILD_ID), { body: commands });
        console.log('✅ Slash commands registered');
    } catch (err) {
        console.error('Failed to register commands:', err);
    }
});

// Handle slash commands and buttons
client.on('interactionCreate', async (interaction) => {

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

    // Only allow staff to use these commands
    const member = interaction.member;
    const isStaff = member.roles.cache.has(CONFIG.STAFF_ROLE_ID);

    if (!isStaff) {
        return interaction.reply({ content: '❌ Only staff can use this command.', ephemeral: true });
    }

    // /close — close the ticket
    if (interaction.commandName === 'close') {
        const channel = interaction.channel;

        // Make sure we're in a ticket channel
        if (!channel.name.startsWith('order-')) {
            return interaction.reply({ content: '❌ This command can only be used in a ticket channel.', ephemeral: true });
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
            `• **${item.name}** x${item.quantity} — $${Number(item.price).toLocaleString()}`
        ).join('\n');

        const embed = new EmbedBuilder()
            .setTitle('🛒 New Order — Vloxora')
            .setColor(0xec4899)
            .addFields(
                { name: '👤 Customer', value: `${member} (@${member.user.username})`, inline: false },
                { name: '📦 Items Ordered', value: itemsList, inline: false },
                { name: '💰 Total', value: `$${Number(total).toLocaleString()}`, inline: true },
                { name: '🆔 Order ID', value: `#${ticketNumber}`, inline: true },
                { name: '📅 Date', value: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), inline: true }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.STAFF_ROLE_ID}> ${member} — new order!`,
            embeds: [embed]
        });

        await channel.send(
            `Hey ${member}! 👋\n\n` +
            `Thanks for your order! A staff member will be with you shortly.\n\n` +
            `**What happens next:**\n` +
            `1. Staff will confirm and verify your order\n` +
            `2. Payment will be arranged\n` +
            `3. You'll receive your items in-game\n\n` +
            `Please stay here and wait for a staff member!`
        );

        // Send close button for staff
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('close_ticket')
                .setLabel('🔒 Close Ticket')
                .setStyle(ButtonStyle.Danger)
        );

        await channel.send({
            content: `**Staff:** Use the button below or \`/close\` to close this ticket when complete.`,
            components: [row]
        });

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

        const { itemName, itemImage, itemRarity, oldValue, newValue, oldDemand, newDemand, reason, proofUrls, changedBy } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.CHANGES_CHANNEL_ID);

        const rarityColors = {
            legend: 0xff9900,
            epic:   0xa855f7,
            rare:   0xef4444,
            basic:  0x3b82f6
        };
        const color = rarityColors[(itemRarity || '').toLowerCase()] || 0x818cf8;

        // Value change
        const valueChanged  = newValue !== oldValue;
        const demandChanged = newDemand !== oldDemand;
        const valueWent     = newValue > oldValue ? '📈' : '📉';
        const demandWent    = newDemand > oldDemand ? '📈' : '📉';

        // Demand stars display
        const starDisplay = (n) => '⭐'.repeat(Math.min(n || 0, 5)) || 'None';

        const fields = [];

        if (valueChanged) {
            fields.push({ name: '\u200b', value: `${valueWent}  **Value Change**\n${(oldValue||0).toLocaleString()} tokens  →  **${(newValue||0).toLocaleString()} tokens**`, inline: false });
        }
        if (demandChanged) {
            fields.push({ name: '\u200b', value: `${demandWent}  **Demand Change**\n${starDisplay(oldDemand)}  →  **${starDisplay(newDemand)}**`, inline: false });
        }

        fields.push({ name: '\u200b', value: `📋  **Admin Reasoning**\n${reason}`, inline: false });
        fields.push({ name: '\u200b', value: `👤  **Updated By**\n${changedBy || 'Admin'}`, inline: false });
        fields.push({ name: '\u200b', value: `> 📊 **[View on vloxora.com](https://vloxora.com)**`, inline: false });

        const embed = new EmbedBuilder()
            .setTitle(`📊  VALUE UPDATE — ${itemName.toUpperCase()}`)
            .setColor(color)
            .setDescription(
                `> **${itemName}** has been reviewed and updated by staff.\n\u200b`
            )
            .addFields(...fields)
            .setThumbnail(itemImage || null)
            .setFooter({ text: `Vloxora Value Team • Vloxy JR` })
            .setTimestamp();

        // If proof images were uploaded add them
        const files = [];
        if (proofUrls && proofUrls.length > 0) {
            embed.addFields({
                name: '\u200b',
                value: `📸  **Proof** (${proofUrls.length} screenshot${proofUrls.length > 1 ? 's' : ''})\n` +
                    proofUrls.map((u, i) => `[Screenshot ${i + 1}](${u})`).join('  ·  '),
                inline: false
            });
        }

        const valueTag  = valueChanged  ? `${valueWent} **${(oldValue||0).toLocaleString()} → ${(newValue||0).toLocaleString()} tokens**` : null;
        const demandTag = demandChanged ? `${demandWent} Demand **${oldDemand} → ${newDemand}**` : null;
        const changeSummary = [valueTag, demandTag].filter(Boolean).join('  ·  ');

        await channel.send({
            content:
                `<@&${CONFIG.CHANGES_ROLE_ID}>\n` +
                `# 📊 VALUE UPDATE — ${itemName.toUpperCase()}\n` +
                (changeSummary ? `${changeSummary}\n` : '') +
                `**Updated by ${changedBy || 'Admin'} · [vloxora.com](https://vloxora.com)**`,
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

        const dealUSD = (Number(dealPrice) * 0.003).toFixed(2);
        const origUSD = (Number(originalPrice) * 0.003).toFixed(2);

        const embed = new EmbedBuilder()
            .setTitle('🔥  L I M I T E D  D E A L  D R O P P E D')
            .setColor(0xf59e0b)
            .setDescription(
                `## ${itemName}\n` +
                `> A limited time deal is now live on **[vloxora.com](https://vloxora.com)**\n` +
                `> Don't sleep on this — stock is limited!\n\u200b`
            )
            .addFields(
                { name: '💸  Deal Price', value: `### $${dealUSD}`, inline: true },
                { name: '🏷️  Original', value: `### ~~$${origUSD}~~`, inline: true },
                { name: '🔥  You Save', value: `### ${discount}% OFF`, inline: true },
                { name: '📦  Stock Left', value: `**${stock} available**`, inline: true },
                { name: '⚡  Act Fast', value: '**Deals sell out within minutes**', inline: true },
                { name: '\u200b', value: '> 🛒 **[Grab it now → vloxora.com](https://vloxora.com)**', inline: false }
            )
            .setThumbnail(itemImage || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR', iconURL: 'https://vloxora.com/favicon.png' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# 🔥 NEW DEAL — ${itemName.toUpperCase()}\n**${discount}% off for a limited time — don't miss out!**`,
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
            .setTitle('😔  D E A L  S O L D  O U T')
            .setColor(0x6b7280)
            .setDescription(
                `## ~~${itemName}~~\n` +
                `> This deal has officially sold out.\n` +
                `> Stay tuned — more deals drop regularly on **[vloxora.com](https://vloxora.com)**\n\u200b`
            )
            .addFields(
                { name: '📭  Status', value: '**SOLD OUT**', inline: true },
                { name: '🔔  Don\'t Miss Next Time', value: 'Keep notifications on!', inline: true },
                { name: '\u200b', value: '> 👀 **[Check vloxora.com for more deals](https://vloxora.com)**', inline: false }
            )
            .setThumbnail(itemImage || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# 😔 SOLD OUT — ${itemName.toUpperCase()}`,
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

        const priceUSD = value ? (Number(value) * 0.003).toFixed(2) : null;

        const rarityColors = {
            legend: 0xff9900,
            epic:   0xa855f7,
            rare:   0xef4444,
            basic:  0x3b82f6
        };
        const rarityEmojis = {
            legend: '🌈',
            epic:   '💜',
            rare:   '🔴',
            basic:  '🔵'
        };
        const color = rarityColors[(rarity || '').toLowerCase()] || 0x34d399;
        const rarEmoji = rarityEmojis[(rarity || '').toLowerCase()] || '✨';

        const embed = new EmbedBuilder()
            .setTitle(`📦  N E W  S T O C K  A V A I L A B L E`)
            .setColor(color)
            .setDescription(
                `## ${rarEmoji} ${name}\n` +
                `> Fresh stock has just been added to **[vloxora.com](https://vloxora.com)**\n` +
                `> Grab it before it sells out!\n\u200b`
            )
            .addFields(
                { name: '✨  Rarity', value: `**${rarity || 'Unknown'}**`, inline: true },
                { name: '🗂️  Category', value: `**${category || 'Unknown'}**`, inline: true },
                ...(priceUSD ? [{ name: '💰  Price', value: `**$${priceUSD}**`, inline: true }] : []),
                { name: '📦  In Stock', value: `**${qty} available**`, inline: true },
                { name: '👤  Added By', value: `**${addedBy || 'Admin'}**`, inline: true },
                { name: '\u200b', value: `> 🛒 **[Shop now → vloxora.com](https://vloxora.com)**`, inline: false }
            )
            .setImage(image || null)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}>\n# 📦 IN STOCK — ${name.toUpperCase()}\n**${qty}x ${rarity || ''} ${name} just dropped into the shop!**`,
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
        const rarityEmojis = { legend: '🌈', epic: '💜', rare: '🔴', basic: '🔵' };

        const embeds = [];

        // One embed per added item
        if (added && added.length > 0) {
            for (const item of added) {
                const priceUSD = item.value ? (Number(item.value) * 0.003).toFixed(2) : null;
                const color = rarityColors[(item.rarity || '').toLowerCase()] || 0x34d399;
                const rarEmoji = rarityEmojis[(item.rarity || '').toLowerCase()] || '✨';

                const embed = new EmbedBuilder()
                    .setTitle(`📦  N E W  S T O C K`)
                    .setColor(color)
                    .setDescription(
                        `## ${item.name}\n` +
                        `> Now available on **[vloxora.com](https://vloxora.com)**\n\u200b`
                    )
                    .addFields(
                        { name: '✨  Rarity',   value: `**${item.rarity || 'Unknown'}**`, inline: true },
                        { name: '🗂️  Category', value: `**${item.category || 'Unknown'}**`, inline: true },
                        ...(priceUSD ? [{ name: '💰  Price', value: `**$${priceUSD}**`, inline: true }] : []),
                        { name: '📦  Qty',      value: `**${item.qty} available**`, inline: true },
                    )
                    .setThumbnail(item.image || null)
                    .setFooter({ text: `Added by ${addedBy || 'Admin'} • Vloxora Shop` })
                    .setTimestamp();

                embeds.push(embed);
            }
        }

        // One embed for all removed items
        if (removed && removed.length > 0) {
            const embed = new EmbedBuilder()
                .setTitle(`📭  R E M O V E D  F R O M  S T O C K`)
                .setColor(0x6b7280)
                .setDescription(
                    removed.map(name => `~~${name}~~`).join('\n') +
                    `\n\n> These items are no longer available in the shop.\n\u200b`
                )
                .setFooter({ text: `Removed by ${addedBy || 'Admin'} • Vloxora Shop` })
                .setTimestamp();

            embeds.push(embed);
        }

        // Build content message
        const addedNames  = added && added.length  ? added.map(i => i.name).join(', ')  : null;
        const removedText = removed && removed.length ? `\n📭 **Removed:** ${removed.join(', ')}` : '';
        const addedText   = addedNames ? `📦 **Added:** ${addedNames}` : '';

        const content =
            `<@&${CONFIG.DEALS_ROLE_ID}>\n` +
            `# 🛒 STOCK UPDATE\n` +
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
