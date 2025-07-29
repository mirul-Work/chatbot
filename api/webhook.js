// Import modul yang diperlukan
const axios = require('axios'); // Untuk membuat HTTP requests (mirip cURL)
const { createClient } = require('@vercel/kv'); // Untuk Vercel KV (pengganti chat_history.json)

// --- KELAYAKAN API (Diambil dari Environment Variables) ---
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN; // Tidak digunakan dalam bot WhatsApp ini, tapi kekalkan
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;     // Tidak digunakan
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.0-flash'; // Default model

const ULTRAMSG_API_TOKEN = process.env.ULTRAMSG_API_TOKEN;
const ULTRAMSG_INSTANCE_ID = process.env.ULTRAMSG_INSTANCE_ID;

// --- KONFIGURASI VERSEL KV ---
// Kredensial KV akan dijana secara automatik oleh Vercel apabila anda menyambung KV Store
const kv = createClient({
  url: process.env.VERCEL_KV_URL,
  token: process.env.VERCEL_KV_REST_API_TOKEN,
});


// --- NOMBOR TELEFON DIBENARKAN (Hardcoded) ---
// Gantikan dengan nombor telefon WhatsApp yang anda benarkan.
// Gunakan format bersih tanpa '@c.us' atau '+', contoh: '60123456789'
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


// --- FUNGSI LOGGING (Guna console.log untuk Vercel logs) ---
function logMessage(level, message) {
    const timestamp = new Date().toISOString();
    console.log(`[${timestamp}] [${level}] ${message}`);
}

// --- FUNGSI MANIPULASI CHAT HISTORY (Guna Vercel KV) ---
async function getWhatsAppUserChatHistory(userId) {
    try {
        const history = await kv.get(`chat_history:${userId}`);
        return history && Array.isArray(history.messages) ? history.messages : [];
    } catch (error) {
        logMessage('ERROR', `Failed to load chat history for ${userId} from KV: ${error.message}`);
        return [];
    }
}

async function addWhatsAppMessageToHistory(userId, messageText, role) {
    try {
        let history = await kv.get(`chat_history:${userId}`);
        history = history && Array.isArray(history.messages) ? history.messages : [];

        const maxMessages = 20;
        const newMessage = {
            timestamp: new Date().toISOString(),
            role: role,
            message_text: messageText
        };

        history.push(newMessage);

        if (history.length > maxMessages) {
            history = history.slice(history.length - maxMessages);
        }

        await kv.set(`chat_history:${userId}`, { messages: history });
        logMessage('INFO', `Message added to KV history for ${userId}. Current history length: ${history.length}`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to add message to KV history for ${userId}: ${error.message}`);
        return false;
    }
}

async function clearWhatsAppUserChatHistory(userId) {
    try {
        await kv.del(`chat_history:${userId}`);
        logMessage('INFO', `Chat history cleared for ${userId} in KV.`);
        return true;
    } catch (error) {
        logMessage('ERROR', `Failed to clear chat history for ${userId} in KV: ${error.message}`);
        return false;
    }
}


// --- FUNGSI ESCAPE UNTUK WHATSAPP ---
function escapeWhatsAppText(text) {
    // WhatsApp API (UltraMsg) biasanya lebih mudah, tidak memerlukan escape serumit Telegram MarkdownV2.
    // Karakter seperti `.` tidak perlu di-escape.
    // Jika anda menggunakan formatting *bold* atau _italic_ dalam teks, ia akan berfungsi terus.
    return text;
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
    logMessage('DEBUG', `Loaded ${chatHistory.length} messages from KV history for user ID ${userId}.`);

    contents.push({ role: 'user', parts: [{ text: promptText }] });

    const payload = { contents: contents };

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/json' },
            timeout: 30000 // 30 seconds timeout
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

// --- Fungsi untuk menghantar mesej teks ke UltraMsg (WhatsApp) ---
async function sendUltraMsgMessage(toPhoneNumber, text, replyToMessageId = null) {
    logMessage('INFO', `Sending UltraMsg message to: ${toPhoneNumber}. Text: '${text}'`);
    
    const url = `https://api.ultramsg.com/${ULTRAMSG_INSTANCE_ID}/messages/chat?token=${ULTRAMSG_API_TOKEN}`; // Token di URL
    const payload = new URLSearchParams(); // Guna URLSearchParams untuk form-urlencoded
    payload.append('to', toPhoneNumber);
    payload.append('body', escapeWhatsAppText(text));

    if (replyToMessageId) {
        payload.append('replyMessageId', replyToMessageId);
    }

    try {
        const response = await axios.post(url, payload, {
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            timeout: 30000 // 30 seconds timeout
        });

        const data = response.data;
        if (data.sent === 'false') { // UltraMsg returns sent: 'true' or 'false'
            logMessage('ERROR', `Failed to send UltraMsg message to ${toPhoneNumber}. Details: ${data.error || 'Unknown error'}`);
        } else {
            logMessage('INFO', `UltraMsg message sent successfully to ${toPhoneNumber}. ID: ${data.id || 'N/A'}`);
        }
        return data;
    } catch (error) {
        logMessage('ERROR', `UltraMsg API request failed: ${error.message || error}`);
        if (error.response) {
            logMessage('ERROR', `UltraMsg API error response data: ${JSON.stringify(error.response.data)}`);
        }
        return { sent: 'false', error: `Network error: ${error.message}` };
    }
}


// -----------------------------------------------------------
// FUNGSI UTAMA UNTUK MENGENDALIKAN PERMINTAAN WEBHOOK
// -----------------------------------------------------------
module.exports = async (req, res) => {
    // Pastikan ini adalah permintaan POST
    if (req.method !== 'POST') {
        logMessage('WARNING', `Received non-POST request: ${req.method}`);
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }

    const update = req.body; // Vercel secara automatik parse JSON body
    logMessage('INFO', `Received UltraMsg Update. Raw data: ${JSON.stringify(update)}`);

    // Pastikan ini adalah update yang sah dari UltraMsg
    if (!update || !update.event_type || !update.data) {
        logMessage('WARNING', 'Invalid UltraMsg update format received.');
        return res.status(200).json({ status: 'ok', message: 'Not a valid UltraMsg update.' });
    }

    const fromPhoneNumberWithSuffix = update.data.from;
    const messageTextUltramsg = update.data.body;
    const messageIdUltramsg = update.data.id;
    const messageTypeUltramsg = update.data.type;

    let fromPhoneNumberClean = null;
    if (fromPhoneNumberWithSuffix) {
        const parts = fromPhoneNumberWithSuffix.split('@');
        fromPhoneNumberClean = parts[0];
    }

    const currentWhatsAppUserId = fromPhoneNumberClean;

    if (!currentWhatsAppUserId) {
        logMessage('WARNING', 'No sender phone number found in UltraMsg update.');
        return res.status(200).json({ status: 'ok', message: 'No sender phone number found.' });
    }

    // --- SEMAK NOMBOR DIBENARKAN ---
    if (!ALLOWED_NUMBERS.includes(currentWhatsAppUserId)) {
        logMessage('WARNING', `Mesej dari nombor TIDAK DIBENARKAN: ${currentWhatsAppUserId}. Mengabaikan mesej.`);
        return res.status(200).json({ status: 'ok', message: 'Nombor tidak dibenarkan.' }); // Terus keluar, abaikan sepenuhnya
    }

    logMessage('INFO', `Processing message from WhatsApp User ID: ${currentWhatsAppUserId}`);

    const effectiveAiRules = AI_RULES; // Dari hardcoded global const
    const effectiveAiPersonality = AI_PERSONALITY; // Dari hardcoded global const

    let responseText = "Maaf, saya tak faham mesej jenis ni. Tolong hantar teks biasa je. 😉";

    if (messageTypeUltramsg === 'chat' && messageTextUltramsg) {
        logMessage('INFO', `WhatsApp User text message: '${messageTextUltramsg}'`);
        if (messageTextUltramsg.toLowerCase().startsWith('/start') || messageTextUltramsg.toLowerCase().startsWith('/hello')) {
            responseText = "Hai! Saya bot AI WhatsApp you. Apa yang saya boleh bantu?";
        } else if (messageTextUltramsg.toLowerCase().startsWith('/clear_chat')) {
            const success = await clearWhatsAppUserChatHistory(currentWhatsAppUserId);
            if (success) {
                responseText = "Sejarah chat you dah dikosongkan. Jom start fresh.";
                logMessage('INFO', `WhatsApp chat history cleared for user ID ${currentWhatsAppUserId}.`);
            } else {
                responseText = "Maaf, tak dapat kosongkan sejarah chat you sekarang.";
                logMessage('ERROR', `Failed to clear WhatsApp chat history for user ID ${currentWhatsAppUserId}.`);
            }
        } else {
            responseText = await getGeminiResponse(messageTextUltramsg, effectiveAiRules, effectiveAiPersonality, currentWhatsAppUserId);
        }
    } else if (['image', 'video', 'document', 'location'].includes(messageTypeUltramsg)) {
        logMessage('INFO', `WhatsApp User sent a ${messageTypeUltramsg} message.`);
        responseText = "I dah terima media/lokasi you. Tapi buat masa ni I hanya boleh reply mesej teks biasa je. Sorry tau! 😉";
    } else {
        logMessage('INFO', `WhatsApp User sent an unsupported message type: ${messageTypeUltramsg}.`);
        responseText = "Maaf, saya tak faham mesej jenis ni. Tolong hantar teks biasa je buat masa ni. 😉";
    }

    const ultramsgResponse = await sendUltraMsgMessage(fromPhoneNumberClean, responseText, messageIdUltramsg);

    if (ultramsgResponse.sent === 'false') {
        logMessage('ERROR', `Final UltraMsg response failed to send to ${fromPhoneNumberClean}. Details: ${JSON.stringify(ultramsgResponse)}`);
    } else {
        logMessage('INFO', `Final UltraMsg response sent successfully to ${fromPhoneNumberClean}.`);
    }

    return res.status(200).json({ status: 'ok', message: 'Update processed' });
};