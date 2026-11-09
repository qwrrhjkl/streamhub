const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const TIMESTAMP_MODULUS = 1n << 33n;
const DEFAULT_SWITCH_GAP_TICKS = 9_000n;
const MAX_OBSERVED_STEP_TICKS = 9_000n;

function modulo(value, modulus = TIMESTAMP_MODULUS) {
  const result = value % modulus;
  return result < 0n ? result + modulus : result;
}

function readTimestamp(packet, offset) {
  if (offset < 0 || offset + 5 > packet.length) return null;
  if ((packet[offset] & 1) !== 1 || (packet[offset + 2] & 1) !== 1 || (packet[offset + 4] & 1) !== 1) {
    return null;
  }
  return (BigInt(packet[offset] & 0x0e) << 29n)
    | (BigInt(packet[offset + 1]) << 22n)
    | (BigInt(packet[offset + 2] & 0xfe) << 14n)
    | (BigInt(packet[offset + 3]) << 7n)
    | BigInt((packet[offset + 4] & 0xfe) >> 1);
}

function writeTimestamp(packet, offset, value) {
  const timestamp = modulo(value);
  packet[offset] = (packet[offset] & 0xf0) | Number(((timestamp >> 30n) & 0x07n) << 1n) | 1;
  packet[offset + 1] = Number((timestamp >> 22n) & 0xffn);
  packet[offset + 2] = Number(((timestamp >> 15n) & 0x7fn) << 1n) | 1;
  packet[offset + 3] = Number((timestamp >> 7n) & 0xffn);
  packet[offset + 4] = Number((timestamp & 0x7fn) << 1n) | 1;
}

function payloadOffset(packet) {
  const adaptationControl = (packet[3] >> 4) & 0x03;
  if (adaptationControl === 0 || adaptationControl === 2) return -1;
  if (adaptationControl === 1) return 4;
  const offset = 5 + packet[4];
  return offset < TS_PACKET_SIZE ? offset : -1;
}

function timestampFields(packet) {
  const fields = [];
  const pid = ((packet[1] & 0x1f) << 8) | packet[2];
  const adaptationControl = (packet[3] >> 4) & 0x03;
  if (
    (adaptationControl === 2 || adaptationControl === 3)
    && packet[4] >= 7 && packet[4] <= TS_PACKET_SIZE - 5
    && (packet[5] & 0x10)
  ) {
    const value = (BigInt(packet[6]) << 25n)
      | (BigInt(packet[7]) << 17n)
      | (BigInt(packet[8]) << 9n)
      | (BigInt(packet[9]) << 1n)
      | BigInt(packet[10] >> 7);
    fields.push({ pid, kind: 'pcr', key: `${pid}:pcr`, offset: 6, value });
  }

  if (!(packet[1] & 0x40)) return fields;
  const offset = payloadOffset(packet);
  if (
    offset < 0 || offset + 14 > TS_PACKET_SIZE
    || packet[offset] !== 0 || packet[offset + 1] !== 0 || packet[offset + 2] !== 1
  ) return fields;
  const timestampFlags = (packet[offset + 7] >> 6) & 0x03;
  if (timestampFlags === 2 || timestampFlags === 3) {
    const pts = readTimestamp(packet, offset + 9);
    if (pts !== null) fields.push({ pid, kind: 'pts', key: `${pid}:pts`, offset: offset + 9, value: pts });
  }
  if (timestampFlags === 3 && offset + 19 <= TS_PACKET_SIZE) {
    const dts = readTimestamp(packet, offset + 14);
    if (dts !== null) fields.push({ pid, kind: 'dts', key: `${pid}:dts`, offset: offset + 14, value: dts });
  }
  return fields;
}

function writePcrBase(packet, offset, value) {
  const timestamp = modulo(value);
  packet[offset] = Number((timestamp >> 25n) & 0xffn);
  packet[offset + 1] = Number((timestamp >> 17n) & 0xffn);
  packet[offset + 2] = Number((timestamp >> 9n) & 0xffn);
  packet[offset + 3] = Number((timestamp >> 1n) & 0xffn);
  packet[offset + 4] = Number((timestamp & 1n) << 7n) | (packet[offset + 4] & 0x7f);
}

function forEachPacket(buffer, visitor) {
  for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
    const packet = buffer.subarray(offset, offset + TS_PACKET_SIZE);
    if (packet[0] === TS_SYNC_BYTE) visitor(packet);
  }
}

function packetPid(packet) {
  return ((packet[1] & 0x1f) << 8) | packet[2];
}

function hasPayload(packet) {
  return ((packet[3] >> 4) & 0x03) === 1 || ((packet[3] >> 4) & 0x03) === 3;
}

function isDiscontinuityOnly(packet) {
  const adaptationControl = (packet[3] >> 4) & 0x03;
  return adaptationControl === 2 && packet[4] >= 1 && Boolean(packet[5] & 0x80);
}

function clearDiscontinuity(packet) {
  const adaptationControl = (packet[3] >> 4) & 0x03;
  if (
    (adaptationControl === 2 || adaptationControl === 3)
    && packet[4] >= 1 && packet[4] <= TS_PACKET_SIZE - 5
  ) packet[5] &= 0x7f;
}

function unwrapNear(value, reference) {
  if (reference === null) return value;
  const epoch = reference - modulo(reference);
  let candidate = epoch + value;
  const half = TIMESTAMP_MODULUS / 2n;
  if (candidate - reference > half) candidate -= TIMESTAMP_MODULUS;
  else if (reference - candidate > half) candidate += TIMESTAMP_MODULUS;
  return candidate;
}

class MpegTsTimelineNormalizer {
  constructor({ switchGapTicks = DEFAULT_SWITCH_GAP_TICKS } = {}) {
    this.switchGapTicks = BigInt(switchGapTicks);
    this.timestampOffset = 0n;
    this.lastByKey = new Map();
    this.stepByKey = new Map();
    this.continuityByPid = new Map();
    this.continuityOffsetByPid = new Map();
  }

  get lastTimestamp() {
    const values = Array.from(this.lastByKey.values());
    return values.length ? Number(values.reduce((maximum, value) => value > maximum ? value : maximum)) : 0;
  }

  observe(buffer) {
    forEachPacket(buffer, packet => {
      if (hasPayload(packet)) this.continuityByPid.set(packetPid(packet), packet[3] & 0x0f);
      for (const field of timestampFields(packet)) {
        const previous = this.lastByKey.get(field.key) ?? null;
        const timestamp = unwrapNear(field.value, previous);
        if (previous === null || timestamp > previous) {
          if (previous !== null) {
            const step = timestamp - previous;
            if (step > 0n && step <= MAX_OBSERVED_STEP_TICKS) this.stepByKey.set(field.key, step);
          }
          this.lastByKey.set(field.key, timestamp);
        }
      }
    });
    return buffer;
  }

  rewrite(buffer) {
    const output = Buffer.from(buffer);
    forEachPacket(output, packet => {
      const pid = packetPid(packet);
      const continuityOffset = this.continuityOffsetByPid.get(pid);
      if (hasPayload(packet) && continuityOffset !== undefined) {
        packet[3] = (packet[3] & 0xf0) | ((packet[3] + continuityOffset) & 0x0f);
      }
      clearDiscontinuity(packet);
      for (const field of timestampFields(packet)) {
        const shifted = field.value + this.timestampOffset;
        if (field.kind === 'pcr') writePcrBase(packet, field.offset, shifted);
        else writeTimestamp(packet, field.offset, shifted);
      }
    });
    this.observe(output);
    return output;
  }

  normalizeCandidate(buffer) {
    const firstByKey = new Map();
    forEachPacket(buffer, packet => {
      for (const field of timestampFields(packet)) {
        if (!firstByKey.has(field.key)) firstByKey.set(field.key, field.value);
      }
    });
    if (!firstByKey.size) {
      throw new Error('Candidate MPEG-TS stream does not contain PCR, PTS, or DTS timestamps');
    }
    let requiredOffset = null;
    for (const [key, candidateStart] of firstByKey) {
      const activeTimestamp = this.lastByKey.get(key);
      if (activeTimestamp !== undefined) {
        const step = this.stepByKey.get(key) || this.switchGapTicks;
        const required = activeTimestamp + step - candidateStart;
        if (requiredOffset === null || required > requiredOffset) requiredOffset = required;
      }
    }
    if (requiredOffset !== null) this.timestampOffset = modulo(requiredOffset);
    const withoutMarkers = [];
    forEachPacket(buffer, packet => {
      if (!isDiscontinuityOnly(packet)) withoutMarkers.push(Buffer.from(packet));
    });
    const candidate = Buffer.concat(withoutMarkers);
    const armedPids = new Set();
    forEachPacket(candidate, packet => {
      if (!hasPayload(packet)) return;
      const pid = packetPid(packet);
      if (armedPids.has(pid)) return;
      armedPids.add(pid);
      const previous = this.continuityByPid.get(pid);
      if (previous === undefined) this.continuityOffsetByPid.delete(pid);
      else this.continuityOffsetByPid.set(pid, (previous + 1 - (packet[3] & 0x0f)) & 0x0f);
    });
    return this.rewrite(candidate);
  }

  normalizeActive(buffer) {
    return this.rewrite(buffer);
  }
}

module.exports = {
  MpegTsTimelineNormalizer,
  TS_PACKET_SIZE,
  TIMESTAMP_MODULUS,
};
