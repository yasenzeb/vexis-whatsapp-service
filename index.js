// ============================================================
// VEXIS WhatsApp Notification Service
// Uses @whiskeysockets/baileys — no browser needed
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
import pino           from 'pino';
import { readFileSync, existsSync, mkdirSync } from 'fs';
import 'dotenv/config';

// ── Config ──────────────────────────────────────────────────
const PORT       = process.env.PORT || 3001;
const API_SECRET = process.env.WA_API_SECRET || 'vexis-secret-key';
const AUTH_DIR   = process.env.AUTH_DIR || './auth';
const OWNER_JID  = (process.env.OWNER_PHONE || '201061927815') + '@s.whatsapp.net';

// ── Logger ───────────────────────────────────────────────────
const logger = pino({ level: 'silent' }); // هادئ — مش هيطفش الـ terminal

// ── Cache لمنع إرسال مكرر ───────────────────────────────────
const sentCache = new NodeCache({ stdTTL: 300 }); // 5 دقايق

// ── Global socket ────────────────────────────────────────────
let sock = null;
let isConnected = false;
let qrPrinted = false;

// ── Auth dir ─────────────────────────────────────────────────
if (!existsSync(AUTH_DIR)) mkdirSync(AUTH_DIR, { recursive: true });

// ============================================================
// WhatsApp Connection
// ============================================================
async function connectToWhatsApp() {
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  sock = makeWASocket({
    auth:            state,
    logger,
    browser:         Browsers.ubuntu('Chrome'),
    printQRInTerminal: false,
    connectTimeoutMs: 60_000,
    keepAliveIntervalMs: 25_000,
    retryRequestDelayMs: 2000,
  });

  // ── QR Code ──────────────────────────────────────────────
  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update;

    if (qr && !qrPrinted) {
      console.log('\n━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━');
      console.log('📱 VEXIS WhatsApp Service — امسح الـ QR Code');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      qrcode.generate(qr, { small: true });
      console.log('\nافتح WhatsApp → More Options → Linked Devices → Link a Device');
      console.log('━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n');
      qrPrinted = true;
    }

    if (connection === 'close') {
      isConnected = false;
      qrPrinted   = false;
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
      qrPrinted   = false;
      console.log('\n✅ WhatsApp connected successfully!');
      console.log(`📞 Connected as: ${sock.user?.id}`);
      console.log(`🌐 Service running on port ${PORT}\n`);
    }
  });

  sock.ev.on('creds.update', saveCreds);
}

// ============================================================
// Message Builder — فاتورة VEXIS احترافية
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

  // بناء قائمة المنتجات
  const itemsText = items.map(i => {
    const size  = i.size  ? ` [${i.size}]`  : '';
    const color = i.color ? ` (${i.color})` : '';
    const price = (i.finalPrice || i.price || 0) * (i.qty || 1);
    return `  • ${i.name}${size}${color} ×${i.qty || 1} — *EGP ${price}*`;
  }).join('\n');

  const discountLine = discount > 0
    ? `\n🏷️ *الخصم:* -EGP ${discount}` : '';

  const notesLine = notes
    ? `\n📝 *ملاحظات:* ${notes}` : '';

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

// ── Middleware: Auth ─────────────────────────────────────────
function checkSecret(req, res, next) {
  const secret = req.headers['x-api-secret'] || req.query.secret;
  if (secret !== API_SECRET) {
    return res.status(401).json({ success: false, error: 'Unauthorized' });
  }
  next();
}

// ── Health Check ─────────────────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    success: true,
    connected: isConnected,
    timestamp: new Date().toISOString()
  });
});

// ── Status ───────────────────────────────────────────────────
app.get('/status', checkSecret, (req, res) => {
  res.json({
    success: true,
    connected: isConnected,
    user: sock?.user?.id || null,
    timestamp: new Date().toISOString()
  });
});

// ── Send Message ─────────────────────────────────────────────
app.post('/send', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({
      success: false,
      error: 'WhatsApp not connected yet. Scan QR code first.'
    });
  }

  const { phone, message, order } = req.body || {};

  if (!phone) {
    return res.status(400).json({ success: false, error: 'phone is required' });
  }

  // بناء الرسالة — إما مباشرة أو من بيانات الأوردر
  const text = message || (order ? buildOrderMessage(order) : null);
  if (!text) {
    return res.status(400).json({ success: false, error: 'message or order object required' });
  }

  // تنظيف رقم الهاتف
  const cleanPhone = phone.toString().replace(/\D/g, '');
  const jid = (cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone) + '@s.whatsapp.net';

  // منع الإرسال المكرر
  const cacheKey = `${jid}:${order?.orderNumber || text.slice(0, 30)}`;
  if (sentCache.has(cacheKey)) {
    return res.json({ success: true, duplicate: true, message: 'Already sent recently' });
  }

  try {
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);

    console.log(`[WA] ✅ Message sent to ${phone} (${order?.orderNumber || 'manual'})`);
    res.json({ success: true, to: phone, orderNumber: order?.orderNumber });
  } catch (err) {
    console.error(`[WA] ❌ Failed to send to ${phone}:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── Send Order (shortcut endpoint) ───────────────────────────
app.post('/send-order', checkSecret, async (req, res) => {
  if (!isConnected || !sock) {
    return res.status(503).json({ success: false, error: 'WhatsApp not connected' });
  }

  const order = req.body;
  if (!order?.phone || !order?.orderNumber) {
    return res.status(400).json({ success: false, error: 'phone and orderNumber required' });
  }

  const text       = buildOrderMessage(order);
  const cleanPhone = order.phone.toString().replace(/\D/g, '');
  const jid        = (cleanPhone.startsWith('2') ? cleanPhone : '2' + cleanPhone) + '@s.whatsapp.net';

  const cacheKey = `order:${order.orderNumber}`;
  if (sentCache.has(cacheKey)) {
    return res.json({ success: true, duplicate: true });
  }

  try {
    await sock.sendMessage(jid, { text });
    sentCache.set(cacheKey, true);
    console.log(`[WA] ✅ Order receipt sent → ${order.phone} | ${order.orderNumber}`);
    res.json({ success: true, to: order.phone, orderNumber: order.orderNumber });
  } catch (err) {
    console.error(`[WA] ❌ Error:`, err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 404 ──────────────────────────────────────────────────────
app.use((req, res) => res.status(404).json({ success: false, error: 'Not found' }));

// ── Start ────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log('\n🚀 VEXIS WhatsApp Service starting...');
  console.log(`📡 HTTP server listening on port ${PORT}`);
  console.log(`🔑 API Secret: ${API_SECRET.slice(0, 4)}****`);
  console.log('🔗 Connecting to WhatsApp...\n');
});

connectToWhatsApp();
