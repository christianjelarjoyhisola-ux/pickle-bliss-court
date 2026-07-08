/* ============================================================
   auth.js — Authentication & Role Management
   ============================================================ */

const Auth = (() => {
  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payment review, open play)
  const ROLES = ['owner', 'court_owner', 'staff', 'host'];

  const ROLE_LABELS = {
    owner: 'System Owner',
    court_owner: 'Court Owner',
    staff: 'Court Staff',
    host: 'Open Play Host',
  };

  // Permission matrix — which roles may perform each action.
  const ROLE_PERMISSIONS = {
    owner:       ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only', 'fees'],
    court_owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'export', 'settings', 'fees'],
    staff:       ['bookings', 'open_play', 'payment_review'],
    host:        ['host_open_play'],
  };

  function permissionsFor(role) {
    return ROLE_PERMISSIONS[role] || [];
  }

  function can(action, role) {
    const r = role || (getSession() && getSession().role);
    return permissionsFor(r).includes(action);
  }

  // Default accounts stored in localStorage under 'pb_accounts'
  const DEFAULT_ACCOUNTS = [
    {
      id: 'owner_001',
      username: 'developer',
      password: 'dev123',
      role: 'owner',
      fullName: 'System Owner',
      email: 'owner@picklebliss.local',
      createdAt: new Date().toISOString(),
    },
  ];

  // Initialize accounts if not already set
  function initAccounts() {
    if (!localStorage.getItem('pb_accounts')) {
      localStorage.setItem('pb_accounts', JSON.stringify(DEFAULT_ACCOUNTS));
    }
  }

  // Get all accounts
  function getAccounts() {
    initAccounts();
    return JSON.parse(localStorage.getItem('pb_accounts')) || [];
  }

  // Save accounts
  function saveAccounts(accounts) {
    localStorage.setItem('pb_accounts', JSON.stringify(accounts));
  }

  // Login — returns {success, user, message}
  function login(username, password) {
    const accounts = getAccounts();
    const user = accounts.find(
      (a) => a.username === username && a.password === password
    );
    if (!user) {
      return { success: false, message: 'Invalid username or password.' };
    }
    // Store session
    localStorage.setItem('pb_session', JSON.stringify({ ...user, loginAt: new Date().toISOString() }));
    return { success: true, user };
  }

  // Logout
  function logout() {
    localStorage.removeItem('pb_session');
    window.location.href = 'login.html';
  }

  // Get current session
  function getSession() {
    const s = localStorage.getItem('pb_session');
    return s ? JSON.parse(s) : null;
  }

  // Check if logged in; redirect if not
  function requireAuth(redirectTo = 'login.html') {
    if (!getSession()) {
      window.location.href = redirectTo;
      return null;
    }
    return getSession();
  }

  // Check if user has required role
  function hasRole(role) {
    const session = getSession();
    if (!session) return false;
    if (session.role === 'owner') return true; // system owner has all access
    return session.role === role;
  }

  // Add a staff/court-owner account (owner only). Defaults to 'staff'.
  function addManager(data) {
    const accounts = getAccounts();
    const exists = accounts.find((a) => a.username === data.username);
    if (exists) return { success: false, message: 'Username already exists.' };
    const role = ROLES.includes(data.role) ? data.role : 'staff';
    const newAccount = {
      id: 'acc_' + Date.now(),
      username: data.username,
      password: data.password,
      role,
      fullName: data.fullName,
      email: data.email,
      createdAt: new Date().toISOString(),
    };
    accounts.push(newAccount);
    saveAccounts(accounts);
    return { success: true, account: newAccount };
  }

  // Update account
  function updateAccount(id, data) {
    const accounts = getAccounts();
    const idx = accounts.findIndex((a) => a.id === id);
    if (idx === -1) return { success: false, message: 'Account not found.' };
    accounts[idx] = { ...accounts[idx], ...data };
    saveAccounts(accounts);
    return { success: true };
  }

  // Delete account
  function deleteAccount(id) {
    const accounts = getAccounts().filter((a) => a.id !== id);
    saveAccounts(accounts);
    return { success: true };
  }

  // Expose public API
  return { login, logout, getSession, requireAuth, hasRole, can, permissionsFor, getAccounts, addManager, updateAccount, deleteAccount, initAccounts, ROLES, ROLE_LABELS };
})();
