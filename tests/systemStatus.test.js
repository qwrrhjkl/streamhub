const test = require('node:test');
const assert = require('node:assert/strict');

const {
  cpuUsageBetween,
  memorySnapshot,
  parseNvidiaSmiCsv,
  createSystemStatusCollector,
} = require('../server/lib/systemStatus');

const cpu = (user, idle, speed = 2000) => ({
  model: 'Test CPU',
  speed,
  times: { user, nice: 0, sys: 0, idle, irq: 0 },
});

test('CPU utilization uses aggregate busy and total deltas', () => {
  const previous = [cpu(100, 900), cpu(200, 800)];
  const current = [cpu(160, 940), cpu(260, 840)];

  assert.equal(cpuUsageBetween(previous, current), 60);
  assert.equal(cpuUsageBetween(null, current), null);
});

test('CPU utilization rejects invalid or regressed samples', () => {
  assert.equal(cpuUsageBetween([cpu(100, 900)], [cpu(90, 890)]), null);
  assert.equal(cpuUsageBetween([cpu(100, 900)], []), null);
});

test('memory snapshot reports used available total and percentage', () => {
  assert.deepEqual(memorySnapshot(16_000, 4_000), {
    available: true,
    usagePercent: 75,
    usedBytes: 12_000,
    availableBytes: 4_000,
    totalBytes: 16_000,
  });
});

test('NVIDIA CSV parser supports multiple devices and nullable values', () => {
  assert.deepEqual(parseNvidiaSmiCsv([
    '0, NVIDIA RTX 4060, 15, 1024, 8192, 51, 8, 3',
    '1, NVIDIA RTX A4000, N/A, 2048, 16384, N/A, N/A, 0',
  ].join('\n')), [
    {
      id: 'gpu-0', index: 0, name: 'NVIDIA RTX 4060', usagePercent: 15,
      memoryUsedMib: 1024, memoryTotalMib: 8192, temperatureC: 51,
      encoderUsagePercent: 8, decoderUsagePercent: 3,
    },
    {
      id: 'gpu-1', index: 1, name: 'NVIDIA RTX A4000', usagePercent: null,
      memoryUsedMib: 2048, memoryTotalMib: 16384, temperatureC: null,
      encoderUsagePercent: null, decoderUsagePercent: 0,
    },
  ]);
});

test('NVIDIA CSV parser ignores malformed rows without losing valid devices', () => {
  const devices = parseNvidiaSmiCsv([
    'malformed row',
    '0, NVIDIA RTX 4060, 0, 1024, 8192, 51, 0, 0',
  ].join('\n'));

  assert.equal(devices.length, 1);
  assert.equal(devices[0].usagePercent, 0);
});

test('collector keeps CPU and memory when NVIDIA collection fails', async () => {
  const system = {
    cpus: () => [cpu(100, 900, 2100)],
    totalmem: () => 16_000,
    freemem: () => 4_000,
    loadavg: () => [1.25, 0, 0],
    uptime: () => 3600,
  };
  const collector = createSystemStatusCollector({
    system,
    now: () => new Date('2026-07-26T12:00:00.000Z'),
    runCommand: async () => ({ ok: false, stdout: '', error: 'ENOENT' }),
  });

  const first = await collector.snapshot();

  assert.equal(first.sampledAt, '2026-07-26T12:00:00.000Z');
  assert.equal(first.cpu.usagePercent, null);
  assert.equal(first.memory.usagePercent, 75);
  assert.deepEqual(first.gpu, {
    available: false,
    message: '未检测到可用的 NVIDIA GPU',
    devices: [],
  });
});

test('collector returns CPU details and parsed GPU devices', async () => {
  let calls = 0;
  const samples = [[cpu(100, 900, 2100)], [cpu(160, 940, 1900)]];
  const collector = createSystemStatusCollector({
    system: {
      cpus: () => samples[Math.min(calls++, 1)],
      totalmem: () => 16_000,
      freemem: () => 4_000,
      loadavg: () => [1.25, 0, 0],
      uptime: () => 3600,
    },
    runCommand: async () => ({
      ok: true,
      stdout: '0, NVIDIA RTX 4060, 15, 1024, 8192, 51, 8, 3',
    }),
  });

  await collector.snapshot();
  const result = await collector.snapshot();

  assert.equal(result.cpu.usagePercent, 60);
  assert.equal(result.cpu.model, 'Test CPU');
  assert.equal(result.cpu.logicalCores, 1);
  assert.equal(result.cpu.averageSpeedMhz, 1900);
  assert.equal(result.cpu.loadAverage1m, 1.25);
  assert.equal(result.cpu.uptimeSec, 3600);
  assert.equal(result.gpu.devices[0].name, 'NVIDIA RTX 4060');
});

test('collector composes disk network and process sections', async () => {
  const linuxSnapshot = {
    disk: { available: true, message: '', devices: [{ id: 'disk-8-1' }] },
    network: { available: true, message: '', interfaces: [{ id: 'network-eno1' }] },
    processes: {
      available: true,
      message: '',
      byCpu: [{ pid: 42, name: 'ffmpeg' }],
      byMemory: [{ pid: 42, name: 'ffmpeg' }],
    },
  };
  const collector = createSystemStatusCollector({
    system: {
      cpus: () => [cpu(100, 900)],
      totalmem: () => 16_000,
      freemem: () => 4_000,
      loadavg: () => [1, 0, 0],
      uptime: () => 100,
    },
    runCommand: async () => ({ ok: false, stdout: '' }),
    linuxMetrics: { snapshot: async () => linuxSnapshot },
  });

  const result = await collector.snapshot();

  assert.deepEqual(result.disk, linuxSnapshot.disk);
  assert.deepEqual(result.network, linuxSnapshot.network);
  assert.deepEqual(result.processes, linuxSnapshot.processes);
});

test('collector keeps CPU memory and GPU when Linux metrics fail', async () => {
  const collector = createSystemStatusCollector({
    system: {
      cpus: () => [cpu(100, 900)],
      totalmem: () => 16_000,
      freemem: () => 4_000,
      loadavg: () => [1, 0, 0],
      uptime: () => 100,
    },
    runCommand: async () => ({
      ok: true,
      stdout: '0, NVIDIA RTX 4060, 15, 1024, 8192, 51, 8, 3',
    }),
    linuxMetrics: { snapshot: async () => { throw new Error('proc unavailable'); } },
  });

  const result = await collector.snapshot();

  assert.equal(result.cpu.available, true);
  assert.equal(result.memory.available, true);
  assert.equal(result.gpu.available, true);
  assert.equal(result.disk.available, false);
  assert.equal(result.network.available, false);
  assert.equal(result.processes.available, false);
});
