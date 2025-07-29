// api/status.js
const Redis = require('ioredis'); // Import ioredis

// --- KONFIGURASI REDIS (MENGGUNAKAN REDIS_URL) ---
// Pastikan REDIS_URL telah ditetapkan dalam Environment Variables Vercel anda
const REDIS_URL = process.env.REDIS_URL;
let redisClient; // Declare client outside to reuse connection

if (!REDIS_URL) {
    console.error('ERROR: REDIS_URL environment variable is not set. Bot status control will not function correctly.');
} else {
    redisClient = new Redis(REDIS_URL);

    redisClient.on('connect', () => console.log('[INFO] Status page connected to Redis!'));
    redisClient.on('error', (err) => console.error('[ERROR] Status page Redis Client Error', err));
}


// Fungsi untuk menjana HTML halaman status
function generateStatusPage(botIsOn, message = '') {
    const statusText = botIsOn ? 'ON' : 'OFF';
    const buttonText = botIsOn ? 'Turn Bot OFF' : 'Turn Bot ON';
    const buttonColor = botIsOn ? '#dc3545' : '#28a745'; // Merah untuk OFF, Hijau untuk ON

    return `
<!DOCTYPE html>
<html lang="ms">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Bot Status Control</title>
    <style>
        body { font-family: Arial, sans-serif; display: flex; justify-content: center; align-items: center; min-height: 100vh; background-color: #f4f4f4; margin: 0; }
        .container { background-color: #fff; padding: 30px; border-radius: 8px; box-shadow: 0 0 10px rgba(0,0,0,0.1); text-align: center; }
        h1 { color: #333; margin-bottom: 20px; }
        p { font-size: 1.1em; color: #555; margin-bottom: 30px; }
        .status-indicator {
            font-size: 1.5em;
            font-weight: bold;
            color: ${botIsOn ? '#28a745' : '#dc3545'}; /* Hijau jika ON, Merah jika OFF */
            margin-bottom: 20px;
        }
        button {
            background-color: ${buttonColor};
            color: white;
            padding: 12px 25px;
            border: none;
            border-radius: 5px;
            cursor: pointer;
            font-size: 1.1em;
            transition: background-color 0.3s ease;
        }
        button:hover {
            opacity: 0.9;
        }
        .message {
            margin-top: 20px;
            padding: 10px;
            border-radius: 5px;
            background-color: #e0f7fa;
            color: #00796b;
            border: 1px solid #b2ebf2;
            display: ${message ? 'block' : 'none'};
        }
    </style>
</head>
<body>
    <div class="container">
        <h1>Kawalan Status Bot WhatsApp</h1>
        <p>Status semasa: <span class="status-indicator">${statusText}</span></p>
        
        <form method="POST">
            <button type="submit" name="toggle" value="${botIsOn ? 'off' : 'on'}">${buttonText}</button>
        </form>

        <div class="message">${message}</div>
    </div>
</body>
</html>
`;
}


// Fungsi utama untuk mengendalikan permintaan ke /api/status
module.exports = async (req, res) => {
    let message = '';
    let botIsOn = true; // Default status jika Redis tak dapat disambung

    // Hanya cuba baca/tulis jika client Redis dah bersambung
    if (redisClient) {
        try {
            const status = await redisClient.get('bot_status'); // Ambil dari Redis
            if (status !== null) {
                const parsedStatus = JSON.parse(status); // Redis simpan string, perlu parse
                if (typeof parsedStatus === 'object' && typeof parsedStatus.isOn === 'boolean') {
                    botIsOn = parsedStatus.isOn;
                }
            } else {
                // Jika status belum ada, inisialisasi ke ON
                await redisClient.set('bot_status', JSON.stringify({ isOn: true }));
                botIsOn = true;
                console.log('[INFO] Bot status initialized to ON in Redis via /api/status.');
            }
        } catch (error) {
            console.error(`[ERROR] Failed to read bot status from Redis in /api/status: ${error.message}. Assuming bot is ON.`);
            message = 'Ralat membaca status bot. Menganggap bot ON.';
        }
    } else {
        console.warn('[WARNING] Redis client not initialized in /api/status. Bot status control may not function correctly.');
        message = 'Ralat: Sambungan Redis tidak tersedia. Kawalan status mungkin tidak berfungsi.';
    }


    // Jika ada permintaan POST (untuk toggle status)
    if (req.method === 'POST') {
        if (!redisClient) {
            return res.status(500).send(generateStatusPage(botIsOn, 'Ralat: Sambungan Redis tidak tersedia. Tidak dapat menukar status.'));
        }

        const toggleAction = req.body.toggle; // Ambil nilai dari butang
        let newStatus = botIsOn;

        if (toggleAction === 'on') {
            newStatus = true;
        } else if (toggleAction === 'off') {
            newStatus = false;
        }

        if (newStatus !== botIsOn) { // Hanya update jika status berubah
            try {
                await redisClient.set('bot_status', JSON.stringify({ isOn: newStatus }));
                botIsOn = newStatus;
                message = `Bot berjaya ditukar ke status: ${botIsOn ? 'ON' : 'OFF'}.`;
                console.log(`[INFO] Bot status successfully toggled to ${botIsOn ? 'ON' : 'OFF'}.`);
            } catch (error) {
                message = `Ralat menukar status bot: ${error.message}`;
                console.error(`[ERROR] Failed to toggle bot status in Redis: ${error.message}`);
            }
        } else {
            message = `Bot sudah berada dalam status ${botIsOn ? 'ON' : 'OFF'}.`;
        }

        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(generateStatusPage(botIsOn, message));

    } else if (req.method === 'GET') {
        res.setHeader('Content-Type', 'text/html');
        return res.status(200).send(generateStatusPage(botIsOn, message));
    } else {
        return res.status(405).json({ status: 'error', message: 'Method Not Allowed' });
    }
};