const express = require('express');
const path = require('path');
const fs = require('fs');
const Pusher = require('pusher');

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
  webhookUrl: '',
  monitoredUser: '',
  enabled: false
};

try {
  if (fs.existsSync(SETTINGS_FILE)) {
    const settingsContent = fs.readFileSync(SETTINGS_FILE, 'utf-8');
    appSettings = JSON.parse(settingsContent);
    console.log('Loaded application settings successfully.');
  }
} catch (error) {
  console.error('Failed to load application settings:', error);
}

function saveSettings(settings) {
  appSettings = {
    webhookUrl: settings.webhookUrl || '',
    monitoredUser: settings.monitoredUser || '',
    enabled: !!settings.enabled
  };
  try {
    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(appSettings, null, 2), 'utf-8');
  } catch (error) {
    console.error('Failed to write settings to file:', error);
  }
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

// Endpoint to send a message
app.post('/api/messages', (req, res) => {
  const { username, text } = req.body;
  
  const cleanUsername = (username || 'Anonymous').trim().substring(0, 25);
  const cleanText = (text || '').trim().substring(0, 1000);

  if (!cleanText) {
    return res.status(400).json({ error: 'Message content is required.' });
  }

  const message = {
    id: `msg-${Date.now()}-${Math.random()}`,
    username: cleanUsername,
    text: cleanText,
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

// Endpoint to retrieve full message history (guarded by admin code)
app.post('/api/history', (req, res) => {
  const { adminCode } = req.body;

  if (adminCode === ADMIN_CODE) {
    res.json({ success: true, messages: messageHistory });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin passcode. Access denied.' });
  }
});

// Endpoint to retrieve current settings (guarded by admin code)
app.post('/api/settings/get', (req, res) => {
  const { adminCode } = req.body;
  if (adminCode === ADMIN_CODE) {
    res.json({ success: true, settings: appSettings });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin passcode. Access denied.' });
  }
});

// Endpoint to save settings (guarded by admin code)
app.post('/api/settings/save', (req, res) => {
  const { adminCode, settings } = req.body;
  if (adminCode === ADMIN_CODE) {
    saveSettings(settings);
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin passcode. Access denied.' });
  }
});

// Endpoint to test webhook URL (guarded by admin code)
app.post('/api/settings/test', (req, res) => {
  const { adminCode, webhookUrl } = req.body;
  if (adminCode === ADMIN_CODE) {
    if (!webhookUrl) {
      return res.status(400).json({ success: false, error: 'Webhook URL is required.' });
    }
    sendDiscordWebhook(webhookUrl, "🔔 **Aether Chat**: This is a test notification. Your Discord Webhook integration is working successfully!")
      .then(() => {
        res.json({ success: true });
      })
      .catch(err => {
        console.error('Webhook test failed:', err);
        res.status(500).json({ success: false, error: err.message });
      });
  } else {
    res.status(401).json({ success: false, error: 'Invalid admin passcode. Access denied.' });
  }
});

const server = app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log('Pusher configuration loaded successfully.');
});
