const { Telegraf, Markup } = require('telegraf');
const { TelegramClient, Logger } = require('telegram');
const { StringSession } = require('telegram/sessions');

// Silence MTProto logs to keep terminal clean
Logger.setLevel("none");
const config = require('./config');
const db = require('./database');
const logger = require('./logger');
const { startAutoScraper, startCleanupLoop } = require('./scraper');
const http = require('http');

// Button Spam rokne ke liye active users ka record
const activeUsers = new Set();

// Validate environment variables
if (!config.BOT_TOKEN) {
  console.error('❌ BOT_TOKEN is required!');
  process.exit(1);
}

if (!config.MONGO_URI) {
  console.error('❌ MONGO_URI is required!');
  process.exit(1);
}

if (!config.CHANNEL_ID) {
  console.error('❌ CHANNEL_ID is required!');
  process.exit(1);
}

// Initialize bot
const bot = new Telegraf(config.BOT_TOKEN);
logger.setBot(bot);

// ============ KEYBOARDS ============

const mainKeyboard = () => {
  return Markup.keyboard([
    ['📊 Stats', '📢 Channel', '▶️ Next Video']
  ]).resize();
};

// Inline keyboard attach karne ke liye for seamless next video
const nextVideoKeyboard = Markup.inlineKeyboard([
  Markup.button.callback('▶️ Next Video', 'next')
]);

// ============ COMMANDS ============

bot.start(async (ctx) => {
  try {
    const user = ctx.from;
    await db.addUser(user.id, user.username, user.first_name);

    const stats = await db.getGlobalStats();

    await ctx.reply(
      `🎬 *Welcome to Video Bot!*\n\n` +
      `📹 Total Videos: ${stats.totalVideos}\n` +
      `👥 Total Users: ${stats.totalUsers}\n` +
      `👁 Total Views: ${stats.totalViews}\n\n` +
      `Click "Next Video" to watch 👇`,
      {
        parse_mode: 'Markdown',
        ...mainKeyboard()
      }
    );
  } catch (error) {
    logger.error('Start command error', error);
    await ctx.reply('❌ An error occurred. Please try again.');
  }
});

bot.command('admin', async (ctx) => {
  try {
    if (!config.ADMIN_IDS.includes(ctx.from.id)) {
      return;
    }

    const stats = await db.getGlobalStats();

    await ctx.reply(
      `🔐 *Admin Panel*\n\n` +
      `📹 Total Videos: ${stats.totalVideos}\n` +
      `👥 Total Users: ${stats.totalUsers}\n` +
      `👁 Total Views: ${stats.totalViews}\n\n` +
      `🤖 Bot is running on Render.com\n` +
      `⏰ Scrape interval: ${config.SCRAPE_INTERVAL_MIN} min`,
      { parse_mode: 'Markdown' }
    );
  } catch (error) {
    logger.error('Admin command error', error);
  }
});

bot.command('help', async (ctx) => {
  await ctx.reply(
    `📖 *How to use this bot:*\n\n` +
    `1️⃣ Click "Next Video" button\n` +
    `2️⃣ Watch the video\n` +
    `3️⃣ Click again for next video\n\n` +
    `🔄 New videos added automatically every ${config.SCRAPE_INTERVAL_MIN} minutes\n\n` +
    `📢 Join our channel: ${config.CHANNEL_USERNAME}`,
    { parse_mode: 'Markdown' }
  );
});

// ============ TEXT HANDLERS (for Reply Keyboard) ============

bot.hears('▶️ Next Video', async (ctx) => {
  try {
    const video = await db.getNextUnseenVideo(ctx.from.id);

    if (!video) {
      const userStats = await db.getUserStats(ctx.from.id);
      // If user has watched videos before, it means they've seen them all.
      if (userStats && userStats.totalVideosWatched > 0) {
        await ctx.reply(
          '🎉 Congratulations! You have watched all available videos.\n\nNew videos are added regularly, so check back later!'
        );
      } else {
        await ctx.reply(
          '⏳ No videos available yet!\nBot is scraping... Check back in a few minutes!'
        );
      }
      return;
    }

    const caption =
      `🎬 ${video.title}\n` +
      `📦 ${video.sizeMb.toFixed(1)} MB\n` +
      `👁 ${video.views} views\n\n` +
      `${config.CHANNEL_USERNAME}`;

    const isOldStringId = isNaN(parseInt(video.fileId)) || !/^\d+$/.test(video.fileId);

    if (isOldStringId) {
      await ctx.telegram.sendVideo(ctx.chat.id, video.fileId, {
        caption,
        supports_streaming: true,
        ...nextVideoKeyboard
      });
    } else {
      // 2GB MTProto files are copied directly from the channel
      await ctx.telegram.copyMessage(ctx.chat.id, config.CHANNEL_ID, parseInt(video.fileId), {
        caption,
        ...nextVideoKeyboard
      });
    }

    await db.markVideoSeen(ctx.from.id, video._id);
  } catch (error) {
    logger.error('Next video text error', error);
    await ctx.reply('❌ Error sending video. Please try again!');
  }
});

bot.hears('📊 Stats', async (ctx) => {
  try {
    const stats = await db.getGlobalStats();
    const userStats = await db.getUserStats(ctx.from.id);

    const message =
      `📊 *Global Stats*\n` +
      `📹 Videos: ${stats.totalVideos}\n` +
      `👥 Users: ${stats.totalUsers}\n` +
      `👁 Views: ${stats.totalViews}\n\n` +
      `*Your Stats*\n` +
      `🎬 Watched: ${userStats?.totalVideosWatched || 0} videos`;

    await ctx.reply(message, { parse_mode: 'Markdown' });
  } catch (error) {
    logger.error('Stats text error', error);
    await ctx.reply('📊 Stats not available');
  }
});

bot.hears('📢 Channel', async (ctx) => {
  const channelLink = config.CHANNEL_USERNAME.startsWith('@')
    ? config.CHANNEL_USERNAME.substring(1)
    : config.CHANNEL_USERNAME;

  await ctx.reply(
    `📢 Join our official channel for more updates:\nhttps://t.me/${channelLink}`,
    { disable_web_page_preview: false }
  );
});

// ============ CALLBACK HANDLERS ============

bot.action('next', async (ctx) => {
  try {
    // Agar user double click karta hai, toh limit lagao (Crash rokne ke liye)
    if (activeUsers.has(ctx.from.id)) {
      return ctx.answerCbQuery('⏳ Wait thoda... Video load ho raha hai!', { show_alert: false });
    }
    activeUsers.add(ctx.from.id);

    await ctx.answerCbQuery();

    const video = await db.getNextUnseenVideo(ctx.from.id);

    if (!video) {
      const userStats = await db.getUserStats(ctx.from.id);
      // If user has watched videos before, it means they've seen them all.
      if (userStats && userStats.totalVideosWatched > 0) {
        await ctx.answerCbQuery(
          '🎉 You have watched all available videos! Check back later.',
          { show_alert: true }
        );
      } else {
        await ctx.answerCbQuery(
          '⏳ No videos available yet! Bot is scraping... Check back in a few minutes!',
          { show_alert: true }
        );
      }
      return;
    }

    const caption =
      `🎬 ${video.title}\n` +
      `📦 ${video.sizeMb.toFixed(1)} MB\n` +
      `👁 ${video.views} views\n\n` +
      `${config.CHANNEL_USERNAME}`;

    const isOldStringId = isNaN(parseInt(video.fileId)) || !/^\d+$/.test(video.fileId);

    if (isOldStringId) {
      await ctx.telegram.sendVideo(ctx.chat.id, video.fileId, {
        caption,
        supports_streaming: true,
        ...nextVideoKeyboard
      });
    } else {
      await ctx.telegram.copyMessage(ctx.chat.id, config.CHANNEL_ID, parseInt(video.fileId), {
        caption,
        ...nextVideoKeyboard
      });
    }

    await db.markVideoSeen(ctx.from.id, video._id);

    // Delete the button message
    try {
      await ctx.deleteMessage();
    } catch (e) {
      // Ignore if message already deleted
    }

  } catch (error) {
    logger.error('Next video error', error);

    if (error.message.includes('file_id')) {
      await ctx.answerCbQuery(
        '❌ Video file not found. Bot will scrape new videos soon!',
        { show_alert: true }
      );
    } else {
      await ctx.answerCbQuery(
        '❌ Error sending video. Please try again!',
        { show_alert: true }
      );
    }
  } finally {
    activeUsers.delete(ctx.from.id);
  }
});

bot.action('stats', async (ctx) => {
  try {
    const stats = await db.getGlobalStats();
    const userStats = await db.getUserStats(ctx.from.id);

    const message =
      `📊 *Global Stats*\n` +
      `📹 Videos: ${stats.totalVideos}\n` +
      `👥 Users: ${stats.totalUsers}\n` +
      `👁 Views: ${stats.totalViews}\n\n` +
      `*Your Stats*\n` +
      `🎬 Watched: ${userStats?.totalVideosWatched || 0} videos`;

    await ctx.answerCbQuery(message, { show_alert: true });
  } catch (error) {
    logger.error('Stats error', error);
    await ctx.answerCbQuery('📊 Stats not available', { show_alert: true });
  }
});

// ============ ERROR HANDLING ============

bot.catch((err, ctx) => {
  logger.error(`Unhandled error for ${ctx.updateType}`, err);
});

process.on('unhandledRejection', (reason, promise) => {
  logger.error('Unhandled promise rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', async (error) => {
  
  // Failsafe timer: Agar Telegram send message me atak jaye toh 3 sec me exit kar dega
  const exitTimer = setTimeout(() => process.exit(1), 3000);
  
  try {
    if (config.LOG_CHANNEL_ID) {
      await bot.telegram.sendMessage(
        config.LOG_CHANNEL_ID,
        `🚨 <b>BOT CRASHED!</b>\nProcess is restarting automatically on Render...\n\n<b>Error:</b> ${error.message}`,
        { parse_mode: 'HTML' }
      );
    }
  } finally {
    clearTimeout(exitTimer);
    process.exit(1);
  }
});

// ============ START BOT ============

const start = async () => {
  try {
    // ⚡ START WEB SERVER IMMEDIATELY FOR LIGHTNING FAST RENDER DEPLOY
    const PORT = process.env.PORT || 3000;
    const server = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200);
        res.end('OK');
        return;
      }
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Bot is running successfully on Render!\n');
    });
    server.listen(PORT, '0.0.0.0');

    // Connect to database
    await db.connectDB();

    // Configure MTProto GramJS Client

    if (!config.API_ID || !config.API_HASH) {
      throw new Error(`API_ID or API_HASH is missing from config! (ID: ${config.API_ID}, HASH: ${config.API_HASH ? 'Exists' : 'Missing'})`);
    }

    const client = new TelegramClient(new StringSession(''), parseInt(config.API_ID.toString()), config.API_HASH, {
      connectionRetries: 15,
      requestRetries: 5,
      timeout: 60000,
      autoReconnect: true
    });

    await client.start({
      botAuthToken: config.BOT_TOKEN,
    });

    // Start background tasks
    startAutoScraper(bot, client);
    startCleanupLoop();

    if (config.LOG_CHANNEL_ID) {
      await logger.log('✅ Bot started successfully and connected to log channel.');
    }

    // Launch bot
    await bot.launch({
      dropPendingUpdates: true
    });

    // Graceful shutdown
    process.once('SIGINT', () => {
      bot.stop('SIGINT');
    });

    process.once('SIGTERM', () => {
      bot.stop('SIGTERM');
    });

  } catch (error) {
    logger.error('Startup error', error);
    
    try {
      if (config.LOG_CHANNEL_ID) {
        await bot.telegram.sendMessage(
          config.LOG_CHANNEL_ID,
          `🚨 <b>STARTUP FAILED!</b>\nBot could not start properly and is restarting...\n\n<b>Error:</b> ${error.message}`,
          { parse_mode: 'HTML' }
        );
      }
    }
    
    // Delay exit slightly to allow logger to write to console
    setTimeout(() => process.exit(1), 2000);
  }
};

// Start the bot
start();
