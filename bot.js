// Vloxy JR - Vloxora Ticket Bot
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
app.use(cors());
app.use(express.json());

// ═══════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════

const CONFIG = {
    GUILD_ID: '1478513220405690408',
    TICKET_CATEGORY_ID: '1493872085993525340',
    STAFF_ROLE_ID: '1493771410227593317',
    API_SECRET: process.env.API_SECRET  // Set this in Railway environment variables
};

// ═══════════════════════════════════════════════════════════
// BOT READY
// ═══════════════════════════════════════════════════════════

client.once('ready', () => {
    console.log(`✅ Vloxy JR logged in as ${client.user.tag}`);
    console.log(`🎫 Ready to create tickets!`);
    console.log(`🏠 Guild: ${CONFIG.GUILD_ID}`);
});

// ═══════════════════════════════════════════════════════════
// CREATE TICKET ENDPOINT
// ═══════════════════════════════════════════════════════════

app.post('/create-ticket', async (req, res) => {
    try {
        // Verify API secret
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { discordUsername, userId, items, total } = req.body;

        if (!discordUsername || !items || !total) {
            return res.status(400).json({ error: 'Missing required fields: discordUsername, items, total' });
        }

        // Get guild
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        if (!guild) {
            return res.status(500).json({ error: 'Bot is not in the server' });
        }

        // Find the member in the server
        const members = await guild.members.fetch();
        const member = members.find(m =>
            m.user.username.toLowerCase() === discordUsername.toLowerCase() ||
            m.user.tag?.toLowerCase() === discordUsername.toLowerCase()
        );

        if (!member) {
            return res.status(404).json({
                error: 'not_in_server',
                message: `"${discordUsername}" was not found in the server. Please join the Vloxora Discord first!`
            });
        }

        // Generate ticket number
        const ticketNumber = Date.now().toString().slice(-6);
        const channelName = `order-${member.user.username.toLowerCase().replace(/[^a-z0-9]/g, '')}-${ticketNumber}`;

        // Create the ticket channel
        const channel = await guild.channels.create({
            name: channelName,
            type: 0, // Text channel
            parent: CONFIG.TICKET_CATEGORY_ID,
            permissionOverwrites: [
                {
                    id: guild.id, // Hide from everyone by default
                    deny: [PermissionFlagsBits.ViewChannel]
                },
                {
                    id: member.id, // Customer can see and chat
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                },
                {
                    id: CONFIG.STAFF_ROLE_ID, // Staff can see and chat
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory,
                        PermissionFlagsBits.ManageMessages
                    ]
                },
                {
                    id: client.user.id, // Bot needs access too
                    allow: [
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.ReadMessageHistory
                    ]
                }
            ]
        });

        // Build items list for the embed
        const itemsList = items.map(item =>
            `• **${item.name}** x${item.quantity} — ${item.price.toLocaleString()} tokens`
        ).join('\n');

        // Build the order embed
        const embed = new EmbedBuilder()
            .setTitle('🛒 New Order — Vloxora')
            .setColor(0xec4899)
            .addFields(
                { name: '👤 Customer', value: `${member} (@${member.user.username})`, inline: false },
                { name: '📦 Items Ordered', value: itemsList, inline: false },
                { name: '💰 Total', value: `${total.toLocaleString()} tokens`, inline: true },
                { name: '🆔 Order ID', value: `#${ticketNumber}`, inline: true },
                { name: '📅 Date', value: new Date().toLocaleDateString('en-US', { month: 'long', day: 'numeric', year: 'numeric' }), inline: true }
            )
            .setFooter({ text: 'Vloxora Shop • Vloxy JR' })
            .setTimestamp();

        // Ping staff and customer, show the order embed
        await channel.send({
            content: `<@&${CONFIG.STAFF_ROLE_ID}> ${member} — new order incoming!`,
            embeds: [embed]
        });

        // Welcome message for the customer
        await channel.send({
            content: `Hey ${member}! 👋\n\nThanks for your order! A staff member will be with you shortly to complete your transaction.\n\n**Here's what happens next:**\n1. Staff will verify and confirm your order\n2. Payment/trade will be arranged\n3. You'll receive your items in-game\n\nPlease stay in this channel and wait for a staff member. If you have any questions just ask here!`
        });

        console.log(`✅ Ticket created: #${channelName} for ${member.user.username}`);

        res.json({
            success: true,
            channelId: channel.id,
            channelName: channel.name,
            ticketNumber
        });

    } catch (error) {
        console.error('❌ Error creating ticket:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// CLOSE TICKET ENDPOINT (staff can call this to delete channel)
// ═══════════════════════════════════════════════════════════

app.post('/close-ticket', async (req, res) => {
    try {
        if (req.headers.authorization !== `Bearer ${CONFIG.API_SECRET}`) {
            return res.status(401).json({ error: 'Unauthorized' });
        }

        const { channelId } = req.body;
        const guild = await client.guilds.fetch(CONFIG.GUILD_ID);
        const channel = await guild.channels.fetch(channelId);

        if (!channel) {
            return res.status(404).json({ error: 'Channel not found' });
        }

        await channel.send('✅ This ticket has been marked as complete and will be closed.');
        await new Promise(r => setTimeout(r, 3000));
        await channel.delete();

        res.json({ success: true });
    } catch (error) {
        console.error('❌ Error closing ticket:', error);
        res.status(500).json({ error: error.message });
    }
});

// ═══════════════════════════════════════════════════════════
// HEALTH CHECK
// ═══════════════════════════════════════════════════════════

app.get('/health', (req, res) => {
    res.json({
        status: 'online',
        bot: client.user?.tag || 'not ready',
        uptime: process.uptime()
    });
});

// ═══════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`🌐 Vloxy JR API running on port ${PORT}`);
});

client.login(process.env.DISCORD_TOKEN);
