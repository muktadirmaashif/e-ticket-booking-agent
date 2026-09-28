/**
 * E-Dalal - Rail Ticket Booking Agent - Background Service Worker
 * Handles messaging, seat monitoring, notifications, and profile storage.
 */

// ─── Constants ───────────────────────────────────────────────────────────────
const ALARM_NAME = 'seat-monitor';
const MONITOR_INTERVAL_MINUTES = 0.5; // 30 seconds

// ─── State ───────────────────────────────────────────────────────────────────
let monitoringActive = false;
let monitoringConfig = null;

// ─── Alarm Listener (Seat Monitoring) ────────────────────────────────────────
chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== ALARM_NAME) return;

  console.log('[ETB] Monitor alarm fired');

  const { monitorConfig } = await chrome.storage.local.get('monitorConfig');
  if (!monitorConfig || !monitorConfig.active) {
    chrome.alarms.clear(ALARM_NAME);
    return;
  }

  // Find the tab running the target site
  const tabs = await chrome.tabs.query({
    url: [
      'https://train.shohoz.com/*',
      'https://www.shohoz.com/*',
      'https://eticket.railway.gov.bd/*'
    ]
  });

  if (tabs.length > 0) {
    // Send check message to the content script
    for (const tab of tabs) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: 'CHECK_AVAILABILITY',
          config: monitorConfig
        });
      } catch (e) {
        console.log('[ETB] Could not reach tab:', tab.id, e.message);
      }
    }
  } else {
    // No tabs open — open one on the user's chosen booking site
    const url = monitorConfig.site === 'railway'
      ? 'https://eticket.railway.gov.bd'
      : 'https://train.shohoz.com';
    chrome.tabs.create({ url, active: false });
  }

  // Log the check
  await appendMonitorLog(`Checked availability at ${new Date().toLocaleTimeString()}`);
});

// ─── Message Handler ─────────────────────────────────────────────────────────
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender).then(sendResponse).catch((err) => {
    console.error('[ETB] Message handler error:', err);
    sendResponse({ success: false, error: err.message });
  });
  return true; // keep the channel open for async response
});

async function handleMessage(message, sender) {
  const { type, data } = message;

  switch (type) {
    // ── Profile Management ──
    case 'SAVE_PROFILE':
      await chrome.storage.sync.set({ passengerProfile: data });
      return { success: true };

    case 'GET_PROFILE':
      const { passengerProfile } = await chrome.storage.sync.get('passengerProfile');
      return { success: true, data: passengerProfile || null };

    case 'SAVE_PREFERENCES':
      await chrome.storage.sync.set({ bookingPreferences: data });
      return { success: true };

    case 'GET_PREFERENCES':
      const { bookingPreferences } = await chrome.storage.sync.get('bookingPreferences');
      return { success: true, data: bookingPreferences || null };

    // ── Monitoring ──
    case 'START_MONITORING':
      await chrome.storage.local.set({
        monitorConfig: { ...data, active: true, startedAt: Date.now() }
      });
      await chrome.alarms.create(ALARM_NAME, {
        periodInMinutes: MONITOR_INTERVAL_MINUTES
      });
      await appendMonitorLog(`Monitoring started at ${new Date().toLocaleTimeString()}`);
      return { success: true };

    case 'STOP_MONITORING':
      await chrome.alarms.clear(ALARM_NAME);
      await chrome.storage.local.set({
        monitorConfig: { active: false }
      });
      await appendMonitorLog(`Monitoring stopped at ${new Date().toLocaleTimeString()}`);
      // Tell ALL content scripts to stop
      try {
        const tabs = await chrome.tabs.query({
          url: ['https://train.shohoz.com/*', 'https://www.shohoz.com/*', 'https://eticket.railway.gov.bd/*']
        });
        for (const tab of tabs) {
          chrome.tabs.sendMessage(tab.id, { type: 'ETB_STOP' }).catch(() => {});
        }
      } catch (e) { /* ignore */ }
      return { success: true };

    case 'GET_MONITOR_STATUS':
      const { monitorConfig: mc } = await chrome.storage.local.get('monitorConfig');
      const { monitorLogs } = await chrome.storage.local.get('monitorLogs');
      return {
        success: true,
        data: {
          active: mc?.active || false,
          config: mc || null,
          logs: monitorLogs || []
        }
      };

    case 'CLEAR_MONITOR_LOGS':
      await chrome.storage.local.set({ monitorLogs: [] });
      return { success: true };

    // ── Seat Availability Notification ──
    case 'SEATS_AVAILABLE':
      chrome.notifications.create('seats-available-' + Date.now(), {
        type: 'basic',
        iconUrl: 'icons/icon128.png',
        title: '🎉 Seats Available!',
        message: data.message || 'Train seats are now available! Click to book.',
        priority: 2
      });
      await appendMonitorLog(`✅ SEATS FOUND: ${data.message}`);
      return { success: true };

    // ── Booking Status ──
    case 'BOOKING_STATUS':
      await chrome.storage.local.set({ bookingStatus: data });
      return { success: true };

    case 'GET_BOOKING_STATUS':
      const { bookingStatus } = await chrome.storage.local.get('bookingStatus');
      return { success: true, data: bookingStatus || { step: 'idle', description: 'Not active' } };

    case 'GET_LOGS':
      const { etb_logs } = await chrome.storage.local.get({ etb_logs: [] });
      return { success: true, data: etb_logs || [] };

    case 'CLEAR_LOGS':
      await chrome.storage.local.set({ etb_logs: [] });
      return { success: true };

    default:
      return { success: false, error: `Unknown message type: ${type}` };
  }
}

// ─── Notification Click Handler ──────────────────────────────────────────────
chrome.notifications.onClicked.addListener(async (notificationId) => {
  if (notificationId.startsWith('seats-available')) {
    const { monitorConfig: mc } = await chrome.storage.local.get('monitorConfig');
    const url = mc?.site === 'railway'
      ? 'https://eticket.railway.gov.bd'
      : 'https://train.shohoz.com';

    const tabs = await chrome.tabs.query({ url: url + '*' });
    if (tabs.length > 0) {
      chrome.tabs.update(tabs[0].id, { active: true });
      chrome.windows.update(tabs[0].windowId, { focused: true });
    } else {
      chrome.tabs.create({ url });
    }
  }
});

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function appendMonitorLog(message) {
  const { monitorLogs = [] } = await chrome.storage.local.get('monitorLogs');
  monitorLogs.push({ time: Date.now(), message });
  // Keep last 100 logs
  if (monitorLogs.length > 100) monitorLogs.splice(0, monitorLogs.length - 100);
  await chrome.storage.local.set({ monitorLogs });
}

// ─── Install Handler ─────────────────────────────────────────────────────────
chrome.runtime.onInstalled.addListener(() => {
  console.log('[ETB] E-Dalal - Rail Ticket Booking Agent installed');
  chrome.storage.local.set({
    monitorConfig: { active: false },
    monitorLogs: [],
    bookingStatus: { step: 'idle', description: 'Not active' }
  });
});
