const fs = require('node:fs');
const path = require('node:path');
const { createId, ensureDir } = require('./store');
const { normalizeScene } = require('./studioModel');

function sceneSourceError(message) {
  const error = new Error(message);
  error.statusCode = 400;
  return error;
}

function escapeConcatPath(filePath) {
  return String(filePath).replace(/'/g, "'\\''");
}

function resolveSceneSource(sceneId, state = {}, rootDir) {
  const scene = (state.scenes || []).find(item => item.id === sceneId);
  if (!scene) throw sceneSourceError('画面场景不存在');
  if (!rootDir) throw sceneSourceError('画面场景素材目录未配置');

  const normalized = normalizeScene(scene, state, scene);
  if (normalized.sourceType === 'stream') {
    return {
      id: `scene-source-${scene.id}`,
      name: `画面场景：${scene.name}`,
      type: 'pull',
      url: normalized.stream.url,
      sceneId: scene.id,
      sharedRelay: true,
    };
  }

  const mediaIds = normalized.playlist.slice();
  const lines = ['ffconcat version 1.0'];
  for (const mediaId of mediaIds) {
    const asset = (state.mediaAssets || []).find(item => item.id === mediaId);
    if (!asset) throw sceneSourceError(`场景中的视频素材不存在：${mediaId}`);
    const filePath = path.resolve(String(asset.path || ''));
    if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
      throw sceneSourceError(`视频素材文件不存在：${asset.name || asset.id || mediaId}`);
    }
    lines.push(`file '${escapeConcatPath(filePath)}'`);
  }

  const playlistDir = path.join(rootDir, 'data', 'playlists');
  ensureDir(playlistDir);
  const manifestPath = path.join(playlistDir, `${createId('playlist')}.ffconcat`);
  fs.writeFileSync(manifestPath, `${lines.join('\n')}\n`, { flag: 'wx' });

  return {
    id: `scene-source-${scene.id}`,
    name: `画面场景：${scene.name}`,
    type: 'playlist',
    manifestPath,
    mediaIds,
    sceneId: scene.id,
    sharedRelay: true,
  };
}

module.exports = { resolveSceneSource };