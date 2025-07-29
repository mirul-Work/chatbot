// api/webhook.js

// Import modul yang diperlukan
const axios = require('axios');
const { Pool } = require('pg'); // Node.js Postgres client

// --- KELAYAKAN API (Diambil dari Environment Variables) ---
// Pastikan anda telah set variable ini di Vercel Dashboard -> Project Settings -> Environment Variables
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash';

const SIDOBE_API_URL = process.env.SIDOBE_API_URL; // e.g., https://api.sidobe.com/wa/v1
const SIDOBE_SECRET_KEY = process.env.SIDOBE_SECRET_KEY; // Your secret key from Sidobe dashboard

// --- NOMBOR TELEFON DIBENARKAN (Hardcoded) ---
const ALLOWED_NUMBERS = [
    '601135027311', // Contoh: NOMBOR TELEFON ANDA. Pastikan ini adalah nombor yang anda gunakan untuk menguji bot!
    '601116649357',
    '601126706771',
    '60164673962',
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
async function getWhatsAppUserChatHistory(userId) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot load chat history.');
        return [];
    }
    try {
        const result = await pgPool.query(
            `SELECT role, message_text, timestamp FROM chat_history WHERE user_id = $1 ORDER BY timestamp ASC LIMIT 20`,
            [userId]
        );
        return result.rows;
    } catch (error) {
        logMessage('ERROR', `Failed to load chat history for ${userId} from Postgres: ${error.message}`);
        return [];
    }
}

async function addWhatsAppMessageToHistory(userId, messageText, role) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot save chat history.');
        return false;
    }
    try {
        await pgPool.query(
            `INSERT INTO chat_history (user_id, role, message_text) VALUES ($1, $2, $3)`,
            [userId, role, messageText]
        );
        logMessage('INFO', `Message added to Postgres history for ${userId}.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to add message to Postgres history for ${userId}: ${error.message}`);
        return false;
    }
}

async function clearWhatsAppUserChatHistory(userId) {
    if (!pgPool) {
        logMessage('WARNING', 'Postgres client not initialized. Cannot clear chat history.');
        return false;
    }
    try {
        await pgPool.query(
            `DELETE FROM chat_history WHERE user_id = $1`,
            [userId]
        );
        logMessage('INFO', `Chat history cleared for ${userId} in Postgres.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to clear chat history for ${userId} in Postgres: ${error.message}`);
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


// --- FUNGSI ESCAPE UNTUK WHATSAPP ---
function escapeWhatsAppText(text) {
    return text; // Sidobe API mungkin tidak memerlukan escape khas untuk mesej teks biasa.
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

    const chatHistory = await getWhatsAppUserChatHistory(userId);
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
            await addWhatsAppMessageToHistory(userId, promptText, 'user');
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
                await addWhatsAppMessageToHistory(userId, promptText, 'user');
                return issueMessage;
            }
        }

        if (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts[0] && data.candidates[0].content.parts[0].text) {
            const geminiResponseText = data.candidates[0].content.parts[0].text;
            logMessage('INFO', `Gemini response received: '${geminiResponseText}'`);
            await addWhatsAppMessageToHistory(userId, promptText, 'user');
            await addWhatsAppMessageToHistory(userId, geminiResponseText, 'model');
            return geminiResponseText;
        }

        logMessage('ERROR', `Gemini API Unexpected Response or No Text: ${JSON.stringify(data)}`);
        await addWhatsAppMessageToHistory(userId, promptText, 'user');
        return "Maaf, saya tidak dapat memproses permintaan anda sekarang (Gemini Unexpected Response).";

    } catch (error) {
        await addWhatsAppMessageToHistory(userId, promptText, 'user');
        logMessage('ERROR', `Gemini API request failed: ${error.message || error}`);
        if (error.response) {
            logMessage('ERROR', `Gemini API error response data: ${JSON.stringify(error.response.data)}`);
        }
        return "Maaf, saya tidak dapat memproses permintaan anda sekarang (Gemini Network Error).";
    }
}

// --- Fungsi untuk menghantar mesej teks ke Sidobe (WhatsApp) ---
async function sendSidobeMessage(toPhoneNumber, text) {
    logMessage('INFO', `Sending Sidobe message to: ${toPhoneNumber}. Text: '${text}'`);
    
    const url = `${SIDOBE_API_URL}/send-message`; // Contoh endpoint Sidobe untuk hantar mesej
    const payload = {
        number: toPhoneNumber,
        message: escapeWhatsAppText(text),
        // Tambah API Key/Secret Key ke payload atau header bergantung pada dokumentasi Sidobe
        // Saya akan letak dalam header Authorization untuk keselamatan yang lebih baik
        // Tetapi kalau Sidobe guna GET parameter atau POST body biasa, kita kena sesuaikan
    };

    try {
        const response = await axios.post(url, payload, {
            headers: { 
                'Content-Type': 'application/json',
                'Authorization': `Bearer ${SIDOBE_SECRET_KEY}` // Andaian: Sidobe guna Bearer Token
            },
            timeout: 30000
        });

        const data = response.data;
        if (data.status === 'success' || data.sent) { // Andaian: Sidobe balas status: 'success' atau 'sent' true
            logMessage('INFO', `Sidobe message sent successfully to ${toPhoneNumber}. Response: ${JSON.stringify(data)}`);
        } else {
            logMessage('ERROR', `Failed to send Sidobe message to ${toPhoneNumber}. Details: ${data.message || data.error || 'Unknown Sidobe error'}`);
        }
        return data;
    } catch (error) {
        logMessage('ERROR', `Sidobe API request failed: ${error.message || error}`);
        if (error.response) {
            logMessage('ERROR', `Sidobe API error response data: ${JSON.stringify(error.response.data)}`);
        }
        return { status: 'error', message: `Network error: ${error.message}` };
    }
}


// -----------------------------------------------------------
// FUNGSI UTAMA UNTUK MENGENDALIKAN PERMINTAAN WEBHOOK
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
    logMessage('INFO', `Received WhatsApp Update. Raw data: ${JSON.stringify(update)}`);

    // --- PENTING: Struktur Webhook Sidobe - INI ADALAH ANDAIAN ---
    // Saya mengandaikan Sidobe menghantar data JSON yang mengandungi
    // nombor pengirim dan teks mesej. Anda mungkin perlu SESUAIKAN INI.
    // Sila semak dokumentasi Sidobe anda untuk struktur data webhook yang tepat.
    const fromPhoneNumberWithSuffix = update.from || update.data.from || null; // Andaian: 'from' field
    const messageText = update.body || update.data.body || update.message || null; // Andaian: 'body' atau 'message' field
    const messageId = update.id || update.data.id || null; // Andaian: 'id' field
    const messageType = update.type || update.data.type || 'chat'; // Andaian: 'type' field, default 'chat'


    let fromPhoneNumberClean = null;
    if (fromPhoneNumberWithSuffix) {
        const parts = fromPhoneNumberWithSuffix.split('@');
        fromPhoneNumberClean = parts[0]; // Buang '@c.us' jika ada
    }

    const currentWhatsAppUserId = fromPhoneNumberClean;

    if (!currentWhatsAppUserId) {
        logMessage('WARNING', 'No sender phone number found in WhatsApp update.');
        return res.status(200).json({ status: 'ok', message: 'No sender phone number found.' });
    }

    if (!ALLOWED_NUMBERS.includes(currentWhatsAppUserId)) {
        logMessage('WARNING', `Mesej dari nombor TIDAK DIBENARKAN: ${currentWhatsAppUserId}. Mengabaikan mesej.`);
        return res.status(200).json({ status: 'ok', message: 'Nombor tidak dibenarkan.' });
    }

    logMessage('INFO', `Processing message from WhatsApp User ID: ${currentWhatsAppUserId}`);

    const effectiveAiRules = AI_RULES;
    const effectiveAiPersonality = AI_PERSONALITY;

    let responseText = "Maaf, saya tak faham mesej jenis ni. Tolong hantar teks biasa je. 😉";

    if (messageType === 'chat' && messageText) {
        logMessage('INFO', `WhatsApp User text message: '${messageText}'`);
        if (messageText.toLowerCase().startsWith('/start') || messageText.toLowerCase().startsWith('/hello')) {
            responseText = "Hai! Saya bot AI WhatsApp you. Apa yang saya boleh bantu?";
        } else if (messageText.toLowerCase().startsWith('/clear_chat')) {
            const success = await clearWhatsAppUserChatHistory(currentWhatsAppUserId);
            if (success) {
                responseText = "Sejarah chat you dah dikosongkan. Jom start fresh.";
                logMessage('INFO', `WhatsApp chat history cleared for user ID ${currentWhatsAppUserId}.`);
            } else {
                responseText = "Maaf, tak dapat kosongkan sejarah chat you sekarang.";
                logMessage('ERROR', `Failed to clear WhatsApp chat history for user ID ${currentWhatsAppUserId}.`);
            }
        } else {
            responseText = await getGeminiResponse(messageText, effectiveAiRules, effectiveAiPersonality, currentWhatsAppUserId);
        }
    } else if (['image', 'video', 'document', 'location'].includes(messageType)) {
        logMessage('INFO', `WhatsApp User sent a ${messageType} message.`);
        responseText = "I dah terima media/lokasi you. Tapi buat masa ni I hanya boleh reply mesej teks biasa je. Sorry tau! 😉";
    } else {
        logMessage('INFO', `WhatsApp User sent an unsupported message type: ${messageType}.`);
        responseText = "Maaf, saya tak faham mesej jenis ni. Tolong hantar teks biasa je buat masa ni. 😉";
    }

    const sidobeResponse = await sendSidobeMessage(fromPhoneNumberClean, responseText); // messageId tidak disokong oleh Sidobe (buat masa ini)

    if (sidobeResponse.status === 'error' || sidobeResponse.success === false) { // Andaian: Sidobe balas {status: 'error'} atau {success: false}
        logMessage('ERROR', `Final Sidobe response failed to send to ${fromPhoneNumberClean}. Details: ${JSON.stringify(sidobeResponse)}`);
    } else {
        logMessage('INFO', `Final Sidobe response sent successfully to ${fromPhoneNumberClean}.`);
    }

    return res.status(200).json({ status: 'ok', message: 'Update processed' });
};