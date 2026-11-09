const TS_PACKET_SIZE = 188;
const TS_SYNC_BYTE = 0x47;
const DEFAULT_MAX_BUFFERED_BYTES = 32 * 1024 * 1024;

const AVC_STREAM_TYPE = 0x1b;
const HEVC_STREAM_TYPE = 0x24;
const AUDIO_STREAM_TYPES = new Set([0x03, 0x04, 0x0f, 0x11, 0x81, 0x87]);

function packetPid(packet) {
  return ((packet[1] & 0x1f) << 8) | packet[2];
}

function payloadOffset(packet) {
  const adaptationControl = (packet[3] >> 4) & 0x03;
  if (adaptationControl === 0 || adaptationControl === 2) return -1;
  if (adaptationControl === 1) return 4;
  const offset = 5 + packet[4];
  return offset < TS_PACKET_SIZE ? offset : -1;
}

function psiSection(packet) {
  const offset = payloadOffset(packet);
  if (offset < 0 || !(packet[1] & 0x40) || offset >= TS_PACKET_SIZE) return null;
  const pointer = packet[offset];
  const start = offset + 1 + pointer;
  if (start + 3 > TS_PACKET_SIZE) return null;
  const sectionLength = ((packet[start + 1] & 0x0f) << 8) | packet[start + 2];
  const end = start + 3 + sectionLength;
  return end <= TS_PACKET_SIZE ? packet.subarray(start, end) : null;
}

function parsePat(packet) {
  const section = psiSection(packet);
  if (!section || section[0] !== 0x00 || section.length < 12) return null;
  const entriesEnd = section.length - 4;
  for (let offset = 8; offset + 4 <= entriesEnd; offset += 4) {
    const programNumber = section.readUInt16BE(offset);
    if (programNumber !== 0) return ((section[offset + 2] & 0x1f) << 8) | section[offset + 3];
  }
  return null;
}

function parsePmt(packet) {
  const section = psiSection(packet);
  if (!section || section[0] !== 0x02 || section.length < 16) return null;
  const programInfoLength = ((section[10] & 0x0f) << 8) | section[11];
  const streamsEnd = section.length - 4;
  let offset = 12 + programInfoLength;
  let videoPid = null;
  let videoType = null;
  let audioPid = null;
  while (offset + 5 <= streamsEnd) {
    const streamType = section[offset];
    const pid = ((section[offset + 1] & 0x1f) << 8) | section[offset + 2];
    const infoLength = ((section[offset + 3] & 0x0f) << 8) | section[offset + 4];
    if (videoPid === null && (streamType === AVC_STREAM_TYPE || streamType === HEVC_STREAM_TYPE)) {
      videoPid = pid;
      videoType = streamType;
    } else if (audioPid === null && AUDIO_STREAM_TYPES.has(streamType)) {
      audioPid = pid;
    }
    offset += 5 + infoLength;
  }
  return videoPid === null ? null : { videoPid, videoType, audioPid };
}

function elementaryPayload(packet) {
  const offset = payloadOffset(packet);
  if (offset < 0) return Buffer.alloc(0);
  let start = offset;
  if (packet[1] & 0x40) {
    if (start + 9 > TS_PACKET_SIZE) return Buffer.alloc(0);
    if (packet[start] === 0x00 && packet[start + 1] === 0x00 && packet[start + 2] === 0x01) {
      start += 9 + packet[start + 8];
    }
  }
  return start < TS_PACKET_SIZE ? packet.subarray(start) : Buffer.alloc(0);
}

function discontinuityPacket(pid, continuityCounter = 0) {
  const packet = Buffer.alloc(TS_PACKET_SIZE, 0xff);
  packet[0] = TS_SYNC_BYTE;
  packet[1] = (pid >> 8) & 0x1f;
  packet[2] = pid & 0xff;
  packet[3] = 0x20 | (continuityCounter & 0x0f);
  packet[4] = 183;
  packet[5] = 0x80;
  return packet;
}

function annexBNalTypes(buffer, videoType) {
  const types = new Set();
  for (let offset = 0; offset + 4 < buffer.length; offset += 1) {
    let nalOffset = -1;
    if (buffer[offset] === 0x00 && buffer[offset + 1] === 0x00 && buffer[offset + 2] === 0x01) nalOffset = offset + 3;
    else if (
      buffer[offset] === 0x00 && buffer[offset + 1] === 0x00
      && buffer[offset + 2] === 0x00 && buffer[offset + 3] === 0x01
    ) nalOffset = offset + 4;
    if (nalOffset >= 0 && nalOffset < buffer.length) {
      types.add(videoType === HEVC_STREAM_TYPE
        ? (buffer[nalOffset] >> 1) & 0x3f
        : buffer[nalOffset] & 0x1f);
    }
  }
  return types;
}

function parameterSetTypes(videoType) {
  return videoType === HEVC_STREAM_TYPE ? [32, 33, 34] : [7, 8];
}

function hasRandomAccess(types, videoType) {
  if (videoType === HEVC_STREAM_TYPE) {
    return Array.from(types).some(type => type >= 16 && type <= 21);
  }
  return types.has(5);
}

function hasVideoCodingLayer(types, videoType) {
  if (videoType === HEVC_STREAM_TYPE) {
    return Array.from(types).some(type => type >= 0 && type <= 31);
  }
  return Array.from(types).some(type => type >= 1 && type <= 5);
}

class MpegTsVideoBoundaryTracker {
  constructor() {
    this.pmtPid = null;
    this.videoPid = null;
  }

  observePacket(packet) {
    if (!Buffer.isBuffer(packet) || packet.length !== TS_PACKET_SIZE || packet[0] !== TS_SYNC_BYTE) {
      return false;
    }
    const pid = packetPid(packet);
    if (pid === 0) {
      const pmtPid = parsePat(packet);
      if (pmtPid !== null) this.pmtPid = pmtPid;
    } else if (this.pmtPid !== null && pid === this.pmtPid) {
      const pmt = parsePmt(packet);
      if (pmt) this.videoPid = pmt.videoPid;
    }
    return this.videoPid !== null && pid === this.videoPid && Boolean(packet[1] & 0x40);
  }

  observe(buffer) {
    for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
      this.observePacket(buffer.subarray(offset, offset + TS_PACKET_SIZE));
    }
  }

  nextVideoPesStart(buffer) {
    for (let offset = 0; offset + TS_PACKET_SIZE <= buffer.length; offset += TS_PACKET_SIZE) {
      if (this.observePacket(buffer.subarray(offset, offset + TS_PACKET_SIZE))) return offset;
    }
    return -1;
  }
}

class MpegTsSwitchGate {
  constructor({ maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES } = {}) {
    this.maxBufferedBytes = Math.max(TS_PACKET_SIZE * 3, Number(maxBufferedBytes) || DEFAULT_MAX_BUFFERED_BYTES);
    this.pending = Buffer.alloc(0);
    this.bufferedBytes = 0;
    this.ready = false;
    this.patPacket = null;
    this.pmtPacket = null;
    this.pmtPid = null;
    this.videoPid = null;
    this.videoType = null;
    this.audioPid = null;
    this.videoPesPackets = [];
    this.videoElementaryParts = [];
    this.parameterPesByType = new Map();
    this.randomAccessStarted = false;
    this.randomAccessComplete = false;
    this.alignedAudioStarted = false;
    this.cleanPackets = [];
  }

  push(chunk) {
    if (!Buffer.isBuffer(chunk) || chunk.length === 0) return this.ready;
    this.bufferedBytes += chunk.length;
    if (!this.ready && this.bufferedBytes > this.maxBufferedBytes) {
      throw new Error(`候选节目预热数据超过 ${this.maxBufferedBytes} 字节上限`);
    }
    this.pending = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    this.consumePackets();
    return this.ready;
  }

  consumePackets() {
    let offset = 0;
    while (offset + TS_PACKET_SIZE <= this.pending.length) {
      if (this.pending[offset] !== TS_SYNC_BYTE) {
        const next = this.pending.indexOf(TS_SYNC_BYTE, offset + 1);
        if (next < 0) break;
        offset = next;
        continue;
      }
      const packet = Buffer.from(this.pending.subarray(offset, offset + TS_PACKET_SIZE));
      offset += TS_PACKET_SIZE;
      this.consumePacket(packet);
    }
    this.pending = Buffer.from(this.pending.subarray(offset));
  }

  consumePacket(packet) {
    if (this.ready) {
      this.cleanPackets.push(packet);
      return;
    }
    const pid = packetPid(packet);
    const payloadStart = Boolean(packet[1] & 0x40);

    if (pid === 0) {
      const pmtPid = parsePat(packet);
      if (pmtPid !== null) {
        this.pmtPid = pmtPid;
        this.patPacket = packet;
      }
    } else if (this.pmtPid !== null && pid === this.pmtPid) {
      const pmt = parsePmt(packet);
      if (pmt) {
        if (this.videoPid !== pmt.videoPid || this.videoType !== pmt.videoType) {
          this.parameterPesByType.clear();
          this.videoPesPackets = [];
          this.videoElementaryParts = [];
        }
        this.pmtPacket = packet;
        this.videoPid = pmt.videoPid;
        this.videoType = pmt.videoType;
        this.audioPid = pmt.audioPid;
      }
    }

    if (!this.patPacket || !this.pmtPacket || this.videoPid === null) return;

    if (pid === this.videoPid) {
      if (payloadStart) {
        if (this.videoPesPackets.length) this.finishVideoPes();
        if (this.randomAccessStarted) {
          this.randomAccessComplete = true;
          if (this.audioPid === null || this.alignedAudioStarted) this.ready = true;
        }
        this.videoPesPackets = [];
        this.videoElementaryParts = [];
      }
      if (this.ready) {
        this.cleanPackets.push(packet);
        return;
      }
      if (!this.videoPesPackets.length && !payloadStart) {
        if (this.randomAccessStarted) this.cleanPackets.push(packet);
        return;
      }
      this.videoPesPackets.push(packet);
      const elementary = elementaryPayload(packet);
      if (elementary.length) this.videoElementaryParts.push(elementary);
      if (this.randomAccessStarted) this.cleanPackets.push(packet);
      else this.tryStartRandomAccess();
      return;
    }

    if (!this.randomAccessStarted) return;
    if (this.audioPid !== null && pid === this.audioPid && payloadStart) {
      if (!this.alignedAudioStarted) {
        this.cleanPackets.push(discontinuityPacket(this.audioPid, packet[3] & 0x0f));
      }
      this.alignedAudioStarted = true;
      this.cleanPackets.push(packet);
      if (this.randomAccessComplete) this.ready = true;
      return;
    }
    if (this.audioPid !== null && pid === this.audioPid && !this.alignedAudioStarted) return;
    this.cleanPackets.push(packet);
  }

  finishVideoPes() {
    if (!this.videoPesPackets.length || this.randomAccessStarted) return;
    const types = annexBNalTypes(Buffer.concat(this.videoElementaryParts), this.videoType);
    if (hasVideoCodingLayer(types, this.videoType)) return;
    const record = { packets: this.videoPesPackets.map(packet => Buffer.from(packet)) };
    for (const type of parameterSetTypes(this.videoType)) {
      if (types.has(type)) this.parameterPesByType.set(type, record);
    }
  }

  tryStartRandomAccess() {
    const types = annexBNalTypes(Buffer.concat(this.videoElementaryParts), this.videoType);
    if (!hasRandomAccess(types, this.videoType)) return false;
    const records = [];
    const seen = new Set();
    for (const type of parameterSetTypes(this.videoType)) {
      if (types.has(type)) continue;
      const record = this.parameterPesByType.get(type);
      if (!record) return false;
      if (!seen.has(record)) {
        seen.add(record);
        records.push(record);
      }
    }
    const patCounter = this.patPacket[3] & 0x0f;
    const pmtCounter = this.pmtPacket[3] & 0x0f;
    const videoCounter = (records[0] && records[0].packets[0] || this.videoPesPackets[0])[3] & 0x0f;
    this.cleanPackets = [
      discontinuityPacket(0, patCounter),
      this.patPacket,
      discontinuityPacket(this.pmtPid, pmtCounter),
      this.pmtPacket,
      discontinuityPacket(this.videoPid, videoCounter),
      ...records.flatMap(record => record.packets),
      ...this.videoPesPackets,
    ];
    this.randomAccessStarted = true;
    return true;
  }

  takeCleanBuffer() {
    if (!this.ready) throw new Error('候选节目尚未到达可切换的音视频边界');
    const parts = [...this.cleanPackets];
    if (this.pending.length) parts.push(this.pending);
    this.cleanPackets = [];
    this.pending = Buffer.alloc(0);
    return Buffer.concat(parts);
  }
}

module.exports = {
  MpegTsSwitchGate,
  MpegTsVideoBoundaryTracker,
  TS_PACKET_SIZE,
  DEFAULT_MAX_BUFFERED_BYTES,
};
