'use strict';

const { execFile, spawnSync } = require('node:child_process');
const { resolveMediaBinaries } = require('./mediaBinaries');

function run(command, args = [], timeout = 10000) {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout, windowsHide: true }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error ? error.message : '' });
    });
    child.on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
  });
}

function combinedOutput(result) {
  return [result && result.stdout, result && result.stderr].filter(Boolean).join('\n');
}

function parseDecklinkDevices(text) {
  const names = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const quoted = line.match(/^\s*"([^"]+)"\s+\[/);
    const logged = line.match(/\]\s+'([^']+)'\s*$/);
    const identifier = line.match(/^\s*(\S+)\s+\[[^\]]+\]\s+\([^)]*\)\s*$/);
    const plain = line.match(/^\s{2,}(.+?)\s+\[[^\]]+\]\s*$/);
    const name = String(quoted && quoted[1] || logged && logged[1] || identifier && identifier[1] || plain && plain[1] || '').trim();
    if (name && !names.includes(name)) names.push(name);
  }
  return names;
}

function parseDecklinkFormats(text) {
  const formats = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/(?:\]\s+|^\s*)([A-Za-z0-9]{2,8})\s+(\d+)x(\d+)\s+at\s+([0-9/.]+)\s+fps(?:\s+\(([^)]*)\))?/);
    if (!match) continue;
    formats.push({
      code: match[1],
      width: Number(match[2]),
      height: Number(match[3]),
      fps: match[4],
      scan: String(match[5] || '').split(',')[0].trim(),
    });
  }
  return formats;
}

async function invoke(runCommand, command, args, timeout) {
  try {
    return await runCommand(command, args, timeout);
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', error: String(error && error.message || error) };
  }
}

async function listDecklinkDevices({ runCommand = run, binaries = resolveMediaBinaries() } = {}) {
  const result = await invoke(runCommand, binaries.ffmpeg, ['-hide_banner', '-sources', 'decklink'], 10000);
  const text = combinedOutput(result);
  const devices = parseDecklinkDevices(text);
  return {
    ok: devices.length > 0,
    devices,
    text,
    error: devices.length ? '' : String(result && result.error || '').trim(),
  };
}

async function listDecklinkFormats(device, { runCommand = run, binaries = resolveMediaBinaries() } = {}) {
  const name = String(device || '').trim();
  if (!name) return { ok: true, formats: [], text: '', error: '' };
  const args = ['-hide_banner', '-f', 'decklink', '-list_formats', '1', '-i', name];
  const result = await invoke(runCommand, binaries.ffmpeg, args, 10000);
  const text = combinedOutput(result);
  const formats = parseDecklinkFormats(text);
  return {
    ok: formats.length > 0,
    formats,
    text,
    error: formats.length ? '' : String(result && result.error || '').trim(),
  };
}

function runPreflight(runner, command, args) {
  try {
    return runner(command, args, { encoding: 'utf8', timeout: 10000, windowsHide: true }) || {};
  } catch (error) {
    return { status: null, stdout: '', stderr: '', error };
  }
}

function checkDecklinkAvailability(source, runner = spawnSync, binaries = resolveMediaBinaries()) {
  const capture = source && source.capture || {};
  const deviceName = String(capture.device || '').trim();
  if (!deviceName) return { ok: false, diagnostic: '未配置 DeckLink 设备名称' };

  const deviceResult = runPreflight(runner, binaries.ffmpeg, ['-hide_banner', '-sources', 'decklink']);
  const devices = parseDecklinkDevices(combinedOutput(deviceResult));
  if (!devices.includes(deviceName)) {
    const details = String(deviceResult.error && (deviceResult.error.message || deviceResult.error) || '').trim();
    return { ok: false, diagnostic: `未找到设备 ${deviceName}${details ? `：${details}` : ''}` };
  }

  const formatCode = String(capture.formatCode || 'auto').trim();
  if (!formatCode || formatCode.toLowerCase() === 'auto') return { ok: true, diagnostic: '' };
  const formatResult = runPreflight(runner, binaries.ffmpeg, [
    '-hide_banner', '-f', 'decklink', '-list_formats', '1', '-i', deviceName,
  ]);
  const formats = parseDecklinkFormats(combinedOutput(formatResult));
  if (!formats.some(format => format.code === formatCode)) {
    return { ok: false, diagnostic: `设备不支持格式 ${formatCode}` };
  }
  return { ok: true, diagnostic: '' };
}

module.exports = {
  parseDecklinkDevices,
  parseDecklinkFormats,
  listDecklinkDevices,
  listDecklinkFormats,
  checkDecklinkAvailability,
};
