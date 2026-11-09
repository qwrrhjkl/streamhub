const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  validateSlideshow,
  slideshowCacheKey,
  buildSlideshowRenderArgs,
  prepareSlideshowCache,
} = require('../server/lib/slideshowCache');

function fixture(rootDir, name, content = name) {
  const filePath = path.join(rootDir, name);
  fs.writeFileSync(filePath, content);
  return filePath;
}

test('validateSlideshow accepts OBS-style defaults and rejects an excessive transition', () => {
  assert.equal(validateSlideshow({ images: [{ path: '/tmp/a.png' }], intervalMs: 2000, transitionMs: 700 }).intervalMs, 2000);
  assert.throws(
    () => validateSlideshow({ images: [{ path: '/tmp/a.png' }], intervalMs: 1000, transitionMs: 1200 }),
    /淡入淡出时长不能超过播放间隔/,
  );
});

test('validateSlideshow enforces timing and image count limits without silently clamping', () => {
  assert.throws(() => validateSlideshow({ images: [], intervalMs: 499, transitionMs: 0 }), /播放间隔必须在 500/);
  assert.throws(() => validateSlideshow({ images: [], intervalMs: 2000, transitionMs: 5001 }), /淡入淡出时长必须在 0/);
  assert.throws(() => validateSlideshow({ images: Array.from({ length: 21 }, (_, index) => ({ path: `/tmp/${index}.png` })) }), /最多添加 20 张/);
});

test('slideshow cache keys include image order resolution timing and file identity', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-slide-key-'));
  try {
    const a = fixture(rootDir, 'a.png', 'a');
    const b = fixture(rootDir, 'b.png', 'b');
    const first = slideshowCacheKey({ images: [{ path: a }, { path: b }], intervalMs: 2000, transitionMs: 700 }, '1920x1080');
    const reordered = slideshowCacheKey({ images: [{ path: b }, { path: a }], intervalMs: 2000, transitionMs: 700 }, '1920x1080');
    const resized = slideshowCacheKey({ images: [{ path: a }, { path: b }], intervalMs: 2000, transitionMs: 700 }, '1280x720');
    assert.notEqual(first, reordered);
    assert.notEqual(first, resized);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('render args preserve alpha and crossfade the last slide back to the first', () => {
  const args = buildSlideshowRenderArgs({
    images: [{ path: '/a.png' }, { path: '/b.png' }],
    intervalMs: 2000,
    transitionMs: 700,
  }, '1920x1080', '/cache/out.mov');
  const filter = args[args.indexOf('-filter_complex') + 1];
  const chains = filter.split(';');
  const slideChains = chains.filter(chain => /^\[\d+:v\]/.test(chain));

  assert.equal(args.filter(value => value === '/a.png').length, 2);
  assert.equal(args.filter(value => value === '-loop').length, 3);
  assert.equal(slideChains.length, 3);
  assert.equal(slideChains.every(chain => !chain.includes('setpts=')), true);
  assert.match(filter, /pad=1920:1080:\(ow-iw\)\/2:\(oh-ih\)\/2:color=black@0/);
  assert.match(filter, /format=rgba/);
  assert.match(filter, /xfade=transition=fade/);
  assert.match(filter, /trim=duration=4,setpts=PTS-STARTPTS\[outv\]/);
  assert.equal(args.includes('qtrle'), true);
  assert.equal(args.includes('argb'), true);
  assert.equal(args.at(-1), '/cache/out.mov');
});

test('prepareSlideshowCache reuses an existing cache and returns one image without rendering', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-slide-cache-'));
  try {
    const a = fixture(rootDir, 'a.png', 'a');
    const b = fixture(rootDir, 'b.png', 'b');
    let runs = 0;
    let command = '';
    const runner = (value, args) => {
      command = value;
      runs += 1;
      const tmpPath = args.at(-1);
      fs.writeFileSync(tmpPath, 'rendered');
      return { status: 0, stdout: '', stderr: '' };
    };
    const slideshow = { images: [{ path: a }, { path: b }], intervalMs: 2000, transitionMs: 700 };

    const first = prepareSlideshowCache({
      rootDir,
      slideshow,
      resolution: '1920x1080',
      runner,
      binaries: { ffmpeg: '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg' },
    });
    const second = prepareSlideshowCache({ rootDir, slideshow, resolution: '1920x1080', runner });
    const one = prepareSlideshowCache({ rootDir, slideshow: { ...slideshow, images: [{ path: a }] }, resolution: '1920x1080', runner });

    assert.equal(runs, 1);
    assert.equal(command, '/opt/StreamHub/runtime/ffmpeg/bin/ffmpeg');
    assert.equal(first.preparedPath, second.preparedPath);
    assert.equal(fs.existsSync(first.preparedPath), true);
    assert.equal(one.preparedPath, a);
    assert.equal(one.cached, false);
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});

test('prepareSlideshowCache rejects missing images and propagates renderer diagnostics', () => {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), 'streamhub-slide-error-'));
  try {
    const a = fixture(rootDir, 'a.png', 'a');
    assert.throws(
      () => prepareSlideshowCache({
        rootDir,
        slideshow: { images: [{ path: a }, { path: path.join(rootDir, 'missing.png') }], intervalMs: 2000, transitionMs: 700 },
        resolution: '1920x1080',
      }),
      /幻灯片图片不存在.*missing\.png/,
    );
    assert.throws(
      () => prepareSlideshowCache({
        rootDir,
        slideshow: { images: [{ path: a }, { path: a }], intervalMs: 2000, transitionMs: 700 },
        resolution: '1920x1080',
        runner: () => ({ status: 1, stdout: '', stderr: 'filter failed' }),
      }),
      /生成幻灯片缓存失败.*filter failed/,
    );
  } finally {
    fs.rmSync(rootDir, { recursive: true, force: true });
  }
});
