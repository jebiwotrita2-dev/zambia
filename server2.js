const express = require('express');
const path = require('path');
const crypto = require('crypto');
const TelegramBot = require('node-telegram-bot-api');

const BOT_TOKEN = process.env.BOT_TOKEN || process.env.TELEGRAM_BOT_TOKEN;
const ADMIN_CHAT_ID = process.env.ADMIN_CHAT_ID || process.env.TELEGRAM_ADMIN_CHAT_ID; // your Telegram chat ID
const PORT = process.env.PORT || 3000;

if (!BOT_TOKEN || !ADMIN_CHAT_ID) {
  console.warn('Set BOT_TOKEN/TELEGRAM_BOT_TOKEN and ADMIN_CHAT_ID/TELEGRAM_ADMIN_CHAT_ID to enable Telegram notifications.');
}

const bot = BOT_TOKEN ? new TelegramBot(BOT_TOKEN, { polling: true }) : null;
const app = express();
app.use(express.json());
app.use(express.static(__dirname));

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

// In-memory store: id -> { username, status, createdAt }
const requests = new Map();
const messageStore = new Map(); // requestId -> [{ id, text, time }]
const notificationMessageIds = new Map(); // `${chatId}:${messageId}` -> requestId
let nextMsgId = 1;

function getRequestMessages(requestId) {
  if (!messageStore.has(requestId)) messageStore.set(requestId, []);
  return messageStore.get(requestId);
}

// 1. Visitor logs in -> notify admin with Approve / Reject buttons
app.post('/api/login', async (req, res) => {
  const username = String(req.body.username || '').trim().slice(0, 100);
  if (!username) return res.status(400).json({ error: 'Username required' });

  const id = crypto.randomBytes(8).toString('hex');
  requests.set(id, { username, status: 'pending', createdAt: Date.now() });

  if (!bot || !ADMIN_CHAT_ID) {
    return res.status(503).json({ error: 'Telegram not configured' });
  }

  try {
    const sentMessage = await bot.sendMessage(ADMIN_CHAT_ID, `🔐 Login request\nUser: ${username}`, {
      reply_markup: {
        inline_keyboard: [[
          { text: '✅ Approve', callback_data: `approve:${id}` },
          { text: '❌ Reject', callback_data: `reject:${id}` },
        ]],
      },
    });
    notificationMessageIds.set(`${ADMIN_CHAT_ID}:${sentMessage.message_id}`, id);
  } catch (e) {
    console.error('Telegram send failed:', e.message);
    return res.status(500).json({ error: 'Could not reach admin' });
  }
  res.json({ id });
});

// 2. Page polls this to learn the decision
app.get('/api/status/:id', (req, res) => {
  const r = requests.get(req.params.id);
  if (!r) return res.status(404).json({ status: 'unknown' });
  res.json({ status: r.status });
});

// 3. Messages YOU paste into Telegram -> shown on the page (approved visitors only)
app.get('/api/messages/:id', (req, res) => {
  const requestId = req.params.id;
  const r = requests.get(requestId);
  if (!r || r.status !== 'approved') return res.status(403).json({ error: 'Not approved' });
  const since = parseInt(req.query.since || '0', 10);
  res.json(getRequestMessages(requestId).filter(m => m.id > since));
});

if (bot) {
  bot.on('message', (msg) => {
    if (String(msg.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const text = msg.text || msg.caption;
    if (!text || text.startsWith('/')) return;

    const replyId = msg.reply_to_message && msg.reply_to_message.message_id;
    const requestId = replyId
      ? notificationMessageIds.get(`${msg.chat.id}:${replyId}`)
      : null;

    if (!requestId) {
      bot.sendMessage(ADMIN_CHAT_ID, 'Reply to a specific login request to message that visitor.').catch(() => {});
      return;
    }

    const requestMessages = getRequestMessages(requestId);
    requestMessages.push({ id: nextMsgId++, text: text.slice(0, 4000), time: Date.now() });
    if (requestMessages.length > 200) requestMessages.shift();
    bot.sendMessage(ADMIN_CHAT_ID, '✅ Posted to the page').catch(() => {});
  });

  // Admin taps a button in Telegram
  bot.on('callback_query', async (q) => {
    if (String(q.message.chat.id) !== String(ADMIN_CHAT_ID)) return;
    const [action, id] = (q.data || '').split(':');
    const r = requests.get(id);

    if (!r) return bot.answerCallbackQuery(q.id, { text: 'Request expired' });

    r.status = action === 'approve' ? 'approved' : 'rejected';
    await bot.answerCallbackQuery(q.id, { text: r.status });
    bot.editMessageText(
      `${r.status === 'approved' ? '✅ Approved' : '❌ Rejected'}\nUser: ${r.username}`,
      { chat_id: q.message.chat.id, message_id: q.message.message_id }
    ).catch(() => {});
  });
}

// Clean up old requests every 10 minutes (older than 1 hour)
setInterval(() => {
  const cutoff = Date.now() - 60 * 60 * 1000;
  for (const [id, r] of requests) {
    if (r.createdAt < cutoff) {
      requests.delete(id);
      messageStore.delete(id);
      for (const [key, requestId] of notificationMessageIds) {
        if (requestId === id) notificationMessageIds.delete(key);
      }
    }
  }
}, 10 * 60 * 1000);

app.listen(PORT, () => console.log(`Running on port ${PORT}`));
