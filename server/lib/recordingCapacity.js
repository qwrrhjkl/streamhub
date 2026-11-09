'use strict';

const DEFAULT_VIDEO_BITRATE_KBPS = 8000;
const DEFAULT_AUDIO_BITRATE_KBPS = 320;
const CONTAINER_OVERHEAD_FACTOR = 1.05;

function positiveNumber(value, fallback = 0) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function nonNegativeNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function configuredProgramBitrateKbps(pipeline) {
  const settings = pipeline && pipeline.settings || {};
  const video = positiveNumber(
    settings.live && settings.live.bitrateKbps,
    DEFAULT_VIDEO_BITRATE_KBPS,
  );
  const firstTrack = settings.audio && Array.isArray(settings.audio.tracks)
    ? settings.audio.tracks[0]
    : null;
  const audio = positiveNumber(
    firstTrack && firstTrack.bitrateKbps,
    DEFAULT_AUDIO_BITRATE_KBPS,
  );
  return video + audio;
}

function availableBytesFromStatfs(statfs) {
  const blockSize = positiveNumber(statfs && statfs.bsize);
  const availableBlocks = nonNegativeNumber(statfs && statfs.bavail);
  if (!blockSize || availableBlocks === null) return null;
  const availableBytes = blockSize * availableBlocks;
  return Number.isFinite(availableBytes) && availableBytes >= 0 ? availableBytes : null;
}

function estimateRecordingCapacity({ measuredBitrateKbps, configuredBitrateKbps, availableBytes } = {}) {
  const measured = positiveNumber(measuredBitrateKbps);
  const configured = positiveNumber(configuredBitrateKbps, DEFAULT_VIDEO_BITRATE_KBPS + DEFAULT_AUDIO_BITRATE_KBPS);
  const bitrateKbps = measured || configured;
  const requiredBytesPerHour = Math.ceil(bitrateKbps * 1000 / 8 * 3600 * CONTAINER_OVERHEAD_FACTOR);
  const available = nonNegativeNumber(availableBytes);
  const availableHours = available === null ? null : available / requiredBytesPerHour;
  return {
    bitrateKbps,
    bitrateSource: measured ? 'measured' : 'configured',
    requiredBytesPerHour,
    availableBytes: available,
    availableHours,
    sufficient: availableHours !== null && availableHours >= 1,
  };
}

module.exports = {
  configuredProgramBitrateKbps,
  estimateRecordingCapacity,
  availableBytesFromStatfs,
};
