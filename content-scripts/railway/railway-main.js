/**
 * E-Ticket Auto Booker - Bangladesh Railway Content Script
 * Runs on: https://train.shohoz.com/*
 * 
 * Automates the booking flow:
 *   1. Login (auto-fill credentials, user solves captcha)
 *   2. Search (navigate to search URL directly)
 *   3. Select Train (click BOOK NOW on available train via real selectors)
 *   4. Select Seat (pick available seats from coach layout)
 *   5. Fill Passenger Details (auto-fill name, NID, mobile)
 *   6. Payment Gate (HUMAN-IN-THE-LOOP confirmation)
 *
 * Depends on: utils.js (ETB namespace), human-in-the-loop.js
 */
(function () {
  'use strict';

  const ETB = window.ETB;

  // ─── Config ──────────────────────────────────────────────────────────
  const SITE_NAME = 'Bangladesh Railway';
  const TOTAL_STEPS = 5;
  let profile = null;
  let preferences = null;
  let isAutomating = false;
  const MAX_RETRIES = 3;
  let retryCount = parseInt(sessionStorage.getItem('etb_retryCount') || '0');

  function incrementRetry() {
    retryCount++;
    sessionStorage.setItem('etb_retryCount', retryCount);
    return retryCount;
  }

  function resetRetry() {
    retryCount = 0;
    sessionStorage.removeItem('etb_retryCount');
    // Also reset the train × class matrix position for a fresh run
    sessionStorage.removeItem('etb_currentClassIndex');
    sessionStorage.removeItem('etb_currentTrainIndex');
  }

  // ─── Real Site Selectors ──────────────────────────────────────────────
  const SEL = {
    // Train Results
    trainCard: 'app-single-trip',
    trainName: '.trip-name',
    seatClassCard: '.single-seat-class',
    seatClassName: '.seat-class-name',
    noSeatAvailable: '.no-seat-available-wrap',
    bookNowButton: 'button.book-now-btn',

    // Seat Selection
    seatLayoutContainer: 'app-seat-layout',
    coachSelect: 'select#select-bogie',
    availableSeat: 'button.btn-seat.seat-available:not(.seat-selected):not(.seat-disabled):not(.seat-in-progress):not(.seat-booked):not([disabled])',
    allSeats: 'button.btn-seat',
    sweetAlertPopup: '.swal2-popup',
    sweetAlertConfirm: '.swal2-confirm',
    
    // Login
    loginMobile: 'input[formcontrolname="mobile_number"], input[name="mobile_number"]',
    loginPassword: 'input[formcontrolname="password"], input[type="password"]',
    captchaInput: 'input[formcontrolname="captcha"]',
    
    // Passenger Details
    passengerName: 'input[formcontrolname="passenger_name"], input[name*="name" i]',
    passengerNid: 'input[name*="nid" i]',
    passengerMobile: 'input[name*="mobile" i]',
    
    // Payment
    paymentSection: 'app-payment-gateway'
  };

  // ─── Initialization ──────────────────────────────────────────────────
  let stopped = false;
  let pageObserver = null;

  async function init() {
    ETB.log(`${SITE_NAME} content script initializing...`);

    [profile, preferences] = await Promise.all([
      ETB.getProfile(),
      ETB.getPreferences()
    ]);

    ETB.showStatusBadge('ETB: Active', true);

    if (!preferences?.autoBook) {
      ETB.log('Auto-booking disabled in preferences');
      ETB.showStatusBadge('ETB: Manual Mode', false);
      return;
    }

    await ETB.sleep(1500);
    detectAndAutomate();
    observePageChanges();

    // Listen for messages from service worker / popup
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (msg.type === 'ETB_STOP') {
        stopAllAutomation();
        sendResponse({ stopped: true });
      }
      if (msg.type === 'CHECK_AVAILABILITY') {
        sendResponse({ received: true });
      }
    });
  }

  function stopAllAutomation() {
    stopped = true;
    isAutomating = false;
    if (pageObserver) {
      pageObserver.disconnect();
      pageObserver = null;
    }
    clearTimeout(debounceTimer);
    resetRetry();
    ETB.log('⛔ AUTOMATION STOPPED by user');
    ETB.showStatusBadge('ETB: Stopped', false);
    ETB.showNotification('🛑 Automation stopped.', 'info', 5000);
  }

  // ─── Utility ─────────────────────────────────────────────────────────
  async function waitFor(findFn, timeoutMs = 10000, description = 'element') {
    // Immediate check
    try {
      const immediate = findFn();
      if (immediate) return immediate;
    } catch (e) {
      throw e;
    }

    return new Promise((resolve, reject) => {
      let finished = false;
      const finish = (callback, value) => {
        if (finished) return;
        finished = true;
        observer.disconnect();
        clearInterval(fallback);
        clearTimeout(timeout);
        callback(value);
      };
      const check = () => {
        try {
          const result = findFn();
          if (result) finish(resolve, result);
        } catch (error) {
          finish(reject, error);
        }
      };
      const observer = new MutationObserver(() => {
        queueMicrotask(check);
      });
      observer.observe(document.documentElement, {
        subtree: true, childList: true, attributes: true, characterData: true
      });
      const fallback = setInterval(check, 200);
      const timeout = setTimeout(
        () => finish(reject, new Error(`Timeout waiting for ${description}`)),
        timeoutMs
      );
      check();
    });
  }

  function normalize(str) {
    return str ? str.trim().toLowerCase() : '';
  }

  // Fuzzy train-name comparison used to match preferred-train names (from the
  // popup, e.g. "CHATTALA EXPRESS") against site-rendered trip titles
  // (e.g. "CHATTALA EXP" / "Chattala Express"). Normalizes case, strips all
  // non-alphanumerics, and drops common suffix abbreviations.
  function normTrainName(str) {
    if (!str) return '';
    let s = String(str).toUpperCase().replace(/[^A-Z0-9]/g, ' ');
    s = s.replace(/\b(EXPRESS|EXP|INTERCITY|SHUTTLE|COMMUTER|MAIL|SLEEPER|PARABAT)\b/g, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  function trainNamesMatch(cardText, preferredName) {
    const a = normTrainName(cardText);
    const b = normTrainName(preferredName);
    if (!a || !b) return false;
    return a === b || a.includes(b) || b.includes(a);
  }

  // ─── Page Detection ──────────────────────────────────────────────────
  function detectCurrentPage() {
    if (document.querySelector(SEL.loginPassword)) return 'login';
    if (document.querySelector(SEL.seatLayoutContainer)) return 'seat-selection';
    if (document.querySelector(SEL.passengerName)) return 'passenger-details';
    if (document.querySelector(SEL.paymentSection)) return 'payment';
    if (document.querySelector(SEL.trainCard)) return 'train-results';
    
    if (window.location.pathname === '/' || window.location.pathname.includes('/search')) {
      return 'search';
    }
    
    return 'unknown';
  }

  async function detectAndAutomate() {
    if (stopped) return;
    if (isAutomating) return;
    isAutomating = true;

    try {
      const page = detectCurrentPage();
      ETB.log(`Detected page: ${page}`);

      // Don't re-run the same step
      if (page === lastDetectedPage && page !== 'unknown') {
        ETB.log(`Already handled page "${page}", skipping`);
        return;
      }
      lastDetectedPage = page;

      switch (page) {
        case 'login': await handleLogin(); break;
        case 'search': await handleSearch(); break;
        case 'train-results': await handleTrainSelection(); break;
        case 'seat-selection': await handleSeatSelection(); break;
        case 'passenger-details': await handlePassengerDetails(); break;
        case 'payment': await handlePayment(); break;
        default: ETB.log('Page not recognized, waiting for navigation...');
      }
    } catch (err) {
      ETB.error('Automation error:', err.message);
      ETB.showNotification(`Error: ${err.message}`, 'error', 6000);
      ETB.updateBookingStatus('error', err.message);
    } finally {
      isAutomating = false;
    }
  }

  let lastDetectedPage = '';
  let debounceTimer = null;

  function observePageChanges() {
    let lastUrl = location.href;
    pageObserver = new MutationObserver(() => {
      if (stopped) return;
      const url = location.href;
      if (url !== lastUrl) {
        lastUrl = url;
        isAutomating = false;
        lastDetectedPage = '';
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(detectAndAutomate, 1500);
      } else if (!isAutomating) {
        // Debounce — don't fire on every tiny DOM change
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(detectAndAutomate, 2000);
      }
    });
    pageObserver.observe(document, { subtree: true, childList: true });
  }

  // ─── Step 1: Login ───────────────────────────────────────────────────
  async function handleLogin() {
    if (!profile?.mobile || !profile?.password) {
      ETB.log('No login credentials saved — please log in manually');
      ETB.showNotification('Please log in manually. Automation will continue after login.', 'info', 5000);
      return;
    }

    ETB.showProgress(0, TOTAL_STEPS, 'Logging in...');
    ETB.showNotification('Auto-filling login credentials...', 'info');

    await ETB.sleep(500);

    const mobileInput = document.querySelector(SEL.loginMobile) || document.querySelector('input[type="text"]');
    if (mobileInput) {
      ETB.reactInputHack(mobileInput, profile.mobile);
      await ETB.sleep(300);
    }

    const passwordInput = document.querySelector(SEL.loginPassword);
    if (passwordInput) {
      ETB.reactInputHack(passwordInput, profile.password);
      await ETB.sleep(300);
    }

    const captchaInput = document.querySelector(SEL.captchaInput) || document.querySelector('input[placeholder*="captcha" i]');
    if (captchaInput) {
      ETB.showNotification('⚠️ Please solve the captcha, then we\'ll auto-submit!', 'warning', 10000);
      
      await new Promise((resolve) => {
        const check = setInterval(() => {
          if (captchaInput.value.length >= 3) {
            clearInterval(check);
            resolve();
          }
        }, 500);
        setTimeout(() => { clearInterval(check); resolve(); }, 60000);
      });
      await ETB.sleep(500);
    }

    const loginBtn = document.querySelector('button[type="submit"]') || Array.from(document.querySelectorAll('button')).find(b => normalize(b.textContent).includes('login'));
    if (loginBtn) {
      loginBtn.click();
      ETB.log('Clicked login button');
    }
  }

  // ─── Class / Train Fallback State ────────────────────────────────────
  // The booking matrix is tried train-outer, class-inner:
  //   try N = for each preferred train → for each priority class → attempt seats
  // One full sweep of that matrix counts as ONE retry attempt (max 3 sweeps).
  // Matrix indices are persisted in sessionStorage so they survive the page
  // reloads/navigations that happen while walking the train × class matrix.
  let currentClassIndex = parseInt(sessionStorage.getItem('etb_currentClassIndex') || '0') || 0;
  let currentTrainIndex = parseInt(sessionStorage.getItem('etb_currentTrainIndex') || '0') || 0;
  let hasTriedAllClasses = false;

  function persistMatrixIndices() {
    try {
      sessionStorage.setItem('etb_currentClassIndex', String(currentClassIndex));
      sessionStorage.setItem('etb_currentTrainIndex', String(currentTrainIndex));
    } catch (e) { /* ignore */ }
  }

  function getClassPriority() {
    return preferences?.classPriority || (preferences?.seatClass ? [preferences.seatClass] : []);
  }

  function getPreferredTrains() {
    return preferences?.preferredTrains || [];
  }

  function getCurrentClass() {
    const classes = getClassPriority();
    return classes[currentClassIndex] || classes[0] || 'SNIGDHA';
  }

  const CLASS_DISPLAY = {
    'SNIGDHA': 'Snigdha', 'AC_S': 'AC Seat', 'AC_B': 'AC Berth',
    'SHOVAN': 'Shovan', 'S_CHAIR': 'Shovan Chair', 'SHOVAN_CHAIR': 'Shovan Chair',
    'F_SEAT': 'First Seat', 'F_BERTH': 'First Berth', 'F_CHAIR': 'First Chair',
    'AC_CHAIR': 'AC Chair', 'SHULOV': 'Shulov'
  };

  // ─── Class-Specific Seating Layouts ──────────────────────────────────
  // groupSize: how many seats sit adjacently in a row block (before the aisle).
  //   First Seat / First Berth / AC Seat / AC Berth → groups of 3 (1-3, 4-6, ...)
  //   Snigdha / Shovan Chair → groups of 2 (window+aisle pairs)
  // centerRange: [first, last] seat numbers that count as "center" — used for
  //   scoring fallbacks and tie-breaking when geometry is unavailable.
  // Pairing rules (seat-number parity), per class family:
  // - SNIGDHA: pairs are EVEN-ODD starting at 4-5 → valid pair starts on an EVEN
  //   number: 4-5, 6-7, …, 24-25, 26-27. So 25-26 is NOT a pair (odd start).
  // - Shovan Chair: pairs start at 3-4, 5-6, … → valid pair starts on an ODD
  //   number: pairStart must be odd.
  // - First Seat / First Berth / AC Seat / AC Berth: blocks of 3 — 1-2-3, 4-5-6,
  //   i.e. block n = seats (3n+1, 3n+2, 3n+3); single & double cabins.
  // gridStart = first seat number of the first valid group; groups tile upward
  // from there with stride groupSize.
  const CLASS_LAYOUTS = {
    'SNIGDHA':       { groupSize: 2, gridStart: 4, centerRange: [24, 31] },
    'AC_S':          { groupSize: 3, gridStart: 1, centerRange: null },
    'AC_B':          { groupSize: 3, gridStart: 1, centerRange: null },
    'S_CHAIR':       { groupSize: 2, gridStart: 3, centerRange: [29, 36] },
    'SHOVAN_CHAIR':  { groupSize: 2, gridStart: 3, centerRange: [29, 36] },
    'SHOVAN':        { groupSize: 2, gridStart: 3, centerRange: null },
    'F_SEAT':        { groupSize: 3, gridStart: 1, centerRange: null },
    'F_BERTH':       { groupSize: 3, gridStart: 1, centerRange: null }
  };

  function getClassLayout(cls) {
    if (!cls) return null;
    let key = String(cls).toUpperCase().replace(/[\s_-]+/g, '_');
    if (CLASS_LAYOUTS[key]) return CLASS_LAYOUTS[key];
    // Aliases: site uses e.g. "SHOVAN CHAIR" / "CHAIR SHOVAN" / "FIRST SEAT" etc.
    if (key.includes('SNIGDHA')) return CLASS_LAYOUTS['SNIGDHA'];
    if (key.includes('CHAIR') && key.includes('SHOVAN')) return CLASS_LAYOUTS['S_CHAIR'];
    if (key === 'SHOVAN_NON_CHAIR' || key.includes('NON_CHAIR')) return CLASS_LAYOUTS['SHOVAN'];
    if ((key.includes('AC') && key.includes('SEAT')) || key === 'AC_SEAT') return CLASS_LAYOUTS['AC_S'];
    if ((key.includes('AC') && key.includes('BERTH')) || key === 'AC_BERTH') return CLASS_LAYOUTS['AC_B'];
    if (key.includes('FIRST') && key.includes('SEAT')) return CLASS_LAYOUTS['F_SEAT'];
    if (key.includes('FIRST') && key.includes('BERTH')) return CLASS_LAYOUTS['F_BERTH'];
    return null;
  }

  // Snap a seat number down to the start of its valid group for the class.
  // SNIGDHA gridStart=4,size=2 → 25 snaps to 24 (pair 24-25), 26 snaps to 26 (pair 26-27).
  // S_CHAIR gridStart=3,size=2 → 4 snaps to 3 (pair 3-4), 6 snaps to 5 (pair 5-6).
  // First/AC gridStart=1,size=3 → 5 snaps to 4 (block 4-5-6).
  function groupStartFor(num, layoutCfg) {
    const size = layoutCfg?.groupSize || 2;
    const start = layoutCfg?.gridStart || 1;
    const idx = Math.floor((num - start) / size);
    return start + idx * size;
  }

  // Extract the numeric part of a seat label, e.g. "SN-30" → 30, "DHA-4" → 4
  function getSeatNumber(btn) {
    const name = (btn.title || btn.textContent || '').trim();
    const m = name.match(/(\d+)\s*$/) || name.match(/(\d+)/);
    return m ? parseInt(m[1]) : null;
  }

  // Fallback center reference derived from total rendered seats:
  // centerSeat = (totalSeats + 1) / 2
  function numberCenterFromTotal(totalSeats) {
    return (totalSeats + 1) / 2;
  }

  // Distance of a seat number from its class's center zone.
  // Inside the configured center range → 0; otherwise distance to nearest edge.
  function numberCenterDistance(num, layout, totalSeats) {
    if (num == null) return Infinity;
    let lo, hi;
    if (layout?.centerRange) {
      [lo, hi] = layout.centerRange;
    } else {
      const c = numberCenterFromTotal(totalSeats || 0);
      lo = Math.floor(c); hi = Math.ceil(c);
    }
    if (num >= lo && num <= hi) return 0;
    return num < lo ? lo - num : num - hi;
  }

  // ─── Step 2: Search ──────────────────────────────────────────────────
  async function handleSearch() {
    if (!preferences?.from || !preferences?.to || !preferences?.date) {
      ETB.showNotification('Please set your journey preferences in the extension popup.', 'warning');
      return;
    }

    const targetClass = getCurrentClass();
    ETB.showProgress(1, TOTAL_STEPS, `Searching trains (${CLASS_DISPLAY[targetClass] || targetClass})...`);

    const dateObj = new Date(preferences.date);
    const months = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const formattedDate = `${String(dateObj.getDate()).padStart(2, '0')}-${months[dateObj.getMonth()]}-${dateObj.getFullYear()}`;

    const searchUrl = `https://train.shohoz.com/booking/train/search?fromcity=${encodeURIComponent(preferences.from)}&tocity=${encodeURIComponent(preferences.to)}&doj=${formattedDate}&class=${targetClass}`;

    // If already on the search URL, wait for results instead of re-navigating
    if (window.location.href.includes('/booking/train/search')) {
      ETB.log('Already on search page, waiting for train results...');
      try {
        await waitFor(() => document.querySelector(SEL.trainCard), 15000, 'train results to load');
        isAutomating = false;
        detectAndAutomate();
      } catch (e) {
        ETB.showNotification('No trains found. Refreshing search...', 'warning');
        window.location.href = searchUrl;
      }
      return;
    }

    ETB.log(`Navigating to search URL: ${searchUrl}`);
    window.location.href = searchUrl;
  }

  /**
   * Advance the train × class booking matrix (train-outer, class-inner).
   * Returns { done, newSweep } — when the last class of the last train is
   * passed we wrap back to (train 0, class 0); that wrap counts as one
   * completed sweep of the whole matrix (= one "try").
   */
  function advanceMatrix() {
    const classes = getClassPriority();
    const trains = getPreferredTrains();
    const trainCount = Math.max(trains.length, 1);

    if (currentClassIndex < classes.length - 1) {
      currentClassIndex++;
      persistMatrixIndices();
      return { done: false, newSweep: false };
    }
    if (currentTrainIndex < trainCount - 1) {
      currentTrainIndex++;
      currentClassIndex = 0;
      persistMatrixIndices();
      return { done: false, newSweep: false };
    }
    // Wrapped past the end — full matrix swept once
    currentClassIndex = 0;
    currentTrainIndex = 0;
    hasTriedAllClasses = false;
    persistMatrixIndices();
    return { done: false, newSweep: true };
  }

  async function tryNextClass() {
    const classes = getClassPriority();
    if (classes.length <= 1 || currentClassIndex >= classes.length - 1) {
      hasTriedAllClasses = true;
      return false;
    }

    currentClassIndex++;
    const nextClass = classes[currentClassIndex];
    ETB.log(`⬇️ Falling back to class ${currentClassIndex + 1}/${classes.length}: ${CLASS_DISPLAY[nextClass] || nextClass}`);
    ETB.showNotification(`⬇️ Trying next class: ${CLASS_DISPLAY[nextClass] || nextClass}...`, 'warning', 5000);

    const url = new URL(window.location.href);
    url.searchParams.set('class', nextClass);
    window.location.href = url.toString();
    return true;
  }

  /**
   * Navigate back to the train-results list (SPA route or reload fallback)
   * so the next train in the priority list can be attempted.
   */
  async function goToTrainResults() {
    lastDetectedPage = '';
    if (window.location.pathname.includes('/booking/train/search')) {
      window.location.reload();
    } else {
      window.location.href = 'https://train.shohoz.com/booking/train/search';
    }
  }

  /**
   * Evaluate a seat-class card on a train row WITHOUT clicking it.
   * Returns { targetClass, display, availableCount, bookable }.
   */
  function evaluateClassCard(classCard, targetClass, passengerCount) {
    const targetClassDisplay = CLASS_DISPLAY[targetClass] || targetClass;
    const cardText = classCard.innerText || '';
    let availableCount = 0;
    const onlineMatch = cardText.match(/Online\)[\s\n]*(\d+)/i);
    if (onlineMatch) {
      availableCount = parseInt(onlineMatch[1]);
    } else {
      const allNums = cardText.match(/\b(\d+)\b/g);
      if (allNums && allNums.length > 0) {
        availableCount = parseInt(allNums[allNums.length - 1]);
      }
    }

    if (availableCount < passengerCount) {
      ETB.log(`Class ${targetClass}: only ${availableCount} available, need ${passengerCount}, skipping`);
      return { targetClass, display: targetClassDisplay, availableCount, bookable: false, reason: 'insufficient' };
    }

    if (classCard.classList.contains('no-seat-available-wrap') || classCard.querySelector('.no-seat-available-wrap')) {
      ETB.log(`Class ${targetClass}: marked as no-seat-available, skipping`);
      return { targetClass, display: targetClassDisplay, availableCount, bookable: false, reason: 'no-seat-marker' };
    }

    const bookBtn = classCard.querySelector(SEL.bookNowButton);
    if (!bookBtn || !ETB.isVisible(bookBtn) || bookBtn.disabled) {
      ETB.log(`Class ${targetClass}: no active BOOK NOW button, skipping`);
      return { targetClass, display: targetClassDisplay, availableCount, bookable: false, reason: 'no-book-btn' };
    }

    return { targetClass, display: targetClassDisplay, availableCount, bookable: true, bookBtn };
  }

  // ─── Step 3: Train Selection ─────────────────────────────────────────
  async function handleTrainSelection() {
    ETB.showProgress(2, TOTAL_STEPS, 'Selecting train...');

    if (document.querySelector(SEL.seatLayoutContainer)) {
      return;
    }

    // Retry limit check — one "try" = one full sweep of the train × class matrix
    if (retryCount >= MAX_RETRIES) {
      ETB.showNotification(`⛔ Stopped after ${MAX_RETRIES} attempts. No bookable seats found.`, 'error', 15000);
      ETB.updateBookingStatus(2, `Stopped: ${MAX_RETRIES} retries exhausted`);
      return;
    }

    await ETB.sleep(1000);

    try {
      await waitFor(() => document.querySelectorAll(SEL.trainCard).length > 0 ? true : null, 10000, 'train cards');
    } catch (e) {
      ETB.showNotification('No trains found on this route.', 'warning');
      return;
    }

    const trainCards = Array.from(document.querySelectorAll(SEL.trainCard));
    if (trainCards.length === 0) return;

    const passengerCount = parseInt(preferences?.passengerCount) || 1;
    const preferredTrains = getPreferredTrains();
    const classPriority = getClassPriority();

    /** Find a train card by name match (fuzzy: case/punctuation/EXPRESS-suffix). */
    function findTrainCard(name) {
      return trainCards.find(card => {
        const title = card.querySelector(SEL.trainName);
        if (!title) return false;
        return trainNamesMatch(title.textContent, name);
      }) || null;
    }

    /** Find the seat-class card for a target class inside a train row. */
    function findClassCard(trainCard, targetClass) {
      const targetClassDisplay = CLASS_DISPLAY[targetClass] || targetClass;
      return Array.from(trainCard.querySelectorAll(SEL.seatClassCard)).find(card => {
        const nameEl = card.querySelector(SEL.seatClassName);
        if (!nameEl) return false;
        const cardText = nameEl.textContent.trim().toUpperCase().replace(/[\s_-]+/g, '');
        const matchId = targetClass.toUpperCase().replace(/[\s_-]+/g, '');
        const matchDisplay = targetClassDisplay.toUpperCase().replace(/[\s_-]+/g, '');
        return cardText.includes(matchId) || cardText.includes(matchDisplay) || matchId.includes(cardText);
      }) || null;
    }

    /** Expand a train row and click BOOK NOW for the chosen class card. */
    async function openSeatLayout(trainCard, bookBtn, targetClass) {
      const trainNameEl = trainCard.querySelector(SEL.trainName);
      if (trainNameEl) {
        trainNameEl.scrollIntoView({ behavior: 'auto', block: 'center' });
        trainNameEl.click();
        await ETB.sleep(800);
      }
      bookBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
      bookBtn.click();
      ETB.log(`Clicked BOOK NOW for ${targetClass} (native click)`);
      try {
        await waitFor(
          () => trainCard.querySelector(SEL.seatLayoutContainer) || document.querySelector(SEL.seatLayoutContainer),
          10000,
          'seat layout to open'
        );
        ETB.log('Seat layout appeared');
        return true;
      } catch (e) {
        ETB.log('Seat layout did not appear');
        return false;
      }
    }

    // ══ Case A: no preferred trains → first available train only ══
    if (preferredTrains.length === 0) {
      const selectedTrainCard = trainCards[0];
      const trainName = selectedTrainCard.querySelector(SEL.trainName)?.textContent.trim() || 'Unknown';
      ETB.log(`No preferred trains set, using first available: ${trainName}`);

      for (let i = 0; i < classPriority.length; i++) {
        const targetClass = classPriority[i];
        const classCard = findClassCard(selectedTrainCard, targetClass);
        if (!classCard) {
          ETB.log(`Class ${targetClass}: not found on this train, skipping`);
          continue;
        }
        const evalRes = evaluateClassCard(classCard, targetClass, passengerCount);
        if (!evalRes.bookable) continue;

        currentClassIndex = i;
        ETB.log(`✅ Class ${targetClass} (${evalRes.display}): ${evalRes.availableCount} available, need ${passengerCount} — booking`);
        ETB.showNotification(`Booking ${evalRes.display} (${evalRes.availableCount} available)...`, 'info');

        if (!(await openSeatLayout(selectedTrainCard, evalRes.bookBtn, targetClass))) continue;

        lastDetectedPage = 'seat-selection';
        await handleSeatSelection();
        return;
      }

      // No class on the first-available train qualifies → counts as a full sweep
      incrementRetry();
      ETB.log(`No bookable class found with ${passengerCount} seat(s) (attempt ${retryCount}/${MAX_RETRIES})`);
      if (retryCount < MAX_RETRIES) {
        ETB.showNotification(`⚠️ Not enough seats. Retrying (${retryCount}/${MAX_RETRIES})...`, 'warning', 5000);
        await ETB.sleep(3000);
        window.location.reload();
      } else {
        ETB.showNotification(`⛔ Stopped: no class has ${passengerCount} available seats after ${MAX_RETRIES} attempts.`, 'error', 15000);
        ETB.updateBookingStatus(2, `No ${passengerCount} seats after ${MAX_RETRIES} retries`);
      }
      return;
    }

    // ══ Case B: preferred trains set → walk the train × class matrix ══
    // Clamp persisted indices in case preferences changed since last run.
    if (currentTrainIndex >= preferredTrains.length) currentTrainIndex = 0;
    if (currentClassIndex >= classPriority.length) currentClassIndex = 0;

    /**
     * Advance to the next matrix cell and re-navigate to the results page.
     * IMPORTANT: we handle exactly ONE cell per page load. After a failed
     * cell we persist the advanced index and reload with ?class=<next>.
     * This prevents the old bug where the code looped back into the first
     * (non-preferred) train over and over.
     */
    async function advanceToNextCell(navigateToResults = true) {
      const { newSweep } = advanceMatrix();
      if (newSweep) {
        incrementRetry();
        if (retryCount >= MAX_RETRIES) {
          ETB.showNotification(`⛔ Stopped: no train/class has ${passengerCount} available seats after ${MAX_RETRIES} attempts.`, 'error', 15000);
          ETB.updateBookingStatus(2, `No ${passengerCount} seats after ${MAX_RETRIES} retries`);
          return false; // stop — do not navigate
        }
        ETB.showNotification(`⚠️ Full sweep done, retrying (${retryCount}/${MAX_RETRIES})...`, 'warning', 6000);
        await ETB.sleep(3000);
        window.location.reload();
        return false;
      }
      if (!navigateToResults) return true; // caller will navigate itself (e.g. tryNextClass)
      await ETB.sleep(800);
      goToSearchWithCurrentClass();
      return false; // navigated away
    }

    /** Rebuild the search-results URL keeping from/to/doj but switching class. */
    function goToSearchWithCurrentClass() {
      lastDetectedPage = '';
      try {
        const url = new URL(window.location.href);
        if (!url.pathname.includes('/booking/train/search')) {
          url.pathname = '/booking/train/search';
        }
        url.searchParams.set('class', getCurrentClass());
        window.location.href = url.toString();
      } catch (e) {
        window.location.reload();
      }
    }

    let guard = (preferredTrains.length + 1) * (classPriority.length + 1) + 4;

    while (guard-- > 0) {
      const preferred = preferredTrains[currentTrainIndex];
      const targetClass = classPriority[currentClassIndex];
      const trainLabel = preferred?.name || `#${currentTrainIndex + 1}`;
      ETB.log(`Matrix cell [train ${currentTrainIndex + 1}/${preferredTrains.length}: ${trainLabel}] [class ${currentClassIndex + 1}/${classPriority.length}: ${targetClass}] (try ${retryCount + 1}/${MAX_RETRIES})`);

      const trainCard = findTrainCard(preferred.name);
      if (!trainCard) {
        ETB.log(`❌ Preferred train "${preferred.name}" not found in search results — skipping to next cell`);
        // Missing trains are skipped within the same try; keep advancing
        // until we hit a listed train or complete a sweep.
        const classes = classPriority;
        const before = `${currentTrainIndex}:${currentClassIndex}`;
        let skipped = advanceMatrix();
        persistMatrixIndices();
        if (skipped.newSweep) {
          incrementRetry();
          if (retryCount >= MAX_RETRIES) {
            ETB.showNotification(`⛔ None of your preferred trains run on this route. Stopped after ${MAX_RETRIES} attempts.`, 'error', 15000);
            ETB.updateBookingStatus(2, 'Preferred trains not available on this route');
            return;
          }
          ETB.showNotification(`⚠️ None of your preferred trains run on this route. Attempt ${retryCount}/${MAX_RETRIES}.`, 'warning', 10000);
          await ETB.sleep(3000);
          window.location.reload();
          return;
        }
        if (`${currentTrainIndex}:${currentClassIndex}` === before) continue;
        // Advanced to a new train — reload results so its cards render for
        // the new target class, then the next page-load picks up there.
        goToSearchWithCurrentClass();
        return;
      }

      const classCard = findClassCard(trainCard, targetClass);
      if (!classCard) {
        ETB.log(`Class ${targetClass}: not found on ${trainLabel}, going to next matrix cell`);
        await advanceToNextCell();
        return;
      }

      const evalRes = evaluateClassCard(classCard, targetClass, passengerCount);
      if (!evalRes.bookable) {
        ETB.log(`${trainLabel} / ${targetClass}: not bookable (${evalRes.reason}), going to next matrix cell`);
        await advanceToNextCell();
        return;
      }

      // ✅ This train+class looks bookable — attempt it
      ETB.log(`✅ ${trainLabel} / ${targetClass} (${evalRes.display}): ${evalRes.availableCount} available, need ${passengerCount} — booking`);
      ETB.showNotification(`Booking ${trainLabel} — ${evalRes.display} (${evalRes.availableCount} available)...`, 'info');

      if (!(await openSeatLayout(trainCard, evalRes.bookBtn, targetClass))) {
        ETB.log(`Seat layout didn't open for ${trainLabel}/${targetClass}, advancing matrix`);
        await advanceToNextCell();
        return;
      }

      lastDetectedPage = 'seat-selection';
      await handleSeatSelection();
      return;
    }
  }

  // ─── Step 4: Smart Seat Selection ───────────────────────────────────
  async function handleSeatSelection() {
    ETB.showProgress(3, TOTAL_STEPS, 'Selecting seats...');

    if (!preferences?.autoSeat) {
      ETB.showNotification('Auto-seat selection disabled.', 'info');
      return;
    }

    let coachSelect;
    try {
      coachSelect = await waitFor(() => document.querySelector(SEL.coachSelect), 8000, 'coach select dropdown');
    } catch (e) {
      ETB.log('No coach select dropdown found');
      return;
    }

    await ETB.sleep(1000);

    const passengerCount = preferences?.passengerCount || 1;
    const options = Array.from(coachSelect.options).filter(opt => opt.value && !opt.disabled);

    // Eligible coaches: enough seats (hard filter) and not XTR/Extra.
    const coachInfo = [];
    for (const opt of options) {
      const match = opt.textContent.match(/-\s*(\d+)\s*Seat/i);
      const count = match ? parseInt(match[1]) : 0;
      if (count < passengerCount) {
        ETB.log(`Skipping ${opt.textContent.trim()}: ${count} seats < ${passengerCount} needed`);
        continue;
      }
      if (/\bXTR|EXTRA\b/.test(opt.textContent.toUpperCase())) continue;
      coachInfo.push({ option: opt, count });
    }

    // ── Score every eligible coach: which one's BEST N-seat cluster sits
    // closest to the coach center? Total seat count is irrelevant beyond the
    // eligibility filter — a 4-seat coach with a center pair beats a 25-seat
    // coach whose only pairs are at the front/back. ──
    const layoutCfg = getClassLayout(getCurrentClass());

    function scoreCoachByCenter(seats, totalRendered) {
      const nums = seats.map(getSeatNumber).filter(n => n != null);
      if (!nums.length) return Infinity;
      const maxNum = totalRendered || Math.max(...nums);

      if (passengerCount === 1) {
        return Math.min(...nums.map(n => numberCenterDistance(n, layoutCfg, maxNum)));
      }

      // Adjacent groups per class layout: First/AC → blocks of 3 (1-3, 4-6...),
      // Snigdha → pairs from 4-5/6-7 (even start), Shovan Chair → pairs from
      // 3-4/5-6 (odd start). Group grid snapped via groupStartFor().
      const groupSize = layoutCfg?.groupSize || 2;
      const sortedNums = [...new Set(nums)].sort((a, b) => a - b);
      let best = Infinity;

      // Complete groups first ("always try to book pair first")
      for (const start of sortedNums) {
        let size = 1;
        while (sortedNums.includes(start + size)) size++;
        if (size < passengerCount) continue;
        const blockStart = groupStartFor(start, layoutCfg);
        for (let b = blockStart; b <= start; b += groupSize) {
          for (let s = b; s + passengerCount - 1 <= b + groupSize - 1; s++) {
            if (sortedNums.includes(s) && sortedNums.includes(s + passengerCount - 1)) {
              const mid = (s + s + passengerCount - 1) / 2;
              best = Math.min(best, numberCenterDistance(mid, layoutCfg, maxNum));
            }
          }
        }
      }

      // Then adjacent-number runs (fallback: "if not, adjacent number")
      for (let i = 0; i + passengerCount - 1 < sortedNums.length; i++) {
        let ok = true;
        for (let j = 1; j < passengerCount; j++) {
          if (sortedNums[i + j] !== sortedNums[i] + j) { ok = false; break; }
        }
        if (ok) {
          const mid = (sortedNums[i] + sortedNums[i + passengerCount - 1]) / 2;
          best = Math.min(best, numberCenterDistance(mid, layoutCfg, maxNum));
        }
      }

      // Last resort: any N seats minimizing summed center distance
      if (best === Infinity) {
        const combos = (arr, k) => {
          if (k === 1) return arr.map(v => [v]);
          const res = [];
          for (let i = 0; i <= arr.length - k; i++) {
            for (const tail of combos(arr.slice(i + 1), k - 1)) res.push([arr[i], ...tail]);
          }
          return res;
        };
        for (const c of combos(sortedNums, passengerCount)) {
          const sum = c.reduce((a, n) => a + numberCenterDistance(n, layoutCfg, maxNum), 0);
          best = Math.min(best, sum);
        }
      }

      return best;
    }

    async function countRenderedSeats() {
      const layout = document.querySelector(SEL.seatLayoutContainer);
      const all = layout ? Array.from(layout.querySelectorAll(SEL.allSeats)).filter(ETB.isVisible) : [];
      return all.length;
    }

    async function switchCoach(option) {
      if (coachSelect.value !== option.value) {
        coachSelect.value = option.value;
        coachSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await ETB.sleep(1500);

        // Handle SweetAlert confirmation for extra coaches
        const okBtn = document.querySelector(SEL.sweetAlertConfirm);
        if (okBtn && ETB.isVisible(okBtn)) {
          okBtn.click();
          await ETB.sleep(500);
        }
      }
    }

    for (const info of coachInfo) {
      await switchCoach(info.option);
      const seats = findAvailableSeats();
      const totalRendered = await countRenderedSeats();
      info.score = scoreCoachByCenter(seats, totalRendered);
      info.seats = seats;
      ETB.log(`Coach ${info.option.textContent.trim()}: ${seats.length} available, center score = ${info.score}`);
    }

    // Sort coaches ascending by center score (closest-to-center first), NOT by seat count
    coachInfo.sort((a, b) => a.score - b.score);

    ETB.log(`Coach priority (closest to center first): ${coachInfo.map(c => `${c.option.textContent.trim()}(score:${c.score})`).join(' → ')}`);

    // Try each coach until we find enough seats
    for (const { option, seats } of coachInfo) {
      if (seats.length < passengerCount) continue;

      // Pick best seats from this coach
      await switchCoach(option);
      const availableSeats = findAvailableSeats();
      const seatsToClick = pickBestSeats(availableSeats, passengerCount);
      let confirmedCount = 0;
      const seatNames = [];

      for (const seat of seatsToClick) {
        const seatName = (seat.title || seat.textContent).trim();
        ETB.showNotification(`Reserving seat ${seatName} (${confirmedCount + 1}/${passengerCount})...`, 'info');
        seat.scrollIntoView({ behavior: 'auto', block: 'center' });
        seat.click();

        // Wait for seat to be marked as selected (or an error popup)
        try {
          await waitFor(() => {
            if (seat.classList.contains('seat-selected')) return true;
            // Check for error popup
            const alert = document.querySelector(SEL.sweetAlertPopup);
            if (alert && ETB.isVisible(alert)) {
              throw new Error(alert.innerText.trim() || 'Seat reservation rejected');
            }
            return null;
          }, 10000, `seat '${seatName}' to be reserved`);

          confirmedCount++;
          seatNames.push(seatName);
          ETB.log(`✅ Seat ${seatName} confirmed`);
        } catch (err) {
          ETB.log(`❌ Seat ${seatName} failed: ${err.message}`);
        }

        await ETB.sleep(300);
      }

      if (confirmedCount >= passengerCount) {
        resetRetry(); // Success — clear retry counter
        const currentClass = getCurrentClass();
        const classLabel = CLASS_DISPLAY[currentClass] || currentClass;
        const coachLabel = option.textContent.trim().split('-')[0].trim();

        ETB.showNotification(
          `✅ ${confirmedCount} seat(s) selected (${classLabel}, Coach ${coachLabel}): ${seatNames.join(', ')}`,
          'success'
        );
        ETB.updateBookingStatus(3, `Seats: ${seatNames.join(', ')} [${classLabel}, ${coachLabel}]`);

        // // Click Continue Purchase (commented out — stop after seat selection)
        // await ETB.sleep(800);
        // const continueBtn = Array.from(document.querySelectorAll('button')).find(
        //   b => b.textContent.trim().toUpperCase().includes('CONTINUE PURCHASE')
        // );
        // if (continueBtn && ETB.isVisible(continueBtn) && !continueBtn.disabled) {
        //   continueBtn.click();
        //   ETB.log('Clicked CONTINUE PURCHASE');
        // }
        stopAllAutomation();
        return;
      }

      ETB.log(`Only got ${confirmedCount}/${passengerCount} in coach ${option.textContent.trim()}`);
    }

    // No coach had enough seats → advance the train × class matrix.
    // Class fallback keeps us on the same train (URL ?class= param); when all
    // classes are exhausted, moving to the next train requires going back to
    // the train-results list. retryCount only increments after a FULL sweep.
    {
      const preferredTrains = getPreferredTrains();

      if (preferredTrains.length === 0) {
        // Single-train mode: try the next class on this train; if none left,
        // count it as a full sweep and reload-retry (max 3).
        const fallbackOk = await tryNextClass();
        if (fallbackOk) return;
        if (retryCount + 1 >= MAX_RETRIES) {
          ETB.showNotification(`⛔ Stopped after ${MAX_RETRIES} attempts. Select manually.`, 'error', 15000);
          ETB.updateBookingStatus(3, `Stopped after ${MAX_RETRIES} attempts`);
          return;
        }
        incrementRetry();
        ETB.showNotification(`⚠️ Not enough seats. Retrying (${retryCount}/${MAX_RETRIES})...`, 'warning', 6000);
        await ETB.sleep(2000);
        window.location.reload();
        return;
      }

      // Preferred-train matrix mode: advance exactly one cell and navigate.
      const { newSweep } = advanceMatrix();
      persistMatrixIndices();

      if (newSweep) {
        if (retryCount + 1 >= MAX_RETRIES) {
          ETB.showNotification(`⛔ Stopped after ${MAX_RETRIES} attempts. Select manually.`, 'error', 15000);
          ETB.updateBookingStatus(3, `Stopped after ${MAX_RETRIES} attempts`);
          return;
        }
        incrementRetry(); // one full sweep of the matrix completed without success
        ETB.log(`Seat selection failed — finished try ${retryCount}/${MAX_RETRIES}, restarting matrix from [train 1] [class ${CLASS_DISPLAY[getCurrentClass()] || getCurrentClass()}]`);
        ETB.showNotification(`⚠️ No seats in any train/class combo. Try ${retryCount}/${MAX_RETRIES}...`, 'warning', 6000);
        await ETB.sleep(2000);
        window.location.reload();
        return;
      }

      ETB.log(`Seat selection failed for current cell — advancing to [train ${currentTrainIndex + 1}] [class ${CLASS_DISPLAY[getCurrentClass()] || getCurrentClass()}] within try ${retryCount + 1}/${MAX_RETRIES}`);
      lastDetectedPage = '';
      try {
        const url = new URL(window.location.href);
        if (!url.pathname.includes('/booking/train/search')) {
          url.pathname = '/booking/train/search';
        }
        url.searchParams.set('class', getCurrentClass());
        window.location.href = url.toString();
      } catch (e) {
        await goToTrainResults();
      }
    }
  }

  function findAvailableSeats() {
    const allBtns = document.querySelectorAll('button.btn-seat');
    const available = Array.from(document.querySelectorAll(SEL.availableSeat)).filter(ETB.isVisible);
    ETB.log(`findAvailableSeats: ${allBtns.length} total seat buttons, ${available.length} available`);
    if (available.length > 0) {
      ETB.log(`Available seats: ${available.slice(0, 10).map(s => (s.title || s.textContent).trim()).join(', ')}${available.length > 10 ? '...' : ''}`);
    } else if (allBtns.length > 0) {
      // Log first few buttons and their classes for debugging
      const sample = Array.from(allBtns).slice(0, 5).map(b => `${(b.title || b.textContent).trim()}[${b.className}]`);
      ETB.log(`No available seats found. Sample button classes: ${sample.join(', ')}`);
    }
    return available;
  }

  /**
   * Smart seat picker — respects train seating layout:
   *   - 2 seats: must be adjacent pair (window+aisle, same row)
   *   - 3+ seats: tight cluster across minimal rows
   *   - Always prefer center-most rows (forward-facing center area)
   *   - Never split across coaches (handled by caller)
   */
  function pickBestSeats(availableSeats, count) {
    if (availableSeats.length <= count) return availableSeats;

    const layout = document.querySelector(SEL.seatLayoutContainer);
    const allSeatBtns = layout ? Array.from(layout.querySelectorAll(SEL.allSeats)).filter(ETB.isVisible) : [];

    if (!allSeatBtns.length) return availableSeats.slice(0, count);

    // ── Map every seat to position info ──
    const ROW_TOLERANCE = 15; // px — seats on the same row are within this Y range

    function seatInfo(btn) {
      const rect = btn.getBoundingClientRect();
      return {
        btn,
        x: rect.left + rect.width / 2,
        y: rect.top + rect.height / 2,
        name: (btn.title || btn.textContent).trim()
      };
    }

    const layoutCfg = getClassLayout(getCurrentClass());
    const GROUP_SIZE = layoutCfg?.groupSize || 2; // 3 for First/AC classes, 2 for Snigdha/Shovan Chair

    const allInfo = allSeatBtns.map(s => ({ ...seatInfo(s), num: getSeatNumber(s) }));
    const availInfo = availableSeats.map(s => ({ ...seatInfo(s), num: getSeatNumber(s) }));
    const availSet = new Set(availableSeats);

    // ── Group ALL seats into rows by Y ──
    const rows = [];
    const sorted = [...allInfo].sort((a, b) => a.y - b.y);

    for (const seat of sorted) {
      let placed = false;
      for (const row of rows) {
        if (Math.abs(seat.y - row[0].y) < ROW_TOLERANCE) {
          row.push(seat);
          placed = true;
          break;
        }
      }
      if (!placed) rows.push([seat]);
    }

    // Sort seats in each row left-to-right
    rows.forEach(row => row.sort((a, b) => a.x - b.x));

    // ── Identify adjacent groups within each row ──
    // Seat numbers on one side of the aisle are consecutive blocks of GROUP_SIZE
    // (First/AC: 1-3, 4-6...; Snigdha pairs start 4-5, 6-7...; Shovan Chair pairs
    // start 3-4, 5-6...). Geometry is used to split sides at the aisle, and seat
    // numbers snap each side's available seats onto its contiguous number runs.
    function getGroups(row) {
      if (row.length < 2) return [];

      // Find the aisle gap (largest X distance between consecutive seats)
      let maxGap = 0, aisleIdx = 0;
      for (let i = 0; i < row.length - 1; i++) {
        const gap = row[i + 1].x - row[i].x;
        if (gap > maxGap) { maxGap = gap; aisleIdx = i; }
      }

      const sides = [row.slice(0, aisleIdx + 1), row.slice(aisleIdx + 1)];
      const groups = [];

      for (const side of sides) {
        if (side.length < 2) continue;

        // Contiguous runs of seat numbers on this side (e.g. [22,23], [30,31])
        const runs = [];
        for (const s of side) {
          const last = runs[runs.length - 1];
          if (last && s.num != null && last[last.length - 1].num === s.num - 1) {
            last.push(s);
          } else {
            runs.push([s]);
          }
        }

        for (const run of runs) {
          if (run.length < 2) continue;
          const firstNum = run[0].num;
          if (firstNum == null) {
            // No usable numbers — fall back to fixed-size geometric chunking
            for (let i = 0; i < run.length - 1; i += GROUP_SIZE) {
              groups.push(run.slice(i, Math.min(i + GROUP_SIZE, run.length)));
            }
            continue;
          }
          // Snap to the class's group grid so only TRUE adjacent blocks form
          // a group. Snigdha pairs start on EVEN numbers (4-5, 6-7, …24-25,
          // 26-27) so run [24,25,26,27] yields pairs 24-25 and 26-27 — never
          // the cross-block 25-26. Shovan Chair pairs start ODD (3-4, 5-6…).
          const blockStart = groupStartFor(firstNum, layoutCfg);
          for (let b = blockStart; b <= run[run.length - 1].num; b += GROUP_SIZE) {
            const block = run.filter(s => s.num >= b && s.num < b + GROUP_SIZE);
            if (block.length >= 2) groups.push(block);
          }
        }
      }

      return groups;
    }

    // Complete groups (every seat available) first, then partial ones —
    // "always try to book pair first, if not, adjacent number".
    function getCompleteGroups(row) {
      return getGroups(row).filter(g => g.every(s => availSet.has(s.btn)));
    }

    // ── Calculate center Y of all rows ──
    const allY = rows.map(r => r[0].y);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const centerY = (minY + maxY) / 2;

    // Score: lower = better (closer to center). Primary score uses real row
    // geometry; seat-number distance from the class's center zone is a small
    // tie-breaker so within-row choices land in the true center seats.
    function centerScore(y) { return Math.abs(y - centerY); }

    const totalNums = allInfo.map(s => s.num).filter(n => n != null);
    const maxSeatNum = totalNums.length ? Math.max(...totalNums) : 0;

    function bestOf(list, scoreFn) {
      let best = null, bestS = Infinity;
      for (const item of list) {
        const s = scoreFn(item);
        if (s < bestS) { bestS = s; best = item; }
      }
      return { best, bestS };
    }

    function groupCenterTie(g) {
      return (g.reduce((a, s) => a + numberCenterDistance(s.num, layoutCfg, maxSeatNum), 0) / g.length);
    }

    // Average number-center distance of the available seats in a row
    function avgNumDist(row, cfg, total) {
      const free = row.filter(s => availSet.has(s.btn));
      if (!free.length) return Infinity;
      return free.reduce((a, s) => a + numberCenterDistance(s.num, cfg, total), 0) / free.length;
    }

    // ── For count === 1 ──
    if (count === 1) {
      // Number-based center distance dominates: the class's center zone /
      // centerSeat = (totalSeats+1)/2 defines "center" far more reliably than
      // pixel rows, which can be skewed by headers or unrendered layouts.
      const geoScale = maxY > minY ? 0.05 : 0;
      const { best } = bestOf(availInfo, s =>
        numberCenterDistance(s.num, layoutCfg, maxSeatNum) + centerScore(s.y) * geoScale);
      return [best.btn];
    }

    // ── For count === 2: find best adjacent pair ──
    if (count === 2) {
      // Adjacency (same row, same group block) is hard-constrained by
      // getCompleteGroups; among valid groups the one whose seat NUMBERS sit
      // closest to the class center wins (pixel Y only breaks exact ties).
      const allComplete = rows.flatMap(row => getCompleteGroups(row));
      let bestPair = null, bestTie = Infinity, bestCS = Infinity;
      for (const g of allComplete) {
        const tie = groupCenterTie(g);
        const cs = centerScore(g[0].y);
        if (tie < bestTie - 1e-9 || (Math.abs(tie - bestTie) <= 1e-9 && cs < bestCS)) {
          bestTie = tie; bestCS = cs; bestPair = g;
        }
      }

      if (bestPair) {
        ETB.log(`Picked pair: ${bestPair.map(s => s.name).join(', ')} (center distance: ${bestCS.toFixed(0)}px)`);
        return bestPair.slice(0, 2).map(s => s.btn);
      }

      // Fallback: no complete pair available — pick 2 adjacent-NUMBER seats on
      // the same row (most-centered numbers first), then geometrically closest two.
      ETB.log('No complete adjacent pair found, falling back to closest same-row seats');
      const allAdjRuns = [];
      for (const row of rows) {
        const avail = row.filter(s => availSet.has(s.btn));
        if (avail.length < 2) continue;
        const byNum = [...avail].sort((a, b) => (a.num ?? 1e9) - (b.num ?? 1e9));
        for (let i = 0; i < byNum.length - 1; i++) {
          if (byNum[i].num != null && byNum[i + 1].num === byNum[i].num + 1) {
            allAdjRuns.push([byNum[i], byNum[i + 1]]);
          }
        }
      }
      if (allAdjRuns.length) {
        const { best } = bestOf(allAdjRuns, g => groupCenterTie(g));
        return [best[0].btn, best[1].btn];
      }

      // No adjacent numbers anywhere — 2 closest-to-center available seats
      const ranked = [...availInfo].sort((a, b) =>
        (numberCenterDistance(a.num, layoutCfg, maxSeatNum) - numberCenterDistance(b.num, layoutCfg, maxSeatNum)) ||
        (centerScore(a.y) - centerScore(b.y)));
      return ranked.slice(0, 2).map(s => s.btn);
    }

    // ── For count >= 3: tight cluster across minimal rows, near center ──
    // Try all windows of consecutive rows, pick the one nearest center with enough available seats
    let bestCluster = null;
    let bestClusterScore = Infinity;

    for (let span = 1; span <= rows.length; span++) {
      for (let start = 0; start <= rows.length - span; start++) {
        const clusterRows = rows.slice(start, start + span);
        const clusterAvail = clusterRows.flatMap(r => r.filter(s => availSet.has(s.btn)));

        if (clusterAvail.length >= count) {
          // Score: how centered the cluster's AVAILABLE seats are, by seat
          // number (primary) and row geometry (tie-break); fewer rows preferred.
          const clusterNumScore = clusterAvail.reduce((a, s) => a + numberCenterDistance(s.num, layoutCfg, maxSeatNum), 0) / clusterAvail.length;
          const clusterMidY = (clusterRows[0][0].y + clusterRows[clusterRows.length - 1][0].y) / 2;
          const geoPenalty = Math.abs(clusterMidY - centerY) * 0.05 + span * 0.5;
          const score = clusterNumScore + geoPenalty;

          if (score < bestClusterScore) {
            bestClusterScore = score;
            // Pick seats: prefer complete groups, most-centered first
            const picked = [];
            const sortedCluster = [...clusterRows].sort((a, b) =>
              (avgNumDist(a, layoutCfg, maxSeatNum) - avgNumDist(b, layoutCfg, maxSeatNum)) ||
              (centerScore(a[0].y) - centerScore(b[0].y)));

            for (const row of sortedCluster) {
              if (picked.length >= count) break;
              const groups = getGroups(row);
              // Add COMPLETE available groups first (pairs/triples together),
              // most-centered group first
              const complete = groups.filter(g => g.every(s => availSet.has(s.btn)))
                .sort((a, b) => groupCenterTie(a) - groupCenterTie(b));
              for (const group of complete) {
                if (picked.length >= count) break;
                group.forEach(s => { if (picked.length < count && !picked.includes(s)) picked.push(s); });
              }
              // Then partial groups — take adjacent seats from them
              for (const group of groups.filter(g => !g.every(s => availSet.has(s.btn)))) {
                const free = group.filter(s => availSet.has(s.btn) && !picked.includes(s));
                for (const s of free) {
                  if (picked.length >= count) break;
                  picked.push(s);
                }
              }
              // Then remaining available singles in that row
              const rowAvail = row.filter(s => availSet.has(s.btn) && !picked.includes(s));
              for (const s of rowAvail) {
                if (picked.length >= count) break;
                picked.push(s);
              }
            }

            if (picked.length >= count) {
              bestCluster = picked.slice(0, count);
            }
          }
        }
      }
      if (bestCluster) break; // Found a cluster with minimum row span
    }

    if (bestCluster) {
      ETB.log(`Picked cluster: ${bestCluster.map(s => s.name).join(', ')} (${new Set(bestCluster.map(s => Math.round(s.y / 15))).size} row(s))`);
      return bestCluster.map(s => s.btn);
    }

    // Fallback: closest to center by seat number (geometry as tie-break)
    const ranked = [...availInfo].sort((a, b) =>
      (numberCenterDistance(a.num, layoutCfg, maxSeatNum) - numberCenterDistance(b.num, layoutCfg, maxSeatNum)) ||
      (centerScore(a.y) - centerScore(b.y)));
    return ranked.slice(0, count).map(s => s.btn);
  }

  function getSelectedSeatLabels() {
    return Array.from(document.querySelectorAll('.seat-selected'))
      .map(s => (s.title || s.textContent).trim())
      .filter(Boolean);
  }

  // ─── Step 5: Passenger Details ───────────────────────────────────────
  async function handlePassengerDetails() {
    ETB.showProgress(4, TOTAL_STEPS, 'Filling passenger details...');
    await ETB.sleep(1000);

    const nameInputs = document.querySelectorAll(SEL.passengerName);
    if (nameInputs.length > 0 && profile) {
      ETB.reactInputHack(nameInputs[0], profile.name || '');
      await ETB.sleep(200);
    }

    const continueBtn = Array.from(document.querySelectorAll('button')).find(b => normalize(b.textContent) === 'continue' || normalize(b.textContent) === 'proceed');
    if (continueBtn) {
      continueBtn.click();
    }
  }

  // ─── Step 6: Payment ─────────────────────────────────────────────────
  async function handlePayment() {
    ETB.showProgress(5, TOTAL_STEPS, 'Ready for payment');
    const summary = gatherBookingSummary();
    
    const confirmed = await ETB.showConfirmation({
      title: 'Ready to Pay',
      subtitle: 'Please review your booking details before proceeding.',
      details: summary.details,
      totalLabel: 'Total Amount',
      totalValue: summary.total
    });

    if (confirmed) {
      ETB.log('User confirmed payment');
    } else {
      ETB.log('User cancelled payment');
      ETB.showNotification('Payment cancelled.', 'warning');
    }
  }

  function gatherBookingSummary() {
    const details = [
      { label: '📍 Journey', value: `${preferences?.from || ''} → ${preferences?.to || ''}` },
      { label: '📅 Date', value: preferences?.date || '' },
      { label: '🎫 Class', value: CLASS_DISPLAY[getCurrentClass()] || getCurrentClass() }
    ];

    const seatLabels = getSelectedSeatLabels();
    if (seatLabels.length > 0) {
      details.push({ label: '💺 Seats', value: seatLabels.join(', ') });
    }

    if (profile?.name) {
      const names = [profile.name];
      (profile.coPassengers || []).forEach(cp => { if (cp.name) names.push(cp.name); });
      details.push({ label: '👤 Passengers', value: names.join(', ') });
    }

    details.push({ label: '🔢 Tickets', value: String(preferences?.passengerCount || 1) });

    // Try to find fare on the page
    let total = '';
    const fareMatch = document.body.innerText.match(/(?:Total|মোট|Payable)[:\s]*(৳\s*[\d,]+)/i);
    if (fareMatch) total = fareMatch[1];

    return { details, total: total || 'See payment page' };
  }

  // Bootstrap
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
