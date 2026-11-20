// ============================================================
// VEXIS WhatsApp Notification & Smart Bot Service
// Brand: VEXIS (https://vexis1.store)
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
import { existsSync, mkdirSync, rmSync } from 'fs';
import 'dotenv/config';

// ── Configuration ────────────────────────────────────────────
const PORT        = process.env.PORT || 3001;
const API_SECRET  = process.env.WA_API_SECRET || 'vexis-wa-2024-secret';
const AUTH_DIR    = process.env.AUTH_DIR || './auth';
const BRAND_LINK  = 'https://vexis1.store';
const WA_USERNAME = 'vexis1.store';
const WA_CHAT_URL = `https://wa.me/${WA_USERNAME}`;

// ── Logger ───────────────────────────────────────────────────
const logger = pino({ level: 'silent' });

// ── Deduplication & Rate Limiting Caches ─────────────────────
const sentCache = new NodeCache({ stdTTL: 300 });       // 5 mins duplicate protection
const botReplyCooldown = new NodeCache({ stdTTL: 60 }); // 1 min bot reply cooldown per user

// ── Global State ─────────────────────────────────────────────
let sock         = null;
let isConnected  = false;
let connectedJid = null;
let latestQR     = null;
let isConnecting = false;

if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

// ============================================================
// Core WhatsApp Connection
// ============================================================
async function connectToWhatsApp() {
  if (isConnecting) return;
  isConnecting = true;

  try {
    const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

    sock = makeWASocket({
      auth:                state,
      logger,
      browser:             Browsers.ubuntu('Chrome'),
      printQRInTerminal:   false,
      connectTimeoutMs:    60_000,
      keepAliveIntervalMs: 25_000,
      retryRequestDelayMs: 2000,
    });

    // ── Connection Status Listener ───────────────────────────
    sock.ev.on('connection.update', async (update) => {
      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        latestQR = qr;
        console.log('\n[WA] ⚡ New QR Code generated — Visit /qr in browser to scan\n');
        qrcode.generate(qr, { small: true });
      }

      if (connection === 'close') {
        isConnected  = false;
        connectedJid = null;
        latestQR     = null;
        isConnecting = false;

        const statusCode = (lastDisconnect?.error instanceof Boom)
          ? lastDisconnect.error.output?.statusCode
          : null;
        const shouldReconnect = statusCode !== DisconnectReason.loggedOut;

        console.log(`[WA] Connection closed. StatusCode: ${statusCode}. Reconnecting: ${shouldReconnect}`);

        if (shouldReconnect) {
          setTimeout(connectToWhatsApp, 3000);
        } else {
          console.log('[WA] Logged out. Session cleaned up. Waiting for new scan.');
          try { rmSync(AUTH_DIR, { recursive: true, force: true }); } catch {}
          setTimeout(connectToWhatsApp, 2000);
        }
      }

      if (connection === 'open') {
        isConnected  = true;
        latestQR     = null;
        isConnecting = false;
        connectedJid = sock.user?.id ? sock.user.id.split(':')[0] : 'unknown';
        console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
        console.log('✅ VEXIS WhatsApp Service is LIVE & Connected!');
        console.log(`📞 Active WhatsApp ID: +${connectedJid}`);
        console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      }
    });

    sock.ev.on('creds.update', saveCreds);

    // ── Smart Interactive Bot (Auto-Reply) ───────────────────
    sock.ev.on('messages.upsert', async ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const msg of messages) {
        // Skip messages sent by the bot itself or status broadcasts
        if (!msg.message || msg.key.fromMe || msg.key.remoteJid.includes('@broadcast')) continue;

        const senderJid = msg.key.remoteJid;
        const text = (
          msg.message.conversation ||
          msg.message.extendedTextMessage?.text ||
          ''
        ).trim().toLowerCase();

        if (!text) continue;

        // Prevent spam replies (cooldown per customer)
        if (botReplyCooldown.has(senderJid)) continue;
        botReplyCooldown.set(senderJid, true);

        // Smart keyword routing
        let reply = '';

        if (/تتبع|أوردر|اوردر|فين طلبي|order|track|شحن/.test(text)) {
          reply = `🏋️ *خدمة تتبع شحنات VEXIS:*

يمكنك معرفة خط سير شحنتك وموعد وصولها لحظة بلحظة:
🌐 ${BRAND_LINK}/my-orders.html

فقط أدخل رقم الهاتف المسجل في طلبك.
_VEXIS — Train Hard. Look Sharp._ 🔥`;

        } else if (/مقاس|مقاسات|size|وزن|طول/.test(text)) {
          reply = `📏 *جدول مقاسات VEXIS الرسمي:*

• *S:* العرض 48.5 سم | الطول 66.5 سم | الوزن 50-60 كجم
• *M:* العرض 51 سم | الطول 68 سم | الوزن 60-70 كجم
• *L:* العرض 53.5 سم | الطول 69.5 سم | الوزن 70-80 كجم
• *XL:* العرض 56 سم | الطول 71 سم | الوزن 80-90 كجم

💡 أقمشتنا مصممة بتقنية Dri-Fit الاستريتش، لو تفضل المقاس مريح (Regular) اختر مقاس أكبر بدرجة.
للمساعدة الفورية ابعتلنا وزنك وطولك!`;

        } else if (/استبدال|ترجيع|تبديل|ارجاع|exchange|return/.test(text)) {
          reply = `🔄 *سياسة الاستبدال والاسترجاع من VEXIS:*

نضمن لك 14 يوماً للاستبدال والاسترجاع بدون أي تعقيد.
لتقديم طلب استبدال أو استرجاع، املأ النموذج السريع هنا:
🌐 ${BRAND_LINK}/return.html

وفريقنا هيتواصل معاك لترتيب الشحن البديل خلال 24 ساعة.`;

        } else {
          reply = `أهلاً بك في *VEXIS* 🏋️🔥
معاك خدمة العملاء، رسالتك وصلتنا وسيقوم ممثل الخدمة بالرد عليك في أقرب وقت.

📌 *أوامر سريعة للرد الآلي:*
• اكتب *تتبع* لمتابعة حالة أوردرك
• اكتب *مقاسات* لمعرفة جدول المقاسات
• اكتب *استبدال* لطلب استبدال منتج

🌐 متجرنا الرسمي: ${BRAND_LINK}
_Train Hard. Look Sharp._ 🔥`;
        }

        try {
          await sock.sendMessage(senderJid, { text: reply });
          console.log(`[WA Bot] 🤖 Replied to ${senderJid} for message: "${text.slice(0, 30)}"`);
        } catch (botErr) {
          console.error('[WA Bot Error]', botErr.message);
        }
      }
    });

  } catch (err) {
    isConnecting = false;
    console.error('[WA Connection Error]', err.message);
    setTimeout(connectToWhatsApp, 5000);
  }
}

// ============================================================
// Message Builders
// ============================================================

// 1. New Order Receipt
function buildOrderMessage(order) {
  const {
    customerName,
    orderNumber,
    items = [],
    shipping = 0,
    discount = 0,
    total    = 0,
    address,
    governorate,
    phone,
  } = order;

  const itemsList = items.map(i => {
    const size = i.size ? ` [${i.size}]` : '';
    const qty  = (i.qty && i.qty > 1) ? ` ×${i.qty}` : '';
    const itemTotal = (i.finalPrice || i.price || 0) * (i.qty || 1);
    return `• *${i.name}*${size}${qty} — EGP ${itemTotal}`;
  }).join('\n');

  const discountText = discount > 0 ? `\n🏷️ *الخصم:* -EGP ${discount}` : '';
  const cleanPhone = (phone || '').toString().replace(/\D/g, '');
  const trackUrl = `${BRAND_LINK}/my-orders.html?phone=${cleanPhone}&order=${orderNumber}`;

  return `أهلاً بك يا *${customerName}* 👋

تم استلام طلبك بنجاح في *VEXIS* 🏋️
طلبك قيد المراجعة والتجهيز الآن للشحن السريع 🚀

━━━━━━━━━━━━━━━━━━━
🧾 *تفاصيل الأوردر*
━━━━━━━━━━━━━━━━━━━
🆔 *رقم الطلب:* \`${orderNumber}\`

📦 *المنتجات:*
${itemsList}
${discountText}
🚚 *الشحن:* EGP ${shipping}
💵 *المطلوب عند الاستلام:* *EGP ${total}*

📍 *عنوان التوصيل:*
${address}، ${governorate}
━━━━━━━━━━━━━━━━━━━

🔍 *تتبع شحنتك لحظة بلحظة:*
${trackUrl}

💬 *خدمة العملاء:* ${WA_CHAT_URL} (@${WA_USERNAME})

شكراً لاختيارك *VEXIS* ❤️
_Train Hard. Look Sharp._ 🔥`.trim();
}

// 2. Order Shipped Notification
function buildShippedMessage(customerName, orderNumber, phone) {
  const cleanPhone = (phone || '').toString().replace(/\D/g, '');
  const trackUrl = `${BRAND_LINK}/my-orders.html?phone=${cleanPhone}&order=${orderNumber}`;

  return `أهلاً يا *${customerName}* 🚚

طلبك رقم \`${orderNumber}\` خرج للشحن مع مندوب التوصيل الآن! 📦💨
المندوب هيتواصل معاك هاتفياً أو عبر واتساب لتسليم الشحنة.

📍 *يمكنك تتبع الشحنة مباشرة من هنا:*
${trackUrl}

_تذكير: يحق لك معاينة الشحنة والتأكد من المقاس والجودة قبل الدفع._ 🛡️

*VEXIS — Train Hard. Look Sharp.* 🔥`.trim();
}

// 3. Order Delivered Notification
function buildDeliveredMessage(customerName, orderNumber) {
  return `أهلاً يا *${customerName}* 🎉

تم تسليم طلبك رقم \`${orderNumber}\` بنجاح!
نتمنى تكون تجربة التسوق ومنتجات *VEXIS* عند حسن ظنك 🏋️❤️

📌 معك ضمان استبدال واسترجاع لمدة 14 يوماً في حال رغبت بتعديل أي مقاس:
🌐 ${BRAND_LINK}/return.html

شكراً لثقتك في *VEXIS* 🔥`.trim();
}

// 4. Return Request Confirmation
function buildReturnConfirmationMessage(customerName, orderNumber) {
  return `أهلاً يا *${customerName}* 👋

تم استلام طلب الاستبدال/الاسترجاع الخاص بالأوردر \`${orderNumber}\` بنجاح.
فريق المتابعة يراجع طلبك وسيتواصل معك خلال 24 ساعة لترتيب استلام وتسليم الشحنة 🔄

لأي استفسار إضافي:
💬 ${WA_CHAT_URL} (@${WA_USERNAME})

*VEXIS Customer Care* ❤️`.trim();
}

// ============================================================
// Express Web Application
// ============================================================
const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: true }));

// Helper: Normalize Egyptian phone numbers to international JID
function formatJid(phone) {
  let clean = phone.toString().replace(/\D/g, '');
  if (clean.startsWith('01')) clean = '2' + clean;
  else if (!clean.startsWith('2') && clean.length === 10) clean = '20' + clean;
  return clean + '@s.whatsapp.net';
}

// Security Middleware
function checkSecret(req, res, next) {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized: Invalid API secret' });
  }
  next();
}

// ── Health Endpoint ──────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    success:      true,
    connected:    isConnected,
    phone:        connectedJid,
    hasQR:        !!latestQR,
    timestamp:    new Date().toISOString()
  });
});

// ── Reset / Disconnect Endpoint (To pair a new number) ───────
app.all('/reset', async (req, res) => {
  try {
    console.log('[WA] 🔄 Session reset requested. Clearing auth folder...');
    isConnected  = false;
    connectedJid = null;
    latestQR     = null;

    if (sock) {
      try { await sock.logout(); } catch {}
      try { sock.end(); } catch {}
      sock = null;
    }

    try {
      rmSync(AUTH_DIR, { recursive: true, force: true });
      mkdirSync(AUTH_DIR, { recursive: true });
    } catch (fsErr) {
      console.warn('[WA Reset] File cleanup warning:', fsErr.message);
    }

    isConnecting = false;
    setTimeout(connectToWhatsApp, 1000);

    if (req.headers.accept?.includes('text/html') || req.method === 'GET') {
      return res.redirect('/qr?reset=1');
    }

    res.json({ success: true, message: 'Session reset successfully. Open /qr to link new device.' });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── QR Code & Control Dashboard ──────────────────────────────
app.get('/qr', async (req, res) => {
  // Case 1: Already Connected
  if (isConnected) {
    return res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>VEXIS WhatsApp — المتصل حالياً</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, system-ui, sans-serif; background: #09090b; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; padding: 20px; }
    .card { background: #18181b; border: 1px solid #27272a; border-radius: 20px; padding: 36px 28px; max-width: 440px; width: 100%; text-align: center; box-shadow: 0 20px 40px rgba(0,0,0,0.6); }
    .status-badge { display: inline-flex; align-items: center; gap: 8px; background: rgba(34,197,94,0.15); border: 1px solid #22c55e; color: #22c55e; padding: 6px 16px; border-radius: 999px; font-weight: 700; font-size: 13px; margin-bottom: 20px; }
    .pulse { width: 8px; height: 8px; background: #22c55e; border-radius: 50%; box-shadow: 0 0 10px #22c55e; }
    h1 { font-size: 24px; font-weight: 900; letter-spacing: 2px; margin-bottom: 6px; }
    .phone { font-size: 18px; color: #e4e4e7; font-weight: 700; background: #27272a; padding: 8px 14px; border-radius: 10px; display: inline-block; margin: 12px 0 20px; direction: ltr; }
    .btn-reset { display: block; width: 100%; background: #ef4444; hover:background: #dc2626; color: #fff; border: none; padding: 14px; border-radius: 12px; font-weight: 700; font-size: 14px; cursor: pointer; text-decoration: none; transition: 0.2s; margin-top: 15px; }
    .btn-reset:hover { background: #dc2626; transform: translateY(-1px); }
    .info { font-size: 12px; color: #71717a; margin-top: 18px; line-height: 1.6; }
  </style>
</head>
<body>
  <div class="card">
    <div class="status-badge"><span class="pulse"></span> متصل ونشط (Online)</div>
    <h1>VEXIS WhatsApp</h1>
    <p style="color:#a1a1aa; font-size:14px;">الخدمة شغالة وجاهزة لإرسال الرسائل والردود التلقائية</p>
    <div class="phone">+${connectedJid || 'متصل'}</div>
    
    <a href="/reset" onclick="return confirm('هل أنت متأكد من قطع الاتصال لربط رقم واتساب جديد؟')" class="btn-reset">
      🔄 قطع الاتصال وربط رقم واتساب جديد (QR)
    </a>
    
    <p class="info">لربط رقم جديد، اضغط على الزر بالأعلى وسيتم إنشاء رمز QR فوري لمسحه بالرقم الجديد.</p>
  </div>
</body>
</html>`);
  }

  // Case 2: Waiting for QR generation
  if (!latestQR) {
    return res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta http-equiv="refresh" content="4">
  <title>VEXIS WhatsApp — جاري التجهيز</title>
  <style>
    body { font-family: -apple-system, sans-serif; background: #09090b; color: #fff; min-height: 100vh; display: flex; align-items: center; justify-content: center; text-align: center; }
  </style>
</head>
<body>
  <div>
    <h2 style="margin-bottom:12px;">⏳ جاري تجهيز رمز QR Code جديد...</h2>
    <p style="color:#71717a; font-size:14px;">الصفحة تتحدث تلقائياً كل 4 ثوانٍ</p>
  </div>
</body>
</html>`);
  }

  // Case 3: QR Code Ready for Scanning
  try {
    const qrDataUrl = await QRCode.toDataURL(latestQR, {
      width:  340,
      margin: 2,
      color:  { dark: '#000000', light: '#ffffff' }
    });

    res.send(`<!DOCTYPE html>
<html lang="ar" dir="rtl">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta http-equiv="refresh" content="25">
  <title>VEXIS WhatsApp — مسح الـ QR Code</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: -apple-system, system-ui, sans-serif;
      background: #09090b;
      color: #fff;
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 20px;
    }
    .card {
      background: #18181b;
      border: 1px solid #27272a;
      border-radius: 24px;
      padding: 36px 28px;
      text-align: center;
      max-width: 440px;
      width: 100%;
      box-shadow: 0 25px 50px rgba(0,0,0,0.7);
    }
    .logo { font-size: 26px; font-weight: 900; letter-spacing: 3px; color: #fff; margin-bottom: 4px; }
    .sub  { color: #71717a; font-size: 13px; margin-bottom: 24px; }
    .qr-container {
      background: #ffffff;
      border-radius: 20px;
      padding: 14px;
      display: inline-block;
      margin-bottom: 22px;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    .qr-container img { width: 280px; height: 280px; display: block; }
    h2 { font-size: 18px; font-weight: 800; margin-bottom: 14px; }
    ol { text-align: right; color: #a1a1aa; font-size: 13.5px; line-height: 1.9; padding-right: 20px; margin-bottom: 20px; }
    ol li strong { color: #fff; }
    .refresh-note { color: #52525b; font-size: 12px; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">VEXIS</div>
    <div class="sub">WhatsApp Business Service & Bot</div>

    <div class="qr-container">
      <img src="${qrDataUrl}" alt="WhatsApp QR Code">
    </div>

    <h2>امسح الرمز لربط الرقم</h2>
    <ol>
      <li>افتح تطبيق <strong>واتساب</strong> على الهاتف</li>
      <li>اضغط على القائمة <strong>⋮</strong> أو الإعدادات</li>
      <li>اختر <strong>الأجهزة المرتبطة (Linked Devices)</strong></li>
      <li>اضغط <strong>ربط جهاز (Link a Device)</strong></li>
      <li>وجّه الكاميرا نحو المربع أعلاه ✅</li>
    </ol>

    <p class="refresh-note">⏱️ يتحدث الرمز تلقائياً كل 25 ثانية لضمان الصلاحية</p>
  </div>
</body>
</html>`);
  } catch (err) {
    res.status(500).send('Error rendering QR: ' + err.message);
  }
});

// ============================================================
// API Endpoints for Store Integration
// ============================================================

// 1. Send Order Confirmation Receipt
app.post('/send-order', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected. Open /qr to pair.' });
  }

  const order = req.body;
  if (!order?.phone || !order?.orderNumber) {
    return res.status(400).json({ success: false, error: 'phone and orderNumber are required' });
  }

  const cacheKey = `order:${order.orderNumber}`;
  if (sentCache.has(cacheKey)) {
    return res.json({ success: true, duplicate: true, message: 'Receipt already sent recently' });
  }

  const jid  = formatJid(order.phone);
  const text = buildOrderMessage(order);

  try {
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);
    console.log(`[WA] ✅ Order receipt sent → ${order.phone} (#${order.orderNumber})`);
    res.json({ success: true, to: order.phone, orderNumber: order.orderNumber });
  } catch (err) {
    console.error('[WA Send Error]', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2. Send Status Update (shipped / delivered / cancelled)
app.post('/send-status', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  const { phone, customerName, orderNumber, status } = req.body || {};
  if (!phone || !orderNumber || !status) {
    return res.status(400).json({ success: false, error: 'phone, orderNumber, and status are required' });
  }

  let text = '';
  if (status === 'shipped') {
    text = buildShippedMessage(customerName || 'عميلنا العزيز', orderNumber, phone);
  } else if (status === 'delivered') {
    text = buildDeliveredMessage(customerName || 'عميلنا العزيز', orderNumber);
  } else {
    return res.json({ success: false, message: `No notification configured for status: ${status}` });
  }

  const cacheKey = `status:${orderNumber}:${status}`;
  if (sentCache.has(cacheKey)) return res.json({ success: true, duplicate: true });

  try {
    const jid = formatJid(phone);
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);
    console.log(`[WA] ✅ Status [${status}] sent → ${phone} (#${orderNumber})`);
    res.json({ success: true, to: phone, status });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. Send Return/Exchange Confirmation
app.post('/send-return', checkSecret, async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ success: false, error: 'WhatsApp not connected' });

  const { phone, customerName, orderNumber } = req.body || {};
  if (!phone || !orderNumber) return res.status(400).json({ success: false, error: 'phone and orderNumber required' });

  try {
    const jid = formatJid(phone);
    const text = buildReturnConfirmationMessage(customerName || 'عميلنا العزيز', orderNumber);
    await sock.sendMessage(jid, { text });
    res.json({ success: true, to: phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. Generic Message Sender
app.post('/send', checkSecret, async (req, res) => {
  if (!isConnected || !sock) return res.status(503).json({ success: false, error: 'WhatsApp not connected' });

  const { phone, message } = req.body || {};
  if (!phone || !message) return res.status(400).json({ success: false, error: 'phone and message required' });

  try {
    const jid = formatJid(phone);
    await sock.sendMessage(jid, { text: message });
    res.json({ success: true, to: phone });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 404 Fallback ─────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, error: 'Endpoint not found' }));

// ── Startup ──────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚀 VEXIS WhatsApp Service initialized on port ' + PORT);
  console.log('🌐 Web Dashboard: http://localhost:' + PORT + '/qr\n');
});

connectToWhatsApp();
