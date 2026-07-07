// Client-side messaging controller using Pusher
document.addEventListener('DOMContentLoaded', () => {
  // App state
  let currentUsername = '';
  let isAdminAuthenticated = false;
  let currentAdminCode = ''; // Cached admin passcode for configurations
  let activeTab = 'live';
  let archiveMessages = []; // Cached messages for filtering & downloading
  
  // Typing Indicator state
  let activeTypingUsers = new Set();
  let typingTimeout = null;
  let isCurrentlyTyping = false;
  
  let pusherInstance = null;
  let presenceChannel = null;

  // DOM Elements - Onboarding
  const onboardingScreen = document.getElementById('onboarding-screen');
  const onboardingForm = document.getElementById('onboarding-form');
  const usernameInput = document.getElementById('username-input');

  // DOM Elements - Chat Area
  const chatShell = document.getElementById('chat-shell');
  const activeUsersCount = document.getElementById('active-users-count');
  const adminToggleBtn = document.getElementById('admin-toggle-btn');
  const adminTabs = document.getElementById('admin-tabs');
  const tabLive = document.getElementById('tab-live');
  const tabArchive = document.getElementById('tab-archive');
  const messagesContainer = document.getElementById('messages-container');
  const archiveContainer = document.getElementById('archive-container');
  const messageForm = document.getElementById('message-form');
  const messageInput = document.getElementById('message-input');

  // DOM Elements - Admin Controls
  const adminControls = document.getElementById('admin-controls');
  const filterUserInput = document.getElementById('filter-user-input');
  const clearFilterBtn = document.getElementById('clear-filter-btn');
  const saveChatsBtn = document.getElementById('save-chats-btn');

  // DOM Elements - Members & Header
  const headerUsername = document.getElementById('header-username');
  const membersCount = document.getElementById('members-count');
  const usersList = document.getElementById('users-list');

  // DOM Elements - Admin Modal
  const adminModal = document.getElementById('admin-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const adminForm = document.getElementById('admin-form');
  const adminCodeInput = document.getElementById('admin-code-input');
  const adminErrorMsg = document.getElementById('admin-error-msg');

  // DOM Elements - Announcements
  const announceBtn = document.getElementById('announce-btn');
  const announcementBanner = document.getElementById('announcement-banner');
  const announcementText = document.getElementById('announcement-text');
  const dismissAnnouncementBtn = document.getElementById('dismiss-announcement-btn');
  const announceModal = document.getElementById('announce-modal');
  const closeAnnounceModalBtn = document.getElementById('close-announce-modal-btn');
  const announceForm = document.getElementById('announce-form');
  const announceInput = document.getElementById('announce-input');
  const clearAnnounceBtn = document.getElementById('clear-announce-btn');

  // DOM Elements - Slash command hints
  const commandHints = document.getElementById('command-hints');

  // Minigame state (client-resolved; server only relays events)
  const activeGames = new Map(); // gameId -> { playerX, playerO, board, turn, status, boardEl }

  // Voice call roster (usernames currently in the Agora voice channel)
  const voiceMembers = new Set();
  const voiceRoster = document.getElementById('voice-roster');
  const voiceRosterList = document.getElementById('voice-roster-list');
  const voiceRosterCount = document.getElementById('voice-roster-count');

  // Settings (persisted locally). Notification sound is OFF by default.
  const SETTINGS_KEY = 'noir_settings';
  let userSettings = { soundNotifications: false };
  try {
    const saved = JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}');
    userSettings.soundNotifications = !!saved.soundNotifications;
  } catch (e) { /* ignore malformed storage */ }

  function saveSettings() {
    try { localStorage.setItem(SETTINGS_KEY, JSON.stringify(userSettings)); } catch (e) { /* ignore */ }
  }

  // DOM Elements - Settings
  const settingsBtn = document.getElementById('settings-btn');
  const settingsModal = document.getElementById('settings-modal');
  const closeSettingsModalBtn = document.getElementById('close-settings-modal-btn');
  const soundToggle = document.getElementById('sound-toggle');

  // Lazily-created audio context for notification sounds (browsers require a
  // user gesture before audio can play, hence the lazy resume-on-demand).
  let audioCtx = null;
  function ensureAudioContext() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    return audioCtx;
  }

  function playNotificationSound() {
    const ctx = ensureAudioContext();
    if (!ctx) return;
    const now = ctx.currentTime;
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.type = 'sine';
    osc.frequency.setValueAtTime(660, now);
    osc.frequency.setValueAtTime(880, now + 0.09);
    gain.gain.setValueAtTime(0.0001, now);
    gain.gain.exponentialRampToValueAtTime(0.14, now + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.3);
    osc.connect(gain);
    gain.connect(ctx.destination);
    osc.start(now);
    osc.stop(now + 0.32);
  }

  // Focus utility
  const focusElement = (el) => {
    if (el) setTimeout(() => el.focus(), 50);
  };

  // --- Onboarding Flow ---
  onboardingForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const username = usernameInput.value.trim();
    if (username) {
      currentUsername = username;
      headerUsername.textContent = username;
      
      // Initialize Pusher connection
      initPusher();
      
      // Notify server of join event
      fetch('/api/join', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username })
      }).catch(err => console.error('Error notifying join event:', err));
      
      // UI transition
      onboardingScreen.classList.add('hidden');
      chatShell.classList.remove('hidden');
      focusElement(messageInput);
    }
  });

  // --- Pusher Initialization & Channel Handlers ---
  async function initPusher() {
    if (pusherInstance) return;
    // Enable pusher logging for development debugging
    Pusher.logToConsole = true;

    try {
      const response = await fetch('/api/config');
      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }
      const config = await response.json();

      // Instantiate Pusher with credentials and pass the username for presence authorization
      pusherInstance = new Pusher(config.key, {
        cluster: config.cluster,
        channelAuthorization: {
          endpoint: '/pusher/auth',
          params: {
            username: currentUsername
          }
        }
      });

      // Subscribe to presence channel
      presenceChannel = pusherInstance.subscribe('presence-chat');

      // Subscription succeeded - retrieve initial online user list
      presenceChannel.bind('pusher:subscription_succeeded', (members) => {
        updateUserCount(members.count);
        updateActiveUsersList();
        // Bootstrap the voice roster so late joiners see who's already in the call
        fetch('/api/voice-presence')
          .then(res => res.json())
          .then(data => {
            (data.members || []).forEach(u => voiceMembers.add(u));
            renderVoiceRoster();
            updateActiveUsersList();
          })
          .catch(() => {});
        messagesContainer.appendChild(createSystemMessageElement({
          text: `Connected to The Lounge as ${currentUsername}. Session is active.`
        }));
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      });

      // Subscription failed
      presenceChannel.bind('pusher:subscription_error', (status) => {
        console.error('Subscription error:', status);
        messagesContainer.appendChild(createSystemMessageElement({
          text: 'Failed to connect to real-time sync. Please refresh.'
        }));
      });

      // Another member joined
      presenceChannel.bind('pusher:member_added', (member) => {
        updateUserCount(presenceChannel.members.count);
        updateActiveUsersList();
        const log = `${member.info.name} joined the chat.`;
        
        // Live View log
        messagesContainer.appendChild(createSystemMessageElement({ text: log, joined: true }));
        if (activeTab === 'live') {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        // Archive View log
        if (isAdminAuthenticated) {
          archiveMessages.push({ text: log, joined: true, system: true, timestamp: Date.now() });
          renderArchive();
        }
      });

      // Another member left
      presenceChannel.bind('pusher:member_removed', (member) => {
        updateUserCount(presenceChannel.members.count);

        // If they were in voice, drop them from the roster too (covers closed tabs)
        if (voiceMembers.delete(member.info.name)) {
          renderVoiceRoster();
        }
        updateActiveUsersList();

        // Remove from typing list if they were typing
        activeTypingUsers.delete(member.info.name);
        updateTypingIndicator();

        const log = `${member.info.name} left the chat.`;

        // Live View log
        messagesContainer.appendChild(createSystemMessageElement({ text: log, left: true }));
        if (activeTab === 'live') {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }
        
        // Archive View log
        if (isAdminAuthenticated) {
          archiveMessages.push({ text: log, left: true, system: true, timestamp: Date.now() });
          renderArchive();
        }
      });

      // Live message received
      presenceChannel.bind('new-message', (msg) => {
        const isSelf = msg.username === currentUsername;

        // Clear typing indicator for this user when they send a message
        activeTypingUsers.delete(msg.username);
        updateTypingIndicator();

        // Notification sound for messages from others while the tab is unfocused
        if (!isSelf && userSettings.soundNotifications && (document.hidden || !document.hasFocus())) {
          playNotificationSound();
        }

        // 1. Append to live viewport
        messagesContainer.appendChild(createMessageElement(msg, isSelf, false));
        if (activeTab === 'live') {
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }

        // 2. Append to archive viewport if unlocked
        if (isAdminAuthenticated) {
          archiveMessages.push(msg);
          renderArchive();
        }
      });

      // Real-time typing event relayed via the server
      presenceChannel.bind('typing', (data) => {
        if (!data || data.username === currentUsername) return;

        if (data.isTyping) {
          activeTypingUsers.add(data.username);
        } else {
          activeTypingUsers.delete(data.username);
        }
        updateTypingIndicator();
      });

      // Broadcast announcement banner updates
      presenceChannel.bind('announcement', (data) => {
        renderAnnouncement(data ? data.announcement : null);
      });

      // Voice call roster updates (someone joined/left the voice channel)
      presenceChannel.bind('voice-presence', (data) => {
        if (!data || !data.username) return;
        if (data.inVoice) {
          voiceMembers.add(data.username);
          if (data.uid) {
            voiceUidToUsername.set(data.uid, data.username);
            voiceUsernameToUid.set(data.username, data.uid);
          }
        } else {
          voiceMembers.delete(data.username);
          const mappedUid = voiceUsernameToUid.get(data.username);
          if (mappedUid) {
            voiceUidToUsername.delete(mappedUid);
            voiceUsernameToUid.delete(data.username);
            activeStreamers.delete(mappedUid);
          }
        }
        renderVoiceRoster();
        updateActiveUsersList();
      });

      // Minigame events (invite / accept / decline / move)
      presenceChannel.bind('game', (data) => {
        handleGameEvent(data);
      });

      // Pull any active announcement so late joiners see the banner too
      fetch('/api/announcement')
        .then(res => res.json())
        .then(data => renderAnnouncement(data.announcement))
        .catch(() => {});
    } catch (error) {
      console.error('Error initializing Pusher config:', error);
      messagesContainer.appendChild(createSystemMessageElement({
        text: 'Failed to retrieve connection config. Please reload the page.'
      }));
    }
  }

  // Update user count element (header + members sidebar badge)
  function updateUserCount(count) {
    activeUsersCount.textContent = `${count} active user${count === 1 ? '' : 's'}`;
    if (membersCount) {
      membersCount.textContent = count;
    }
  }

  // Send a chat message (optionally as an 'action' kind) to the server.
  function sendChatMessage(text, kind = 'message') {
    return fetch('/api/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username: currentUsername, text, kind })
    })
    .then(res => res.json())
    .then(data => {
      if (!data.success) {
        console.error('API Error sending message:', data.error);
      }
      return data;
    })
    .catch(err => console.error('Error sending message:', err));
  }

  // --- Real-time Messaging Submission ---
  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (!text) return;

    // Reset typing state immediately
    if (isCurrentlyTyping) {
      isCurrentlyTyping = false;
      clearTimeout(typingTimeout);
      sendTypingState(false);
    }

    hideCommandHints();

    // Slash commands are intercepted before hitting the message API
    if (text.startsWith('/')) {
      messageInput.value = '';
      handleSlashCommand(text);
      focusElement(messageInput);
      return;
    }

    sendChatMessage(text);
    messageInput.value = '';
    focusElement(messageInput);
  });

  // Helper to format time (HH:MM)
  function formatTime(timestamp) {
    const date = new Date(timestamp);
    const hours = String(date.getHours()).padStart(2, '0');
    const minutes = String(date.getMinutes()).padStart(2, '0');
    return `${hours}:${minutes}`;
  }

  // Helper to format full date-time for archive
  function formatFullDateTime(timestamp) {
    const date = new Date(timestamp);
    return date.toLocaleString();
  }

  // Helper to convert URLs, Giphy links, and direct images into Discord-style embeds
  function formatMessageContent(text) {
    // 1. Escape HTML to prevent XSS
    const div = document.createElement('div');
    div.textContent = text;
    let escapedText = div.innerHTML;

    // Regex to match URLs
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    
    // Find all matches
    const urls = text.match(urlRegex) || [];
    let embedsHtml = '';
    
    // Replace links in the text with anchors
    escapedText = escapedText.replace(urlRegex, (url) => {
      return `<a href="${url}" target="_blank" rel="noopener noreferrer" class="chat-link">${url}</a>`;
    });

    // Generate embeds for each URL
    urls.forEach(url => {
      // 1. Check if it's a direct image link
      const isDirectImage = /\.(jpeg|jpg|gif|png|webp)(?:\?.*)?$/i.test(url);
      
      // 2. Check if it's a Giphy link
      const giphyRegex = /https?:\/\/(?:media\d*\.giphy\.com\/media\/([a-zA-Z0-9]+)\/giphy\.gif|giphy\.com\/gifs\/(?:[a-zA-Z0-9-]+-)?([a-zA-Z0-9]+))/i;
      const giphyMatch = url.match(giphyRegex);

      if (isDirectImage) {
        embedsHtml += `
          <div class="chat-embed-image">
            <img src="${url}" alt="Shared Image" loading="lazy" />
          </div>
        `;
      } else if (giphyMatch) {
        const giphyId = giphyMatch[1] || giphyMatch[2];
        const directGiphyUrl = `https://media.giphy.com/media/${giphyId}/giphy.gif`;
        embedsHtml += `
          <div class="chat-embed-image">
            <img src="${directGiphyUrl}" alt="Giphy GIF" loading="lazy" />
          </div>
        `;
      }
    });

    return `<span class="message-text">${escapedText}</span>` + embedsHtml;
  }

  // Helper to create and return a message element securely
  function createMessageElement(msg, isSelf, isArchive = false) {
    // Action messages (/me, dice rolls, etc.) render as a centered emote line
    if (msg.kind === 'action') {
      const actionDiv = document.createElement('div');
      actionDiv.classList.add('action-message');
      const textSpan = document.createElement('span');
      textSpan.classList.add('action-text');
      textSpan.textContent = `${isSelf ? 'You' : msg.username} ${msg.text}`;
      actionDiv.appendChild(textSpan);
      return actionDiv;
    }

    const messageDiv = document.createElement('div');
    messageDiv.classList.add('message');
    if (isArchive) {
      messageDiv.classList.add('archived-msg');
    }
    messageDiv.classList.add(isSelf ? 'self' : 'other');

    // Message meta block
    const metaDiv = document.createElement('div');
    metaDiv.classList.add('message-meta');

    const nameSpan = document.createElement('span');
    nameSpan.classList.add('msg-username');
    nameSpan.textContent = isSelf ? 'You' : msg.username;

    const timeSpan = document.createElement('span');
    timeSpan.classList.add('msg-time');
    timeSpan.textContent = isArchive ? formatFullDateTime(msg.timestamp) : formatTime(msg.timestamp);

    metaDiv.appendChild(nameSpan);
    
    if (isArchive) {
      const badge = document.createElement('span');
      badge.classList.add('archive-badge');
      badge.textContent = 'Archive';
      metaDiv.appendChild(badge);
    }
    
    metaDiv.appendChild(timeSpan);

    // Message content block
    const contentDiv = document.createElement('div');
    contentDiv.classList.add('message-content');
    contentDiv.innerHTML = formatMessageContent(msg.text);

    messageDiv.appendChild(metaDiv);
    messageDiv.appendChild(contentDiv);

    return messageDiv;
  }

  // Helper to create and return a system message element
  function createSystemMessageElement(msg) {
    const sysDiv = document.createElement('div');
    sysDiv.classList.add('system-message');
    if (msg.joined) {
      sysDiv.classList.add('joined');
    } else if (msg.left) {
      sysDiv.classList.add('left');
    }

    const textSpan = document.createElement('span');
    textSpan.classList.add('sys-text');
    textSpan.textContent = msg.text;

    sysDiv.appendChild(textSpan);
    return sysDiv;
  }

  // --- Admin Verification Drawer Flow ---
  adminToggleBtn.addEventListener('click', () => {
    if (isAdminAuthenticated) {
      adminTabs.classList.toggle('hidden');
      if (adminTabs.classList.contains('hidden')) {
        switchTab('live');
        adminControls.classList.add('hidden');
        adminToggleBtn.classList.remove('active');
      } else {
        adminToggleBtn.classList.add('active');
        switchTab('archive');
      }
    } else {
      adminModal.classList.remove('hidden');
      adminErrorMsg.classList.add('hidden');
      adminCodeInput.value = '';
      focusElement(adminCodeInput);
    }
  });

  closeModalBtn.addEventListener('click', () => {
    adminModal.classList.add('hidden');
    focusElement(messageInput);
  });

  adminModal.addEventListener('click', (e) => {
    if (e.target === adminModal) {
      adminModal.classList.add('hidden');
      focusElement(messageInput);
    }
  });

  // Admin Code verification submit
  adminForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const adminCode = adminCodeInput.value.trim();
    if (adminCode) {
      fetch('/api/history', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ adminCode })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          isAdminAuthenticated = true;
          currentAdminCode = adminCode;
          adminModal.classList.add('hidden');
          adminTabs.classList.remove('hidden');
          adminToggleBtn.classList.add('active');
          announceBtn.classList.remove('hidden');
          
          // Cache history messages
          archiveMessages = data.messages || [];
          
          // Render the messages using dynamic filter/render logic
          renderArchive();

          // Switch to the archive view tab immediately
          switchTab('archive');
        } else {
          adminErrorMsg.textContent = data.error || 'Authentication failed.';
          adminErrorMsg.classList.remove('hidden');
          adminCodeInput.value = '';
          focusElement(adminCodeInput);
        }
      })
      .catch(err => {
        console.error('Error fetching history:', err);
        adminErrorMsg.textContent = 'Connection error. Please try again.';
        adminErrorMsg.classList.remove('hidden');
      });
    }
  });

  // Render function for Archive with filtering
  function renderArchive() {
    // Keep first element (the system description banner) if it exists
    const firstSystemMessage = archiveContainer.querySelector('.system-message');
    archiveContainer.innerHTML = '';
    if (firstSystemMessage) {
      archiveContainer.appendChild(firstSystemMessage);
    }

    const filterVal = filterUserInput.value.trim().toLowerCase();
    if (filterVal) {
      clearFilterBtn.classList.remove('hidden');
    } else {
      clearFilterBtn.classList.add('hidden');
    }

    archiveMessages.forEach(msg => {
      if (filterVal) {
        // Skip system log entries when filtering by specific user
        if (msg.system) return;
        if (!msg.username || !msg.username.toLowerCase().includes(filterVal)) {
          return;
        }
      }

      if (msg.system) {
        archiveContainer.appendChild(createSystemMessageElement(msg));
      } else {
        const isSelf = msg.username === currentUsername;
        archiveContainer.appendChild(createMessageElement(msg, isSelf, true));
      }
    });

    archiveContainer.scrollTop = archiveContainer.scrollHeight;
  }

  // --- View Switch Tabs ---
  function switchTab(target) {
    if (target === 'live') {
      activeTab = 'live';
      tabLive.classList.add('active');
      tabArchive.classList.remove('active');
      
      messagesContainer.classList.remove('hidden-view');
      messagesContainer.classList.add('active-view');
      
      archiveContainer.classList.remove('active-view');
      archiveContainer.classList.add('hidden-view');
      
      // Hide admin controls in live view
      adminControls.classList.add('hidden');
      
      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    } else if (target === 'archive') {
      activeTab = 'archive';
      tabArchive.classList.add('active');
      tabLive.classList.remove('active');
      
      archiveContainer.classList.remove('hidden-view');
      archiveContainer.classList.add('active-view');
      
      messagesContainer.classList.remove('active-view');
      messagesContainer.classList.add('hidden-view');
      
      // Show admin controls in archive view if authenticated
      if (isAdminAuthenticated) {
        adminControls.classList.remove('hidden');
      }
      
      archiveContainer.scrollTop = archiveContainer.scrollHeight;
    }
  }

  tabLive.addEventListener('click', () => switchTab('live'));
  tabArchive.addEventListener('click', () => switchTab('archive'));

  // --- Search Filter Inputs & Save Events ---
  filterUserInput.addEventListener('input', () => {
    renderArchive();
  });

  clearFilterBtn.addEventListener('click', () => {
    filterUserInput.value = '';
    renderArchive();
    focusElement(filterUserInput);
  });

  saveChatsBtn.addEventListener('click', () => {
    if (archiveMessages.length === 0) {
      alert('No messages found to export.');
      return;
    }

    let fileContent = `NOIR — THE LOUNGE ARCHIVE LOG\r\n`;
    fileContent += `Export Date: ${new Date().toLocaleString()}\r\n`;
    fileContent += `==================================================\r\n\r\n`;

    archiveMessages.forEach(msg => {
      const timeStr = new Date(msg.timestamp).toLocaleString();
      if (msg.system) {
        fileContent += `[${timeStr}] [SYSTEM LOG] ${msg.text}\r\n`;
      } else {
        fileContent += `[${timeStr}] [${msg.username}] ${msg.text}\r\n`;
      }
    });

    const blob = new Blob([fileContent], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    
    const downloadLink = document.createElement('a');
    downloadLink.href = url;
    downloadLink.download = `chat_log_${Date.now()}.txt`;
    document.body.appendChild(downloadLink);
    downloadLink.click();
    
    document.body.removeChild(downloadLink);
    URL.revokeObjectURL(url);
  });



  // Update the Active Users List modal content
  function updateActiveUsersList() {
    usersList.innerHTML = '';
    if (!presenceChannel || !presenceChannel.members) return;

    const rendered = new Set();

    presenceChannel.members.each((member) => {
      const username = member.info.name;
      if (rendered.has(username)) return;
      rendered.add(username);
      const isSelf = username === currentUsername;

      const li = document.createElement('li');
      li.classList.add('user-list-item');
      if (isSelf) {
        li.classList.add('self-item');
      }

      const icon = document.createElement('i');
      icon.classList.add('fa-solid', 'fa-circle-user');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = username + (isSelf ? ' (You)' : '');

      li.appendChild(icon);
      li.appendChild(nameSpan);

      // Speaker badge for members currently in the voice call
      if (voiceMembers.has(username)) {
        const voiceIcon = document.createElement('i');
        voiceIcon.classList.add('fa-solid', 'fa-volume-high', 'voice-indicator');
        voiceIcon.title = 'In voice';
        li.appendChild(voiceIcon);
      }

      usersList.appendChild(li);
    });
  }

  // Render the "In Voice" roster in the sidebar
  function renderVoiceRoster() {
    if (!voiceRoster || !voiceRosterList) return;
    voiceRosterList.innerHTML = '';

    const members = Array.from(voiceMembers);
    if (voiceRosterCount) voiceRosterCount.textContent = members.length;

    if (members.length === 0) {
      voiceRoster.classList.add('hidden');
      return;
    }
    voiceRoster.classList.remove('hidden');

    members.forEach((username) => {
      const isSelf = username === currentUsername;
      const li = document.createElement('li');
      li.classList.add('voice-roster-item');
      if (isSelf) li.classList.add('self-item');

      const icon = document.createElement('i');
      icon.classList.add('fa-solid', 'fa-microphone');

      const nameSpan = document.createElement('span');
      nameSpan.textContent = username + (isSelf ? ' (You)' : '');

      li.appendChild(icon);
      li.appendChild(nameSpan);

      // If this member is actively streaming screen (and not self), show a Watch button next to their name
      const userUid = voiceUsernameToUid.get(username);
      if (userUid && activeStreamers.has(userUid) && !isSelf) {
        const watchBtn = document.createElement('button');
        watchBtn.className = 'watch-stream-badge-btn';
        
        const isWatching = (currentViewingUid === userUid);
        watchBtn.innerHTML = isWatching 
          ? `<i class="fa-solid fa-stop"></i> Stop` 
          : `<i class="fa-solid fa-play"></i> Watch`;
        
        watchBtn.addEventListener('click', (e) => {
          e.stopPropagation();
          const remoteUser = activeStreamers.get(userUid);
          if (remoteUser) {
            if (currentViewingUid === userUid) {
              hideRemoteScreenShare(remoteUser);
              currentViewingUid = null;
              watchBtn.innerHTML = `<i class="fa-solid fa-play"></i> Watch`;
            } else {
              showRemoteScreenShare(remoteUser);
              currentViewingUid = userUid;
              watchBtn.innerHTML = `<i class="fa-solid fa-stop"></i> Stop`;
            }
          }
        });
        li.appendChild(watchBtn);
      }

      voiceRosterList.appendChild(li);
    });
  }

  // Broadcast our own voice join/leave so everyone's roster updates
  function announceVoicePresence(inVoice, uid = 0) {
    if (!currentUsername) return;
    fetch('/api/voice-presence', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username: currentUsername, inVoice, uid })
    }).catch(err => console.error('Error announcing voice presence:', err));
  }

  // Helper to render/update typing indicators
  function updateTypingIndicator() {
    let typingDiv = document.getElementById('typing-indicator');
    
    if (activeTypingUsers.size > 0) {
      // Build display text
      const usersArray = Array.from(activeTypingUsers);
      let text = '';
      if (usersArray.length === 1) {
        text = `${usersArray[0]} is typing...`;
      } else if (usersArray.length === 2) {
        text = `${usersArray[0]} and ${usersArray[1]} are typing...`;
      } else {
        text = `Several people are typing...`;
      }
      
      // Determine if scroll is near bottom
      const isNearBottom = messagesContainer.scrollHeight - messagesContainer.scrollTop - messagesContainer.clientHeight < 50;

      if (!typingDiv) {
        typingDiv = document.createElement('div');
        typingDiv.id = 'typing-indicator';
        typingDiv.classList.add('message', 'other');
        
        const metaDiv = document.createElement('div');
        metaDiv.classList.add('message-meta');
        const nameSpan = document.createElement('span');
        nameSpan.classList.add('msg-username');
        metaDiv.appendChild(nameSpan);
        
        const bubbleDiv = document.createElement('div');
        bubbleDiv.classList.add('message-content', 'typing-bubble');
        
        for (let i = 0; i < 3; i++) {
          const dot = document.createElement('div');
          dot.classList.add('typing-dot');
          bubbleDiv.appendChild(dot);
        }
        
        typingDiv.appendChild(metaDiv);
        typingDiv.appendChild(bubbleDiv);
        messagesContainer.appendChild(typingDiv);
      }
      
      typingDiv.querySelector('.msg-username').textContent = text;
      
      if (isNearBottom) {
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    } else {
      if (typingDiv) {
        typingDiv.remove();
      }
    }
  }

  // Relay typing state through the server so it works without Pusher client events
  function sendTypingState(isTyping) {
    if (!currentUsername) return;
    fetch('/api/typing', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ username: currentUsername, isTyping })
    }).catch(err => console.error('Error sending typing state:', err));
  }

  // --- Message Input Typing Event Triggers ---
  messageInput.addEventListener('input', () => {
    if (!currentUsername) return;

    // Show slash-command hints while composing a command
    updateCommandHints(messageInput.value);

    if (!isCurrentlyTyping) {
      isCurrentlyTyping = true;
      sendTypingState(true);
    }

    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => {
      isCurrentlyTyping = false;
      sendTypingState(false);
    }, 2500);
  });

  // Global Keybind: Esc closes modals / hint bar
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!adminModal.classList.contains('hidden')) {
        adminModal.classList.add('hidden');
        focusElement(messageInput);
      }
      if (announceModal && !announceModal.classList.contains('hidden')) {
        announceModal.classList.add('hidden');
        focusElement(messageInput);
      }
      if (settingsModal && !settingsModal.classList.contains('hidden')) {
        settingsModal.classList.add('hidden');
        focusElement(messageInput);
      }
      hideCommandHints();
    }
  });

  // =====================================================================
  //  Slash commands
  // =====================================================================
  const SLASH_COMMANDS = [
    { name: '/help', usage: '/help', desc: 'List all commands' },
    { name: '/me', usage: '/me <action>', desc: 'Send an emote, e.g. /me waves' },
    { name: '/shrug', usage: '/shrug [text]', desc: 'Append ¯\\_(ツ)_/¯' },
    { name: '/roll', usage: '/roll [max]', desc: 'Roll a die (default 6)' },
    { name: '/flip', usage: '/flip', desc: 'Flip a coin' },
    { name: '/8ball', usage: '/8ball <question>', desc: 'Ask the magic 8-ball' },
    { name: '/ttt', usage: '/ttt <user>', desc: 'Challenge someone to Tic-Tac-Toe' },
    { name: '/clear', usage: '/clear', desc: 'Clear your local chat view' }
  ];

  const EIGHT_BALL = [
    'It is certain.', 'Without a doubt.', 'Yes — definitely.', 'Most likely.',
    'Signs point to yes.', 'Reply hazy, try again.', 'Ask again later.',
    'Cannot predict now.', "Don't count on it.", 'My reply is no.',
    'Very doubtful.', 'Outlook not so good.'
  ];

  function localSystemMessage(text) {
    messagesContainer.appendChild(createSystemMessageElement({ text }));
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function handleSlashCommand(raw) {
    const parts = raw.slice(1).trim().split(/\s+/);
    const cmd = (parts.shift() || '').toLowerCase();
    const rest = parts.join(' ').trim();

    switch (cmd) {
      case 'help':
        localSystemMessage(
          'Commands — ' + SLASH_COMMANDS.map(c => c.usage).join('  ·  ')
        );
        break;
      case 'me':
        if (!rest) return localSystemMessage('Usage: /me <action>');
        sendChatMessage(rest, 'action');
        break;
      case 'shrug':
        sendChatMessage((rest ? rest + ' ' : '') + '¯\\_(ツ)_/¯');
        break;
      case 'roll': {
        const max = Math.max(2, Math.min(1000, parseInt(rest, 10) || 6));
        const result = Math.floor(Math.random() * max) + 1;
        sendChatMessage(`🎲 rolled ${result} (1–${max})`, 'action');
        break;
      }
      case 'flip':
        sendChatMessage(`🪙 flipped ${Math.random() < 0.5 ? 'Heads' : 'Tails'}`, 'action');
        break;
      case '8ball':
        if (!rest) return localSystemMessage('Usage: /8ball <question>');
        sendChatMessage(`🎱 ${EIGHT_BALL[Math.floor(Math.random() * EIGHT_BALL.length)]}`, 'action');
        break;
      case 'ttt':
      case 'tictactoe':
        startTicTacToe(rest.replace(/^@/, ''));
        break;
      case 'clear':
        clearLocalMessages();
        break;
      default:
        localSystemMessage(`Unknown command: /${cmd}. Try /help`);
    }
  }

  function clearLocalMessages() {
    messagesContainer.innerHTML = '';
    localSystemMessage('Local view cleared. Server history is unaffected.');
  }

  // --- Command hint bar ---
  function updateCommandHints(value) {
    if (!value.startsWith('/') || value.includes(' ')) {
      hideCommandHints();
      return;
    }
    const q = value.toLowerCase();
    const matches = SLASH_COMMANDS.filter(c => c.name.startsWith(q));
    if (matches.length === 0) {
      hideCommandHints();
      return;
    }
    commandHints.innerHTML = '';
    matches.forEach(c => {
      const row = document.createElement('button');
      row.type = 'button';
      row.classList.add('command-hint');
      const name = document.createElement('span');
      name.classList.add('command-hint-name');
      name.textContent = c.usage;
      const desc = document.createElement('span');
      desc.classList.add('command-hint-desc');
      desc.textContent = c.desc;
      row.appendChild(name);
      row.appendChild(desc);
      row.addEventListener('click', () => {
        messageInput.value = c.name + ' ';
        hideCommandHints();
        focusElement(messageInput);
      });
      commandHints.appendChild(row);
    });
    commandHints.classList.remove('hidden');
  }

  function hideCommandHints() {
    commandHints.classList.add('hidden');
    commandHints.innerHTML = '';
  }

  // =====================================================================
  //  Admin announcements
  // =====================================================================
  function renderAnnouncement(announcement) {
    if (!announcement || !announcement.text) {
      announcementBanner.classList.add('hidden');
      announcementText.textContent = '';
      announcementBanner.removeAttribute('data-ann-id');
      return;
    }
    announcementText.textContent = announcement.text;
    announcementBanner.setAttribute('data-ann-id', announcement.id || '');
    announcementBanner.classList.remove('hidden');
  }

  if (announceBtn) {
    announceBtn.addEventListener('click', () => {
      if (!isAdminAuthenticated) return;
      announceInput.value = announcementText.textContent || '';
      announceModal.classList.remove('hidden');
      focusElement(announceInput);
    });
  }

  if (closeAnnounceModalBtn) {
    closeAnnounceModalBtn.addEventListener('click', () => {
      announceModal.classList.add('hidden');
      focusElement(messageInput);
    });
  }

  if (announceModal) {
    announceModal.addEventListener('click', (e) => {
      if (e.target === announceModal) {
        announceModal.classList.add('hidden');
        focusElement(messageInput);
      }
    });
  }

  if (announceForm) {
    announceForm.addEventListener('submit', (e) => {
      e.preventDefault();
      const text = announceInput.value.trim();
      if (!text) return;
      postAnnouncement(text);
      announceModal.classList.add('hidden');
      focusElement(messageInput);
    });
  }

  if (clearAnnounceBtn) {
    clearAnnounceBtn.addEventListener('click', () => {
      postAnnouncement('');
      announceModal.classList.add('hidden');
      focusElement(messageInput);
    });
  }

  if (dismissAnnouncementBtn) {
    // Dismiss only hides the banner locally; it does not clear it for others
    dismissAnnouncementBtn.addEventListener('click', () => {
      announcementBanner.classList.add('hidden');
    });
  }

  function postAnnouncement(text) {
    fetch('/api/announce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ adminCode: currentAdminCode, text })
    })
    .then(res => res.json())
    .then(data => {
      if (!data.success) {
        console.error('Announcement error:', data.error);
        localSystemMessage(data.error || 'Failed to post announcement.');
      }
    })
    .catch(err => console.error('Error posting announcement:', err));
  }

  // =====================================================================
  //  Settings
  // =====================================================================
  if (settingsBtn) {
    settingsBtn.addEventListener('click', () => {
      if (soundToggle) soundToggle.checked = userSettings.soundNotifications;
      settingsModal.classList.remove('hidden');
    });
  }

  if (closeSettingsModalBtn) {
    closeSettingsModalBtn.addEventListener('click', () => {
      settingsModal.classList.add('hidden');
      focusElement(messageInput);
    });
  }

  if (settingsModal) {
    settingsModal.addEventListener('click', (e) => {
      if (e.target === settingsModal) {
        settingsModal.classList.add('hidden');
        focusElement(messageInput);
      }
    });
  }

  if (soundToggle) {
    soundToggle.addEventListener('change', () => {
      userSettings.soundNotifications = soundToggle.checked;
      saveSettings();
      // Turning it on is a user gesture — unlock audio and play a confirmation
      // chime so it's clear it works.
      if (soundToggle.checked) {
        playNotificationSound();
      }
    });
  }

  // =====================================================================
  //  Tic-Tac-Toe minigame
  // =====================================================================
  const WIN_LINES = [
    [0, 1, 2], [3, 4, 5], [6, 7, 8],
    [0, 3, 6], [1, 4, 7], [2, 5, 8],
    [0, 4, 8], [2, 4, 6]
  ];

  function relayGame(payload) {
    fetch('/api/game', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    }).catch(err => console.error('Error relaying game action:', err));
  }

  function findMemberByName(name) {
    if (!presenceChannel || !presenceChannel.members || !name) return null;
    let found = null;
    presenceChannel.members.each((m) => {
      if (m.info.name.toLowerCase() === name.toLowerCase()) found = m.info.name;
    });
    return found;
  }

  function startTicTacToe(targetRaw) {
    const target = (targetRaw || '').trim();
    if (!target) return localSystemMessage('Usage: /ttt <user> — challenge someone online.');
    if (target.toLowerCase() === currentUsername.toLowerCase()) {
      return localSystemMessage("You can't challenge yourself.");
    }
    const opponent = findMemberByName(target);
    if (!opponent) {
      return localSystemMessage(`"${target}" isn't online. Pick someone from the members list.`);
    }
    const gameId = `ttt-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    relayGame({ type: 'invite', gameId, from: currentUsername, to: opponent });
  }

  function handleGameEvent(data) {
    if (!data || !data.gameId) return;
    switch (data.type) {
      case 'invite':
        renderGameInvite(data);
        break;
      case 'decline':
        if (data.from === currentUsername || data.to === currentUsername) {
          localSystemMessage(`${data.by || data.to} declined the Tic-Tac-Toe challenge.`);
        }
        break;
      case 'accept':
        startGameBoard(data);
        break;
      case 'move':
        applyGameMove(data);
        break;
    }
  }

  function renderGameInvite(data) {
    const card = document.createElement('div');
    card.classList.add('game-card', 'system-message');

    const title = document.createElement('div');
    title.classList.add('game-card-title');
    title.textContent = `${data.from} challenged ${data.to} to Tic-Tac-Toe`;
    card.appendChild(title);

    if (data.to === currentUsername) {
      const actions = document.createElement('div');
      actions.classList.add('game-card-actions');

      const accept = document.createElement('button');
      accept.classList.add('game-btn', 'accept');
      accept.textContent = 'Accept';
      accept.addEventListener('click', () => {
        actions.remove();
        // Inviter is X, invitee is O
        relayGame({ type: 'accept', gameId: data.gameId, playerX: data.from, playerO: data.to });
      });

      const decline = document.createElement('button');
      decline.classList.add('game-btn', 'decline');
      decline.textContent = 'Decline';
      decline.addEventListener('click', () => {
        actions.remove();
        relayGame({ type: 'decline', gameId: data.gameId, from: data.from, to: data.to, by: currentUsername });
      });

      actions.appendChild(accept);
      actions.appendChild(decline);
      card.appendChild(actions);
    } else if (data.from !== currentUsername) {
      const note = document.createElement('div');
      note.classList.add('game-card-note');
      note.textContent = 'Spectating…';
      card.appendChild(note);
    }

    messagesContainer.appendChild(card);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
  }

  function startGameBoard(data) {
    if (activeGames.has(data.gameId)) return;

    const game = {
      playerX: data.playerX,
      playerO: data.playerO,
      board: Array(9).fill(null),
      turn: 'X',
      status: 'playing',
      boardEl: null
    };

    const card = document.createElement('div');
    card.classList.add('game-board-card', 'system-message');

    const header = document.createElement('div');
    header.classList.add('game-board-header');
    header.textContent = `Tic-Tac-Toe — ${game.playerX} (X) vs ${game.playerO} (O)`;
    card.appendChild(header);

    const status = document.createElement('div');
    status.classList.add('game-board-status');
    card.appendChild(status);

    const grid = document.createElement('div');
    grid.classList.add('game-grid');
    for (let i = 0; i < 9; i++) {
      const cell = document.createElement('button');
      cell.classList.add('game-cell');
      cell.dataset.index = String(i);
      cell.addEventListener('click', () => attemptMove(data.gameId, i));
      grid.appendChild(cell);
    }
    card.appendChild(grid);

    game.boardEl = { card, status, grid };
    activeGames.set(data.gameId, game);

    messagesContainer.appendChild(card);
    messagesContainer.scrollTop = messagesContainer.scrollHeight;
    updateGameStatus(data.gameId);
  }

  function myMarkFor(game) {
    if (game.playerX === currentUsername) return 'X';
    if (game.playerO === currentUsername) return 'O';
    return null;
  }

  function attemptMove(gameId, index) {
    const game = activeGames.get(gameId);
    if (!game || game.status !== 'playing') return;
    const myMark = myMarkFor(game);
    if (!myMark) return; // spectators can't play
    if (game.turn !== myMark) return; // not your turn
    if (game.board[index]) return; // occupied
    relayGame({ type: 'move', gameId, index, mark: myMark, by: currentUsername });
  }

  function applyGameMove(data) {
    const game = activeGames.get(data.gameId);
    if (!game || game.status !== 'playing') return;
    if (typeof data.index !== 'number' || data.index < 0 || data.index > 8) return;
    if (game.board[data.index]) return;
    if (data.mark !== game.turn) return; // enforce turn order consistently

    game.board[data.index] = data.mark;
    game.turn = data.mark === 'X' ? 'O' : 'X';
    updateGameBoard(data.gameId);

    const winner = getWinner(game.board);
    if (winner) {
      game.status = 'won';
      updateGameBoard(data.gameId, winner.line);
    } else if (game.board.every(Boolean)) {
      game.status = 'draw';
    }
    updateGameStatus(data.gameId, winner);
  }

  function getWinner(board) {
    for (const line of WIN_LINES) {
      const [a, b, c] = line;
      if (board[a] && board[a] === board[b] && board[a] === board[c]) {
        return { mark: board[a], line };
      }
    }
    return null;
  }

  function updateGameBoard(gameId, winLine) {
    const game = activeGames.get(gameId);
    if (!game || !game.boardEl) return;
    const cells = game.boardEl.grid.querySelectorAll('.game-cell');
    cells.forEach((cell, i) => {
      cell.textContent = game.board[i] || '';
      cell.classList.toggle('x', game.board[i] === 'X');
      cell.classList.toggle('o', game.board[i] === 'O');
      cell.classList.toggle('filled', Boolean(game.board[i]));
      if (winLine) cell.classList.toggle('win', winLine.includes(i));
    });
  }

  function updateGameStatus(gameId, winner) {
    const game = activeGames.get(gameId);
    if (!game || !game.boardEl) return;
    const statusEl = game.boardEl.status;
    const myMark = myMarkFor(game);

    if (game.status === 'won' && winner) {
      const winnerName = winner.mark === 'X' ? game.playerX : game.playerO;
      const iWon = winner.mark === myMark;
      statusEl.textContent = myMark
        ? (iWon ? 'You win! 🏆' : `${winnerName} wins.`)
        : `${winnerName} (${winner.mark}) wins.`;
      game.boardEl.grid.classList.add('game-over');
    } else if (game.status === 'draw') {
      statusEl.textContent = "It's a draw.";
      game.boardEl.grid.classList.add('game-over');
    } else {
      const turnName = game.turn === 'X' ? game.playerX : game.playerO;
      const yourTurn = myMark && game.turn === myMark;
      statusEl.textContent = yourTurn ? 'Your turn' : `${turnName}'s turn (${game.turn})`;
      game.boardEl.grid.classList.toggle('my-turn', Boolean(yourTurn));
    }
  }

  // --- Agora Voice Call & Streaming Integration ---
  const AGORA_APP_ID = "9f05b55c788b47f3a11622bd8ac945ad";
  const VOICE_CHANNEL = "lounge-voice";

  let rtc = {
    client: null,
    localAudioTrack: null,
    localVideoTrack: null, // Screen share track
    localScreenAudioTrack: null, // Screen share audio track
    joined: false,
    muted: false,
    sharingScreen: false,
    aloneTimer: null
  };

  // Maps and state to resolve screen sharing streams and watch lists
  const voiceUidToUsername = new Map();
  const voiceUsernameToUid = new Map();
  const activeStreamers = new Map(); // maps remoteUid -> remoteUser object
  let currentViewingUid = null;

  const joinVoiceBtn = document.getElementById('join-voice-btn');
  const voiceControls = document.getElementById('voice-controls');
  const muteVoiceBtn = document.getElementById('mute-voice-btn');
  const leaveVoiceBtn = document.getElementById('leave-voice-btn');
  const voiceStatusText = document.getElementById('voice-status-text');

  // Screen Share elements
  const screenShareViewport = document.getElementById('screen-share-viewport');
  const screenShareLabel = document.getElementById('screen-share-label');
  const screenSharePlayer = document.getElementById('screen-share-player');
  const closeScreenBtn = document.getElementById('close-screen-btn');
  const shareScreenBtn = document.getElementById('share-screen-btn');
  const theatreScreenBtn = document.getElementById('theatre-screen-btn');
  const fullscreenScreenBtn = document.getElementById('fullscreen-screen-btn');

  function showLocalScreenShare() {
    if (!screenShareViewport) return;
    screenShareViewport.classList.remove('hidden');
    screenShareLabel.textContent = "You are sharing your screen";
    screenSharePlayer.innerHTML = "";
    if (rtc.localVideoTrack) {
      rtc.localVideoTrack.play('screen-share-player');
    }
  }

  function hideLocalScreenShare() {
    if (rtc.localVideoTrack) {
      rtc.localVideoTrack.stop();
    }
    if (chatShell) {
      chatShell.classList.remove('theatre-mode');
    }
    if (theatreScreenBtn) {
      theatreScreenBtn.innerHTML = `<i class="fa-solid fa-circle-half-stroke"></i>`;
      theatreScreenBtn.title = "Theatre Mode";
    }
    if (screenShareViewport) {
      screenShareViewport.classList.add('hidden');
      screenSharePlayer.innerHTML = "";
    }
  }

  function showRemoteScreenShare(user) {
    if (!screenShareViewport) return;
    screenShareViewport.classList.remove('hidden');
    const name = voiceUidToUsername.get(user.uid) || 'Someone';
    screenShareLabel.textContent = `${name} is sharing screen`;
    screenSharePlayer.innerHTML = "";
    if (user.videoTrack) {
      user.videoTrack.play('screen-share-player');
    }
  }

  function hideRemoteScreenShare(user) {
    if (user && user.videoTrack) {
      user.videoTrack.stop();
    }
    if (chatShell) {
      chatShell.classList.remove('theatre-mode');
    }
    if (theatreScreenBtn) {
      theatreScreenBtn.innerHTML = `<i class="fa-solid fa-circle-half-stroke"></i>`;
      theatreScreenBtn.title = "Theatre Mode";
    }
    if (screenShareViewport) {
      screenShareViewport.classList.add('hidden');
      screenSharePlayer.innerHTML = "";
    }
  }

  // Check if we are the only one in the channel
  function checkAloneStatus() {
    if (!rtc.joined || !rtc.client) return;

    // Get count of remote users
    const remoteCount = rtc.client.remoteUsers.length;
    console.log(`[Agora] Remote users count: ${remoteCount}`);

    if (remoteCount === 0) {
      // If we are alone and no timer is active, start a 2-minute kick timer
      if (!rtc.aloneTimer) {
        console.log("[Agora] User is alone. Starting 2-minute auto-kick timer...");
        
        messagesContainer.appendChild(createSystemMessageElement({
          text: "You are alone in the voice lounge. You will be automatically disconnected in 2 minutes if no one joins."
        }));
        messagesContainer.scrollTop = messagesContainer.scrollHeight;

        rtc.aloneTimer = setTimeout(() => {
          console.log("[Agora] Auto-kick timer triggered.");
          leaveVoiceChannel();
          messagesContainer.appendChild(createSystemMessageElement({
            text: "Disconnected from the voice lounge automatically to conserve resources (inactive for 2 minutes)."
          }));
          messagesContainer.scrollTop = messagesContainer.scrollHeight;
        }, 2 * 60 * 1000); // 2 minutes
      }
    } else {
      // Someone is in the channel, clear any active kick timer
      if (rtc.aloneTimer) {
        console.log("[Agora] Another user joined. Clearing auto-kick timer.");
        clearTimeout(rtc.aloneTimer);
        rtc.aloneTimer = null;
        
        messagesContainer.appendChild(createSystemMessageElement({
          text: "Another user has joined the voice lounge. Auto-kick cancelled."
        }));
        messagesContainer.scrollTop = messagesContainer.scrollHeight;
      }
    }
  }

  async function joinVoiceChannel() {
    if (!window.AgoraRTC) {
      alert("Agora SDK failed to load. Please check your internet connection.");
      return;
    }

    try {
      // 1. Create client
      rtc.client = AgoraRTC.createClient({ mode: "rtc", codec: "vp8" });

      // 2. Setup subscription listeners
      rtc.client.on("user-published", async (user, mediaType) => {
        await rtc.client.subscribe(user, mediaType);
        if (mediaType === "audio") {
          user.audioTrack.play();
        }
        if (mediaType === "video") {
          activeStreamers.set(user.uid, user);
          if (currentViewingUid === user.uid) {
            showRemoteScreenShare(user);
          }
          renderVoiceRoster();
        }
        // Check alone status whenever remote user count changes
        checkAloneStatus();
      });

      rtc.client.on("user-unpublished", (user, mediaType) => {
        if (mediaType === "video") {
          activeStreamers.delete(user.uid);
          if (currentViewingUid === user.uid) {
            hideRemoteScreenShare(user);
            currentViewingUid = null;
          }
          renderVoiceRoster();
        }
        checkAloneStatus();
      });

      rtc.client.on("user-left", (user) => {
        activeStreamers.delete(user.uid);
        if (currentViewingUid === user.uid) {
          hideRemoteScreenShare(user);
          currentViewingUid = null;
        }
        renderVoiceRoster();
        checkAloneStatus();
      });

      // Fetch dynamic token (and its matching App ID / channel / uid) from the server
      const tokenRes = await fetch('/api/voice-token');
      const tokenData = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok || !tokenData.success || !tokenData.token) {
        throw new Error(tokenData.error || `Failed to retrieve voice access token (HTTP ${tokenRes.status}).`);
      }
      const token = tokenData.token;

      // The server is the single source of truth for these
      const appId = tokenData.appId || AGORA_APP_ID;
      const channel = tokenData.channel || VOICE_CHANNEL;
      const uid = (tokenData.uid !== undefined && tokenData.uid !== null) ? tokenData.uid : 0;

      // 3. Join channel with the server-provided credentials
      const joinedUid = await rtc.client.join(appId, channel, token, uid);

      // 4. Create local audio track from microphone (high-quality voice preset)
      rtc.localAudioTrack = await AgoraRTC.createMicrophoneAudioTrack({
        encoderConfig: "high_quality", // 48 kHz mono, ~128 Kbps Opus
        AEC: true, // acoustic echo cancellation
        ANS: true, // automatic noise suppression
        AGC: true  // automatic gain control
      });

      // 5. Publish local audio
      await rtc.client.publish([rtc.localAudioTrack]);

      rtc.joined = true;

      // Show/Hide UI elements
      joinVoiceBtn.classList.add('hidden');
      voiceControls.classList.remove('hidden');
      voiceStatusText.classList.remove('hidden');

      // Announce ourselves in the voice roster
      voiceMembers.add(currentUsername);
      renderVoiceRoster();
      updateActiveUsersList();
      announceVoicePresence(true, joinedUid);

      // Start initial alone check
      checkAloneStatus();

      console.log("[Agora] Joined voice lounge successfully!");
    } catch (err) {
      console.error("[Agora] Join voice lounge failed:", err);
      alert("Failed to join voice lounge: " + err.message);
    }
  }

  async function leaveVoiceChannel() {
    if (rtc.aloneTimer) {
      clearTimeout(rtc.aloneTimer);
      rtc.aloneTimer = null;
    }

    if (rtc.localVideoTrack) {
      rtc.localVideoTrack.close();
      rtc.localVideoTrack = null;
    }
    if (rtc.localScreenAudioTrack) {
      rtc.localScreenAudioTrack.close();
      rtc.localScreenAudioTrack = null;
    }
    rtc.sharingScreen = false;
    if (shareScreenBtn) {
      shareScreenBtn.classList.remove('share-active');
      shareScreenBtn.innerHTML = `<i class="fa-solid fa-desktop"></i>`;
    }
    hideLocalScreenShare();

    if (rtc.localAudioTrack) {
      rtc.localAudioTrack.close();
      rtc.localAudioTrack = null;
    }

    if (rtc.client) {
      await rtc.client.leave();
      rtc.client = null;
    }

    rtc.joined = false;
    rtc.muted = false;
    currentViewingUid = null;
    voiceUidToUsername.clear();
    voiceUsernameToUid.clear();
    activeStreamers.clear();

    // Reset UI elements
    joinVoiceBtn.classList.remove('hidden');
    voiceControls.classList.add('hidden');
    voiceStatusText.classList.add('hidden');
    muteVoiceBtn.classList.remove('muted-active');
    muteVoiceBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;

    // Remove ourselves from the voice roster
    voiceMembers.delete(currentUsername);
    renderVoiceRoster();
    updateActiveUsersList();
    announceVoicePresence(false);

    console.log("[Agora] Left voice lounge.");
  }

  async function toggleMute() {
    if (!rtc.localAudioTrack) return;

    try {
      if (rtc.muted) {
        await rtc.localAudioTrack.setEnabled(true);
        rtc.muted = false;
        muteVoiceBtn.classList.remove('muted-active');
        muteVoiceBtn.innerHTML = `<i class="fa-solid fa-microphone"></i>`;
      } else {
        await rtc.localAudioTrack.setEnabled(false);
        rtc.muted = true;
        muteVoiceBtn.classList.add('muted-active');
        muteVoiceBtn.innerHTML = `<i class="fa-solid fa-microphone-slash"></i>`;
      }
    } catch (err) {
      console.error("[Agora] Toggle mute failed:", err);
    }
  }

  async function toggleScreenShare() {
    if (!rtc.joined || !rtc.client) return;

    try {
      if (rtc.sharingScreen) {
        if (rtc.localVideoTrack) {
          await rtc.client.unpublish([rtc.localVideoTrack]);
          rtc.localVideoTrack.close();
          rtc.localVideoTrack = null;
        }
        if (rtc.localScreenAudioTrack) {
          await rtc.client.unpublish([rtc.localScreenAudioTrack]);
          rtc.localScreenAudioTrack.close();
          rtc.localScreenAudioTrack = null;
        }
        rtc.sharingScreen = false;
        shareScreenBtn.classList.remove('share-active');
        shareScreenBtn.innerHTML = `<i class="fa-solid fa-desktop"></i>`;
        hideLocalScreenShare();
      } else {
        const screenTrack = await AgoraRTC.createScreenVideoTrack({
          encoderConfig: "1080p_1", // 1080p 15fps, detail optimized
          optimizationMode: "detail"
        }, "auto");

        // Agora can return [videoTrack, audioTrack] or just a single videoTrack
        rtc.localVideoTrack = Array.isArray(screenTrack) ? screenTrack[0] : screenTrack;
        rtc.localScreenAudioTrack = Array.isArray(screenTrack) ? screenTrack[1] : null;

        rtc.localVideoTrack.on("track-ended", () => {
          if (rtc.sharingScreen) {
            toggleScreenShare();
          }
        });

        const tracksToPublish = [rtc.localVideoTrack];
        if (rtc.localScreenAudioTrack) {
          tracksToPublish.push(rtc.localScreenAudioTrack);
        }

        await rtc.client.publish(tracksToPublish);
        rtc.sharingScreen = true;
        shareScreenBtn.classList.add('share-active');
        shareScreenBtn.innerHTML = `<i class="fa-solid fa-desktop-slash"></i>`;
        showLocalScreenShare();
      }
    } catch (err) {
      console.error("[Agora] Screen sharing failed:", err);
      alert("Failed to share screen: " + err.message);
    }
  }

  joinVoiceBtn.addEventListener('click', joinVoiceChannel);
  leaveVoiceBtn.addEventListener('click', leaveVoiceChannel);
  muteVoiceBtn.addEventListener('click', toggleMute);
  if (shareScreenBtn) shareScreenBtn.addEventListener('click', toggleScreenShare);
  if (closeScreenBtn) {
    closeScreenBtn.addEventListener('click', () => {
      if (rtc.sharingScreen) {
        toggleScreenShare();
      } else {
        if (currentViewingUid) {
          const remoteUser = activeStreamers.get(currentViewingUid);
          hideRemoteScreenShare(remoteUser);
          currentViewingUid = null;
          renderVoiceRoster();
        } else {
          if (screenShareViewport) screenShareViewport.classList.add('hidden');
        }
      }
    });
  }

  if (theatreScreenBtn && chatShell) {
    theatreScreenBtn.addEventListener('click', () => {
      const isTheatre = chatShell.classList.toggle('theatre-mode');
      theatreScreenBtn.innerHTML = isTheatre 
        ? `<i class="fa-solid fa-table-columns"></i>`
        : `<i class="fa-solid fa-circle-half-stroke"></i>`;
      theatreScreenBtn.title = isTheatre ? "Show Chat" : "Theatre Mode";
    });
  }

  if (fullscreenScreenBtn && screenSharePlayer) {
    fullscreenScreenBtn.addEventListener('click', () => {
      if (!document.fullscreenElement) {
        screenSharePlayer.requestFullscreen().catch(err => {
          console.error("[Agora] Fullscreen failed:", err);
        });
      } else {
        document.exitFullscreen();
      }
    });

    document.addEventListener('fullscreenchange', () => {
      if (document.fullscreenElement === screenSharePlayer) {
        fullscreenScreenBtn.innerHTML = `<i class="fa-solid fa-compress"></i>`;
        fullscreenScreenBtn.title = "Exit Fullscreen";
      } else {
        fullscreenScreenBtn.innerHTML = `<i class="fa-solid fa-expand"></i>`;
        fullscreenScreenBtn.title = "Fullscreen";
      }
    });
  }

  // Automatically clean up on page close/refresh
  window.addEventListener('beforeunload', () => {
    // Disconnect Pusher instantly to prevent stale user counts
    if (pusherInstance) {
      try {
        pusherInstance.unsubscribe('presence-chat');
        pusherInstance.disconnect();
      } catch (e) { /* ignore */ }
    }

    if (rtc.joined) {
      if (rtc.localAudioTrack) {
        rtc.localAudioTrack.close();
      }
      if (rtc.localVideoTrack) {
        rtc.localVideoTrack.close();
      }
      try {
        const blob = new Blob(
          [JSON.stringify({ username: currentUsername, inVoice: false })],
          { type: 'application/json' }
        );
        navigator.sendBeacon('/api/voice-presence', blob);
      } catch (e) { /* ignore */ }
    }
  });

  // --- Giphy GIF Search & Picker Integration ---
  const GIPHY_API_KEY = "dc6zaTOxFJmzC";
  let gifSearchTimeout = null;

  const gifToggleBtn = document.getElementById('gif-toggle-btn');
  const gifPickerPanel = document.getElementById('gif-picker-panel');
  const gifSearchInput = document.getElementById('gif-search-input');
  const gifResultsContainer = document.getElementById('gif-results-container');

  async function fetchGifs(query = '') {
    if (!gifResultsContainer) return;
    
    gifResultsContainer.innerHTML = '<div class="gif-loading">Loading...</div>';

    try {
      let url;
      if (query) {
        url = `https://api.giphy.com/v1/gifs/search?api_key=${GIPHY_API_KEY}&q=${encodeURIComponent(query)}&limit=20`;
      } else {
        url = `https://api.giphy.com/v1/gifs/trending?api_key=${GIPHY_API_KEY}&limit=20`;
      }

      const response = await fetch(url);
      const data = await response.json();
      
      gifResultsContainer.innerHTML = '';
      if (data.data && data.data.length > 0) {
        data.data.forEach(gif => {
          const imgUrl = gif.images.fixed_height.url;
          const shareUrl = gif.url;

          const img = document.createElement('img');
          img.src = gif.images.fixed_height_downsampled.url || imgUrl;
          img.alt = gif.title || 'GIF';
          img.title = 'Click to send';
          img.loading = 'lazy';
          img.addEventListener('click', () => {
            sendChatMessage(shareUrl);
            if (gifPickerPanel) gifPickerPanel.classList.add('hidden');
          });
          gifResultsContainer.appendChild(img);
        });
      } else {
        gifResultsContainer.innerHTML = '<div class="gif-loading">No results found.</div>';
      }
    } catch (err) {
      console.error('Error fetching GIFs:', err);
      gifResultsContainer.innerHTML = '<div class="gif-loading">Failed to load GIFs.</div>';
    }
  }

  if (gifToggleBtn && gifPickerPanel) {
    gifToggleBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const isHidden = gifPickerPanel.classList.toggle('hidden');
      if (!isHidden) {
        fetchGifs();
        if (gifSearchInput) {
          setTimeout(() => gifSearchInput.focus(), 50);
        }
      }
    });

    // Close panel when clicking outside
    document.addEventListener('click', (e) => {
      if (!gifPickerPanel.classList.contains('hidden')) {
        if (!gifPickerPanel.contains(e.target) && e.target !== gifToggleBtn && !gifToggleBtn.contains(e.target)) {
          gifPickerPanel.classList.add('hidden');
        }
      }
    });
  }

  if (gifSearchInput) {
    gifSearchInput.addEventListener('input', () => {
      clearTimeout(gifSearchTimeout);
      gifSearchTimeout = setTimeout(() => {
        fetchGifs(gifSearchInput.value.trim());
      }, 500); // debounce searches by 500ms
    });
  }
});
