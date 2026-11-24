const test = require('node:test');
const assert = require('node:assert/strict');
const {
  assessStreamQuality,
  buildPipelineReportPdf,
  streamReportDetails,
  taskRuntimeTimeline,
} = require('../server/lib/pipelineReport');

test('report quality reads persisted metrics nested under output.metrics', () => {
  const output = {
    status: 'stopped',
    lastOperationalStatus: 'running',
    uptimeSec: 600,
    metrics: {
      bitrateKbps: 5800,
      actualBitrateAvailable: true,
      fps: 30,
      targetFps: 30,
      totalDroppedFrames: 0,
      totalDropRatePercent: 0,
      networkDropAvailable: true,
      networkLossActive: false,
      udpOverruns: 0,
      corruptPackets: 0,
      speed: 1.02,
    },
  };

  const details = streamReportDetails({
    destination: { id: 'dest-a', name: '平台 A', protocol: 'rtmp' },
    output,
    logs: [],
  }, {
    id: 'pipe-a',
    name: '直播任务',
    settings: { live: { bitrateKbps: 6000 }, video: { fps: '30' } },
    lastStartedAt: '2026-11-24T02:00:00.000Z',
    lastStoppedAt: '2026-11-24T02:10:00.000Z',
  }, new Date('2026-11-24T02:11:00.000Z'), { id: 'run-a' });

  assert.equal(details.video.bitrate, '5800 Kbps');
  assert.equal(details.video.fps, '30');
  assert.equal(details.video.encoderSpeed, '1.02x');
  assert.equal(details.runtime.uptime, '00:10:00');
  assert.equal(details.runtime.startedAt, '2026-11-24 10:00:00');
  assert.equal(details.runtime.endedAt, '2026-11-24 10:10:00');
  assert.equal(details.quality.level, '良好');
  assert.equal(details.quality.basis, '运行指标与日志摘要');
});

test('report does not turn missing samples into zero or claim a sampled quality result', () => {
  const quality = assessStreamQuality({
    status: 'stopped',
    lastOperationalStatus: 'running',
  }, { runObserved: true, durationSec: 300 });

  assert.equal(quality.level, '未见明显故障');
  assert.match(quality.reasons.join(' '), /未取得有效码率、FPS 或网络丢失采样/);
});

test('task timeline uses the immutable run timestamps', () => {
  const timeline = taskRuntimeTimeline({
    run: {
      startedAt: '2026-11-24T02:00:00.000Z',
      endedAt: '2026-11-24T02:05:00.000Z',
    },
    pipeline: { id: 'pipe-a' },
    streams: [],
    relayLogs: [],
  });

  assert.equal(timeline.startedAt, '2026-11-24 10:00:00');
  assert.equal(timeline.endedAt, '2026-11-24 10:05:00');
  assert.equal(timeline.duration, '00:05:00');
});

test('pipeline PDF paginates a multi-destination run and stays within footer bounds', () => {
  const destinations = Array.from({ length: 9 }, (_, index) => ({
    id: `dest-${index}`,
    name: `平台目标 ${index + 1}`,
    protocol: 'rtmp',
    enabled: true,
  }));
  const streams = destinations.map(destination => ({
    destination,
    output: {
      status: 'stopped',
      lastOperationalStatus: 'running',
      uptimeSec: 300,
      metrics: {
        bitrateKbps: 5800,
        actualBitrateAvailable: true,
        fps: 30,
        targetFps: 30,
        networkDropAvailable: true,
        networkLossActive: false,
      },
    },
    logs: [],
  }));
  const pdf = buildPipelineReportPdf({
    scope: 'pipeline',
    run: {
      id: 'run-multi',
      outcome: 'stopped',
      stopMode: 'discard',
      startedAt: '2026-11-24T02:00:00.000Z',
      endedAt: '2026-11-24T02:05:00.000Z',
    },
    pipeline: {
      id: 'pipe-multi',
      name: '多平台直播任务',
      mode: 'encode',
      settings: {},
    },
    source: { type: 'url', name: '直播源' },
    destinations,
    streams,
    relayLogs: [],
    program: null,
    active: null,
  }, new Date('2026-11-24T02:06:00.000Z'));
  const pdfText = pdf.toString('latin1');
  const pageCount = Number(pdfText.match(/\/Type \/Pages \/Count (\d+)/)?.[1]);

  assert.equal(pdf.subarray(0, 4).toString(), '%PDF');
  assert.equal(pageCount, 10);
});
