/**
 * E-Ticket Auto Booker - Shared Utilities
 * Available globally in content scripts.
 */

const ETB = window.ETB || {};
window.ETB = ETB;

// ─── Logging (persisted to chrome.storage.local) ─────────────────────────────
const _logBuffer = [];
let _logFlushTimer = null;
const MAX_LOGS = 500;

function _flushLogs() {
  if (_logBuffer.length === 0) return;
  const batch = _logBuffer.splice(0);
  chrome.storage.local.get({ etb_logs: [] }, (res) => {
    let logs = res.etb_logs || [];
    logs.push(...batch);
    if (logs.length > MAX_LOGS) logs = logs.slice(-MAX_LOGS);
    chrome.storage.local.set({ etb_logs: logs });
  });
}

function _addLog(level, message, args) {
  const ts = new Date().toISOString();
  const entry = { ts, level, msg: `${message}${args.length ? ' ' + args.map(a => (typeof a === 'object' ? JSON.stringify(a) : String(a))).join(' ') : ''}` };
  _logBuffer.push(entry);
  clearTimeout(_logFlushTimer);
  _logFlushTimer = setTimeout(_flushLogs, 1000);
}

ETB.log = function log(message, ...args) {
  console.log(`[ETB] ${message}`, ...args);
  _addLog('info', message, args);
};

ETB.warn = function warn(message, ...args) {
  console.warn(`[ETB] ${message}`, ...args);
  _addLog('warn', message, args);
};

ETB.error = function error(message, ...args) {
  console.error(`[ETB] ${message}`, ...args);
  _addLog('error', message, args);
};

// ─── DOM Utilities ───────────────────────────────────────────────────────────

/**
 * Wait for a single element to appear in the DOM.
 * @param {string} selector - CSS selector
 * @param {number} timeout - Max wait in ms (default 10000)
 * @returns {Promise<Element>}
 */
ETB.waitForElement = function waitForElement(selector, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const el = document.querySelector(selector);
    if (el) return resolve(el);

    const observer = new MutationObserver(() => {
      const el = document.querySelector(selector);
      if (el) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(el);
      }
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElement: "${selector}" not found within ${timeout}ms`));
    }, timeout);

    observer.observe(document.body, { childList: true, subtree: true });
  });
};

/**
 * Wait for multiple elements matching a selector.
 * @param {string} selector - CSS selector
 * @param {number} minCount - Minimum number of elements to wait for
 * @param {number} timeout - Max wait in ms
 * @returns {Promise<NodeList>}
 */
ETB.waitForElements = function waitForElements(selector, minCount = 1, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const els = document.querySelectorAll(selector);
    if (els.length >= minCount) return resolve(els);

    const observer = new MutationObserver(() => {
      const els = document.querySelectorAll(selector);
      if (els.length >= minCount) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(els);
      }
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      const els = document.querySelectorAll(selector);
      if (els.length > 0) resolve(els);
      else reject(new Error(`waitForElements: "${selector}" — found 0, needed ${minCount}`));
    }, timeout);

    observer.observe(document.body, { childList: true, subtree: true });
  });
};

/**
 * Wait for an element matching text content.
 * @param {string} selector - CSS selector for candidates
 * @param {string|RegExp} textMatch - Text to match
 * @param {number} timeout
 * @returns {Promise<Element>}
 */
ETB.waitForElementByText = function waitForElementByText(selector, textMatch, timeout = 10000) {
  return new Promise((resolve, reject) => {
    const check = () => {
      const elements = document.querySelectorAll(selector);
      for (const el of elements) {
        const text = el.textContent.trim();
        if (typeof textMatch === 'string' && text.includes(textMatch)) return el;
        if (textMatch instanceof RegExp && textMatch.test(text)) return el;
      }
      return null;
    };

    const found = check();
    if (found) return resolve(found);

    const observer = new MutationObserver(() => {
      const found = check();
      if (found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
    });

    const timer = setTimeout(() => {
      observer.disconnect();
      reject(new Error(`waitForElementByText: "${selector}" with text "${textMatch}" not found`));
    }, timeout);

    observer.observe(document.body, { childList: true, subtree: true });
  });
};

// ─── Event Simulation ────────────────────────────────────────────────────────

/**
 * Simulate a realistic mouse click on an element.
 */
ETB.simulateClick = function simulateClick(element) {
  if (!element) {
    ETB.warn('simulateClick: element is null');
    return;
  }
  element.scrollIntoView({ behavior: 'smooth', block: 'center' });

  const rect = element.getBoundingClientRect();
  const x = rect.left + rect.width / 2;
  const y = rect.top + rect.height / 2;

  const eventOpts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };

  element.dispatchEvent(new MouseEvent('mousedown', eventOpts));
  element.dispatchEvent(new MouseEvent('mouseup', eventOpts));
  element.dispatchEvent(new MouseEvent('click', eventOpts));
};

/**
 * Simulate typing into a standard input.
 */
ETB.simulateInput = function simulateInput(element, value) {
  if (!element) {
    ETB.warn('simulateInput: element is null');
    return;
  }
  element.focus();
  element.value = value;
  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));
  element.dispatchEvent(new Event('blur', { bubbles: true }));
};

/**
 * Set value on a React-controlled input by using the native setter.
 * This bypasses React's synthetic event system.
 */
ETB.reactInputHack = function reactInputHack(element, value) {
  if (!element) {
    ETB.warn('reactInputHack: element is null');
    return;
  }
  // Use the native HTMLInputElement setter to bypass React
  const nativeSetter = Object.getOwnPropertyDescriptor(
    window.HTMLInputElement.prototype, 'value'
  )?.set || Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set;

  if (nativeSetter) {
    nativeSetter.call(element, value);
  } else {
    element.value = value;
  }

  element.dispatchEvent(new Event('input', { bubbles: true }));
  element.dispatchEvent(new Event('change', { bubbles: true }));

  // Also try React's internal fiber approach
  const tracker = element._valueTracker;
  if (tracker) {
    tracker.setValue('');
  }
  element.dispatchEvent(new Event('input', { bubbles: true }));
};

/**
 * Simulate selecting a value from a dropdown/select element.
 */
ETB.simulateSelect = function simulateSelect(selectElement, value) {
  if (!selectElement) {
    ETB.warn('simulateSelect: element is null');
    return;
  }
  selectElement.value = value;
  selectElement.dispatchEvent(new Event('change', { bubbles: true }));
};

// ─── Utility Functions ───────────────────────────────────────────────────────

/**
 * Promise-based sleep/delay.
 */
ETB.sleep = function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
};

/**
 * Safely get text content of an element.
 */
ETB.getTextContent = function getTextContent(selector) {
  const el = document.querySelector(selector);
  return el ? el.textContent.trim() : '';
};

/**
 * Check if an element is visible in the viewport.
 */
ETB.isVisible = function isVisible(element) {
  if (!element) return false;
  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = element.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
};

/**
 * Find an element containing specific text.
 */
ETB.findByText = function findByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  for (const el of elements) {
    if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
      return el;
    }
  }
  return null;
};

/**
 * Find all elements matching text.
 */
ETB.findAllByText = function findAllByText(selector, text) {
  const elements = document.querySelectorAll(selector);
  return Array.from(elements).filter(el =>
    el.textContent.trim().toLowerCase().includes(text.toLowerCase())
  );
};

// ─── Messaging ───────────────────────────────────────────────────────────────

/**
 * Send a message to the background service worker.
 */
ETB.sendMessage = function sendMessage(type, data = {}) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type, data }, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
      } else {
        resolve(response);
      }
    });
  });
};

/**
 * Listen for messages from the background service worker.
 */
ETB.onMessage = function onMessage(callback) {
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    callback(message, sender, sendResponse);
    return true;
  });
};

// ─── Storage Shortcuts ───────────────────────────────────────────────────────

ETB.getProfile = async function getProfile() {
  const response = await ETB.sendMessage('GET_PROFILE');
  return response?.data || null;
};

ETB.getPreferences = async function getPreferences() {
  const response = await ETB.sendMessage('GET_PREFERENCES');
  return response?.data || null;
};

ETB.updateBookingStatus = function updateBookingStatus(step, description, details) {
  const data = { step, description, timestamp: Date.now() };
  if (details) data.details = details;
  return ETB.sendMessage('BOOKING_STATUS', data);
};

ETB.notifySeatsAvailable = function notifySeatsAvailable(message) {
  return ETB.sendMessage('SEATS_AVAILABLE', { message });
};

// ─── Retry Helper ────────────────────────────────────────────────────────────

/**
 * Retry an async function with exponential backoff.
 * @param {Function} fn - async function to retry
 * @param {number} maxRetries
 * @param {number} baseDelay - initial delay in ms
 */
ETB.retry = async function retry(fn, maxRetries = 3, baseDelay = 1000) {
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await fn();
    } catch (err) {
      if (attempt === maxRetries) throw err;
      const delay = baseDelay * Math.pow(2, attempt);
      ETB.warn(`Retry ${attempt + 1}/${maxRetries} after ${delay}ms:`, err.message);
      await ETB.sleep(delay);
    }
  }
};

ETB.log('Utils loaded');
