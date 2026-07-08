// =============================================
// SUPABASE CONFIGURATION
// Replace these with your actual project credentials.
// Find them at: Supabase Dashboard → Project Settings → API
// =============================================
const SUPABASE_URL = 'https://ikqfszhqpyayzroccegi.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_o4zS7E8WD-XnQWD9MQRtCA_6gPJf4-I';

// Initialize Supabase client (uses UMD global loaded from CDN)
const _sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// Expose globally so HTML pages can use real-time subscriptions
window._supabase = _sb;

const PB_IS_LOCAL_HOST = ['localhost', '127.0.0.1', '::1'].includes(location.hostname);
const PB_DATA_MODE_KEY = 'pb_data_mode';

if (PB_IS_LOCAL_HOST) {
  const params = new URLSearchParams(location.search);
  if (['1', 'true', 'local'].includes((params.get('localData') || '').toLowerCase())) {
    localStorage.setItem(PB_DATA_MODE_KEY, 'local');
  }
  if (['1', 'true', 'remote'].includes((params.get('remoteData') || '').toLowerCase())) {
    localStorage.removeItem(PB_DATA_MODE_KEY);
  }
}

window.PB_USE_LOCAL_DATA = PB_IS_LOCAL_HOST && localStorage.getItem(PB_DATA_MODE_KEY) === 'local';

const PB_FAST_CACHE_MS = {
  courts: 60000,
  settings: 30000,
  blockedDates: 30000,
  bookings: 3500,
  openPlay: 3500,
};
const _pbFastCache = new Map();

function _pbClone(value) {
  if (value == null) return value;
  try {
    if (typeof structuredClone === 'function') return structuredClone(value);
  } catch(_) {}
  try { return JSON.parse(JSON.stringify(value)); } catch(_) { return value; }
}

function _pbCacheKey(scope, params = {}) {
  const suffix = Object.entries(params || {})
    .filter(([, value]) => value !== undefined && value !== null && value !== '')
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, value]) => `${key}=${Array.isArray(value) ? value.join(',') : String(value)}`)
    .join('&');
  return suffix ? `${scope}:${suffix}` : scope;
}

async function _pbCached(scope, params, ttlMs, loader) {
  const key = _pbCacheKey(scope, params);
  const hit = _pbFastCache.get(key);
  const now = Date.now();
  if (hit?.promise) return _pbClone(await hit.promise);
  if (hit && now - hit.at < ttlMs) return _pbClone(hit.value);

  const promise = Promise.resolve()
    .then(loader)
    .then(value => {
      _pbFastCache.set(key, { at: Date.now(), value });
      return value;
    })
    .catch(err => {
      _pbFastCache.delete(key);
      throw err;
    });
  _pbFastCache.set(key, { at: now, promise });
  return _pbClone(await promise);
}

function _pbClearFastCache(scopes = []) {
  const list = Array.isArray(scopes) ? scopes.filter(Boolean) : [scopes].filter(Boolean);
  if (list.length === 0) { _pbFastCache.clear(); return; }
  for (const key of [..._pbFastCache.keys()]) {
    if (list.some(scope => key === scope || key.startsWith(`${scope}:`))) _pbFastCache.delete(key);
  }
}

function _safeJsonParse(v) {
  try { return JSON.parse(v); } catch(_) { return null; }
}

function _extractFnError(err, fallback = 'Edge Function request failed') {
  if (!err) return fallback;
  if (typeof err === 'string') return err;
  if (err.message) return String(err.message);
  if (err.error_description) return String(err.error_description);
  if (err.error) return String(err.error);
  if (err.context) {
    const parsed = _safeJsonParse(err.context);
    if (parsed?.error) return String(parsed.error);
    if (typeof err.context === 'string') return err.context;
  }
  try { return JSON.stringify(err); } catch(_) { return fallback; }
}

async function _invokePaymentSessionFallback(payload) {
  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/create-payment-session`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  let res;
  try {
    res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
  } catch (networkErr) {
    throw new Error(`Cannot reach Edge Function endpoint (${fnUrl}). ${_extractFnError(networkErr, 'Network error')}`);
  }

  const txt = await res.text();
  const json = _safeJsonParse(txt);
  if (!res.ok) {
    const reason = json?.error || txt || `HTTP ${res.status}`;
    throw new Error(`Edge Function HTTP ${res.status}: ${reason}`);
  }
  if (!json || json.ok !== true || !json.checkoutUrl) {
    throw new Error(`Invalid Edge Function response: ${txt || 'empty body'}`);
  }
  return json;
}

async function _invokeEdgeFunction(name, payload = {}, { allowFailure = false } = {}) {
  const { data, error } = await _sb.functions.invoke(name, { body: payload });
  if (!error && data) return data;

  const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/${name}`;
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;

  try {
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': authHeader,
      },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    const json = _safeJsonParse(txt) || {};
    if (!res.ok) throw new Error(json.error || txt || `HTTP ${res.status}`);
    return json;
  } catch (fallbackErr) {
    const reason = `${_extractFnError(error, 'Function invoke failed')}. ${_extractFnError(fallbackErr, 'Fallback call failed')}`;
    if (allowFailure) return { ok: false, error: reason };
    throw new Error(reason);
  }
}

async function _authRestHeaders(extra = {}) {
  const sess = await _sb.auth.getSession();
  const accessToken = sess?.data?.session?.access_token || '';
  return {
    apikey: SUPABASE_ANON_KEY,
    Authorization: `Bearer ${accessToken || SUPABASE_ANON_KEY}`,
    ...extra,
  };
}

function _bookingEmailPayload(b) {
  const items = Array.isArray(b.items) && b.items.length
    ? b.items
    : Array.isArray(b.groupItems) && b.groupItems.length
      ? b.groupItems
      : [];
  return {
    bookingRef: b.displayRef || b.ref,
    email: b.email,
    fullName: b.fullName,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.downpayment || Math.round((b.total || 0) * 0.5),
    contactNumber: b.contactNumber,
    bookingItems: items.map(item => ({
      courtName: item.courtName,
      date: item.date,
      startTime: item.startTime,
      endTime: item.endTime,
      duration: item.duration,
      total: item.total,
      downpayment: item.downpayment,
    })),
  };
}

function _telegramBookingPayload(b, extras = {}) {
  return {
    bookingRef: b.ref,
    fullName: b.fullName,
    contactNumber: b.contactNumber,
    courtName: b.courtName,
    date: b.date,
    startTime: b.startTime,
    endTime: b.endTime,
    duration: b.duration,
    total: b.total,
    downpayment: b.downpayment || Math.round((b.total || 0) * 0.5),
    paymentMethod: b.paymentMethod,
    paymentStatus: b.paymentStatus,
    bookingStatus: b.status,
    gcashRef: b.gcashRef || null,
    ...extras,
  };
}

// =============================================
// ROW ↔ JS OBJECT MAPPING
// SQL uses snake_case; JS objects use camelCase
// =============================================
const PB_DIGITAL_PAYMENT_METHODS = ['gcash', 'bdopay', 'maya', 'bpi', 'gotyme', 'pnb'];

function normalizePaymentKey(value, fallback = '') {
  return String(value || fallback || '').toLowerCase().trim();
}

function receivedAccountForBooking(b = {}) {
  const explicit = normalizePaymentKey(b.receivedAccount || b.received_account);
  if (explicit) return explicit;

  const method = normalizePaymentKey(b.paymentMethod || b.payment_method, 'cash');
  if (method === 'cash') return 'cash';
  return 'gcash';
}

function _fmtBookingHour(h) {
  const hour = Number(h);
  if (!Number.isFinite(hour)) return '';
  const normalized = ((hour % 24) + 24) % 24;
  const labelHour = normalized % 12 || 12;
  const suffix = normalized < 12 ? 'AM' : 'PM';
  return `${labelHour}:00 ${suffix}`;
}

function _bookingSlotsTimeLabel(slots, fallbackStart = '', fallbackEnd = '') {
  const sorted = [...(slots || [])].map(Number).filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return fallbackStart && fallbackEnd ? `${fallbackStart} - ${fallbackEnd}` : '';
  const groups = [];
  sorted.forEach(h => {
    const last = groups[groups.length - 1];
    if (last && h === last.end) last.end = h + 1;
    else groups.push({ start: h, end: h + 1 });
  });
  return groups.map(g => `${_fmtBookingHour(g.start)} - ${_fmtBookingHour(g.end)}`).join(', ');
}

function rowToBooking(r) {
  const slots = r.slots || [];
  return {
    ref:           r.ref,
    groupRef:      r.booking_group_ref || null,
    fullName:      r.full_name,
    contactNumber: r.contact_number,
    email:         r.email,
    courtId:       r.court_id,
    courtName:     r.court_name,
    date:          r.date,
    slots,
    startTime:     r.start_time,
    endTime:       r.end_time,
    timeLabel:     _bookingSlotsTimeLabel(slots, r.start_time, r.end_time),
    duration:      r.duration,
    rate:          r.rate,
    total:         r.total,
    paymentMethod: r.payment_method,
    receivedAccount: receivedAccountForBooking(r),
    paymentFlow:   r.payment_flow || null,
    paymentStatus: r.payment_status || 'unpaid',
    paymentProvider: r.payment_provider || null,
    paymentSessionId: r.payment_session_id || null,
    paymentCheckoutUrl: r.payment_checkout_url || null,
    paidAt:        r.paid_at || null,
    gcashRef:      r.gcash_ref || null,
    downpayment:   r.downpayment || null,
    receiptStatus:     r.receipt_status || 'none',
    receiptFlags:      r.receipt_flags || [],
    receiptExtracted:  r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptImageUrl:   r.receipt_image_url || null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    billedAt:      r.billed_at || null,
    weeklyFeeId:   r.weekly_fee_id || null,
    confirmationEmailId: r.confirmation_email_id || null,
    confirmationEmailSentAt: r.confirmation_email_sent_at || null,
    confirmationEmailLastEvent: r.confirmation_email_last_event || null,
    status:        r.status,
    createdAt:     r.created_at,
  };
}

function archivePayloadToBooking(payload) {
  if (!payload || typeof payload !== 'object') return null;
  return Object.prototype.hasOwnProperty.call(payload, 'full_name') || Object.prototype.hasOwnProperty.call(payload, 'court_id')
    ? rowToBooking(payload)
    : payload;
}

function rowToDeletedBookingArchive(r) {
  return {
    id: r.id,
    bookingRef: r.booking_ref,
    source: r.source,
    originalBooking: archivePayloadToBooking(r.original_booking),
    originalBookingRow: r.original_booking || null,
    recoveredBooking: archivePayloadToBooking(r.recovered_booking),
    recoveredBookingRow: r.recovered_booking || null,
    recoveryStatus: r.recovery_status,
    recoveredFrom: r.recovered_from,
    notes: r.notes,
    deletedAt: r.deleted_at,
    archivedAt: r.archived_at,
    restoredAt: r.restored_at,
    restoredBy: r.restored_by,
    createdAt: r.created_at,
  };
}

const PB_RESERVATION_HOLD_MINUTES = 15;

function bookingHoldsSlotForConflict(b) {
  if (!b || b.status === 'cancelled') return false;
  if (b.status !== 'verifying') return true;

  const created = b.created_at || b.createdAt;
  if (!created) return true;

  const createdMs = new Date(created).getTime();
  if (!Number.isFinite(createdMs)) return true;

  return (Date.now() - createdMs) < PB_RESERVATION_HOLD_MINUTES * 60 * 1000;
}

function hasSlotConflict(existingBookings, booking) {
  const requested = new Set((booking.slots || []).map(Number));
  if (requested.size === 0) return false;

  return (existingBookings || [])
    .filter(bookingHoldsSlotForConflict)
    .flatMap(b => b.slots || [])
    .some(slot => requested.has(Number(slot)));
}

function bookingToRow(b) {
  return {
    ref:            b.ref,
    booking_group_ref: b.groupRef || null,
    full_name:      b.fullName,
    contact_number: b.contactNumber,
    email:          b.email,
    court_id:       b.courtId,
    court_name:     b.courtName,
    date:           b.date,
    slots:          b.slots,
    start_time:     b.startTime,
    end_time:       b.endTime,
    duration:       b.duration,
    rate:           b.rate,
    total:          b.total,
    payment_method: b.paymentMethod,
    received_account: receivedAccountForBooking(b),
    payment_flow:   b.paymentFlow || null,
    payment_status: b.paymentStatus || 'unpaid',
    payment_provider: b.paymentProvider || null,
    payment_session_id: b.paymentSessionId || null,
    payment_checkout_url: b.paymentCheckoutUrl || null,
    paid_at:        b.paidAt || null,
    gcash_ref:      b.gcashRef || null,
    downpayment:    b.downpayment || null,
    status:         b.status,
    created_at:     b.createdAt,
  };
}

function rowToCourt(r) {
  return {
    id:           r.id,
    name:         r.name,
    desc:         r.description,
    rate:         r.rate,
    blocked:      r.blocked,
    feats:        r.feats || [],
    photo:        r.photo || '',
    rateSchedule: r.rate_schedule || null,
  };
}

function courtToRow(c) {
  return {
    id:            c.id,
    name:          c.name,
    description:   c.desc,
    rate:          c.rate,
    blocked:       c.blocked,
    feats:         c.feats || [],
    photo:         c.photo || null,
    rate_schedule: c.rateSchedule || null,
  };
}

function rowToAccount(r) {
  return {
    id:        r.id,
    username:  r.username,
    role:      r.role,
    fullName:  r.full_name,
    email:     r.email,
    createdAt: r.created_at,
  };
}

function accountToRow(a) {
  return {
    id:         a.id,
    username:   a.username,
    role:       a.role,
    full_name:  a.fullName,
    email:      a.email,
    created_at: a.createdAt,
  };
}

function rowToOpenPlayHostApplication(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    contactNumber: r.contact_number,
    email: r.email,
    preferredSchedule: r.preferred_schedule || '',
    notes: r.notes || '',
    status: r.status || 'pending',
    reviewedBy: r.reviewed_by || null,
    reviewedAt: r.reviewed_at || null,
    reviewNote: r.review_note || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostApplicationToRow(app) {
  return {
    full_name: app.fullName,
    contact_number: app.contactNumber,
    email: app.email,
    preferred_schedule: app.preferredSchedule || null,
    notes: app.notes || null,
    status: app.status || 'pending',
    review_note: app.reviewNote || null,
  };
}

function rowToOpenPlayHostSession(r) {
  return {
    id: r.id,
    hostUserId: r.host_user_id || null,
    hostName: r.host_name,
    hostEmail: r.host_email || '',
    title: r.title,
    date: r.date,
    startHour: Number(r.start_hour),
    endHour: Number(r.end_hour),
    courtIds: r.court_ids || [],
    courtNames: r.court_names || [],
    maxPlayers: Number(r.max_players || 0),
    feePerPlayer: Number(r.fee_per_player || 0),
    status: r.status || 'published',
    notes: r.notes || '',
    paymentInstructions: r.payment_instructions || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

function hostSessionToRow(session) {
  return {
    host_user_id: session.hostUserId || null,
    host_name: session.hostName,
    host_email: session.hostEmail || null,
    title: session.title,
    date: session.date,
    start_hour: session.startHour,
    end_hour: session.endHour,
    court_ids: session.courtIds || [],
    court_names: session.courtNames || [],
    max_players: session.maxPlayers || 16,
    fee_per_player: session.feePerPlayer || 0,
    status: session.status || 'published',
    notes: session.notes || null,
    payment_instructions: session.paymentInstructions || null,
  };
}

function rowToOpenPlayHostSessionRegistration(r) {
  return {
    id: r.id,
    sessionId: r.session_id,
    fullName: r.full_name,
    contactNumber: r.contact_number || '',
    paymentMethod: r.payment_method || 'gcash',
    gcashRef: r.gcash_ref || null,
    paymentStatus: r.payment_status || 'pending',
    amount: Number(r.amount || 0),
    receiptImageUrl: r.receipt_image_url || null,
    receiptImageHash: r.receipt_image_hash || null,
    receiptPhash: r.receipt_phash || null,
    receiptStatus: r.receipt_status || 'none',
    receiptFlags: r.receipt_flags || [],
    receiptExtracted: r.receipt_extracted || null,
    receiptConfidence: r.receipt_confidence != null ? Number(r.receipt_confidence) : null,
    receiptVerifiedAt: r.receipt_verified_at || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

// =============================================
// DB — Async Data Layer (replaces localStorage)
// =============================================
window.DB = {

  // ---- COURTS ----
  async getCourts() {
    return _pbCached('courts', {}, PB_FAST_CACHE_MS.courts, async () => {
      const { data, error } = await _sb.from('courts').select('*').order('id');
      if (error) { console.error('getCourts:', error); return []; }
      return data.map(rowToCourt);
    });
  },

  async saveCourt(court) {
    const { error } = await _sb.from('courts').upsert(courtToRow(court));
    if (error) { console.error('saveCourt:', error); throw error; }
    _pbClearFastCache(['courts']);
  },

  async deleteCourt(id) {
    const { error } = await _sb.from('courts').delete().eq('id', id);
    if (error) console.error('deleteCourt:', error);
    _pbClearFastCache(['courts']);
  },

  // ---- BOOKINGS ----
  async getBookings(filters = {}) {
    const opts = filters || {};
    return _pbCached('bookings', opts, PB_FAST_CACHE_MS.bookings, async () => {
      let query = _sb.from('bookings').select('*').order('created_at', { ascending: false });
      if (opts.date) query = query.eq('date', opts.date);
      if (opts.courtId) query = query.eq('court_id', String(opts.courtId));
      if (opts.activeOnly) query = query.neq('status', 'cancelled');
      const { data, error } = await query;
      if (error) { console.error('getBookings:', error); return []; }
      return data.map(rowToBooking);
    });
  },

  async addBooking(booking) {
    // Check for slot conflicts before inserting
    const { data: existing } = await _sb
      .from('bookings')
      .select('ref, status, slots, created_at')
      .eq('court_id', booking.courtId)
      .eq('date', booking.date)
      .neq('status', 'cancelled');

    if (hasSlotConflict(existing, booking)) {
      throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
    }

    const { error } = await _sb.from('bookings').insert(bookingToRow(booking));
    if (error) { console.error('addBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async getBookingByRef(ref) {
    const { data, error } = await _sb.from('bookings').select('*').eq('ref', ref).single();
    if (error) { console.error('getBookingByRef:', error); return null; }
    return rowToBooking(data);
  },

  async updateBooking(ref, updates) {
    // Map only the fields provided (camelCase → snake_case)
    const row = {};
    if (updates.status    !== undefined) row.status = updates.status;
    if (updates.groupRef  !== undefined) row.booking_group_ref = updates.groupRef;
    if (updates.fullName  !== undefined) row.full_name = updates.fullName;
    if (updates.contactNumber !== undefined) row.contact_number = updates.contactNumber;
    if (updates.email     !== undefined) row.email = updates.email;
    if (updates.total     !== undefined) row.total = updates.total;
    if (updates.paymentMethod !== undefined) row.payment_method = updates.paymentMethod;
    if (updates.receivedAccount !== undefined) row.received_account = receivedAccountForBooking(updates);
    else if (updates.paymentMethod !== undefined) row.received_account = receivedAccountForBooking(updates);
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.paymentFlow !== undefined) row.payment_flow = updates.paymentFlow;
    if (updates.paymentProvider !== undefined) row.payment_provider = updates.paymentProvider;
    if (updates.paymentSessionId !== undefined) row.payment_session_id = updates.paymentSessionId;
    if (updates.paymentCheckoutUrl !== undefined) row.payment_checkout_url = updates.paymentCheckoutUrl;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.gcashRef !== undefined) row.gcash_ref = updates.gcashRef;
    if (updates.downpayment !== undefined) row.downpayment = updates.downpayment;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startTime !== undefined) row.start_time = updates.startTime;
    if (updates.endTime !== undefined) row.end_time = updates.endTime;
    if (updates.duration !== undefined) row.duration = updates.duration;
    if (updates.slots !== undefined) row.slots = updates.slots;
    if (updates.billedAt !== undefined) row.billed_at = updates.billedAt;
    if (updates.weeklyFeeId !== undefined) row.weekly_fee_id = updates.weeklyFeeId;
    if (updates.receiptImageUrl !== undefined) row.receipt_image_url = updates.receiptImageUrl;
    if (updates.receiptImageHash !== undefined) row.receipt_image_hash = updates.receiptImageHash;
    if (updates.receiptPhash !== undefined) row.receipt_phash = updates.receiptPhash;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    if (updates.confirmationEmailId !== undefined) row.confirmation_email_id = updates.confirmationEmailId;
    if (updates.confirmationEmailSentAt !== undefined) row.confirmation_email_sent_at = updates.confirmationEmailSentAt;
    if (updates.confirmationEmailLastEvent !== undefined) row.confirmation_email_last_event = updates.confirmationEmailLastEvent;
    const { error } = await _sb.from('bookings').update(row).eq('ref', ref);
    if (error) { console.error('updateBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  // Stamp a set of bookings as billed on a given weekly statement (idempotent
  // audit trail; a booking is only ever billed once).
  async markBookingsBilled(refs, weeklyFeeId) {
    if (!Array.isArray(refs) || refs.length === 0) return;
    const { error } = await _sb.from('bookings')
      .update({ billed_at: new Date().toISOString(), weekly_fee_id: weeklyFeeId })
      .in('ref', refs);
    if (error) { console.error('markBookingsBilled:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async deleteBooking(ref) {
    const { error } = await _sb.from('bookings').delete().eq('ref', ref);
    if (error) { console.error('deleteBooking:', error); throw error; }
    _pbClearFastCache(['bookings']);
  },

  async getDeletedBookingArchive(filters = {}) {
    const opts = filters || {};
    let query = _sb
      .from('deleted_booking_archive')
      .select('*')
      .order('deleted_at', { ascending: false })
      .limit(Number(opts.limit || 250));
    if (opts.status) query = query.eq('recovery_status', opts.status);
    if (opts.bookingRef) query = query.eq('booking_ref', opts.bookingRef);
    const { data, error } = await query;
    if (error) { console.error('getDeletedBookingArchive:', error); throw error; }
    return (data || []).map(rowToDeletedBookingArchive);
  },

  async restoreDeletedBookingArchive(id) {
    const { data, error } = await _sb.rpc('restore_deleted_booking_archive', { p_archive_id: id });
    if (error) { console.error('restoreDeletedBookingArchive:', error); throw error; }
    _pbClearFastCache(['bookings']);
    return data ? rowToBooking(data) : null;
  },

  // ---- OPEN PLAY REGISTRATIONS ----
  async getOpenPlayRegistrations() {
    return _pbCached('openPlayRegistrations', {}, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.from('open_play_registrations').select('*').order('created_at', { ascending: false });
      if (error) { console.error('getOpenPlayRegistrations:', error); return []; }
      return data;
    });
  },

  async addOpenPlayRegistration(reg) {
    const { error } = await _sb.from('open_play_registrations').insert({
      full_name: reg.fullName,
      court_id: String(reg.courtId),
      court_name: reg.courtName,
      date: reg.date,
      hour: reg.hour,
      time_label: reg.timeLabel,
      payment_type: reg.paymentType,
      payment_method: reg.paymentMethod || 'cash',
      gcash_ref: reg.gcashRef || null,
      payment_status: reg.paymentStatus || 'pending',
      amount: reg.amount,
      receipt_image_url: reg.receiptImageUrl || null,
      receipt_image_hash: reg.receiptImageHash || null,
      receipt_phash: reg.receiptPhash || null,
      receipt_status: reg.receiptStatus || 'none',
      receipt_flags: reg.receiptFlags || [],
      receipt_extracted: reg.receiptExtracted || null,
      receipt_confidence: reg.receiptConfidence ?? null,
      receipt_verified_at: reg.receiptVerifiedAt || null,
      created_at: new Date().toISOString(),
    });
    if (error) { console.error('addOpenPlayRegistration:', error); throw error; }
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  async updateOpenPlayRegistration(id, updates) {
    const row = {};
    if (updates.paymentStatus !== undefined) row.payment_status = updates.paymentStatus;
    if (updates.gcashRef      !== undefined) row.gcash_ref      = updates.gcashRef;
    if (updates.receiptImageUrl !== undefined) row.receipt_image_url = updates.receiptImageUrl;
    if (updates.receiptImageHash !== undefined) row.receipt_image_hash = updates.receiptImageHash;
    if (updates.receiptPhash !== undefined) row.receipt_phash = updates.receiptPhash;
    if (updates.receiptStatus !== undefined) row.receipt_status = updates.receiptStatus;
    if (updates.receiptFlags !== undefined) row.receipt_flags = updates.receiptFlags;
    if (updates.receiptExtracted !== undefined) row.receipt_extracted = updates.receiptExtracted;
    if (updates.receiptConfidence !== undefined) row.receipt_confidence = updates.receiptConfidence;
    if (updates.receiptVerifiedAt !== undefined) row.receipt_verified_at = updates.receiptVerifiedAt;
    const { error } = await _sb.from('open_play_registrations').update(row).eq('id', id);
    if (error) { console.error('updateOpenPlayRegistration:', error); throw error; }
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  async getOpenPlayCountForDate(date, courtId = null) {
    return _pbCached('openPlayCount', { date, courtId: courtId || '' }, PB_FAST_CACHE_MS.openPlay, async () => {
      let query = _sb.from('open_play_registrations')
        .select('*', { count: 'exact', head: true })
        .eq('date', date)
        .or('payment_status.is.null,payment_status.neq.rejected');
      if (courtId) query = query.eq('court_id', String(courtId));
      const { count, error } = await query;
      if (error) { console.error('getOpenPlayCountForDate:', error); return 0; }
      return count || 0;
    });
  },

  async getOpenPlayCountsForDate(date) {
    return _pbCached('openPlayCounts', { date }, PB_FAST_CACHE_MS.openPlay, async () => {
      const { data, error } = await _sb.from('open_play_registrations')
        .select('court_id')
        .eq('date', date)
        .or('payment_status.is.null,payment_status.neq.rejected');
      if (error) { console.error('getOpenPlayCountsForDate:', error); return {}; }
      return (data || []).reduce((counts, row) => {
        const key = String(row.court_id || '');
        counts[key] = (counts[key] || 0) + 1;
        return counts;
      }, {});
    });
  },

  async deleteOpenPlayRegistration(id) {
    const { error } = await _sb.from('open_play_registrations').delete().eq('id', id);
    if (error) console.error('deleteOpenPlayRegistration:', error);
    _pbClearFastCache(['openPlayRegistrations', 'openPlayCount', 'openPlayCounts']);
  },

  // ---- OPEN PLAY HOSTS ----
  async getOpenPlayHostApplications() {
    const { data, error } = await _sb.from('open_play_host_applications').select('*').order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayHostApplications:', error); return []; }
    return (data || []).map(rowToOpenPlayHostApplication);
  },

  async addOpenPlayHostApplication(app) {
    const { error } = await _sb.from('open_play_host_applications').insert({
      ...hostApplicationToRow(app),
      status: 'pending',
      created_at: new Date().toISOString(),
    });
    if (error) { console.error('addOpenPlayHostApplication:', error); throw error; }
  },

  async updateOpenPlayHostApplication(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.reviewNote !== undefined) row.review_note = updates.reviewNote;
    if (updates.reviewedBy !== undefined) row.reviewed_by = updates.reviewedBy;
    if (updates.reviewedAt !== undefined) row.reviewed_at = updates.reviewedAt;
    const { data, error } = await _sb.from('open_play_host_applications').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostApplication:', error); throw error; }
    return data ? rowToOpenPlayHostApplication(data) : null;
  },

  async getOpenPlayHostSessions() {
    const { data, error } = await _sb.from('open_play_host_sessions').select('*').order('date', { ascending: true }).order('start_hour', { ascending: true });
    if (error) { console.error('getOpenPlayHostSessions:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSession);
  },

  async createOpenPlayHostSession(session) {
    const { data, error } = await _sb.from('open_play_host_sessions').insert(hostSessionToRow(session)).select('*').single();
    if (error) { console.error('createOpenPlayHostSession:', error); throw error; }
    return rowToOpenPlayHostSession(data);
  },

  async updateOpenPlayHostSession(id, updates) {
    const row = {};
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.title !== undefined) row.title = updates.title;
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.startHour !== undefined) row.start_hour = updates.startHour;
    if (updates.endHour !== undefined) row.end_hour = updates.endHour;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.maxPlayers !== undefined) row.max_players = updates.maxPlayers;
    if (updates.feePerPlayer !== undefined) row.fee_per_player = updates.feePerPlayer;
    if (updates.notes !== undefined) row.notes = updates.notes;
    if (updates.paymentInstructions !== undefined) row.payment_instructions = updates.paymentInstructions;
    const { data, error } = await _sb.from('open_play_host_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayHostSession:', error); throw error; }
    return data ? rowToOpenPlayHostSession(data) : null;
  },

  async getOpenPlayHostSessionRegistrations(sessionId = null) {
    let query = _sb.from('open_play_host_session_registrations').select('*').order('created_at', { ascending: false });
    if (sessionId) query = query.eq('session_id', sessionId);
    const { data, error } = await query;
    if (error) { console.error('getOpenPlayHostSessionRegistrations:', error); return []; }
    return (data || []).map(rowToOpenPlayHostSessionRegistration);
  },

  async getOpenPlayHostSessionRegistrationCount(sessionId) {
    const { data, error } = await _sb.rpc('count_open_play_host_session_registrations', { p_session_id: sessionId });
    if (error) { console.error('getOpenPlayHostSessionRegistrationCount:', error); return 0; }
    return Number(data || 0);
  },

  async addOpenPlayHostSessionRegistration(reg) {
    const { data, error } = await _sb.from('open_play_host_session_registrations').insert({
      session_id: reg.sessionId,
      full_name: reg.fullName,
      contact_number: reg.contactNumber || null,
      payment_method: reg.paymentMethod || 'gcash',
      gcash_ref: reg.gcashRef || null,
      payment_status: reg.paymentStatus || 'pending',
      amount: reg.amount || 0,
      receipt_image_url: reg.receiptImageUrl || null,
      receipt_image_hash: reg.receiptImageHash || null,
      receipt_phash: reg.receiptPhash || null,
      receipt_status: reg.receiptStatus || 'none',
      receipt_flags: reg.receiptFlags || [],
      receipt_extracted: reg.receiptExtracted || null,
      receipt_confidence: reg.receiptConfidence ?? null,
      receipt_verified_at: reg.receiptVerifiedAt || null,
    }).select('*').single();
    if (error) { console.error('addOpenPlayHostSessionRegistration:', error); throw error; }
    return rowToOpenPlayHostSessionRegistration(data);
  },

  // ---- OPEN PLAY GAME MANAGER ----
  async getOpenPlayGameSessions() {
    const { data, error } = await _sb.from('open_play_game_sessions').select('*').order('date', { ascending: false }).order('created_at', { ascending: false });
    if (error) { console.error('getOpenPlayGameSessions:', error); return []; }
    return data || [];
  },

  async createOpenPlayGameSession(session) {
    const row = {
      date: session.date,
      time_label: session.timeLabel || null,
      court_ids: session.courtIds || [],
      court_names: session.courtNames || [],
      mode: session.mode || 'smart_random_mixer',
      status: session.status || 'draft',
      current_round: session.currentRound || 0,
    };
    const { data, error } = await _sb.from('open_play_game_sessions').insert(row).select('*').single();
    if (error) { console.error('createOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async updateOpenPlayGameSession(id, updates) {
    const row = {};
    if (updates.date !== undefined) row.date = updates.date;
    if (updates.timeLabel !== undefined) row.time_label = updates.timeLabel;
    if (updates.courtIds !== undefined) row.court_ids = updates.courtIds;
    if (updates.courtNames !== undefined) row.court_names = updates.courtNames;
    if (updates.mode !== undefined) row.mode = updates.mode;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.currentRound !== undefined) row.current_round = updates.currentRound;
    const { data, error } = await _sb.from('open_play_game_sessions').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameSession:', error); throw error; }
    return data;
  },

  async getOpenPlayGamePlayers(sessionId) {
    const { data, error } = await _sb.from('open_play_game_players').select('*').eq('session_id', sessionId).order('seed_order');
    if (error) { console.error('getOpenPlayGamePlayers:', error); return []; }
    return data || [];
  },

  async replaceOpenPlayGamePlayers(sessionId, players) {
    const { error: delError } = await _sb.from('open_play_game_players').delete().eq('session_id', sessionId);
    if (delError) { console.error('replaceOpenPlayGamePlayers delete:', delError); throw delError; }
    if (!players.length) return [];
    const rows = players.map((p, i) => ({
      session_id: sessionId,
      full_name: p.fullName || p.full_name,
      source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
      status: p.status || 'active',
      seed_order: i,
    }));
    const { data, error } = await _sb.from('open_play_game_players').insert(rows).select('*').order('seed_order');
    if (error) { console.error('replaceOpenPlayGamePlayers insert:', error); throw error; }
    return data || [];
  },

  async getOpenPlayGameRounds(sessionId) {
    const { data, error } = await _sb.from('open_play_game_rounds').select('*').eq('session_id', sessionId).order('round_no');
    if (error) { console.error('getOpenPlayGameRounds:', error); return []; }
    return data || [];
  },

  async addOpenPlayGameRound(round) {
    const row = {
      session_id: round.sessionId,
      round_no: round.roundNo,
      assignments: round.assignments || [],
      queue_snapshot: round.queueSnapshot || [],
      partner_history: round.partnerHistory || {},
      opponent_history: round.opponentHistory || {},
      completed_at: round.completedAt || null,
    };
    const { data, error } = await _sb.from('open_play_game_rounds').insert(row).select('*').single();
    if (error) { console.error('addOpenPlayGameRound:', error); throw error; }
    await this.updateOpenPlayGameSession(round.sessionId, { currentRound: round.roundNo, status: 'active' }).catch(() => {});
    return data;
  },

  async updateOpenPlayGameRound(id, updates) {
    const row = {};
    if (updates.assignments !== undefined) row.assignments = updates.assignments;
    if (updates.queueSnapshot !== undefined) row.queue_snapshot = updates.queueSnapshot;
    if (updates.partnerHistory !== undefined) row.partner_history = updates.partnerHistory;
    if (updates.opponentHistory !== undefined) row.opponent_history = updates.opponentHistory;
    if (updates.completedAt !== undefined) row.completed_at = updates.completedAt;
    const { data, error } = await _sb.from('open_play_game_rounds').update(row).eq('id', id).select('*').single();
    if (error) { console.error('updateOpenPlayGameRound:', error); throw error; }
    return data;
  },

  async deleteLatestOpenPlayGameRound(sessionId) {
    const rounds = await this.getOpenPlayGameRounds(sessionId);
    const last = rounds[rounds.length - 1];
    if (!last) return null;
    const { error } = await _sb.from('open_play_game_rounds').delete().eq('id', last.id);
    if (error) { console.error('deleteLatestOpenPlayGameRound:', error); throw error; }
    await this.updateOpenPlayGameSession(sessionId, { currentRound: Math.max(0, Number(last.round_no || 1) - 1) }).catch(() => {});
    return last;
  },

  async clearOpenPlayGameRounds(sessionId) {
    const { error } = await _sb.from('open_play_game_rounds').delete().eq('session_id', sessionId);
    if (error) { console.error('clearOpenPlayGameRounds:', error); throw error; }
    await this.updateOpenPlayGameSession(sessionId, { currentRound: 0, status: 'draft' }).catch(() => {});
  },

  // ---- BLOCKED DATES ----
  async getBlockedDates() {
    return _pbCached('blockedDates', {}, PB_FAST_CACHE_MS.blockedDates, async () => {
      const { data, error } = await _sb.from('blocked_dates').select('date').order('date');
      if (error) { console.error('getBlockedDates:', error); return []; }
      return data.map(r => r.date);
    });
  },

  async addBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').insert({ date, created_at: new Date().toISOString() });
    if (error) console.error('addBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  async removeBlockedDate(date) {
    const { error } = await _sb.from('blocked_dates').delete().eq('date', date);
    if (error) console.error('removeBlockedDate:', error);
    _pbClearFastCache(['blockedDates']);
  },

  // ---- ACCOUNTS ----
  async getAccounts() {
    const { data, error } = await _sb.from('accounts').select('*').order('created_at');
    if (error) { console.error('getAccounts:', error); return []; }
    return data.map(rowToAccount);
  },

  async saveAccount(account) {
    const { error } = await _sb.from('accounts').upsert(accountToRow(account));
    if (error) { console.error('saveAccount:', error); throw error; }
  },

  async deleteAccount(id) {
    const { error } = await _sb.from('accounts').delete().eq('id', id);
    if (error) console.error('deleteAccount:', error);
  },

  // ---- SETTINGS ----
  async getSettings() {
    return _pbCached('settings', {}, PB_FAST_CACHE_MS.settings, async () => {
      const { data, error } = await _sb.from('settings').select('*');
      if (error) { console.error('getSettings:', error); return {}; }
      const out = {};
      data.forEach(r => out[r.key] = r.value);
      return out;
    });
  },

  async saveSetting(key, value) {
    const { error } = await _sb.from('settings').upsert({ key, value });
    if (error) { console.error('saveSetting:', error); throw error; }
    _pbClearFastCache(['settings']);
  },

  clearCache(scopes = []) {
    _pbClearFastCache(scopes);
  },

  async createPaymentSession(payload) {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
      throw new Error('Supabase configuration missing (SUPABASE_URL / SUPABASE_ANON_KEY).');
    }
    const { data, error } = await _sb.functions.invoke('create-payment-session', { body: payload });
    if (!error && data) return data;

    // Fallback path: direct HTTP call to the function endpoint. This helps diagnose
    // invoke-wrapper issues and still allows checkout if endpoint is reachable.
    try {
      return await _invokePaymentSessionFallback(payload);
    } catch (fallbackErr) {
      const baseReason = _extractFnError(error, 'Failed to send a request to the Edge Function');
      const fbReason = _extractFnError(fallbackErr, 'Fallback call failed');
      console.error('createPaymentSession.invokeError:', error);
      console.error('createPaymentSession.fallbackError:', fallbackErr);
      throw new Error(`${baseReason}. Fallback failed: ${fbReason}`);
    }
  },

  async sendConfirmationEmail(booking, options = {}) {
    if (!booking?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    return _invokeEdgeFunction('send-confirmation-email', _bookingEmailPayload(booking), {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendRescheduleEmail(payload, options = {}) {
    if (!payload?.email) return { ok: false, skipped: true, reason: 'No customer email' };
    return _invokeEdgeFunction('send-reschedule-email', payload, {
      allowFailure: !!options.allowFailure,
    });
  },

  async sendTelegramNotification(payload, options = {}) {
    return _invokeEdgeFunction('send-telegram-notification', payload, {
      allowFailure: options.allowFailure !== false,
    });
  },

  async notifyBookingSubmitted(booking) {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { event: 'new_booking' }), { allowFailure: true });
  },

  async notifyBookingUpdate(booking, event, note = '') {
    if (window.PB_USE_LOCAL_DATA) return { ok: true, skipped: true, reason: 'Local data mode' };
    return this.sendTelegramNotification(_telegramBookingPayload(booking, { type: 'booking_update', event, note }), { allowFailure: true });
  },

  async getIntegrationStatus() {
    return _invokeEdgeFunction('integration-status', { action: 'status' }, { allowFailure: true });
  },

  // Verify an uploaded GCash/GoTyme/PNB receipt image via the Edge Function.
  // payload: { bookingRef, provider, imageBase64, contentType }
  // Returns: { ok, status, flags, extracted, confidence, message }
  async verifyGcashReceipt(payload) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', { body: payload });
    if (!error && data) return data;

    // Fallback: direct HTTP call (mirrors createPaymentSession fallback).
    const fnUrl = `${SUPABASE_URL.replace(/\/+$/, '')}/functions/v1/verify-gcash-receipt`;
    const sess = await _sb.auth.getSession();
    const accessToken = sess?.data?.session?.access_token || '';
    const authHeader = accessToken ? `Bearer ${accessToken}` : `Bearer ${SUPABASE_ANON_KEY}`;
    const res = await fetch(fnUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'apikey': SUPABASE_ANON_KEY, 'Authorization': authHeader },
      body: JSON.stringify(payload),
    });
    const txt = await res.text();
    const json = _safeJsonParse(txt);
    if (!res.ok) throw new Error(json?.error || `HTTP ${res.status}`);
    return json;
  },

  // Request a short-lived signed URL to view a stored receipt (admin only).
  async getReceiptSignedUrl(bookingRef) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', bookingRef },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getOpenPlayReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', openPlayRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  async getHostSessionReceiptSignedUrl(registrationId) {
    const { data, error } = await _sb.functions.invoke('verify-gcash-receipt', {
      body: { action: 'sign', hostSessionRegistrationId: registrationId },
    });
    if (error) throw new Error(_extractFnError(error, 'Could not load receipt'));
    if (!data?.url) throw new Error(data?.error || 'No receipt available');
    return data.url;
  },

  // ---- SEED DEFAULT DATA (runs once on first load) ----
  async seedDefaultData() {
    const courts = await this.getCourts();
    if (courts.length === 0) {
      await _sb.from('courts').insert([
        { id: 'c1', name: 'Court Alpha', description: 'Outdoor · Air passing through · Standard Flooring', rate: 350, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
        { id: 'c2', name: 'Court Beta',  description: 'Outdoor · Air passing through · Standard Flooring', rate: 280, blocked: false, feats: ['Outdoor','Open Air','Standard Floor'], photo: null },
      ]);
    }
  },

  // Check if user has accepted the current agreement version
  async getAgreement(userId, version = 1) {
    const { data } = await _sb.from('agreements').select('id, full_name, agreed_at').eq('user_id', userId).eq('version', version).maybeSingle();
    return data || null;
  },

  // Save signed agreement
  async saveAgreement({ userId, email, fullName, role, signatureData, ipAddress, userAgent, version = 1 }) {
    const { error } = await _sb.from('agreements').upsert({
      user_id:        userId,
      email,
      full_name:      fullName,
      role,
      version,
      signature_data: signatureData,
      ip_address:     ipAddress || null,
      user_agent:     userAgent || null,
      agreed_at:      new Date().toISOString(),
    }, { onConflict: 'user_id,version' });
    if (error) throw error;
  },

  // ---- WEEKLY BILLING (system owner) ----
  async getWeeklyFees() {
    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?order=week_start.desc,created_at.desc`, {
        headers: await _authRestHeaders(),
      });
      if (!res.ok) {
        console.error('getWeeklyFees REST error:', res.status, res.statusText);
        return [];
      }
      return await res.json();
    } catch (err) {
      console.error('getWeeklyFees:', err);
      return [];
    }
  },

  async saveWeeklyFee(statement) {
    const row = {
      court_owner_user_id: statement.courtOwnerUserId,
      court_owner_email: statement.courtOwnerEmail || null,
      week_start: statement.weekStart,
      week_end: statement.weekEnd,
      bookings_count: statement.bookingsCount || 0,
      fee_per_booking: statement.feePerBooking,
      amount_due: statement.amountDue,
      billed_refs: statement.billedRefs || [],
      status: statement.status || 'sent',
      generated_at: statement.generatedAt || new Date().toISOString(),
      due_at: statement.dueAt || null,
      sent_at: statement.sentAt || null,
      paid_at: statement.paidAt || null,
      paid_ref: statement.paidRef || null,
      paid_note: statement.paidNote || null,
      paid_by_user_id: statement.paidByUserId || null,
    };

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees`, {
        method: 'POST',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
          Prefer: 'return=representation',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('saveWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
      const data = await res.json();
      return Array.isArray(data) ? data[0] : data;
    } catch (err) {
      console.error('saveWeeklyFee:', err);
      throw err;
    }
  },

  async updateWeeklyFee(id, updates) {
    const row = {};
    if (updates.courtOwnerUserId !== undefined) row.court_owner_user_id = updates.courtOwnerUserId;
    if (updates.courtOwnerEmail !== undefined) row.court_owner_email = updates.courtOwnerEmail;
    if (updates.status !== undefined) row.status = updates.status;
    if (updates.paidAt !== undefined) row.paid_at = updates.paidAt;
    if (updates.paidRef !== undefined) row.paid_ref = updates.paidRef;
    if (updates.paidNote !== undefined) row.paid_note = updates.paidNote;
    if (updates.paidByUserId !== undefined) row.paid_by_user_id = updates.paidByUserId;
    if (updates.sentAt !== undefined) row.sent_at = updates.sentAt;
    if (updates.dueAt !== undefined) row.due_at = updates.dueAt;
    if (updates.bookingsCount !== undefined) row.bookings_count = updates.bookingsCount;
    if (updates.amountDue !== undefined) row.amount_due = updates.amountDue;
    if (updates.feePerBooking !== undefined) row.fee_per_booking = updates.feePerBooking;
    if (updates.billedRefs !== undefined) row.billed_refs = updates.billedRefs;
    if (updates.generatedAt !== undefined) row.generated_at = updates.generatedAt;

    try {
      // Use REST API directly to bypass schema cache
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('updateWeeklyFee error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('updateWeeklyFee:', err);
      throw err;
    }
  },

  // Court owner submits a payment proof for their statement
  async submitWeeklyFeePayment(id, { submittedRef, submittedNote, submittedProofUrl }) {
    const row = {
      status: 'submitted',
      submitted_at: new Date().toISOString(),
      submitted_ref: submittedRef || null,
      submitted_note: submittedNote || null,
      submitted_proof_url: submittedProofUrl || null,
    };
    try {
      const res = await fetch(`${SUPABASE_URL}/rest/v1/weekly_fees?id=eq.${id}`, {
        method: 'PATCH',
        headers: await _authRestHeaders({
          'Content-Type': 'application/json',
        }),
        body: JSON.stringify(row),
      });
      if (!res.ok) {
        const errText = await res.text();
        console.error('submitWeeklyFeePayment error:', res.status, errText);
        throw new Error(`HTTP ${res.status}: ${errText}`);
      }
    } catch (err) {
      console.error('submitWeeklyFeePayment:', err);
      throw err;
    }
  },
};

// =============================================
// AUTH — Supabase Auth (email + password)
// Admin accounts are managed in Supabase Dashboard → Authentication → Users
// The accounts table stores role/display info linked by email.
// =============================================
// =============================================
// LOCAL DATA MODE
// Enable only on localhost with localStorage.setItem('pb_data_mode', 'local')
// or by opening a local page with ?localData=1. Disable with ?remoteData=1.
// =============================================
(function installLocalDataMode() {
  if (!window.PB_USE_LOCAL_DATA) return;

  const STORE_KEY = 'pb_local_db_v1';
  const nowIso = () => new Date().toISOString();
  const localRef = prefix => `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`.toUpperCase();

  const defaultCourts = () => Array.from({ length: 10 }, (_, i) => {
    const n = i + 1;
    return {
      id: `c${n}`,
      name: n === 1 ? 'Pickle Bliss Court' : `Court ${n}`,
      desc: 'Outdoor',
      rate: n <= 5 ? 60 : 90,
      blocked: false,
      feats: ['Outdoor'],
      photo: '',
      rateSchedule: [
        { from: 6, to: 18, rate: 60 },
        { from: 18, to: 23, rate: 90 },
      ],
    };
  });

  const defaultSettings = () => ({
    open_hour: '6',
    close_hour: '24',
    open_play_config: JSON.stringify({
      enabled: true,
      start: 6,
      end: 23,
      days: [0, 6],
      specificDates: ['2026-06-20'],
      courtIds: [],
      fee: 25,
      maxPlayers: 16,
    }),
    payment_acceptance_mode: 'full_payment_only',
    payment_method_cash: '0',
    payment_method_gcash: '1',
    payment_method_bdopay: '1',
    payment_method_maya: '1',
    payment_method_bpi: '1',
    payment_method_gotyme: '0',
    payment_method_pnb: '0',
    gcash_merchant_number: '09XXXXXXXXX',
    gcash_merchant_name: 'Court Owner Name',
    maya_merchant_number: '09XXXXXXXXX',
    maya_merchant_name: 'Court Owner Name',
    maya_qr_image: '',
    service_fee_rate: '15',
    maintenance_fee: '5',
    fee_type: 'per_hour',
  });

  const defaultAccounts = () => ([{
    id: 'owner_001',
    username: 'developer',
    password: 'dev123',
    role: 'owner',
    fullName: 'System Owner',
    email: 'owner@picklebliss.local',
    createdAt: nowIso(),
  }]);

  function freshDb() {
    return {
      courts: defaultCourts(),
      bookings: [],
      openPlayRegistrations: [],
      openPlayHostApplications: [],
      openPlayHostSessions: [],
      openPlayHostSessionRegistrations: [],
      openPlayGameSessions: [],
      openPlayGamePlayers: [],
      openPlayGameRounds: [],
      blockedDates: [],
      deletedBookingArchive: [],
      accounts: defaultAccounts(),
      settings: defaultSettings(),
      agreements: [],
      weeklyFees: [],
    };
  }

  function readDb() {
    const parsed = _safeJsonParse(localStorage.getItem(STORE_KEY));
    if (!parsed || typeof parsed !== 'object') {
      const db = freshDb();
      localStorage.setItem(STORE_KEY, JSON.stringify(db));
      return db;
    }
    return {
      ...freshDb(),
      ...parsed,
      settings: { ...defaultSettings(), ...(parsed.settings || {}) },
      courts: Array.isArray(parsed.courts) && parsed.courts.length ? parsed.courts : defaultCourts(),
      bookings: Array.isArray(parsed.bookings) ? parsed.bookings : [],
      openPlayRegistrations: Array.isArray(parsed.openPlayRegistrations) ? parsed.openPlayRegistrations : [],
      openPlayHostApplications: Array.isArray(parsed.openPlayHostApplications) ? parsed.openPlayHostApplications : [],
      openPlayHostSessions: Array.isArray(parsed.openPlayHostSessions) ? parsed.openPlayHostSessions : [],
      openPlayHostSessionRegistrations: Array.isArray(parsed.openPlayHostSessionRegistrations) ? parsed.openPlayHostSessionRegistrations : [],
      openPlayGameSessions: Array.isArray(parsed.openPlayGameSessions) ? parsed.openPlayGameSessions : [],
      openPlayGamePlayers: Array.isArray(parsed.openPlayGamePlayers) ? parsed.openPlayGamePlayers : [],
      openPlayGameRounds: Array.isArray(parsed.openPlayGameRounds) ? parsed.openPlayGameRounds : [],
      blockedDates: Array.isArray(parsed.blockedDates) ? parsed.blockedDates : [],
      deletedBookingArchive: Array.isArray(parsed.deletedBookingArchive) ? parsed.deletedBookingArchive : [],
      accounts: Array.isArray(parsed.accounts) && parsed.accounts.length ? parsed.accounts : defaultAccounts(),
      agreements: Array.isArray(parsed.agreements) ? parsed.agreements : [],
      weeklyFees: Array.isArray(parsed.weeklyFees) ? parsed.weeklyFees : [],
    };
  }

  function writeDb(db) {
    localStorage.setItem(STORE_KEY, JSON.stringify(db));
  }

  window.DB = {
    async getCourts() { return readDb().courts; },
    async saveCourt(court) {
      const db = readDb();
      const row = { ...court, id: String(court.id || localRef('court')).toLowerCase() };
      const idx = db.courts.findIndex(c => String(c.id) === String(row.id));
      if (idx >= 0) db.courts[idx] = { ...db.courts[idx], ...row };
      else db.courts.push(row);
      writeDb(db);
    },
    async deleteCourt(id) {
      const db = readDb();
      db.courts = db.courts.filter(c => String(c.id) !== String(id));
      writeDb(db);
    },

    async getBookings(filters = {}) {
      const opts = filters || {};
      return readDb().bookings
        .filter(b => !opts.date || b.date === opts.date)
        .filter(b => !opts.courtId || String(b.courtId) === String(opts.courtId))
        .filter(b => !opts.activeOnly || b.status !== 'cancelled')
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    },
    async addBooking(booking) {
      const db = readDb();
      const existing = db.bookings
        .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled');
      if (hasSlotConflict(existing, booking)) {
        throw new Error('One or more time slots are no longer available. Please refresh and choose a different time.');
      }
      const row = {
        ...booking,
        ref: booking.ref || localRef('PB'),
        receivedAccount: receivedAccountForBooking(booking),
        createdAt: booking.createdAt || nowIso(),
      };
      db.bookings.push(row);
      writeDb(db);
    },
    async getBookingByRef(ref) { return readDb().bookings.find(b => String(b.ref) === String(ref)) || null; },
    async updateBooking(ref, updates) {
      const db = readDb();
      db.bookings = db.bookings.map(b => {
        if (String(b.ref) !== String(ref)) return b;
        const next = { ...b, ...updates };
        if (updates.receivedAccount === undefined && updates.paymentMethod !== undefined) {
          next.receivedAccount = receivedAccountForBooking(next);
        }
        if (!next.receivedAccount) next.receivedAccount = receivedAccountForBooking(next);
        return next;
      });
      writeDb(db);
    },
    async markBookingsBilled(refs, weeklyFeeId) {
      if (!Array.isArray(refs) || refs.length === 0) return;
      const db = readDb();
      db.bookings = db.bookings.map(b => refs.includes(b.ref) ? { ...b, billedAt: nowIso(), weeklyFeeId } : b);
      writeDb(db);
    },
    async deleteBooking(ref) {
      const db = readDb();
      const existing = db.bookings.find(b => String(b.ref) === String(ref));
      if (existing) {
        db.deletedBookingArchive.unshift({
          id: localRef('del'),
          bookingRef: existing.ref,
          source: 'local_delete',
          originalBooking: { ...existing },
          originalBookingRow: { ...existing },
          recoveredBooking: null,
          recoveredBookingRow: null,
          recoveryStatus: 'deleted',
          recoveredFrom: null,
          notes: 'Automatically archived before local delete.',
          deletedAt: nowIso(),
          archivedAt: nowIso(),
          restoredAt: null,
          restoredBy: null,
          createdAt: nowIso(),
        });
      }
      db.bookings = db.bookings.filter(b => String(b.ref) !== String(ref));
      writeDb(db);
    },

    async getDeletedBookingArchive(filters = {}) {
      const opts = filters || {};
      return readDb().deletedBookingArchive
        .filter(r => !opts.status || r.recoveryStatus === opts.status)
        .filter(r => !opts.bookingRef || String(r.bookingRef) === String(opts.bookingRef))
        .sort((a, b) => String(b.deletedAt || '').localeCompare(String(a.deletedAt || '')))
        .slice(0, Number(opts.limit || 250));
    },

    async restoreDeletedBookingArchive(id) {
      const db = readDb();
      const idx = db.deletedBookingArchive.findIndex(r => String(r.id) === String(id));
      if (idx < 0) throw new Error('Deleted booking archive row not found.');
      const entry = db.deletedBookingArchive[idx];
      const booking = { ...(entry.originalBooking || entry.originalBookingRow || {}) };
      if (!booking.ref) throw new Error('Archive row has no booking reference.');
      if (db.bookings.some(b => String(b.ref) === String(booking.ref))) {
        throw new Error(`Booking ${booking.ref} already exists in active bookings.`);
      }
      const existing = db.bookings
        .filter(b => String(b.courtId) === String(booking.courtId) && b.date === booking.date && b.status !== 'cancelled');
      if (hasSlotConflict(existing, booking)) {
        throw new Error('Cannot restore because one or more slots are already booked.');
      }
      db.bookings.push(booking);
      db.deletedBookingArchive[idx] = {
        ...entry,
        recoveryStatus: 'restored',
        recoveredBooking: { ...booking },
        recoveredBookingRow: { ...booking },
        recoveredFrom: entry.recoveredFrom || 'archive_restore',
        restoredAt: nowIso(),
        restoredBy: Auth.getSession()?.id || null,
        notes: [entry.notes, 'Restored from deleted booking archive.'].filter(Boolean).join('\n'),
      };
      writeDb(db);
      return booking;
    },

    async getOpenPlayRegistrations() {
      return readDb().openPlayRegistrations.sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')));
    },
    async addOpenPlayRegistration(reg) {
      const db = readDb();
      db.openPlayRegistrations.push({
        id: localRef('op'),
        full_name: reg.fullName,
        court_id: String(reg.courtId),
        court_name: reg.courtName,
        date: reg.date,
        hour: reg.hour,
        time_label: reg.timeLabel,
        payment_type: reg.paymentType,
        payment_method: reg.paymentMethod || 'cash',
        gcash_ref: reg.gcashRef || null,
        payment_status: reg.paymentStatus || 'pending',
        amount: reg.amount,
        receipt_image_url: reg.receiptImageUrl || null,
        receipt_image_hash: reg.receiptImageHash || null,
        receipt_phash: reg.receiptPhash || null,
        receipt_status: reg.receiptStatus || 'none',
        receipt_flags: reg.receiptFlags || [],
        receipt_extracted: reg.receiptExtracted || null,
        receipt_confidence: reg.receiptConfidence ?? null,
        receipt_verified_at: reg.receiptVerifiedAt || null,
        created_at: nowIso(),
      });
      writeDb(db);
    },
    async updateOpenPlayRegistration(id, updates) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.map(r => {
        if (String(r.id) !== String(id)) return r;
        return {
          ...r,
          payment_status: updates.paymentStatus !== undefined ? updates.paymentStatus : r.payment_status,
          gcash_ref: updates.gcashRef !== undefined ? updates.gcashRef : r.gcash_ref,
          receipt_image_url: updates.receiptImageUrl !== undefined ? updates.receiptImageUrl : r.receipt_image_url,
          receipt_image_hash: updates.receiptImageHash !== undefined ? updates.receiptImageHash : r.receipt_image_hash,
          receipt_phash: updates.receiptPhash !== undefined ? updates.receiptPhash : r.receipt_phash,
          receipt_status: updates.receiptStatus !== undefined ? updates.receiptStatus : r.receipt_status,
          receipt_flags: updates.receiptFlags !== undefined ? updates.receiptFlags : r.receipt_flags,
          receipt_extracted: updates.receiptExtracted !== undefined ? updates.receiptExtracted : r.receipt_extracted,
          receipt_confidence: updates.receiptConfidence !== undefined ? updates.receiptConfidence : r.receipt_confidence,
          receipt_verified_at: updates.receiptVerifiedAt !== undefined ? updates.receiptVerifiedAt : r.receipt_verified_at,
        };
      });
      writeDb(db);
    },
    async getOpenPlayCountForDate(date, courtId = null) {
      return readDb().openPlayRegistrations.filter(r =>
        r.date === date &&
        (!courtId || String(r.court_id) === String(courtId)) &&
        r.payment_status !== 'rejected'
      ).length;
    },
    async getOpenPlayCountsForDate(date) {
      return readDb().openPlayRegistrations
        .filter(r => r.date === date && r.payment_status !== 'rejected')
        .reduce((counts, row) => {
          const key = String(row.court_id || '');
          counts[key] = (counts[key] || 0) + 1;
          return counts;
        }, {});
    },
    async deleteOpenPlayRegistration(id) {
      const db = readDb();
      db.openPlayRegistrations = db.openPlayRegistrations.filter(r => String(r.id) !== String(id));
      writeDb(db);
    },

    async getOpenPlayHostApplications() {
      return readDb().openPlayHostApplications.sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async addOpenPlayHostApplication(app) {
      const db = readDb();
      db.openPlayHostApplications.unshift({
        id: localRef('hostapp'),
        fullName: app.fullName,
        contactNumber: app.contactNumber,
        email: app.email,
        preferredSchedule: app.preferredSchedule || '',
        notes: app.notes || '',
        status: 'pending',
        reviewNote: '',
        reviewedBy: null,
        reviewedAt: null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      });
      writeDb(db);
    },
    async updateOpenPlayHostApplication(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostApplications = db.openPlayHostApplications.map(app => {
        if (String(app.id) !== String(id)) return app;
        saved = { ...app, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async getOpenPlayHostSessions() {
      return readDb().openPlayHostSessions.sort((a, b) =>
        String(a.date || '').localeCompare(String(b.date || '')) ||
        Number(a.startHour || a.start_hour || 0) - Number(b.startHour || b.start_hour || 0)
      );
    },
    async createOpenPlayHostSession(session) {
      const db = readDb();
      const row = {
        id: localRef('hosts'),
        hostUserId: session.hostUserId || null,
        hostName: session.hostName,
        hostEmail: session.hostEmail || '',
        title: session.title,
        date: session.date,
        startHour: session.startHour,
        endHour: session.endHour,
        courtIds: session.courtIds || [],
        courtNames: session.courtNames || [],
        maxPlayers: session.maxPlayers || 16,
        feePerPlayer: session.feePerPlayer || 0,
        status: session.status || 'published',
        notes: session.notes || '',
        paymentInstructions: session.paymentInstructions || '',
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayHostSession(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayHostSessions = db.openPlayHostSessions.map(session => {
        if (String(session.id) !== String(id)) return session;
        saved = { ...session, ...updates, updatedAt: nowIso() };
        return saved;
      });
      writeDb(db);
      return saved;
    },

    async getOpenPlayHostSessionRegistrations(sessionId = null) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => !sessionId || String(r.sessionId || r.session_id) === String(sessionId))
        .sort((a, b) => String(b.createdAt || b.created_at || '').localeCompare(String(a.createdAt || a.created_at || '')));
    },
    async getOpenPlayHostSessionRegistrationCount(sessionId) {
      return (readDb().openPlayHostSessionRegistrations || [])
        .filter(r => String(r.sessionId || r.session_id) === String(sessionId) && r.paymentStatus !== 'rejected' && r.payment_status !== 'rejected')
        .length;
    },
    async addOpenPlayHostSessionRegistration(reg) {
      const db = readDb();
      if (!Array.isArray(db.openPlayHostSessionRegistrations)) db.openPlayHostSessionRegistrations = [];
      const row = {
        id: localRef('hostreg'),
        sessionId: reg.sessionId,
        fullName: reg.fullName,
        contactNumber: reg.contactNumber || '',
        paymentMethod: reg.paymentMethod || 'gcash',
        gcashRef: reg.gcashRef || null,
        paymentStatus: reg.paymentStatus || 'pending',
        amount: reg.amount || 0,
        receiptImageUrl: reg.receiptImageUrl || null,
        receiptImageHash: reg.receiptImageHash || null,
        receiptPhash: reg.receiptPhash || null,
        receiptStatus: reg.receiptStatus || 'none',
        receiptFlags: reg.receiptFlags || [],
        receiptExtracted: reg.receiptExtracted || null,
        receiptConfidence: reg.receiptConfidence ?? null,
        receiptVerifiedAt: reg.receiptVerifiedAt || null,
        createdAt: nowIso(),
        updatedAt: nowIso(),
      };
      db.openPlayHostSessionRegistrations.unshift(row);
      writeDb(db);
      return row;
    },

    async getOpenPlayGameSessions() {
      return readDb().openPlayGameSessions.sort((a, b) =>
        String(b.date || '').localeCompare(String(a.date || '')) ||
        String(b.created_at || '').localeCompare(String(a.created_at || ''))
      );
    },
    async createOpenPlayGameSession(session) {
      const db = readDb();
      const row = {
        id: localRef('gm'),
        date: session.date,
        time_label: session.timeLabel || null,
        court_ids: session.courtIds || [],
        court_names: session.courtNames || [],
        mode: session.mode || 'smart_random_mixer',
        status: session.status || 'draft',
        current_round: session.currentRound || 0,
        created_at: nowIso(),
        updated_at: nowIso(),
      };
      db.openPlayGameSessions.unshift(row);
      writeDb(db);
      return row;
    },
    async updateOpenPlayGameSession(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayGameSessions = db.openPlayGameSessions.map(s => {
        if (String(s.id) !== String(id)) return s;
        saved = {
          ...s,
          date: updates.date !== undefined ? updates.date : s.date,
          time_label: updates.timeLabel !== undefined ? updates.timeLabel : s.time_label,
          court_ids: updates.courtIds !== undefined ? updates.courtIds : s.court_ids,
          court_names: updates.courtNames !== undefined ? updates.courtNames : s.court_names,
          mode: updates.mode !== undefined ? updates.mode : s.mode,
          status: updates.status !== undefined ? updates.status : s.status,
          current_round: updates.currentRound !== undefined ? updates.currentRound : s.current_round,
          updated_at: nowIso(),
        };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async getOpenPlayGamePlayers(sessionId) {
      return readDb().openPlayGamePlayers
        .filter(p => String(p.session_id) === String(sessionId))
        .sort((a, b) => Number(a.seed_order || 0) - Number(b.seed_order || 0));
    },
    async replaceOpenPlayGamePlayers(sessionId, players) {
      const db = readDb();
      db.openPlayGamePlayers = db.openPlayGamePlayers.filter(p => String(p.session_id) !== String(sessionId));
      const rows = players.map((p, i) => ({
        id: localRef('gmp'),
        session_id: sessionId,
        full_name: p.fullName || p.full_name,
        source_registration_id: p.sourceRegistrationId || p.source_registration_id || null,
        status: p.status || 'active',
        seed_order: i,
        created_at: nowIso(),
      }));
      db.openPlayGamePlayers.push(...rows);
      writeDb(db);
      return rows;
    },
    async getOpenPlayGameRounds(sessionId) {
      return readDb().openPlayGameRounds
        .filter(r => String(r.session_id) === String(sessionId))
        .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
    },
    async addOpenPlayGameRound(round) {
      const db = readDb();
      const row = {
        id: localRef('gmr'),
        session_id: round.sessionId,
        round_no: round.roundNo,
        assignments: round.assignments || [],
        queue_snapshot: round.queueSnapshot || [],
        partner_history: round.partnerHistory || {},
        opponent_history: round.opponentHistory || {},
        created_at: nowIso(),
        completed_at: round.completedAt || null,
      };
      db.openPlayGameRounds.push(row);
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(round.sessionId)
          ? { ...s, current_round: round.roundNo, status: 'active', updated_at: nowIso() }
          : s
      );
      writeDb(db);
      return row;
    },
    async updateOpenPlayGameRound(id, updates) {
      const db = readDb();
      let saved = null;
      db.openPlayGameRounds = db.openPlayGameRounds.map(r => {
        if (String(r.id) !== String(id)) return r;
        saved = {
          ...r,
          assignments: updates.assignments !== undefined ? updates.assignments : r.assignments,
          queue_snapshot: updates.queueSnapshot !== undefined ? updates.queueSnapshot : r.queue_snapshot,
          partner_history: updates.partnerHistory !== undefined ? updates.partnerHistory : r.partner_history,
          opponent_history: updates.opponentHistory !== undefined ? updates.opponentHistory : r.opponent_history,
          completed_at: updates.completedAt !== undefined ? updates.completedAt : r.completed_at,
        };
        return saved;
      });
      writeDb(db);
      return saved;
    },
    async deleteLatestOpenPlayGameRound(sessionId) {
      const db = readDb();
      const rounds = db.openPlayGameRounds
        .filter(r => String(r.session_id) === String(sessionId))
        .sort((a, b) => Number(a.round_no || 0) - Number(b.round_no || 0));
      const last = rounds[rounds.length - 1];
      if (!last) return null;
      db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.id) !== String(last.id));
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(sessionId)
          ? { ...s, current_round: Math.max(0, Number(last.round_no || 1) - 1), updated_at: nowIso() }
          : s
      );
      writeDb(db);
      return last;
    },
    async clearOpenPlayGameRounds(sessionId) {
      const db = readDb();
      db.openPlayGameRounds = db.openPlayGameRounds.filter(r => String(r.session_id) !== String(sessionId));
      db.openPlayGameSessions = db.openPlayGameSessions.map(s =>
        String(s.id) === String(sessionId)
          ? { ...s, current_round: 0, status: 'draft', updated_at: nowIso() }
          : s
      );
      writeDb(db);
    },

    async getBlockedDates() { return readDb().blockedDates; },
    async addBlockedDate(date) {
      const db = readDb();
      if (!db.blockedDates.includes(date)) db.blockedDates.push(date);
      db.blockedDates.sort();
      writeDb(db);
    },
    async removeBlockedDate(date) {
      const db = readDb();
      db.blockedDates = db.blockedDates.filter(d => d !== date);
      writeDb(db);
    },

    async getAccounts() { return readDb().accounts; },
    async saveAccount(account) {
      const db = readDb();
      const idx = db.accounts.findIndex(a => String(a.id) === String(account.id));
      if (idx >= 0) db.accounts[idx] = { ...db.accounts[idx], ...account };
      else db.accounts.push({ ...account, id: account.id || localRef('acc'), createdAt: account.createdAt || nowIso() });
      writeDb(db);
    },
    async deleteAccount(id) {
      const db = readDb();
      db.accounts = db.accounts.filter(a => String(a.id) !== String(id));
      writeDb(db);
    },

    async getSettings() { return readDb().settings; },
    async saveSetting(key, value) {
      const db = readDb();
      db.settings[key] = value;
      writeDb(db);
    },
    clearCache() {},

    async createPaymentSession() { throw new Error('Online checkout is disabled in local data mode.'); },
    async sendConfirmationEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendRescheduleEmail() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async sendTelegramNotification() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingSubmitted() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async notifyBookingUpdate() { return { ok: true, skipped: true, reason: 'Local data mode' }; },
    async getIntegrationStatus() {
      return {
        ok: true,
        local: true,
        services: [
          { id: 'email', label: 'Email confirmations', configured: false, required: ['RESEND_API_KEY'], missing: ['RESEND_API_KEY'], note: 'Local data mode' },
          { id: 'telegram', label: 'Telegram admin alerts', configured: false, required: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], missing: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_CHAT_ID'], note: 'Local data mode' },
          { id: 'payments', label: 'PayMongo checkout', configured: false, required: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], missing: ['PAYMONGO_SECRET_KEY', 'PAYMENT_SUCCESS_URL', 'PAYMENT_CANCEL_URL'], note: 'Local data mode' },
          { id: 'ocr', label: 'Receipt OCR', configured: false, required: ['GOOGLE_VISION_API_KEY'], missing: ['GOOGLE_VISION_API_KEY'], note: 'Local data mode' },
          { id: 'service_role', label: 'Server database access', configured: false, required: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], missing: ['SERVICE_ROLE_KEY or SUPABASE_SERVICE_ROLE_KEY'], note: 'Local data mode' },
        ],
      };
    },
    async verifyGcashReceipt() {
      return { ok: true, status: 'manual_review', flags: ['local_data_mode'], extracted: {}, confidence: 0, message: 'Local data mode: receipt OCR is not sent to Supabase.' };
    },
    async getReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },
    async getOpenPlayReceiptSignedUrl() { throw new Error('No stored receipt in local data mode.'); },

    async seedDefaultData() { readDb(); },
    async getAgreement(userId, version = 1) {
      return readDb().agreements.find(a => String(a.userId) === String(userId) && Number(a.version) === Number(version)) || null;
    },
    async saveAgreement(data) {
      const db = readDb();
      const version = data.version || 1;
      const idx = db.agreements.findIndex(a => String(a.userId) === String(data.userId) && Number(a.version || 1) === Number(version));
      const row = { ...data, version, agreedAt: nowIso() };
      if (idx >= 0) db.agreements[idx] = row;
      else db.agreements.push(row);
      writeDb(db);
    },
    async getWeeklyFees() { return readDb().weeklyFees; },
    async saveWeeklyFee(statement) {
      const db = readDb();
      const row = { ...statement, id: statement.id || localRef('fee'), generatedAt: statement.generatedAt || nowIso() };
      db.weeklyFees.unshift(row);
      writeDb(db);
      return row;
    },
    async updateWeeklyFee(id, updates) {
      const db = readDb();
      db.weeklyFees = db.weeklyFees.map(f => String(f.id) === String(id) ? { ...f, ...updates } : f);
      writeDb(db);
    },
    async submitWeeklyFeePayment(id, data) {
      await this.updateWeeklyFee(id, { ...data, status: 'submitted', submittedAt: nowIso() });
    },
  };

  window.PB_RESET_LOCAL_DATA = function resetLocalData() {
    localStorage.removeItem(STORE_KEY);
    return readDb();
  };

  console.info('[Pickle Bliss Court] Local data mode enabled. Supabase writes are bypassed in this browser.');
})();

window.Auth = {

  // ── Role model ──────────────────────────────────────────
  // owner       → System Owner   (full access: everything + accounts)
  // court_owner → Court Owner    (operations + payment settings, no account mgmt)
  // staff       → Court Staff    (front-desk: bookings, payment review, open play)
  ROLES: ['owner', 'court_owner', 'staff', 'host'],
  ROLE_LABELS: { owner: 'System Owner', court_owner: 'Court Owner', staff: 'Court Staff', host: 'Open Play Host' },
  ROLE_PERMISSIONS: {
    owner:       ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'accounts', 'booking_delete', 'export', 'settings', 'owner_only'],
    court_owner: ['dashboard', 'bookings', 'payment_review', 'reports', 'courts', 'open_play', 'host_open_play', 'maintenance', 'payments', 'export', 'settings', 'court_owner_only'],
    staff:       ['bookings', 'open_play', 'payment_review'],
    host:        ['host_open_play'],
  },

  permissionsFor(role) {
    return this.ROLE_PERMISSIONS[role] || [];
  },

  can(action, role) {
    const r = role || (this.getSession() && this.getSession().role);
    return this.permissionsFor(r).includes(action);
  },

  hasRole(role) {
    const sess = this.getSession();
    if (!sess) return false;
    if (sess.role === 'owner') return true; // system owner has all access
    return sess.role === role;
  },

  async refreshSessionFromAuth({ remember = null } = {}) {
    const { data: authData, error } = await _sb.auth.getUser();
    if (error || !authData?.user) return null;

    const { data: acc } = await _sb
      .from('accounts')
      .select('*')
      .eq('id', authData.user.id)
      .maybeSingle();

    const session = acc
      ? { ...rowToAccount(acc), loginAt: new Date().toISOString() }
      : {
          id: authData.user.id,
          email: authData.user.email,
          role: 'staff',
          fullName: authData.user.user_metadata?.full_name || 'Court Staff',
          loginAt: new Date().toISOString(),
        };

    const shouldRemember = remember === null ? localStorage.getItem('pb_remember') === '1' : !!remember;
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    const store = shouldRemember ? localStorage : sessionStorage;
    store.setItem('pb_session', JSON.stringify(session));
    if (shouldRemember) localStorage.setItem('pb_remember', '1');
    else localStorage.removeItem('pb_remember');
    return session;
  },

  async login(email, password, remember = false) {
    // Sign in via Supabase Auth — establishes a verified JWT session.
    const { data, error } = await _sb.auth.signInWithPassword({ email, password });
    if (error || !data.user) return { ok: false };
    const session = await this.refreshSessionFromAuth({ remember });
    return session ? { ok: true } : { ok: false };
  },

  getSession() {
    // Check localStorage first (remembered), then sessionStorage (tab-only).
    const s = localStorage.getItem('pb_session') || sessionStorage.getItem('pb_session');
    if (!s) return null;
    try { return JSON.parse(s); }
    catch (_) {
      localStorage.removeItem('pb_session');
      sessionStorage.removeItem('pb_session');
      return null;
    }
  },

  requireAuth() {
    const sess = this.getSession();
    if (!sess) { window.location.href = 'login.html'; return null; }
    return sess;
  },

  async logout() {
    await _sb.auth.signOut();
    sessionStorage.removeItem('pb_session');
    localStorage.removeItem('pb_session');
    localStorage.removeItem('pb_remember');
    window.location.href = 'login.html';
  },

  // Used by admin.html account management
  async getAll() {
    return DB.getAccounts();
  },

  async add(d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'create',
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account create failed.') };
    }
  },

  async update(id, d) {
    try {
      await _invokeEdgeFunction('manage-account', {
        action: 'update',
        id,
        fullName: d.fullName,
        username: d.username,
        email: d.email,
        password: d.password || '',
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
      });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account update failed.') };
    }
  },

  // Self-service password change for the currently signed-in user.
  // Verifies the current password first, then updates Supabase Auth (the source
  // of truth for login). Any signed-in role (owner / court_owner / staff) can use it.
  async changePassword(currentPassword, newPassword) {
    const sess = this.getSession();
    if (!sess || !sess.email) return { ok: false, msg: 'No active session. Please sign in again.' };
    if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };

    // Re-authenticate to confirm the current password is correct.
    const { error: authErr } = await _sb.auth.signInWithPassword({ email: sess.email, password: currentPassword });
    if (authErr) return { ok: false, msg: 'Current password is incorrect.' };

    // Update the password in Supabase Auth.
    const { error: updErr } = await _sb.auth.updateUser({ password: newPassword });
    if (updErr) return { ok: false, msg: updErr.message || 'Could not update password.' };

    return { ok: true };
  },

  async del(id) {
    try {
      await _invokeEdgeFunction('manage-account', { action: 'delete', id });
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: _extractFnError(e, 'Account delete failed.') };
    }
  },
};

if (window.PB_USE_LOCAL_DATA) {
  Object.assign(window.Auth, {
    async login(usernameOrEmail, password, remember = false) {
      const accounts = await DB.getAccounts();
      const user = accounts.find(a =>
        (a.username === usernameOrEmail || a.email === usernameOrEmail) &&
        (!a.password || a.password === password)
      );
      if (!user) return { ok: false };
      const session = { ...user, loginAt: new Date().toISOString(), isLocalData: true };
      const store = remember ? localStorage : sessionStorage;
      store.setItem('pb_session', JSON.stringify(session));
      if (remember) localStorage.setItem('pb_remember', '1');
      return { ok: true };
    },

    async logout() {
      sessionStorage.removeItem('pb_session');
      localStorage.removeItem('pb_session');
      localStorage.removeItem('pb_remember');
      window.location.href = 'login.html';
    },

    async add(d) {
      const all = await DB.getAccounts();
      if (all.find(x => x.username === d.username || x.email === d.email)) return { ok: false, msg: 'Username or email already exists.' };
      const acc = {
        id: `local_${Date.now().toString(36)}`,
        fullName: d.fullName,
        username: d.username,
        password: d.password,
        email: d.email,
        role: this.ROLES.includes(d.role) ? d.role : 'staff',
        createdAt: new Date().toISOString(),
      };
      await DB.saveAccount(acc);
      return { ok: true };
    },

    async changePassword(currentPassword, newPassword) {
      const sess = this.getSession();
      if (!sess) return { ok: false, msg: 'No active session. Please sign in again.' };
      const accounts = await DB.getAccounts();
      const user = accounts.find(a => String(a.id) === String(sess.id));
      if (user?.password && user.password !== currentPassword) return { ok: false, msg: 'Current password is incorrect.' };
      if (!newPassword || newPassword.length < 6) return { ok: false, msg: 'New password must be at least 6 characters.' };
      await DB.saveAccount({ ...user, password: newPassword });
      return { ok: true };
    },
  });
}
