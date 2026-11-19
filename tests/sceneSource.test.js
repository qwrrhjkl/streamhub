const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveSceneSource } = require('../server/lib/sceneSource');
const { resolvePipelineSource } = require('../server/lib/ffmpegBuilder');

test('scene source resolves a playlist scene into a concat manifest', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-scene-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const videoDir = path.join(root, 'data', 'videos');
  fs.mkdirSync(videoDir, { recursive: true });
  const filePath = path.join(videoDir, 'clip.mp4');
  fs.writeFileSync(filePath, 'clip');
  const state = {
    mediaAssets: [{ id: 'media-a', name: 'Clip', path: filePath }],
    scenes: [{ id: 'scene-a', name: 'PGM', sourceType: 'playlist', playlist: ['media-a'], watermarks: [] }],
  };

  const source = resolveSceneSource('scene-a', state, root);
  assert.equal(source.type, 'playlist');
  assert.equal(source.name, '画面场景：PGM');
  assert.deepEqual(source.mediaIds, ['media-a']);
  assert.equal(source.sharedRelay, true);
  assert.ok(fs.existsSync(source.manifestPath));
  assert.match(fs.readFileSync(source.manifestPath, 'utf8'), /file '.*clip\.mp4'/);
});

test('scene source resolves stream scenes as pull inputs', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-scene-stream-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const state = {
    mediaAssets: [],
    scenes: [{
      id: 'scene-stream',
      name: 'Remote',
      sourceType: 'stream',
      playlist: [],
      stream: { protocol: 'rtmp', url: 'rtmp://192.168.16.11/live/pgm' },
      watermarks: [],
    }],
  };

  const source = resolveSceneSource('scene-stream', state, root);
  assert.equal(source.type, 'pull');
  assert.equal(source.url, 'rtmp://192.168.16.11/live/pgm');
  assert.equal(source.sceneId, 'scene-stream');
});

test('pipeline source delegates scene inputs to the runtime resolver', () => {
  let requestedScene = '';
  const source = resolvePipelineSource(
    { input: { type: 'scene', sceneId: 'scene-a' } },
    { scenes: [] },
    {
      resolveSceneSource(sceneId) {
        requestedScene = sceneId;
        return { id: 'scene-source-scene-a', type: 'playlist', manifestPath: '/tmp/list.ffconcat' };
      },
    },
  );

  assert.equal(requestedScene, 'scene-a');
  assert.equal(source.type, 'playlist');
});

test('pipeline source rejects scene input without a runtime resolver', () => {
  assert.throws(
    () => resolvePipelineSource({ input: { type: 'scene', sceneId: 'scene-a' } }, {}),
    /场景输入需要运行环境解析/,
  );
});