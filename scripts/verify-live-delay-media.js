'use strict';

const net = require('node:net');
const { spawn } = require('node:child_process');
const { LiveDelayBuffer } = require('../server/lib/liveDelayBuffer');

const HOST = '127.0.0.1';
const DELAY_SECONDS = 2;
const SOURCE_SECONDS = 8;
const PROCESS_TIMEOUT_MS = 90_000;
const CORRUPTION_PATTERN = /Packet corrupt|concealing \d+ DC|decode_slice_header|non-existing PPS|no frame!|error while decoding/gi;

function waitForExit(child, label, timeoutMs = PROCESS_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`${label} timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    child.once('error', error => {
      clearTimeout(timeout);
      reject(error);
    });
    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

async function reservePorts(count) {
  const servers = [];
  try {
    for (let index = 0; index < count; index += 1) {
      const server = net.createServer();
      servers.push(server);
      await new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, HOST, resolve);
      });
    }
    return servers.map(server => server.address().port);
  } finally {
    await Promise.allSettled(servers.map(server => new Promise(resolve => server.close(resolve))));
  }
}

async function canUseNvenc(ffmpeg) {
  const args = [
    '-hide_banner', '-loglevel', 'error',
    '-f', 'lavfi', '-i', 'color=size=320x180:rate=1:duration=1',
    '-frames:v', '1', '-c:v', 'h264_nvenc', '-f', 'null', '-',
  ];
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  const result = await waitForExit(child, 'NVENC preflight', 20_000);
  return result.code === 0;
}

function startDecoder(ffmpeg, outputPort, progress) {
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'info', '-nostats',
    '-i', `tcp://${HOST}:${outputPort}?tcp_nodelay=1`,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-progress', 'pipe:2', '-f', 'null', '-',
  ];
  const child = spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', chunk => {
    progress.stderr += chunk;
    for (const match of chunk.matchAll(/out_time_(?:us|ms)=(\d+)/g)) {
      const mediaSeconds = Number(match[1]) / 1_000_000;
      progress.durationSeconds = Math.max(progress.durationSeconds, mediaSeconds);
      if (mediaSeconds > 0 && progress.firstDecodedProgressMs === null) {
        progress.firstDecodedProgressMs = Date.now() - progress.producerStartedAt;
      }
    }
  });
  return child;
}

function startProducer(ffmpeg, inputPort, encoder) {
  const videoEncoderArgs = encoder === 'h264_nvenc'
    ? ['-c:v', 'h264_nvenc', '-preset', 'p4', '-rc', 'cbr']
    : ['-c:v', 'libx264', '-preset', 'veryfast', '-tune', 'zerolatency'];
  const args = [
    '-hide_banner', '-nostdin', '-loglevel', 'warning',
    '-re', '-f', 'lavfi', '-i', `testsrc2=size=1920x1080:rate=60:duration=${SOURCE_SECONDS}`,
    '-f', 'lavfi', '-i', `sine=frequency=1000:sample_rate=48000:duration=${SOURCE_SECONDS}`,
    '-map', '0:v:0', '-map', '1:a:0',
    ...videoEncoderArgs,
    '-pix_fmt', 'yuv420p', '-b:v', '8M', '-maxrate', '8M', '-bufsize', '16M',
    '-g', '120', '-keyint_min', '120', '-sc_threshold', '0',
    '-c:a', 'aac', '-b:a', '192k', '-ar', '48000',
    '-f', 'mpegts', `tcp://${HOST}:${inputPort}?tcp_nodelay=1`,
  ];
  return spawn(ffmpeg, args, { stdio: ['ignore', 'ignore', 'pipe'] });
}

async function main() {
  const ffmpeg = String(process.env.STREAMHUB_FFMPEG || 'ffmpeg');
  const encoder = await canUseNvenc(ffmpeg) ? 'h264_nvenc' : 'libx264';
  const [inputPort, outputPort] = await reservePorts(2);
  let bufferError = null;
  let readyResolve;
  let readyReject;
  const ready = new Promise((resolve, reject) => {
    readyResolve = resolve;
    readyReject = reject;
  });
  const delay = new LiveDelayBuffer({
    delaySeconds: DELAY_SECONDS,
    inputPort,
    outputPorts: [outputPort],
    inputTransport: 'tcp-server',
    outputTransport: 'tcp-server',
    onReady: readyResolve,
    onError(error) {
      bufferError = error;
      readyReject(error);
    },
  });
  const progress = {
    stderr: '',
    producerStartedAt: 0,
    firstDecodedProgressMs: null,
    durationSeconds: 0,
  };
  let producer = null;
  let decoder = null;

  try {
    delay.start();
    await ready;
    decoder = startDecoder(ffmpeg, outputPort, progress);
    progress.producerStartedAt = Date.now();
    producer = startProducer(ffmpeg, inputPort, encoder);
    let producerStderr = '';
    producer.stderr.setEncoding('utf8');
    producer.stderr.on('data', chunk => { producerStderr += chunk; });
    const producerResult = await waitForExit(producer, 'producer');
    if (producerResult.code !== 0) throw new Error(`producer exited ${producerResult.code}: ${producerStderr.slice(-2000)}`);

    const drainResult = await delay.beginDrain();
    if (drainResult.status !== 'stopped') throw bufferError || new Error(`delay buffer ended as ${drainResult.status}`);
    const decoderResult = await waitForExit(decoder, 'decoder');
    if (decoderResult.code !== 0) throw new Error(`decoder exited ${decoderResult.code}: ${progress.stderr.slice(-2000)}`);
    if (bufferError) throw bufferError;

    const corruptionErrors = (progress.stderr.match(CORRUPTION_PATTERN) || []).length;
    if (corruptionErrors) throw new Error(`decoder reported ${corruptionErrors} corruption errors`);
    if (progress.firstDecodedProgressMs === null) throw new Error('decoder produced no progress');
    if (progress.firstDecodedProgressMs < DELAY_SECONDS * 1000 - 500) {
      throw new Error(`decoded output started too early at ${progress.firstDecodedProgressMs}ms`);
    }
    if (progress.durationSeconds < SOURCE_SECONDS - 0.5) {
      throw new Error(`decoded duration was only ${progress.durationSeconds.toFixed(3)}s`);
    }

    console.log(JSON.stringify({
      delaySeconds: DELAY_SECONDS,
      firstDecodedProgressMs: progress.firstDecodedProgressMs,
      durationSeconds: Number(progress.durationSeconds.toFixed(3)),
      producerEncoder: encoder,
      corruptionErrors,
    }));
  } finally {
    if (producer && producer.exitCode === null) producer.kill('SIGKILL');
    if (decoder && decoder.exitCode === null) decoder.kill('SIGKILL');
    if (!['stopped', 'error'].includes(delay.describe().status)) await delay.discard();
  }
}

main().catch(error => {
  console.error(error && error.stack || error);
  process.exitCode = 1;
});
