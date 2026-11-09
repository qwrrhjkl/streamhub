#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { createLogManager, parseLogFilename, RETENTION_MS } = require('../server/lib/logManager');

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function compactTimestamp(value) {
  return new Date(Number(value)).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function legacyPrefix(filename) {
  const parsed = parseLogFilename(filename);
  if (!parsed || parsed.timestamp || parsed.protected) return '';
  return filename.replace(/\.log(?:\.\d+|\.old)?$/, '');
}

function findOpenLogFiles(logDir, procRoot = '/proc') {
  const active = new Set();
  if (!fs.existsSync(procRoot)) return [];
  for (const processId of fs.readdirSync(procRoot).filter(name => /^\d+$/.test(name))) {
    const fdDir = path.join(procRoot, processId, 'fd');
    let descriptors;
    try { descriptors = fs.readdirSync(fdDir); } catch { continue; }
    for (const descriptor of descriptors) {
      try {
        const target = path.resolve(fs.readlinkSync(path.join(fdDir, descriptor)).replace(/ \(deleted\)$/, ''));
        if (target.startsWith(`${logDir}${path.sep}`)) active.add(target);
      } catch {}
    }
  }
  return Array.from(active);
}

function migrateLogs({
  rootDir,
  now = Date.now,
  dryRun = false,
  activeFiles = [],
} = {}) {
  const root = path.resolve(String(rootDir || ''));
  const logDir = path.join(root, 'data', 'logs');
  if (!rootDir || root === path.parse(root).root || !fs.existsSync(logDir) || !fs.statSync(logDir).isDirectory()) {
    throw new Error('A valid StreamHub root with data/logs is required');
  }
  const active = new Set(activeFiles.map(file => path.resolve(String(file))));
  const existing = new Set(fs.readdirSync(logDir));
  const entries = [];
  const retentionCandidates = [];
  const skippedActive = [];
  const protectedFiles = [];

  for (const filename of Array.from(existing).sort()) {
    const source = path.join(logDir, filename);
    const parsed = parseLogFilename(filename);
    if (!parsed || !fs.statSync(source).isFile()) continue;
    if (parsed.protected) { protectedFiles.push(filename); continue; }
    if (active.has(path.resolve(source))) { skippedActive.push(filename); continue; }
    const stats = fs.statSync(source);
    const prefix = legacyPrefix(filename);
    if (!prefix) {
      retentionCandidates.push({ name: filename, mtimeMs: stats.mtimeMs });
      continue;
    }
    const timestamp = compactTimestamp(stats.mtimeMs);
    let part = 1;
    let destinationName = `${prefix}-${timestamp}.log`;
    while (existing.has(destinationName)) {
      part += 1;
      destinationName = `${prefix}-${timestamp}-part-${part}.log`;
    }
    existing.add(destinationName);
    const destination = path.join(logDir, destinationName);
    const beforeHash = sha256File(source);
    const entry = {
      from: filename,
      to: destinationName,
      sha256: beforeHash,
      sizeBytes: stats.size,
      mtimeMs: stats.mtimeMs,
    };
    entries.push(entry);
    retentionCandidates.push({ name: destinationName, mtimeMs: stats.mtimeMs });
    if (dryRun) continue;
    fs.renameSync(source, destination);
    const afterHash = sha256File(destination);
    if (afterHash !== beforeHash) {
      fs.renameSync(destination, source);
      throw new Error(`Hash verification failed for ${filename}`);
    }
  }

  const cutoff = Number(now()) - RETENTION_MS;
  const wouldDelete = retentionCandidates
    .filter(entry => entry.mtimeMs < cutoff)
    .map(entry => entry.name)
    .sort();
  let deleted = [];
  if (!dryRun) {
    const manager = createLogManager({
      rootDir: root,
      store: { getState: () => ({}) },
      activeFiles: () => Array.from(active),
      now,
    });
    deleted = manager.cleanup().deleted;
  }

  return {
    rootDir: root,
    dryRun,
    renamed: entries,
    skippedActive: skippedActive.sort(),
    protected: protectedFiles.sort(),
    wouldDelete,
    deleted,
  };
}

function parseArguments(argv) {
  const options = { rootDir: process.env.STREAMHUB_ROOT || '/opt/StreamHub', dryRun: false, manifest: '' };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--dry-run') options.dryRun = true;
    else if (argument === '--root') options.rootDir = argv[++index];
    else if (argument === '--now') options.nowValue = argv[++index];
    else if (argument === '--manifest') options.manifest = argv[++index];
    else throw new Error(`Unknown argument: ${argument}`);
  }
  return options;
}

function writeManifest(rootDir, manifestPath, result) {
  const dataDir = path.resolve(rootDir, 'data');
  const resolved = path.resolve(manifestPath);
  if (!resolved.startsWith(`${dataDir}${path.sep}`)) throw new Error('Manifest must be written under StreamHub data');
  const temporary = `${resolved}.tmp-${process.pid}`;
  fs.writeFileSync(temporary, `${JSON.stringify(result, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temporary, resolved);
}

if (require.main === module) {
  try {
    const options = parseArguments(process.argv.slice(2));
    const rootDir = path.resolve(options.rootDir);
    const logDir = path.join(rootDir, 'data', 'logs');
    const nowValue = options.nowValue === undefined ? Date.now() : Date.parse(options.nowValue);
    if (!Number.isFinite(nowValue)) throw new Error('--now must be an ISO timestamp');
    const result = migrateLogs({
      rootDir,
      now: () => nowValue,
      dryRun: options.dryRun,
      activeFiles: findOpenLogFiles(logDir),
    });
    if (!options.dryRun) {
      const timestamp = compactTimestamp(nowValue);
      const manifest = options.manifest || path.join(rootDir, 'data', `log-migration-${timestamp}.json`);
      writeManifest(rootDir, manifest, result);
      result.manifest = manifest;
    }
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  }
}

module.exports = { findOpenLogFiles, migrateLogs, parseArguments, writeManifest };
