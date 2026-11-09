function sumCpuTimes(cpus) {
  if (!Array.isArray(cpus) || !cpus.length) return null;
  return cpus.reduce((sum, cpu) => {
    const times = cpu && cpu.times || {};
    const values = ['user', 'nice', 'sys', 'idle', 'irq'].map(key => Number(times[key]));
    if (values.some(value => !Number.isFinite(value) || value < 0)) return sum;
    sum.idle += values[3];
    sum.total += values.reduce((total, value) => total + value, 0);
    sum.valid += 1;
    return sum;
  }, { idle: 0, total: 0, valid: 0 });
}

function cpuUsageBetween(previous, current) {
  const before = sumCpuTimes(previous);
  const after = sumCpuTimes(current);
  if (
    !before ||
    !after ||
    before.valid !== previous.length ||
    after.valid !== current.length ||
    before.valid !== after.valid
  ) return null;

  const totalDelta = after.total - before.total;
  const idleDelta = after.idle - before.idle;
  if (!(totalDelta > 0) || idleDelta < 0 || idleDelta > totalDelta) return null;
  return Math.max(0, Math.min(100, (1 - idleDelta / totalDelta) * 100));
}

function memorySnapshot(totalBytes, availableBytes) {
  const total = Number(totalBytes);
  const available = Number(availableBytes);
  if (!(total > 0) || !Number.isFinite(available) || available < 0 || available > total) {
    return {
      available: false,
      usagePercent: null,
      usedBytes: null,
      availableBytes: null,
      totalBytes: null,
    };
  }

  const usedBytes = total - available;
  return {
    available: true,
    usagePercent: usedBytes / total * 100,
    usedBytes,
    availableBytes: available,
    totalBytes: total,
  };
}

function nullableNumber(value) {
  const text = value === null || value === undefined ? '' : String(value).trim();
  if (!text || /^(N\/A|\[Not Supported\])$/i.test(text)) return null;
  const number = Number(text);
  return Number.isFinite(number) ? number : null;
}

function parseNvidiaSmiCsv(stdout) {
  return String(stdout || '')
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(Boolean)
    .flatMap(line => {
      const fields = line.split(',').map(value => value.trim());
      if (fields.length !== 8 || !Number.isInteger(Number(fields[0])) || !fields[1]) return [];
      const index = Number(fields[0]);
      return [{
        id: `gpu-${index}`,
        index,
        name: fields[1],
        usagePercent: nullableNumber(fields[2]),
        memoryUsedMib: nullableNumber(fields[3]),
        memoryTotalMib: nullableNumber(fields[4]),
        temperatureC: nullableNumber(fields[5]),
        encoderUsagePercent: nullableNumber(fields[6]),
        decoderUsagePercent: nullableNumber(fields[7]),
      }];
    });
}

function run(command, args, timeout = 4000) {
  return new Promise(resolve => {
    const child = execFile(command, args, { timeout }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? error.message : '',
      });
    });
    child.on('error', error => resolve({ ok: false, stdout: '', stderr: '', error: error.message }));
  });
}

function createSystemStatusCollector({
  system = os,
  runCommand = run,
  now = () => new Date(),
  linuxMetrics = createLinuxSystemMetricsCollector(),
} = {}) {
  let previousCpus = null;

  return {
    async snapshot() {
      const cpus = system.cpus();
      const usagePercent = cpuUsageBetween(previousCpus, cpus);
      previousCpus = cpus;
      const speeds = cpus.map(item => Number(item.speed)).filter(Number.isFinite);

      const [gpuResult, linuxResult] = await Promise.all([
        (async () => {
          try {
            return await runCommand('nvidia-smi', NVIDIA_QUERY, 4000);
          } catch (error) {
            return { ok: false, stdout: '', error: String(error && error.message || error) };
          }
        })(),
        (async () => {
          try {
            return await linuxMetrics.snapshot();
          } catch {
            return {
              disk: { available: false, message: '磁盘状态读取失败', devices: [] },
              network: { available: false, message: '网卡状态读取失败', interfaces: [] },
              processes: { available: false, message: '进程状态读取失败', byCpu: [], byMemory: [] },
            };
          }
        })(),
      ]);
      const devices = gpuResult && gpuResult.ok ? parseNvidiaSmiCsv(gpuResult.stdout) : [];

      return {
        sampledAt: now().toISOString(),
        cpu: {
          available: cpus.length > 0,
          usagePercent,
          model: cpus[0] && String(cpus[0].model || '').trim() || '',
          logicalCores: cpus.length,
          averageSpeedMhz: speeds.length
            ? speeds.reduce((sum, value) => sum + value, 0) / speeds.length
            : null,
          loadAverage1m: nullableNumber(system.loadavg()[0]),
          uptimeSec: nullableNumber(system.uptime()),
        },
        memory: memorySnapshot(system.totalmem(), system.freemem()),
        gpu: {
          available: devices.length > 0,
          message: devices.length ? '' : '未检测到可用的 NVIDIA GPU',
          devices,
        },
        disk: linuxResult.disk,
        network: linuxResult.network,
        processes: linuxResult.processes,
      };
    },
  };
}

module.exports = {
  cpuUsageBetween,
  memorySnapshot,
  parseNvidiaSmiCsv,
  createSystemStatusCollector,
};
const os = require('node:os');
const { execFile } = require('node:child_process');
const { createLinuxSystemMetricsCollector } = require('./linuxSystemMetrics');

const NVIDIA_QUERY = [
  '--query-gpu=index,name,utilization.gpu,memory.used,memory.total,temperature.gpu,utilization.encoder,utilization.decoder',
  '--format=csv,noheader,nounits',
];
