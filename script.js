/* ============================================================
   script.js — User-Facing Booking System Logic
   ============================================================ */

/* ---- Data Layer (localStorage, ready for backend swap) ---- */
const DB = {
  getCourts() {
    const defaults = [
      { id: 'c1', name: 'SMASH Court 1', description: 'Outdoor · Standard flooring', rate: 300, blocked: false, features: ['Outdoor' , 'Standard'] },
      { id: 'c2', name: 'SMASH Court 2', description: 'Outdoor · Standard flooring', rate: 300, blocked: false, features: ['Outdoor' , 'Standard'] },
    ];
    const stored = localStorage.getItem('pb_courts');
    if (!stored) { localStorage.setItem('pb_courts', JSON.stringify(defaults)); return defaults; }
    return JSON.parse(stored);
  },

  saveCourts(courts) {
    localStorage.setItem('pb_courts', JSON.stringify(courts));
  },

  getBookings() {
    return JSON.parse(localStorage.getItem('pb_bookings') || '[]');
  },

  saveBookings(bookings) {
    localStorage.setItem('pb_bookings', JSON.stringify(bookings));
  },

  addBooking(booking) {
    const bookings = this.getBookings();
    bookings.push(booking);
    this.saveBookings(bookings);
  },

  getBlockedDates() {
    return JSON.parse(localStorage.getItem('pb_blocked_dates') || '[]');
  },
};

/* ---- UI State ---- */
const state = {
  selectedCourt: null,
  selectedDate: '',
  selectedSlots: [],  // array of hour numbers (6, 7, … 21)
};

/* ---- Utility ---- */
function generateRef() {
  return 'PB-' + Date.now().toString(36).toUpperCase() + '-' + Math.random().toString(36).substr(2, 4).toUpperCase();
}

function formatTime(hour) {
  const period = hour < 12 ? 'AM' : 'PM';
  const h = hour % 12 || 12;
  return `${h}:00 ${period}`;
}

function formatCurrency(amount) {
  return '₱' + Number(amount).toLocaleString('en-PH', { minimumFractionDigits: 2 });
}

function formatDate(dateStr) {
  if (!dateStr) return '';
  const d = new Date(dateStr + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
}

/* Returns a Set of booked hour-slots for the given court+date */
function getBookedSlots(courtId, date) {
  const bookings = DB.getBookings();
  const slots = new Set();
  bookings.forEach((b) => {
    if (b.courtId === courtId && b.date === date && b.status !== 'cancelled') {
      b.slots.forEach((s) => slots.add(s));
    }
  });
  return slots;
}

/* Returns the current hour (local time) — used to gray out past slots for today */
function getCurrentHour() {
  return new Date().getHours();
}

function isToday(dateStr) {
  return dateStr === new Date().toISOString().split('T')[0];
}

function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/* ---- Dark Mode ---- */
function initDarkMode() {
  const toggle = document.getElementById('darkTog');
  const isDark = localStorage.getItem('pb_darkmode') !== 'light';
  if (!isDark) document.body.classList.add('light-mode');
  if (toggle) toggle.checked = isDark;
  toggle?.addEventListener('change', () => {
    document.body.classList.toggle('light-mode', !toggle.checked);
    localStorage.setItem('pb_darkmode', toggle.checked ? 'dark' : 'light');
  });
}

/* ---- Render Courts ---- */
function renderCourts() {
  const grid = document.getElementById('courtsGrid');
  if (!grid) return;
  const courts = DB.getCourts();

  grid.innerHTML = courts.map((court) => {
    const isBlocked = court.blocked;
    const badge = isBlocked
      ? '<span class="court-badge maintenance">Maintenance</span>'
      : '<span class="court-badge">Available</span>';

    // Show today's availability count inline on the card
    const today = new Date().toISOString().split('T')[0];
    const bookedToday = getBookedSlots(court.id, today);
    const currentHour = getCurrentHour();
    // Total remaining hours today (6AM–10PM = hours 6–21, only future ones)
    const totalSlots = Array.from({ length: 16 }, (_, i) => i + 6); // 6..21
    const availableToday = isBlocked ? 0 : totalSlots.filter(h => h >= currentHour && !bookedToday.has(h)).length;

    return `
      <div class="court-card ${isBlocked ? 'blocked' : ''}" data-id="${court.id}" onclick="selectCourt('${court.id}')">
        <div class="court-card-img">
          <div class="court-visual"></div>
          ${badge}
        </div>
        <div class="court-card-body">
          <div class="court-name">${court.name}</div>
          <div class="court-desc">${court.description}</div>
          <div style="display:flex;align-items:center;gap:6px;margin-bottom:10px">
            <span style="font-size:0.75rem;font-weight:700;padding:3px 10px;border-radius:20px;background:${availableToday > 0 ? 'rgba(0,200,83,0.12)' : 'rgba(255,77,79,0.12)'};color:${availableToday > 0 ? 'var(--green-primary)' : 'var(--accent-red)'}">
              ${availableToday > 0 ? `⏱ ${availableToday} slots open today` : '⛔ Fully booked today'}
            </span>
          </div>
          <div class="court-price">
            <div>
              <div class="price-tag">${formatCurrency(court.rate)}</div>
              <div class="price-unit">per hour</div>
            </div>
            <div style="display:flex;gap:4px;flex-wrap:wrap;justify-content:flex-end">
              ${court.features.map((f) => `<span style="font-size:0.7rem;background:var(--dark-input);border:1px solid var(--dark-border);border-radius:4px;padding:2px 6px;color:var(--dark-muted)">${f}</span>`).join('')}
            </div>
          </div>
        </div>
        <div style="padding:0 16px 14px;font-size:0.78rem;color:var(--green-primary);font-weight:600">
          ${isBlocked ? '' : '👆 Click to book this court'}
        </div>
      </div>`;
  }).join('');
}

/* ---- Select Court — also reveals the booking panel ---- */
function selectCourt(courtId) {
  const courts = DB.getCourts();
  const court = courts.find((c) => c.id === courtId);
  if (!court) return;
  if (court.blocked) { showToast('This court is currently under maintenance.', 'error'); return; }

  state.selectedCourt = court;
  state.selectedSlots = [];

  // Highlight selected card
  document.querySelectorAll('.court-card').forEach((el) => {
    el.classList.toggle('selected', el.dataset.id === courtId);
  });

  // Update court display in the form
  const display = document.getElementById('courtDisp');
  if (display) {
    display.textContent = `${court.name} — ${formatCurrency(court.rate)}/hr`;
    display.classList.add('filled');
  }

  // Reveal booking section with smooth animation
  const bookSec = document.getElementById('bookSec');
  if (bookSec) {
    bookSec.classList.add('visible');
    // Small delay so the CSS transition fires after display change
    setTimeout(() => {
      bookSec.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 80);
  }

  // Reset date & slots when switching courts
  const dateInput = document.getElementById('bDate');
  if (dateInput && state.selectedDate) {
    // Keep date, just refresh slots
  } else {
    state.selectedDate = '';
    state.selectedSlots = [];
  }

  renderTimeSlots();
  updatePriceSummary();
}

/* ---- Date Change ---- */
function onDate() {
  const dateInput = document.getElementById('bDate');
  if (!dateInput) return;
  const date = dateInput.value;

  // Check if date is blocked by admin
  const blocked = DB.getBlockedDates();
  if (blocked.includes(date)) {
    showToast('This date is blocked for maintenance. Please choose another date.', 'error');
    dateInput.value = '';
    state.selectedDate = '';
    document.getElementById('slotsGrid').innerHTML = '';
    document.getElementById('slotMsg').style.display = 'block';
    document.getElementById('slotMsg').textContent = 'That date is unavailable. Please pick another.';
    return;
  }

  state.selectedDate = date;
  state.selectedSlots = [];
  renderTimeSlots();
  updatePriceSummary();
}

/* ---- Render Time Slots with real-time awareness ---- */
function renderTimeSlots() {
  const grid = document.getElementById('slotsGrid');
  const msg = document.getElementById('slotMsg');
  if (!grid) return;

  if (!state.selectedCourt || !state.selectedDate) {
    grid.innerHTML = '';
    if (msg) { msg.style.display = 'block'; msg.textContent = 'Select a court and date to see available slots.'; }
    return;
  }

  const bookedSlots = getBookedSlots(state.selectedCourt.id, state.selectedDate);
  const todayFlag = isToday(state.selectedDate);
  const nowHour = getCurrentHour();

  // Build legend + slots
  if (msg) msg.style.display = 'none';

  // Count available
  let availCount = 0;
  const slotItems = [];

  for (let h = 6; h <= 21; h++) {
    const isPast = todayFlag && h < nowHour;          // past hours on today
    const isNow  = todayFlag && h === nowHour;        // current hour
    const isBooked = bookedSlots.has(h);
    const isSelected = state.selectedSlots.includes(h);
    const isUnavailable = isPast || isBooked;

    if (!isUnavailable) availCount++;

    let slotClass = 'slot';
    let label = '';
    let title = '';

    if (isSelected) { slotClass += ' sel'; }
    else if (isNow) { slotClass += ' now'; label = '<span class="slot-tag">NOW</span>'; title = 'Current hour'; }
    else if (isPast) { slotClass += ' past'; label = '<span class="slot-tag past-tag">DONE</span>'; title = 'This hour has passed'; }
    else if (isBooked) { slotClass += ' booked'; label = '<span class="slot-tag booked-tag">TAKEN</span>'; title = 'Already booked'; }
    else { slotClass += ' free'; }

    slotItems.push(`
      <div class="${slotClass}" data-hour="${h}" title="${title}" onclick="toggleSlot(${h})">
        <div class="slot-time">${formatTime(h)}</div>
        <div class="slot-end">${formatTime(h + 1)}</div>
        ${label}
      </div>`);
  }

  // Realtime clock indicator
  const clockNote = todayFlag
    ? `<div class="slots-live-note">🟢 Live — ${availCount} slot${availCount !== 1 ? 's' : ''} available today · Current time: ${formatTime(nowHour)}</div>`
    : `<div class="slots-live-note">📅 ${availCount} slot${availCount !== 1 ? 's' : ''} available on this date</div>`;

  // Legend
  const legend = `
    <div class="slot-legend">
      <span class="leg free">⬜ Available</span>
      <span class="leg sel">🟩 Selected</span>
      <span class="leg booked">🟥 Booked</span>
      ${todayFlag ? '<span class="leg past">⬛ Past</span><span class="leg now">🔵 Now</span>' : ''}
    </div>`;

  grid.innerHTML = clockNote + legend + `<div class="slots-grid">${slotItems.join('')}</div>`;
}

function toggleSlot(hour) {
  if (!state.selectedCourt) { showToast('Please select a court first.', 'info'); return; }
  if (!state.selectedDate) { showToast('Please select a date first.', 'info'); return; }

  const bookedSlots = getBookedSlots(state.selectedCourt.id, state.selectedDate);
  const todayFlag = isToday(state.selectedDate);
  const nowHour = getCurrentHour();

  // Block past and current-hour slots (can't book what's already happening)
  if (bookedSlots.has(hour)) { showToast('This slot is already booked.', 'error'); return; }
  if (todayFlag && hour < nowHour) { showToast('This time slot has already passed.', 'error'); return; }
  if (todayFlag && hour === nowHour) { showToast('Cannot book the current hour — it has already started.', 'info'); return; }

  const idx = state.selectedSlots.indexOf(hour);

  if (idx === -1) {
    // Add — must be contiguous
    if (state.selectedSlots.length === 0) {
      state.selectedSlots.push(hour);
    } else {
      const min = Math.min(...state.selectedSlots);
      const max = Math.max(...state.selectedSlots);
      if (hour === min - 1 || hour === max + 1) {
        state.selectedSlots.push(hour);
        state.selectedSlots.sort((a, b) => a - b);
      } else {
        showToast('Please select consecutive time slots.', 'info');
        return;
      }
    }
  } else {
    // Remove — only from ends
    const min = Math.min(...state.selectedSlots);
    const max = Math.max(...state.selectedSlots);
    if (hour === min || hour === max) {
      state.selectedSlots.splice(idx, 1);
    } else {
      showToast('You can only deselect from the start or end of your booking.', 'info');
      return;
    }
  }

  renderTimeSlots();
  updatePriceSummary();
}

/* ---- Price Summary ---- */
function updatePriceSummary() {
  const hours = state.selectedSlots.length;
  const rate = state.selectedCourt ? state.selectedCourt.rate : 0;
  const total = hours * rate;

  const el = (id) => document.getElementById(id);
  if (el('pHrs')) el('pHrs').textContent = `${hours} hr${hours !== 1 ? 's' : ''}`;
  if (el('pRate')) el('pRate').textContent = formatCurrency(rate) + '/hr';
  if (el('pTot')) el('pTot').textContent = formatCurrency(total);
}

/* ---- Payment Method ---- */
function pickPay(method) {
  document.querySelectorAll('.pay-opt').forEach((el) => {
    el.classList.toggle('on', el.dataset.m === method);
  });
  document.getElementById('bPay').value = method;
  const gcashBox = document.getElementById('gcashBox');
  if (gcashBox) gcashBox.classList.toggle('show', method === 'gcash');
}

/* ---- Form Validation ---- */
function validateForm() {
  const fields = [
    { id: 'bName', label: 'Full Name' },
    { id: 'bPhone', label: 'Contact Number' },
    { id: 'bEmail', label: 'Email' },
    { id: 'bDate', label: 'Date' },
    { id: 'bPay', label: 'Payment Method' },
  ];

  for (const f of fields) {
    const el = document.getElementById(f.id);
    if (!el || !el.value.trim()) {
      showToast(`Please fill in: ${f.label}`, 'error');
      el?.focus();
      return false;
    }
  }

  if (!state.selectedCourt) { showToast('Please select a court.', 'error'); return false; }
  if (state.selectedSlots.length === 0) { showToast('Please select at least one time slot.', 'error'); return false; }

  const email = document.getElementById('bEmail').value;
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    showToast('Please enter a valid email address.', 'error');
    return false;
  }

  return true;
}

/* ---- Submit Booking ---- */
function submitBooking(e) {
  e.preventDefault();
  if (!validateForm()) return;

  const hours = state.selectedSlots.length;
  const total = hours * state.selectedCourt.rate;
  const startHour = Math.min(...state.selectedSlots);
  const endHour = Math.max(...state.selectedSlots) + 1;

  const booking = {
    ref: generateRef(),
    fullName: document.getElementById('bName').value.trim(),
    contactNumber: document.getElementById('bPhone').value.trim(),
    email: document.getElementById('bEmail').value.trim(),
    courtId: state.selectedCourt.id,
    courtName: state.selectedCourt.name,
    date: state.selectedDate,
    slots: [...state.selectedSlots],
    startTime: formatTime(startHour),
    endTime: formatTime(endHour),
    duration: hours,
    rate: state.selectedCourt.rate,
    total,
    paymentMethod: document.getElementById('bPay').value,
    status: 'pending',
    createdAt: new Date().toISOString(),
  };

  DB.addBooking(booking);
  showInvoiceModal(booking);
  resetForm();
  showToast('Booking submitted successfully! 🎾', 'success');
}

function resetForm() {
  document.getElementById('bookForm')?.reset();
  state.selectedCourt = null;
  state.selectedDate = '';
  state.selectedSlots = [];

  document.querySelectorAll('.court-card').forEach((el) => el.classList.remove('selected'));

  const display = document.getElementById('courtDisp');
  if (display) { display.textContent = 'Click a court above to select'; display.classList.remove('filled'); }

  // Hide booking section again
  document.getElementById('bookSec')?.classList.remove('visible');

  document.getElementById('slotsGrid').innerHTML = '';
  const slotMsg = document.getElementById('slotMsg');
  if (slotMsg) { slotMsg.style.display = 'block'; slotMsg.textContent = 'Select a court and date to see available slots.'; }

  updatePriceSummary();
  document.getElementById('gcashBox')?.classList.remove('show');
  document.querySelectorAll('.pay-opt').forEach((el) => el.classList.remove('on'));

  // Refresh court cards to reflect new booking
  renderCourts();
}

/* ---- Invoice Modal ---- */
function showInvoiceModal(booking) {
  const modal = document.getElementById('invModal');
  if (!modal) return;

  document.getElementById('invRef').textContent = booking.ref;
  document.getElementById('invName').textContent = booking.fullName;
  document.getElementById('invContact').textContent = booking.contactNumber;
  document.getElementById('invEmail').textContent = booking.email;
  document.getElementById('invCourt').textContent = booking.courtName;
  document.getElementById('invDate').textContent = formatDate(booking.date);
  document.getElementById('invTime').textContent = `${booking.startTime} – ${booking.endTime}`;
  document.getElementById('invDur').textContent = `${booking.duration} hr${booking.duration !== 1 ? 's' : ''}`;
  document.getElementById('invPay').textContent = booking.paymentMethod === 'gcash' ? 'GCash' : 'Cash';
  document.getElementById('invStatus').className = `status-badge status-${booking.status}`;
  document.getElementById('invStatus').textContent = booking.status.charAt(0).toUpperCase() + booking.status.slice(1);
  document.getElementById('invTot').textContent = formatCurrency(booking.total);
  document.getElementById('invEmailNote').textContent = `📧 Confirmation email simulated to: ${booking.email}`;

  modal.classList.add('show');
}

function closeModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

/* ---- Real-time clock refresh (every minute) ---- */
function startRealtimeClock() {
  // Refresh slots display every 60 seconds so "past" slots auto-update
  setInterval(() => {
    if (state.selectedCourt && state.selectedDate) renderTimeSlots();
    renderCourts(); // refresh availability badges
  }, 60000);
}

/* ---- Init ---- */
document.addEventListener('DOMContentLoaded', () => {
  initDarkMode();
  renderCourts();
  startRealtimeClock();

  // Set min date
  const dateInput = document.getElementById('bDate');
  if (dateInput) dateInput.min = new Date().toISOString().split('T')[0];

  // Live hero stats
  const bookings = DB.getBookings();
  const courts = DB.getCourts();
  const s = (id) => document.getElementById(id);
  if (s('sCourts')) s('sCourts').textContent = courts.length;
  if (s('sBook')) s('sBook').textContent = bookings.length;
  if (s('sRev')) {
    const rev = bookings.filter(b => b.status !== 'cancelled').reduce((sum, b) => sum + b.total, 0);
    s('sRev').textContent = formatCurrency(rev);
  }

  // Form submit
  document.getElementById('bookForm')?.addEventListener('submit', submitBooking);

  // Close modals on overlay click
  document.querySelectorAll('.modal-overlay').forEach((overlay) => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  });
});
