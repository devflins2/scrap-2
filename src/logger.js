const config = require('./config');

let bot = null;

/**
 * Initializes the logger with the Telegraf bot instance.
 * @param {import('telegraf').Telegraf} botInstance 
 */
function setBot(botInstance) {
    bot = botInstance;
}

/**
 * Sends a log message to the configured Telegram log channel.
 * If no log channel is set, the message is ignored to keep console clean.
 * @param {string} message The message to log.
 */
async function log(message) {
    if (bot && config.LOG_CHANNEL_ID) {
        try {
            // Truncate long messages
            const truncatedMessage = message.length > 4000 ? message.substring(0, 4000) + '...' : message;
            await bot.telegram.sendMessage(config.LOG_CHANNEL_ID, truncatedMessage, {
                parse_mode: 'HTML', // Use HTML for better formatting options if needed
                disable_web_page_preview: true
            });
        } catch (e) {
            // Fallback to console if Telegram sending fails
            // Completely silenced for Render
        }
    }
}

/**
 * Logs a critical error to both the console and the Telegram log channel.
 * @param {string} message The error message.
 * @param {Error} [err] Optional error object.
 */
function error(message, err) {
    let errorMessage = message;
    if (err) {
        errorMessage += `: ${err.message}`;
        // Agar Axios HTTP error hai toh status code add karo
        if (err.response && err.response.status) {
            errorMessage += ` (HTTP ${err.response.status})`;
        }
    }

    if (bot && config.LOG_CHANNEL_ID) {
        log(`<b>❌ ERROR</b>\n${errorMessage.replace(/</g, '&lt;').replace(/>/g, '&gt;')}`);
    }
}

module.exports = {
    setBot,
    log,
    error
};