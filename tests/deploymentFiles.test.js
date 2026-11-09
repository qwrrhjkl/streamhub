'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const scriptsDir = path.join(root, 'scripts');
const ordered = [
  '00-preflight.sh',
  '10-install-base.sh',
  '20-install-nvidia.sh',
  '30-install-blackmagic.sh',
  '40-build-ffmpeg-decklink.sh',
  '50-install-streamhub.sh',
  '60-verify.sh',
];

test('Ubuntu deployment scripts exist in strict order with safe Bash settings', () => {
  for (const file of ordered) {
    const content = fs.readFileSync(path.join(scriptsDir, file), 'utf8');
    assert.match(content, /^#!\/usr\/bin\/env bash/);
    assert.match(content, /set -euo pipefail/);
    assert.match(content, /scripts\/lib\/common\.sh/);
  }
  assert.equal(fs.existsSync(path.join(scriptsDir, 'install-deps.sh')), false);
  const preflight = fs.readFileSync(path.join(scriptsDir, ordered[0]), 'utf8');
  assert.match(preflight, /1935/);
  assert.doesNotMatch(preflight, new RegExp('193' + '6'));
});

test('deployment configuration pins media paths and licensed vendor boundary', () => {
  const env = fs.readFileSync(path.join(root, 'config', 'streamhub.env.example'), 'utf8');
  assert.match(env, /^STREAMHUB_FFMPEG=\/opt\/StreamHub\/runtime\/ffmpeg\/bin\/ffmpeg$/m);
  assert.match(env, /^STREAMHUB_FFPROBE=\/opt\/StreamHub\/runtime\/ffmpeg\/bin\/ffprobe$/m);
  assert.match(env, /^STREAMHUB_RTMP_PORT=1935$/m);
  assert.match(env, /^STREAMHUB_AUTH_USERNAME=admin$/m);
  assert.match(env, /^STREAMHUB_AUTH_PASSWORD=REPLACE_WITH_A_LONG_RANDOM_PASSWORD$/m);
  const serviceInstaller = fs.readFileSync(path.join(scriptsDir, '50-install-streamhub.sh'), 'utf8');
  assert.match(serviceInstaller, /REPLACE_WITH_A_LONG_RANDOM_PASSWORD/);
  assert.match(serviceInstaller, /Set a unique STREAMHUB_AUTH_PASSWORD/);
  const vendor = fs.readFileSync(path.join(root, 'vendor', 'blackmagic', 'README.txt'), 'utf8');
  assert.match(vendor, /Blackmagic Design/i);
  assert.match(vendor, /Desktop Video/i);
  assert.match(vendor, /SDK/i);
  assert.match(vendor, /https:\/\/www\.blackmagicdesign\.com\/support/);
});

test('NVIDIA installer installs the NVENC runtime matching the active driver package', () => {
  const installer = fs.readFileSync(path.join(scriptsDir, '20-install-nvidia.sh'), 'utf8');

  assert.match(installer, /dpkg-query -W -f=.*nvidia-driver-\[0-9\]/);
  assert.match(installer, /libnvidia-encode-\$\{BASH_REMATCH\[1\]\}/);
});

test('Blackmagic installer selects the Linux SDK header instead of a macOS header', () => {
  const installer = fs.readFileSync(path.join(scriptsDir, '30-install-blackmagic.sh'), 'utf8');
  assert.match(installer, /-ipath '\*\/linux\/\*' -name DeckLinkAPI\.h -print -quit/i);
  assert.doesNotMatch(installer, /find "\$\{WORK_DIR\}" -type f -name DeckLinkAPI\.h -print -quit/);
  assert.match(installer, /Linux DeckLinkAPI\.h was not found/);
});

test('systemd services run without root and Nginx exposes the approved ports', () => {
  const appService = fs.readFileSync(path.join(root, 'services', 'streamhub.service'), 'utf8');
  const rtmpService = fs.readFileSync(path.join(root, 'services', 'streamhub-rtmp.service'), 'utf8');
  const nginx = fs.readFileSync(path.join(root, 'services', 'nginx-rtmp.conf'), 'utf8');

  assert.match(appService, /^User=streamhub$/m);
  assert.match(appService, /^Group=streamhub$/m);
  assert.match(appService, /^EnvironmentFile=\/etc\/streamhub\/streamhub\.env$/m);
  assert.doesNotMatch(appService, /User=root/);
  assert.match(rtmpService, /^User=streamhub$/m);
  assert.match(rtmpService, /^Type=simple$/m);
  assert.match(rtmpService, /^KillSignal=SIGQUIT$/m);
  assert.doesNotMatch(rtmpService, /PIDFile=/);
  assert.match(nginx, /listen 1935;/);
  assert.match(nginx, /listen 127\.0\.0\.1:18081;/);
  assert.doesNotMatch(`${appService}\n${rtmpService}\n${nginx}`, new RegExp('193' + '6'));
});

test('service installer creates the RTMP PID directory before validating Nginx', () => {
  const installer = fs.readFileSync(path.join(scriptsDir, '50-install-streamhub.sh'), 'utf8');
  const runtimeDirectory = 'install -d -o streamhub -g streamhub -m 0750 /run/streamhub-rtmp';

  assert.equal(installer.includes(runtimeDirectory), true);
  assert.ok(installer.indexOf(runtimeDirectory) < installer.indexOf('nginx -t -c'));
});

test('service installer validates Nginx as its runtime user', () => {
  const installer = fs.readFileSync(path.join(scriptsDir, '50-install-streamhub.sh'), 'utf8');

  assert.match(
    installer,
    /runuser -u streamhub -- nginx -t -c "\$\{STREAMHUB_PREFIX\}\/services\/nginx-rtmp\.conf" -p "\$\{STREAMHUB_PREFIX\}"/
  );
});

test('RTMP module uses a StreamHub-owned access log instead of the distro default', () => {
  const nginx = fs.readFileSync(path.join(root, 'services', 'nginx-rtmp.conf'), 'utf8');
  const rtmpSection = nginx.split('rtmp {')[1].split('\n}\n\nhttp {')[0];

  assert.match(rtmpSection, /^\s*access_log \/opt\/StreamHub\/data\/logs\/nginx-rtmp-ingest-access\.log;$/m);
  assert.doesNotMatch(rtmpSection, /\/var\/log\/nginx/);
});

test('all administrative Nginx preflights use the StreamHub runtime user', () => {
  const verify = fs.readFileSync(path.join(scriptsDir, '60-verify.sh'), 'utf8');
  const healthcheck = fs.readFileSync(path.join(scriptsDir, 'healthcheck.sh'), 'utf8');
  const control = fs.readFileSync(path.join(scriptsDir, 'streamhubctl.sh'), 'utf8');

  for (const script of [verify, healthcheck, control]) {
    assert.match(script, /runuser -u streamhub -- nginx -t/);
  }
});

test('application restart limits are valid systemd Unit settings', () => {
  const appService = fs.readFileSync(path.join(root, 'services', 'streamhub.service'), 'utf8');
  const unitSection = appService.split('[Service]')[0];
  const serviceSection = appService.split('[Service]')[1].split('[Install]')[0];

  assert.match(unitSection, /^StartLimitIntervalSec=30$/m);
  assert.match(unitSection, /^StartLimitBurst=5$/m);
  assert.doesNotMatch(serviceSection, /^StartLimit(?:IntervalSec|Burst)=/m);
});

test('FFmpeg build contract enables DeckLink NVENC and required transports', () => {
  const build = fs.readFileSync(path.join(scriptsDir, '40-build-ffmpeg-decklink.sh'), 'utf8');
  for (const flag of ['--enable-decklink', '--enable-nvenc', '--enable-libx264', '--enable-libsrt', '--enable-openssl']) {
    assert.equal(build.includes(flag), true, `missing ${flag}`);
  }
  assert.match(build, /--extra-cflags="-I\$\{DECKLINK_SDK_INCLUDE\}"/);
  assert.match(build, /--extra-cxxflags="-I\$\{DECKLINK_SDK_INCLUDE\}"/);
  assert.match(build, /FFMPEG_VERSION="7\.1\.2"/);
  assert.match(build, /DeckLinkAPI\.h/);
  assert.match(build, /encoder_text="\$\("\$\{staged_ffmpeg\}" -hide_banner -encoders 2>\/dev\/null\)"/);
  assert.match(build, /grep -q 'h264_nvenc' <<<"\$\{encoder_text\}"/);
  assert.match(build, /device_text="\$\("\$\{staged_ffmpeg\}" -hide_banner -devices 2>\/dev\/null\)"/);
  assert.match(build, /protocol_text="\$\("\$\{staged_ffmpeg\}" -hide_banner -protocols 2>\/dev\/null\)"/);
  assert.doesNotMatch(build, /\|\s*head\b/);
});

test('FFmpeg build applies the DeckLink SDK 16 compatibility patch', () => {
  const build = fs.readFileSync(path.join(scriptsDir, '40-build-ffmpeg-decklink.sh'), 'utf8');
  const patchPath = path.join(scriptsDir, 'patches', 'ffmpeg-7.1.2-decklink-sdk16.patch');
  const patch = fs.readFileSync(patchPath, 'utf8');

  assert.match(build, /ffmpeg-7\.1\.2-decklink-sdk16\.patch/);
  assert.match(build, /patch --batch --forward --strip=1/);
  for (const token of [
    'DeckLinkAPI_v14_2_1.h',
    'IDeckLinkInput_v14_2_1',
    'IDeckLinkMemoryAllocator_v14_2_1',
    'IDeckLinkVideoOutputCallback_v14_2_1',
  ]) {
    assert.equal(patch.includes(token), true, `missing ${token}`);
  }
});

test('package metadata matches the Node.js deployment baseline', () => {
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  assert.equal(packageJson.engines.node, '>=22');
});

test('live-delay media smoke test is local-only and rejects decoder corruption', () => {
  const smokePath = path.join(scriptsDir, 'verify-live-delay-media.js');
  assert.equal(fs.existsSync(smokePath), true);
  const smoke = fs.readFileSync(smokePath, 'utf8');

  assert.match(smoke, /require\('\.\.\/server\/lib\/liveDelayBuffer'\)/);
  assert.match(smoke, /STREAMHUB_FFMPEG/);
  assert.match(smoke, /spawn\([^;]+\{\s*stdio:/s);
  assert.doesNotMatch(smoke, /shell:\s*true/);
  assert.match(smoke, /127\.0\.0\.1/);
  assert.doesNotMatch(smoke, /rtmps?:\/\//i);
  for (const pattern of [
    'Packet corrupt', 'concealing \\d+ DC', 'decode_slice_header',
    'non-existing PPS', 'no frame!', 'error while decoding',
  ]) {
    assert.equal(smoke.includes(pattern), true, `missing corruption pattern ${pattern}`);
  }
});

test('final verification requires a real DeckLink device row and robust port checks', () => {
  const verify = fs.readFileSync(path.join(scriptsDir, '60-verify.sh'), 'utf8');
  const ffmpegDeckLinkRow = '  81:610e9870:00000000 [DeckLink Duo (1)] (none)';
  const sourceRowPattern = '^[[:space:]]*[^[:space:]]+[[:space:]]+\\[[^]]+\\][[:space:]]+\\([^)]*\\)[[:space:]]*$';

  assert.match(ffmpegDeckLinkRow, /^[ \t]*\S+[ \t]+\[[^\]]+\][ \t]+\([^)]*\)[ \t]*$/);
  assert.equal(verify.includes(`decklink_source_row_pattern='${sourceRowPattern}'`), true);
  assert.doesNotMatch(verify, /grep -Eqi 'DeckLink\|Blackmagic'/);
  assert.match(verify, /firmware version mismatch/i);
  assert.match(verify, /Desktop Video firmware updater/i);
  assert.match(verify, /port_in_use tcp 18080/);
  assert.match(verify, /port_in_use tcp 1935/);
  assert.doesNotMatch(verify, /ss -ltn \| grep -q/);
});

module.exports = { ordered };
