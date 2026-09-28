/**
 * E-Dalal - Rail Ticket Booking Agent - Shohoz Train Content Script
 * Runs on: https://*.shohoz.com/*
 * 
 * Only activates on train-related pages.
 * Automates the booking flow:
 *   1. Search (auto-fill journey details)
 *   2. Select Train (pick available train)
 *   3. Select Seat (pick available seats)
 *   4. Fill Passenger Details
 *   5. Payment Gate (HUMAN-IN-THE-LOOP)
 *
 * Depends on: utils.js (ETB namespace), human-in-the-loop.js
 */
(function () {
  'use strict';

  // ─── Train-only guard ────────────────────────────────────────────────
  const url = window.location.href.toLowerCase();
  const isTrainPage = url.includes('/train') || url.includes('rail') ||
                      url.includes('eticket') || document.title.toLowerCase().includes('train');

  // If on shohoz.com but NOT a train page, exit early
  if (url.includes('shohoz.com') && !isTrainPage) {
    // Check after a delay in case of SPA routing
    setTimeout(() => {
      const bodyText = document.body?.innerText?.toLowerCase() || '';
      if (!bodyText.includes('train') && !window.location.href.includes('/train')) {
        ETB.log('Not a train page on Shohoz. Exiting.');
        return;
      }
    }, 2000);
    return;
  }

  // ─── Config ──────────────────────────────────────────────────────────
  const SITE_NAME = 'Shohoz Train';
  const TOTAL_STEPS = 5;
  let profile = null;
  let preferences = null;
  let isAutomating = false;

  // ─── Flexible Selectors ──────────────────────────────────────────────
  const SEL = {
    // Search
    fromStation: 'input[placeholder*="From" i], input[name*="from" i], input[aria-label*="From" i], input[placeholder*="departure" i]',
    toStation: 'input[placeholder*="To" i], input[name*="to" i], input[aria-label*="To" i], input[placeholder*="destination" i]',
    dateInput: 'input[type="date"], input[name*="date" i], input[placeholder*="Date" i]',
    classSelect: 'select[name*="class" i], [class*="class-select"], select[aria-label*="Class" i]',
    searchButton: 'button[type="submit"], button:has-text("Search")',

    // Results
    trainCard: '[class*="trip"], [class*="train"], [class*="result-card"]',
    bookButton: 'button:has-text("Book Now"), button:has-text("BOOK NOW"), button:has-text("Select"), a:has-text("Book")',
    availableTag: '[class*="available"], .badge-success, [class*="seat-count"]',

    // Seat selection
    coachTab: '[class*="coach"], [class*="bogie"], button[class*="tab"]',
    seatAvailable: '.seat.available, [class*="seat"][class*="available"], [class*="seat-available"]',
    seatSelected: '.seat.selected, [class*="seat"][class*="selected"]',
    continueBtn: 'button:has-text("Continue"), button:has-text("Proceed"), button:has-text("Next")',

    // Passenger form
    passengerName: 'input[name*="name" i], input[placeholder*="Name" i]',
    passengerNid: 'input[name*="nid" i], input[name*="id_number" i], input[placeholder*="NID" i]',
    passengerMobile: 'input[name*="mobile" i], input[name*="phone" i], input[placeholder*="Mobile" i]',
    passengerEmail: 'input[name*="email" i], input[type="email"]',

    // Payment
    paymentSection: '[class*="payment"], [class*="checkout"]',
    totalPrice: '[class*="total"], [class*="price"], [class*="fare"], [class*="amount"]'
  };

  // ─── Initialization ──────────────────────────────────────────────────
  async function init() {
    ETB.log(`${SITE_NAME} content script initializing...`);

    [profile, preferences] = await Promise.all([
      ETB.getProfile(),
      ETB.getPreferences()
    ]);

    if (!profile) {
      ETB.showNotification('Set up your profile in the E-Dalal - Rail Ticket Booking Agent popup.', 'warning', 6000);
      ETB.showStatusBadge('ETB: No Profile', false);
      return;
    }

    ETB.showStatusBadge('ETB: Active (Shohoz)', true);

    if (!preferences?.autoBook) {
      ETB.log('Auto-booking disabled');
      ETB.showStatusBadge('ETB: Manual Mode', false);
      return;
    }

    await ETB.sleep(1500);
    detectAndAutomate();
    observePageChanges();

    // Listen for monitoring messages
    ETB.onMessage((msg, sender, sendResponse) => {
      if (msg.type === 'CHECK_AVAILABILITY') {
        checkSeatAvailability();
        sendResponse({ received: true });
      }
    });
  }

  // ─── Page Detection ──────────────────────────────────────────────────
  function detectCurrentPage() {
    const path = window.location.pathname.toLowerCase();
    const body = document.body.innerText.toLowerCase();

    // Payment page
    if (path.includes('payment') || path.includes('checkout') ||
        body.includes('payment method') || document.querySelector(SEL.paymentSection)) {
      return 'payment';
    }

    // Passenger details
    if (document.querySelector(SEL.passengerName) &&
        (body.includes('passenger') || body.includes('contact info') || path.includes('booking'))) {
      // Check it's not just the search page with similar inputs
      const nameInputs = document.querySelectorAll(SEL.passengerName);
      if (nameInputs.length > 0 && body.includes('nid')) {
        return 'passenger-details';
      }
    }

    // Seat selection
    if (document.querySelector(SEL.seatAvailable) || 
        document.querySelector(SEL.coachTab) ||
        body.includes('select seat') || body.includes('choose seat')) {
      return 'seat-selection';
    }

    // Search results
    const bookBtns = findButtonsByText('book now').concat(findButtonsByText('select'));
    if (bookBtns.length > 0 && (path.includes('search') || body.includes('departure'))) {
      return 'train-results';
    }

    // Search page
    if (document.querySelector(SEL.fromStation) ||
        path.includes('train-ticket') || path.includes('train')) {
      return 'search';
    }

    return 'unknown';
  }

  async function detectAndAutomate() {
    if (isAutomating) return;
    isAutomating = true;

    try {
      const page = detectCurrentPage();
      ETB.log(`Detected page: ${page}`);

      switch (page) {
        case 'search':
          await handleSearch();
          break;
        case 'train-results':
          await handleTrainSelection();
          break;
        case 'seat-selection':
          await handleSeatSelection();
          break;
        case 'passenger-details':
          await handlePassengerDetails();
          break;
        case 'payment':
          await handlePayment();
          break;
        default:
          ETB.log('Page not recognized on Shohoz.');
      }
    } catch (err) {
      ETB.error('Automation error:', err.message);
      ETB.showNotification(`Error: ${err.message}`, 'error', 6000);
      ETB.updateBookingStatus('error', err.message);
    } finally {
      isAutomating = false;
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
    return classes[currentClassIndex] || classes[0] || '';
  }

  const CLASS_DISPLAY = {
    'SNIGDHA': 'Snigdha', 'AC_S': 'AC Seat', 'AC_B': 'AC Berth',
    'SHOVAN': 'Shovan', 'SHOVAN_CHAIR': 'Shovan Chair',
    'F_SEAT': 'First Seat', 'F_BERTH': 'First Berth', 'F_CHAIR': 'First Chair'
  };

  async function tryNextClass() {
    const classes = getClassPriority();
    if (classes.length <= 1 || currentClassIndex >= classes.length - 1) {
      hasTriedAllClasses = true;
      return false;
    }
    currentClassIndex++;
    const nextClass = classes[currentClassIndex];
    ETB.log(`⬇️ Falling back to class ${currentClassIndex + 1}/${classes.length}: ${CLASS_DISPLAY[nextClass] || nextClass}`);
    ETB.showNotification(`⬇️ Trying ${CLASS_DISPLAY[nextClass] || nextClass}...`, 'warning', 5000);
    await ETB.sleep(1000);
    const backBtn = findButtonByText('back') || findButtonByText('modify') ||
                    findButtonByText('change') || findButtonByText('search again');
    if (backBtn) {
      ETB.simulateClick(backBtn);
      await ETB.sleep(2000);
    } else {
      window.history.back();
      await ETB.sleep(2000);
    }
    isAutomating = false;
    await handleSearch();
    return true;
  }

  // ─── Step 1: Search ──────────────────────────────────────────────────
  async function handleSearch() {
    if (!preferences?.from || !preferences?.to) {
      ETB.showNotification('Set journey preferences in the extension popup first.', 'warning');
      return;
    }

    ETB.showProgress(1, TOTAL_STEPS, `Searching${getCurrentClass() ? ' (' + (CLASS_DISPLAY[getCurrentClass()] || getCurrentClass()) + ')' : ''}...`);
    ETB.showNotification('Auto-filling search form...', 'info');

    await ETB.sleep(800);

    // From station
    const fromInput = document.querySelector(SEL.fromStation);
    if (fromInput) {
      ETB.reactInputHack(fromInput, preferences.from);
      ETB.simulateClick(fromInput);
      await ETB.sleep(600);
      await selectDropdownOption(preferences.from);
      await ETB.sleep(400);
    }

    // To station
    const toInput = document.querySelector(SEL.toStation);
    if (toInput) {
      ETB.reactInputHack(toInput, preferences.to);
      ETB.simulateClick(toInput);
      await ETB.sleep(600);
      await selectDropdownOption(preferences.to);
      await ETB.sleep(400);
    }

    // Date
    if (preferences.date) {
      const dateInput = document.querySelector(SEL.dateInput);
      if (dateInput) {
        ETB.reactInputHack(dateInput, preferences.date);
        await ETB.sleep(300);
      }
    }

    // Class (from priority list)
    const targetClass = getCurrentClass();
    if (targetClass) {
      const classSelect = document.querySelector(SEL.classSelect);
      if (classSelect) {
        ETB.simulateSelect(classSelect, targetClass);
        ETB.log(`Selected class: ${CLASS_DISPLAY[targetClass] || targetClass} (priority ${currentClassIndex + 1}/${getClassPriority().length})`);
        await ETB.sleep(300);
      } else {
        const classBtn = findButtonByText(targetClass.replace(/_/g, ' '));
        if (classBtn) ETB.simulateClick(classBtn);
      }
    }

    await ETB.sleep(500);

    // Search
    const searchBtn = findButtonByText('search') || 
                      document.querySelector('button[type="submit"]');
    if (searchBtn) {
      ETB.simulateClick(searchBtn);
      ETB.showNotification(`Searching${targetClass ? ' in ' + (CLASS_DISPLAY[targetClass] || targetClass) : ''}...`, 'info');
    }
  }

  // ─── Step 2: Train Selection ─────────────────────────────────────────
  async function handleTrainSelection() {
    ETB.showProgress(2, TOTAL_STEPS, 'Selecting train...');

    await ETB.sleep(1000);

    const bookBtns = findButtonsByText('book now').concat(findButtonsByText('select'));

    if (bookBtns.length === 0) {
      // Try class fallback before giving up
      const classes = getClassPriority();
      if (classes.length > 1 && !hasTriedAllClasses) {
        const fallbackOk = await tryNextClass();
        if (fallbackOk) return;
      }

      ETB.showNotification('No available trains on Shohoz.', 'warning');
      return;
    }

    // Check if user has preferred trains
    const preferredTrains = preferences?.preferredTrains || [];

    if (preferredTrains.length > 0) {
      ETB.log(`Preferred trains: ${preferredTrains.map(t => t.name).join(', ')}`);

      // Try each preferred train in priority order
      for (const preferred of preferredTrains) {
        const matchedBtn = findTrainBookButton(preferred.name, bookBtns);
        if (matchedBtn) {
          ETB.log(`✅ Found preferred train: ${preferred.name} (dep: ${preferred.departure})`);
          ETB.showNotification(`🎯 Found preferred train: ${preferred.name}! Booking...`, 'success');
          await ETB.sleep(300);
          ETB.simulateClick(matchedBtn);
          ETB.log('Clicked book/select for preferred train');
          return;
        }
      }

      // No preferred trains matched
      ETB.showNotification(
        `⚠️ None of your preferred trains are available. Booking first available instead.`,
        'warning'
      );
      ETB.log('No preferred trains matched, falling back to first available');
    }

    const currentClass = getCurrentClass();
    ETB.showNotification(
      `Found ${bookBtns.length} train(s)${currentClass ? ' in ' + (CLASS_DISPLAY[currentClass] || currentClass) : ''}. Selecting...`,
      'success'
    );
    await ETB.sleep(300);
    ETB.simulateClick(bookBtns[0]);
    ETB.log('Clicked book/select on first available train');
  }

  /**
   * Find the book/select button for a specific train by matching its name
   * against the text content of the train card containing the button.
   */
  function findTrainBookButton(trainName, bookButtons) {
    const searchName = trainName.toLowerCase();

    for (const btn of bookButtons) {
      // Walk up the DOM to find the train card container
      let container = btn.parentElement;
      let depth = 0;

      while (container && depth < 8) {
        const text = container.textContent.toLowerCase();
        if (text.includes(searchName)) {
          return btn;
        }
        container = container.parentElement;
        depth++;
      }
    }

    return null;
  }

  // ─── Step 3: Smart Seat Selection ──────────────────────────────────
  async function handleSeatSelection() {
    ETB.showProgress(3, TOTAL_STEPS, 'Selecting seats...');

    if (!preferences?.autoSeat) {
      ETB.showNotification('Auto-seat disabled. Select seats manually.', 'info');
      return;
    }

    await ETB.sleep(1500);

    // Select coach with most available seats
    const coaches = document.querySelectorAll(SEL.coachTab);
    if (coaches.length > 0) {
      let bestCoach = null;
      let bestCount = 0;

      for (const coach of coaches) {
        const text = coach.textContent.toLowerCase();
        if (coach.disabled || text.includes('full')) continue;
        const countMatch = text.match(/(\d+)\s*(?:available|seat|আসন)/i);
        const count = countMatch ? parseInt(countMatch[1]) : 1;
        if (count > bestCount) { bestCount = count; bestCoach = coach; }
      }

      if (!bestCoach) {
        bestCoach = Array.from(coaches).find(c => !c.disabled && !c.textContent.toLowerCase().includes('full'));
      }

      if (bestCoach) {
        ETB.simulateClick(bestCoach);
        ETB.log('Selected coach:', bestCoach.textContent.trim());
        await ETB.sleep(2000);
      }
    }

    // Select seats smartly
    const passengerCount = preferences?.passengerCount || 1;
    await ETB.sleep(1000);

    let availableSeats = findAvailableSeats();

    if (availableSeats.length === 0 || availableSeats.length < passengerCount) {
      const classes = getClassPriority();
      if (classes.length > 1 && !hasTriedAllClasses) {
        ETB.log(`Not enough seats (${availableSeats.length}/${passengerCount}) in ${CLASS_DISPLAY[getCurrentClass()] || getCurrentClass()}`);
        const fallbackOk = await tryNextClass();
        if (fallbackOk) return;
      }

      if (availableSeats.length === 0) {
        ETB.showNotification('No seats found. Select manually.', 'warning');
        ETB.updateBookingStatus(3, 'Waiting for manual seat selection...');
        await waitForManualSeatSelection(passengerCount);
        return;
      }
    }

    const seatsToClick = pickBestSeats(availableSeats, passengerCount);

    // Check adjacency
    if (passengerCount > 1 && seatsToClick.length >= 2) {
      const rects = seatsToClick.map(s => s.getBoundingClientRect());
      const ySpread = Math.max(...rects.map(r => r.top)) - Math.min(...rects.map(r => r.top));
      if (ySpread > 40) {
        const classes = getClassPriority();
        if (classes.length > 1 && !hasTriedAllClasses) {
          const fallbackOk = await tryNextClass();
          if (fallbackOk) return;
        }
        ETB.showNotification('⚠️ Adjacent seats not available. Selecting best available.', 'warning');
      }
    }

    // ── Click seats and VERIFY each one ──
    let confirmedCount = 0;
    for (let i = 0; i < seatsToClick.length; i++) {
      const seat = seatsToClick[i];
      const label = getSeatLabel(seat);
      const selected = await clickAndVerifySeat(seat);
      if (selected) {
        confirmedCount++;
        ETB.log(`✅ Seat ${i + 1} confirmed: ${label}`);
      } else {
        ETB.log(`❌ Seat ${label} click did not register`);
      }
      await ETB.sleep(300);
    }

    // Double-check selected count on the page
    await ETB.sleep(500);
    const selectedOnPage = countSelectedSeats();
    ETB.log(`Confirmed ${confirmedCount}, page reports ${selectedOnPage} selected seat(s)`);

    if (selectedOnPage < passengerCount) {
      ETB.showNotification(
        selectedOnPage === 0
          ? '⚠️ Seats could not be auto-selected. Please select seats manually.'
          : `⚠️ Only ${selectedOnPage}/${passengerCount} selected. Select remaining manually.`,
        'warning', 10000
      );
      ETB.updateBookingStatus(3, 'Waiting for manual seat selection...');
      await waitForManualSeatSelection(passengerCount);
      return;
    }

    const currentClass = getCurrentClass();
    const classLabel = CLASS_DISPLAY[currentClass] || currentClass;
    const allSelectedLabels = getSelectedSeatLabels();
    ETB.showNotification(
      `✅ ${selectedOnPage} seat(s) selected${classLabel ? ' (' + classLabel + ')' : ''}: ${allSelectedLabels.join(', ') || 'confirmed'}`,
      'success'
    );
    ETB.updateBookingStatus(3, `Seats: ${allSelectedLabels.join(', ') || selectedOnPage + ' seats'}${classLabel ? ' [' + classLabel + ']' : ''}`);

    await ETB.sleep(1000);
    const continueBtn = findButtonByText('continue') || findButtonByText('proceed') ||
                        findButtonByText('next') || document.querySelector('button[type="submit"]');
    if (continueBtn) {
      ETB.simulateClick(continueBtn);
      ETB.log('Clicked continue after verified seat selection');
    }
  }

  async function clickAndVerifySeat(seatEl) {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt === 0) {
        ETB.simulateClick(seatEl);
      } else if (attempt === 1) {
        seatEl.focus();
        seatEl.click();
      } else {
        seatEl.scrollIntoView({ behavior: 'smooth', block: 'center' });
        await ETB.sleep(200);
        const rect = seatEl.getBoundingClientRect();
        const x = rect.left + rect.width / 2;
        const y = rect.top + rect.height / 2;
        const opts = { bubbles: true, cancelable: true, view: window, clientX: x, clientY: y };
        seatEl.dispatchEvent(new PointerEvent('pointerdown', opts));
        seatEl.dispatchEvent(new MouseEvent('mousedown', opts));
        seatEl.dispatchEvent(new PointerEvent('pointerup', opts));
        seatEl.dispatchEvent(new MouseEvent('mouseup', opts));
        seatEl.dispatchEvent(new MouseEvent('click', opts));
      }
      await ETB.sleep(500);
      if (isSeatSelected(seatEl)) return true;
      ETB.log(`Seat click attempt ${attempt + 1} did not register, retrying...`);
    }
    return false;
  }

  function isSeatSelected(seatEl) {
    const cl = seatEl.classList.toString().toLowerCase();
    const parentCl = seatEl.parentElement?.classList?.toString()?.toLowerCase() || '';
    if (cl.includes('selected') || cl.includes('active') || cl.includes('chosen') || cl.includes('picked')) return true;
    if (parentCl.includes('selected') || parentCl.includes('active')) return true;
    const style = window.getComputedStyle(seatEl);
    const bg = style.backgroundColor;
    if (bg.includes('33, 150, 243') || bg.includes('255, 152, 0') ||
        bg.includes('76, 175, 80') || bg.includes('0, 123, 255') || bg.includes('25, 118, 210')) return true;
    if (seatEl.getAttribute('aria-selected') === 'true' || seatEl.getAttribute('aria-checked') === 'true') return true;
    return false;
  }

  function countSelectedSeats() {
    const sels = ['.seat.selected', '[class*="seat"][class*="selected"]', '[class*="seat"][class*="active"]', '[aria-selected="true"]'];
    const all = new Set();
    for (const s of sels) document.querySelectorAll(s).forEach(el => all.add(el));
    return all.size;
  }

  function getSelectedSeatLabels() {
    const sels = ['.seat.selected', '[class*="seat"][class*="selected"]', '[class*="seat"][class*="active"]'];
    const all = new Set();
    for (const s of sels) document.querySelectorAll(s).forEach(el => all.add(el));
    return Array.from(all).map(el => getSeatLabel(el)).filter(Boolean);
  }

  function findAvailableSeats() {
    let seats = Array.from(document.querySelectorAll(SEL.seatAvailable));
    if (seats.length > 0) return seats;
    const allSeatEls = document.querySelectorAll('[class*="seat"], [class*="berth"], [data-seat], [data-seat-number]');
    seats = Array.from(allSeatEls).filter(s => {
      const cl = s.classList.toString().toLowerCase();
      const style = window.getComputedStyle(s);
      const bg = style.backgroundColor;
      const rect = s.getBoundingClientRect();
      if (rect.width > 80 || rect.height > 80 || rect.width < 10) return false;
      if (cl.includes('booked') || cl.includes('sold') || cl.includes('disabled') ||
          cl.includes('selected') || cl.includes('reserved') || cl.includes('blocked')) return false;
      if (s.disabled || style.pointerEvents === 'none') return false;
      if (cl.includes('available') || cl.includes('free') || cl.includes('green')) return true;
      if (bg.includes('0, 128') || bg.includes('46, 204') || bg.includes('76, 175, 80')) return true;
      if (style.cursor === 'pointer' && rect.width > 15 && rect.height > 15 && ETB.isVisible(s)) return true;
      return false;
    });
    return seats;
  }

  async function waitForManualSeatSelection(requiredCount) {
    ETB.showNotification('⏳ Waiting for you to select seats manually...', 'info', 15000);
    for (let i = 0; i < 60; i++) {
      await ETB.sleep(2000);
      const selectedCount = countSelectedSeats();
      if (selectedCount >= requiredCount) {
        const labels = getSelectedSeatLabels();
        ETB.showNotification(`✅ ${selectedCount} seat(s) selected! Proceeding...`, 'success');
        ETB.updateBookingStatus(3, `Seats: ${labels.join(', ') || selectedCount + ' seats'}`);
        await ETB.sleep(800);
        const continueBtn = findButtonByText('continue') || findButtonByText('proceed') ||
                            findButtonByText('next') || document.querySelector('button[type="submit"]');
        if (continueBtn) ETB.simulateClick(continueBtn);
        return;
      }
    }
    ETB.showNotification('Seat selection timed out. Please continue manually.', 'warning');
  }

  /**
   * Smart seat picking: adjacent, middle-of-coach, forward-facing.
   */
  function pickBestSeats(availableSeats, count) {
    if (availableSeats.length <= count) return availableSeats;

    const seatInfos = availableSeats.map((el, idx) => {
      const rect = el.getBoundingClientRect();
      const label = getSeatLabel(el);
      const labelMatch = label.match(/^([A-Z]?)(\d+)$/i);
      const row = labelMatch ? parseInt(labelMatch[2]) : Math.round(rect.top);
      const col = labelMatch ? (labelMatch[1] || '').charCodeAt(0) || rect.left : rect.left;
      return { el, idx, rect, label, row, col, y: rect.top, x: rect.left };
    });

    seatInfos.sort((a, b) => a.y - b.y || a.x - b.x);

    const parentEl = availableSeats[0].closest('[class*="coach"], [class*="layout"], [class*="seat-map"], .seat-container') || document.body;
    const parentRect = parentEl.getBoundingClientRect();
    const midY = parentRect.top + parentRect.height / 2;

    if (count === 1) {
      let bestSeat = seatInfos[0];
      let bestScore = -Infinity;
      for (const s of seatInfos) {
        const distFromMiddle = Math.abs(s.y - midY);
        const maxDist = parentRect.height / 2 || 300;
        let score = 100 * (1 - distFromMiddle / maxDist);
        score += (s.x < parentRect.left + parentRect.width / 2) ? 15 : 0;
        if (score > bestScore) { bestScore = score; bestSeat = s; }
      }
      return [bestSeat.el];
    }

    let bestGroup = null;
    let bestScore = -Infinity;

    // Sequential scan
    for (let i = 0; i <= seatInfos.length - count; i++) {
      const group = seatInfos.slice(i, i + count);
      const ySpread = Math.max(...group.map(s => s.y)) - Math.min(...group.map(s => s.y));
      const sameRow = ySpread < 30;
      let adjacencyGaps = 0;
      for (let j = 1; j < group.length; j++) {
        if (Math.abs(group[j].x - group[j - 1].x) > 80) adjacencyGaps++;
      }
      const avgY = group.reduce((sum, s) => sum + s.y, 0) / group.length;
      const distFromMiddle = Math.abs(avgY - midY);
      const maxDist = parentRect.height / 2 || 300;
      let score = 100 * (1 - distFromMiddle / maxDist);
      score += sameRow ? 50 : 0;
      score -= adjacencyGaps * 30;
      const avgX = group.reduce((sum, s) => sum + s.x, 0) / group.length;
      score += (avgX < parentRect.left + parentRect.width / 2) ? 15 : 0;
      if (score > bestScore) { bestScore = score; bestGroup = group; }
    }

    // Row-by-row grouping
    const rowMap = new Map();
    for (const s of seatInfos) {
      const rowKey = Math.round(s.y / 20) * 20;
      if (!rowMap.has(rowKey)) rowMap.set(rowKey, []);
      rowMap.get(rowKey).push(s);
    }
    for (const [, rowSeats] of rowMap) {
      if (rowSeats.length < count) continue;
      rowSeats.sort((a, b) => a.x - b.x);
      for (let i = 0; i <= rowSeats.length - count; i++) {
        const group = rowSeats.slice(i, i + count);
        const avgY = group.reduce((sum, s) => sum + s.y, 0) / group.length;
        const distFromMiddle = Math.abs(avgY - midY);
        const maxDist = parentRect.height / 2 || 300;
        let score = 100 * (1 - distFromMiddle / maxDist) + 60;
        const avgX = group.reduce((sum, s) => sum + s.x, 0) / group.length;
        score += (avgX < parentRect.left + parentRect.width / 2) ? 15 : 0;
        if (score > bestScore) { bestScore = score; bestGroup = group; }
      }
    }

    return bestGroup ? bestGroup.map(s => s.el) : availableSeats.slice(0, count);
  }

  function getSeatLabel(seatEl) {
    const label = seatEl.getAttribute('data-seat') ||
                  seatEl.getAttribute('data-seat-number') ||
                  seatEl.getAttribute('data-id') ||
                  seatEl.getAttribute('title') ||
                  seatEl.getAttribute('aria-label');
    if (label) return label;
    const text = seatEl.textContent.trim();
    if (text && text.length <= 6) return text;
    const child = seatEl.querySelector('[class*="number"], [class*="label"], span');
    if (child) return child.textContent.trim();
    return '';
  }

  // ─── Step 4: Passenger Details ───────────────────────────────────────
  async function handlePassengerDetails() {
    ETB.showProgress(4, TOTAL_STEPS, 'Filling passenger details...');

    if (!preferences?.autoFill) {
      ETB.showNotification('Auto-fill disabled.', 'info');
      return;
    }

    await ETB.sleep(1000);

    const nameInputs = document.querySelectorAll(SEL.passengerName);
    const nidInputs = document.querySelectorAll(SEL.passengerNid);
    const mobileInputs = document.querySelectorAll(SEL.passengerMobile);
    const emailInputs = document.querySelectorAll(SEL.passengerEmail);

    // Primary
    if (nameInputs[0] && profile.name) {
      ETB.reactInputHack(nameInputs[0], profile.name);
      await ETB.sleep(200);
    }
    if (nidInputs[0] && profile.nid) {
      ETB.reactInputHack(nidInputs[0], profile.nid);
      await ETB.sleep(200);
    }
    if (mobileInputs[0] && profile.mobile) {
      ETB.reactInputHack(mobileInputs[0], profile.mobile);
      await ETB.sleep(200);
    }
    if (emailInputs[0] && profile.email) {
      ETB.reactInputHack(emailInputs[0], profile.email);
      await ETB.sleep(200);
    }

    // Co-passengers
    const coPassengers = profile.coPassengers || [];
    for (let i = 0; i < coPassengers.length; i++) {
      const cp = coPassengers[i];
      const idx = i + 1;
      if (nameInputs[idx] && cp.name) ETB.reactInputHack(nameInputs[idx], cp.name);
      if (nidInputs[idx] && cp.nid) ETB.reactInputHack(nidInputs[idx], cp.nid);
      if (mobileInputs[idx] && cp.mobile) ETB.reactInputHack(mobileInputs[idx], cp.mobile);
      await ETB.sleep(150);
    }

    ETB.showNotification('Passenger details filled!', 'success');

    await ETB.sleep(800);
    const continueBtn = findButtonByText('continue') || findButtonByText('proceed') ||
                        findButtonByText('confirm') || document.querySelector('button[type="submit"]');
    if (continueBtn) ETB.simulateClick(continueBtn);
  }

  // ─── Step 5: Payment (HUMAN-IN-THE-LOOP) ────────────────────────────
  async function handlePayment() {
    ETB.showProgress(5, TOTAL_STEPS, 'Awaiting payment confirmation...');
    ETB.showNotification('🛑 Payment reached. Waiting for your confirmation...', 'warning', 8000);

    const summary = gatherBookingSummary();

    // Store detailed booking info for popup display
    ETB.updateBookingStatus(5, 'Awaiting payment confirmation', summary.details);

    const confirmed = await ETB.showConfirmation({
      title: '💳 Ready to Pay (Shohoz)',
      subtitle: 'Review your booking details before proceeding to payment.',
      details: summary.details,
      totalLabel: 'Total Amount',
      totalValue: summary.total || 'See payment page',
      confirmText: '✅ CONFIRM & PROCEED TO PAYMENT',
      cancelText: '❌ CANCEL'
    });

    if (confirmed) {
      ETB.updateBookingStatus('done', 'Payment confirmed — proceeding to payment', summary.details);
      ETB.log('User confirmed payment — clicking pay button');

      await ETB.sleep(300);

      // Find and click the actual payment button
      const payBtn = findButtonByText('pay') || findButtonByText('proceed to pay') ||
                     findButtonByText('confirm') || findButtonByText('complete') ||
                     findButtonByText('submit') || findButtonByText('place order') ||
                     findButtonByText('purchase') || findButtonByText('পেমেন্ট') ||
                     findButtonByText('proceed');

      const payBtnAlt = document.querySelector(
        'button[class*="pay"], button[class*="payment"], button[class*="submit"], ' +
        'a[class*="pay"], a[class*="payment"], ' +
        'button[type="submit"], input[type="submit"]'
      );

      const targetPayBtn = payBtn || payBtnAlt;

      if (targetPayBtn) {
        ETB.simulateClick(targetPayBtn);
        ETB.log('Clicked payment button:', targetPayBtn.textContent.trim());
        ETB.showNotification('✅ Proceeding to payment...', 'success', 5000);
      } else {
        // Fallback: try to submit any visible form
        const forms = document.querySelectorAll('form');
        let submitted = false;
        for (const form of forms) {
          if (ETB.isVisible(form)) {
            const submitBtn = form.querySelector('button[type="submit"], input[type="submit"], button');
            if (submitBtn) {
              ETB.simulateClick(submitBtn);
              submitted = true;
              break;
            }
          }
        }

        if (!submitted) {
          const paymentArea = document.querySelector(SEL.paymentSection) ||
                              document.querySelector('form') ||
                              document.querySelector('[class*="payment"], [class*="checkout"]');
          if (paymentArea) {
            paymentArea.style.outline = '3px solid #2ecc71';
            paymentArea.style.outlineOffset = '4px';
            paymentArea.style.borderRadius = '8px';
            paymentArea.scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
          ETB.showNotification(
            '✅ Confirmed! Please click the payment button manually.',
            'success', 10000
          );
        }
      }
    } else {
      ETB.showNotification('Payment cancelled.', 'error');
      ETB.updateBookingStatus('error', 'Cancelled by user');
    }

    ETB.hideProgress();
  }

  // ─── Monitoring ──────────────────────────────────────────────────────
  async function checkSeatAvailability() {
    ETB.log('Checking Shohoz availability...');
    
    const page = detectCurrentPage();
    if (page === 'train-results') {
      const bookBtns = findButtonsByText('book now').concat(findButtonsByText('select'));
      if (bookBtns.length > 0) {
        ETB.notifySeatsAvailable(
          `${bookBtns.length} train(s) with seats available on Shohoz!`
        );
      }
    }
  }

  // ─── Helpers ─────────────────────────────────────────────────────────
  function findButtonByText(text) {
    for (const sel of ['button', 'a', '[role="button"]', 'input[type="submit"]']) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
          if (ETB.isVisible(el) && !el.disabled) return el;
        }
      }
    }
    return null;
  }

  function findButtonsByText(text) {
    const results = [];
    for (const sel of ['button', 'a', '[role="button"]']) {
      for (const el of document.querySelectorAll(sel)) {
        if (el.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
          if (ETB.isVisible(el) && !el.disabled) results.push(el);
        }
      }
    }
    return results;
  }

  async function selectDropdownOption(text) {
    await ETB.sleep(300);
    const optionSelectors = [
      '[class*="option"]', '[role="option"]', '[class*="dropdown"] li',
      '[class*="listbox"] li', '[class*="suggestion"]', '[class*="menu"] li'
    ];
    for (const sel of optionSelectors) {
      for (const opt of document.querySelectorAll(sel)) {
        if (opt.textContent.trim().toLowerCase().includes(text.toLowerCase())) {
          ETB.simulateClick(opt);
          return true;
        }
      }
    }
    return false;
  }

  /**
   * Gather booking summary by scraping real data from the current page DOM.
   * Falls back to saved preferences only if page data is not found.
   */
  function gatherBookingSummary() {
    const details = [];
    const bodyText = document.body.innerText;

    // ── Helper: extract text near a label ──
    function extractNearLabel(labelPatterns, containerSelectors) {
      for (const pattern of labelPatterns) {
        const regex = new RegExp(pattern + '[:\\s]*([^\\n]+)', 'im');
        const match = bodyText.match(regex);
        if (match && match[1]?.trim()) return match[1].trim();
      }
      for (const sel of (containerSelectors || [])) {
        const el = document.querySelector(sel);
        if (el && el.textContent.trim()) return el.textContent.trim();
      }
      return null;
    }

    // ── Train Name / Number ──
    const trainName = extractNearLabel(
      ['Train\\s*(?:Name|No\\.?|Number)?', 'ট্রেন'],
      ['[class*="train-name"]', '[class*="trainName"]', '[class*="trip-name"]',
       'h2[class*="train"]', 'h3[class*="train"]', '.train-title', '.trip-title']
    );
    if (trainName) {
      details.push({ label: '🚂 Train', value: trainName });
    }

    // ── Route ──
    const routeFromPage = extractNearLabel(
      ['Route', 'From.*?To', 'যাত্রাপথ'],
      ['[class*="route"]', '[class*="journey-info"]', '[class*="trip-route"]']
    );
    if (routeFromPage) {
      details.push({ label: '📍 Route', value: routeFromPage });
    } else {
      const from = preferences?.from || 'N/A';
      const to = preferences?.to || 'N/A';
      details.push({ label: '📍 Route', value: `${from} → ${to}` });
    }

    // ── Date & Time ──
    const dateFromPage = extractNearLabel(
      ['Date\\s*(?:of)?\\s*Journey', 'Journey\\s*Date', 'Departure\\s*Date', 'তারিখ'],
      ['[class*="journey-date"]', '[class*="date"]', '[class*="departure-date"]']
    );
    if (dateFromPage) {
      details.push({ label: '📅 Date', value: dateFromPage });
    } else if (preferences?.date) {
      details.push({ label: '📅 Date', value: preferences.date });
    }

    const departureTime = extractNearLabel(
      ['Departure\\s*(?:Time)?', 'Departs?', 'ছাড়ার সময়'],
      ['[class*="departure"]', '[class*="depart-time"]', 'time[class*="dep"]']
    );
    if (departureTime) {
      details.push({ label: '🕐 Departure', value: departureTime });
    }

    const arrivalTime = extractNearLabel(
      ['Arrival\\s*(?:Time)?', 'Arrives?', 'পৌঁছানোর সময়'],
      ['[class*="arrival"]', '[class*="arrive-time"]', 'time[class*="arr"]']
    );
    if (arrivalTime) {
      details.push({ label: '🕐 Arrival', value: arrivalTime });
    }

    // ── Class ──
    const classFromPage = extractNearLabel(
      ['Class', 'Seat\\s*Class', 'শ্রেণী'],
      ['[class*="seat-class"]', '[class*="seatClass"]', '[class*="class-name"]']
    );
    if (classFromPage) {
      details.push({ label: '🎫 Class', value: classFromPage });
    } else if (preferences?.seatClass) {
      details.push({ label: '🎫 Class', value: preferences.seatClass.replace(/_/g, ' ') });
    }

    // ── Coach / Bogie ──
    const coach = extractNearLabel(
      ['Coach', 'Bogie', 'বগি'],
      ['[class*="coach"]', '[class*="bogie"]', '[class*="coach-name"]',
       '.selected-coach', '[class*="selectedCoach"]']
    );
    if (coach) {
      details.push({ label: '🚃 Coach', value: coach });
    }

    // ── Seat Numbers ──
    const selectedSeats = document.querySelectorAll(SEL.seatSelected);
    const seatNumbers = [];
    selectedSeats.forEach(seat => {
      const num = seat.textContent.trim() || seat.getAttribute('data-seat') ||
                  seat.getAttribute('data-seat-number') || seat.getAttribute('title');
      if (num) seatNumbers.push(num);
    });
    if (seatNumbers.length === 0) {
      const seatMatch = bodyText.match(/Seat\s*(?:No\.?|Number)?[:\s]*([A-Z]?\d+(?:\s*,\s*[A-Z]?\d+)*)/i);
      if (seatMatch) seatNumbers.push(seatMatch[1]);
    }
    if (seatNumbers.length === 0) {
      const seatLabels = document.querySelectorAll(
        '[class*="seat-number"], [class*="seatNumber"], [class*="selected-seat"], .seat-label'
      );
      seatLabels.forEach(el => {
        const t = el.textContent.trim();
        if (t && t.length < 10) seatNumbers.push(t);
      });
    }
    if (seatNumbers.length > 0) {
      details.push({ label: '💺 Seat(s)', value: seatNumbers.join(', ') });
    }

    // ── Passenger(s) ──
    const nameInputs = document.querySelectorAll(SEL.passengerName);
    const filledNames = Array.from(nameInputs)
      .map(inp => inp.value?.trim())
      .filter(Boolean);
    if (filledNames.length > 0) {
      details.push({ label: '👤 Passenger(s)', value: filledNames.join(', ') });
    } else if (profile?.name) {
      const names = [profile.name];
      (profile.coPassengers || []).forEach(cp => { if (cp.name) names.push(cp.name); });
      details.push({ label: '👤 Passenger(s)', value: names.join(', ') });
    }

    // ── Passenger Count ──
    const paxCount = filledNames.length || ((profile?.coPassengers?.length || 0) + 1);
    details.push({ label: '🔢 Total Tickets', value: `${paxCount}` });

    // ── Fare / Price ──
    let total = null;
    const priceSelectors = [
      '[class*="total"]', '[class*="price"]', '[class*="amount"]', '[class*="fare"]',
      '[class*="payable"]', '[class*="grand-total"]', '[class*="net-amount"]',
      'td:last-child', 'span[class*="tk"]', 'strong'
    ];
    for (const sel of priceSelectors) {
      const els = document.querySelectorAll(sel);
      for (const el of els) {
        const text = el.textContent.trim();
        const priceMatch = text.match(/(৳|BDT|Tk\.?)\s*[\d,]+\.?\d*/i) ||
                           text.match(/[\d,]+\.?\d*\s*(৳|BDT|Tk\.?)/i);
        if (priceMatch) {
          total = text;
          break;
        }
      }
      if (total) break;
    }
    if (!total) {
      const priceMatch = bodyText.match(/(?:Total|মোট|Amount|Payable)[:\s]*(৳|BDT|Tk\.?)\s*[\d,]+\.?\d*/i);
      if (priceMatch) total = priceMatch[0];
    }

    return { details, total };
  }

  function observePageChanges() {
    let lastUrl = location.href;
    const observer = new MutationObserver(() => {
      if (location.href !== lastUrl) {
        lastUrl = location.href;
        setTimeout(() => detectAndAutomate(), 1500);
      }
    });
    observer.observe(document.body, { childList: true, subtree: true });

    let debounce = null;
    const contentObs = new MutationObserver((mutations) => {
      const significant = mutations.some(m => {
        for (const node of m.addedNodes) {
          if (node.nodeType === 1 && (
            node.tagName === 'FORM' || node.tagName === 'BUTTON' ||
            node.querySelector?.('form, button, input')
          )) return true;
        }
        return false;
      });
      if (significant && !isAutomating) {
        clearTimeout(debounce);
        debounce = setTimeout(() => detectAndAutomate(), 2000);
      }
    });
    contentObs.observe(document.body, { childList: true, subtree: true });
  }

  // ─── Start ───────────────────────────────────────────────────────────
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
