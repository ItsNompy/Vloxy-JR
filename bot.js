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

        // Prices come in as tokens — convert to USD
        const dealUSD = (Number(dealPrice) * 0.003).toFixed(2);
        const origUSD = (Number(originalPrice) * 0.003).toFixed(2);

        const embed = new EmbedBuilder()
            .setTitle('🔥 New Deal Available!')
            .setColor(0xf59e0b)
            .setDescription(`A limited time deal has just dropped on **[vloxora.com](https://vloxora.com)**!`)
            .addFields(
                { name: '🎁 Item', value: itemName, inline: true },
                { name: '💸 Deal Price', value: `$${dealUSD}`, inline: true },
                { name: '🏷️ Original Price', value: `$${origUSD}`, inline: true },
                { name: '📉 Discount', value: `${discount}% off`, inline: true },
                { name: '📦 Stock', value: `${stock} available`, inline: true },
                { name: '⚡ Hurry!', value: 'Deals sell out fast — grab it before it\'s gone!', inline: false }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        if (itemImage) embed.setThumbnail(itemImage);

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}> 🔥 **New deal just dropped!**`,
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
// DEAL SOLD OUT ANNOUNCEMENT
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
            .setTitle('😔 Deal Sold Out')
            .setColor(0xef4444)
            .setDescription(`**${itemName}** has sold out! Keep an eye on **[vloxora.com](https://vloxora.com)** for the next deal.`)
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        if (itemImage) embed.setThumbnail(itemImage);

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}> 😔 **${itemName}** is now sold out!`,
            embeds: [embed]
        });

        console.log(`✅ Sold out announced: ${itemName}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Sold out announcement error:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// STOCK UPDATE ANNOUNCEMENT
// ═══════════════════════════════════════════════════════════

app.post('/announce-stock', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { name, image, rarity, category, value, qty, addedBy } = req.body;

        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(CONFIG.DEALS_CHANNEL_ID);

        // Convert value (tokens) to USD
        const priceUSD = value ? (Number(value) * 0.003).toFixed(2) : null;

        // Colour based on rarity
        const rarityColors = {
            legend: 0xff9900,
            epic:   0xa855f7,
            rare:   0xef4444,
            basic:  0x3b82f6
        };
        const color = rarityColors[(rarity || '').toLowerCase()] || 0x34d399;

        const embed = new EmbedBuilder()
            .setTitle('📦 New Stock Available!')
            .setColor(color)
            .setDescription(`**${name}** is now in stock on **[vloxora.com](https://vloxora.com)**!`)
            .addFields(
                { name: '🎮 Item', value: name, inline: true },
                { name: '✨ Rarity', value: rarity || 'Unknown', inline: true },
                { name: '🗂️ Category', value: category || 'Unknown', inline: true },
                ...(priceUSD ? [{ name: '💰 Price', value: `$${priceUSD}`, inline: true }] : []),
                { name: '📦 Quantity', value: `${qty} available`, inline: true },
                { name: '👤 Added By', value: addedBy || 'Admin', inline: true }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        if (image) embed.setThumbnail(image);

        await channel.send({
            content: `<@&${CONFIG.DEALS_ROLE_ID}> 📦 **${name}** is now in stock!`,
            embeds: [embed]
        });

        console.log(`✅ Stock announced: ${name} x${qty}`);
        res.json({ success: true });

    } catch (error) {
        console.error('❌ Stock announcement error:', error);
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
