const test = require('node:test');
const assert = require('node:assert/strict');

let parseMonitorQuery;
try {
  ({ parseMonitorQuery } = require('../server/lib/monitorQuery'));
} catch {}

test('monitor query parses a rolling range and one output id', () => {
  assert.equal(typeof parseMonitorQuery, 'function');

  const options = parseMonitorQuery(new URLSearchParams('rangeSec=900&outputId=pipe-a-dest-b'));

  assert.deepEqual(options, { rangeSec: 900, outputId: 'pipe-a-dest-b', historyMode: 'persistent' });
});

test('monitor query defaults to 15 minutes and clamps rolling history to three days', () => {
  assert.deepEqual(parseMonitorQuery(new URLSearchParams()), { rangeSec: 900, historyMode: 'persistent' });
  assert.deepEqual(parseMonitorQuery(new URLSearchParams('rangeSec=259200')), { rangeSec: 259200, historyMode: 'persistent' });
  assert.deepEqual(parseMonitorQuery(new URLSearchParams('rangeSec=999999')), { rangeSec: 259200, historyMode: 'persistent' });
});

test('monitor query validates explicit history modes', () => {
  assert.deepEqual(
    parseMonitorQuery(new URLSearchParams('rangeSec=900&history=none')),
    { rangeSec: 900, historyMode: 'none' },
  );
  assert.deepEqual(
    parseMonitorQuery(new URLSearchParams('rangeSec=900&history=memory')),
    { rangeSec: 900, historyMode: 'memory' },
  );
  assert.deepEqual(
    parseMonitorQuery(new URLSearchParams('rangeSec=900&history=persistent')),
    { rangeSec: 900, historyMode: 'persistent' },
  );
});

test('monitor query rejects an unknown history mode as a bad request', () => {
  assert.throws(
    () => parseMonitorQuery(new URLSearchParams('history=cache')),
    error => error.statusCode === 400 && /history/.test(error.message),
  );
});

test('monitor query gives an exact time period priority over rolling range', () => {
  assert.equal(typeof parseMonitorQuery, 'function');

  const options = parseMonitorQuery(new URLSearchParams('rangeSec=900&from=15000&to=25000&outputId=pipe%2Fa'));

  assert.deepEqual(options, {
    rangeSec: 0,
    from: 15_000,
    to: 25_000,
    outputId: 'pipe/a',
    historyMode: 'persistent',
  });
});

test('monitor query rejects a reversed exact time period as a bad request', () => {
  assert.equal(typeof parseMonitorQuery, 'function');

  assert.throws(
    () => parseMonitorQuery(new URLSearchParams('from=25000&to=15000')),
    error => error.statusCode === 400 && /结束时间不能早于开始时间/.test(error.message),
  );
});
