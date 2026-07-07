const express = require('express');
const path = require('path');
const fs = require('fs');
const Pusher = require('pusher');
const { RtcTokenBuilder, RtcRole } = require('agora-token');

// Load environment variables from .env file if it exists
const envPath = path.join(__dirname, '.env');
if (fs.existsSync(envPath)) {
  try {
    const lines = fs.readFileSync(envPath, 'utf-8').split(/\r?\n/);
    lines.forEach(line => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const match = trimmed.match(/^([\w.-]+)\s*=\s*(.*)?$/);
      if (match) {
        const key = match[1];
        let val = match[2] || '';
        if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
        else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
        process.env[key] = val.trim();
      }
    });
    console.log('Loaded environment variables from local .env file.');
  } catch (err) {
    console.error('Failed to parse local .env file:', err);
  }
}

const app = express();

// Parse JSON and form-urlencoded payloads
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

const PORT = process.env.PORT || 3000;
const ADMIN_CODE = process.env.ADMIN_CODE || '723801';

// Pusher credentials fallback structure
const pusher = new Pusher({
  appId: process.env.PUSHER_APP_ID || '2153068',
  key: process.env.PUSHER_KEY || '8cc1a38474623bd4a70e',
  secret: process.env.PUSHER_SECRET || 'a6f47027e26bb66f48db',
  cluster: process.env.PUSHER_CLUSTER || 'us3',
  useTLS: true
});

const DATA_DIR = path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'messages.json');

// Ensure data directory exists
if (!fs.existsSync(DATA_DIR)) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
}

// In-memory message store
let messageHistory = [];

try {
  if (fs.existsSync(DATA_FILE)) {
    const fileContent = fs.readFileSync(DATA_FILE, 'utf-8');
    messageHistory = JSON.parse(fileContent);
    console.log(`Loaded ${messageHistory.length} messages from persistent store.`);
  }
} catch (error) {
  console.error('Failed to load message history from file:', error);
}

// Helper to save messages
function saveMessage(msg) {
  messageHistory.push(msg);
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(messageHistory, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to save message history to file:', error);
  }
}

const SETTINGS_FILE = path.join(DATA_DIR, 'settings.json');
let appSettings = {
  webhookUrl: process.env.DISCORD_WEBHOOK_URL || '',
  monitoredUser: process.env.MONITORED_USER || '',
  enabled: process.env.DISCORD_ALERTS_ENABLED === 'true'
};

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const settingsContent = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    const parsedSettings = JSON.parse(settingsContent);
    appSettings = {
      webhookUrl: process.env.DISCORD_WEBHOOK_URL || parsedSettings.webhookUrl || '',
      monitoredUser: process.env.MONITORED_USER || parsedSettings.monitoredUser || '',
      enabled: process.env.DISCORD_ALERTS_ENABLED !== undefined
        ? process.env.DISCORD_ALERTS_ENABLED === 'true'
        : (parsedSettings.enabled !== undefined ? parsedSettings.enabled : false)
    };
    console.log('Loaded application settings successfully.');
  }
} catch (error) {
  console.error('Failed to load application settings:', error);
}



async function sendDiscordWebhook(url, content) {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content })
  });
  if (!response.ok) {
    const errText = await response.text();
    throw new Error(`Discord Webhook API returned ${response.status}: ${errText}`);
  }
}

// Endpoint to retrieve Pusher configuration dynamically for the client
app.get('/api/config', (req, res) => {
  res.json({
    key: process.env.PUSHER_KEY || '8cc1a38474623bd4a70e',
    cluster: process.env.PUSHER_CLUSTER || 'us3'
  });
});

// Endpoint to generate Agora RTC voice tokens dynamically
app.get('/api/voice-token', (req, res) => {
  const appId = process.env.AGORA_APP_ID;
  const appCertificate = process.env.AGORA_APP_CERTIFICATE;

  if (!appId || !appCertificate) {
    return res.status(500).json({ error: 'Agora credentials are not configured on the server.' });
  }

  const channelName = "lounge-voice";
  const uid = 0; // Dynamic UID
  const role = RtcRole.PUBLISHER;
  const expirationTimeInSeconds = 3600; // 1 hour token validity
  const currentTimestamp = Math.floor(Date.now() / 1000);
  const privilegeExpiredTs = currentTimestamp + expirationTimeInSeconds;

  try {
    const token = RtcTokenBuilder.buildTokenWithUid(
      appId,
      appCertificate,
      channelName,
      uid,
      role,
      privilegeExpiredTs
    );
    res.json({ success: true, token });
  } catch (err) {
    console.error('Agora token generation error:', err);
    res.status(500).json({ error: 'Failed to generate token.' });
  }
});

// Serve public directory
app.use(express.static(path.join(__dirname, 'public')));

// Pusher presence channel authorization endpoint
app.post('/pusher/auth', (req, res) => {
  const socketId = req.body.socket_id;
  const channel = req.body.channel_name;
  const username = req.body.username || 'Anonymous';

  console.log(`Pusher auth request: socket=${socketId}, channel=${channel}, user=${username}`);

  // Presence channel metadata
  const presenceData = {
    user_id: socketId,
    user_info: {
      name: username
    }
  };

  try {
    const authResponse = pusher.authorizeChannel(socketId, channel, presenceData);
    res.send(authResponse);
  } catch (error) {
    console.error('Pusher authorization failed:', error);
    res.status(500).send({ error: 'Pusher authorization failed' });
  }
});

// Message kinds broadcast/persisted in the chat stream.
const MESSAGE_KINDS = ['message', 'action'];

// Endpoint to send a message
app.post('/api/messages', (req, res) => {
  const { username, text, kind } = req.body;

  const cleanUsername = (username || 'Anonymous').trim().substring(0, 25);
  const cleanText = (text || '').trim().substring(0, 1000);
  const cleanKind = MESSAGE_KINDS.includes(kind) ? kind : 'message';

  if (!cleanText) {
    return res.status(400).json({ error: 'Message content is required.' });
  }

  const message = {
    id: `msg-${Date.now()}-${Math.random()}`,
    username: cleanUsername,
    text: cleanText,
    kind: cleanKind,
    timestamp: Date.now()
  };

  // Persist locally
  saveMessage(message);

  // Trigger Pusher event on presence channel
  pusher.trigger('presence-chat', 'new-message', message)
    .then(() => {
      res.json({ success: true, message });

      // Send Discord Webhook notification if enabled and monitored user matches
      if (appSettings.enabled && appSettings.webhookUrl && appSettings.monitoredUser) {
        const msgUser = cleanUsername.toLowerCase().trim();
        const targetUser = appSettings.monitoredUser.toLowerCase().trim();
        if (msgUser === targetUser) {
          const alertContent = `⚠️ **Aether Chatroom Notification**\nUser **${cleanUsername}** sent a message:\n> ${cleanText}`;
          sendDiscordWebhook(appSettings.webhookUrl, alertContent)
            .catch(err => console.error('Failed to dispatch Discord webhook alert:', err));
        }
      }
    })
    .catch((err) => {
      console.error('Pusher trigger error:', err);
      res.status(500).json({ error: 'Failed to broadcast message.' });
    });
});

// Endpoint to relay typing indicator state to all connected clients.
// Routing this through the server (instead of Pusher client events) means the
// typing indicator works without enabling client events in the Pusher dashboard.
app.post('/api/typing', (req, res) => {
  const { username, isTyping } = req.body;
  const cleanUsername = (username || 'Anonymous').trim().substring(0, 25);

  pusher.trigger('presence-chat', 'typing', {
    username: cleanUsername,
    isTyping: !!isTyping
  })
    .then(() => res.json({ success: true }))
    .catch((err) => {
      console.error('Typing relay error:', err);
      res.status(500).json({ error: 'Failed to relay typing state.' });
    });
});

// Relay minigame actions (invite / accept / decline / move) to all clients.
// Game state is resolved on the clients; the server only broadcasts events.
app.post('/api/game', (req, res) => {
  const payload = req.body || {};
  const type = typeof payload.type === 'string' ? payload.type : '';
  const allowed = ['invite', 'accept', 'decline', 'move'];

  if (!allowed.includes(type)) {
    return res.status(400).json({ error: 'Unknown game action.' });
  }

  pusher.trigger('presence-chat', 'game', payload)
    .then(() => res.json({ success: true }))
    .catch((err) => {
      console.error('Game relay error:', err);
      res.status(500).json({ error: 'Failed to relay game action.' });
    });
});

// Current pinned announcement (in-memory; latest wins). Empty string = none.
let currentAnnouncement = null;

// Late-joining clients fetch the active announcement so the banner shows for them too.
app.get('/api/announcement', (req, res) => {
  res.json({ announcement: currentAnnouncement });
});

// Admin-only: post or clear a broadcast announcement banner.
app.post('/api/announce', (req, res) => {
  const { adminCode, text } = req.body;

  if (adminCode !== ADMIN_CODE) {
    return res.status(401).json({ error: 'Invalid admin passcode. Access denied.' });
  }

  const cleanText = (text || '').trim().substring(0, 300);

  if (!cleanText) {
    // Empty text clears the current announcement.
    currentAnnouncement = null;
    return pusher.trigger('presence-chat', 'announcement', { announcement: null })
      .then(() => res.json({ success: true, announcement: null }))
      .catch((err) => {
        console.error('Announcement relay error:', err);
        res.status(500).json({ error: 'Failed to clear announcement.' });
      });
  }

  currentAnnouncement = {
    id: `ann-${Date.now()}`,
    text: cleanText,
    timestamp: Date.now()
  };

  pusher.trigger('presence-chat', 'announcement', { announcement: currentAnnouncement })
    .then(() => res.json({ success: true, announcement: currentAnnouncement }))
    .catch((err) => {
      console.error('Announcement relay error:', err);
      res.status(500).json({ error: 'Failed to broadcast announcement.' });
    });
});

// Endpoint to notify when a user joins
app.post('/api/join', (req, res) => {
  const { username } = req.body;
  const cleanUsername = (username || 'Anonymous').trim().substring(0, 25);
  
  res.json({ success: true });

  // Send Discord Webhook join announcement if enabled and monitored user matches
  if (appSettings.enabled && appSettings.webhookUrl && appSettings.monitoredUser) {
    const msgUser = cleanUsername.toLowerCase().trim();
    const targetUser = appSettings.monitoredUser.toLowerCase().trim();
    if (msgUser === targetUser) {
      const alertContent = `@everyone 🔔 **Aether Chatroom Announcement**\nUser **${cleanUsername}** has joined the chatroom!`;
      sendDiscordWebhook(appSettings.webhookUrl, alertContent)
        .catch(err => console.error('Failed to dispatch Discord webhook join alert:', err));
    }
  }
});

// Endpoint to retrieve full message history (guarded by admin code)
app.post('/api/history', (req, res) => {
  const { adminCode } = req.body;

  if (adminCode === ADMIN_CODE) {
    res.json({ success: true, messages: messageHistory });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin passcode. Access denied.' });
  }
});



const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Pusher configuration loaded successfully.');
});
