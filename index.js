// ============================================================
// VEXIS WhatsApp Notification Service
// ============================================================

import express        from 'express';
import {
  makeWASocket,
  useMultiFileAuthState,
  DisconnectReason,
  Browsers
} from '@whiskeysockets/baileys';
import { Boom }       from '@hapi/boom';
import NodeCache      from 'node-cache';
import qrcode         from 'qrcode-terminal';
import QRCode         from 'qrcode';
import pino           from 'pino';
import { existsSync, mkdirSync } from 'fs';
import 'dotenv/config';

// ── Config ───────────────────────────────────────────────────
const PORT       = process.env.PORT || 3001;
const API_SECRET = process.env.WA_API_SECRET || 'vexis-secret-key';
const AUTH_DIR   = process.env.AUTH_DIR || './auth';

// ── Logger ───────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ── Cache لمنع إرسال مكرر ────────────────────────────────────
const sentCache = new NodeCache({ stdTTL: 300 });

// ── Global state ─────────────────────────────────────────────
let sock        = null;
let isConnected = false;
let latestQR    = null;   // raw QR string — لعمل صورة منه

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

// ============================================================
// WhatsApp Connection
// ============================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth:               state,
    logger,
    browser:            Browsers.ubuntu('Chrome'),
    printQRInTerminal:  false,
    connectTimeoutMs:   60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2000,
  });

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      latestQR = qr;
      // طباعة ASCII في الـ logs للمراقبة
      console.log('\n[WA] New QR Code generated — open /qr in browser to scan\n');
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'close') {
      isConnected = false;
      latestQR    = null;
      const shouldReconnect =
        (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode !== DisconnectReason.loggedOut
          : true;

      console.log(`[WA] Connection closed. Reconnect: ${shouldReconnect}`);
      if (shouldReconnect) {
        setTimeout(connectToWhatsApp, 3000);
      } else {
        console.log('[WA] Logged out — delete ./auth folder and restart');
      }
    }

    if (connection === 'open') {
      isConnected = true;
      latestQR    = null;
      console.log('\n✅ WhatsApp connected successfully!');
      console.log(`📞 Connected as: ${sock.user?.id}\n`);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ============================================================
// Message Builder
// ============================================================
function buildOrderMessage(order) {
  const {
    customerName,
    orderNumber,
    items = [],
    subtotal = 0,
    shipping = 0,
    discount = 0,
    total    = 0,
    address,
    governorate,
    notes,
  } = order;

  const now     = new Date();
  const dateStr = now.toLocaleDateString('ar-EG', {
    year: 'numeric', month: 'long', day: 'numeric',
    timeZone: 'Africa/Cairo'
  });
  const timeStr = now.toLocaleTimeString('ar-EG', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Africa/Cairo'
  });

  const itemsText = items.map(i => {
    const size  = i.size  ? ` [${i.size}]`  : '';
    const color = i.color ? ` (${i.color})` : '';
    const price = (i.finalPrice || i.price || 0) * (i.qty || 1);
    return `  • ${i.name}${size}${color} ×${i.qty || 1} — *EGP ${price}*`;
  }).join('\n');

  const discountLine = discount > 0 ? `\n🏷️ *الخصم:* -EGP ${discount}` : '';
  const notesLine    = notes        ? `\n📝 *ملاحظات:* ${notes}`        : '';

  return `أزيك يا *${customerName}* 👋❤️

استلمنا أوردرك وبنجهزه دلوقتي! 🏋️

━━━━━━━━━━━━━━━━━━━
🧾 *فاتورة الطلب*
━━━━━━━━━━━━━━━━━━━

🆔 *رقم الطلب:* \`${orderNumber}\`
📅 *التاريخ:* ${dateStr} — ${timeStr}

━━━━━━━━━━━━━━━━━━━
📦 *المنتجات:*
${itemsText}

━━━━━━━━━━━━━━━━━━━
💰 *المجموع الفرعي:* EGP ${subtotal}${discountLine}
🚚 *رسوم الشحن:* EGP ${shipping}
✅ *الإجمالي المطلوب دفعه:* *EGP ${total}*

━━━━━━━━━━━━━━━━━━━
📍 *عنوان التوصيل:*
${address}، ${governorate}${notesLine}

💳 *طريقة الدفع:* الدفع عند الاستلام (COD)
━━━━━━━━━━━━━━━━━━━

معاك خدمة عملاء *VEXIS* 🏋️

طلبك تحت نظرنا وهيوصلك في أقرب وقت ❤️
أي استفسار عن الأوردر، المقاسات، الشحن، أو الاستبدال — إحنا هنا!

📲 *واتساب:* 01061927815
🕒 *مواعيد الرد:* 10 صباحًا – 12 منتصف الليل

شكرًا لثقتك في *VEXIS* ❤️
_VEXIS — Train Hard. Look Sharp._ 🔥`.trim();
}

// ============================================================
// Express Server
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));

function checkSecret(req, res, next) {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ── Health ───────────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({ success: true, connected: isConnected, hasQR: !!latestQR, timestamp: new Date().toISOString() });
});

// ── QR Code Page (بدون auth — لأن محتاجها تفتحها في المتصفح) ──
app.get('/qr', async (req, res) => {
  if (isConnected) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <title>VEXIS WhatsApp</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#000;color:#fff;flex-direction:column;gap:16px}</style>
    </head><body>
    <h1>✅ WhatsApp Connected!</h1>
    <p>الواتساب متصل بنجاح — مش محتاج تعمل scan</p>
    <p style="color:#aaa;font-size:12px">Connected as: ${sock?.user?.id || 'unknown'}</p>
    </body></html>`);
  }

  if (!latestQR) {
    return res.send(`<!DOCTYPE html><html><head><meta charset="utf-8">
    <meta http-equiv="refresh" content="5">
    <title>VEXIS WhatsApp — Waiting for QR</title>
    <style>body{font-family:sans-serif;display:flex;align-items:center;justify-content:center;height:100vh;margin:0;background:#000;color:#fff;flex-direction:column;gap:16px}</style>
    </head><body>
    <h2>⏳ جاري الاتصال بـ WhatsApp...</h2>
    <p>الصفحة هتتحدث أوتوماتيك كل 5 ثواني</p>
    <p style="color:#aaa;font-size:12px">الصفحة بتتحدث... انتظر</p>
    </body></html>`);
  }

  try {
    const qrDataUrl = await QRCode.toDataURL(latestQR, {
      width:  400,
      margin: 2,
      color:  { dark: '#000000', light: '#ffffff' }
    });

    res.send(`<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="30">
  <title>VEXIS WhatsApp — Scan QR</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, sans-serif;
      background: #0a0a0a;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 24px;
    }
    .card {
      background: #111;
      border: 1px solid #222;
      border-radius: 20px;
      padding: 40px 32px;
      text-align: center;
      max-width: 420px;
      width: 100%;
    }
    .logo { font-size: 28px; font-weight: 900; letter-spacing: 4px; margin-bottom: 8px; }
    .sub  { color: #666; font-size: 13px; margin-bottom: 28px; }
    .qr-box {
      background: #fff;
      border-radius: 16px;
      padding: 16px;
      display: inline-block;
      margin-bottom: 24px;
    }
    .qr-box img { width: 300px; height: 300px; display: block; }
    h2 { font-size: 18px; margin-bottom: 12px; }
    ol { text-align: left; color: #bbb; font-size: 14px; line-height: 2; padding-left: 20px; }
    ol li strong { color: #fff; }
    .refresh { color: #555; font-size: 12px; margin-top: 20px; }
    .timer { color: #22c55e; font-weight: bold; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">VEXIS</div>
    <div class="sub">WhatsApp Business Service</div>

    <div class="qr-box">
      <img src="${qrDataUrl}" alt="WhatsApp QR Code">
    </div>

    <h2>امسح الـ QR Code</h2>
    <ol>
      <li>افتح <strong>واتساب</strong> على موبايلك</li>
      <li>اضغط النقط الثلاث <strong>⋮</strong></li>
      <li>اختر <strong>Linked Devices</strong></li>
      <li>اضغط <strong>Link a Device</strong></li>
      <li>امسح الكود فوق ✅</li>
    </ol>

    <p class="refresh">⏱️ الصفحة بتتحدث كل 30 ثانية | الكود صالح لدقيقتين</p>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error generating QR: ' + err.message);
  }
});

// ── Status ───────────────────────────────────────────────────
app.get('/status', checkSecret, (req, res) => {
  res.json({ success: true, connected: isConnected, user: sock?.user?.id || null });
});

// ── Send Order (main endpoint) ────────────────────────────────
app.post('/send-order', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected. Open /qr to scan.' });
  }

  const order = req.body;
  if (!order?.phone || !order?.orderNumber) {
    return res.status(400).json({ success: false, error: 'phone and orderNumber required' });
  }

  const cacheKey = `order:${order.orderNumber}`;
  if (sentCache.has(cacheKey)) {
    return res.json({ success: true, duplicate: true });
  }

  const cleanPhone = order.phone.toString().replace(/\D/g, '');
  const jid        = (cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone) + '@s.whatsapp.net';
  const text       = buildOrderMessage(order);

  try {
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);
    console.log(`[WA] ✅ Receipt sent → ${order.phone} | ${order.orderNumber}`);
    res.json({ success: true, to: order.phone, orderNumber: order.orderNumber });
  } catch (err) {
    console.error(`[WA] ❌ Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Send (generic) ────────────────────────────────────────────
app.post('/send', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  const { phone, message, order } = req.body || {};
  if (!phone) return res.status(400).json({ success: false, error: 'phone required' });

  const text = message || (order ? buildOrderMessage(order) : null);
  if (!text) return res.status(400).json({ success: false, error: 'message or order required' });

  const cleanPhone = phone.toString().replace(/\D/g, '');
  const jid        = (cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone) + '@s.whatsapp.net';

  const cacheKey = `${jid}:${text.slice(0, 30)}`;
  if (sentCache.has(cacheKey)) return res.json({ success: true, duplicate: true });

  try {
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);
    res.json({ success: true, to: phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚀 VEXIS WhatsApp Service starting...');
  console.log(`📡 HTTP server listening on port ${PORT}`);
  console.log(`🔗 Open /qr in browser to scan QR Code\n`);
});

connectToWhatsApp();
