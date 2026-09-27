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

  // ─── Class Fallback State ─────────────────────────────────────────────
  let currentClassIndex = 0;
  let hasTriedAllClasses = false;

  function getClassPriority() {
    return preferences?.classPriority || (preferences?.seatClass ? [preferences.seatClass] : []);
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

  // ─── Step 3: Train Selection ─────────────────────────────────────────
  async function handleTrainSelection() {
    ETB.showProgress(2, TOTAL_STEPS, 'Selecting train...');

    if (document.querySelector(SEL.seatLayoutContainer)) {
      return;
    }

    // Retry limit check
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
    const preferredTrains = preferences?.preferredTrains || [];

    // ── Find train card ──
    let selectedTrainCard = null;

    if (preferredTrains.length > 0) {
      // Try each preferred train in priority order
      for (const preferred of preferredTrains) {
        selectedTrainCard = trainCards.find(card => {
          const title = card.querySelector(SEL.trainName);
          return title && normalize(title.textContent).includes(normalize(preferred.name));
        });
        if (selectedTrainCard) {
          ETB.log(`✅ Found preferred train: ${preferred.name}`);
          break;
        } else {
          ETB.log(`❌ Preferred train "${preferred.name}" not found in search results`);
        }
      }

      if (!selectedTrainCard) {
        // NONE of the preferred trains are on this route — DO NOT fallback silently
      incrementRetry();
        ETB.log(`None of the preferred trains found on this route (attempt ${retryCount}/${MAX_RETRIES})`);
        ETB.showNotification(
          `⚠️ None of your preferred trains run on this route. Attempt ${retryCount}/${MAX_RETRIES}.`,
          'warning', 10000
        );
        if (retryCount >= MAX_RETRIES) {
          ETB.updateBookingStatus(2, 'Preferred trains not available on this route');
        }
        return;
      }
    } else {
      // No preferred trains — use first available
      selectedTrainCard = trainCards[0];
      const trainName = selectedTrainCard.querySelector(SEL.trainName)?.textContent.trim() || 'Unknown';
      ETB.log(`No preferred trains set, using first available: ${trainName}`);
    }

    // ── Find bookable class with enough seats ──
    const seatClassCards = Array.from(selectedTrainCard.querySelectorAll(SEL.seatClassCard));
    const classPriority = getClassPriority();

    for (let i = 0; i < classPriority.length; i++) {
      const targetClass = classPriority[i];
      const targetClassDisplay = CLASS_DISPLAY[targetClass] || targetClass;

      // Find the matching class card
      const classCard = seatClassCards.find(card => {
        const nameEl = card.querySelector(SEL.seatClassName);
        if (!nameEl) return false;
        const cardText = nameEl.textContent.trim().toUpperCase().replace(/[\s_-]+/g, '');
        const matchId = targetClass.toUpperCase().replace(/[\s_-]+/g, '');
        const matchDisplay = targetClassDisplay.toUpperCase().replace(/[\s_-]+/g, '');
        return cardText.includes(matchId) || cardText.includes(matchDisplay) || matchId.includes(cardText);
      });

      if (!classCard) {
        ETB.log(`Class ${targetClass}: not found on this train, skipping`);
        continue;
      }

      // Parse available seat count from the card text
      // Card text format: "SNIGDHA\n৳788\nIncluding VAT\nAvailable Tickets\n(Counter + Online)\n0"
      const cardText = classCard.innerText || '';
      let availableCount = 0;
      const onlineMatch = cardText.match(/Online\)[\s\n]*(\d+)/i);
      if (onlineMatch) {
        availableCount = parseInt(onlineMatch[1]);
      } else {
        // Fallback: last standalone number in the text
        const allNums = cardText.match(/\b(\d+)\b/g);
        if (allNums && allNums.length > 0) {
          availableCount = parseInt(allNums[allNums.length - 1]);
        }
      }

      if (availableCount < passengerCount) {
        ETB.log(`Class ${targetClass}: only ${availableCount} available, need ${passengerCount}, skipping`);
        continue;
      }

      // Check for no-seat-available markers
      if (classCard.classList.contains('no-seat-available-wrap') || classCard.querySelector('.no-seat-available-wrap')) {
        ETB.log(`Class ${targetClass}: marked as no-seat-available, skipping`);
        continue;
      }

      const bookBtn = classCard.querySelector(SEL.bookNowButton);
      if (!bookBtn || !ETB.isVisible(bookBtn) || bookBtn.disabled) {
        ETB.log(`Class ${targetClass}: no active BOOK NOW button, skipping`);
        continue;
      }

      // ✅ Found a bookable class with enough seats
      currentClassIndex = i;
      ETB.log(`✅ Class ${targetClass} (${targetClassDisplay}): ${availableCount} available, need ${passengerCount} — booking`);
      ETB.showNotification(`Booking ${targetClassDisplay} (${availableCount} available)...`, 'info');

      // Expand the train card
      const trainNameEl = selectedTrainCard.querySelector(SEL.trainName);
      if (trainNameEl) {
        trainNameEl.scrollIntoView({ behavior: 'auto', block: 'center' });
        trainNameEl.click();
        await ETB.sleep(800);
      }

      // Click BOOK NOW
      bookBtn.scrollIntoView({ behavior: 'auto', block: 'center' });
      bookBtn.click();
      ETB.log(`Clicked BOOK NOW for ${targetClass} (native click)`);

      // Wait for seat layout
      try {
        await waitFor(
          () => selectedTrainCard.querySelector(SEL.seatLayoutContainer) || document.querySelector(SEL.seatLayoutContainer),
          10000,
          'seat layout to open'
        );
        ETB.log('Seat layout appeared');
      } catch (e) {
        ETB.log('Seat layout did not appear, trying next class...');
        continue;
      }
      // Directly proceed to seat selection
      lastDetectedPage = 'seat-selection';
      await handleSeatSelection();
      return;
    }

    // None of the priority classes had enough seats
    incrementRetry();
    ETB.log(`No bookable class found with ${passengerCount} seat(s) (attempt ${retryCount}/${MAX_RETRIES})`);

    if (retryCount < MAX_RETRIES) {
      ETB.showNotification(`⚠️ Not enough seats. Retrying (${retryCount}/${MAX_RETRIES})...`, 'warning', 5000);
      // Reload search page to try again
      await ETB.sleep(3000);
      window.location.reload();
    } else {
      ETB.showNotification(`⛔ Stopped: no class has ${passengerCount} available seats after ${MAX_RETRIES} attempts.`, 'error', 15000);
      ETB.updateBookingStatus(2, `No ${passengerCount} seats after ${MAX_RETRIES} retries`);
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

    // Sort coaches by available seat count (highest first)
    const coachInfo = options.map(opt => {
      const match = opt.textContent.match(/-\s*(\d+)\s*Seat/i);
      return { option: opt, count: match ? parseInt(match[1]) : 0 };
    }).sort((a, b) => b.count - a.count);

    ETB.log(`Coach priority (most seats first): ${coachInfo.map(c => `${c.option.textContent.trim()}(${c.count})`).join(' → ')}`);

    // Try each coach until we find enough seats
    for (const { option, count } of coachInfo) {
      if (count < passengerCount) {
        ETB.log(`Skipping ${option.textContent.trim()}: ${count} seats < ${passengerCount} needed`);
        continue;
      }

      // Skip XTR/Extra coaches unless allowed
      const label = option.textContent.toUpperCase();
      if (/\bXTR|EXTRA\b/.test(label)) continue;

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

      const availableSeats = findAvailableSeats();
      ETB.log(`Coach ${option.textContent.trim()}: ${availableSeats.length} available seats`);

      if (availableSeats.length < passengerCount) continue;

      // Pick best seats from this coach
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

    // No coach had enough seats — try next class (with retry limit)
    if (!hasTriedAllClasses && retryCount < MAX_RETRIES) {
      incrementRetry();
      ETB.log(`Seat selection failed, retrying (${retryCount}/${MAX_RETRIES})`);
      const fallbackOk = await tryNextClass();
      if (fallbackOk) return;
    }

    if (retryCount >= MAX_RETRIES) {
      ETB.showNotification(`⛔ Stopped after ${MAX_RETRIES} attempts. Select manually.`, 'error', 15000);
    } else {
      ETB.showNotification('⚠️ Could not find enough seats. Please select manually.', 'warning', 10000);
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

    const allInfo = allSeatBtns.map(seatInfo);
    const availInfo = availableSeats.map(seatInfo);
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

    // ── Identify pairs within each row ──
    // A row typically has 4 seats: [window, aisle | aisle, window]
    // Split at the largest X gap (the aisle)
    function getPairs(row) {
      if (row.length < 2) return [];
      const pairs = [];

      // Find the aisle gap (largest X distance between consecutive seats)
      let maxGap = 0, aisleIdx = 0;
      for (let i = 0; i < row.length - 1; i++) {
        const gap = row[i + 1].x - row[i].x;
        if (gap > maxGap) { maxGap = gap; aisleIdx = i; }
      }

      // Left side pairs (indices 0..aisleIdx)
      const leftSide = row.slice(0, aisleIdx + 1);
      for (let i = 0; i < leftSide.length - 1; i += 2) {
        pairs.push([leftSide[i], leftSide[i + 1]]);
      }

      // Right side pairs (indices aisleIdx+1..end)
      const rightSide = row.slice(aisleIdx + 1);
      for (let i = 0; i < rightSide.length - 1; i += 2) {
        pairs.push([rightSide[i], rightSide[i + 1]]);
      }

      return pairs;
    }

    // ── Calculate center Y of all rows ──
    const allY = rows.map(r => r[0].y);
    const minY = Math.min(...allY);
    const maxY = Math.max(...allY);
    const centerY = (minY + maxY) / 2;

    // Score: lower = better (closer to center)
    function centerScore(y) { return Math.abs(y - centerY); }

    // ── For count === 1 ──
    if (count === 1) {
      // Pick the available seat closest to center
      availInfo.sort((a, b) => centerScore(a.y) - centerScore(b.y));
      return [availInfo[0].btn];
    }

    // ── For count === 2: find best adjacent pair ──
    if (count === 2) {
      let bestPair = null;
      let bestScore = Infinity;

      for (const row of rows) {
        const pairs = getPairs(row);
        for (const pair of pairs) {
          // Both seats in the pair must be available
          if (pair.every(s => availSet.has(s.btn))) {
            const score = centerScore(pair[0].y);
            if (score < bestScore) {
              bestScore = score;
              bestPair = pair;
            }
          }
        }
      }

      if (bestPair) {
        ETB.log(`Picked pair: ${bestPair.map(s => s.name).join(', ')} (center distance: ${bestScore.toFixed(0)}px)`);
        return bestPair.map(s => s.btn);
      }

      // Fallback: no complete pair available — pick 2 closest seats on same row
      ETB.log('No complete adjacent pair found, falling back to closest same-row seats');
      for (const row of [...rows].sort((a, b) => centerScore(a[0].y) - centerScore(b[0].y))) {
        const avail = row.filter(s => availSet.has(s.btn));
        if (avail.length >= 2) {
          // Pick the 2 that are closest to each other
          avail.sort((a, b) => a.x - b.x);
          let bestI = 0, bestDist = Infinity;
          for (let i = 0; i < avail.length - 1; i++) {
            const d = avail[i + 1].x - avail[i].x;
            if (d < bestDist) { bestDist = d; bestI = i; }
          }
          return [avail[bestI].btn, avail[bestI + 1].btn];
        }
      }

      // Last resort: 2 closest to center
      availInfo.sort((a, b) => centerScore(a.y) - centerScore(b.y));
      return availInfo.slice(0, 2).map(s => s.btn);
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
          // Score: center distance of the cluster's middle row
          const clusterMidY = (clusterRows[0][0].y + clusterRows[clusterRows.length - 1][0].y) / 2;
          const score = Math.abs(clusterMidY - centerY) + span * 5; // penalize more rows

          if (score < bestClusterScore) {
            bestClusterScore = score;
            // Pick seats: prefer complete pairs, center rows first
            const picked = [];
            const sortedCluster = [...clusterRows].sort((a, b) => centerScore(a[0].y) - centerScore(b[0].y));

            for (const row of sortedCluster) {
              if (picked.length >= count) break;
              const pairs = getPairs(row);
              // Add complete available pairs first
              for (const pair of pairs) {
                if (picked.length >= count) break;
                if (pair.every(s => availSet.has(s.btn))) {
                  pair.forEach(s => { if (picked.length < count && !picked.includes(s)) picked.push(s); });
                }
              }
              // Then fill with remaining available singles
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

    // Fallback: closest to center
    availInfo.sort((a, b) => centerScore(a.y) - centerScore(b.y));
    return availInfo.slice(0, count).map(s => s.btn);
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
