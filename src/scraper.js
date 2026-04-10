const axios = require('axios');
const { Api } = require('telegram');
const fs = require('fs');
const cheerio = require('cheerio');
const { HttpsProxyAgent } = require('https-proxy-agent');
const path = require('path');
const crypto = require('crypto');
const PQueue = require('p-queue').default;
const config = require('./config');
const db = require('./database');
const logger = require('./logger');

// Create temp directory
if (!fs.existsSync(config.TEMP_DIR)) {
  fs.mkdirSync(config.TEMP_DIR, { recursive: true });
} else {
  // Cleanup temp directory on startup
  fs.readdirSync(config.TEMP_DIR).forEach(file => {
    fs.unlinkSync(path.join(config.TEMP_DIR, file));
  });
}

// Download queue with concurrency control
const downloadQueue = new PQueue({
  concurrency: config.CONCURRENT_DOWNLOADS
});

// ============ HELPER FUNCTIONS ============

const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Proxy Agent handle
const proxyAgent = config.PROXY_URL ? new HttpsProxyAgent(config.PROXY_URL) : null;
if (proxyAgent) logger.log('🌐 Proxy support enabled');

const normalizeUrl = (url) => {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // Remove query params that often change but same content
    parsed.search = '';
    // Remove trailing slash
    return parsed.toString().replace(/\/$/, '');
  } catch (e) {
    return url.replace(/\/$/, '');
  }
};

// ============ HOMEPAGE SCRAPING ============

const getVideoLinks = async () => {
  const urls = new Set();
  let page = 1;
  let emptyPagesCount = 0; // Stop condition for deep scraping

  try {
    logger.log('🕵️‍♂️ Starting DEEP scrape of the website... (Scanning every page)');
    while (true) {
      // Safe break limit to prevent literal infinite loops (can be increased)
      if (page > 5000) break;

      let url = config.SOURCE_SITE;
      if (page > 1) {
        if (url.includes('?')) {
          url = `${url}&page=${page}`;
        } else {
          url = `${url}/page/${page}/`;
        }
      }

      let foundOnPage = 0;
      const { data } = await axios.get(url, {
        headers: config.HEADERS,
        timeout: config.TIMEOUT,
        maxRedirects: 10,
        httpsAgent: proxyAgent,
        httpAgent: proxyAgent
      });

      const $ = cheerio.load(data);
      $('a').each((i, el) => {
        let foundUrl = $(el).attr('href');
        if (foundUrl && (foundUrl.includes('/video/') || foundUrl.includes('/watch/') || foundUrl.match(/\/\d+\/.+\.html/))) {
          if (foundUrl.startsWith('/')) {
            const baseUrl = new URL(config.SOURCE_SITE).origin;
            foundUrl = baseUrl + foundUrl;
          }
          const cleanUrl = normalizeUrl(foundUrl);
          if (!urls.has(cleanUrl)) {
            urls.add(cleanUrl);
            foundOnPage++;
          }
        }
      });

      // If no new videos found on this page, it means we reached the end
      if (foundOnPage === 0) {
        emptyPagesCount++;
        if (emptyPagesCount >= 2) {
          logger.log(`🛑 Reached end of website. Stopping pagination at page ${page}.`);
          break;
        }
      } else {
        emptyPagesCount = 0;
      }

      if (page % 5 === 0) {
        logger.log(`📄 Scraped ${page} pages... Found ${urls.size} unique links so far.`);
      }

      page++;
      // Anti-ban & RAM protection: Sleep 2 seconds before next page
      await sleep(2000);
    }
  } catch (error) {
    if (error.response && error.response.status === 404) {
      logger.log(`🛑 Reached 404 on page ${page}. Pagination finished.`);
    } else {
      logger.error(`Homepage scraping error on page ${page}`, error);
    }
  }

  const result = Array.from(urls);
  logger.log(`✅ Deep scrape complete. Total unique links found: ${result.length}`);
  return result;
};

// ============ SINGLE VIDEO SCRAPING ============

const scrapeVideoInfo = async (url) => {
  let cleanUrl = normalizeUrl(url);

  try {
    const { data } = await axios.get(cleanUrl, {
      headers: config.HEADERS,
      timeout: config.TIMEOUT,
      maxRedirects: 10,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent
    });

    const $ = cheerio.load(data);
    let title = $('meta[property="og:title"]').attr('content') || $('title').text() || 'Unknown Video';
    title = title.split('–')[0].split('|')[0].trim().substring(0, 100);
    let thumbnail = $('meta[property="og:image"]').attr('content') || $('video').attr('poster') || null;

    const videoPatterns = [
      /source\s+src=['"]([^'"]+\.mp4[^'"]*)['"]/i,
      /['"](?:file|url|src)['"]\s*:\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i,
      /video_url\s*=\s*['"](https?:\/\/[^'"]+\.mp4[^'"]*)['"]/i,
      /video_url\s*:\s*['"]([^'"]+)['"]/i,
      /html5_video_file['"]?\s*:\s*['"]([^'"]+)['"]/i,
      /['"](https?:\/\/[^'"]+\.mp4\?[^'"]+)['"]/i, // Links with tokens
      /['"](https?:\/\/[^'"]+\.mp4)['"]/i           // Any direct mp4 link
    ];

    let directUrl = null;
    for (const pattern of videoPatterns) {
      const match = data.match(pattern);
      if (match) {
        directUrl = match[1].replace(/\\\//g, '/');
        break;
      }
    }

    if (!directUrl) {
      const sourceSrc = $('source[type="video/mp4"]').attr('src') || $('video source').attr('src');
      if (sourceSrc) directUrl = sourceSrc;
    }

    if (!directUrl) {
      logger.log(`⚠️ No direct video URL found: ${url}`);
      return null;
    }

    if (directUrl.startsWith('/')) {
      const baseUrl = new URL(cleanUrl).origin;
      directUrl = baseUrl + directUrl;
    }

    // Check file size
    const headResponse = await axios.head(directUrl, {
      headers: config.HEADERS,
      timeout: 15000,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent
    }).catch(() => null);

    const sizeBytes = headResponse && headResponse.headers['content-length'] ? parseInt(headResponse.headers['content-length']) : 0;
    const sizeMb = sizeBytes > 0 ? sizeBytes / (1024 * 1024) : 10;

    if (sizeMb > config.MAX_SIZE_MB) {
      logger.log(`⚠️ Too large (${sizeMb.toFixed(1)}MB): ${title}`);
      return null;
    }

    if (sizeBytes > 0 && sizeMb < 1) {
      logger.log(`⚠️ Too small (${sizeMb.toFixed(1)}MB): ${title}`);
      return null;
    }

    return {
      url,
      title,
      directUrl,
      sizeMb,
      thumbnail
    };

  } catch (error) {
    if (error.code === 'ECONNABORTED') {
      logger.log(`⏱️ Timeout scraping page: ${url}`);
    } else {
      logger.error(`Scrape error for ${url}`, error);
    }
    return null;
  }
};

// ============ DOWNLOAD & UPLOAD ============

const downloadVideo = async (bot, directUrl, filepath, videoInfo, statusMsgId = null) => {
  const writer = fs.createWriteStream(filepath);
  let lastUpdate = 0;

  try {
    const response = await axios({
      url: directUrl,
      method: 'GET',
      headers: config.HEADERS,
      responseType: 'stream',
      timeout: 300000, // 5 minutes
      maxRedirects: 5,
      httpsAgent: proxyAgent,
      httpAgent: proxyAgent
    });

    const totalLength = parseInt(response.headers['content-length'] || '0');
    let downloadedLength = 0;

    response.data.on('data', (chunk) => {
      downloadedLength += chunk.length;
      if (totalLength > 0) {
        const percent = ((downloadedLength / totalLength) * 100).toFixed(1);
        const now = Date.now();

        // Update Telegram every 5 seconds to avoid rate limits
        if (statusMsgId && now - lastUpdate > 5000) {
          bot.telegram.editMessageText(
            config.CHANNEL_ID,
            statusMsgId,
            null,
            `⏳ *Downloading:* ${videoInfo.title.substring(0, 50)}...\n📊 *Progress:* ${percent}%`,
            { parse_mode: 'Markdown' }
          ).catch(() => { }); // Ignore edit errors
          lastUpdate = now;
        }
      }
    });

    response.data.pipe(writer);

    return new Promise((resolve, reject) => {
      writer.on('finish', () => {
        resolve(true);
      });
      writer.on('error', (err) => {
        writer.destroy(); // Free up Render RAM / File Handles
        reject(err);
      });
      response.data.on('error', (err) => {
        writer.destroy();
        reject(err);
      });

      // Timeout safety
      setTimeout(() => {
        writer.destroy();
        reject(new Error('Download timeout'));
      }, 300000);
    });
  } catch (error) {
    writer.destroy();
    throw error;
  }
};

const uploadToTelegram = async (bot, client, filepath, videoInfo, statusMsgId = null) => {
  const caption = `🎬 ${videoInfo.title}\n📦 ${videoInfo.sizeMb.toFixed(1)} MB\n\n${config.CHANNEL_USERNAME}`;
  let lastUpdate = 0;

  try {
    // Send file using GramJS Client
    // This allows uploading files up to 2000 MB!
    const message = await client.sendFile(BigInt(config.CHANNEL_ID), {
      file: filepath,
      caption: caption,
      workers: 4,
      supportsStreaming: true,
      attributes: [
        new Api.DocumentAttributeVideo({
          duration: 0,
          w: 0,
          h: 0,
          supportsStreaming: true,
        }),
      ],
      progressCallback: (progress) => {
        const percent = (progress * 100).toFixed(1);
        const now = Date.now();
        // Update Telegram every 5 seconds
        if (statusMsgId && now - lastUpdate > 5000) {
          bot.telegram.editMessageText(
            config.CHANNEL_ID,
            statusMsgId,
            null,
            `📤 *Uploading:* ${videoInfo.title.substring(0, 50)}...\n📊 *Progress:* ${percent}%`,
            { parse_mode: 'Markdown' }
          ).catch(() => { });
          lastUpdate = now;
        }
      }
    });

    // GramJS returns a message object. We store the message ID in the DB
    return { file_id: message.id.toString(), duration: 0 };
  } catch (error) {
    logger.error('Telegram upload error', error);
    throw error;
  }
};

const processVideo = async (bot, client, videoInfo) => {
  const fileHash = crypto
    .createHash('md5')
    .update(videoInfo.url)
    .digest('hex')
    .substring(0, 10);

  const filepath = path.join(config.TEMP_DIR, `${fileHash}.mp4`);
  let statusMsg = null;

  try {
    // Create initial status message on Telegram
    try {
      statusMsg = await bot.telegram.sendMessage(
        config.CHANNEL_ID,
        `⏳ *Preparing:* ${videoInfo.title.substring(0, 50)}...`,
        { parse_mode: 'Markdown' }
      );
    } catch (e) {
      logger.error('Failed to send initial status message', e);
    }

    logger.log(`[1/3] ⏳ Downloading: ${videoInfo.title}`);

    await downloadVideo(bot, videoInfo.directUrl, filepath, videoInfo, statusMsg?.message_id);

    // Verify file exists and has size
    if (!fs.existsSync(filepath)) {
      throw new Error('Downloaded file not found');
    }

    const fileSize = fs.statSync(filepath).size;
    if (fileSize < 1024) {
      throw new Error('Downloaded file too small');
    }

    logger.log(`[2/3] 📤 Uploading: ${videoInfo.title}`);

    const video = await uploadToTelegram(bot, client, filepath, videoInfo, statusMsg?.message_id);

    // Save to database
    await db.addVideo({
      url: videoInfo.url,
      title: videoInfo.title,
      fileId: video.file_id,
      sizeMb: videoInfo.sizeMb,
      thumbnail: videoInfo.thumbnail,
      duration: video.duration || 0,
      channelPosted: true
    });

    logger.log(`[3/3] ✅ Success: ${videoInfo.title}`);

    return true;

  } catch (error) {
    logger.error(`Processing failed for "${videoInfo.title}"`, error);
    return false;

  } finally {
    // Delete status message if it exists
    if (statusMsg) {
      bot.telegram.deleteMessage(config.CHANNEL_ID, statusMsg.message_id).catch(() => { });
    }

    // Cleanup
    if (fs.existsSync(filepath)) {
      try {
        fs.unlinkSync(filepath);
      } catch (e) {
        logger.error('File cleanup error', e);
      }
    }
  }
};

// ============ BATCH PROCESSING ============

const processBatch = async (bot, client, queueItems) => {
  const tasks = [];

  for (const item of queueItems) {
    try {
      // Check if already exists
      const exists = await db.videoExists(item.url);
      if (exists) {
        await db.markScrapeDone(item._id);
        continue;
      }

      // Scrape video info
      const videoInfo = await scrapeVideoInfo(item.url);

      if (!videoInfo) {
        await db.markScrapeFailed(item._id, 'Failed to scrape');
        continue;
      }

      // Secondary check: Title-based duplicate detection
      const titleExists = await db.videoTitleExists(videoInfo.title);
      if (titleExists) {
        logger.log(`⚠️ Duplicate title found, skipping: ${videoInfo.title}`);
        await db.markScrapeDone(item._id);
        continue;
      }

      // Add to download queue (respects concurrency)
      const task = downloadQueue.add(async () => {
        const success = await processVideo(bot, client, videoInfo);

        if (success) {
          await db.markScrapeDone(item._id);
        } else {
          await db.markScrapeFailed(item._id, 'Download/upload failed');
        }
      });

      tasks.push(task);

    } catch (error) {
      logger.error('Batch item processing error', error);
      await db.markScrapeFailed(item._id, error.message);
    }
  }

  // Wait for all to complete
  await Promise.all(tasks);
  await downloadQueue.onIdle();
};

// ============ MAIN SCRAPER CYCLE ============

const scraperCycle = async (bot, client) => {
  try {
    // Force cleanup before every cycle to guarantee disk space
    try {
      if (fs.existsSync(config.TEMP_DIR)) {
        const files = fs.readdirSync(config.TEMP_DIR);
        for (const file of files) {
          fs.unlinkSync(path.join(config.TEMP_DIR, file));
        }
      }
    } catch (e) { }

    const videoUrls = await getVideoLinks();

    if (videoUrls.length === 0) {
      logger.log('⚠️ Scraper cycle: No new video links found on homepage. Either site structure changed or Cloudflare is blocking.');
      return;
    }

    await db.addToScrapeQueue(videoUrls);

    // Process queue in batches
    let processedAny = false;
    while (true) {
      const batch = await db.getPendingBatch(5);

      if (batch.length === 0) {
        break;
      }

      processedAny = true;
      await processBatch(bot, client, batch);

      await sleep(3000);
    }

    if (processedAny) logger.log('✅ Scraper cycle completed.');

  } catch (error) {
    logger.error('Scraper cycle failed', error);
  }
};

// ============ AUTO SCRAPER LOOP ============

const startAutoScraper = (bot, client) => {
  logger.log(`🤖 Auto scraper started. Interval: ${config.SCRAPE_INTERVAL_MIN} min.`);

  const runCycle = async () => {
    try {
      await scraperCycle(bot, client);
      await db.cleanupOldQueue();
    } catch (error) {
      logger.error('Auto-scraper loop error (will retry)', error);
    }

    // Schedule next cycle
    const interval = config.SCRAPE_INTERVAL_MIN * 60 * 1000;
    setTimeout(runCycle, interval);
  };

  // Start after 10 seconds
  setTimeout(runCycle, 10000);
};

// ============ CLEANUP LOOP ============

const startCleanupLoop = () => {
  setInterval(() => {
    try {
      if (fs.existsSync(config.TEMP_DIR)) {
        const files = fs.readdirSync(config.TEMP_DIR);

        for (const file of files) {
          const filepath = path.join(config.TEMP_DIR, file);
          const stats = fs.statSync(filepath);

          // Delete files older than 1 hour
          const age = Date.now() - stats.mtimeMs;
          if (age > 60 * 60 * 1000) {
            fs.unlinkSync(filepath);
          }
        }

        if (files.length > 0) {
          logger.log(`🧹 Temp directory cleanup: Found ${files.length} leftover files. Deleting files older than 1 hour.`);
        }
      }
    } catch (error) {
      logger.error('Temp directory cleanup loop error', error);
    }
  }, 60 * 60 * 1000); // Every hour
};

module.exports = {
  startAutoScraper,
  startCleanupLoop
};
