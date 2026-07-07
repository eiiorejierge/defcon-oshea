// Client-side messaging controller using Pusher
document.addEventListener('DOMContentLoaded', () => {
  // App state
  let currentUsername = '';
  let isAdminAuthenticated = false;
  let activeTab = 'live';
  let archiveMessages = []; // Cached messages for filtering & downloading
  
  let pusherInstance = null;
  let presenceChannel = null;

  // DOM Elements - Onboarding
  const onboardingScreen = document.getElementById('onboarding-screen');
  const onboardingForm = document.getElementById('onboarding-form');
  const usernameInput = document.getElementById('username-input');

  // DOM Elements - Chat Area
  const chatScreen = document.getElementById('chat-screen');
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

  // DOM Elements - Admin Modal
  const adminModal = document.getElementById('admin-modal');
  const closeModalBtn = document.getElementById('close-modal-btn');
  const adminForm = document.getElementById('admin-form');
  const adminCodeInput = document.getElementById('admin-code-input');
  const adminErrorMsg = document.getElementById('admin-error-msg');

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
      
      // Initialize Pusher connection
      initPusher();
      
      // UI transition
      onboardingScreen.classList.add('hidden');
      chatScreen.classList.remove('hidden');
      focusElement(messageInput);
    }
  });

  // --- Pusher Initialization & Channel Handlers ---
  async function initPusher() {
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
        messagesContainer.appendChild(createSystemMessageElement({
          text: `Connected to Aether Room as ${currentUsername}. Session is active.`
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
    } catch (error) {
      console.error('Error initializing Pusher config:', error);
      messagesContainer.appendChild(createSystemMessageElement({
        text: 'Failed to retrieve connection config. Please reload the page.'
      }));
    }
  }

  // Update user count element
  function updateUserCount(count) {
    activeUsersCount.textContent = `${count} active user${count === 1 ? '' : 's'}`;
  }

  // --- Real-time Messaging Submission ---
  messageForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const text = messageInput.value.trim();
    if (text) {
      fetch('/api/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          username: currentUsername,
          text: text
        })
      })
      .then(res => res.json())
      .then(data => {
        if (data.success) {
          messageInput.value = '';
          focusElement(messageInput);
        } else {
          console.error('API Error sending message:', data.error);
        }
      })
      .catch(err => console.error('Error sending message:', err));
    }
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

  // Helper to create and return a message element securely
  function createMessageElement(msg, isSelf, isArchive = false) {
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
    contentDiv.textContent = msg.text;

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
          adminModal.classList.add('hidden');
          adminTabs.classList.remove('hidden');
          adminToggleBtn.classList.add('active');
          
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

    let fileContent = `AETHER CHATROOM ARCHIVE LOG\r\n`;
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

  // Global Keybind: Esc closes modal
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !adminModal.classList.contains('hidden')) {
      adminModal.classList.add('hidden');
      focusElement(messageInput);
    }
  });
});
