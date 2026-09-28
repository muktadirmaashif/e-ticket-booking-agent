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

  // ─── Rush Mode (score-and-strike) ────────────────────────────────────
  // Fast-path seat booking: pre-rank coaches from dropdown text only, switch
  // with event-driven render waits (no blind sleeps), and BOOK THE FIRST coach
  // whose best group scores ≤ STRIKE_SCORE — instead of auditing every coach
  // upfront and re-switching to the global winner. Full-audit mode remains as
  // fallback. Disable via popup ("Rush mode" toggle) or prefs.rushMode=false.
  const RUSH_DEFAULTS = {
    rushMode: true,        // fast path on/off (fallback audit always available)
    strikeScore: 1,        // book instantly when best group center-distance ≤ this
                           // (0 = only perfectly-centered groups trigger a strike;
                           //  1 also accepts "near the class center zone")
    initialWait: 0,        // render waits are event-driven — no fixed settle at all
    settleMs: 0,           // score the instant the layout fingerprint changes
                           // (was 150ms of post-mutation quiet time)
    switchTimeout: 2500,   // max wait for coach layout re-render (event-driven)
    staleFallbackMs: 250,  // only used when NO re-render is ever detected; was a
                           // blind sleep(1500) → 600ms. Tight strike thresholds
                           // (0–1) miss more often, so every coach pays this on
                           // the no-change path — keep it short.
    auditLogEvery: 3,      // throttles per-coach audit log writes in rush mode
                           // (each write buffers + schedules a storage flush;
                           // with ~10 coaches that's measurable main-thread
                           // work mid-race). 1 = log every coach (verbose).
    clickGap: 0,           // back-to-back optimistic clicks (was 300ms per seat)
    confirmTimeout: 2500,  // was 10s → 4s → now 2.5s per-seat confirmation cap
    fastConfirm: true,     // rAF+MO event-driven seat confirmation (vs legacy
                           // waitFor polling); verified seats are clicked
                           // serially, unverified ones optimistically in parallel
    burstClicks: false,    // CONFIRMED FROM LIVE MARKUP: IRCTC's Angular app
                           // re-renders the coach layout on every seat click
                           // (buttons carry only _ngcontent + state classes —
                           // no stable id/data-attrs, so a detached node can't
                           // be trusted). A synchronous multi-seat burst races
                           // those re-renders → second click lands on shifted
                           // nodes (the 24+31-instead-of-25+31 misfire). Keep
                           // false: per-click MO confirmation is same-frame
                           // fast (~one round-trip total for 2 seats). Set true
                           // ONLY if the page ever moves to pure client-side
                           // selection with stable nodes.
    notifyUi: false        // suppress per-seat UI notifications during booking
                           // (each ETB.showNotification round-trips to the SW,
                           // adding ms between clicks at rush hour)
  };

  function getRushConfig() {
    // Popup settings (rushMode/strikeScore) override the defaults; power users
    // can also set a `preferences.rush` object for the fine-grained knobs.
    const p = preferences || {};
    const overrides = {};
    if (typeof p.rushMode === 'boolean') overrides.rushMode = p.rushMode;
    if (Number.isInteger(p.strikeScore)) overrides.strikeScore = p.strikeScore;
    return { ...RUSH_DEFAULTS, ...(p.rush || {}), ...overrides };
  }

  function sleep(ms) {
    return ETB.sleep(ms > 0 ? ms : 0);
  }

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

    // RUSH: was a blind sleep(1500) on every page load. The first thing
    // detectAndAutomate() does is waitFor() its target element, which polls
    // until the element exists — an extra fixed wait only delays the strike
    // window by 1.5s at rush hour. Skip it when rush mode is on.
    if (!getRushConfig().rushMode) await ETB.sleep(1500);
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
  // BUGFIX (PR #7): PARABAT EXPRESS was never matchable — it is a real train
  // name on this route yet sat in the generic-suffix strip list (leftover from
  // an older naming scheme), so "PARABAT EXPRESS" normalized to "" and fuzzy
  // matching bailed out with "not found". Also: stripping whole words used to
  // turn "TITRA EXPRESS" into "EXPRESS", which then matched ANY card whose
  // text contained another train's suffix word ("EXP") — cross-train false
  // positives. Now we keep both a conservative form (type-suffixes stripped)
  // and a raw compact form, and require BOTH to agree before a match counts.
  const TRAIN_TYPE_SUFFIXES = /\b(EXPRESS|EXP|INTERCITY|SHUTTLE|COMMUTER|MAIL|SLEEPER)\b/g;
  const GENERIC_TOKENS = new Set(['', 'EXPRESS', 'EXP', 'INTERCITY', 'SHUTTLE', 'COMMUTER', 'MAIL', 'SLEEPER']);

  function normTrainName(str) {
    if (!str) return '';
    let s = String(str).toUpperCase().replace(/[^A-Z0-9]+/g, ' ');
    s = s.replace(TRAIN_TYPE_SUFFIXES, ' ');
    return s.replace(/\s+/g, ' ').trim();
  }

  /** Compact raw form (no suffix stripping) for the second agreement check. */
  function compactTrainName(str) {
    return String(str || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  }

  function trainNamesMatch(cardText, preferredName) {
    const a = normTrainName(cardText);
    const b = normTrainName(preferredName);
    if (!a || !b) return false;
    // If either side lost ALL its words to suffix-stripping (e.g. someone
    // prefers just "EXPRESS"), fall back to comparing the raw compact forms.
    if (GENERIC_TOKENS.has(a) || GENERIC_TOKENS.has(b)) {
      const ca = compactTrainName(cardText);
      const cb = compactTrainName(preferredName);
      return !!ca && !!cb && (ca === cb || ca.includes(cb) || cb.includes(ca));
    }
    const loose = a === b || a.includes(b) || b.includes(a);
    if (!loose) return false;
    // Agreement guard: the raw compact names must also overlap, so a card
    // titled "KALNI EXP" can never match preference "PARABAT EXPRESS".
    const ca = compactTrainName(cardText);
    const cb = compactTrainName(preferredName);
    return ca.includes(cb) || cb.includes(ca);
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

    // RUSH: was an unconditional sleep(1000) before even looking for train
    // cards — pure dead time on the race-critical path. The waitFor below is
    // event-driven (MutationObserver), so rush mode skips the fixed wait and
    // reacts the moment cards render. Legacy mode keeps the original 1s.
    if (!getRushConfig().rushMode) await ETB.sleep(1000);

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

    /** Find a train card by name match (fuzzy: case/punctuation/EXPRESS-suffix).
     *  REREAD LIVE each call — BUGFIX (PR #7): the Angular results page can
     *  re-render and replace app-single-trip nodes AFTER our initial snapshot,
     *  leaving stale detached cards in `trainCards` so a visible train looked
     *  "not found". querySelectorAll on ~10 rows is sub-millisecond. */
    function findTrainCard(name) {
      const live = Array.from(document.querySelectorAll(SEL.trainCard));
      return live.find(card => {
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
      const rush = getRushConfig();
      const trainNameEl = trainCard.querySelector(SEL.trainName);
      if (trainNameEl) {
        trainNameEl.scrollIntoView({ behavior: 'auto', block: 'center' });
        trainNameEl.click();
        // RUSH: was a blind sleep(800) between expanding the row and clicking
        // BOOK NOW. The row-expansion only needs one paint before the button
        // is live; the seat-layout waitFor below is event-driven anyway.
        await ETB.sleep(rush.rushMode ? 120 : 800);
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
        // BUGFIX (PR #7): the class card was evaluated from a snapshot taken
        // up to ~4s earlier; Angular re-renders seat counts asynchronously, so
        // a train that NOW has seats read as "only 0 available" and got
        // skipped. Before trusting an 'insufficient' verdict, wait briefly for
        // the count to settle above zero (event-driven; returns immediately
        // when already bookable or genuinely sold out).
        if (evalRes.reason === 'insufficient') {
          try {
            await waitFor(() => {
              const fresh = findClassCard(trainCard, targetClass) || classCard;
              return evaluateClassCard(fresh, targetClass, passengerCount).bookable ? true : null;
            }, 1200, `${targetClass} availability on ${trainLabel}`);
            const reEval = evaluateClassCard(findClassCard(trainCard, targetClass) || classCard, targetClass, passengerCount);
            if (reEval.bookable) {
              Object.assign(evalRes, reEval, { bookable: true });
              ETB.log(`⏳ ${trainLabel}/${targetClass}: availability settled after delayed render — proceeding`);
            }
          } catch (e) { /* still not bookable after grace period */ }
        }
      }
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

  // ─── Step 4: Smart Seat Selection (score-and-strike) ────────────────
  // Phase 1 (rush mode, default): walk coaches in heuristic order; on each
  // coach wait for the re-render EVENT (not a blind sleep), score its best
  // group in memory, and BOOK INSTANTLY the first coach whose score ≤ strike
  // threshold. No second traversal — we're already on the winning coach.
  // Phase 2 (fallback): no strike fired → we've collected every coach's score
  // during Phase 1, so sort ascending and book the best cached coach (the old
  // global-audit flow, minus the redundant re-read pass).
  async function handleSeatSelection() {
    ETB.showProgress(3, TOTAL_STEPS, 'Selecting seats...');

    if (!preferences?.autoSeat) {
      ETB.showNotification('Auto-seat selection disabled.', 'info');
      return;
    }

    const rush = getRushConfig();

    let coachSelect;
    try {
      coachSelect = await waitFor(() => document.querySelector(SEL.coachSelect), 8000, 'coach select dropdown');
    } catch (e) {
      ETB.log('No coach select dropdown found');
      return;
    }

    // Rush mode: no fixed settle at all by default — the first coach switch is
    // fully event-driven. Legacy mode keeps the original 1000ms.
    if (!rush.rushMode) {
      await sleep(1000);
    } else if (rush.initialWait > 0) {
      await sleep(rush.initialWait);
    }

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

    /**
     * RUSH SCAN: one querySelectorAll + classList pass over the seat buttons.
     * Returns { available, rendered } — replaces findAvailableSeats() +
     * countRenderedSeats() (two DOM passes + two storage-backed log writes)
     * with a single ~0.1ms pass and zero logging overhead. Used everywhere in
     * the rush path; legacy mode keeps the old verbose helpers.
     */
    function scanSeatsOnce() {
      const layout = document.querySelector(SEL.seatLayoutContainer);
      const btns = layout ? layout.querySelectorAll(SEL.allSeats) : [];
      const available = [];
      let rendered = 0;
      for (const b of btns) {
        if (!b.offsetParent && getComputedStyle(b).visibility === 'hidden') continue;
        rendered++;
        if (b.classList.contains('seat-available') &&
            !b.classList.contains('seat-selected') &&
            !b.classList.contains('seat-disabled') &&
            !b.classList.contains('seat-in-progress') &&
            !b.classList.contains('seat-booked') &&
            !b.disabled) {
          available.push(b);
        }
      }
      return { available, rendered };
    }

    // ── Score every eligible coach: which one's BEST N-seat cluster sits
    // closest to the coach center? Total seat count is irrelevant beyond the
    // eligibility filter — a 4-seat coach with a center pair beats a 25-seat
    // coach whose only pairs are at the front/back. ──
    //
    // RUSH REWRITE: same pairing rules (Snigdha even-start pairs, Shovan
    // Chair odd-start, blocks of groupSize, adjacent-run fallback, any-N
    // last resort) but implemented over an O(1)-lookup availability array
    // in a SINGLE pass over seat numbers 1..maxNum (no Map, no window
    // scanning over button arrays). A ~100-seat coach scores in single-digit
    // microseconds, so the audit walk between strikes costs effectively zero.
    //
    // Also returns `alts`: ALL complete parity-grid groups ranked ascending
    // by center score. At strike time we already know every valid alternative
    // for this coach, so a mid-flight snipe never needs a geometry re-scan
    // (pickBestSeats) — we just take the next queued group. Same pairing
    // rules as before; the grid check (blockStart === s) is what prevents
    // cross-block pairs like Snigdha 25-26.
    const layoutCfg = getClassLayout(getCurrentClass());

    function scoreCoachByCenter(seats, totalRendered) {
      let maxSeen = 0;
      for (const b of seats) {
        const n = getSeatNumber(b);
        if (n != null && n > maxSeen) maxSeen = n;
      }
      if (!seats.length) return { score: Infinity, seats: [], alts: [] };
      const maxNum = Math.max(totalRendered || 0, maxSeen);
      const btnByNum = new Array(maxNum + 1).fill(null);
      for (const b of seats) {
        const n = getSeatNumber(b);
        if (n != null && n >= 1 && n <= maxNum && !btnByNum[n]) btnByNum[n] = b;
      }

      const dist = (x) => numberCenterDistance(x, layoutCfg, maxNum);

      if (passengerCount === 1) {
        let bestScore = Infinity, bestBtns = [];
        const alts = [];
        for (let n = 1; n <= maxNum; n++) {
          if (!btnByNum[n]) continue;
          const d = dist(n);
          alts.push({ score: d, seats: [btnByNum[n]] });
          if (d < bestScore) { bestScore = d; bestBtns = [btnByNum[n]]; }
        }
        alts.sort((a, b) => a.score - b.score);
        return { score: bestScore, seats: bestBtns, alts };
      }

      const groupSize = layoutCfg?.groupSize || 2;
      const span = passengerCount - 1;
      let bestScore = Infinity;
      let bestBtns = [];
      const alts = [];   // every complete GRID-aligned group, ranked

      // Single pass: every candidate window start s. Membership is O(1) on
      // the plain array; grid alignment uses groupStartFor (same rule as
      // pickBestSeats' snap: Snigdha pairs start EVEN at 4, S_CHAIR ODD at 3,
      // AC/First blocks of 3 from 1).
      for (let s = 1; s + span <= maxNum; s++) {
        if (!btnByNum[s] || !btnByNum[s + span]) continue;
        const blockStart = groupStartFor(s, layoutCfg);
        if (s !== blockStart || s + span > blockStart + groupSize - 1) continue;
        let ok = true;
        for (let j = 1; j < span; j++) if (!btnByNum[s + j]) { ok = false; break; }
        if (!ok) continue;
        const d = dist(s + span / 2);
        const grp = [];
        for (let j = 0; j <= span; j++) grp.push(btnByNum[s + j]);
        alts.push({ score: d, seats: grp });
        if (d < bestScore) { bestScore = d; bestBtns = grp; }
      }

      if (alts.length) {
        alts.sort((a, b) => a.score - b.score);
        return { score: bestScore, seats: bestBtns, alts };
      }

      // No complete grid group → adjacent-number runs (fallback: "if not,
      // adjacent number"), then greedy any-N nearest center (last resort).
      // Both mirror the original rules exactly.
      outer:
      for (let s = 1; s + span <= maxNum; s++) {
        for (let j = 0; j <= span; j++) if (!btnByNum[s + j]) continue outer;
        const d = dist(s + span / 2);
        if (d < bestScore) {
          bestScore = d;
          bestBtns = [];
          for (let j = 0; j <= span; j++) bestBtns.push(btnByNum[s + j]);
        }
      }

      if (bestScore === Infinity) {
        const ranked = [];
        for (let n = 1; n <= maxNum; n++) {
          if (btnByNum[n]) ranked.push({ n, b: btnByNum[n], d: dist(n) });
        }
        ranked.sort((x, y) => x.d - y.d);
        const top = ranked.slice(0, passengerCount);
        bestScore = top.reduce((a, r) => a + r.d, 0);
        bestBtns = top.map(r => r.b);
      }

      return { score: bestScore, seats: bestBtns, alts };
    }

    function countRenderedSeats() {
      const layout = document.querySelector(SEL.seatLayoutContainer);
      const all = layout ? Array.from(layout.querySelectorAll(SEL.allSeats)).filter(ETB.isVisible) : [];
      return all.length;
    }

    // Synchronous snapshot of the rendered layout — ONE querySelector call
    // (~0.1ms) so it can run every 30ms inside the switch loop without cost.
    function readLayoutFingerprint() {
      const layout = document.querySelector(SEL.seatLayoutContainer);
      if (!layout) return '';
      const btns = layout.querySelectorAll(SEL.allSeats);
      let fp = String(btns.length);
      if (btns.length) {
        fp += ',' + btns[0].className;
        fp += ',' + btns[btns.length - 1].className;
      }
      return fp;
    }

    /**
     * Event-driven coach switch. Fires the dropdown change, then resolves as
     * soon as the seat layout fingerprint actually changed vs before the switch
     * — NO settle wait by default (settleMs=0): scoring reads the live DOM, so
     * microtasks from the MutationObserver land on the fully-updated tree and
     * a stale read is impossible in practice. Polls at 30ms (was 100ms) so even
     * missed mutations are caught fast. Falls back to the old fixed wait only
     * if the change is never detected.
     */
    async function switchCoachFast(option, timeoutMs) {
      if (coachSelect.value === option.value) return;
      const prevFp = readLayoutFingerprint();
      coachSelect.value = option.value;
      coachSelect.dispatchEvent(new Event('change', { bubbles: true }));

      // SweetAlert confirmation for extra coaches — dismiss ASAP, keep polling.
      const swOk = document.querySelector(SEL.sweetAlertConfirm);
      if (swOk && ETB.isVisible(swOk)) swOk.click();

      let layoutChanged = false;   // did the seat layout visibly re-render?
      let lastChange = performance.now();

      await new Promise((resolve) => {
        let finished = false;
        const finish = () => {
          if (finished) return;
          finished = true;
          observer.disconnect();
          clearTimeout(checkTimer);
          clearTimeout(timeoutTimer);
          resolve();
        };
        const check = () => {
          const alert = document.querySelector(SEL.sweetAlertConfirm);
          if (alert && ETB.isVisible(alert)) alert.click();
          const fp = readLayoutFingerprint();
          if (fp && fp !== prevFp) {
            layoutChanged = true;
            lastChange = performance.now();
          }
          // Resolve as soon as the layout actually changed (+ optional settle
          // quiet-time), any SweetAlert is gone, and this coach is still the
          // selected one.
          if (layoutChanged &&
              coachSelect.value === option.value &&
              !(document.querySelector(SEL.sweetAlertConfirm) && ETB.isVisible(document.querySelector(SEL.sweetAlertConfirm))) &&
              performance.now() - lastChange >= rush.settleMs) {
            finish();
          }
        };
        const observer = new MutationObserver(() => queueMicrotask(check));
        observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
        const checkTimer = setInterval(check, 30);
        const timeoutTimer = setTimeout(finish, timeoutMs || rush.switchTimeout);
        check();
      });

      // Safety net: if the layout never visibly changed within the event window
      // (cached render or missed fingerprint), fall back to a short fixed wait
      // so we don't score a stale DOM. RUSH: was sleep(1500) — that blind
      // penalty hit every coach whose fingerprint happened not to change;
      // now capped at rush.staleFallbackMs (600ms default).
      if (!layoutChanged) await sleep(rush.staleFallbackMs);
    }

    // Legacy fixed-wait switch used when rush mode is off.
    async function switchCoachLegacy(option) {
      if (coachSelect.value !== option.value) {
        coachSelect.value = option.value;
        coachSelect.dispatchEvent(new Event('change', { bubbles: true }));
        await sleep(1500);

        // Handle SweetAlert confirmation for extra coaches
        const okBtn = document.querySelector(SEL.sweetAlertConfirm);
        if (okBtn && ETB.isVisible(okBtn)) {
          okBtn.click();
          await sleep(500);
        }
      }
    }

    /**
     * Fast, event-driven wait for ONE seat to gain .seat-selected. Resolves on
     * the exact mutation (MutationObserver microtask → same frame as Angular's
     * class flip) instead of waitFor's 200ms fallback poll — typically saves
     * 100–600ms per seat. Rejects on an error popup or timeout.
     *
     * RUSH: a single SHARED MutationObserver serves all concurrent waits
     * (previously each seat spun up its own document-wide observer — with N
     * seats that meant N callbacks per DOM change). One callback per batch of
     * mutations now checks every pending seat synchronously (~microseconds),
     * plus a 50ms safety poll in case a class flip was missed entirely.
     */
    const _seatWaiters = new Set();
    let _seatWaitMO = null;
    let _seatWaitPoll = null;

    function _checkSeatWaiters() {
      const alert = document.querySelector(SEL.sweetAlertPopup);
      const alertVisible = !!(alert && ETB.isVisible(alert));
      for (const w of [..._seatWaiters]) {
        if (w.settled) continue;
        if (w.seat.classList.contains('seat-selected')) { w.settled = true; _seatWaiters.delete(w); w.resolve(); }
        else if (alertVisible) { w.settled = true; _seatWaiters.delete(w); w.reject(new Error((alert.innerText || '').trim() || 'Seat reservation rejected')); }
        // Sniped server-side (lost seat-available / removed) → fail fast
        // instead of burning the full confirmTimeout waiting for a flip that
        // will never come — this is what made strike retries crawl.
        else if (!document.contains(w.seat) || !w.seat.classList.contains('seat-available')) {
          w.settled = true; _seatWaiters.delete(w); w.reject(new Error(`Seat '${w.name}' became unavailable`));
        }
      }
      if (_seatWaiters.size === 0 && _seatWaitMO) {
        _seatWaitMO.disconnect(); clearInterval(_seatWaitPoll);
        _seatWaitMO = null; _seatWaitPoll = null;
      }
    }

    function fastWaitSeatSelected(seat, timeoutMs, seatName) {
      return new Promise((resolve, reject) => {
        if (seat.classList.contains('seat-selected')) return resolve();
        const w = {
          seat, name: seatName, settled: false, resolve, reject,
          timer: setTimeout(() => {
            if (w.settled) return;
            w.settled = true; _seatWaiters.delete(w);
            if (_seatWaiters.size === 0 && _seatWaitMO) { _seatWaitMO.disconnect(); clearInterval(_seatWaitPoll); _seatWaitMO = null; _seatWaitPoll = null; }
            reject(new Error(`Timeout waiting for seat '${seatName}' to be reserved`));
          }, timeoutMs)
        };
        _seatWaiters.add(w);
        if (!_seatWaitMO) {
          _seatWaitMO = new MutationObserver(() => queueMicrotask(_checkSeatWaiters));
          _seatWaitMO.observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['class'] });
          _seatWaitPoll = setInterval(_checkSeatWaiters, 50);
        }
        queueMicrotask(_checkSeatWaiters);
      });
    }

    // ── Re-locate a seat button by NAME after Angular re-renders the layout ──
    // CONFIRMED FROM LIVE MARKUP: seat buttons carry no stable id/data attrs
    // (`button.btn-seat.seat-available`, title="JA-36"). After click #1 is
    // confirmed the app may replace the whole button set — our cached node for
    // seat #2 can become DETACHED while still showing its old
    // `.seat-available` class. A click on a detached node does nothing →
    // "Timeout waiting for seat 'JA-23'", and the retry path then fell back to
    // pickBestSeats' geometry pass, which produced cross-block picks like
    // 24+31 (breaking Snigdha's even-start pairing). Always resolve the live
    // button from the current DOM before clicking (sync querySelectorAll,
    // ~0.1ms per seat).
    function findSeatByName(name) {
      if (!name) return null;
      const layout = document.querySelector(SEL.seatLayoutContainer);
      if (!layout) return null;
      const norm = s => (s || '').replace(/\s+/g, '');
      for (const b of layout.querySelectorAll(SEL.allSeats)) {
        if (norm(b.title) === norm(name) || norm(b.textContent) === norm(name)) return b;
      }
      return null;
    }

    function isSeatAvailable(btn) {
      return !!btn && document.contains(btn) &&
        btn.classList.contains('seat-available') &&
        !btn.classList.contains('seat-disabled') &&
        !btn.classList.contains('seat-booked') &&
        !btn.disabled;
    }

    /**
     * Click the given seat buttons and verify each became .seat-selected.
     * Returns { confirmed, names, error }. An error popup aborts immediately
     * (caller handles rollback/retry — same semantics as before).
     *
     * RUSH BURST MODE (fastConfirm + burstClicks): ALL clicks fire in ONE
     * synchronous pass (zero awaits between them — no scrollIntoView, no
     * notifications, no per-seat confirmation absorbed mid-loop), then every
     * confirmation resolves CONCURRENTLY via MutationObserver microtasks.
     * Total click→all-confirmed time ≈ one server round-trip instead of N.
     * Set rush.burstClicks=false to revert to fire-and-absorb serial style;
     * legacy mode keeps the original waitFor + clickGap behavior.
     */
    async function clickAndVerifySeats(seatsToClick, confirmTimeout, clickGap, fastMode, burstMode, notifyUi) {
      if (fastMode && burstMode) {
        const targets = seatsToClick.filter(s => document.contains(s) && s.classList.contains('seat-available'));
        const names = targets.map(s => (s.title || s.textContent).trim());
        if (!targets.length) return { confirmed: 0, names: [] };
        if (notifyUi) ETB.showNotification(`Reserving ${names.join(', ')}...`, 'info');

        // Fire every click back-to-back — nothing between them but the click.
        for (const seat of targets) seat.click();

        // Verify all concurrently; first rejection wins the race against the
        // rest (their observers are cleaned up by their own timeouts/promises).
        const results = await Promise.allSettled(
          targets.map((seat, i) => fastWaitSeatSelected(seat, confirmTimeout, names[i]))
        );
        let confirmed = 0;
        let error = null;
        for (const r of results) {
          if (r.status === 'fulfilled') {
            confirmed++;
          } else if (!error) {
            error = r.reason;
          }
        }
        for (const r of results) {
          if (r.status === 'fulfilled') ETB.log('✅ Seat confirmed');
          else ETB.log(`❌ Seat failed: ${r.reason?.message || r.reason}`);
        }
        return { confirmed, names, error };
      }

      let confirmed = 0;
      const names = [];

      // CONFIRMED FROM LIVE MARKUP: seat buttons are plain Angular-rendered
      // nodes (`button.btn-seat.seat-available`, title="JA-36", no stable
      // id/data attrs). The app re-renders the layout on each reservation, so
      // firing click #2 before click #1 is confirmed lands on shifted/detached
      // nodes → wrong seats booked (the 24+31-instead-of-25-31 misfire) and
      // 'Timeout waiting for seat ...' failures. Every click is now verified
      // (.seat-selected via MutationObserver microtask) BEFORE the next one
      // fires, AND every seat after the first is RE-LOCATED by name in the
      // live DOM before clicking (cached nodes go stale after a re-render —
      // a detached node still carries its old .seat-available class, passes
      // the freshness guard, and silently swallows the click).
      for (const orig of seatsToClick) {
        const seatName = (orig.title || orig.textContent).trim();

        // Resolve the CURRENT button for this seat name (sync, ~0.1ms). If
        // the seat vanished/got sniped during a re-render, skip it — the
        // group-retry queue handles recovery with parity-valid groups.
        const seat = findSeatByName(seatName) || orig;
        if (!isSeatAvailable(seat)) continue;

        if (notifyUi) ETB.showNotification(`Reserving seat ${seatName} (${confirmed + 1}/${passengerCount})...`, 'info');
        // scrollIntoView forces a synchronous layout flush — skip it in the
        // fast path; Angular seats are already in the viewport grid.
        if (!fastMode) seat.scrollIntoView({ behavior: 'auto', block: 'center' });
        seat.click();
        names.push(seatName);

        try {
          if (fastMode) {
            await fastWaitSeatSelected(seat, confirmTimeout, seatName);
          } else {
            await waitFor(() => {
              if (seat.classList.contains('seat-selected')) return true;
              // Check for error popup
              const alert = document.querySelector(SEL.sweetAlertPopup);
              if (alert && ETB.isVisible(alert)) {
                throw new Error(alert.innerText.trim() || 'Seat reservation rejected');
              }
              return null;
            }, confirmTimeout, `seat '${seatName}' to be reserved`);
          }

          confirmed++;
          ETB.log(`✅ Seat ${seatName} confirmed`);
        } catch (err) {
          ETB.log(`❌ Seat ${seatName} failed: ${err.message}`);
          if (/rejected|already|booked|unavailable|taken/i.test(err.message)) {
            return { confirmed, names, error: err };
          }
        }

        if (clickGap > 0) await sleep(clickGap);
      }

      return { confirmed, names };
    }

    // Success bookkeeping shared by fast path & fallback booking loops.
    function finalizeSuccess(option, seatNames, confirmedCount) {
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
    }

    // ── PHASE 1 — Fast path: score-and-strike, first qualifying coach wins ──
    if (rush.rushMode && coachInfo.length) {
      // Cheap pre-rank from dropdown TEXT only (zero DOM switching): center-ish
      // bogies (KA/KHA-style short names) first, tie-break by seat count.
      const rankOf = (opt) => {
        const label = opt.textContent.trim().split('-')[0].trim().toUpperCase();
        const isShort = /^[A-Z]{1,3}$/.test(label);           // KA, KHA, C, D…
        const len = label.replace(/[^A-Z]/g, '').length;
        return (isShort ? 0 : 100) + len;                     // lower = try earlier
      };
      coachInfo.sort((a, b) => (rankOf(a.option) - rankOf(b.option)) || (b.count - a.count));
      ETB.log(`⚡ Rush mode: strike threshold ${rush.strikeScore}, trying ${coachInfo.length} coach(es) in order: ${coachInfo.map(c => c.option.textContent.trim()).join(' → ')}`);

      let auditIdx = 0; // rush-mode log throttle counter
      for (const info of coachInfo) {
        if (stopped) return;
        await switchCoachFast(info.option);
        const scan = scanSeatsOnce();
        const seats = scan.available;
        const scored = scoreCoachByCenter(seats, scan.rendered);
        info.score = scored.score;
        info.bestBtns = scored.seats;   // exact best group — zero re-pick cost
        info.alts = scored.alts;        // ranked next-best grid groups (retry queue)
        info.seats = seats;
        // RUSH: throttle per-coach audit writes. Each ETB.log buffers an entry
        // and re-arms a storage flush; with ~10 coaches that's measurable
        // main-thread work mid-race. Strike-qualifying coaches always log.
        if (auditIdx++ % Math.max(1, rush.auditLogEvery) === 0 || info.score <= rush.strikeScore) {
          ETB.log(`Coach ${info.option.textContent.trim()}: ${seats.length} available, center score = ${info.score}`);
        }

        if (info.score <= rush.strikeScore && seats.length >= passengerCount) {
          ETB.log(`🎯 STRIKE on ${info.option.textContent.trim()} (score ${info.score} ≤ ${rush.strikeScore}) — booking now, no further audit`);

          // Target = the scorer's own best group (already in memory, already
          // validated against the parity grid). Freshness guard re-locates
          // each button by NAME in the live DOM (cached nodes go stale after
          // an Angular re-render) — no geometry pass, no pickBestSeats.
          let targets = info.bestBtns
            .map(b => (b.title || b.textContent).trim())
            .map(findSeatByName)
            .filter(isSeatAvailable);
          if (targets.length < passengerCount) {
            // Part of the group got sniped between scan and strike → take the
            // next-best COMPLETE grid group from the pre-computed queue
            // (parity-valid: Snigdha 24-25/26-27…, never cross-block 25-26).
            const alt = (info.alts || []).find(g => g.seats.every(s => isSeatAvailable(findSeatByName((s.title || s.textContent).trim()))));
            targets = alt ? alt.seats.map(s => findSeatByName((s.title || s.textContent).trim())) : pickBestSeats(scanSeatsOnce().available, passengerCount);
          }

          let res = await clickAndVerifySeats(targets, rush.confirmTimeout, rush.clickGap, rush.fastConfirm, rush.burstClicks, rush.notifyUi);

          // Seat sniped mid-flight → retry with the NEXT-BEST GROUP from the
          // pre-computed ranked queue (same coach, same parity rules). We do
          // NOT call pickBestSeats here: its geometry pass produced the
          // cross-block 24+31 misfire when a partial selection left it
          // picking "count - confirmed" seats from scratch. Only if the whole
          // queue is exhausted do we fall back to a fresh scan.
          if (res.confirmed < passengerCount) {
            ETB.log(`Retrying on same coach with next-best group after failure${res.error ? `: ${res.error.message}` : ''}`);
            const takenNames = new Set(res.names);
            let nextGroup = null;
            for (const g of (info.alts || [])) {
              const btns = g.seats.map(s => findSeatByName((s.title || s.textContent).trim()));
              if (btns.length === passengerCount && btns.every(isSeatAvailable)) { nextGroup = btns; break; }
              if (g.seats.some(s => takenNames.has((s.title || s.textContent).trim()))) continue;
            }
            if (!nextGroup) {
              const freshSeats = scanSeatsOnce().available;
              if (freshSeats.length >= passengerCount - res.confirmed) {
                nextGroup = pickBestSeats(freshSeats, passengerCount - res.confirmed);
              }
            }
            if (nextGroup && nextGroup.length) {
              const res2 = await clickAndVerifySeats(nextGroup, rush.confirmTimeout, rush.clickGap, rush.fastConfirm, rush.burstClicks, rush.notifyUi);
              res.confirmed += res2.confirmed;
              res.names.push(...res2.names);
            }
          }

          if (res.confirmed >= passengerCount) {
            finalizeSuccess(info.option, res.names, res.confirmed);
            return;
          }
          ETB.log(`Strike attempt on ${info.option.textContent.trim()} confirmed only ${res.confirmed}/${passengerCount} — falling through`);
        }
      }

      // No strike fired, but every coach was scored during the walk above →
      // ── PHASE 2 (fast-path variant): sort cached scores ascending, book best.
      const scored = coachInfo.filter(c => Number.isFinite(c.score) && c.seats && c.seats.length >= passengerCount);
      if (scored.length) {
        scored.sort((a, b) => a.score - b.score);
        ETB.log(`No strike — booking best cached coach: ${scored.map(c => `${c.option.textContent.trim()}(score:${c.score})`).join(' → ')}`);
        for (const info of scored) {
          if (stopped) return;
          // We may already be on this coach (last walked) — skip the re-switch.
          if (coachSelect.value !== info.option.value) await switchCoachFast(info.option);
          const seats = scanSeatsOnce().available;
          if (seats.length < passengerCount) continue;
          // Reuse the cached best group if it's still fully available — but
          // re-locate every button BY NAME first (cached nodes go stale after
          // an Angular re-render); only when part of the grid queue got
          // sniped do we fall back to pickBestSeats' geometry pass.
          let targets = (info.bestBtns || [])
            .map(b => (b.title || b.textContent).trim())
            .map(findSeatByName)
            .filter(isSeatAvailable);
          if (targets.length < passengerCount) {
            const alt = (info.alts || []).find(g => g.seats.every(s => isSeatAvailable(findSeatByName((s.title || s.textContent).trim()))));
            targets = alt ? alt.seats.map(s => findSeatByName((s.title || s.textContent).trim())) : pickBestSeats(seats, passengerCount);
          }
          const res = await clickAndVerifySeats(targets, rush.confirmTimeout, rush.clickGap, rush.fastConfirm, rush.burstClicks, rush.notifyUi);
          if (res.confirmed >= passengerCount) {
            finalizeSuccess(info.option, res.names, res.confirmed);
            return;
          }
          ETB.log(`Only got ${res.confirmed}/${passengerCount} in coach ${info.option.textContent.trim()}`);
        }
      }
    } else {
      // ── LEGACY FULL-AUDIT MODE (rushMode=false): unchanged original flow ──
      for (const info of coachInfo) {
        await switchCoachLegacy(info.option);
        const seats = findAvailableSeats();
        const totalRendered = countRenderedSeats();
        const scored = scoreCoachByCenter(seats, totalRendered);
        info.score = scored.score;
        info.bestBtns = scored.seats;
        info.seats = seats;
        ETB.log(`Coach ${info.option.textContent.trim()}: ${seats.length} available, center score = ${info.score}`);
      }

      // Sort coaches ascending by center score (closest-to-center first), NOT by seat count
      coachInfo.sort((a, b) => a.score - b.score);

      ETB.log(`Coach priority (closest to center first): ${coachInfo.map(c => `${c.option.textContent.trim()}(score:${c.score})`).join(' → ')}`);

      // Try each coach until we find enough seats
      for (const { option, bestBtns, seats } of coachInfo) {
        if (seats.length < passengerCount) continue;

        // Pick best seats from this coach — reuse the audit's cached group
        // when it survived, otherwise re-pick against the fresh DOM.
        await switchCoachLegacy(option);
        const availableSeats = findAvailableSeats();
        let seatsToClick = (bestBtns || []).filter(s => document.contains(s) && s.classList.contains('seat-available'));
        if (seatsToClick.length < passengerCount) seatsToClick = pickBestSeats(availableSeats, passengerCount);
        const res = await clickAndVerifySeats(seatsToClick, 10000, 300, false, false, true);

        if (res.confirmed >= passengerCount) {
          finalizeSuccess(option, res.names, res.confirmed);
          return;
        }

        ETB.log(`Only got ${res.confirmed}/${passengerCount} in coach ${option.textContent.trim()}`);
      }
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
