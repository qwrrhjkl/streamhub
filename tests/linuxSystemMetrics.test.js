const test = require('node:test');
const assert = require('node:assert/strict');

const {
  parseMountInfo,
  parseDiskStats,
  diskDelta,
  networkDelta,
  parseProcessStat,
  parseProcessStatus,
  parseProcessIo,
  processDelta,
  rankProcesses,
  createLinuxSystemMetricsCollector,
} = require('../server/lib/linuxSystemMetrics');

function procStat({
  pid = 42,
  name = 'video worker (main)',
  state = 'S',
  userTicks = 100,
  systemTicks = 20,
  startTimeTicks = 500,
} = {}) {
  const fields = Array(40).fill('0');
  fields[0] = state;
  fields[11] = String(userTicks);
  fields[12] = String(systemTicks);
  fields[19] = String(startTimeTicks);
  return `${pid} (${name}) ${fields.join(' ')}`;
}

test('mount parser keeps mounted block filesystems and decodes escaped paths', () => {
  const mounts = parseMountInfo([
    '36 25 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw',
    '37 25 0:31 / /proc rw,nosuid - proc proc rw',
    '38 25 8:17 / /media/Record\\040Disk rw,relatime - xfs /dev/sdb1 rw',
    '39 25 8:17 / /media/Record\\040Disk/bind rw,relatime - xfs /dev/sdb1 rw',
  ].join('\n'));

  assert.deepEqual(mounts, [
    { key: '259:2', source: '/dev/nvme0n1p2', mountPoint: '/', filesystem: 'ext4' },
    { key: '8:17', source: '/dev/sdb1', mountPoint: '/media/Record Disk', filesystem: 'xfs' },
  ]);
});

test('diskstats parser exposes sectors and io time by major minor key', () => {
  const stats = parseDiskStats([
    '259 2 nvme0n1p2 10 0 100 20 5 0 40 10 0 75 90',
    'malformed',
  ].join('\n'));

  assert.deepEqual(stats.get('259:2'), {
    name: 'nvme0n1p2',
    readSectors: 100,
    writeSectors: 40,
    ioMs: 75,
  });
  assert.equal(stats.size, 1);
});

test('disk delta calculates bounded activity and byte rates', () => {
  assert.deepEqual(diskDelta(
    { readSectors: 100, writeSectors: 50, ioMs: 1000 },
    { readSectors: 300, writeSectors: 150, ioMs: 2500 },
    2000,
  ), {
    activityPercent: 75,
    readBytesPerSec: 51_200,
    writeBytesPerSec: 25_600,
  });

  assert.equal(diskDelta(
    { readSectors: 300, writeSectors: 50, ioMs: 1000 },
    { readSectors: 200, writeSectors: 60, ioMs: 1100 },
    2000,
  ), null);
});

test('network delta calculates receive send and total rates', () => {
  assert.deepEqual(networkDelta(
    { rxBytes: 1000, txBytes: 2000 },
    { rxBytes: 5000, txBytes: 4000 },
    2000,
  ), {
    receiveBytesPerSec: 2000,
    sendBytesPerSec: 1000,
    totalBytesPerSec: 3000,
  });
  assert.equal(networkDelta(
    { rxBytes: 5000, txBytes: 2000 },
    { rxBytes: 4000, txBytes: 3000 },
    2000,
  ), null);
});

test('process parsers handle names with parentheses memory and optional io', () => {
  assert.deepEqual(parseProcessStat(procStat()), {
    pid: 42,
    name: 'video worker (main)',
    stateCode: 'S',
    cpuTicks: 120,
    startTimeTicks: 500,
  });
  assert.equal(parseProcessStatus('Name:\tworker\nVmRSS:\t2048 kB\n').memoryBytes, 2 * 1024 * 1024);
  assert.deepEqual(parseProcessIo('read_bytes: 4096\nwrite_bytes: 2048\ncancelled_write_bytes: 0\n'), {
    readBytes: 4096,
    writeBytes: 2048,
  });
  assert.deepEqual(parseProcessIo('permission denied'), { readBytes: null, writeBytes: null });
});

test('process delta uses total host ticks and rejects pid reuse', () => {
  const previous = {
    pid: 42, name: 'ffmpeg', stateCode: 'S', cpuTicks: 100, startTimeTicks: 500,
    memoryBytes: 1_000_000, readBytes: 1000, writeBytes: 2000,
  };
  const current = {
    ...previous,
    stateCode: 'R',
    cpuTicks: 150,
    memoryBytes: 2_000_000,
    readBytes: 5000,
    writeBytes: 6000,
  };

  assert.deepEqual(processDelta(previous, current, 1000, 2000, 10_000_000), {
    pid: 42,
    name: 'ffmpeg',
    state: 'running',
    cpuPercent: 5,
    memoryBytes: 2_000_000,
    memoryPercent: 20,
    readBytesPerSec: 2000,
    writeBytesPerSec: 2000,
  });

  assert.deepEqual(processDelta(previous, { ...current, startTimeTicks: 900 }, 1000, 2000, 10_000_000), {
    pid: 42,
    name: 'ffmpeg',
    state: 'running',
    cpuPercent: null,
    memoryBytes: 2_000_000,
    memoryPercent: 20,
    readBytesPerSec: null,
    writeBytesPerSec: null,
  });
});

test('process ranking returns separate sanitized CPU and memory top tens', () => {
  const processes = Array.from({ length: 12 }, (_, index) => ({
    pid: 100 + index,
    name: `worker-${index}`,
    state: 'sleeping',
    cpuPercent: index,
    memoryBytes: (20 - index) * 1024,
    memoryPercent: 20 - index,
    readBytesPerSec: index * 10,
    writeBytesPerSec: index * 20,
    commandLine: `worker-${index} --secret hidden`,
  }));

  const ranked = rankProcesses(processes, 10);

  assert.equal(ranked.byCpu.length, 10);
  assert.equal(ranked.byMemory.length, 10);
  assert.equal(ranked.byCpu[0].name, 'worker-11');
  assert.equal(ranked.byMemory[0].name, 'worker-0');
  assert.equal(Object.hasOwn(ranked.byCpu[0], 'commandLine'), false);
  assert.deepEqual(Object.keys(ranked.byCpu[0]), [
    'pid', 'name', 'state', 'cpuPercent', 'memoryBytes', 'memoryPercent',
    'readBytesPerSec', 'writeBytesPerSec',
  ]);
});

function linuxFixture({ failMounts = false } = {}) {
  let sampleIndex = -1;
  const samples = [
    {
      disk: '259 2 nvme0n1p2 10 0 100 20 5 0 50 10 0 500 90',
      networkRx: '1000',
      networkTx: '2000',
      cpu: 'cpu  100 0 100 800 0 0 0 0 0 0',
      process: procStat({ userTicks: 100, systemTicks: 20 }),
      io: 'read_bytes: 1000\nwrite_bytes: 2000\n',
    },
    {
      disk: '259 2 nvme0n1p2 10 0 300 20 5 0 150 10 0 1500 90',
      networkRx: '5000',
      networkTx: '4000',
      cpu: 'cpu  400 0 200 1400 0 0 0 0 0 0',
      process: procStat({ userTicks: 150, systemTicks: 20 }),
      io: 'read_bytes: 5000\nwrite_bytes: 6000\n',
    },
  ];
  const readFile = async path => {
    const sample = samples[Math.max(0, sampleIndex)];
    if (path === '/proc/self/mountinfo') {
      if (failMounts) throw new Error('mountinfo unavailable');
      return '36 25 259:2 / / rw,relatime - ext4 /dev/nvme0n1p2 rw\n';
    }
    if (path === '/proc/diskstats') return sample.disk;
    if (path === '/sys/dev/block/259:2/device/model') return 'KINGSTON NVMe\n';
    if (path === '/sys/dev/block/259:2/queue/rotational') return '0\n';
    if (path === '/sys/class/net/eno1/operstate') return 'up\n';
    if (path === '/sys/class/net/eno1/statistics/rx_bytes') return sample.networkRx;
    if (path === '/sys/class/net/eno1/statistics/tx_bytes') return sample.networkTx;
    if (path === '/sys/class/net/eno1/speed') return '1000\n';
    if (path === '/proc/stat') return sample.cpu;
    if (path === '/proc/42/stat') return sample.process;
    if (path === '/proc/42/status') return 'Name:\tffmpeg\nVmRSS:\t2048 kB\n';
    if (path === '/proc/42/io') return sample.io;
    throw new Error(`unexpected read: ${path}`);
  };
  return {
    platform: 'linux',
    nowMs: () => {
      sampleIndex += 1;
      return (sampleIndex + 1) * 2000;
    },
    readFile,
    readdir: async path => path === '/proc' ? ['42', 'self', 'sys'] : [],
    statfs: async () => ({ bsize: 4096, blocks: 1000, bavail: 250 }),
    networkInterfaces: () => ({
      lo: [{ address: '127.0.0.1', family: 'IPv4', internal: true, mac: '00:00:00:00:00:00' }],
      eno1: [{ address: '192.168.11.232', family: 'IPv4', internal: false, mac: '00:11:22:33:44:55' }],
    }),
    totalMemory: () => 10 * 1024 * 1024,
  };
}

test('Linux collector calculates disk network and process deltas on the second sample', async () => {
  const collector = createLinuxSystemMetricsCollector(linuxFixture());

  const first = await collector.snapshot();
  const second = await collector.snapshot();

  assert.equal(first.disk.devices[0].activityPercent, null);
  assert.equal(second.disk.available, true);
  assert.deepEqual(second.disk.devices[0], {
    id: 'disk-259-2',
    name: 'KINGSTON NVMe',
    device: 'nvme0n1p2',
    source: '/dev/nvme0n1p2',
    mountPoint: '/',
    filesystem: 'ext4',
    type: 'SSD',
    available: true,
    activityPercent: 50,
    readBytesPerSec: 51_200,
    writeBytesPerSec: 25_600,
    usedBytes: 3_072_000,
    availableBytes: 1_024_000,
    totalBytes: 4_096_000,
  });
  assert.equal(second.network.available, true);
  assert.equal(second.network.interfaces[0].receiveBytesPerSec, 2000);
  assert.equal(second.network.interfaces[0].sendBytesPerSec, 1000);
  assert.equal(second.network.interfaces[0].speedMbps, 1000);
  assert.equal(second.processes.available, true);
  assert.equal(second.processes.byCpu[0].pid, 42);
  assert.equal(second.processes.byCpu[0].cpuPercent, 5);
  assert.equal(second.processes.byCpu[0].readBytesPerSec, 2000);
});

test('Linux collector degrades disk collection independently', async () => {
  const collector = createLinuxSystemMetricsCollector(linuxFixture({ failMounts: true }));

  const snapshot = await collector.snapshot();

  assert.equal(snapshot.disk.available, false);
  assert.match(snapshot.disk.message, /磁盘/);
  assert.equal(snapshot.network.available, true);
  assert.equal(snapshot.processes.available, true);
});

test('Linux collector avoids proc and sys reads on unsupported platforms', async () => {
  let reads = 0;
  const collector = createLinuxSystemMetricsCollector({
    platform: 'win32',
    readFile: async () => { reads += 1; },
  });

  const snapshot = await collector.snapshot();

  assert.equal(reads, 0);
  assert.equal(snapshot.disk.available, false);
  assert.equal(snapshot.network.available, false);
  assert.equal(snapshot.processes.available, false);
});
