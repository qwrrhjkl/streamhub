const PSEUDO_FILESYSTEMS = new Set([
  'proc',
  'sysfs',
  'tmpfs',
  'devtmpfs',
  'cgroup',
  'cgroup2',
  'overlay',
  'squashfs',
]);

const PROCESS_FIELDS = [
  'pid',
  'name',
  'state',
  'cpuPercent',
  'memoryBytes',
  'memoryPercent',
  'readBytesPerSec',
  'writeBytesPerSec',
];

function decodeMountPath(value) {
  const escapes = { '040': ' ', '011': '\t', '134': '\\' };
  return String(value || '').replace(/\\(040|011|134)/g, (_, code) => escapes[code]);
}

function parseMountInfo(text) {
  const rows = String(text || '')
    .split(/\r?\n/)
    .flatMap(line => {
      const [mountPart, filesystemPart] = line.split(' - ');
      if (!mountPart || !filesystemPart) return [];
      const mountFields = mountPart.trim().split(/\s+/);
      const filesystemFields = filesystemPart.trim().split(/\s+/);
      const key = mountFields[2];
      const mountPoint = decodeMountPath(mountFields[4]);
      const filesystem = filesystemFields[0];
      const source = decodeMountPath(filesystemFields[1]);
      if (
        !/^\d+:\d+$/.test(key) ||
        !source.startsWith('/dev/') ||
        PSEUDO_FILESYSTEMS.has(filesystem)
      ) return [];
      return [{ key, source, mountPoint, filesystem }];
    })
    .sort((left, right) => left.mountPoint.localeCompare(right.mountPoint));

  const seen = new Set();
  return rows.filter(row => {
    if (seen.has(row.key)) return false;
    seen.add(row.key);
    return true;
  });
}

function parseDiskStats(text) {
  const result = new Map();
  String(text || '').split(/\r?\n/).forEach(line => {
    const fields = line.trim().split(/\s+/);
    if (fields.length < 13) return;
    const values = [fields[0], fields[1], fields[5], fields[9], fields[12]].map(Number);
    if (values.some(value => !Number.isFinite(value) || value < 0)) return;
    result.set(`${values[0]}:${values[1]}`, {
      name: fields[2],
      readSectors: values[2],
      writeSectors: values[3],
      ioMs: values[4],
    });
  });
  return result;
}

function diskDelta(previous, current, elapsedMs) {
  if (!previous || !current || !(elapsedMs > 0)) return null;
  const readSectors = current.readSectors - previous.readSectors;
  const writeSectors = current.writeSectors - previous.writeSectors;
  const ioMs = current.ioMs - previous.ioMs;
  if ([readSectors, writeSectors, ioMs].some(value => !Number.isFinite(value) || value < 0)) return null;
  return {
    activityPercent: Math.min(100, ioMs / elapsedMs * 100),
    readBytesPerSec: readSectors * 512 * 1000 / elapsedMs,
    writeBytesPerSec: writeSectors * 512 * 1000 / elapsedMs,
  };
}

function networkDelta(previous, current, elapsedMs) {
  if (!previous || !current || !(elapsedMs > 0)) return null;
  const received = current.rxBytes - previous.rxBytes;
  const sent = current.txBytes - previous.txBytes;
  if (![received, sent].every(value => Number.isFinite(value) && value >= 0)) return null;
  return {
    receiveBytesPerSec: received * 1000 / elapsedMs,
    sendBytesPerSec: sent * 1000 / elapsedMs,
    totalBytesPerSec: (received + sent) * 1000 / elapsedMs,
  };
}

function parseProcessStat(text) {
  const value = String(text || '').trim();
  const open = value.indexOf('(');
  const close = value.lastIndexOf(')');
  if (open < 1 || close <= open) return null;
  const pid = Number(value.slice(0, open).trim());
  const name = value.slice(open + 1, close);
  const fields = value.slice(close + 1).trim().split(/\s+/);
  const stateCode = fields[0];
  const userTicks = Number(fields[11]);
  const systemTicks = Number(fields[12]);
  const startTimeTicks = Number(fields[19]);
  if (
    !Number.isInteger(pid) ||
    pid <= 0 ||
    !name ||
    !stateCode ||
    ![userTicks, systemTicks, startTimeTicks].every(valuePart => Number.isFinite(valuePart) && valuePart >= 0)
  ) return null;
  return {
    pid,
    name,
    stateCode,
    cpuTicks: userTicks + systemTicks,
    startTimeTicks,
  };
}

function parseProcessStatus(text) {
  const match = String(text || '').match(/^VmRSS:\s+(\d+)\s+kB$/im);
  const kibibytes = match ? Number(match[1]) : null;
  return {
    memoryBytes: Number.isFinite(kibibytes) && kibibytes >= 0 ? kibibytes * 1024 : null,
  };
}

function parseProcessIo(text) {
  const values = Object.fromEntries(String(text || '').split(/\r?\n/).flatMap(line => {
    const match = line.match(/^([a-z_]+):\s+(\d+)$/i);
    return match ? [[match[1], Number(match[2])]] : [];
  }));
  return {
    readBytes: Number.isFinite(values.read_bytes) ? values.read_bytes : null,
    writeBytes: Number.isFinite(values.write_bytes) ? values.write_bytes : null,
  };
}

function processState(code) {
  if (code === 'R') return 'running';
  if (code === 'S' || code === 'I') return 'sleeping';
  if (code === 'D') return 'waiting';
  if (code === 'T' || code === 't') return 'stopped';
  if (code === 'Z') return 'zombie';
  return 'unknown';
}

function finiteDeltaRate(previous, current, elapsedMs) {
  if (!Number.isFinite(previous) || !Number.isFinite(current) || !(elapsedMs > 0)) return null;
  const delta = current - previous;
  return delta >= 0 ? delta * 1000 / elapsedMs : null;
}

function processDelta(previous, current, totalCpuTicksDelta, elapsedMs, totalMemoryBytes) {
  if (!current) return null;
  const sameProcess = Boolean(previous && previous.startTimeTicks === current.startTimeTicks);
  const cpuTickDelta = sameProcess ? current.cpuTicks - previous.cpuTicks : null;
  const cpuPercent = (
    Number.isFinite(cpuTickDelta) &&
    cpuTickDelta >= 0 &&
    totalCpuTicksDelta > 0
  ) ? Math.min(100, cpuTickDelta / totalCpuTicksDelta * 100) : null;
  const memoryPercent = (
    Number.isFinite(current.memoryBytes) &&
    current.memoryBytes >= 0 &&
    totalMemoryBytes > 0
  ) ? Math.min(100, current.memoryBytes / totalMemoryBytes * 100) : null;
  return {
    pid: current.pid,
    name: current.name,
    state: processState(current.stateCode),
    cpuPercent,
    memoryBytes: Number.isFinite(current.memoryBytes) ? current.memoryBytes : null,
    memoryPercent,
    readBytesPerSec: sameProcess
      ? finiteDeltaRate(previous.readBytes, current.readBytes, elapsedMs)
      : null,
    writeBytesPerSec: sameProcess
      ? finiteDeltaRate(previous.writeBytes, current.writeBytes, elapsedMs)
      : null,
  };
}

function sanitizedProcess(process) {
  return Object.fromEntries(PROCESS_FIELDS.map(field => [field, process[field] ?? null]));
}

function rankProcesses(processes, limit = 10) {
  const count = Math.max(0, Math.floor(Number(limit) || 0));
  const sanitized = Array.isArray(processes) ? processes.map(sanitizedProcess) : [];
  const descending = field => (left, right) => {
    const leftValue = Number.isFinite(left[field]) ? left[field] : -1;
    const rightValue = Number.isFinite(right[field]) ? right[field] : -1;
    return rightValue - leftValue || left.pid - right.pid;
  };
  return {
    byCpu: sanitized.slice().sort(descending('cpuPercent')).slice(0, count),
    byMemory: sanitized.slice().sort(descending('memoryBytes')).slice(0, count),
  };
}

function parseTotalCpuTicks(text) {
  const line = String(text || '').split(/\r?\n/).find(value => /^cpu\s/.test(value));
  if (!line) return null;
  const values = line.trim().split(/\s+/).slice(1, 9).map(Number);
  if (!values.length || values.some(value => !Number.isFinite(value) || value < 0)) return null;
  return values.reduce((sum, value) => sum + value, 0);
}

function unavailable(message, collectionName) {
  return {
    available: false,
    message,
    [collectionName]: [],
  };
}

function numeric(value) {
  if (typeof value === 'bigint') return Number(value);
  return Number(value);
}

async function optionalText(readFile, paths) {
  for (const path of paths) {
    try {
      const value = String(await readFile(path, 'utf8')).trim();
      if (value) return value;
    } catch {
      // Optional sysfs metadata is not exposed uniformly by every block driver.
    }
  }
  return '';
}

async function mapLimit(items, limit, mapper) {
  const result = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      result[index] = await mapper(items[index], index);
    }
  }
  const workerCount = Math.min(Math.max(1, limit), Math.max(1, items.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return result;
}

function activeAddresses(networkInterfaces) {
  return Object.entries(networkInterfaces || {}).filter(([name, addresses]) => (
    !name.includes('/') &&
    !name.includes('\\') &&
    !name.includes('..') &&
    Array.isArray(addresses) &&
    addresses.some(address => address && !address.internal)
  ));
}

function createLinuxSystemMetricsCollector({
  platform = process.platform,
  readFile = fs.readFile,
  readdir = fs.readdir,
  statfs = fs.statfs,
  networkInterfaces = os.networkInterfaces,
  totalMemory = os.totalmem,
  nowMs = Date.now,
  processConcurrency = 24,
} = {}) {
  let previousSampleAt = null;
  let previousDisks = new Map();
  let previousNetwork = new Map();
  let previousProcesses = new Map();
  let previousTotalCpuTicks = null;

  async function collectDisks(elapsedMs) {
    const [mountText, diskText] = await Promise.all([
      readFile('/proc/self/mountinfo', 'utf8'),
      readFile('/proc/diskstats', 'utf8'),
    ]);
    const mounts = parseMountInfo(mountText);
    const stats = parseDiskStats(diskText);
    const currentDisks = new Map();
    const devices = (await Promise.all(mounts.map(async mount => {
      const current = stats.get(mount.key);
      if (!current) return null;
      currentDisks.set(mount.key, current);
      const capacity = await statfs(mount.mountPoint);
      const blockSize = numeric(capacity.bsize);
      const blocks = numeric(capacity.blocks);
      const availableBlocks = numeric(capacity.bavail);
      const totalBytes = blockSize * blocks;
      const availableBytes = blockSize * availableBlocks;
      if (![totalBytes, availableBytes].every(value => Number.isFinite(value) && value >= 0)) return null;
      const model = await optionalText(readFile, [
        `/sys/dev/block/${mount.key}/device/model`,
        `/sys/class/block/${current.name}/device/model`,
      ]);
      const rotational = await optionalText(readFile, [
        `/sys/dev/block/${mount.key}/queue/rotational`,
        `/sys/class/block/${current.name}/queue/rotational`,
      ]);
      const rates = diskDelta(previousDisks.get(mount.key), current, elapsedMs);
      return {
        id: `disk-${mount.key.replace(':', '-')}`,
        name: model || current.name,
        device: current.name,
        source: mount.source,
        mountPoint: mount.mountPoint,
        filesystem: mount.filesystem,
        type: rotational === '0' ? 'SSD' : rotational === '1' ? 'HDD' : '',
        available: true,
        activityPercent: rates && rates.activityPercent,
        readBytesPerSec: rates && rates.readBytesPerSec,
        writeBytesPerSec: rates && rates.writeBytesPerSec,
        usedBytes: Math.max(0, totalBytes - availableBytes),
        availableBytes,
        totalBytes,
      };
    }))).filter(Boolean);
    previousDisks = currentDisks;
    return devices.length
      ? { available: true, message: '', devices }
      : unavailable('未检测到已挂载的物理磁盘', 'devices');
  }

  async function collectNetwork(elapsedMs) {
    const currentNetwork = new Map();
    const interfaces = (await Promise.all(activeAddresses(networkInterfaces()).map(async ([name, addresses]) => {
      const root = `/sys/class/net/${name}`;
      try {
        const [operstate, rxText, txText, speedText] = await Promise.all([
          readFile(`${root}/operstate`, 'utf8'),
          readFile(`${root}/statistics/rx_bytes`, 'utf8'),
          readFile(`${root}/statistics/tx_bytes`, 'utf8'),
          readFile(`${root}/speed`, 'utf8').catch(() => ''),
        ]);
        if (String(operstate).trim() !== 'up') return null;
        const counters = { rxBytes: Number(rxText), txBytes: Number(txText) };
        if (Object.values(counters).some(value => !Number.isFinite(value) || value < 0)) return null;
        currentNetwork.set(name, counters);
        const rates = networkDelta(previousNetwork.get(name), counters, elapsedMs);
        const external = addresses.filter(address => address && !address.internal);
        const speed = Number(String(speedText).trim());
        return {
          id: `network-${name}`,
          name,
          available: true,
          addresses: external.map(address => ({ family: address.family, address: address.address })),
          ipv4: external.find(address => address.family === 'IPv4' || address.family === 4)?.address || '',
          ipv6: external.find(address => address.family === 'IPv6' || address.family === 6)?.address || '',
          mac: external.find(address => address.mac)?.mac || '',
          speedMbps: Number.isFinite(speed) && speed > 0 ? speed : null,
          receiveBytesPerSec: rates && rates.receiveBytesPerSec,
          sendBytesPerSec: rates && rates.sendBytesPerSec,
          totalBytesPerSec: rates && rates.totalBytesPerSec,
        };
      } catch {
        return null;
      }
    }))).filter(Boolean).sort((left, right) => left.name.localeCompare(right.name));
    previousNetwork = currentNetwork;
    return interfaces.length
      ? { available: true, message: '', interfaces }
      : unavailable('未检测到运行中的网卡', 'interfaces');
  }

  async function readProcess(pid) {
    try {
      const [statText, statusText] = await Promise.all([
        readFile(`/proc/${pid}/stat`, 'utf8'),
        readFile(`/proc/${pid}/status`, 'utf8'),
      ]);
      let ioText = '';
      try {
        ioText = await readFile(`/proc/${pid}/io`, 'utf8');
      } catch {
        ioText = '';
      }
      const stat = parseProcessStat(statText);
      if (!stat || stat.pid !== Number(pid)) return null;
      return { ...stat, ...parseProcessStatus(statusText), ...parseProcessIo(ioText) };
    } catch {
      return null;
    }
  }

  async function collectProcesses(elapsedMs) {
    const [procStat, entries] = await Promise.all([
      readFile('/proc/stat', 'utf8'),
      readdir('/proc'),
    ]);
    const totalCpuTicks = parseTotalCpuTicks(procStat);
    if (!Number.isFinite(totalCpuTicks)) throw new Error('invalid /proc/stat');
    const pids = entries.map(entry => typeof entry === 'string' ? entry : entry.name).filter(name => /^\d+$/.test(name));
    const rawProcesses = (await mapLimit(pids, processConcurrency, readProcess)).filter(Boolean);
    const currentProcesses = new Map(rawProcesses.map(item => [item.pid, item]));
    const totalCpuTicksDelta = Number.isFinite(previousTotalCpuTicks)
      ? totalCpuTicks - previousTotalCpuTicks
      : null;
    const processes = rawProcesses.map(current => processDelta(
      previousProcesses.get(current.pid),
      current,
      totalCpuTicksDelta,
      elapsedMs,
      totalMemory(),
    )).filter(Boolean);
    previousProcesses = currentProcesses;
    previousTotalCpuTicks = totalCpuTicks;
    return processes.length
      ? { available: true, message: '', ...rankProcesses(processes, 10) }
      : { available: false, message: '未检测到可读取的进程', byCpu: [], byMemory: [] };
  }

  return {
    async snapshot() {
      if (platform !== 'linux') {
        return {
          disk: unavailable('磁盘状态仅支持 Linux', 'devices'),
          network: unavailable('网卡状态仅支持 Linux', 'interfaces'),
          processes: { available: false, message: '进程状态仅支持 Linux', byCpu: [], byMemory: [] },
        };
      }
      const sampledAt = Number(nowMs());
      const elapsedMs = Number.isFinite(previousSampleAt) ? sampledAt - previousSampleAt : null;
      const results = await Promise.allSettled([
        collectDisks(elapsedMs),
        collectNetwork(elapsedMs),
        collectProcesses(elapsedMs),
      ]);
      previousSampleAt = sampledAt;
      return {
        disk: results[0].status === 'fulfilled'
          ? results[0].value
          : unavailable('磁盘状态读取失败', 'devices'),
        network: results[1].status === 'fulfilled'
          ? results[1].value
          : unavailable('网卡状态读取失败', 'interfaces'),
        processes: results[2].status === 'fulfilled'
          ? results[2].value
          : { available: false, message: '进程状态读取失败', byCpu: [], byMemory: [] },
      };
    },
  };
}

module.exports = {
  parseMountInfo,
  parseDiskStats,
  diskDelta,
  networkDelta,
  parseProcessStat,
  parseProcessStatus,
  parseProcessIo,
  processDelta,
  rankProcesses,
  parseTotalCpuTicks,
  createLinuxSystemMetricsCollector,
};
const fs = require('node:fs/promises');
const os = require('node:os');
