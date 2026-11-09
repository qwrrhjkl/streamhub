'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const docsDir = path.join(root, 'docs');
const expected = ['01-系统介绍.md', '02-使用方法.md', '03-Ubuntu24.04安装环境.md'];
const orderedScripts = [
  '00-preflight.sh',
  '10-install-base.sh',
  '20-install-nvidia.sh',
  '30-install-blackmagic.sh',
  '40-build-ffmpeg-decklink.sh',
  '50-install-streamhub.sh',
  '60-verify.sh',
];

test('docs contains exactly the three approved Markdown guides', () => {
  const entries = fs.readdirSync(docsDir, { withFileTypes: true }).filter(entry => entry.isFile());
  assert.deepEqual(entries.map(entry => entry.name).sort(), [...expected].sort());
  assert.equal(entries.every(entry => entry.isFile()), true);
  for (const name of expected) {
    const content = fs.readFileSync(path.join(docsDir, name), 'utf8');
    assert.match(content, /1935/);
    assert.doesNotMatch(content, new RegExp('193' + '6'));
  }
});

test('installation guide lists every numbered script in strict order', () => {
  const install = fs.readFileSync(path.join(docsDir, expected[2]), 'utf8');
  let previous = -1;
  for (const script of orderedScripts) {
    const index = install.indexOf(script);
    assert.equal(index > previous, true, `${script} must appear after the previous script`);
    previous = index;
  }
  assert.match(install, /ubuntu-drivers install --gpgpu/);
  assert.match(install, /Blackmagic Design/);
  assert.match(install, /DeckLinkAPI\.h/);
});

test('root documentation indexes the three guides and approved ports', () => {
  const readme = fs.readFileSync(path.join(root, 'README.md'), 'utf8');
  for (const name of expected) assert.equal(readme.includes(`docs/${name}`), true);
  assert.match(readme, /18080\/tcp/);
  assert.match(readme, /1935\/tcp/);
  assert.match(readme, /127\.0\.0\.1:18081/);
});

test('usage guide explains safe shared-relay input preview behavior', () => {
  const usage = fs.readFileSync(path.join(docsDir, '02-使用方法.md'), 'utf8');

  assert.match(usage, /预览输入源/);
  assert.match(usage, /约 1 秒/);
  assert.match(usage, /共享转推/);
  assert.match(usage, /重启/);
  assert.match(usage, /直连.*采集/);
  assert.match(usage, /不会.*推流平台/);
});
