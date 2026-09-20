(function (root, factory) {
  const api = factory(root);
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.PickleBlissAvailabilityGraphic = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function (root) {
  'use strict';

  const MANILA_TIME_ZONE = 'Asia/Manila';
  const FRESHNESS_LIMIT_MS = 3 * 60 * 1000;
  const DEFAULT_BOOKING_URL = 'https://pickleblisscourt.com/';
  const COURT_COLLATOR = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
  const FORMATS = Object.freeze({
    feed: Object.freeze({ width: 1080, height: 1350, label: 'Facebook post', short: 'POST' }),
    story: Object.freeze({ width: 1080, height: 1920, label: 'Facebook story', short: 'STORY' }),
  });
  const POSTER_LAYOUTS = Object.freeze({
    feed: Object.freeze({
      brandY: 34,
      heroTop: 153,
      cardsStart: 374,
      cardsEnd: 1024,
      footerY: 1040,
      safeTop: 0,
      safeBottom: 1350,
      footerContentBottom: 1342,
      capacity: 4,
    }),
    story: Object.freeze({
      brandY: 86,
      heroTop: 236,
      cardsStart: 530,
      cardsEnd: 1460,
      footerY: 1496,
      safeTop: 80,
      safeBottom: 1855,
      footerContentBottom: 1845,
      capacity: 4,
    }),
  });
  const QR_RENDER_CONFIG = Object.freeze({
    size: 231,
    margin: 4,
    errorCorrectionLevel: 'M',
    dark: '#050706',
    light: '#ffffff',
  });
  const FOOTER_LAYOUTS = Object.freeze({
    feed: Object.freeze({
      qrSize: QR_RENDER_CONFIG.size,
      qrCardX: 753,
      qrCardY: 1052,
      qrCardPadding: 12,
      qrLabelY: 1337,
      readyY: 1083,
      ctaY: 1150,
      urlY: 1212,
      updatedY: 1305,
      readyFontSize: 20,
      ctaFontSize: 58,
      urlFontSize: 48,
      updatedFontSize: 30,
      qrLabelFontSize: 20,
    }),
    story: Object.freeze({
      qrSize: QR_RENDER_CONFIG.size,
      qrCardX: 753,
      qrCardY: 1525,
      qrCardPadding: 12,
      qrLabelY: 1820,
      readyY: 1550,
      ctaY: 1625,
      urlY: 1690,
      updatedY: 1795,
      readyFontSize: 20,
      ctaFontSize: 60,
      urlFontSize: 48,
      updatedFontSize: 30,
      qrLabelFontSize: 20,
    }),
  });

  const state = {
    overlay: null,
    canvas: null,
    date: '',
    format: 'feed',
    page: 0,
    snapshot: null,
    courts: [],
    selectedCourtIds: new Set(),
    requestedCourtIds: [],
    options: {},
    busy: false,
    open: false,
    renderToken: 0,
    operationToken: 0,
    returnFocus: null,
    freshnessTimer: null,
    logoPromise: null,
    lastCaption: '',
    refreshPromise: null,
    outputPromise: null,
  };

  function number(value, fallback = 0) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : fallback;
  }

  function clamp(value, minimum, maximum) {
    return Math.max(minimum, Math.min(maximum, number(value)));
  }

  function text(value) {
    return String(value == null ? '' : value).trim();
  }

  function escapeHtml(value) {
    return text(value)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function unique(values) {
    return [...new Set((values || []).map(value => text(value)).filter(Boolean))];
  }

  function dateOnly(value) {
    const match = text(value).match(/^(\d{4}-\d{2}-\d{2})/);
    return match ? match[1] : '';
  }

  function manilaDateKey(value) {
    if (dateOnly(value)) return dateOnly(value);
    const parsed = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(parsed.getTime())) return '';
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: MANILA_TIME_ZONE,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(parsed);
  }

  function zonedMinutes(value, timeZone = MANILA_TIME_ZONE) {
    const parsed = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(parsed.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: text(timeZone) || MANILA_TIME_ZONE,
      hourCycle: 'h23',
      hour: '2-digit',
      minute: '2-digit',
    }).formatToParts(parsed);
    const values = Object.fromEntries(parts.map(part => [part.type, part.value]));
    const hour = Number(values.hour);
    const minute = Number(values.minute);
    return Number.isFinite(hour) && Number.isFinite(minute) ? hour * 60 + minute : null;
  }

  function isElapsedSlot(slot, snapshot) {
    const scheduleDate = dateOnly(snapshot?.date);
    const generated = new Date(snapshot?.generatedAt || '');
    if (!scheduleDate || Number.isNaN(generated.getTime())) return false;
    const timeZone = text(snapshot?.timezone) || MANILA_TIME_ZONE;
    const generatedDate = timeZone === MANILA_TIME_ZONE
      ? manilaDateKey(generated)
      : new Intl.DateTimeFormat('en-CA', {
          timeZone,
          year: 'numeric',
          month: '2-digit',
          day: '2-digit',
        }).format(generated);
    if (scheduleDate < generatedDate) return true;
    if (scheduleDate > generatedDate) return false;
    const currentMinutes = zonedMinutes(generated, timeZone);
    return currentMinutes != null && number(slot?.end) * 60 <= currentMinutes;
  }

  function minimumSelectableDate() {
    return manilaDateKey();
  }

  function selectableDate(value) {
    const requested = dateOnly(value);
    const minimum = minimumSelectableDate();
    return requested && requested >= minimum ? requested : minimum;
  }

  function parseClock(value, fallbackPeriod) {
    if (typeof value === 'number' && Number.isFinite(value)) return clamp(value, 0, 24);
    const source = text(value);
    if (!source) return null;
    if (/^\d{1,2}(?:\.\d+)?$/.test(source)) return clamp(Number(source), 0, 24);
    const match = source.match(/(?:^|\s)(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?(?:\s|$)/i);
    if (!match) return null;
    let hour = Number(match[1]);
    const minute = Number(match[2] || 0);
    const period = (match[3] || fallbackPeriod || '').toUpperCase();
    if (period) {
      hour %= 12;
      if (period === 'PM') hour += 12;
    }
    if (hour > 24 || minute > 59) return null;
    return clamp(hour + (minute / 60), 0, 24);
  }

  function parseLabelRange(label) {
    const source = text(label).replace(/\s+/g, ' ');
    const match = source.match(/(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?\s*(?:-|–|—|to)\s*(\d{1,2})(?::(\d{2}))?\s*(AM|PM)?/i);
    if (!match) return null;
    const firstPeriod = match[3] || match[6];
    const secondPeriod = match[6] || match[3];
    let start = parseClock(`${match[1]}:${match[2] || '00'} ${firstPeriod || ''}`);
    let end = parseClock(`${match[4]}:${match[5] || '00'} ${secondPeriod || ''}`);
    if (start == null || end == null) return null;
    if (end <= start) {
      if (!match[3] && match[6] && end + 12 > start) end += 12;
      else if (end === 0) end = 24;
      else end += 12;
    }
    return { start: clamp(start, 0, 24), end: clamp(end, 0, 24) };
  }

  function availabilityStatus(value, fallbackAvailable) {
    if (value === true) return 'available';
    if (value === false) return 'unavailable';
    const normalized = text(value).toLowerCase().replace(/[\s_-]+/g, '');
    if (['available', 'open', 'free', 'vacant', 'remaining'].includes(normalized)) return 'available';
    if (['unavailable', 'booked', 'blocked', 'closed', 'held', 'reserved', 'maintenance'].includes(normalized)) return 'unavailable';
    return fallbackAvailable ? 'available' : 'unavailable';
  }

  function normalizeSlot(raw, fallbackAvailable) {
    const source = raw && typeof raw === 'object' ? raw : { label: raw };
    const startLabel = text(source.startLabel ?? source.start_label);
    const endLabel = text(source.endLabel ?? source.end_label);
    const label = text(source.label ?? source.time_label ?? source.timeLabel ?? source.display ?? source.name)
      || (startLabel && endLabel ? `${startLabel}–${endLabel}` : text(raw));
    const rangeFromLabel = parseLabelRange(label);
    let start = parseClock(
      source.hour ?? source.start_hour ?? source.startHour ?? source.start_time ?? source.startTime ?? source.start ?? startLabel,
    );
    if (start == null && rangeFromLabel) start = rangeFromLabel.start;
    if (start == null) start = parseClock(label);
    if (start == null) return null;

    let end = parseClock(source.end_hour ?? source.endHour ?? source.end_time ?? source.endTime ?? source.end ?? endLabel);
    if (end == null && rangeFromLabel) end = rangeFromLabel.end;
    if (end == null) end = start + Math.max(0.25, number(source.duration ?? source.duration_hours ?? source.durationHours, 1));
    if (end <= start && start >= 12 && end <= 12) end += 12;
    end = clamp(end, start + 0.25, 24);

    const statusValue = source.status ?? source.state ?? source.availability_status ?? source.availabilityStatus ?? source.available;
    const statusReason = text(statusValue).toLowerCase().replace(/[\s_-]+/g, '');
    return {
      hour: start,
      start,
      end,
      label: label || `${formatHour(start)}–${formatHour(end)}`,
      status: availabilityStatus(statusValue, fallbackAvailable),
      reason: text(source.reason ?? source.block_reason ?? source.blockReason) ||
        (['booked', 'maintenance', 'blocked', 'closed', 'past', 'current'].includes(statusReason) ? statusReason : ''),
    };
  }

  function courtRows(raw) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const candidates = source.courts
      ?? source.court_availability
      ?? source.courtAvailability
      ?? source.availability_by_court
      ?? source.availabilityByCourt
      ?? source.data
      ?? [];
    if (Array.isArray(candidates)) return candidates;
    if (candidates && typeof candidates === 'object') {
      return Object.entries(candidates).map(([id, value]) => (
        value && typeof value === 'object' ? { id, ...value } : { id, name: id, slots: value }
      ));
    }
    return [];
  }

  function slotRows(court) {
    if (!court || typeof court !== 'object') return { values: [], fallbackAvailable: false };
    const explicit = court.slots ?? court.time_slots ?? court.timeSlots ?? court.availability;
    if (Array.isArray(explicit)) return { values: explicit, fallbackAvailable: false };
    const available = court.available_slots ?? court.availableSlots ?? court.remaining_slots ?? court.remainingSlots;
    if (Array.isArray(available)) return { values: available, fallbackAvailable: true };
    return { values: [], fallbackAvailable: false };
  }

  function normalizeSnapshot(raw, requestedDate) {
    const source = raw && typeof raw === 'object' ? raw : {};
    const rows = courtRows(source);
    const courts = rows.map((court, index) => {
      const row = court && typeof court === 'object' ? court : { name: court };
      const id = text(row.id ?? row.court_id ?? row.courtId ?? row.slug ?? index + 1) || String(index + 1);
      const name = text(row.name ?? row.court_name ?? row.courtName ?? row.label) || `Court ${index + 1}`;
      const { values, fallbackAvailable } = slotRows(row);
      const slots = values
        .map(value => normalizeSlot(value, fallbackAvailable))
        .filter(Boolean)
        .sort((a, b) => a.start - b.start || a.end - b.end);
      return { id, name, slots };
    }).sort((left, right) => (
      COURT_COLLATOR.compare(left.name, right.name)
      || COURT_COLLATOR.compare(String(left.id), String(right.id))
    ));

    return {
      generatedAt: text(source.generatedAt ?? source.generated_at ?? source.asOf ?? source.as_of ?? source.updatedAt ?? source.updated_at) || new Date().toISOString(),
      timezone: text(source.timezone ?? source.time_zone) || MANILA_TIME_ZONE,
      date: dateOnly(source.date ?? source.schedule_date ?? source.scheduleDate ?? requestedDate) || dateOnly(requestedDate) || manilaDateKey(),
      courts,
    };
  }

  function formatHour(value) {
    let hour = number(value);
    if (hour === 24) hour = 0;
    hour = ((hour % 24) + 24) % 24;
    const whole = Math.floor(hour);
    const minute = Math.round((hour - whole) * 60);
    const period = whole >= 12 ? 'PM' : 'AM';
    return `${whole % 12 || 12}${minute ? `:${String(minute).padStart(2, '0')}` : ''} ${period}`;
  }

  function formatRange(start, end) {
    const startLabel = formatHour(start);
    const endLabel = formatHour(end);
    const startPeriod = startLabel.slice(-2);
    const endPeriod = endLabel.slice(-2);
    const startHalfDay = Math.floor((((number(start) % 24) + 24) % 24) / 12);
    const endHalfDay = Math.floor(((((number(end) - .001) % 24) + 24) % 24) / 12);
    if (startPeriod === endPeriod && startHalfDay === endHalfDay) {
      return `${startLabel.slice(0, -3)}–${endLabel}`;
    }
    return `${startLabel}–${endLabel}`;
  }

  function formatPosterHour(value) {
    let hour = number(value);
    if (hour === 24) hour = 0;
    hour = ((hour % 24) + 24) % 24;
    const whole = Math.floor(hour);
    const minute = Math.round((hour - whole) * 60);
    const period = whole >= 12 ? 'PM' : 'AM';
    return `${whole % 12 || 12}:${String(minute).padStart(2, '0')} ${period}`;
  }

  function formatPosterRange(start, end) {
    const startLabel = formatPosterHour(start);
    const endLabel = formatPosterHour(end);
    const startPeriod = startLabel.slice(-2);
    const endPeriod = endLabel.slice(-2);
    const startHalfDay = Math.floor((((number(start) % 24) + 24) % 24) / 12);
    const endHalfDay = Math.floor(((((number(end) - .001) % 24) + 24) % 24) / 12);
    if (startPeriod === endPeriod && startHalfDay === endHalfDay) {
      return `${startLabel.slice(0, -3)}–${endLabel}`;
    }
    return `${startLabel}–${endLabel}`;
  }

  function mergeAvailableRanges(input) {
    const slots = Array.isArray(input) ? input : (input?.slots || []);
    const normalized = slots
      .map(slot => slot && typeof slot === 'object' && Number.isFinite(Number(slot.start ?? slot.hour))
        ? {
            start: number(slot.start ?? slot.hour),
            end: number(slot.end, number(slot.start ?? slot.hour) + 1),
            status: availabilityStatus(slot.status ?? slot.available, false),
          }
        : normalizeSlot(slot, false))
      .filter(slot => slot && slot.status === 'available' && slot.end > slot.start)
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const ranges = [];
    normalized.forEach(slot => {
      const previous = ranges[ranges.length - 1];
      if (previous && slot.start <= previous.end + 0.001) previous.end = Math.max(previous.end, slot.end);
      else ranges.push({ start: slot.start, end: slot.end });
    });
    return ranges.map(range => ({ ...range, label: formatRange(range.start, range.end) }));
  }

  function selectedSnapshot(snapshot, selectedIds) {
    const selected = new Set((selectedIds || []).map(String));
    return {
      ...(snapshot || normalizeSnapshot({}, state.date)),
      courts: (snapshot?.courts || []).filter(court => selected.size === 0 || selected.has(String(court.id))),
    };
  }

  function paginateSnapshot(snapshot, formatName = 'feed') {
    const format = FORMATS[formatName] ? formatName : 'feed';
    const capacity = POSTER_LAYOUTS[format].capacity;
    const normalized = normalizeSnapshot(snapshot, snapshot?.date);
    const courts = normalized.courts || [];
    if (!courts.length) return [{ ...normalized, courts: [] }];
    const pages = [];
    for (let courtStart = 0; courtStart < courts.length; courtStart += capacity) {
      const courtGroup = courts.slice(courtStart, courtStart + capacity);
      pages.push({ ...normalized, courts: courtGroup });
    }
    return pages;
  }

  function rangeGridLayout(rangeCount, bounds = {}, story = false) {
    const count = Math.max(0, Math.floor(number(rangeCount)));
    const x = number(bounds.x);
    const y = number(bounds.y);
    const width = Math.max(0, number(bounds.width));
    const height = Math.max(0, number(bounds.height));
    if (!count || !width || !height) {
      return { columns: 0, rows: 0, fontSize: 0, cells: [] };
    }

    // One column keeps the common one-to-three-window case effortless to scan.
    // Denser schedules expand across the card. The authoritative whole-hour
    // schedule can produce at most 12 alternating windows, rendered as 3 × 4.
    const columns = count <= 3 ? 1 : count <= 6 ? 2 : 3;
    const rows = Math.ceil(count / columns);
    const columnGap = columns > 1 ? (story ? 12 : 10) : 0;
    const rowGap = rows > 1 ? (story ? 8 : 6) : 0;
    const cellWidth = Math.max(0, (width - columnGap * (columns - 1)) / columns);
    const cellHeight = Math.max(0, (height - rowGap * (rows - 1)) / rows);
    const heightScale = columns === 1 ? .82 : .7;
    const fontSize = Math.floor(clamp(
      cellHeight * heightScale,
      story ? 18 : 16,
      story ? 34 : 32,
    ));
    const cells = Array.from({ length: count }, (_, index) => {
      const column = index % columns;
      const row = Math.floor(index / columns);
      return {
        x: x + column * (cellWidth + columnGap),
        y: y + row * (cellHeight + rowGap),
        width: cellWidth,
        height: cellHeight,
        column,
        row,
      };
    });
    return { columns, rows, fontSize, cells };
  }

  function outputFileName(date, formatName, pageIndex = 0, totalPages = 1) {
    const safeDate = dateOnly(date) || 'schedule';
    const format = FORMATS[formatName] ? formatName : 'feed';
    const suffix = totalPages > 1
      ? `-${String(pageIndex + 1).padStart(2, '0')}-of-${String(totalPages).padStart(2, '0')}`
      : '';
    return `pickle-bliss-availability-${safeDate}-${format}${suffix}.png`;
  }

  function snapshotAge(snapshot, now = Date.now()) {
    const generated = Date.parse(snapshot?.generatedAt || '');
    return Number.isFinite(generated) ? Math.max(0, number(now) - generated) : Infinity;
  }

  function isSnapshotStale(snapshot, now = Date.now()) {
    return !snapshot || snapshotAge(snapshot, now) > FRESHNESS_LIMIT_MS;
  }

  function formatDate(value, style = 'long') {
    const date = dateOnly(value);
    if (!date) return '';
    const parsed = new Date(`${date}T12:00:00+08:00`);
    const options = style === 'weekday'
      ? { timeZone: MANILA_TIME_ZONE, weekday: 'long' }
      : style === 'short'
        ? { timeZone: MANILA_TIME_ZONE, month: 'short', day: 'numeric' }
        : { timeZone: MANILA_TIME_ZONE, month: 'long', day: 'numeric', year: 'numeric' };
    return new Intl.DateTimeFormat('en-PH', options).format(parsed);
  }

  function formatGeneratedAt(value) {
    const parsed = new Date(value || Date.now());
    if (Number.isNaN(parsed.getTime())) return '';
    return new Intl.DateTimeFormat('en-PH', {
      timeZone: MANILA_TIME_ZONE,
      hour: 'numeric',
      minute: '2-digit',
      hour12: true,
    }).format(parsed);
  }

  function buildCaption(snapshot, options = {}) {
    const normalized = normalizeSnapshot(snapshot, snapshot?.date);
    const bookingUrl = text(options.bookingUrl) || DEFAULT_BOOKING_URL;
    const lines = [
      `🏓 COURT AVAILABILITY — ${formatDate(normalized.date, 'weekday')}, ${formatDate(normalized.date, 'short')}`,
      '',
    ];
    normalized.courts.forEach(court => {
      const ranges = mergeAvailableRanges(court.slots);
      lines.push(`${court.name}: ${ranges.length ? ranges.map(range => range.label).join(' · ') : 'Fully booked'}`);
    });
    lines.push(
      '',
      `Book your court: ${bookingUrl}`,
      `Availability as of ${formatGeneratedAt(normalized.generatedAt)} PHT. Slots may change.`,
      '',
      '#PickleBliss #PickleballMonkayo #BookYourCourt',
    );
    return lines.join('\n');
  }

  function formatAge(age) {
    if (!Number.isFinite(age)) return 'Needs refresh';
    if (age < 60000) return 'Updated just now';
    const minutes = Math.max(1, Math.round(age / 60000));
    return `Updated ${minutes} min ago`;
  }

  function icon(name) {
    const icons = {
      close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m6 6 12 12M18 6 6 18"/></svg>',
      refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 7v5h-5M4 17v-5h5"/><path d="M6.1 9A7 7 0 0 1 18 6l2 6M18 15a7 7 0 0 1-11.9 3L4 12"/></svg>',
      download: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v12m0 0 4-4m-4 4-4-4M5 20h14"/></svg>',
      copy: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="11" height="11" rx="2"/><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2"/></svg>',
      share: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="18" cy="5" r="2.5"/><circle cx="6" cy="12" r="2.5"/><circle cx="18" cy="19" r="2.5"/><path d="m8.2 10.8 7.6-4.5M8.2 13.2l7.6 4.5"/></svg>',
      calendar: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="5" width="18" height="16" rx="3"/><path d="M8 3v4m8-4v4M3 10h18"/></svg>',
      check: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12 4 4L19 6"/></svg>',
      sparkle: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2c.5 5.6 3 8.1 8 8.5-5 .5-7.5 3-8 8.5-.5-5.5-3-8-8-8.5C9 10.1 11.5 7.6 12 2Z"/><path d="M19 15c.2 2.3 1.2 3.3 3 3.5-1.8.2-2.8 1.2-3 3.5-.2-2.3-1.2-3.3-3-3.5 1.8-.2 2.8-1.2 3-3.5Z"/></svg>',
    };
    return icons[name] || '';
  }

  function modalMarkup() {
    return `
      <div class="prag-overlay" data-prag-overlay hidden>
        <section class="prag-modal" role="dialog" aria-modal="true" aria-labelledby="pragTitle" aria-describedby="pragDescription" tabindex="-1">
          <header class="prag-header">
            <div class="prag-brand-mark"><img src="pickle-bliss-logo.jpg" alt="Pickle Bliss Court logo" width="52" height="64"></div>
            <div class="prag-heading">
              <span class="prag-eyebrow">Pickle Bliss content tool <b>Live schedule</b></span>
              <h2 id="pragTitle">Court availability post</h2>
              <p id="pragDescription">Create a branded Pickle Bliss post using live courts and operating hours.</p>
            </div>
            <button class="prag-icon-button" type="button" data-prag-action="close" aria-label="Close availability graphic studio">${icon('close')}</button>
          </header>

          <div class="prag-workspace">
            <aside class="prag-controls" aria-label="Graphic settings">
              <div class="prag-section">
                <div class="prag-section-heading"><span>01</span><div><strong>Schedule</strong><small>Choose what to publish</small></div></div>
                <label class="prag-field">
                  <span class="prag-field-label">Date</span>
                  <span class="prag-input-wrap">${icon('calendar')}<input type="date" data-prag-date /></span>
                </label>
                <fieldset class="prag-court-fieldset">
                  <legend>Court selection</legend>
                  <div class="prag-court-list" data-prag-courts></div>
                </fieldset>
              </div>

              <div class="prag-section">
                <div class="prag-section-heading"><span>02</span><div><strong>Canvas</strong><small>Optimized for Facebook</small></div></div>
                <div class="prag-format-switch" role="group" aria-label="Graphic format">
                  <button type="button" data-prag-format="feed" aria-pressed="true"><b>4:5</b><span>Post</span><small>1080 × 1350</small></button>
                  <button type="button" data-prag-format="story" aria-pressed="false"><b>9:16</b><span>Story</span><small>1080 × 1920</small></button>
                </div>
              </div>

              <div class="prag-live-card">
                <div class="prag-live-row"><span class="prag-live-dot"></span><strong data-prag-freshness>Waiting for live schedule</strong></div>
                <p data-prag-freshness-detail>Exports refresh again before they are created.</p>
                <button class="prag-refresh" type="button" data-prag-action="refresh">${icon('refresh')}<span>Refresh availability</span></button>
              </div>

              <div class="prag-safety-note">${icon('check')}<p><strong>Privacy safe</strong><span>Shows court names, times, and availability status—never customer details.</span></p></div>
            </aside>

            <main class="prag-preview-panel">
              <div class="prag-preview-toolbar">
                <div><span class="prag-preview-kicker">Live preview</span><strong data-prag-preview-title>Facebook post · 1080 × 1350</strong></div>
                <div class="prag-preview-tools">
                  <div class="prag-page-controls" data-prag-page-controls hidden>
                    <button type="button" data-prag-action="previous-page" aria-label="Show previous carousel page">&#8249;</button>
                    <span data-prag-page-label>Page 1 of 1</span>
                    <button type="button" data-prag-action="next-page" aria-label="Show next carousel page">&#8250;</button>
                  </div>
                  <span class="prag-ready-badge" data-prag-ready><i></i>Ready to post</span>
                </div>
              </div>
              <div class="prag-canvas-stage" data-prag-stage>
                <div class="prag-canvas-shell" data-prag-canvas-shell>
                  <canvas data-prag-canvas width="1080" height="1350" aria-label="Preview of the Pickle Bliss court availability post"></canvas>
                </div>
                <div class="prag-loading" data-prag-loading hidden><span></span><strong>Syncing live courts</strong><small>Building your graphic…</small></div>
              </div>
              <div class="prag-status" role="status" aria-live="polite" data-prag-status>Choose a date to begin.</div>
            </main>
          </div>

          <footer class="prag-footer">
            <div class="prag-footer-copy">${icon('sparkle')}<span><strong>Freshness protected</strong><small>Download, caption, and share always check the live schedule first.</small></span></div>
            <div class="prag-actions">
              <button class="prag-button prag-button-secondary" type="button" data-prag-action="copy">${icon('copy')}<span>Copy caption</span></button>
              <button class="prag-button prag-button-secondary" type="button" data-prag-action="share" hidden>${icon('share')}<span>Share</span></button>
              <button class="prag-button prag-button-primary" type="button" data-prag-action="download">${icon('download')}<span>Download PNG</span></button>
            </div>
          </footer>
        </section>
      </div>`;
  }

  function documentAvailable() {
    return Boolean(root?.document?.body);
  }

  function element(selector) {
    return state.overlay?.querySelector(selector) || null;
  }

  function ensureModal() {
    if (!documentAvailable()) throw new Error('The availability graphic studio requires a browser.');
    if (state.overlay?.isConnected) return state.overlay;
    const template = root.document.createElement('template');
    template.innerHTML = modalMarkup().trim();
    state.overlay = template.content.firstElementChild;
    state.canvas = state.overlay.querySelector('[data-prag-canvas]');
    root.document.body.appendChild(state.overlay);
    state.overlay.addEventListener('click', handleClick);
    state.overlay.addEventListener('change', handleChange);
    state.overlay.addEventListener('keydown', handleKeydown);
    state.overlay.addEventListener('pointerdown', event => {
      if (event.target === state.overlay && !state.busy) close();
    });
    const shareButton = element('[data-prag-action="share"]');
    if (shareButton) shareButton.hidden = typeof root.navigator?.share !== 'function';
    return state.overlay;
  }

  function focusableElements() {
    if (!state.overlay) return [];
    return [...state.overlay.querySelectorAll('button:not([disabled]):not([hidden]), input:not([disabled]), [tabindex]:not([tabindex="-1"])')]
      .filter(item => !item.closest('[hidden]') && item.getClientRects().length > 0);
  }

  function handleKeydown(event) {
    if (event.key === 'Escape') {
      event.preventDefault();
      if (!state.busy) close();
      return;
    }
    if (event.key !== 'Tab') return;
    const items = focusableElements();
    if (!items.length) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (event.shiftKey && root.document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && root.document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  }

  function notify(message, kind = 'neutral') {
    const status = element('[data-prag-status]');
    if (status) {
      status.textContent = message;
      status.dataset.kind = kind;
    }
    if (kind === 'error' && typeof root?.toast === 'function') root.toast(message, 'err');
  }

  function setBusy(busy, message) {
    state.busy = Boolean(busy);
    const loading = element('[data-prag-loading]');
    if (loading) loading.hidden = !state.busy;
    state.overlay?.querySelectorAll('button, input').forEach(control => {
      if (control.matches('[data-prag-action="close"]')) return;
      control.disabled = state.busy;
    });
    updatePageUi();
    if (message) notify(message);
  }

  function updateFormatUi() {
    const format = FORMATS[state.format] || FORMATS.feed;
    state.overlay?.querySelectorAll('[data-prag-format]').forEach(button => {
      const active = button.dataset.pragFormat === state.format;
      button.setAttribute('aria-pressed', String(active));
    });
    const shell = element('[data-prag-canvas-shell]');
    if (shell) shell.dataset.format = state.format;
    const title = element('[data-prag-preview-title]');
    if (title) title.textContent = `${format.label} · ${format.width} × ${format.height}`;
    if (state.canvas) {
      state.canvas.width = format.width;
      state.canvas.height = format.height;
      state.canvas.setAttribute('aria-label', `Preview of the ${format.label} for Pickle Bliss court availability`);
    }
  }

  function updatePageUi() {
    const pages = paginateSnapshot(currentSnapshot(), state.format);
    state.page = clamp(state.page, 0, Math.max(0, pages.length - 1));
    const controls = element('[data-prag-page-controls]');
    const label = element('[data-prag-page-label]');
    const previous = element('[data-prag-action="previous-page"]');
    const next = element('[data-prag-action="next-page"]');
    const downloadButton = element('[data-prag-action="download"] span');
    if (controls) controls.hidden = pages.length <= 1;
    if (label) label.textContent = `Page ${state.page + 1} of ${pages.length}`;
    if (previous) previous.disabled = state.busy || state.page === 0;
    if (next) next.disabled = state.busy || state.page >= pages.length - 1;
    if (downloadButton) downloadButton.textContent = pages.length > 1 ? `Download ${pages.length} PNGs` : 'Download PNG';
    return pages;
  }

  function updateFreshnessUi() {
    const freshness = element('[data-prag-freshness]');
    const detail = element('[data-prag-freshness-detail]');
    const badge = element('[data-prag-ready]');
    const stale = isSnapshotStale(state.snapshot);
    const age = snapshotAge(state.snapshot);
    if (freshness) freshness.textContent = state.snapshot ? formatAge(age) : 'Waiting for live schedule';
    if (detail) {
      detail.textContent = stale
        ? 'Refresh before posting so followers see current openings.'
        : `Live schedule · ${formatGeneratedAt(state.snapshot?.generatedAt)} PHT`;
    }
    if (badge) {
      badge.classList.toggle('is-stale', stale);
      badge.innerHTML = stale ? '<i></i>Refresh needed' : '<i></i>Ready to post';
    }
  }

  function renderCourtControls() {
    const container = element('[data-prag-courts]');
    if (!container) return;
    if (!state.courts.length) {
      container.innerHTML = '<p class="prag-empty-courts">No courts returned for this date.</p>';
      return;
    }
    container.innerHTML = state.courts.map(court => {
      const checked = state.selectedCourtIds.has(String(court.id));
      const available = court.slots.filter(slot => slot.status === 'available').length;
      const booked = court.slots.filter(slot => slotCellLabel(slot).tone === 'booked').length;
      const summary = `${available} available${booked ? ` · ${booked} booked` : ''}`;
      return `<label class="prag-court-option" title="${escapeHtml(court.name)}">
        <input type="checkbox" value="${escapeHtml(court.id)}" data-prag-court ${checked ? 'checked' : ''} />
        <span class="prag-checkbox">${icon('check')}</span>
        <span class="prag-court-copy"><strong>${escapeHtml(court.name)}</strong><small>${summary}</small></span>
      </label>`;
    }).join('');
  }

  function mergeCourtCatalog(incoming, replace) {
    if (replace) {
      state.courts = (incoming || []).map(court => ({ ...court, slots: [...court.slots] }));
      return;
    }
    const map = new Map(state.courts.map(court => [String(court.id), court]));
    (incoming || []).forEach(court => map.set(String(court.id), { ...court, slots: [...court.slots] }));
    state.courts = [...map.values()];
  }

  function currentSnapshot() {
    return {
      ...(state.snapshot || {}),
      date: state.date,
      courts: state.courts.filter(court => state.selectedCourtIds.has(String(court.id))),
    };
  }

  async function getSnapshot(date, courtIds) {
    if (state.options.snapshot && !state.snapshot) return state.options.snapshot;
    const db = state.options.db || root?.DB;
    const getAvailability = db?.getAvailabilityGraphic || db?.getAvailabilityGraphicSnapshot;
    if (!db || typeof getAvailability !== 'function') {
      throw new Error('Live availability is not connected yet.');
    }
    return getAvailability.call(db, date, courtIds);
  }

  async function refresh(options = {}) {
    if (state.refreshPromise) {
      try { await state.refreshPromise; } catch (_) { /* a forced refresh retries below */ }
      if (!options.force) return currentSnapshot();
    }
    const operationToken = ++state.operationToken;
    const replace = Boolean(options.replace);
    const ids = replace ? [] : [...state.selectedCourtIds];
    const request = (async () => {
      setBusy(true, options.message || 'Refreshing live court availability…');
      try {
        const raw = await getSnapshot(state.date, ids);
        if (operationToken !== state.operationToken || !state.open) return currentSnapshot();
        const normalized = normalizeSnapshot(raw, state.date);
        state.snapshot = normalized;
        mergeCourtCatalog(normalized.courts, replace || state.courts.length === 0);

        if (!state.selectedCourtIds.size) {
          const preferred = unique(state.requestedCourtIds);
          const validPreferred = preferred.filter(id => state.courts.some(court => String(court.id) === id));
          state.selectedCourtIds = new Set(validPreferred.length ? validPreferred : state.courts.map(court => String(court.id)));
        } else {
          const validIds = new Set(state.courts.map(court => String(court.id)));
          state.selectedCourtIds = new Set([...state.selectedCourtIds].filter(id => validIds.has(id)));
          if (!state.selectedCourtIds.size) state.courts.forEach(court => state.selectedCourtIds.add(String(court.id)));
        }

        renderCourtControls();
        updateFreshnessUi();
        await renderActiveCanvas();
        const count = currentSnapshot().courts.length;
        notify(`${count} court${count === 1 ? '' : 's'} synced · ${formatGeneratedAt(normalized.generatedAt)} PHT`, 'success');
        return currentSnapshot();
      } catch (error) {
        const message = text(error?.message) || 'Could not load live court availability.';
        notify(message, 'error');
        throw error;
      } finally {
        if (operationToken === state.operationToken) setBusy(false);
      }
    })();
    state.refreshPromise = request;
    try {
      return await request;
    } finally {
      if (state.refreshPromise === request) state.refreshPromise = null;
    }
  }

  async function ensureFreshForExport(actionLabel) {
    try {
      await refresh({ replace: false, force: true, message: `Checking live slots before ${actionLabel}…` });
    } catch (_) {
      throw new Error(`Could not refresh the schedule. ${actionLabel} was stopped to prevent an outdated post.`);
    }
    if (isSnapshotStale(state.snapshot)) {
      throw new Error(`The schedule is still stale. ${actionLabel} was stopped to prevent an outdated post.`);
    }
    if (!state.open) throw new Error(`${actionLabel} was canceled because the studio was closed.`);
    const snapshot = currentSnapshot();
    if (!snapshot.courts.length) throw new Error(`No courts are available for ${formatDate(state.date)}. Nothing was exported.`);
    return snapshot;
  }

  function roundRectPath(context, x, y, width, height, radius) {
    const r = Math.min(Math.max(0, radius), width / 2, height / 2);
    context.beginPath();
    context.moveTo(x + r, y);
    context.arcTo(x + width, y, x + width, y + height, r);
    context.arcTo(x + width, y + height, x, y + height, r);
    context.arcTo(x, y + height, x, y, r);
    context.arcTo(x, y, x + width, y, r);
    context.closePath();
  }

  function fillRoundRect(context, x, y, width, height, radius, fill) {
    context.save();
    roundRectPath(context, x, y, width, height, radius);
    context.fillStyle = fill;
    context.fill();
    context.restore();
  }

  function strokeRoundRect(context, x, y, width, height, radius, stroke, lineWidth = 1) {
    context.save();
    roundRectPath(context, x, y, width, height, radius);
    context.strokeStyle = stroke;
    context.lineWidth = lineWidth;
    context.stroke();
    context.restore();
  }

  function trackedText(context, value, x, y, spacing = 2) {
    let cursor = x;
    [...String(value)].forEach(character => {
      context.fillText(character, cursor, y);
      cursor += context.measureText(character).width + spacing;
    });
    return cursor;
  }

  function fitFont(context, value, maximumWidth, startSize, minimumSize, family, weight = 800) {
    let size = Math.max(minimumSize, startSize);
    while (size > minimumSize) {
      context.font = `${weight} ${size}px ${family}`;
      if (context.measureText(value).width <= maximumWidth) return size;
      size -= 2;
    }
    size = minimumSize;
    context.font = `${weight} ${size}px ${family}`;
    return size;
  }

  function drawCourtTexture(context, width, height) {
    context.save();
    context.strokeStyle = 'rgba(23,110,131,.055)';
    context.lineWidth = 1;
    const cell = 96;
    for (let x = -height; x < width + height; x += cell) {
      context.beginPath();
      context.moveTo(x, 0);
      context.lineTo(x + height, height);
      context.stroke();
    }
    context.strokeStyle = 'rgba(23,56,68,.035)';
    for (let y = 0; y < height; y += 120) {
      context.beginPath();
      context.moveTo(0, y);
      context.lineTo(width, y);
      context.stroke();
    }
    context.restore();
  }

  function loadSameOriginImage(source) {
    if (!documentAvailable() || !root.location) return Promise.resolve(null);
    let url;
    try {
      url = new URL(source, root.location.href);
      if (url.origin !== root.location.origin) return Promise.resolve(null);
    } catch (_) {
      return Promise.resolve(null);
    }
    return new Promise(resolve => {
      const image = new Image();
      image.onload = () => resolve(image);
      image.onerror = () => resolve(null);
      image.src = url.href;
    });
  }

  async function logoImage() {
    if (!state.logoPromise) state.logoPromise = loadSameOriginImage(state.options.logoUrl || 'pickle-bliss-logo.jpg');
    return state.logoPromise;
  }

  async function qrCanvas(url, size) {
    if (!documentAvailable() || typeof root?.PaddleRageQRCode?.toCanvas !== 'function') return null;
    const canvas = root.document.createElement('canvas');
    canvas.width = size;
    canvas.height = size;
    try {
      await root.PaddleRageQRCode.toCanvas(canvas, url, {
        width: size,
        margin: QR_RENDER_CONFIG.margin,
        color: { dark: QR_RENDER_CONFIG.dark, light: QR_RENDER_CONFIG.light },
        errorCorrectionLevel: QR_RENDER_CONFIG.errorCorrectionLevel,
      });
      return canvas;
    } catch (_) {
      return null;
    }
  }

  function drawBrand(context, logo, layout) {
    const { width, story } = layout;
    const x = 70;
    const y = layout.brandY;
    const logoWidth = story ? 88 : 72;
    const logoHeight = story ? 112 : 92;
    fillRoundRect(context, x, y, logoWidth, logoHeight, 14, '#ffffff');
    strokeRoundRect(context, x, y, logoWidth, logoHeight, 14, '#f0d8cf', 2);
    if (logo) {
      const inset = 5;
      const availableWidth = logoWidth - inset * 2;
      const availableHeight = logoHeight - inset * 2;
      const scale = Math.min(availableWidth / logo.width, availableHeight / logo.height);
      const drawWidth = logo.width * scale;
      const drawHeight = logo.height * scale;
      context.drawImage(
        logo,
        x + (logoWidth - drawWidth) / 2,
        y + (logoHeight - drawHeight) / 2,
        drawWidth,
        drawHeight,
      );
    } else {
      context.fillStyle = '#24120d';
      context.font = `800 ${story ? 36 : 32}px "Manrope", "DM Sans", sans-serif`;
      context.textAlign = 'center';
      context.fillText('PB', x + logoWidth / 2, y + logoHeight * .58);
      context.textAlign = 'left';
    }
    context.fillStyle = '#24120d';
    context.font = `800 ${story ? 34 : 29}px "Manrope", "DM Sans", sans-serif`;
    trackedText(context, 'PICKLE BLISS', x + logoWidth + 22, y + (story ? 42 : 37), 1.2);
    context.fillStyle = '#d90416';
    context.font = `800 ${story ? 16 : 14}px "DM Sans", Arial, sans-serif`;
    trackedText(context, 'BLISS · POBLACION · MONKAYO', x + logoWidth + 22, y + (story ? 73 : 66), 2.4);

    fillRoundRect(context, width - (story ? 308 : 284) - 70, y + 9, story ? 308 : 284, story ? 57 : 50, 28, '#ffe6df');
    strokeRoundRect(context, width - (story ? 308 : 284) - 70, y + 9, story ? 308 : 284, story ? 57 : 50, 28, '#efb8a5', 2);
    context.fillStyle = '#d90416';
    context.font = `800 ${story ? 17 : 15}px "DM Sans", Arial, sans-serif`;
    trackedText(context, 'LIVE AVAILABILITY', width - (story ? 308 : 284) - 42, y + (story ? 45 : 41), 2.5);
  }

  function posterSummary(snapshot) {
    const courts = snapshot.courts || [];
    const rangesByCourt = courts.map(court => mergeAvailableRanges(
      court.slots.filter(slot => !isElapsedSlot(slot, snapshot)),
    ));
    const openHours = rangesByCourt.reduce((total, ranges) => (
      total + ranges.reduce((sum, range) => sum + (range.end - range.start), 0)
    ), 0);
    const openCourts = rangesByCourt.filter(ranges => ranges.length).length;
    let headline = 'OPEN COURTS';
    let kicker = 'BOOK YOUR GAME';
    const courtVisibility = posterCourtVisibility(courts);
    if (courts.length && !courtVisibility.courts.length) {
      headline = 'CLOSED';
      kicker = 'VENUE NOTICE';
    } else if (!openHours) {
      headline = 'FULLY BOOKED';
      kicker = 'CHECK ANOTHER DATE';
    } else if (openHours <= 3) {
      headline = 'LAST SLOTS';
      kicker = 'MOVE FAST';
    }
    return { courts, rangesByCourt, openHours, openCourts, headline, kicker };
  }

  function drawHero(context, snapshot, summary, layout) {
    const { width, story } = layout;
    const top = layout.heroTop;
    const date = formatDate(snapshot.date);
    const weekday = formatDate(snapshot.date, 'weekday').toUpperCase();

    context.fillStyle = '#d90416';
    context.font = `900 ${story ? 21 : 16}px "DM Sans", Arial, sans-serif`;
    trackedText(context, summary.kicker, 72, top, 5);

    context.fillStyle = '#24120d';
    const headlineSize = fitFont(context, summary.headline, width - 144, story ? 112 : 91, 64, '"Manrope", "DM Sans", sans-serif', 800);
    context.font = `800 ${headlineSize}px "Manrope", "DM Sans", sans-serif`;
    context.fillText(summary.headline, 68, top + (story ? 118 : 91));

    context.fillStyle = '#d90416';
    context.font = `900 ${story ? 44 : 34}px "DM Sans", Arial, sans-serif`;
    context.fillText(`${weekday} · ${date.toUpperCase()}`, 72, top + (story ? 186 : 139));

    const pillY = top + (story ? 224 : 164);
    const selectedCount = summary.courts.length;
    const statText = summary.openHours
      ? `${summary.openHours} AVAILABLE COURT-HOUR${summary.openHours === 1 ? '' : 'S'}  ·  ${summary.openCourts}/${selectedCount} COURTS`
      : `${selectedCount} COURT${selectedCount === 1 ? '' : 'S'} CHECKED  ·  NO OPEN SLOTS`;
    context.font = `800 ${story ? 19 : 15}px "DM Sans", Arial, sans-serif`;
    const pillWidth = width - 144;
    fillRoundRect(context, 72, pillY, pillWidth, story ? 52 : 42, 15, '#fff1e8');
    strokeRoundRect(context, 72, pillY, pillWidth, story ? 52 : 42, 15, '#efc6b8', 1.5);
    context.fillStyle = '#5a3c32';
    fitFont(context, statText, pillWidth - 56, story ? 19 : 15, 12, '"DM Sans", Arial, sans-serif', 800);
    context.fillText(statText, 100, pillY + (story ? 34 : 27));
  }

  function slotCellLabel(slot) {
    if (!slot) return { label: 'UNAVAILABLE', tone: 'unavailable' };
    if (slot.status === 'available') return { label: 'AVAILABLE', tone: 'available' };
    const reason = text(slot.reason).toLowerCase();
    if (reason === 'booked') return { label: 'BOOKED', tone: 'booked' };
    if (reason === 'past') return { label: 'PAST', tone: 'past' };
    if (reason === 'current') return { label: 'NOW', tone: 'past' };
    if (reason === 'maintenance') return { label: 'BLOCKED', tone: 'blocked' };
    if (reason === 'blocked_date') return { label: 'CLOSED', tone: 'blocked' };
    return { label: 'UNAVAILABLE', tone: 'unavailable' };
  }

  function isClosedSlot(slot) {
    const reason = text(slot?.reason).toLowerCase();
    return reason === 'maintenance' || reason === 'blocked_date';
  }

  function posterCourtVisibility(courts) {
    const hiddenCourtNames = [];
    const visibleCourts = courts.filter(court => {
      const remainingSlots = court.slots.filter(slot => text(slot.reason).toLowerCase() !== 'past');
      const closedForRemainingDay = remainingSlots.length > 0 && remainingSlots.every(isClosedSlot);
      if (closedForRemainingDay) hiddenCourtNames.push(court.name);
      return !closedForRemainingDay;
    });
    return { courts: visibleCourts, hiddenCourtNames };
  }

  function posterSlotVisibility(courts, snapshot) {
    const allSlots = [...new Map(courts.flatMap(court => court.slots).map(slot => [`${slot.start}|${slot.end}`, slot])).values()]
      .sort((left, right) => left.start - right.start || left.end - right.end);
    let hiddenPastCount = 0;
    let hiddenUnavailableCount = 0;
    const timeSlots = allSlots.filter(slotWindow => {
      const matchingSlots = courts
        .map(court => court.slots.find(candidate => candidate.start === slotWindow.start && candidate.end === slotWindow.end))
        .filter(Boolean);
      const fullyPast = isElapsedSlot(slotWindow, snapshot)
        || (matchingSlots.length === courts.length
          && matchingSlots.every(slot => text(slot.reason).toLowerCase() === 'past'));
      const fullyUnavailable = matchingSlots.length === courts.length
        && matchingSlots.every(slot => (
          slot.status !== 'available'
          && text(slot.reason).toLowerCase() !== 'current'
          && text(slot.reason).toLowerCase() !== 'past'
        ));
      if (fullyPast) hiddenPastCount += 1;
      else if (fullyUnavailable) hiddenUnavailableCount += 1;
      return !fullyPast && !fullyUnavailable;
    });
    return { timeSlots, hiddenPastCount, hiddenUnavailableCount };
  }

  function drawCourtCards(context, snapshot, summary, layout) {
    const { width, story } = layout;
    const courtVisibility = posterCourtVisibility(summary.courts);
    const courts = courtVisibility.courts;
    const startY = layout.cardsStart;
    const endY = layout.cardsEnd;
    const cardWidth = width - 144;

    if (!summary.courts.length) {
      fillRoundRect(context, 72, startY, cardWidth, story ? 240 : 210, 24, '#ffffff');
      strokeRoundRect(context, 72, startY, cardWidth, story ? 240 : 210, 24, '#f0d8cf', 2);
      context.fillStyle = '#24120d';
      context.font = `800 ${story ? 38 : 32}px "Manrope", "DM Sans", sans-serif`;
      context.textAlign = 'center';
      context.fillText('SELECT A COURT TO CONTINUE', width / 2, startY + (story ? 112 : 98));
      context.fillStyle = '#7d6a62';
      context.font = `600 ${story ? 19 : 16}px "DM Sans", Arial, sans-serif`;
      context.fillText('Your live openings will appear here.', width / 2, startY + (story ? 155 : 138));
      context.textAlign = 'left';
      return;
    }

    if (!courts.length) {
      const boardHeight = story ? 300 : 230;
      const boardStartY = startY + (endY - startY - boardHeight) / 2;
      fillRoundRect(context, 72, boardStartY, cardWidth, boardHeight, 24, '#ffffff');
      strokeRoundRect(context, 72, boardStartY, cardWidth, boardHeight, 24, '#e5bfae', 2);
      context.fillStyle = '#24120d';
      context.font = `800 ${story ? 48 : 40}px "Manrope", "DM Sans", sans-serif`;
      context.textAlign = 'center';
      context.fillText('CLOSED ON THIS DATE', width / 2, boardStartY + (story ? 126 : 98));
      context.fillStyle = '#7d6a62';
      context.font = `700 ${story ? 22 : 18}px "DM Sans", Arial, sans-serif`;
      context.fillText('Choose another date to see live court availability.', width / 2, boardStartY + (story ? 178 : 142));
      context.textAlign = 'left';
      return;
    }

    const { timeSlots, hiddenPastCount, hiddenUnavailableCount } = posterSlotVisibility(courts, snapshot);
    const headerHeight = story ? 58 : 46;
    const timeWidth = story ? 210 : 205;
    const columnGap = story ? 10 : 8;
    const rowGap = story ? 5 : 3;
    const maximumBoardHeight = endY - startY;
    const hasVisibilityNote = hiddenPastCount || hiddenUnavailableCount || courtVisibility.hiddenCourtNames.length;
    const noteHeight = hasVisibilityNote ? (story ? 42 : 32) : 0;
    const maximumRowHeight = story ? 58 : 46;
    const availableRowsHeight = maximumBoardHeight - headerHeight - noteHeight
      - rowGap * Math.max(0, timeSlots.length - 1);
    const rowHeight = timeSlots.length
      ? Math.min(maximumRowHeight, availableRowsHeight / timeSlots.length)
      : 0;
    const contentHeight = timeSlots.length
      ? headerHeight + noteHeight + rowHeight * timeSlots.length + rowGap * Math.max(0, timeSlots.length - 1)
      : (story ? 280 : 220);
    const boardHeight = Math.min(maximumBoardHeight, contentHeight);
    const boardStartY = startY + (maximumBoardHeight - boardHeight) / 2;
    const courtWidth = (cardWidth - timeWidth - columnGap * courts.length) / courts.length;

    fillRoundRect(context, 72, boardStartY, cardWidth, boardHeight, 24, '#ffffff');
    strokeRoundRect(context, 72, boardStartY, cardWidth, boardHeight, 24, '#e5bfae', 2);
    context.fillStyle = '#d90416';
    context.font = `900 ${story ? 17 : 14}px "DM Sans", Arial, sans-serif`;
    trackedText(context, 'TIME SLOT', 98, boardStartY + headerHeight * .64, 2);
    courts.forEach((court, index) => {
      const x = 72 + timeWidth + columnGap + index * (courtWidth + columnGap);
      context.fillStyle = '#24120d';
      const label = text(court.name).toUpperCase();
      const fontSize = fitFont(context, label, courtWidth - 12, story ? 24 : 21, 13, '"Manrope", "DM Sans", sans-serif', 800);
      context.font = `800 ${fontSize}px "Manrope", "DM Sans", sans-serif`;
      context.textAlign = 'center';
      context.fillText(label, x + courtWidth / 2, boardStartY + headerHeight * .66);
    });
    context.textAlign = 'left';

    timeSlots.forEach((slotWindow, rowIndex) => {
      const y = boardStartY + headerHeight + rowIndex * (rowHeight + rowGap);
      context.fillStyle = rowIndex % 2 ? '#fffaf7' : '#fff0e0';
      context.fillRect(88, y, timeWidth - 26, rowHeight);
      context.fillStyle = '#5a3c32';
      const timeLabel = formatPosterRange(slotWindow.start, slotWindow.end);
      const timeFont = fitFont(context, timeLabel, timeWidth - 40, story ? 24 : 20, 12, '"DM Sans", Arial, sans-serif', 800);
      context.font = `800 ${timeFont}px "DM Sans", Arial, sans-serif`;
      context.fillText(timeLabel, 98, y + rowHeight / 2 + timeFont * .35);

      courts.forEach((court, columnIndex) => {
        const x = 72 + timeWidth + columnGap + columnIndex * (courtWidth + columnGap);
        const slot = court.slots.find(candidate => candidate.start === slotWindow.start && candidate.end === slotWindow.end);
        const cellState = slotCellLabel(slot);
        const tones = {
          available: ['#ffe6df', '#ff6a00', '#9b3700'],
          booked: ['#ffe6df', '#d90416', '#8c0611'],
          blocked: ['#fff4df', '#ff9a3d', '#8a4a00'],
          past: ['#f5e8e2', '#cfbcb3', '#7d6a62'],
          unavailable: ['#fff1e8', '#cfbcb3', '#7d6a62'],
        };
        const [fill, stroke, color] = tones[cellState.tone] || tones.unavailable;
        fillRoundRect(context, x, y, courtWidth, rowHeight, 7, fill);
        strokeRoundRect(context, x, y, courtWidth, rowHeight, 7, stroke, 1.5);
        context.fillStyle = color;
        const statusFont = fitFont(context, cellState.label, courtWidth - 14, story ? 20 : 18, 10, '"DM Sans", Arial, sans-serif', 900);
        context.font = `900 ${statusFont}px "DM Sans", Arial, sans-serif`;
        context.textAlign = 'center';
        context.fillText(cellState.label, x + courtWidth / 2, y + rowHeight / 2 + statusFont * .34);
      });
      context.textAlign = 'left';
    });

    if (hasVisibilityNote) {
      context.fillStyle = '#7d6a62';
      context.font = `700 ${story ? 17 : 14}px "DM Sans", Arial, sans-serif`;
      context.textAlign = 'center';
      const noteY = timeSlots.length
        ? boardStartY + boardHeight - noteHeight * .34
        : boardStartY + boardHeight - (story ? 28 : 22);
      let note = 'Unavailable time slots hidden · showing bookable times';
      if (hiddenPastCount && !hiddenUnavailableCount) note = 'Earlier time slots hidden · showing what remains today';
      if (!timeSlots.length && hiddenPastCount && !hiddenUnavailableCount) note = 'Today’s court hours have ended';
      if (courtVisibility.hiddenCourtNames.length) {
        note = `${courtVisibility.hiddenCourtNames.join(', ')} closed · ${note}`;
      }
      fitFont(context, note, cardWidth - 48, story ? 17 : 14, 10, '"DM Sans", Arial, sans-serif', 700);
      context.fillText(note, width / 2, noteY);
      context.textAlign = 'left';
    }

    if (!timeSlots.length) {
      context.fillStyle = '#7d6a62';
      context.font = `700 ${story ? 30 : 27}px "DM Sans", Arial, sans-serif`;
      context.textAlign = 'center';
      const emptyLabel = hiddenUnavailableCount
        ? 'NO REMAINING OPENINGS'
        : hiddenPastCount
          ? 'TODAY’S COURT HOURS HAVE ENDED'
          : 'No operating time slots for this selection';
      context.fillText(emptyLabel, width / 2, boardStartY + headerHeight + 80);
      context.textAlign = 'left';
    }

  }

  function drawPageMarker(context, layout, pageNumber, totalPages) {
    if (totalPages <= 1) return;
    const label = `PAGE ${pageNumber} / ${totalPages}`;
    const width = layout.story ? 154 : 136;
    const height = layout.story ? 42 : 36;
    const x = layout.width - width - 70;
    const y = layout.brandY + (layout.story ? 78 : 65);
    fillRoundRect(context, x, y, width, height, height / 2, '#ffe6df');
    strokeRoundRect(context, x, y, width, height, height / 2, '#efb8a5', 1.5);
    context.fillStyle = '#d90416';
    context.font = `900 ${layout.story ? 14 : 12}px "DM Sans", Arial, sans-serif`;
    context.textAlign = 'center';
    context.fillText(label, x + width / 2, y + height * .65);
    context.textAlign = 'left';
  }

  function drawFooter(context, snapshot, qr, layout, bookingUrl) {
    const { width, height, story } = layout;
    const footer = FOOTER_LAYOUTS[story ? 'story' : 'feed'];
    const footerY = layout.footerY;
    const footerHeight = height - footerY;
    const gradient = context.createLinearGradient(0, footerY, width, height);
    gradient.addColorStop(0, '#7f0711');
    gradient.addColorStop(.6, '#ba0716');
    gradient.addColorStop(1, '#a80012');
    context.fillStyle = gradient;
    context.fillRect(0, footerY, width, footerHeight);

    context.fillStyle = 'rgba(255,255,255,.055)';
    context.beginPath();
    context.arc(width - 110, footerY + 10, story ? 290 : 230, 0, Math.PI * 2);
    context.fill();

    const x = 72;
    context.fillStyle = '#ffffff';
    context.font = `900 ${footer.readyFontSize}px "DM Sans", Arial, sans-serif`;
    trackedText(context, 'READY TO PLAY?', x, footer.readyY, 3.1);
    context.font = `800 ${footer.ctaFontSize - 6}px "Manrope", "DM Sans", sans-serif`;
    context.fillText('BOOK YOUR COURT', x, footer.ctaY);
    const bookingDisplay = text(bookingUrl).replace(/^https?:\/\//, '').replace(/\/$/, '');
    fitFont(
      context,
      bookingDisplay,
      footer.qrCardX - x - 42,
      footer.urlFontSize,
      20,
      '"DM Sans", Arial, sans-serif',
      800,
    );
    context.fillText(bookingDisplay, x, footer.urlY);

    const updateText = `Updated ${formatGeneratedAt(snapshot.generatedAt)} PHT · Slots may change`;
    context.fillStyle = 'rgba(255,255,255,.82)';
    fitFont(
      context,
      updateText,
      footer.qrCardX - x - 42,
      footer.updatedFontSize,
      24,
      '"DM Sans", Arial, sans-serif',
      700,
    );
    context.fillText(updateText, x, footer.updatedY);

    if (qr) {
      const size = footer.qrSize;
      const qrX = footer.qrCardX + footer.qrCardPadding;
      const qrY = footer.qrCardY + footer.qrCardPadding;
      const cardSize = size + footer.qrCardPadding * 2;
      fillRoundRect(context, footer.qrCardX, footer.qrCardY, cardSize, cardSize, 22, '#ffffff');
      context.save();
      context.imageSmoothingEnabled = false;
      context.drawImage(qr, qrX, qrY, size, size);
      context.restore();
      context.fillStyle = '#ffffff';
      context.font = `900 ${footer.qrLabelFontSize}px "DM Sans", Arial, sans-serif`;
      context.textAlign = 'center';
      context.fillText('SCAN TO BOOK', footer.qrCardX + cardSize / 2, footer.qrLabelY);
      context.textAlign = 'left';
    }
  }

  async function drawPoster(canvas, snapshot, formatName, options = {}) {
    const resolvedFormat = FORMATS[formatName] ? formatName : 'feed';
    const format = FORMATS[resolvedFormat];
    canvas.width = format.width;
    canvas.height = format.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('Canvas rendering is unavailable in this browser.');
    const story = resolvedFormat === 'story';
    const layout = { ...format, ...POSTER_LAYOUTS[resolvedFormat], story };
    const footer = FOOTER_LAYOUTS[resolvedFormat];
    const bookingUrl = text(options.bookingUrl) || DEFAULT_BOOKING_URL;
    const [logo, qr] = await Promise.all([
      options.logo === false ? null : logoImage(),
      options.qr === false ? null : qrCanvas(bookingUrl, footer.qrSize),
    ]);

    context.clearRect(0, 0, format.width, format.height);
    context.fillStyle = '#fff8f2';
    context.fillRect(0, 0, format.width, format.height);
    const glow = context.createRadialGradient(format.width * .78, format.height * .05, 10, format.width * .78, format.height * .05, format.width * .72);
    glow.addColorStop(0, 'rgba(217,4,22,.16)');
    glow.addColorStop(.38, 'rgba(217,4,22,.05)');
    glow.addColorStop(1, 'rgba(242,245,246,0)');
    context.fillStyle = glow;
    context.fillRect(0, 0, format.width, format.height);
    drawCourtTexture(context, format.width, format.height);

    context.save();
    context.strokeStyle = 'rgba(217,4,22,.14)';
    context.lineWidth = 2;
    context.beginPath();
    context.arc(format.width + 40, story ? 380 : 300, story ? 410 : 330, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(format.width + 40, story ? 380 : 300, story ? 330 : 260, 0, Math.PI * 2);
    context.stroke();
    context.restore();

    drawBrand(context, logo, layout);
    drawPageMarker(context, layout, number(options.pageNumber, 1), number(options.totalPages, 1));
    const fullSummary = posterSummary(options.summarySnapshot || snapshot);
    drawHero(context, snapshot, fullSummary, layout);
    drawCourtCards(context, snapshot, posterSummary(snapshot), layout);
    drawFooter(context, snapshot, qr, layout, bookingUrl);
    return canvas;
  }

  async function renderActiveCanvas() {
    if (!state.canvas) return null;
    const renderToken = ++state.renderToken;
    const snapshot = currentSnapshot();
    const pages = updatePageUi();
    const pageSnapshot = pages[state.page] || pages[0];
    if (root?.document?.fonts?.ready) {
      try { await root.document.fonts.ready; } catch (_) { /* fall back to system fonts */ }
    }
    await drawPoster(state.canvas, pageSnapshot, state.format, {
      bookingUrl: state.options.bookingUrl,
      logo: state.options.logo,
      qr: state.options.qr,
      pageNumber: state.page + 1,
      totalPages: pages.length,
      summarySnapshot: snapshot,
    });
    if (renderToken !== state.renderToken) return null;
    state.lastCaption = buildCaption(snapshot, { bookingUrl: state.options.bookingUrl });
    return state.canvas;
  }

  function canvasBlob(canvas) {
    return new Promise((resolve, reject) => {
      canvas.toBlob(blob => {
        if (blob) resolve(blob);
        else reject(new Error('Could not create the PNG image.'));
      }, 'image/png');
    });
  }

  async function prepareOutputSet(label) {
    const snapshot = await ensureFreshForExport(label);
    setBusy(true, 'Rendering every carousel page from the fresh schedule…');
    const operationToken = state.operationToken;
    const pages = paginateSnapshot(snapshot, state.format);
    const items = [];
    for (let index = 0; index < pages.length; index += 1) {
      const canvas = root.document.createElement('canvas');
      await drawPoster(canvas, pages[index], state.format, {
        bookingUrl: state.options.bookingUrl,
        logo: state.options.logo,
        qr: state.options.qr,
        pageNumber: index + 1,
        totalPages: pages.length,
        summarySnapshot: snapshot,
      });
      if (!state.open || operationToken !== state.operationToken) throw new Error(`${label} was canceled because the studio was closed.`);
      items.push({
        canvas,
        blob: await canvasBlob(canvas),
        name: outputFileName(snapshot.date, state.format, index, pages.length),
        pageNumber: index + 1,
      });
      if (!state.open || operationToken !== state.operationToken) throw new Error(`${label} was canceled because the studio was closed.`);
    }
    return { items, snapshot };
  }

  function withOutputLock(operation) {
    if (state.outputPromise) return state.outputPromise;
    const request = Promise.resolve().then(operation);
    state.outputPromise = request;
    return request.finally(() => {
      setBusy(false);
      if (state.outputPromise === request) state.outputPromise = null;
    });
  }

  function shareErrorMessage(error) {
    if (error?.name === 'AbortError') return '';
    if (error?.name === 'NotAllowedError') {
      return 'The share sheet could not stay open while live slots refreshed. Use Download PNG, then upload the fresh image to Facebook.';
    }
    return text(error?.message) || 'Could not share the post. Use Download PNG, then upload it to Facebook.';
  }

  function download() {
    return withOutputLock(async () => {
      try {
        const { items } = await prepareOutputSet('download');
        items.forEach((item, index) => {
          const url = URL.createObjectURL(item.blob);
          const link = root.document.createElement('a');
          link.href = url;
          link.download = item.name;
          root.document.body.appendChild(link);
          link.click();
          link.remove();
          setTimeout(() => URL.revokeObjectURL(url), 1800 + index * 150);
        });
        notify(items.length > 1
          ? `${items.length} fresh, numbered carousel PNGs downloaded.`
          : 'Fresh PNG downloaded and ready for Facebook.', 'success');
      } catch (error) {
        notify(text(error?.message) || 'Download failed.', 'error');
      }
    });
  }

  async function writeClipboard(value) {
    if (root.navigator?.clipboard?.writeText) {
      await root.navigator.clipboard.writeText(value);
      return;
    }
    const textarea = root.document.createElement('textarea');
    textarea.value = value;
    textarea.setAttribute('readonly', '');
    textarea.style.position = 'fixed';
    textarea.style.opacity = '0';
    root.document.body.appendChild(textarea);
    textarea.select();
    const copied = root.document.execCommand('copy');
    textarea.remove();
    if (!copied) throw new Error('Clipboard access is unavailable.');
  }

  function copyCaption() {
    return withOutputLock(async () => {
      try {
        const snapshot = await ensureFreshForExport('caption copy');
        setBusy(true, 'Copying the fresh caption…');
        if (!state.open) throw new Error('Caption copy was canceled because the studio was closed.');
        state.lastCaption = buildCaption(snapshot, { bookingUrl: state.options.bookingUrl });
        await writeClipboard(state.lastCaption);
        notify('Fresh Facebook caption copied.', 'success');
      } catch (error) {
        notify(text(error?.message) || 'Could not copy the caption.', 'error');
      }
    });
  }

  function share() {
    if (typeof root.navigator?.share !== 'function') return;
    return withOutputLock(async () => {
      try {
        const { items, snapshot } = await prepareOutputSet('share');
        setBusy(true, 'Opening your share sheet…');
        const caption = buildCaption(snapshot, { bookingUrl: state.options.bookingUrl });
        const files = typeof root.File === 'function'
          ? items.map(item => new root.File([item.blob], item.name, { type: 'image/png' }))
          : [];
        let canAttachEveryPage = files.length === items.length;
        if (canAttachEveryPage && root.navigator.canShare) {
          try { canAttachEveryPage = root.navigator.canShare({ files }); } catch (_) { canAttachEveryPage = false; }
        }
        if (!canAttachEveryPage) {
          notify(`This device cannot attach all ${items.length} image${items.length === 1 ? '' : 's'}. Use Download ${items.length > 1 ? 'PNGs' : 'PNG'}, then upload ${items.length > 1 ? 'the numbered pages' : 'the image'} to Facebook.`, 'notice');
          return;
        }
        await root.navigator.share({ title: 'Pickle Bliss court availability', text: caption, files });
        notify('Availability post shared.', 'success');
      } catch (error) {
        const message = shareErrorMessage(error);
        if (message) notify(message, error?.name === 'NotAllowedError' ? 'notice' : 'error');
      }
    });
  }

  async function handleClick(event) {
    const button = event.target.closest('button');
    if (!button || !state.overlay?.contains(button)) return;
    const action = button.dataset.pragAction;
    const format = button.dataset.pragFormat;
    if (format) {
      state.format = FORMATS[format] ? format : 'feed';
      state.page = 0;
      updateFormatUi();
      await renderActiveCanvas();
      notify(`${FORMATS[state.format].label} selected.`, 'success');
      return;
    }
    if (action === 'close') close();
    else if (action === 'previous-page' || action === 'next-page') {
      const pages = paginateSnapshot(currentSnapshot(), state.format);
      const offset = action === 'previous-page' ? -1 : 1;
      state.page = clamp(state.page + offset, 0, Math.max(0, pages.length - 1));
      await renderActiveCanvas();
      notify(`Showing carousel page ${state.page + 1} of ${pages.length}.`, 'success');
    }
    else if (action === 'refresh') {
      try { await refresh({ replace: false }); } catch (_) { /* status already shown */ }
    } else if (action === 'download') await download();
    else if (action === 'copy') await copyCaption();
    else if (action === 'share') await share();
  }

  async function handleChange(event) {
    if (event.target.matches('[data-prag-date]')) {
      const requested = dateOnly(event.target.value);
      state.date = selectableDate(requested);
      event.target.value = state.date;
      state.selectedCourtIds.clear();
      state.snapshot = null;
      state.page = 0;
      try {
        await refresh({ replace: true, message: `Loading ${formatDate(state.date)}…` });
        if (requested && requested < minimumSelectableDate()) {
          notify(`Availability graphics use today or a future date. Showing ${formatDate(state.date)} instead.`, 'notice');
        }
      } catch (_) { /* status already shown */ }
      return;
    }
    if (event.target.matches('[data-prag-court]')) {
      const id = String(event.target.value);
      if (event.target.checked) state.selectedCourtIds.add(id);
      else state.selectedCourtIds.delete(id);
      if (!state.selectedCourtIds.size) {
        state.selectedCourtIds.add(id);
        event.target.checked = true;
        notify('Keep at least one court selected.', 'error');
        return;
      }
      state.page = 0;
      await renderActiveCanvas();
      const count = state.selectedCourtIds.size;
      notify(`${count} court${count === 1 ? '' : 's'} included in the graphic.`, 'success');
    }
  }

  async function open(options = {}) {
    ensureModal();
    if (state.open) close({ restoreFocus: false });
    state.options = { ...options };
    const requestedDate = dateOnly(options.date);
    state.date = selectableDate(requestedDate);
    state.format = FORMATS[options.format] ? options.format : 'feed';
    state.page = 0;
    state.snapshot = null;
    state.courts = [];
    state.selectedCourtIds = new Set();
    state.requestedCourtIds = unique(options.courtIds ?? options.court_ids ?? []);
    state.logoPromise = null;
    state.returnFocus = root.document.activeElement instanceof HTMLElement ? root.document.activeElement : null;
    state.open = true;
    state.overlay.hidden = false;
    root.document.body.classList.add('prag-modal-open');
    // A reopened studio starts at its settings, including the single mobile scroll area.
    state.overlay.querySelectorAll('.prag-workspace, .prag-controls').forEach(panel => {
      panel.scrollTop = 0;
      panel.scrollLeft = 0;
    });
    const dateInput = element('[data-prag-date]');
    if (dateInput) {
      dateInput.value = state.date;
      dateInput.min = minimumSelectableDate();
    }
    updateFormatUi();
    updateFreshnessUi();
    state.overlay.querySelector('.prag-modal')?.focus();
    clearInterval(state.freshnessTimer);
    state.freshnessTimer = setInterval(updateFreshnessUi, 30000);
    try {
      await refresh({ replace: true, message: 'Loading live court availability…' });
      if (requestedDate && requestedDate < minimumSelectableDate()) {
        notify(`Availability graphics use today or a future date. Showing ${formatDate(state.date)} instead.`, 'notice');
      }
    } catch (_) {
      renderCourtControls();
      await renderActiveCanvas();
    }
    return currentSnapshot();
  }

  function close(options = {}) {
    if (!state.overlay || !state.open) return;
    state.open = false;
    state.operationToken += 1;
    state.overlay.hidden = true;
    setBusy(false);
    root.document.body.classList.remove('prag-modal-open');
    clearInterval(state.freshnessTimer);
    state.freshnessTimer = null;
    if (options.restoreFocus !== false && state.returnFocus?.isConnected) state.returnFocus.focus();
  }

  function destroy() {
    close();
    state.overlay?.remove();
    state.overlay = null;
    state.canvas = null;
    state.courts = [];
    state.snapshot = null;
  }

  return Object.freeze({
    open,
    close,
    destroy,
    refresh,
    download,
    copyCaption,
    share,
    shareErrorMessage,
    normalizeSnapshot,
    normalizeSlot,
    mergeAvailableRanges,
    formatPosterRange,
    posterCourtVisibility,
    posterSlotVisibility,
    buildCaption,
    drawPoster,
    isSnapshotStale,
    snapshotAge,
    formats: FORMATS,
    posterLayouts: POSTER_LAYOUTS,
    footerLayouts: FOOTER_LAYOUTS,
    qrRenderConfig: QR_RENDER_CONFIG,
    paginateSnapshot,
    rangeGridLayout,
    outputFileName,
    constants: Object.freeze({ MANILA_TIME_ZONE, FRESHNESS_LIMIT_MS, DEFAULT_BOOKING_URL }),
  });
});
