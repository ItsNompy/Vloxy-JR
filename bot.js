// Vloxy JR — Vloxora Ticket Bot
require('dotenv').config();
const { Client, GatewayIntentBits, PermissionFlagsBits, EmbedBuilder } = require('discord.js');
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
    API_SECRET: process.env.API_SECRET
};

client.once('clientReady', () => {
    console.log(`✅ Vloxy JR online as ${client.user.tag}`);
    console.log(`🎫 Ticket system ready`);
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

app.get('/health', (req, res) => {
    res.json({ status: 'online', bot: client.user?.tag || 'starting...', uptime: Math.floor(process.uptime()) + 's' });
});

const PORT = process.env.PORT || 3000;

// Start HTTP server first so Railway health checks pass immediately
const server = app.listen(PORT, '0.0.0.0', () => {
    console.log(`🌐 Vloxy JR API running on port ${PORT}`);
});

// Keep the process alive — prevent Railway from killing it
process.on('uncaughtException', (error) => {
    console.error('Uncaught Exception:', error);
});

process.on('unhandledRejection', (reason) => {
    console.error('Unhandled Rejection:', reason);
});

// Reconnect bot if it disconnects
client.on('disconnect', () => {
    console.log('⚠️ Bot disconnected, reconnecting...');
    client.login(process.env.DISCORD_TOKEN);
});

client.on('error', (error) => {
    console.error('Bot error:', error);
});

// Login the bot
client.login(process.env.DISCORD_TOKEN);
