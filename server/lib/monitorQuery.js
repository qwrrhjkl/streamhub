function badRequest(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

const HISTORY_MODES = new Set(['none', 'memory', 'persistent']);

function parseHistoryMode(searchParams) {
  const requested = String(searchParams.get('history') || 'persistent').trim().toLowerCase();
  if (!HISTORY_MODES.has(requested)) throw badRequest('history 必须是 none、memory 或 persistent');
  return requested;
}

function parseMonitorQuery(searchParams) {
  const outputId = String(searchParams.get('outputId') || '').trim();
  const fromText = searchParams.get('from');
  const toText = searchParams.get('to');
  const hasExactRange = fromText !== null && toText !== null;
  const rangeText = searchParams.get('rangeSec');
  const requestedRange = rangeText === null ? 900 : Math.max(0, Number(rangeText) || 0);
  const options = {
    rangeSec: Math.min(259200, requestedRange),
    ...(outputId ? { outputId } : {}),
    historyMode: parseHistoryMode(searchParams),
  };

  if (!hasExactRange) return options;

  const from = Number(fromText);
  const to = Number(toText);
  if (!Number.isFinite(from) || !Number.isFinite(to)) throw badRequest('开始时间和结束时间必须是有效时间');
  if (to < from) throw badRequest('结束时间不能早于开始时间');
  return { ...options, rangeSec: 0, from, to };
}

module.exports = { parseMonitorQuery };
