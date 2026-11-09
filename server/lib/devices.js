const fs = require('node:fs');
const { execFile } = require('node:child_process');
const { resolveMediaBinaries } = require('./mediaBinaries');
const { listDecklinkDevices, listDecklinkFormats } = require('./decklink');

function run(command, args = [], timeout = 5000) {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({ ok: !error, stdout: stdout || '', stderr: stderr || '', error: error ? error.message : '' });
    });
    child.on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
  });
}

async function safeRun(runCommand, command, args, timeout) {
  try {
    return await runCommand(command, args, timeout);
  } catch (error) {
    return { ok: false, stdout: '', stderr: '', error: String(error && error.message || error) };
  }
}

function parseV4l2Devices(text, nodes = []) {
  const devices = [];
  let currentName = '';
  const add = (path, name = '') => {
    if (!path || devices.some(device => device.id === path)) return;
    const label = String(name || '').trim() || path;
    devices.push({ id: path, path, name: label, label: `${label} · ${path}` });
  };

  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const paths = trimmed.match(/\/dev\/video\d+/g) || [];
    if (!/^\s/.test(line) && paths.length === 0) currentName = trimmed.replace(/:\s*$/, '');
    paths.forEach(path => add(path, currentName));
  }
  nodes.forEach(path => add(path));
  return devices;
}

function parseAlsaDevices(text) {
  const devices = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const match = line.match(/^\s*card\s+(\d+):\s*([^\[]+)\[([^\]]*)\].*device\s+(\d+):\s*([^\[]+)\[([^\]]*)\]/i);
    if (!match) continue;
    const card = Number(match[1]);
    const device = Number(match[4]);
    if (!Number.isInteger(card) || !Number.isInteger(device)) continue;
    const cardName = String(match[3] || match[2] || '').trim();
    const deviceName = String(match[6] || match[5] || '').trim();
    const id = `hw:${card},${device}`;
    const name = [cardName, deviceName].filter(Boolean).filter((value, index, values) => values.indexOf(value) === index).join(' · ') || id;
    if (!devices.some(item => item.id === id)) devices.push({ id, card, device, name, label: `${name} · ${id}` });
  }
  return devices;
}

async function listDevices({
  readDevDir = () => fs.readdirSync('/dev'),
  runCommand = run,
  binaries = resolveMediaBinaries(),
  decklinkDevice = '',
} = {}) {
  let videoNodes = [];
  let nodeError = '';
  try {
    videoNodes = readDevDir().filter(name => /^video\d+$/.test(name)).sort().map(name => `/dev/${name}`);
  } catch (error) {
    nodeError = String(error && error.message || error);
  }
  const [v4l, audio, decklinkDevices] = await Promise.all([
    safeRun(runCommand, 'v4l2-ctl', ['--list-devices'], 5000),
    safeRun(runCommand, 'arecord', ['-l'], 5000),
    listDecklinkDevices({ runCommand, binaries }),
  ]);
  const decklinkFormats = await listDecklinkFormats(decklinkDevice, { runCommand, binaries });
  const v4l2Text = String(v4l && (v4l.stdout || v4l.stderr) || '');
  const alsaText = String(audio && (audio.stdout || audio.stderr) || '');
  return {
    v4l2: {
      ok: Boolean(v4l && v4l.ok) && !nodeError,
      nodes: videoNodes,
      devices: parseV4l2Devices(v4l2Text, videoNodes),
      text: v4l2Text,
      error: nodeError || String(v4l && v4l.error || ''),
    },
    alsa: {
      ok: Boolean(audio && audio.ok),
      devices: parseAlsaDevices(alsaText),
      text: alsaText,
      error: String(audio && audio.error || ''),
    },
    decklink: {
      ok: decklinkDevices.ok,
      devices: decklinkDevices.devices,
      formats: decklinkFormats.formats,
      text: [decklinkDevices.text, decklinkFormats.text].filter(Boolean).join('\n'),
      error: decklinkDevices.error || decklinkFormats.error,
    },
  };
}

async function probeInput(input, { runCommand = run, binaries = resolveMediaBinaries() } = {}) {
  const target = input.url || input.path || input.device;
  if (!target) throw new Error('需要 url/path/device');
  const result = await runCommand(binaries.ffprobe, ['-hide_banner', '-v', 'error', '-show_format', '-show_streams', '-print_format', 'json', target], 10000);
  if (!result.ok) throw new Error(result.stderr || result.error || 'ffprobe failed');
  return JSON.parse(result.stdout || '{}');
}

module.exports = {
  listDevices,
  parseAlsaDevices,
  parseV4l2Devices,
  probeInput,
};
