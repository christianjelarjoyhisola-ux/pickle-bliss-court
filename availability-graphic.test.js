const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

const graphic = require('./availability-graphic.js');

function sampleSnapshot() {
  return {
    date: '2026-09-21',
    timezone: 'Asia/Manila',
    generatedAt: '2026-09-20T13:00:00+08:00',
    courts: [{
      id: 'court-1',
      name: 'Pickle Bliss Court',
      slots: [
        { startHour: 6, endHour: 7, state: 'free', label: 'Available' },
        { startHour: 7, endHour: 8, state: 'free', label: 'Available' },
        { startHour: 8, endHour: 9, state: 'unavailable', reason: 'booked', label: 'Booked' },
      ],
    }],
  };
}

test('uses Pickle Bliss booking and social branding', () => {
  assert.equal(graphic.constants.DEFAULT_BOOKING_URL, 'https://pickleblisscourt.com/');
  assert.equal(
    graphic.outputFileName('2026-09-21', 'feed'),
    'pickle-bliss-availability-2026-09-21-feed.png',
  );
  const caption = graphic.buildCaption(sampleSnapshot());
  assert.match(caption, /https:\/\/pickleblisscourt\.com\//);
  assert.match(caption, /#PickleBliss #PickleballMonkayo #BookYourCourt/);
  assert.doesNotMatch(caption, /PickleStreet|Pickle Street/);
});

test('merges adjacent live availability without exposing booking details', () => {
  const snapshot = graphic.normalizeSnapshot(sampleSnapshot(), '2026-09-21');
  const ranges = graphic.mergeAvailableRanges(snapshot.courts[0].slots);
  assert.deepEqual(ranges, [{ start: 6, end: 8, label: '6–8 AM' }]);
  const caption = graphic.buildCaption(snapshot);
  assert.match(caption, /Pickle Bliss Court: 6–8 AM/);
  assert.doesNotMatch(caption, /customer|email|contact/i);
});

test('admin loads the studio and the Pickle Bliss data adapter', () => {
  const admin = fs.readFileSync('admin.html', 'utf8');
  const client = fs.readFileSync('supabase-config.js', 'utf8');
  const source = fs.readFileSync('availability-graphic.js', 'utf8');
  assert.match(admin, /Availability Post/);
  assert.match(admin, /availability-graphic\.js/);
  assert.match(admin, /qrcode\.min\.js/);
  assert.match(client, /async getAvailabilityGraphic\(date, courtIds = \[\]\)/);
  assert.match(client, /maintenance_config/);
  assert.match(source, /root\.PickleBlissAvailabilityGraphic/);
  assert.match(source, /pickle-bliss-logo\.jpg/);
  assert.match(source, /PICKLE BLISS/);
  assert.doesNotMatch(source, /Pickle Street|picklestreet|PICKLE STREET/);
});
