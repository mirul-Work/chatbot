// api/webhook_telegram.js

// Import modul yang diperlukan
const axios = require('axios');
const { Pool } = require('pg'); // Node.js Postgres client

// --- KELAYAKAN API (Diambil dari Environment Variables) ---
// Pastikan anda telah set variable ini di Vercel Dashboard -> Project Settings -> Environment Variables
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Token Bot Telegram anda
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;     // Chat ID anda untuk balasan utama (jika perlu)
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

// --- NOMBOR/ID PENGGUNA DIBENARKAN (Hardcoded untuk Telegram) ---
// Untuk Telegram, user_id adalah ID numerik, bukan nombor telefon.
// Sila GANTIKAN ini dengan ID Telegram anda yang sebenar (user ID anda, bukan chat ID).
// Anda boleh dapatkan user ID anda dari bot seperti @userinfobot di Telegram.
const ALLOWED_TELEGRAM_USER_IDS = [
    5206449238, // Contoh: GANTIKAN DENGAN ID PENGGUNA TELEGRAM ANDA
    // Tambah ID lain jika perlu: 123456789, 987654321
];

// --- AI PERSONALITY & RULES (Hardcoded seperti yang diminta) ---
const AI_RULES = [
    "Reply MUST be short, exactly 1 line. Never exceed 1 line for any reply.",
    "Keep sentences extremely concise and direct. Every word counts.",
    "Use common shortforms (e.g., 'takpe', 'jap', 'bro', 'sis', 'dgn', 'yg', 'ngn', 'btw', 'lol', 'srsly') naturally.",
    "Keep every reply casual and real, like WhatsApp chat.",
    "Speak in Bahasa Melayu + English (Manglish).",
    "Avoid full paragraphs or formal structure — no karangan.",
    "Flirt SPARINGLY and only when the situation naturally invites it. Do NOT be overtly flirty in every reply.",
    "Maintain bad boy vibes, not nice guy vibes.",
    "Never over-explain or sound too eager.",
    "Replies should feel spontaneous, not scripted.",
    "Use light teasing, sarcasm, or confidence. Contoh: “Berani ajak I keluar? You kuat ke 😏”",
    "Use a few emojis (😏👀😂🥱) only when it naturally fits the tone or situation. Don't overuse them.",
    "Don't compliment too much. One-liner is enough. Ex: “You lawa. Tapi tu biasa je, kan?”",
    "Ask questions like a guy who’s interested but chill. Contoh: “You selalu senyum macam tu ke?” or “Tempat lepak fav you?”",
    "Sometimes give cocky/funny replies: “You stalk I ke tadi?” / “Chill lah, belum rindu lagi 😏”",
    "Don’t sound robotic, overly sweet, or cringe (avoid pickup lines).",
    "Use typing gaps/delay if possible to feel like real texting.",
    "Never say anything too deep, desperate, or needy.",
    "Act as human, make sure not like robot."
];

const AI_PERSONALITY = "You are a confident, laid-back guy with a “bad boy” charm. You speak casually in a mix of Bahasa Melayu and English, just like a real Malaysian guy texting on WhatsApp. You're bold, playful, and you enjoy teasing. Your replies are always very concise, often using shortforms, making them feel super natural and efficient like real WhatsApp texts. Your flirting is subtle and selective, only used when the context is right, not constant. You don’t try too hard to impress — your cool attitude speaks for itself. You keep your replies short, sometimes even one-liners, and you enjoy giving off mysterious, intriguing energy. You're smooth, never awkward, and you never sound like a robot. You flirt with style and confidence, always keeping it low effort, high impact, and situationally appropriate.";


// --- KONFIGURASI DATABASE POSTGRES (NEON) ---
const POSTGRES_URL = process.env.POSTGRES_URL; // Gunakan URL sambungan penuh

let pgPool;
if (POSTGRES_URL) {
    pgPool = new Pool({
        connectionString: POSTGRES_URL,
        ssl: {
            rejectUnauthorized: false, // Penting untuk sambungan ke Neon dari Vercel
        },
    });

    pgPool.on('connect', () => console.log('[INFO] Connected to Postgres!'));
    pgPool.on('error', (err) => console.error('[ERROR] Postgres Pool Error:', err));
} else {
    console.error('ERROR: POSTGRES_URL environment variable is not set. Database features will not work.');
}


// --- FUNGSI LOGGING (Guna console.log untuk Vercel logs) ---
function logMessage(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

// --- FUNGSI MANIPULASI CHAT HISTORY (Guna Postgres) ---
async function getTelegramUserChatHistory(userId) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot load chat history.');
        return [];
    }
    try {
        const result = await pgPool.query(
            `SELECT role, message_text, timestamp FROM chat_history WHERE user_id = $1 ORDER BY timestamp ASC LIMIT 20`,
            [String(userId)] // Pastikan userId adalah string untuk Postgres TEXT type
        );
        return result.rows;
    } catch (error) {
        logMessage('ERROR', `Failed to load chat history for ${userId} from Postgres: ${error.message}`);
        return [];
    }
}

async function addTelegramMessageToHistory(userId, messageText, role) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot save chat history.');
        return false;
    }
    try {
        await pgPool.query(
            `INSERT INTO chat_history (user_id, role, message_text) VALUES ($1, $2, $3)`,
            [String(userId), role, messageText] // Pastikan userId adalah string
        );
        logMessage('INFO', `Message added to Postgres history for user ID ${userId}.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to add message to Postgres history for user ID ${userId}: ${error.message}`);
        return false;
    }
}

async function clearTelegramUserChatHistory(userId) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot clear chat history.');
        return false;
    }
    try {
        await pgPool.query(
            `DELETE FROM chat_history WHERE user_id = $1`,
            [String(userId)] // Pastikan userId adalah string
        );
        logMessage('INFO', `Chat history cleared for user ID ${userId} in Postgres.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to clear chat history for user ID ${userId} in Postgres: ${error.message}`);
        return false;
    }
}

// --- FUNGSI MANIPULASI STATUS BOT (Guna Postgres) ---
async function getBotStatus() {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot load bot status.');
        return { isOn: true, error: 'DB not connected' };
    }
    try {
        const result = await pgPool.query(
            `SELECT is_on FROM bot_status WHERE status_key = 'main_bot_status'`
        );
        if (result.rows.length > 0) {
            return { isOn: result.rows[0].is_on };
        } else {
            // If status key not found, initialize it
            await pgPool.query(
                `INSERT INTO bot_status (status_key, is_on) VALUES ('main_bot_status', TRUE) ON CONFLICT (status_key) DO NOTHING`
            );
            return { isOn: true };
        }
    } catch (error) {
        logMessage('ERROR', `Failed to get bot status from Postgres: ${error.message}. Defaulting to ON.`);
        return { isOn: true, error: error.message };
    }
}

async function setBotStatus(statusBoolean) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot set bot status.');
        return false;
    }
    try {
        await pgPool.query(
            `UPDATE bot_status SET is_on = $1 WHERE status_key = 'main_bot_status'`,
            [statusBoolean]
        );
        logMessage('INFO', `Bot status set to ${statusBoolean} in Postgres.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to set bot status in Postgres: ${error.message}`);
        return false;
    }
}


// --- FUNGSI ESCAPE UNTUK MARKDOWNV2 ---
// Telegram Bot API menggunakan MarkdownV2, memerlukan escape khas
function escapeMarkdownV2(text) {
    const replacements = {
        '_': '\\_', '*' : '\\*', '[' : '\\[', ']' : '\\]', '(' : '\\(',
        ')' : '\\)', '~' : '\\~', '`' : '\\`', '>' : '\\>', '#' : '\\#',
        '+' : '\\+', '-' : '\\-', '=' : '\\=', '|' : '\\|', '{' : '\\{',
        '}' : '\\}', '.' : '\\.', '!' : '\\!'
    };
    let escapedText = text;
    for (const char in replacements) {
        escapedText = escapedText.split(char).join(replacements[char]);
    }
    return escapedText;
}


// --- Fungsi untuk berinteraksi dengan Google Gemini API ---
async function getGeminiResponse(promptText, aiRules, aiPersonality, userId) {
    logMessage('INFO', `Getting Gemini response for prompt: '${promptText}' for user ID ${userId}`);

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${GEMINI_API_KEY}`;

    const contents = [];

    if (aiPersonality) {
        contents.push({ role: 'user', parts: [{ text: 'Personality instruction: ' + aiPersonality }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood. I will adopt this personality.' }] });
    }

    if (aiRules && aiRules.length > 0) {
        const rulesString = "Rules: " + aiRules.join('\n- ');
        contents.push({ role: 'user', parts: [{ text: 'Rule instruction: ' + rulesString }] });
        contents.push({ role: 'model', parts: [{ text: 'Understood. I will adhere to these rules.' }] });
    }

    const chatHistory = await getTelegramUserChatHistory(userId);
    for (const message of chatHistory) {
        const textToAdd = message.message_text || '';
        let roleToAdd = message.role || 'user';

        if (!['user', 'model'].includes(roleToAdd)) {
            roleToAdd = 'user';
        }
        contents.push({ role: roleToAdd, parts: [{ text: textToAdd }] });
    }
    logMessage('DEBUG', `Loaded ${chatHistory.length} messages from Postgres history for user ID ${userId}.`);

    contents.push({ role: 'user', parts: [{ text: promptText }] });

    const payload = { contents: contents };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });

        const data = response.data;

        if (data.error) {
            await addTelegramMessageToHistory(userId, promptText, 'user');
            logMessage('ERROR', `Gemini API returned error: ${JSON.stringify(data)}`);
            return `Maaf, Gemini API mengembalikan ralat: ${data.error.message || 'Unknown Error'}.`;
        }

        if (data.promptFeedback && data.promptFeedback.safetyRatings) {
            const safetyIssues = [];
            for (const rating of data.promptFeedback.safetyRatings) {
                if (rating.probability !== 'NEGLIGIBLE' && rating.blocked === true) {
                    safetyIssues.push(`${rating.category} (Probability: ${rating.probability})`);
                }
            }
            if (safetyIssues.length > 0) {
                const issueMessage = `Maaf, mesej anda tidak dapat diproses kerana melanggar polisi keselamatan AI. Isu: ${safetyIssues.join(', ')}.`;
                logMessage('WARNING', `Gemini API Safety Block: ${issueMessage} Original prompt: ${promptText}`);
                await addTelegramMessageToHistory(userId, promptText, 'user');
                return issueMessage;
            }
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) {
            const geminiResponseText = data.candidates[0].content.parts[0].text;
            logMessage('INFO', `Gemini response received: '${geminiResponseText}'`);
            await addTelegramMessageToHistory(userId, promptText, 'user');
            await addTelegramMessageToHistory(userId, geminiResponseText, 'model');
            return geminiResponseText;
        }

        logMessage('ERROR', `Gemini API Unexpected Response or No Text: ${JSON.stringify(data)}`);
        await addTelegramMessageToHistory(userId, promptText, 'user');
        return "Maaf, saya tidak dapat memproses permintaan anda sekarang (Gemini Unexpected Response).";

    } catch (error) {
        await addTelegramMessageToHistory(userId, promptText, 'user');
        logMessage('ERROR', `Gemini API request failed: ${error.message || error}`);
        if (error.response) {
            logMessage('ERROR', `Gemini API error response data: ${JSON.stringify(error.response.data)}`);
        }
        return "Maaf, saya tidak dapat memproses permintaan anda sekarang (Gemini Network Error).";
    }
}

// --- Fungsi untuk menghantar mesej teks ke Telegram ---
async function sendTelegramMessage(chatId, text, parseMode = 'MarkdownV2', replyToMessageId = null) {
    logMessage('INFO', `Sending Telegram message to chat ID ${chatId}. Parse Mode: ${parseMode}. Text: '${text}'`);
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;

    let processedText = text;
    if (parseMode === 'MarkdownV2') {
        processedText = escapeMarkdownV2(text);
    }

    const payload = {
        chat_id: chatId,
        text: processedText,
        parse_mode: parseMode,
        disable_web_page_preview: true,
    };
    if (replyToMessageId) {
        payload.reply_to_message_id = replyToMessageId;
    }

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000
        });
        const data = response.data;
        if (data.ok === false) {
            logMessage('ERROR', `Failed to send Telegram message to chat ID ${chatId}. Details: ${data.description || 'Unknown error'}`);
        } else {
            logMessage('INFO', `Telegram message sent successfully to chat ID ${chatId}.`);
        }
        return data;
    } catch (error) {
        logMessage('ERROR', `Telegram API request failed: ${error.message || error}`);
        if (error.response) {
            logMessage('ERROR', `Telegram API error response data: ${JSON.stringify(error.response.data)}`);
        }
        return { ok: false, error: `Network error: ${error.message}` };
    }
}

// -----------------------------------------------------------
// PENGENDALIAN WEBHOOK TELEGRAM UTAMA
// -----------------------------------------------------------
module.exports = async (req, res) => {
    if (req.method !== 'POST') {
        logMessage('WARNING', `Received non-POST request to webhook: ${req.method}`);
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    // --- Semak Status Bot ON/OFF ---
    let isBotOn = true;
    const botStatus = await getBotStatus();
    isBotOn = botStatus.isOn;
    if (botStatus.error) {
        logMessage('WARNING', `Error getting bot status: ${botStatus.error}. Assuming bot is ON.`);
    }

    if (!isBotOn) {
        logMessage('INFO', 'Bot is currently OFF. Ignoring incoming message.');
        return res.status(200).json({ status: 'ok', message: 'Bot is OFF.' });
    }


    const update = req.body;
    logMessage('INFO', `Received Telegram Update. Raw data: ${JSON.stringify(update)}`);

    if (!update || !update.update_id) {
        logMessage('WARNING', 'Invalid Telegram update format received (no update_id).');
        return res.status(200).json({ status: 'ok', message: 'Not a valid Telegram update.' });
    }

    const chatId = update.message?.chat?.id; // Guna optional chaining
    const messageText = update.message?.text;
    const messageId = update.message?.message_id;
    const fromId = update.message?.from?.id;
    const photo = update.message?.photo;
    const document = update.message?.document;
    const location = update.message?.location;

    if (!chatId) {
        logMessage('WARNING', 'No chat ID found in Telegram update.');
        return res.status(200).json({ status: 'ok', message: 'No chat ID found.' });
    }

    logMessage('INFO', `Processing message from Chat ID: ${chatId}. From User ID: ${fromId}`);

    // --- SEMAK ID PENGGUNA DIBENARKAN ---
    if (!ALLOWED_TELEGRAM_USER_IDS.includes(fromId)) {
        logMessage('WARNING', `Mesej dari ID pengguna TIDAK DIBENARKAN: ${fromId}. Mengabaikan mesej.`);
        await sendTelegramMessage(chatId, "Maaf, anda tidak dibenarkan untuk berinteraksi dengan bot ini.", 'MarkdownV2'); // Balas sekali sahaja
        return res.status(200).json({ status: 'ok', message: 'Pengguna tidak dibenarkan.' });
    }


    const effectiveAiRules = AI_RULES;
    const effectiveAiPersonality = AI_PERSONALITY;

    let responseText = "Maaf, saya tidak faham. Sila berikan arahan yang jelas.";

    if (messageText) {
        logMessage('INFO', `Telegram User text message: '${messageText}'`);
        if (messageText.toLowerCase().startsWith('/start') || messageText.toLowerCase().startsWith('/hello')) {
            responseText = "Hai! Saya bot AI anda. Apa yang saya boleh bantu?";
        } else if (messageText.toLowerCase().startsWith('/clear_chat')) {
            const success = await clearTelegramUserChatHistory(fromId); // Gunakan fromId
            if (success) {
                responseText = "Sejarah chat anda dah dikosongkan. Jom start fresh.";
                logMessage('INFO', `Telegram chat history cleared for user ID ${fromId}.`);
            } else {
                responseText = "Maaf, tak dapat kosongkan sejarah chat anda sekarang.";
                logMessage('ERROR', `Failed to clear Telegram chat history for user ID ${fromId}.`);
            }
        } else {
            responseText = await getGeminiResponse(messageText, effectiveAiRules, effectiveAiPersonality, fromId); // Gunakan fromId
        }
    } else if (photo) {
        logMessage('INFO', `Telegram User sent a photo. File ID: ${photo[photo.length - 1]?.file_id || 'N/A'}`);
        responseText = "Dah dapat foto you! Tapi I lagi suka kalau you cerita je apa yang I nak tahu. 😉";
    } else if (location) {
        logMessage('INFO', `Telegram User sent a location. Latitude: ${location.latitude}, Longitude: ${location.longitude}`);
        responseText = "I dah tau you kat mana. 😉 Apa lagi you nak share?";
    } else if (document) {
        logMessage('INFO', `Telegram User sent a document. File Name: ${document.file_name || 'N/A'}, File ID: ${document.file_id}`);
        responseText = "Dah nampak dokumen you. Tapi I tak faham lagi content dia. Story mory je lah. 😎";
    } else {
        logMessage('INFO', `Telegram User sent an unsupported message type: ${messageType}.`); // messageType tak didefinisi
        responseText = "Maaf, saya tak faham mesej jenis ni. Tolong hantar teks, foto, dokumen, atau lokasi je buat masa ni. 😉";
    }

    const telegramResponse = await sendTelegramMessage(chatId, responseText, 'MarkdownV2', messageId);

    if (telegramResponse.ok === false) {
        logMessage('ERROR', `Final Telegram response failed to send to chat ID ${chatId}. Details: ${JSON.stringify(telegramResponse)}`);
    } else {
        logMessage('INFO', `Final Telegram response sent successfully to chat ID ${chatId}.`);
    }

    return res.status(200).json({ status: 'ok', message: 'Update processed' });
};