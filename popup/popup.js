/**
 * E-Ticket Auto Booker - Popup Controller
 * Manages profile, preferences, monitoring, and status tabs.
 */
document.addEventListener('DOMContentLoaded', () => {
  // ─── Tab Navigation ──────────────────────────────────────────────────
  const tabs = document.querySelectorAll('.tab');
  const contents = document.querySelectorAll('.tab-content');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      tabs.forEach(t => t.classList.remove('active'));
      contents.forEach(c => c.classList.remove('active'));
      tab.classList.add('active');
      document.getElementById(`tab-${tab.dataset.tab}`).classList.add('active');
    });
  });

  // ─── Profile Management ──────────────────────────────────────────────
  const profileFields = {
    mobile: document.getElementById('p-mobile'),
    password: document.getElementById('p-password')
  };

  // Load profile
  sendMsg('GET_PROFILE').then(res => {
    if (res?.data) {
      profileFields.mobile.value = res.data.mobile || '';
      profileFields.password.value = res.data.password || '';
    }
  });

  // Save profile
  document.getElementById('save-profile').addEventListener('click', async () => {
    const profile = {
      mobile: profileFields.mobile.value.trim(),
      password: profileFields.password.value
    };
    const res = await sendMsg('SAVE_PROFILE', profile);
    showStatus('profile-status', res?.success ? 'Saved!' : 'Error saving', res?.success);
  });

  // ─── Preferences Management ──────────────────────────────────────────
  const CLASS_NAMES = {
    'SNIGDHA': 'Snigdha', 'AC_S': 'AC Seat', 'AC_B': 'AC Berth',
    'SHOVAN': 'Shovan', 'S_CHAIR': 'Shovan Chair', 'SHOVAN_CHAIR': 'Shovan Chair',
    'F_SEAT': 'First Seat', 'F_BERTH': 'First Berth', 'F_CHAIR': 'First Chair',
    'AC_CHAIR': 'AC Chair', 'SHULOV': 'Shulov'
  };

  const prefFields = {
    from: document.getElementById('pref-from'),
    to: document.getElementById('pref-to'),
    date: document.getElementById('pref-date'),
    passengerCount: document.getElementById('pref-count'),
    autoFill: document.getElementById('pref-autofill'),
    autoSeat: document.getElementById('pref-autoseat'),
    rushMode: document.getElementById('pref-rushmode'),
    strikeScore: document.getElementById('pref-strikescore'),
    autoBook: document.getElementById('pref-autobook')
  };

  // ─── Class Priority ────────────────────────────────────────────────
  let classPriority = [];
  const classPriorityList = document.getElementById('class-priority-list');
  const classAddSelect = document.getElementById('class-add-select');

  classAddSelect.addEventListener('change', () => {
    const val = classAddSelect.value;
    if (val && !classPriority.includes(val)) {
      classPriority.push(val);
      renderClassPriority();
    }
    classAddSelect.value = '';
  });

  function renderClassPriority() {
    classPriorityList.innerHTML = '';
    if (classPriority.length === 0) {
      classPriorityList.innerHTML = '<div class="class-empty">No class selected — will use site default</div>';
      return;
    }
    classPriority.forEach((cls, i) => {
      const item = document.createElement('div');
      item.className = 'class-priority-item';
      item.draggable = true;
      item.dataset.idx = i;
      item.innerHTML = `
        <span class="class-drag-handle">⠿</span>
        <span class="class-priority-num">${i + 1}</span>
        <span class="class-priority-name">${CLASS_NAMES[cls] || cls}</span>
        <button class="class-priority-remove" data-idx="${i}">✕</button>
      `;
      classPriorityList.appendChild(item);

      // Remove handler
      item.querySelector('.class-priority-remove').addEventListener('click', (e) => {
        e.stopPropagation();
        classPriority.splice(i, 1);
        renderClassPriority();
      });

      // Drag handlers
      item.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/plain', i);
        item.classList.add('dragging');
      });
      item.addEventListener('dragend', () => item.classList.remove('dragging'));
      item.addEventListener('dragover', (e) => {
        e.preventDefault();
        item.classList.add('drag-over');
      });
      item.addEventListener('dragleave', () => item.classList.remove('drag-over'));
      item.addEventListener('drop', (e) => {
        e.preventDefault();
        item.classList.remove('drag-over');
        const fromIdx = parseInt(e.dataTransfer.getData('text/plain'));
        const toIdx = i;
        if (fromIdx !== toIdx) {
          const [moved] = classPriority.splice(fromIdx, 1);
          classPriority.splice(toIdx, 0, moved);
          renderClassPriority();
        }
      });
    });
  }

  renderClassPriority();

  // ─── Site Data (exact names from train.shohoz.com) ───────────
  const STATIONS = ["Abdulpur","Aditmari","Ahsanganj","Akhaura","Akkelpur","Alamdanga","Amirganj","Amnura Bypass","Arani","Arikhola","Ashuganj","Azampur","Azim Nagar","Badarganj","Badiakhali","Baharpur","Bajitpur","Bajra","Bamondanga","Baramchal","Barhatta","Barkhata","Baura","Bazra","Benapole","Bhairab Bazar","Bhanga","Bhanga Junction","Bhanugach","Bhatera","Bhatiary","Bhatshala","Bheramara","Bhomradah","Bhotmari","Bhuapur","Bidyaganj","Biman Bandar","Bipulashar","Birampur","Birol","Boalmari Bazar","Bogura","Bonar Para","Boral Bridge","Borashi","Brahmanbaria","Burimari","Chakaria","Chandpur","Chandpur Court","Chandradighalia","Chapainawabganj","Chapta","Chatiyan","Chatmohar","Chattogram","Chilahati","Chinki Astana","Chirirbandar","Chitoshi Road","Chokhapon","Choto Bahirbag","Choumuhani","Chowmuhani","Chuadanga","Cox's Bazar","Cumilla","Darshana Halt","Daulatganj","Daulatkandi","Daulatpur","Dewanganj Bazar","Dhaka","Dhalarchar","Dinajpur","Dohazari","Domar","Dulahazara","Faridpur","Fenchuganj","Feni","Fulbari","Gachihata","Gafargaon","Gaibandha","Gangasagar","Ghorashal","Ghorashal Flag","Gobra","GOMDANDI","Gopalganj","Gouripur Myn","Gunabati","Hajiganj","Harashpur","HARBANG","Harinarayanpur","Hasanpur","Hatibandha","Hatubhanga","Hi-Tech City","Hili","Ibrahimabad","Imambari","Ishwardi","Ishwardi Bypass","ISLAMABAD","Islampur Bazar","Itakhola","Jamalganj","Jamalpur Town","Jamtail","Janali Hat","Jashore","Jhikargacha","Jinardi","Joydebpur","Joypurhat","Kakonhat","Kalukhali","Kankina","Kashiani","Kaunia","Kendua Bazar","Khanabari","Khila","Khoksha","Kholahati","Khulna","Kishorganj","Kismat","Kotchandpur","Kulaura","Kuliarchar","Kumarkhali","Kumira","Kurigram","Kushtia Court","Laksam","Lalmonirhat","Langla","Laskarpur","LOHAGARA","Lohagora","Lolitnagar","Madhnagar","Madhukhali","Mahendranagar","Mahimaganj","Maijdee","Maijdee Court","Maijdi Court","Maijgaon","Mandabag","Manikkhali","Mantala","Manu","Mawa","Meher","Melandah Bazar","Merasani","Methikanda","Mirbagh","Mirpur","Mirzapur","Modhu Road","Mogla Bazar","Mohanganj","Montola","Mubarakganj","Muksudpur","Mukundapur","Muladhuli","Mymensingh","Nandina","Nangolkot","Narail","Narsingdi","Narundi","Natherpetua","Natore","Nayapara","Netrakona","Nilphamari","Noakhali","Noapara","Nowapara","Pabna","Padma","Paghachang","Pahartali","Paksey","Panchagarh","Panchbibi","Pangsha","Parbatipur","Patgram","Patiya","Pirgacha","Pirganj","Piyarpur","Poradaha","Pubail","Quasba","Rajapur","Rajbari","Rajshahi","Ramu","Rangpur","Rashidpur","Ruhia","Sadar Rasulpur","Safdarpur","Saidpur","Saldanadi","Santahar","Sararchar","Sardah Road","Sarishabari","Satgaon","Satiajuri","Satkania","Setabganj","SH M Monsur Ali","Shahaji Bazar","Shahapur","Shaistaganj","Shamsher Nagar","Shamshernagar","Shashidal","Shibchar","Shibganj","Sholoshohor","Shyamgonj","Shyampur","Singerbil","Singia","Sirajganj Bazar","Sirajganjraipur","Sitakunda","Sonaimuri","Sonatola","SOYDABAD","Sreemangal","Sreepur","Srinidhi","Sylhet","Talora","Talshahar","Tangail","Tarakandi","Teesta Junction","Tejgaon","Teliapara","Thakrokona","Thakurgaon Road","Tilagaon","Tongi","Tushbhandar","Ullapara"];

  const TRAINS = ["AGHNIBINA EXPRESS","BANALATA EXPRESS","BANGLABANDHA EXPRESS","BARENDRA EXPRESS","BENAPOLE EXPRESS","BHRAMMAPUTRA EXPRESS","BIJOY EXPRESS","CHAPAINAWABGANJ SHUTTLE","CHATTALA EXPRESS","CHILAHATI EXPRESS","CHITRA EXPRESS","COXS BAZAR EXPRESS","DHALARCHAR EXPRESS","DHUMKETU EXPRESS","DOLONCHAPA EXPRESS","DRUTOJAN EXPRESS","EGAROSINDHUR GODHULI","EGAROSINDHUR PROVATI","EKOTA EXPRESS","HAWR EXPRESS","JAHANABAD EXPRESS","JAMALPUR EXPRESS","JAMUNA EXPRESS","JAYENTIKA EXPRESS","KALNI EXPRESS","KANCHON INTERCITY COMMUTER","KAPOTAKSHA EXPRESS","KISHORGANJ EXPRESS","KOROTOA EXPRESS","KURIGRAM EXPRESS","LALMONI EXPRESS","MADHUMATI EXPRESS","MAHANAGAR GODHULI","MAHANAGAR PROVATI","MEGHNA EXPRESS","MOHANAGAR EXPRESS","MOHONGANJ EXPRESS","NILSAGAR EXPRESS","OVIJATRI COMMUTER","PADMA EXPRESS","PAHARIKA EXPRESS","PANCHAGARH EXPRESS","PARABAT EXPRESS","PARJOTAK EXPRESS","PROBAL EXPRESS","RANGPUR EXPRESS","RUPSHA EXPRESS","RUPOSHI BANGLA EXPRESS","SAGARDARI EXPRESS","SHAIKAT EXPRESS","SILKCITY EXPRESS","SIMANTA EXPRESS","SIRAJGANJ EXPRESS","SONAR BANGLA EXPRESS","SUBORNO EXPRESS","SUNDARBAN EXPRESS","TISTA EXPRESS","TITUMIR EXPRESS","TUNGIPARA EXPRESS","TURNA","UDAYAN EXPRESS","UPABAN EXPRESS","UPAKUL EXPRESS"];

  const SEAT_CLASSES = [
    { id: 'AC_B', name: 'AC Berth' }, { id: 'AC_S', name: 'AC Seat' },
    { id: 'SNIGDHA', name: 'Snigdha' }, { id: 'F_BERTH', name: 'First Berth' },
    { id: 'F_SEAT', name: 'First Seat' }, { id: 'F_CHAIR', name: 'First Chair' },
    { id: 'S_CHAIR', name: 'Shovan Chair' }, { id: 'SHOVAN', name: 'Shovan' },
    { id: 'SHULOV', name: 'Shulov' }, { id: 'AC_CHAIR', name: 'AC Chair' }
  ];

  // Populate station datalist
  document.getElementById('stations').innerHTML = STATIONS.map(s => `<option value="${s}">`).join('');

  // Populate seat class dropdown
  const classSelect = document.getElementById('class-add-select');
  SEAT_CLASSES.forEach(cls => {
    const opt = document.createElement('option');
    opt.value = cls.id;
    opt.textContent = cls.name;
    classSelect.appendChild(opt);
  });

  // Populate train datalist
  document.getElementById('train-options').innerHTML = TRAINS.map(t => `<option value="${t}">`).join('');

  // ─── Preferred Trains (add-to-list) ────────────────────────────────
  let preferredTrains = [];
  const trainPriorityList = document.getElementById('train-priority-list');
  const trainSearchInput = document.getElementById('train-search');
  const selectedTrainsSummary = document.getElementById('selected-trains-summary');

  function renderTrainPriority() {
    trainPriorityList.innerHTML = '';
    preferredTrains.forEach((train, i) => {
      const item = document.createElement('div');
      item.className = 'class-priority-item';
      item.draggable = true;
      item.dataset.index = i;
      item.innerHTML = `
        <span class="class-priority-handle">☰</span>
        <span class="class-priority-number">${i + 1}</span>
        <span class="class-priority-name">${train}</span>
        <button class="class-priority-remove" data-index="${i}">✕</button>
      `;
      trainPriorityList.appendChild(item);
    });

    // Drag-and-drop reorder
    trainPriorityList.querySelectorAll('.class-priority-item').forEach(item => {
      item.addEventListener('dragstart', e => { e.dataTransfer.setData('text/plain', item.dataset.index); });
      item.addEventListener('dragover', e => { e.preventDefault(); item.style.borderTop = '2px solid #1a73e8'; });
      item.addEventListener('dragleave', () => { item.style.borderTop = ''; });
      item.addEventListener('drop', e => {
        e.preventDefault(); item.style.borderTop = '';
        const from = +e.dataTransfer.getData('text/plain');
        const to = +item.dataset.index;
        const [moved] = preferredTrains.splice(from, 1);
        preferredTrains.splice(to, 0, moved);
        renderTrainPriority();
      });
    });

    // Remove buttons
    trainPriorityList.querySelectorAll('.class-priority-remove').forEach(btn => {
      btn.addEventListener('click', () => {
        preferredTrains.splice(+btn.dataset.index, 1);
        renderTrainPriority();
      });
    });

    updateTrainSummary();
  }

  // Add train button
  document.getElementById('add-train-btn').addEventListener('click', () => {
    const val = trainSearchInput.value.trim();
    if (val && !preferredTrains.includes(val)) {
      preferredTrains.push(val);
      trainSearchInput.value = '';
      renderTrainPriority();
    }
  });

  // Also add on Enter key
  trainSearchInput.addEventListener('keydown', e => {
    if (e.key === 'Enter') {
      e.preventDefault();
      document.getElementById('add-train-btn').click();
    }
  });

  // Clear all
  document.getElementById('clear-trains').addEventListener('click', () => {
    preferredTrains = [];
    renderTrainPriority();
  });

  function getSelectedTrains() {
    return preferredTrains.map(name => ({ name, departure: '' }));
  }

  function updateTrainSummary() {
    if (preferredTrains.length === 0) {
      selectedTrainsSummary.innerHTML = '<span class="summary-empty">No train added — will book first available</span>';
    } else {
      selectedTrainsSummary.innerHTML =
        `<span class="summary-label">🎯 Priority (${preferredTrains.length}):</span> ` +
        preferredTrains.map((t, i) => `<span class="summary-tag">${i + 1}. ${t}</span>`).join('');
    }
  }

  updateTrainSummary();

  // Load preferences
  sendMsg('GET_PREFERENCES').then(res => {
    if (res?.data) {
      const p = res.data;
      prefFields.from.value = p.from || '';
      prefFields.to.value = p.to || '';
      prefFields.date.value = p.date || '';
      prefFields.passengerCount.value = p.passengerCount || '1';
      prefFields.autoFill.checked = p.autoFill !== false;
      prefFields.autoSeat.checked = p.autoSeat !== false;
      prefFields.rushMode.checked = p.rushMode !== false;
      prefFields.strikeScore.value = String(
        Number.isInteger(p.strikeScore) ? p.strikeScore : 1
      );
      prefFields.autoBook.checked = p.autoBook !== false;

      // Restore class priority (backward compat: convert old seatClass)
      if (p.classPriority && p.classPriority.length > 0) {
        classPriority = [...p.classPriority];
      } else if (p.seatClass) {
        classPriority = [p.seatClass];
      }
      renderClassPriority();

      // Restore preferred trains
      if (p.preferredTrains && p.preferredTrains.length > 0) {
        preferredTrains = p.preferredTrains.map(t => t.name);
        renderTrainPriority();
      }
    }
  });

  // Save preferences
  document.getElementById('save-prefs').addEventListener('click', async () => {
    const prefs = {
      from: prefFields.from.value.trim(),
      to: prefFields.to.value.trim(),
      date: prefFields.date.value,
      classPriority: [...classPriority],
      seatClass: classPriority[0] || '', // backward compat
      passengerCount: parseInt(prefFields.passengerCount.value),
      autoFill: prefFields.autoFill.checked,
      autoSeat: prefFields.autoSeat.checked,
      rushMode: prefFields.rushMode.checked,
      strikeScore: parseInt(prefFields.strikeScore.value, 10) || 0,
      autoBook: prefFields.autoBook.checked,
      preferredTrains: getSelectedTrains()
    };

    const res = await sendMsg('SAVE_PREFERENCES', prefs);
    showStatus('prefs-status', res?.success ? 'Preferences saved!' : 'Error saving', res?.success);
  });


  // ─── Monitor Management ──────────────────────────────────────────────
  const monDot = document.getElementById('monitor-dot');
  const monLabel = document.getElementById('monitor-label');
  const monLogs = document.getElementById('monitor-logs');

  // Load monitor status
  refreshMonitorStatus();

  document.getElementById('start-monitor').addEventListener('click', async () => {
    const site = document.getElementById('mon-site').value;
    await sendMsg('START_MONITORING', { site });
    refreshMonitorStatus();

    // Open the railway site in the active tab with search params from preferences
    const prefRes = await sendMsg('GET_PREFERENCES');
    const prefs = prefRes?.data;

    if (site === 'railway' && prefs?.from && prefs?.to && prefs?.date) {
      const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
      const d = new Date(prefs.date);
      const doj = `${String(d.getDate()).padStart(2, '0')}-${MONTHS[d.getMonth()]}-${d.getFullYear()}`;
      const seatClass = (prefs.classPriority && prefs.classPriority[0]) || prefs.seatClass || 'SNIGDHA';
      const url = `https://train.shohoz.com/booking/train/search?fromcity=${encodeURIComponent(prefs.from)}&tocity=${encodeURIComponent(prefs.to)}&doj=${doj}&class=${seatClass}`;
      chrome.tabs.update({ url });
    } else if (site === 'shohoz') {
      chrome.tabs.update({ url: 'https://train.shohoz.com' });
    } else {
      chrome.tabs.update({ url: 'https://train.shohoz.com' });
    }
  });

  document.getElementById('stop-monitor').addEventListener('click', async () => {
    await sendMsg('STOP_MONITORING');
    refreshMonitorStatus();
  });

  document.getElementById('clear-logs').addEventListener('click', async () => {
    await sendMsg('CLEAR_MONITOR_LOGS');
    refreshMonitorStatus();
  });

  async function refreshMonitorStatus() {
    const res = await sendMsg('GET_MONITOR_STATUS');
    if (!res?.data) return;

    const { active, logs } = res.data;

    if (active) {
      monDot.classList.add('active');
      monLabel.textContent = 'Monitoring Active';
      monLabel.style.color = '#1a7a3a';
    } else {
      monDot.classList.remove('active');
      monLabel.textContent = 'Inactive';
      monLabel.style.color = '#7f8c8d';
    }

    // Render logs
    if (logs && logs.length > 0) {
      monLogs.innerHTML = logs.slice(-20).reverse().map(l =>
        `<div class="log-entry">${new Date(l.time).toLocaleTimeString()} — ${l.message}</div>`
      ).join('');
    } else {
      monLogs.innerHTML = '<p class="log-empty">No logs yet</p>';
    }
  }

  // ─── Booking Status ──────────────────────────────────────────────────
  refreshBookingStatus();

  async function refreshBookingStatus() {
    const res = await sendMsg('GET_BOOKING_STATUS');
    if (!res?.data) return;

    const { step, description, timestamp, details } = res.data;
    const icons = { idle: '💤', 1: '🔍', 2: '🚂', 3: '💺', 4: '📝', 5: '💳', done: '✅', error: '❌' };
    const stepNames = { idle: 'Idle', 1: 'Searching', 2: 'Selecting Train', 3: 'Selecting Seats', 4: 'Filling Details', 5: 'Payment', done: 'Complete', error: 'Error' };

    document.getElementById('status-icon').textContent = icons[step] || '💤';
    document.getElementById('status-step').textContent =
      stepNames[step] || (typeof step === 'number' ? `Step ${step} of 5` : 'Idle');
    document.getElementById('status-desc').textContent = description || 'No active booking';
    document.getElementById('status-time').textContent =
      timestamp ? `Updated: ${new Date(timestamp).toLocaleTimeString()}` : '';

    // Update step progress visualization
    const stepItems = document.querySelectorAll('.step-item');
    const currentStep = typeof step === 'number' ? step : (step === 'done' ? 6 : 0);
    stepItems.forEach(item => {
      const itemStep = parseInt(item.dataset.step);
      item.classList.remove('completed', 'active', 'pending');
      if (step === 'error') {
        item.classList.add(itemStep <= currentStep ? 'error-step' : 'pending');
      } else if (itemStep < currentStep) {
        item.classList.add('completed');
      } else if (itemStep === currentStep) {
        item.classList.add('active');
      } else {
        item.classList.add('pending');
      }
    });

    // Update booking details card
    const detailsSection = document.getElementById('booking-details-section');
    const detailsCard = document.getElementById('booking-details-card');

    if (details && details.length > 0) {
      detailsSection.style.display = 'block';
      detailsCard.innerHTML = details.map(d =>
        `<div class="detail-row">
          <span class="detail-label">${d.label}</span>
          <span class="detail-value">${d.value}</span>
        </div>`
      ).join('');
    } else if (step !== 'idle') {
      // Show preferences-based info when no page-scraped details
      const prefsRes = await sendMsg('GET_PREFERENCES');
      if (prefsRes?.data) {
        const p = prefsRes.data;
        const prefDetails = [];
        if (p.from && p.to) prefDetails.push({ label: '📍 Route', value: `${p.from} → ${p.to}` });
        if (p.date) prefDetails.push({ label: '📅 Date', value: p.date });
        if (p.seatClass) prefDetails.push({ label: '🎫 Class', value: p.seatClass.replace(/_/g, ' ') });
        if (p.passengerCount) prefDetails.push({ label: '👤 Passengers', value: `${p.passengerCount}` });
        if (p.preferredTrains?.length > 0) {
          prefDetails.push({ label: '🚂 Preferred', value: p.preferredTrains.map(t => t.name).join(', ') });
        }

        if (prefDetails.length > 0) {
          detailsSection.style.display = 'block';
          detailsCard.innerHTML = prefDetails.map(d =>
            `<div class="detail-row">
              <span class="detail-label">${d.label}</span>
              <span class="detail-value">${d.value}</span>
            </div>`
          ).join('');
        }
      }
    } else {
      detailsSection.style.display = 'none';
    }
  }

  // ─── Auto-refresh status tab every 3 seconds when visible ────────────
  setInterval(() => {
    const activeTab = document.querySelector('.tab.active');
    if (activeTab?.dataset.tab === 'monitor') refreshMonitorStatus();
    if (activeTab?.dataset.tab === 'status') refreshBookingStatus();
  }, 3000);

  // ─── Helpers ─────────────────────────────────────────────────────────
  function sendMsg(type, data = {}) {
    return new Promise(resolve => {
      chrome.runtime.sendMessage({ type, data }, resolve);
    });
  }

  function showStatus(elementId, message, success) {
    const el = document.getElementById(elementId);
    el.textContent = message;
    el.className = `status-msg ${success ? 'success' : 'error'}`;
    setTimeout(() => { el.textContent = ''; }, 3000);
  }

  // ─── Log Viewer ──────────────────────────────────────────────────────
  const logViewer = document.getElementById('log-viewer');

  // BD (Asia/Dhaka) timestamp for log lines — the ISO ts is UTC, so render it
  // explicitly in Dhaka time regardless of the machine's locale.
  function bdTime(tsOrDate) {
    const d = tsOrDate ? new Date(tsOrDate) : new Date();
    try {
      return d.toLocaleTimeString('en-GB', { timeZone: 'Asia/Dhaka', hour12: false });
    } catch (e) {
      return d.toTimeString().slice(0, 8);
    }
  }

  function renderLogEntry(e) {
    const levelColor = { info: '#8bc34a', warn: '#ffc107', error: '#f44336' };
    const color = levelColor[e.level] || '#e0e0e0';
    return `<span style="color:#888">${bdTime(e.ts)}</span> <span style="color:${color}">[${(e.level || '').toUpperCase()}]</span> ${e.msg || ''}`;
  }

  // ── Real-time streaming: re-render whenever content scripts flush new logs
  // to chrome.storage.local (etb_logs). Only active while the viewer is open;
  // auto-scrolls to the newest line unless the user has scrolled up to read.
  let _logsWereOpen = false;
  let _logsRenderedCount = 0;
  setInterval(async () => {
    const isOpen = logViewer && logViewer.style.display !== 'none';
    if (!isOpen) { _logsWereOpen = false; return; }
    if (!_logsWereOpen) {
      // Just opened via the View logs button — its own handler renders first.
      _logsWereOpen = true;
      return;
    }
    try {
      const res = await sendMsg('GET_LOGS');
      const logs = res?.data || [];
      if (logs.length !== _logsRenderedCount) {
        const stickToBottom = logViewer.scrollTop + logViewer.clientHeight >= logViewer.scrollHeight - 30;
        logViewer.innerHTML = logs.map(renderLogEntry).join('\n');
        _logsRenderedCount = logs.length;
        if (stickToBottom) logViewer.scrollTop = logViewer.scrollHeight;
      }
    } catch (err) { /* popup closing / SW asleep — next tick retries */ }
  }, 300);

  document.getElementById('view-logs').addEventListener('click', async () => {
    if (logViewer.style.display !== 'none') {
      logViewer.style.display = 'none';
      return;
    }
    const res = await sendMsg('GET_LOGS');
    const logs = res?.data || [];
    if (logs.length === 0) {
      logViewer.textContent = '(no logs yet)';
    } else {
      logViewer.innerHTML = logs.map(renderLogEntry).join('\n');
    }
    _logsRenderedCount = logs.length;
    logViewer.style.display = 'block';
    logViewer.scrollTop = logViewer.scrollHeight;
  });

  document.getElementById('download-logs').addEventListener('click', async () => {
    const res = await sendMsg('GET_LOGS');
    const logs = res?.data || [];
    const text = logs.map(e => {
      const time = e.ts || '';
      return `${time} [${(e.level || '').toUpperCase()}] ${e.msg || ''}`;
    }).join('\n');
    const blob = new Blob([text || '(no logs)'], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `etb-logs-${new Date().toISOString().slice(0, 10)}.log`;
    a.click();
    URL.revokeObjectURL(url);
  });

  document.getElementById('clear-etb-logs').addEventListener('click', async () => {
    await sendMsg('CLEAR_LOGS');
    logViewer.textContent = '(logs cleared)';
  });
});
