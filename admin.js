/* ============================================================
   admin.js — Admin Dashboard Logic
   ============================================================ */

/* ---- Data helpers (mirrors script.js DB layer) ---- */
const AdminDB = {
  getCourts() {
    const defaults = [
      { id: 'c1', name: 'Court Alpha', description: 'Indoor · Air-conditioned · Premium flooring', rate: 350, blocked: false, features: ['Indoor', 'AC', 'LED Lighting'] },
      { id: 'c2', name: 'Court Beta', description: 'Indoor · Covered · Standard flooring', rate: 280, blocked: false, features: ['Indoor', 'Covered', 'Standard'] },
    ];
    const stored = localStorage.getItem('pb_courts');
    if (!stored) { localStorage.setItem('pb_courts', JSON.stringify(defaults)); return defaults; }
    return JSON.parse(stored);
  },
  saveCourts(courts) { localStorage.setItem('pb_courts', JSON.stringify(courts)); },
  getBookings() { return JSON.parse(localStorage.getItem('pb_bookings') || '[]'); },
  saveBookings(b) { localStorage.setItem('pb_bookings', JSON.stringify(b)); },
  getBlockedDates() { return JSON.parse(localStorage.getItem('pb_blocked_dates') || '[]'); },
  saveBlockedDates(dates) { localStorage.setItem('pb_blocked_dates', JSON.stringify(dates)); },
};

/* ---- Formatters ---- */
function fCurrency(n) { return '₱' + Number(n).toLocaleString('en-PH', { minimumFractionDigits: 2 }); }
function fDate(s) {
  if (!s) return '—';
  const d = new Date(s + 'T00:00:00');
  return d.toLocaleDateString('en-PH', { month: 'short', day: 'numeric', year: 'numeric' });
}
function fDateTime(s) {
  if (!s) return '—';
  return new Date(s).toLocaleString('en-PH', { month: 'short', day: 'numeric', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}
function statusBadge(s) {
  const map = { pending: 'status-pending', confirmed: 'status-confirmed', completed: 'status-completed', cancelled: 'status-cancelled' };
  return `<span class="status-badge ${map[s] || ''}">${s}</span>`;
}
function showToast(msg, type = 'success') {
  const container = document.getElementById('toastContainer');
  if (!container) return;
  const icons = { success: '✅', error: '❌', info: 'ℹ️' };
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.innerHTML = `<span class="toast-icon">${icons[type]}</span><span class="toast-msg">${msg}</span>`;
  container.appendChild(toast);
  setTimeout(() => toast.remove(), 4000);
}

/* ---- State ---- */
let currentSection = 'dashboard';
let bookingFilters = { search: '', date: '', status: '' };
let editingCourt = null;
let editingAccount = null;

/* ---- Navigation ---- */
function navigate(section) {
  currentSection = section;
  document.querySelectorAll('.nav-item').forEach(el => el.classList.toggle('active', el.dataset.section === section));
  document.querySelectorAll('.admin-section').forEach(el => el.classList.toggle('active', el.id === 'section-' + section));

  const loaders = {
    dashboard: renderDashboard,
    bookings: renderBookings,
    courts: renderCourts,
    accounts: renderAccounts,
    blocked: renderBlockedDates,
  };
  if (loaders[section]) loaders[section]();
}

/* ---- Dashboard ---- */
function renderDashboard() {
  const bookings = AdminDB.getBookings();
  const today = new Date().toISOString().split('T')[0];
  const todayBookings = bookings.filter(b => b.date === today);
  const active = bookings.filter(b => b.status !== 'cancelled');
  const revenue = active.reduce((s, b) => s + b.total, 0);

  // Court ranking
  const courtCount = {};
  active.forEach(b => { courtCount[b.courtName] = (courtCount[b.courtName] || 0) + 1; });
  const mostBooked = Object.entries(courtCount).sort((a,b) => b[1] - a[1])[0];

  document.getElementById('dashTotal').textContent = bookings.length;
  document.getElementById('dashToday').textContent = todayBookings.length;
  document.getElementById('dashRevenue').textContent = fCurrency(revenue);
  document.getElementById('dashMost').textContent = mostBooked ? mostBooked[0] : '—';

  // Payment breakdown
  const gcash = active.filter(b => b.paymentMethod === 'gcash').reduce((s,b) => s + b.total, 0);
  const cash = active.filter(b => b.paymentMethod === 'cash').reduce((s,b) => s + b.total, 0);
  document.getElementById('payGcash').textContent = fCurrency(gcash);
  document.getElementById('payCash').textContent = fCurrency(cash);

  // GCash bar percentage
  const total = gcash + cash;
  const pct = total > 0 ? Math.round((gcash / total) * 100) : 0;
  document.getElementById('gcashBar').style.width = pct + '%';
  document.getElementById('cashBar').style.width = (100 - pct) + '%';

  // Recent bookings
  const recent = [...bookings].sort((a,b) => new Date(b.createdAt) - new Date(a.createdAt)).slice(0, 5);
  const tbody = document.getElementById('recentBookingsBody');
  tbody.innerHTML = recent.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--dark-muted);padding:24px">No bookings yet.</td></tr>'
    : recent.map(b => `
      <tr>
        <td><code style="color:var(--green-primary)">${b.ref}</code></td>
        <td>${b.fullName}</td>
        <td>${b.courtName}</td>
        <td>${fDate(b.date)}</td>
        <td>${statusBadge(b.status)}</td>
      </tr>`).join('');
}

/* ---- Bookings ---- */
function renderBookings() {
  let bookings = AdminDB.getBookings();

  // Apply filters
  if (bookingFilters.search) {
    const q = bookingFilters.search.toLowerCase();
    bookings = bookings.filter(b =>
      b.ref.toLowerCase().includes(q) ||
      b.fullName.toLowerCase().includes(q) ||
      b.email.toLowerCase().includes(q) ||
      b.courtName.toLowerCase().includes(q)
    );
  }
  if (bookingFilters.date) bookings = bookings.filter(b => b.date === bookingFilters.date);
  if (bookingFilters.status) bookings = bookings.filter(b => b.status === bookingFilters.status);

  bookings.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

  const isDev = session.role === 'developer';
  const tbody = document.getElementById('bookingsBody');
  tbody.innerHTML = bookings.length === 0
    ? '<tr><td colspan="8" style="text-align:center;color:var(--dark-muted);padding:32px">No bookings found.</td></tr>'
    : bookings.map(b => `
      <tr>
        <td><code style="color:var(--green-primary);font-size:0.8rem">${b.ref}</code></td>
        <td><div style="font-weight:600">${b.fullName}</div><div style="font-size:0.78rem;color:var(--dark-muted)">${b.email}</div></td>
        <td>${b.courtName}</td>
        <td>${fDate(b.date)}<div style="font-size:0.78rem;color:var(--dark-muted)">${b.startTime}–${b.endTime}</div></td>
        <td>${fCurrency(b.total)}</td>
        <td><span style="font-size:0.78rem;background:var(--dark-input);border-radius:4px;padding:2px 8px">${b.paymentMethod.toUpperCase()}</span></td>
        <td>${statusBadge(b.status)}</td>
        <td>
          <div style="display:flex;gap:6px;flex-wrap:wrap">
            <select class="form-control" style="padding:4px 8px;font-size:0.78rem;width:auto" onchange="updateBookingStatus('${b.ref}', this.value)">
              <option value="pending" ${b.status==='pending'?'selected':''}>Pending</option>
              <option value="confirmed" ${b.status==='confirmed'?'selected':''}>Confirmed</option>
              <option value="completed" ${b.status==='completed'?'selected':''}>Completed</option>
              <option value="cancelled" ${b.status==='cancelled'?'selected':''}>Cancelled</option>
            </select>
            ${isDev ? `<button class="btn btn-danger btn-sm" onclick="deleteBooking('${b.ref}')">🗑️</button>` : ''}
          </div>
        </td>
      </tr>`).join('');
}

function updateBookingStatus(ref, status) {
  const bookings = AdminDB.getBookings();
  const b = bookings.find(b => b.ref === ref);
  if (!b) return;
  b.status = status;
  AdminDB.saveBookings(bookings);
  showToast(`Booking ${ref} updated to ${status}.`);
  renderBookings();
  if (currentSection === 'dashboard') renderDashboard();
}

function deleteBooking(ref) {
  if (!confirm(`Delete booking ${ref}? This cannot be undone.`)) return;
  AdminDB.saveBookings(AdminDB.getBookings().filter(b => b.ref !== ref));
  showToast('Booking deleted.', 'info');
  renderBookings();
  renderDashboard();
}

function exportCSV() {
  let bookings = AdminDB.getBookings();
  if (bookingFilters.search || bookingFilters.date || bookingFilters.status) {
    // re-apply same filters
    if (bookingFilters.search) {
      const q = bookingFilters.search.toLowerCase();
      bookings = bookings.filter(b => b.ref.toLowerCase().includes(q) || b.fullName.toLowerCase().includes(q) || b.email.toLowerCase().includes(q));
    }
    if (bookingFilters.date) bookings = bookings.filter(b => b.date === bookingFilters.date);
    if (bookingFilters.status) bookings = bookings.filter(b => b.status === bookingFilters.status);
  }

  const headers = ['Reference', 'Name', 'Email', 'Contact', 'Court', 'Date', 'Start', 'End', 'Duration(hrs)', 'Rate', 'Total', 'Payment', 'Status', 'Created'];
  const rows = bookings.map(b => [
    b.ref, b.fullName, b.email, b.contactNumber, b.courtName, b.date, b.startTime, b.endTime, b.duration, b.rate, b.total, b.paymentMethod, b.status, b.createdAt
  ]);

  const csv = [headers, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `pickle_bliss_bookings_${new Date().toISOString().split('T')[0]}.csv`;
  a.click();
  URL.revokeObjectURL(url);
  showToast('CSV exported!');
}

/* ---- Courts ---- */
function renderCourts() {
  const courts = AdminDB.getCourts();
  const tbody = document.getElementById('courtsBody');
  tbody.innerHTML = courts.map(c => `
    <tr>
      <td><strong>${c.name}</strong></td>
      <td style="font-size:0.85rem;color:var(--dark-muted)">${c.description}</td>
      <td>${fCurrency(c.rate)}/hr</td>
      <td>${c.blocked ? '<span class="status-badge status-cancelled">Maintenance</span>' : '<span class="status-badge status-confirmed">Available</span>'}</td>
      <td>
        <div style="display:flex;gap:6px">
          <button class="btn btn-secondary btn-sm" onclick="openEditCourt('${c.id}')">✏️ Edit</button>
          <button class="btn btn-sm" style="background:${c.blocked?'rgba(0,200,83,0.15);color:var(--green-primary)':'rgba(255,214,0,0.15);color:var(--accent-yellow)'}"
            onclick="toggleCourtBlock('${c.id}')">
            ${c.blocked ? '✅ Unblock' : '🔒 Block'}
          </button>
          <button class="btn btn-danger btn-sm" onclick="deleteCourt('${c.id}')">🗑️</button>
        </div>
      </td>
    </tr>`).join('');
}

function openAddCourt() {
  editingCourt = null;
  document.getElementById('courtModalTitle').textContent = 'ADD COURT';
  document.getElementById('courtId').value = '';
  document.getElementById('courtName').value = '';
  document.getElementById('courtDesc').value = '';
  document.getElementById('courtRate').value = '';
  document.getElementById('courtModal').classList.add('show');
}

function openEditCourt(id) {
  const court = AdminDB.getCourts().find(c => c.id === id);
  if (!court) return;
  editingCourt = court;
  document.getElementById('courtModalTitle').textContent = 'EDIT COURT';
  document.getElementById('courtId').value = court.id;
  document.getElementById('courtName').value = court.name;
  document.getElementById('courtDesc').value = court.description;
  document.getElementById('courtRate').value = court.rate;
  document.getElementById('courtModal').classList.add('show');
}

function saveCourt() {
  const id = document.getElementById('courtId').value;
  const name = document.getElementById('courtName').value.trim();
  const desc = document.getElementById('courtDesc').value.trim();
  const rate = parseFloat(document.getElementById('courtRate').value);

  if (!name || !rate || isNaN(rate)) { showToast('Please fill in all court fields.', 'error'); return; }

  const courts = AdminDB.getCourts();
  if (id) {
    const idx = courts.findIndex(c => c.id === id);
    if (idx !== -1) courts[idx] = { ...courts[idx], name, description: desc, rate };
  } else {
    courts.push({ id: 'c' + Date.now(), name, description: desc, rate, blocked: false, features: [] });
  }

  AdminDB.saveCourts(courts);
  closeAdminModal('courtModal');
  renderCourts();
  showToast(id ? 'Court updated!' : 'Court added!');
}

function toggleCourtBlock(id) {
  const courts = AdminDB.getCourts();
  const idx = courts.findIndex(c => c.id === id);
  if (idx !== -1) courts[idx].blocked = !courts[idx].blocked;
  AdminDB.saveCourts(courts);
  renderCourts();
  showToast(`Court ${courts[idx].blocked ? 'blocked' : 'unblocked'}.`, 'info');
}

function deleteCourt(id) {
  if (!confirm('Delete this court? Existing bookings will remain.')) return;
  AdminDB.saveCourts(AdminDB.getCourts().filter(c => c.id !== id));
  renderCourts();
  showToast('Court deleted.', 'info');
}

/* ---- Accounts ---- */
function renderAccounts() {
  const accounts = Auth.getAccounts().filter(a => a.id !== session.id);
  const tbody = document.getElementById('accountsBody');
  tbody.innerHTML = accounts.length === 0
    ? '<tr><td colspan="5" style="text-align:center;color:var(--dark-muted);padding:24px">No other accounts.</td></tr>'
    : accounts.map(a => `
      <tr>
        <td><strong>${a.fullName}</strong></td>
        <td>${a.username}</td>
        <td>${a.email}</td>
        <td><span class="status-badge ${a.role==='developer'?'status-confirmed':'status-pending'}">${a.role}</span></td>
        <td>
          <div style="display:flex;gap:6px">
            <button class="btn btn-secondary btn-sm" onclick="openEditAccount('${a.id}')">✏️ Edit</button>
            <button class="btn btn-danger btn-sm" onclick="deleteAccount('${a.id}')">🗑️</button>
          </div>
        </td>
      </tr>`).join('');
}

function openAddAccount() {
  editingAccount = null;
  document.getElementById('accountModalTitle').textContent = 'ADD MANAGER';
  document.getElementById('accountId').value = '';
  document.getElementById('accFullName').value = '';
  document.getElementById('accUsername').value = '';
  document.getElementById('accEmail').value = '';
  document.getElementById('accPassword').value = '';
  document.getElementById('accountModal').classList.add('show');
}

function openEditAccount(id) {
  const acct = Auth.getAccounts().find(a => a.id === id);
  if (!acct) return;
  editingAccount = acct;
  document.getElementById('accountModalTitle').textContent = 'EDIT ACCOUNT';
  document.getElementById('accountId').value = acct.id;
  document.getElementById('accFullName').value = acct.fullName;
  document.getElementById('accUsername').value = acct.username;
  document.getElementById('accEmail').value = acct.email;
  document.getElementById('accPassword').value = '';
  document.getElementById('accountModal').classList.add('show');
}

function saveAccount() {
  const id = document.getElementById('accountId').value;
  const fullName = document.getElementById('accFullName').value.trim();
  const username = document.getElementById('accUsername').value.trim();
  const email = document.getElementById('accEmail').value.trim();
  const password = document.getElementById('accPassword').value;

  if (!fullName || !username || !email) { showToast('Please fill all required fields.', 'error'); return; }

  if (id) {
    const data = { fullName, username, email };
    if (password) data.password = password;
    const result = Auth.updateAccount(id, data);
    if (result.success) { showToast('Account updated!'); closeAdminModal('accountModal'); renderAccounts(); }
  } else {
    if (!password) { showToast('Password is required for new accounts.', 'error'); return; }
    const result = Auth.addManager({ fullName, username, email, password });
    if (result.success) { showToast('Manager added!'); closeAdminModal('accountModal'); renderAccounts(); }
    else showToast(result.message, 'error');
  }
}

function deleteAccount(id) {
  if (!confirm('Delete this account?')) return;
  Auth.deleteAccount(id);
  renderAccounts();
  showToast('Account deleted.', 'info');
}

/* ---- Blocked Dates ---- */
function renderBlockedDates() {
  const dates = AdminDB.getBlockedDates();
  const list = document.getElementById('blockedDatesList');
  list.innerHTML = dates.length === 0
    ? '<p style="color:var(--dark-muted);font-style:italic">No blocked dates.</p>'
    : dates.map(d => `
      <div style="display:flex;align-items:center;justify-content:space-between;background:var(--dark-input);border:1px solid var(--dark-border);border-radius:8px;padding:12px 16px;margin-bottom:8px">
        <span>📅 ${fDate(d)}</span>
        <button class="btn btn-danger btn-sm" onclick="removeBlockedDate('${d}')">Remove</button>
      </div>`).join('');
}

function addBlockedDate() {
  const input = document.getElementById('newBlockedDate');
  const date = input.value;
  if (!date) { showToast('Please pick a date.', 'error'); return; }
  const dates = AdminDB.getBlockedDates();
  if (dates.includes(date)) { showToast('Date already blocked.', 'info'); return; }
  dates.push(date);
  dates.sort();
  AdminDB.saveBlockedDates(dates);
  input.value = '';
  renderBlockedDates();
  showToast('Date blocked.');
}

function removeBlockedDate(date) {
  AdminDB.saveBlockedDates(AdminDB.getBlockedDates().filter(d => d !== date));
  renderBlockedDates();
  showToast('Date unblocked.', 'info');
}

/* ---- Modal helpers ---- */
function closeAdminModal(id) {
  document.getElementById(id)?.classList.remove('show');
}

/* ---- Sidebar toggle (mobile) ---- */
function toggleSidebar() {
  document.getElementById('sidebar').classList.toggle('open');
}

/* ---- Role-based visibility ---- */
function applyRoleVisibility() {
  const isDev = session.role === 'developer';
  document.querySelectorAll('[data-dev-only]').forEach(el => {
    el.style.display = isDev ? '' : 'none';
  });
  document.getElementById('userRoleBadge').textContent = isDev ? 'Developer' : 'Manager';
  document.getElementById('userRoleBadge').className = `role-badge ${isDev ? 'role-dev' : 'role-mgr'}`;
}

/* ---- Logout ---- */
function logout() {
  Auth.logout();
}

/* ---- Init ---- */
let session;
document.addEventListener('DOMContentLoaded', () => {
  session = Auth.requireAuth();
  if (!session) return;

  // User info in sidebar
  document.getElementById('sidebarUserName').textContent = session.fullName;
  document.getElementById('sidebarUserEmail').textContent = session.email;

  applyRoleVisibility();

  // Dark mode
  const isDark = localStorage.getItem('pb_darkmode') !== 'light';
  if (!isDark) document.body.classList.add('light-mode');
  const toggle = document.getElementById('adminDarkToggle');
  if (toggle) {
    toggle.checked = isDark;
    toggle.addEventListener('change', () => {
      document.body.classList.toggle('light-mode', !toggle.checked);
      localStorage.setItem('pb_darkmode', toggle.checked ? 'dark' : 'light');
    });
  }

  // Booking search/filter events
  document.getElementById('searchInput')?.addEventListener('input', (e) => {
    bookingFilters.search = e.target.value;
    renderBookings();
  });
  document.getElementById('filterDate')?.addEventListener('change', (e) => {
    bookingFilters.date = e.target.value;
    renderBookings();
  });
  document.getElementById('filterStatus')?.addEventListener('change', (e) => {
    bookingFilters.status = e.target.value;
    renderBookings();
  });

  // Modal close on overlay click
  document.querySelectorAll('.modal-overlay').forEach(overlay => {
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.classList.remove('show');
    });
  });

  navigate('dashboard');
});
