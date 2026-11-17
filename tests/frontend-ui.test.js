const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const root = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(root, 'app', 'index.html'), 'utf8');
const app = fs.readFileSync(path.join(root, 'app', 'app.js'), 'utf8');
const css = fs.readFileSync(path.join(root, 'app', 'styles.css'), 'utf8');
const server = fs.readFileSync(path.join(root, 'server', 'index.js'), 'utf8');

function controlMarkup(name) {
  const selectMatch = html.match(new RegExp(`<select[^>]+name="${name}"[\\s\\S]*?</select>`));
  if (selectMatch) return { type: 'select', markup: selectMatch[0] };
  const inputMatch = html.match(new RegExp(`<input[^>]+name="${name}"[^>]*>`));
  if (inputMatch) return { type: 'input', markup: inputMatch[0] };
  return null;
}

function formMarkup(id) {
  const match = html.match(new RegExp(`<form[^>]+id="${id}"[\\s\\S]*?</form>`));
  assert.ok(match, `${id} form should exist`);
  return match[0];
}

function appFunctionSource(name) {
  const functionStart = app.indexOf(`function ${name}`);
  assert.notEqual(functionStart, -1, `${name} function should exist`);
  const start = app.slice(Math.max(0, functionStart - 6), functionStart) === 'async '
    ? functionStart - 6
    : functionStart;
  const signatureEnd = app.indexOf(')', functionStart);
  const open = app.indexOf('{', signatureEnd);
  assert.notEqual(open, -1, `${name} function body should exist`);
  let depth = 0;
  for (let index = open; index < app.length; index += 1) {
    if (app[index] === '{') depth += 1;
    if (app[index] === '}') {
      depth -= 1;
      if (depth === 0) return app.slice(start, index + 1);
    }
  }
  assert.fail(`${name} function body should close`);
}

function appFunction(name) {
  return Function(`return (${appFunctionSource(name)})`)();
}

test('frontend RTMP fallbacks use the standard port 1935', () => {
  assert.doesNotMatch(app, new RegExp('rtmpPort\\s*\\|\\|\\s*193' + '6'));
  assert.match(app, /rtmpPort\s*\|\|\s*1935/);
});

function appFunctions(names, context = {}) {
  const sandbox = vm.createContext({ ...context });
  const exports = names.map(name => `this.${name} = (${appFunctionSource(name)});`).join('\n');
  vm.runInContext(exports, sandbox);
  return sandbox;
}

test('approved A5 login markup gates the console and exposes an accessible user menu', () => {
  for (const id of [
    'loginView', 'loginForm', 'loginUsername', 'loginPassword', 'loginError', 'loginSubmit',
    'consoleApp', 'userMenuButton', 'userMenu', 'currentUsername', 'logoutButton',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  }
  assert.match(html, /class="login-view" id="loginView"/);
  assert.match(html, /class="console-app" id="consoleApp" hidden/);
  assert.match(html, /class="signal-field"[^>]+aria-hidden="true"/);
  assert.match(html, /class="channel-bars"[^>]+aria-hidden="true"/);
  assert.match(html, /id="loginError"[^>]+role="alert"[^>]+hidden/);
  assert.match(html, /id="userMenuButton"[^>]+aria-label="[^"]+"/);
  assert.match(html, /id="userMenu"[^>]+hidden/);
  assert.doesNotMatch(html, /注册|连接 IP|LIVE OPERATIONS GATEWAY|SYSTEM READY|CONTROL PLANE ONLINE/);
});

test('approved A5 login styling is centered, rounded, responsive, and keyboard visible', () => {
  assert.match(css, /\.login-view\{[^}]*min-height:100vh[^}]*place-items:center[^}]*background-color:#d8e7e9/);
  assert.match(css, /\.login-card\{[^}]*width:min\(440px,calc\(100% - 34px\)\)[^}]*border-radius:18px/);
  assert.match(css, /\.login-card input,\.login-card button\{[^}]*min-height:49px[^}]*border-radius:11px/);
  assert.match(css, /\.login-view :focus-visible\{/);
  assert.match(css, /\.console-user-menu\{[^}]*border-radius:8px/);
  assert.match(css, /@media\(max-width:820px\)[\s\S]*\.login-card\{[^}]*padding:25px/);
  assert.match(css, /@media\(prefers-reduced-motion:reduce\)/);
  assert.doesNotMatch(css, /login-(?:promo|visual|rectangle|left-panel)/);
});

test('management HTTP 401 enters the shared unauthorized path but login failures stay inline', async () => {
  let unauthorizedCalls = 0;
  const context = appFunctions(['api'], {
    async fetch() {
      return { ok: false, status: 401, async json() { return { error: 'expired' }; } };
    },
    handleUnauthorized() { unauthorizedCalls += 1; },
  });

  await assert.rejects(context.api('/api/state'), error => error.status === 401);
  assert.equal(unauthorizedCalls, 1);
  await assert.rejects(context.api('/api/auth/login'), error => error.status === 401);
  assert.equal(unauthorizedCalls, 1);
});

test('entering the console toggles both views, renders the username, and loads once', async () => {
  const nodes = {
    '#loginView': { hidden: false },
    '#consoleApp': { hidden: true },
    '#currentUsername': { textContent: '' },
    '#userMenu': { hidden: false },
    '#userMenuButton': { setAttribute() {} },
  };
  const authState = { authenticated: false, username: '', resolving: true, signingOut: false };
  let loadCalls = 0;
  let pollingCalls = 0;
  const context = appFunctions(['enterConsole'], {
    authState,
    $: selector => nodes[selector],
    async loadState() { loadCalls += 1; },
    startPolling() { pollingCalls += 1; },
  });

  await context.enterConsole('admin');

  assert.equal(authState.authenticated, true);
  assert.equal(authState.username, 'admin');
  assert.equal(nodes['#loginView'].hidden, true);
  assert.equal(nodes['#consoleApp'].hidden, false);
  assert.equal(nodes['#currentUsername'].textContent, 'admin');
  assert.equal(loadCalls, 1);
  assert.equal(pollingCalls, 1);
});

test('failed initial console loading returns to the signed-out state before polling starts', async () => {
  const nodes = {
    '#loginView': { hidden: false },
    '#consoleApp': { hidden: true },
    '#currentUsername': { textContent: '' },
    '#userMenu': { hidden: false },
    '#userMenuButton': { setAttribute() {} },
  };
  let leaveCalls = 0;
  let pollingCalls = 0;
  const context = appFunctions(['enterConsole'], {
    authState: { authenticated: false, username: '', resolving: true, signingOut: false },
    $: selector => nodes[selector],
    async loadState() { throw new Error('load failed'); },
    startPolling() { pollingCalls += 1; },
    leaveConsole() { leaveCalls += 1; },
  });

  await assert.rejects(context.enterConsole('admin'), /load failed/);
  assert.equal(leaveCalls, 1);
  assert.equal(pollingCalls, 0);
});

test('authentication flow owns polling, preview cleanup, menu controls, and session bootstrap', () => {
  assert.match(app, /const authState = \{[\s\S]*authenticated: false[\s\S]*resolving: true/);
  for (const name of [
    'resolveSession', 'submitLogin', 'logout', 'enterConsole', 'leaveConsole',
    'handleUnauthorized', 'startPolling', 'stopPolling', 'detachInputPreview', 'setUserMenuOpen',
  ]) {
    assert.notEqual(app.indexOf(`function ${name}`), -1, `${name} should exist`);
  }
  assert.match(appFunctionSource('submitLogin'), /loginPassword/);
  assert.match(appFunctionSource('submitLogin'), /loginError/);
  assert.match(appFunctionSource('logout'), /releaseInputPreview/);
  assert.match(appFunctionSource('leaveConsole'), /stopPolling/);
  assert.match(appFunctionSource('leaveConsole'), /detachInputPreview/);
  assert.match(appFunctionSource('leaveConsole'), /#consoleApp dialog\[open\]/);
  assert.match(appFunctionSource('handleUnauthorized'), /leaveConsole/);
  assert.match(app, /resolveSession\(\)/);
  assert.doesNotMatch(app.slice(app.lastIndexOf('handleMonitorDetailRangePresetChange')), /loadState\(\)\.catch/);
});

function fakeForm(values = {}, disabled = []) {
  const disabledNames = new Set(disabled);
  const elements = Object.fromEntries(Object.entries(values).map(([name, value]) => [name, {
    disabled: disabledNames.has(name),
    tagName: 'INPUT',
    value: String(value),
    attributes: {},
    setAttribute(key, attributeValue) { this.attributes[key] = attributeValue; },
    removeAttribute(key) { delete this.attributes[key]; },
  }]));
  return { elements };
}

class TestFormData {
  constructor(form) {
    this.form = form;
  }

  get(name) {
    const control = this.form.elements[name];
    return control && !control.disabled ? control.value : null;
  }
}

test('video encoder control defaults to auto and exposes an accessible effective-mode status', () => {
  const pipelineForm = formMarkup('pipelineForm');
  const encoder = pipelineForm.match(/<select[^>]+name="videoEncoder"[\s\S]*?<\/select>/);
  assert.ok(encoder, 'video encoder select should exist');

  const options = [...encoder[0].matchAll(/<option value="([^"]+)"([^>]*)>([^<]+)<\/option>/g)];
  assert.deepEqual(options.map(option => option[1]), ['auto', 'copy', 'libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf']);
  assert.match(options[0][2], /selected/);
  assert.match(options[2][3], /x264.*软件编码/);
  assert.match(pipelineForm, /<p id="encodingModeStatus" class="field-status(?: full)?" role="status" aria-live="polite" tabindex="-1"><\/p>/);
  for (const name of ['videoEncoder', 'bitrateKbps', 'outputResolution', 'fps', 'keyframeSec', 'preset', 'profile']) {
    assert.match(controlMarkup(name).markup, /aria-describedby="encodingModeStatus"/);
  }
});

test('pipeline editor is modular and card monitoring is bounded and visibility-aware', () => {
  const pipelineForm = formMarkup('pipelineForm');
  for (const section of ['basic', 'input', 'output', 'video', 'audio', 'processing', 'advanced']) {
    assert.match(pipelineForm, new RegExp(`data-pipeline-section="${section}"`));
    assert.match(pipelineForm, new RegExp(`data-pipeline-panel="${section}"`));
  }
  for (const name of [
    'rateControl', 'maxBitrateKbps', 'bufferSizeKbps', 'crf', 'level', 'tune', 'multipass',
    'bFrames', 'referenceFrames', 'lookahead', 'adaptiveQuantization', 'aqStrength',
    'sceneDetection', 'pixelFormat', 'colorRange', 'repeatHeaders', 'customOptions',
  ]) {
    assert.ok(controlMarkup(name) || pipelineForm.includes(`name="${name}"`), `${name} should exist`);
  }
  assert.match(app, /maxActive:\s*3/);
  assert.match(appFunctionSource('syncPipelineCardMonitors'), /IntersectionObserver/);
  assert.match(appFunctionSource('startPipelineCardMonitor'), /monitor:\s*true/);
  assert.match(appFunctionSource('renderPipelineCardMonitor'), /480p \/ 2 fps 低负载监看/);
  assert.match(appFunctionSource('pipelineCardMonitorMessage'), /暂无输入源/);
  assert.match(css, /@media\(max-width:900px\)[\s\S]*\.pipeline-editor-nav\{[^}]*flex-direction:row/);
});

test('pipeline errors replace raw FFmpeg diagnostics with concise operator guidance', () => {
  const { friendlyPipelineError } = appFunctions(['friendlyPipelineError']);
  assert.match(friendlyPipelineError('Error setting option rc to value 22. Invalid argument'), /码率控制参数无效/);
  assert.match(friendlyPipelineError('cuInit failed: CUDA_ERROR_NO_DEVICE. Invalid argument'), /GPU 可见性/);
  assert.doesNotMatch(friendlyPipelineError('ffmpeg version 7 configuration: --enable-nvenc'), /configuration:/);
});

test('pipeline input validation rejects stale, disabled, and incomplete inputs independently of encoding', () => {
  const context = appFunctions(['validatePipelineInput'], {
    state: {
      rooms: [{ id: 'room-ok', enabled: true }, { id: 'room-off', enabled: false }],
      sources: [{ id: 'source-ok', enabled: true }, { id: 'source-off', enabled: false }],
    },
  });
  const fields = values => ({ get: name => values[name] ?? null });

  assert.equal(context.validatePipelineInput(fields({ inputType: 'room', roomId: 'room-ok' })), '');
  assert.match(context.validatePipelineInput(fields({ inputType: 'room', roomId: 'room-off' })), /已启用的本地直播间/);
  assert.match(context.validatePipelineInput(fields({ inputType: 'room', roomId: 'missing' })), /已启用的本地直播间/);
  assert.equal(context.validatePipelineInput(fields({ inputType: 'legacy', sourceId: 'source-ok' })), '');
  assert.match(context.validatePipelineInput(fields({ inputType: 'legacy', sourceId: 'source-off' })), /已启用的已保存输入源/);
  assert.match(context.validatePipelineInput(fields({ inputType: 'url', url: '  ' })), /URL 输入地址/);
  assert.match(context.validatePipelineInput(fields({ inputType: 'file', filePath: '' })), /视频文件路径/);
  assert.match(context.validatePipelineInput(fields({ inputType: 'capture', videoDevice: '' })), /视频设备/);
  assert.equal(context.validatePipelineInput(fields({ inputType: 'capture', videoDevice: '/dev/video0' })), '');

  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  const submitHandler = app.slice(submitStart, submitEnd);
  assert.ok(submitHandler.indexOf('validatePipelineInput(fd)') < submitHandler.indexOf('syncEncodingControls'));
  assert.ok(submitHandler.indexOf('validatePipelineInput(fd)') < submitHandler.indexOf('await api('));

  const startHandler = appFunctionSource('startPipeline');
  assert.ok(startHandler.indexOf('validatePipelineInput') < startHandler.indexOf('pipelineEncodingValidationError'));
  assert.ok(startHandler.indexOf('validatePipelineInput') < startHandler.indexOf('await api('));
});

test('pipeline validation errors use the focusable inline status before alerting', () => {
  let focused = false;
  let alerted = '';
  const status = {
    textContent: '',
    classList: { add(name) { this.name = name; } },
    focus() { focused = true; },
  };
  const context = appFunctions(['showPipelineValidationError'], {
    $: () => status,
    alert(message) { alerted = message; },
  });

  context.showPipelineValidationError('请选择有效输入');
  assert.equal(status.textContent, '请选择有效输入');
  assert.equal(status.classList.name, 'error');
  assert.equal(focused, true);
  assert.equal(alerted, '请选择有效输入');

  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  assert.match(app.slice(submitStart, submitEnd), /showPipelineValidationError/);
  assert.doesNotMatch(html, /class="monitor-grid"[^>]*aria-live/);
});

test('reference selects preserve valid values and mark stale edit references', () => {
  const context = appFunctions(['escapeHtml', 'optionList', 'replaceReferenceOptions']);
  const select = { value: 'room-b', innerHTML: '' };
  const items = [{ id: 'room-a', name: 'A' }, { id: 'room-b', name: 'B' }];

  context.replaceReferenceOptions(select, items, false);
  assert.equal(select.value, 'room-b');
  assert.match(select.innerHTML, /value="room-b" selected/);

  select.value = 'missing-room';
  context.replaceReferenceOptions(select, items, true);
  assert.equal(select.value, 'missing-room');
  assert.match(select.innerHTML, /value="missing-room" selected>missing-room（原引用已不存在）/);

  select.value = 'missing-room';
  context.replaceReferenceOptions(select, items, false);
  assert.equal(select.value, '');
  assert.doesNotMatch(select.innerHTML, /原引用已不存在/);

  assert.match(appFunctionSource('renderRooms'), /replaceReferenceOptions\([^;]+Boolean\(editingPipelineId\)\)/);
  assert.match(appFunctionSource('renderPipelineFormOptions'), /replaceReferenceOptions\([^;]+Boolean\(editingPipelineId\)\)/);
});

test('pipeline form generation owns async overlay and submit results', () => {
  const ownership = appFunctions(['pipelineFormOwns'], {
    pipelineFormGeneration: 7,
    editingPipelineId: 'pipe-a',
  });
  assert.equal(ownership.pipelineFormOwns(7, 'pipe-a'), true);
  assert.equal(ownership.pipelineFormOwns(6, 'pipe-a'), false);
  assert.equal(ownership.pipelineFormOwns(7, 'pipe-b'), false);

  assert.match(app, /let pipelineFormGeneration = 0/);
  assert.match(app, /let pipelineSubmitPending = false/);
  assert.match(appFunctionSource('resetPipelineForm'), /advancePipelineFormGeneration\(\)/);
  assert.match(appFunctionSource('editPipeline'), /advancePipelineFormGeneration\(\)/);

  const upload = appFunctionSource('uploadOverlayFiles');
  assert.match(upload, /const uploadGeneration = pipelineFormGeneration/);
  assert.match(upload, /const uploadEditingPipelineId = editingPipelineId/);
  assert.match(upload, /pipelineFormOwns\(uploadGeneration, uploadEditingPipelineId\)/);
  assert.ok(upload.indexOf('pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)') < upload.indexOf('setOverlayItems'));

  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  const submitHandler = app.slice(submitStart, submitEnd);
  assert.match(submitHandler, /if \(pipelineSubmitPending\) return/);
  assert.match(submitHandler, /setPipelineSubmitPending\(true\)/);
  assert.match(submitHandler, /setPipelineSubmitPending\(false\)/);
  assert.ok(submitHandler.indexOf('pipelineFormOwns(submitGeneration, submitEditingPipelineId)') < submitHandler.indexOf('resetPipelineForm()'));
});

test('container rerenders restore action focus without changing scroll position', () => {
  let focusOptions = null;
  const before = { dataset: { action: 'start-pipeline', id: 'pipe-a' } };
  const after = {
    dataset: { action: 'start-pipeline', id: 'pipe-a' },
    focus(options) { focusOptions = options; },
  };
  const container = {
    innerHTML: '',
    contains(element) { return element === before; },
    querySelectorAll() { return [after]; },
  };
  const context = appFunctions(['captureContainerFocus', 'restoreContainerFocus', 'replaceContainerHtmlPreservingFocus'], {
    document: { activeElement: before },
  });

  context.replaceContainerHtmlPreservingFocus(container, '<button>new</button>');
  assert.equal(container.innerHTML, '<button>new</button>');
  assert.equal(focusOptions && focusOptions.preventScroll, true);

  assert.match(appFunctionSource('renderPipelineCards'), /replaceContainerHtmlPreservingFocus\(\$\('#pipelineCards'\)/);
  assert.match(appFunctionSource('renderMonitor'), /replaceContainerHtmlPreservingFocus\(\$\('#monitorCards'\)/);
  assert.match(appFunctionSource('renderMonitor'), /data-action="monitor-detail"[^>]+data-id=/);
});

test('semantic status colors meet the reviewed AA token baseline', () => {
  assert.match(css, /--accent:#0969da/);
  assert.match(css, /--danger:#c62828/);
  assert.match(css, /--warn:#9a5a00/);
  assert.match(css, /--ok:#067647/);
  assert.match(css, /\.primary\{[^}]*background:var\(--accent\)[^}]*color:#fff/);
  assert.match(css, /\.field-status\.error\{[^}]*color:var\(--danger\)/);
  assert.match(css, /\.warning\{[^}]*color:var\(--warn\)/);
});

test('settings form defaults absent encoders to auto and retains disabled video parameters', () => {
  const pipelineForm = formMarkup('pipelineForm');
  for (const name of ['preset', 'profile']) {
    assert.match(pipelineForm, new RegExp(`<input[^>]+type="hidden"[^>]+name="${name}"`));
  }
  const values = {
    videoEncoder: 'auto', audioEncoder: 'aac', bitrateKbps: 6123, keyframeSec: 4,
    preset: 'slow', profile: 'main', outputResolution: '1280x720', fps: '50',
    sampleRate: '48000', channels: 'stereo', audioBitrateKbps: 320,
    delaySeconds: 45,
    slideshowIntervalMs: 2000, slideshowTransitionMs: 700,
  };
  const form = fakeForm(values, ['bitrateKbps', 'keyframeSec', 'preset', 'profile', 'outputResolution', 'fps']);
  form.elements.delayEnabled = { checked: true, value: 'on' };
  const context = appFunctions(['formControlValue', 'settingsFromForm'], {
    FormData: TestFormData,
    pipelineWatermarks: [],
    pipelineSlideshow: { images: [] },
  });
  const settings = context.settingsFromForm(form);

  assert.equal(settings.live.videoEncoder, 'auto');
  assert.equal(settings.live.bitrateKbps, 6123);
  assert.equal(settings.live.keyframeSec, 4);
  assert.equal(settings.live.preset, 'slow');
  assert.equal(settings.live.profile, 'main');
  assert.equal(settings.live.delayEnabled, true);
  assert.equal(settings.live.delaySeconds, 45);
  assert.equal(settings.video.outputResolution, '1280x720');
  assert.equal(settings.video.fps, '50');

  delete form.elements.videoEncoder;
  assert.equal(context.settingsFromForm(form).live.videoEncoder, 'auto');

  const fillContext = appFunctions(['setControlValue', 'fillSettingsForm']);
  const fillForm = fakeForm({ videoEncoder: '', audioEncoder: '', bitrateKbps: '', keyframeSec: '', outputResolution: '', fps: '', sampleRate: '', channels: '', audioBitrateKbps: '', delayEnabled: '', delaySeconds: '' });
  fillForm.elements.delayEnabled.checked = false;
  fillContext.fillSettingsForm(fillForm, {});
  assert.equal(fillForm.elements.videoEncoder.value, 'auto');
  assert.equal(fillForm.elements.delayEnabled.checked, false);
  assert.equal(fillForm.elements.delaySeconds.value, '20');
  fillContext.fillSettingsForm(fillForm, { live: { videoEncoder: 'h264_nvenc', delayEnabled: true, delaySeconds: 60 } });
  assert.equal(fillForm.elements.videoEncoder.value, 'h264_nvenc');
  assert.equal(fillForm.elements.delayEnabled.checked, true);
  assert.equal(fillForm.elements.delaySeconds.value, '60');
});

test('distribution form exposes live delay controls and three explicit stop choices', () => {
  const pipelineForm = formMarkup('pipelineForm');
  assert.match(pipelineForm, /<h3>直播延时<\/h3>/);
  assert.match(pipelineForm, /<input[^>]+name="delayEnabled"[^>]+type="checkbox"/);
  assert.match(pipelineForm, /<input[^>]+name="delaySeconds"[^>]+type="number"[^>]+value="20"[^>]+min="1"[^>]+max="300"/);
  assert.match(pipelineForm, /id="liveDelayMemoryEstimate"[^>]+aria-live="polite"/);
  assert.match(html, /<dialog[^>]+id="liveDelayStopDialog"[^>]+aria-labelledby="liveDelayStopTitle"/);
  assert.match(html, /<button[^>]+id="drainLiveDelayBtn"[^>]*>停止直播<\/button>/);
  assert.match(html, /<button[^>]+id="discardLiveDelayBtn"[^>]*>切断直播（丢弃延时）<\/button>/);
  assert.match(html, /<button[^>]+id="cancelLiveDelayStopBtn"[^>]*>取消<\/button>/);
});

test('live delay controls estimate memory and lock the pipeline to shared relay', () => {
  const context = appFunctions(['estimateLiveDelayMemoryMib']);
  assert.equal(context.estimateLiveDelayMemoryMib(20, 8000, 320), 19.8);
  assert.equal(context.estimateLiveDelayMemoryMib(300, 8000, 320), 297.5);
  const syncSource = appFunctionSource('syncLiveDelayControls');
  assert.match(syncSource, /modeControl\.value = 'shared-relay'/);
  assert.match(syncSource, /modeControl\.disabled = enabled/);
  assert.match(syncSource, /delaySecondsControl\.disabled = !enabled/);
  assert.match(syncSource, /原样复制模式下，内存占用按实际输入码率计算/);
});

test('delayed pipeline stop uses drain discard and cancel actions', () => {
  assert.match(appFunctionSource('stopPipeline'), /openLiveDelayStopDialog\(pipeline\)/);
  assert.match(appFunctionSource('requestPipelineStop'), /body: JSON\.stringify\(\{ mode \}\)/);
  assert.match(app, /drainLiveDelayBtn[\s\S]*requestPipelineStop\(pipelineId, 'drain'\)/);
  assert.match(app, /discardLiveDelayBtn[\s\S]*requestPipelineStop\(pipelineId, 'discard'\)/);
  assert.match(app, /cancelLiveDelayStopBtn[\s\S]*liveDelayStopDialog'\)\.close\(\)/);
});

test('draining live delay exposes remaining time and a distinct task state', () => {
  const context = appFunctions(['pipelineStatusLabel', 'pipelineRuntimeMessage'], {
    state: {
      monitor: {
        activePipelines: [{
          pipelineId: 'pipe-delay',
          status: 'draining',
          liveDelay: { enabled: true, remainingSeconds: 12 },
        }],
      },
    },
  });

  assert.equal(context.pipelineStatusLabel('draining'), '正在播完');
  assert.match(context.pipelineRuntimeMessage({ id: 'pipe-delay' }), /12 秒/);
  assert.match(appFunctionSource('renderPipelineCards'), /直播延时/);
  assert.match(css, /\.badge\.draining/);
  assert.match(css, /\.live-delay-stop-dialog/);
});

test('auto encoding decisions account for input transport and visual processing', () => {
  const form = fakeForm({ videoEncoder: 'auto', inputType: 'room', url: '', sourceId: '' });
  const context = appFunctions(['assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'formEncodingInput', 'resolveEncodingMode', 'formHasVisualProcessing', 'resolveFormEncodingMode'], {
    pipelineWatermarks: [],
    pipelineSlideshow: { images: [] },
    state: {
      sources: [
        { id: 'saved-rtmp', type: 'pull', url: 'rtmp://example.test/live/saved' },
        { id: 'saved-capture', type: 'capture' },
        { id: 'saved-file', type: 'file', path: '/data/saved.mp4' },
        { id: 'saved-srt', type: 'pull', url: 'srt://example.test:9000' },
      ],
    },
  });

  assert.equal(context.resolveFormEncodingMode(form), 'copy');
  form.elements.inputType.value = 'capture';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.inputType.value = 'url';
  form.elements.url.value = 'rtmp://example.test/live/key';
  assert.equal(context.resolveFormEncodingMode(form), 'copy');
  form.elements.url.value = 'rtmps://example.test/live/key';
  assert.equal(context.resolveFormEncodingMode(form), 'copy');
  form.elements.url.value = 'srt://example.test:9000';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.inputType.value = 'file';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.inputType.value = 'legacy';
  form.elements.sourceId.value = 'saved-rtmp';
  assert.equal(context.resolveFormEncodingMode(form), 'copy');
  form.elements.sourceId.value = 'saved-capture';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.sourceId.value = 'saved-file';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.sourceId.value = 'saved-srt';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');

  context.pipelineWatermarks.push({ id: 'wm-1', path: '/tmp/wm-1.png' });
  form.elements.inputType.value = 'room';
  assert.equal(context.formHasVisualProcessing(), true);
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  context.pipelineWatermarks.length = 0;
  context.pipelineSlideshow.images.push({ id: 'slide-1', path: '/tmp/slide-1.png' });
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.inputType.value = 'file';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.inputType.value = 'url';
  form.elements.url.value = 'srt://example.test:9000';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.inputType.value = 'legacy';
  form.elements.sourceId.value = 'missing-source';
  assert.equal(context.resolveFormEncodingMode(form), 'unsupported');
  form.elements.inputType.value = 'url';
  form.elements.url.value = 'rtmp://example.test/live/key';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.inputType.value = 'room';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.inputType.value = 'capture';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');

  form.elements.videoEncoder.value = 'libx264';
  assert.equal(context.resolveFormEncodingMode(form), 'cpu');
  form.elements.videoEncoder.value = 'h264_nvenc';
  assert.equal(context.resolveFormEncodingMode(form), 'nvenc');
  form.elements.videoEncoder.value = 'copy';
  assert.equal(context.resolveFormEncodingMode(form), 'copy');
});

test('ineligible auto inputs with visual layers are rejected before submit API calls', () => {
  const form = fakeForm({
    videoEncoder: 'auto', inputType: 'file', url: '', sourceId: 'missing-source',
    bitrateKbps: '8000', outputResolution: '1920x1080', fps: '59.94', keyframeSec: '2',
    preset: 'veryfast', profile: 'high',
  });
  const status = { textContent: '', classList: { error: false, toggle(_name, value) { this.error = value; } } };
  const context = appFunctions(['assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'formEncodingInput', 'resolveEncodingMode', 'formHasVisualProcessing', 'resolveFormEncodingMode', 'syncEncodingControls'], {
    $: () => status,
    pipelineWatermarks: [{ id: 'wm-1' }],
    pipelineSlideshow: { images: [] },
    state: { sources: [] },
  });

  assert.equal(context.syncEncodingControls(form).mode, 'unsupported');
  assert.match(context.syncEncodingControls(form).error, /自动模式无法识别当前输入/);

  context.pipelineWatermarks.length = 0;
  context.pipelineSlideshow.images.push({ id: 'slide-1' });
  form.elements.inputType.value = 'url';
  form.elements.url.value = 'srt://example.test:9000';
  assert.equal(context.syncEncodingControls(form).mode, 'unsupported');
  assert.match(context.syncEncodingControls(form).error, /自动模式无法识别当前输入/);

  context.pipelineSlideshow.images.length = 0;
  context.pipelineWatermarks.push({ id: 'wm-2' });
  form.elements.inputType.value = 'legacy';
  assert.equal(context.syncEncodingControls(form).mode, 'unsupported');
  assert.match(context.syncEncodingControls(form).error, /自动模式无法识别当前输入/);

  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  const submitHandler = app.slice(submitStart, submitEnd);
  assert.ok(submitHandler.indexOf('encodingState.error') < submitHandler.indexOf('await api('));
});

test('copy mode disables only ineffective video controls and restores them when mode changes', () => {
  const names = ['bitrateKbps', 'outputResolution', 'fps', 'keyframeSec', 'preset', 'profile'];
  const form = fakeForm(Object.fromEntries([
    ['videoEncoder', 'copy'], ['inputType', 'room'], ['url', ''], ...names.map(name => [name, 'retained']),
  ]));
  const status = { textContent: '', classList: { error: false, toggle(_name, value) { this.error = value; } } };
  const context = appFunctions(['assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'formEncodingInput', 'resolveEncodingMode', 'formHasVisualProcessing', 'resolveFormEncodingMode', 'syncEncodingControls'], {
    $: () => status,
    pipelineWatermarks: [],
    pipelineSlideshow: { images: [] },
    state: { sources: [] },
  });

  assert.equal(context.syncEncodingControls(form).mode, 'copy');
  assert.equal(status.textContent, '实际模式：原样复制');
  for (const name of names) {
    assert.equal(form.elements[name].disabled, true);
    assert.equal(form.elements[name].attributes['aria-disabled'], 'true');
    assert.equal(form.elements[name].value, 'retained');
  }

  form.elements.videoEncoder.value = 'auto';
  form.elements.inputType.value = 'capture';
  assert.equal(context.syncEncodingControls(form).mode, 'nvenc');
  assert.equal(status.textContent, '实际模式：NVIDIA NVENC');
  assert.equal(status.classList.error, false);
  for (const name of names) {
    assert.equal(form.elements[name].disabled, false);
    assert.equal('aria-disabled' in form.elements[name].attributes, false);
  }

  form.elements.inputType.value = 'file';
  assert.equal(context.syncEncodingControls(form).mode, 'unsupported');
  assert.equal(status.textContent, '自动模式无法识别当前输入，请选择明确的视频编码器');
  assert.equal(status.classList.error, true);
});

test('invalid copy and unsupported auto modes are rejected before pipeline API calls', () => {
  for (const helper of ['formHasVisualProcessing', 'resolveFormEncodingMode', 'syncEncodingControls', 'encodingModeLabel']) {
    assert.match(app, new RegExp(`function ${helper}\\(`));
  }
  assert.match(app, /原样复制不能用于采集卡输入、水印或幻灯片/);

  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  const submitHandler = app.slice(submitStart, submitEnd);
  assert.ok(submitHandler.indexOf('syncEncodingControls') < submitHandler.indexOf('await api('));
  assert.ok(submitHandler.indexOf('encodingState.error') < submitHandler.indexOf('await api('));

  const startPipeline = appFunctionSource('startPipeline');
  assert.ok(startPipeline.indexOf('pipelineEncodingValidationError') < startPipeline.indexOf('await api('));

  const validation = appFunctions(['assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'pipelineEncodingInput', 'resolveEncodingMode', 'pipelineEncodingValidationError'], {
    state: { sources: [{ id: 'saved-capture', type: 'capture' }] },
  });
  assert.match(validation.pipelineEncodingValidationError({
    sourceId: 'saved-capture',
    settings: { live: { videoEncoder: 'copy' } },
  }), /原样复制不能用于采集卡输入/);
});

test('effective copy requires shared relay while direct CPU and NVENC remain valid', () => {
  const names = ['bitrateKbps', 'outputResolution', 'fps', 'keyframeSec', 'preset', 'profile'];
  const form = fakeForm(Object.fromEntries([
    ['videoEncoder', 'auto'], ['mode', 'direct'], ['inputType', 'url'], ['url', 'rtmp://example.test/live/key'],
    ...names.map(name => [name, 'retained']),
  ]));
  const status = { textContent: '', classList: { error: false, toggle(_name, value) { this.error = value; } } };
  const context = appFunctions([
    'assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'formEncodingInput',
    'resolveEncodingMode', 'formHasVisualProcessing', 'resolveFormEncodingMode', 'syncEncodingControls',
    'pipelineEncodingInput', 'pipelineEncodingValidationError',
  ], {
    $: () => status,
    pipelineWatermarks: [],
    pipelineSlideshow: { images: [] },
    state: { sources: [] },
  });

  const directCopy = context.syncEncodingControls(form);
  assert.equal(directCopy.mode, 'copy');
  assert.match(directCopy.error, /原样复制.*共享转推/);
  assert.equal(status.classList.error, true);
  assert.match(context.pipelineEncodingValidationError({
    mode: 'direct',
    input: { type: 'url', url: 'rtmp://example.test/live/key' },
    settings: { live: { videoEncoder: 'auto' } },
  }), /原样复制.*共享转推/);

  for (const encoder of ['libx264', 'h264_nvenc']) {
    form.elements.videoEncoder.value = encoder;
    assert.equal(context.syncEncodingControls(form).error, '');
    assert.equal(context.pipelineEncodingValidationError({
      mode: 'direct', input: { type: 'url', url: 'rtmp://example.test/live/key' },
      settings: { live: { videoEncoder: encoder } },
    }), '');
  }

  assert.match(app, /\$\('#pipelineForm'\)\.elements\.mode\.addEventListener\('change', \(\) => syncEncodingControls/);
});

test('legacy saved copy pipelines derive their mode from enabled destinations', () => {
  const context = appFunctions([
    'assetHasPath', 'visualProcessingActive', 'normalizeEncodingInput', 'pipelineEncodingInput',
    'resolveEncodingMode', 'findDestination', 'pipelineEnabledDestinations', 'pipelineEncodingValidationError',
  ], {
    state: {
      sources: [],
      destinations: [
        { id: 'dest-a', enabled: true },
        { id: 'dest-b', enabled: true },
      ],
    },
  });
  const pipeline = {
    input: { type: 'url', url: 'rtmp://example.test/live/key' },
    destinationIds: ['dest-a'],
    settings: { live: { videoEncoder: 'auto' } },
  };

  assert.match(context.pipelineEncodingValidationError(pipeline), /原样复制.*共享转推/);
  pipeline.destinationIds.push('dest-b');
  assert.equal(context.pipelineEncodingValidationError(pipeline), '');

  pipeline.mode = 'direct';
  assert.match(context.pipelineEncodingValidationError(pipeline), /原样复制.*共享转推/);
  pipeline.mode = 'shared-relay';
  pipeline.destinationIds = ['dest-a'];
  assert.equal(context.pipelineEncodingValidationError(pipeline), '');
});

test('frontend visual detection only counts path-backed overlays like the backend', () => {
  const context = appFunctions(['assetHasPath', 'visualProcessingActive', 'formHasVisualProcessing'], {
    pipelineWatermarks: [{ id: 'legacy-no-path' }],
    pipelineSlideshow: { images: [{ id: 'legacy-slide-no-path' }] },
  });

  assert.equal(context.visualProcessingActive({
    watermark: { id: 'legacy' }, watermarks: [{ id: 'item' }], slideshow: { images: [{ id: 'slide' }] },
  }), false);
  assert.equal(context.visualProcessingActive({ watermarks: ['/tmp/watermark.png'] }), true);
  assert.equal(context.visualProcessingActive({ watermarks: [{ path: '/tmp/watermark.png' }] }), true);
  assert.equal(context.visualProcessingActive({ slideshow: { images: [{ path: '/tmp/slide.png' }] } }), true);
  assert.equal(context.visualProcessingActive({ slideshow: { preparedPath: '/tmp/slideshow.mov', images: [] } }), true);
  assert.equal(context.formHasVisualProcessing(), false);
  context.pipelineWatermarks.push({ path: '/tmp/form-watermark.png' });
  assert.equal(context.formHasVisualProcessing(), true);
});

test('monitoring labels effective encoding mode and suppresses copy encoder warnings', () => {
  const encodingModeLabel = appFunction('encodingModeLabel');
  assert.equal(encodingModeLabel('copy'), 'copy');
  assert.equal(encodingModeLabel('nvenc'), 'NVENC');
  assert.equal(encodingModeLabel('cpu'), 'CPU');
  assert.equal(encodingModeLabel('stopped'), '未知');
  assert.equal(encodingModeLabel(), '未知');

  const overview = appFunctionSource('renderMonitor');
  const detail = appFunctionSource('renderMonitorDetail');
  assert.match(overview, /encodingModeLabel\(encodingMode\)/);
  assert.match(detail, /encodingModeLabel\(encodingMode\)/);
  assert.match(overview, /\['nvenc', 'cpu'\]\.includes\(encodingMode\) &&/);
  assert.match(detail, /\['nvenc', 'cpu'\]\.includes\(encodingMode\) &&/);
  assert.match(overview, /<span>实际编码<\/span>/);
  assert.match(detail, /\['实际编码', encodingModeLabel\(encodingMode\)\]/);
});

test('encoding status and disabled settings use the existing restrained semantic tokens', () => {
  assert.match(css, /\.field-status\s*\{[^}]*font-size:13px[^}]*min-height:/);
  assert.match(css, /\.field-status\.error\s*\{[^}]*color:var\(--danger\)/);
  assert.match(css, /\.field-status\.warning\s*\{[^}]*color:var\(--warn\)/);
  assert.match(app, /status\.classList\.toggle\('warning', statusTone === 'warning'\)/);
  assert.match(css, /\.settings-box (?:input|select):disabled/);
});

test('distribution live parameters use preset selects while bitrate remains custom numeric input', () => {
  const pipelineForm = formMarkup('pipelineForm');
  for (const name of ['outputResolution', 'fps', 'keyframeSec', 'sampleRate', 'channels', 'videoEncoder', 'audioEncoder']) {
    const control = pipelineForm.match(new RegExp(`<select[^>]+name="${name}"[\\s\\S]*?</select>`));
    assert.ok(control, `${name} control should exist`);
  }

  assert.match(pipelineForm, /<input[^>]+name="bitrateKbps"[^>]+type="number"/);
  assert.match(pipelineForm, /<input[^>]+name="audioBitrateKbps"[^>]+type="number"/);
});

test('room form and room cards do not expose terminal-controlled audio video settings', () => {
  const roomForm = formMarkup('roomForm');
  assert.doesNotMatch(roomForm, /直播间设置/);
  for (const name of ['outputResolution', 'fps', 'keyframeSec', 'sampleRate', 'channels', 'videoEncoder', 'audioEncoder', 'bitrateKbps', 'audioBitrateKbps']) {
    assert.doesNotMatch(roomForm, new RegExp(`name="${name}"`), `${name} should not appear in room form`);
  }
  assert.doesNotMatch(app, /room\.settings/);
});

test('capture-card resolution and fps use preset selects', () => {
  assert.equal(controlMarkup('captureResolution').type, 'select');
  assert.equal(controlMarkup('captureFps').type, 'select');
});

test('room and pipeline cards expose edit actions and cancel edit buttons', () => {
  assert.match(html, /id="cancelRoomEditBtn"/);
  assert.match(html, /id="cancelPipelineEditBtn"/);
  assert.match(app, /let editingRoomId/);
  assert.match(app, /let editingPipelineId/);
  assert.match(app, /editRoom\(/);
  assert.match(app, /editPipeline\(/);
  assert.match(app, /data-action="edit-room"/);
  assert.match(app, /data-action="edit-pipeline"/);
});

test('distribution uses a searchable status-filtered task card board with an on-demand form', () => {
  for (const id of [
    'pipelineTaskSummary', 'pipelineStatusFilters', 'pipelineSearchInput', 'newPipelineBtn',
    'pipelineResultCount', 'pipelineCards', 'closePipelineFormBtn',
  ]) {
    assert.match(html, new RegExp(`id="${id}"`), `${id} should exist`);
  }
  assert.match(html, /id="pipelineForm" hidden/);
  assert.match(html, /data-pipeline-filter="all"[^>]+aria-pressed="true"/);
  assert.match(html, /data-pipeline-filter="running"/);
  assert.match(html, /class="pipeline-card-grid"/);
  assert.match(css, /\.pipeline-card-grid\{[^}]*grid-template-columns:repeat\(auto-fill,minmax\(min\(100%,360px\),1fr\)\)/);
  assert.match(css, /\.pipeline-task-card\{[^}]*border-radius:10px/);
  assert.match(css, /@media\(max-width:640px\)[\s\S]*\.pipeline-card-footer\{[^}]*flex-direction:column/);

  const renderer = appFunctionSource('renderPipelineCards');
  assert.match(renderer, /pipelineMatchesCardFilters/);
  assert.match(renderer, /pipeline-card-preview/);
  assert.match(renderer, /pipeline-card-live-metrics/);
  assert.match(renderer, /data-action="preview-pipeline"/);
  assert.match(renderer, /data-action="duplicate-pipeline"/);
  assert.match(renderer, /data-action="open-studio-switcher"/);
  assert.doesNotMatch(renderer, /class="signal-path"/);
  assert.match(appFunctionSource('editPipeline'), /setPipelineFormVisible\(true\)/);
  assert.match(appFunctionSource('closePipelineForm'), /setPipelineFormVisible\(false\)/);
});

test('console uses a professional appliance shell with grouped operational navigation', () => {
  for (const label of ['系统总览', '分发任务', '输入通道', '场景编排', '输出目标', '输出监测', '采集设备', '系统日志']) {
    assert.match(html, new RegExp(`<span>${label}</span>`));
  }
  for (const id of ['topbarPageTitle', 'topbarOutputCount', 'topbarCpu', 'topbarGpu', 'topbarUplink']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  assert.match(html, /class="sidebar-machine-status"/);
  assert.match(css, /\.console-app \.nav-section-label\{/);
  assert.match(css, /\.console-app \.topbar-telemetry\{/);
  assert.match(app, /function show\(view\)[\s\S]*?VIEW_META\[view\]/);
  assert.match(appFunctionSource('renderTopbarTelemetry'), /sendBytesPerSec/);
});

test('input channels and output targets use on-demand forms and control cards', () => {
  assert.match(html, /id="roomForm" hidden/);
  assert.match(html, /id="destinationForm" hidden/);
  for (const id of ['newRoomBtn', 'closeRoomFormBtn', 'roomBoardSummary', 'newDestinationBtn', 'closeDestinationFormBtn', 'destinationBoardSummary']) {
    assert.match(html, new RegExp(`id="${id}"`));
  }
  const roomRenderer = appFunctionSource('renderRooms');
  const destinationRenderer = appFunctionSource('renderDestinations');
  assert.match(roomRenderer, /entity-control-card input-channel-card/);
  assert.match(roomRenderer, /entity-copy-list/);
  assert.match(roomRenderer, /data-action="create-room"/);
  assert.match(destinationRenderer, /entity-control-card output-target-card/);
  assert.match(destinationRenderer, /entity-target-address/);
  assert.match(destinationRenderer, /data-action="create-destination"/);
  assert.match(css, /\.console-app \.entity-card-grid\{/);
  assert.match(css, /@media\(max-width:640px\)[\s\S]*\.console-app \.entity-card-actions\{/);
});

test('task card status buckets and compact bitrate labels are deterministic', () => {
  const context = appFunctions(['pipelineStatusBucket', 'pipelineStatusIsActive', 'compactBitrate']);
  assert.equal(context.pipelineStatusBucket('running'), 'running');
  assert.equal(context.pipelineStatusBucket('fallback'), 'error');
  assert.equal(context.pipelineStatusBucket('stopped'), 'stopped');
  assert.equal(context.pipelineStatusIsActive('draining'), true);
  assert.equal(context.pipelineStatusIsActive('error'), false);
  assert.equal(context.compactBitrate(9820), '9.82 Mbps');
  assert.equal(context.compactBitrate(800), '800 Kbps');
  assert.equal(context.compactBitrate(null), '--');
});

test('capture form exposes V4L2 and DeckLink backends', () => {
  const pipelineForm = formMarkup('pipelineForm');
  assert.match(pipelineForm, /name="captureBackend"/);
  assert.match(pipelineForm, /value="v4l2"/);
  assert.match(pipelineForm, /value="decklink"/);
  assert.match(pipelineForm, /name="decklinkDevice"/);
  assert.match(pipelineForm, /name="decklinkFormatCode"/);
  assert.match(pipelineForm, /name="decklinkRawFormat"/);
  assert.match(pipelineForm, /name="decklinkAudioChannels"/);
  assert.match(pipelineForm, /id="decklinkStatus"[^>]+role="status"/);
});

test('capture payload serializes DeckLink and preserves the V4L2 default', () => {
  const capturePayloadFromValues = appFunction('capturePayloadFromValues');
  const values = input => ({ get: name => Object.hasOwn(input, name) ? input[name] : null });

  assert.deepEqual(capturePayloadFromValues(values({
    captureBackend: 'decklink',
    decklinkDevice: 'DeckLink Duo 2 (1)',
    decklinkFormatCode: 'Hp59',
    decklinkRawFormat: 'uyvy422',
    decklinkAudioChannels: '8',
  })), {
    backend: 'decklink',
    device: 'DeckLink Duo 2 (1)',
    formatCode: 'Hp59',
    rawFormat: 'uyvy422',
    audioChannels: 8,
  });

  assert.deepEqual(capturePayloadFromValues(values({
    videoDevice: '/dev/video2',
    audioDevice: 'hw:1,0',
    captureResolution: '1280x720',
    captureFps: '50',
  })), {
    backend: 'v4l2',
    videoDevice: '/dev/video2',
    audioDevice: 'hw:1,0',
    resolution: '1280x720',
    fps: '50',
  });
});

test('capture edit values round-trip both backends', () => {
  const pipelineInputValues = appFunction('pipelineInputValues');
  assert.deepEqual(pipelineInputValues({ input: { type: 'capture', capture: {
    backend: 'decklink', device: 'DeckLink Mini Recorder 4K', formatCode: 'auto', rawFormat: 'bgra', audioChannels: 16,
  } } }), {
    inputType: 'capture',
    captureBackend: 'decklink',
    decklinkDevice: 'DeckLink Mini Recorder 4K',
    decklinkFormatCode: 'auto',
    decklinkRawFormat: 'bgra',
    decklinkAudioChannels: 16,
  });
  assert.equal(pipelineInputValues({ input: { type: 'capture', capture: { videoDevice: '/dev/video0' } } }).captureBackend, 'v4l2');
});

test('DeckLink field visibility and discovery retain manual entry fallback', () => {
  assert.match(appFunctionSource('updateCaptureBackendFields'), /dataset\.captureBackend/);
  assert.match(appFunctionSource('loadCaptureDevices'), /\/api\/devices/);
  assert.match(appFunctionSource('loadDecklinkFormats'), /decklinkDevice=/);
  assert.match(html, /name="decklinkDevice"[^>]+list="decklinkDeviceOptions"/);
  assert.match(css, /\[hidden\]\s*\{[^}]*display:none!important/);
});

test('monitor metrics normalize invalid values to finite bounded numbers', () => {
  const finiteMetric = appFunction('finiteMetric');

  assert.equal(finiteMetric(null), 0);
  assert.equal(finiteMetric('not-a-number'), 0);
  assert.equal(finiteMetric(Number.NaN), 0);
  assert.equal(finiteMetric(-12), 0);
  assert.equal(finiteMetric(150, { max: 100 }), 100);
  assert.equal(finiteMetric('42.5', { max: 100 }), 42.5);
  assert.match(app, /formatActualBitrate\(o\)/);
  assert.match(app, /formatEstimatedNetworkDropCount\(o\)/);
  assert.match(app, /formatEstimatedNetworkDropRate\(o\)/);
  assert.match(app, /finiteMetric\(o\.transportShortfallPercent/);
  assert.match(app, /formatActualBitrate\(output\)/);
  assert.match(app, /formatEstimatedNetworkDropCount\(output\)/);
  assert.match(app, /formatEstimatedNetworkDropRate\(output\)/);
  assert.match(app, /finiteMetric\(output\.transportShortfallPercent/);
});

test('actual transport and estimated network loss format explicit availability states', () => {
  const context = appFunctions([
    'finiteMetric',
    'formatActualBitrate',
    'formatEstimatedNetworkDropCount',
    'formatEstimatedNetworkDropRate',
  ]);

  assert.equal(context.formatActualBitrate({ actualBitrateAvailable: true, bitrateKbps: 8123.4 }), '8123 Kbps');
  assert.equal(context.formatActualBitrate({ actualBitrateStatus: 'sampling' }), '采样中');
  assert.equal(context.formatActualBitrate({ actualBitrateStatus: 'unavailable' }), '不可用');
  assert.equal(context.formatEstimatedNetworkDropCount({ networkDropAvailable: false, totalDroppedFrames: 0 }), '不可用');
  assert.equal(context.formatEstimatedNetworkDropCount({ networkDropAvailable: true, totalDroppedFrames: 12 }), '12');
  assert.equal(context.formatEstimatedNetworkDropRate({ networkDropAvailable: true, totalDropRatePercent: 1.234 }), '1.23%');
});

test('renderer actions use escaped data attributes and delegated listeners', () => {
  assert.doesNotMatch(app, /onclick\s*=/);
  for (const action of [
    'copy-text', 'remove-selected-destination', 'edit-room', 'toggle-room', 'delete-item',
    'edit-pipeline', 'start-pipeline', 'stop-pipeline', 'preview-pipeline', 'duplicate-pipeline',
    'create-pipeline', 'edit-destination', 'toggle-destination',
  ]) {
    assert.match(app, new RegExp(`data-action="${action}"`));
  }
  for (const renderer of ['renderSelectedDestinations', 'renderRooms', 'renderPipelineCards', 'renderDestinations']) {
    assert.match(app, new RegExp(`${renderer}[\\s\\S]*?bindRendererActions\\(`));
  }
  assert.match(app, /data-id="\$\{escapeHtml\(/);
  assert.match(app, /data-value="\$\{escapeHtml\(/);
  assert.match(app, /data-collection="(?:rooms|pipelines|destinations)"/);

  const escapeHtml = appFunction('escapeHtml');
  const hostile = 'quote" data-action="evil & <';
  const markup = `data-action="edit-room" data-id="${escapeHtml(hostile)}"`;
  assert.match(markup, /^data-action="edit-room" data-id="quote&quot; data-action=&quot;evil &amp; &lt;"$/);
  assert.doesNotMatch(markup, /onclick\s*=/);
});

test('duplicate top navigation is removed and mobile sidebar stays within the viewport', () => {
  assert.doesNotMatch(html, /<header class="topbar">/);
  assert.doesNotMatch(html, /class="tabs"|class="tab(?:\s|")/);
  assert.doesNotMatch(html, /id="reloadBtn"|user-pill/);
  assert.doesNotMatch(css, /\.topbar\{|\.tabs\{|\.tab\{/);
  assert.doesNotMatch(app, /reloadBtn|\.tab/);
  assert.match(css, /@media\(max-width:1100px\)[\s\S]*?\.sidebar\{[^}]*width:auto/);
  assert.match(css, /@media\(max-width:640px\)[\s\S]*?\.nav\{[^}]*grid-template-columns/);
});

test('monitor chart draws bitrate and fps axes with time labels', () => {
  assert.match(app, /formatTimeLabel/);
  assert.match(app, /chartTimeWindow/);
  assert.match(app, /niceBitrateScale/);
  assert.match(app, /niceFpsScale/);
  assert.match(app, /drawBitrateAxisLabels/);
  assert.match(app, /drawFpsAxisLabels/);
  assert.match(app, /drawXAxisLabels/);
  assert.match(app, /pointBitrate/);
  assert.match(app, /pointFps/);
  assert.match(app, /Kbps/);
  assert.match(app, /FPS/);
  assert.match(app, /#2388ff/);
  assert.match(app, /#19a974/);
});

test('monitor view renders per-output charts with a custom time range', () => {
  assert.match(html, /id="monitorRangePreset"/);
  assert.match(html, /id="monitorCustomMinutes"/);
  assert.match(html, /id="applyMonitorRangeBtn"/);
  assert.match(app, /let monitorRangeSec/);
  assert.match(app, /function monitorQuery/);
  assert.match(app, /function drawOutputBitrateChart/);
  assert.match(app, /monitor\.range/);
  assert.match(app, /timeWindow/);
  assert.match(app, /data-output-chart/);
  assert.match(app, /o\.history/);
  assert.doesNotMatch(app, /monitorHistory\.push/);
  assert.match(html, /<option value="86400">24 小时<\/option>/);
  assert.match(html, /<option value="259200">3 天<\/option>/);
  assert.doesNotMatch(html, /服务重启后当前会话历史会重新累计/);
});

test('output monitoring navigation and headings use consistent terminology', () => {
  assert.match(html, /<nav[^>]+id="nav"[\s\S]*?<button data-view="monitor">[\s\S]*?<span>输出监测<\/span><\/button>/);
  assert.match(html, /<button data-view="monitor" class="jump">打开输出监测<\/button>/);
  assert.match(html, /id="view-monitor"[\s\S]*?<h1>输出监测<\/h1>/);
  assert.match(html, /id="monitorDetailTitle">输出监测详情<\/h2>/);
  assert.match(app, /输出监测详情：\$\{outputName\}/);
});

test('push status description explains current and cumulative metric semantics', () => {
  const monitorView = html.match(/<section class="view" id="view-monitor">[\s\S]*?<div class="panel monitor-toolbar">/);
  assert.ok(monitorView, 'push status view should exist');
  assert.match(monitorView[0], /TCP.*确认|确认.*TCP/);
  assert.match(monitorView[0], /实际输出码率/);
  assert.match(monitorView[0], /本次推流开始以来/);
  assert.match(monitorView[0], /估算网络丢帧数/);
  assert.match(monitorView[0], /估算网络丢帧率/);
  assert.doesNotMatch(monitorView[0], /视频卡顿/);
  assert.doesNotMatch(monitorView[0], /30 秒|30秒|最近窗口/);
});

test('monitor cards and details prefer cumulative network-loss metrics', () => {
  assert.match(app, /formatEstimatedNetworkDropCount\(o\)/);
  assert.match(app, /formatEstimatedNetworkDropRate\(o\)/);
  assert.match(app, /formatEstimatedNetworkDropCount\(output\)/);
  assert.match(app, /formatEstimatedNetworkDropRate\(output\)/);
  assert.doesNotMatch(app, /recentDroppedFrames \?\?/);
  assert.doesNotMatch(app, /recentDropRatePercent \?\?/);
  assert.match(app, /<span>估算网络丢帧数<\/span>/);
  assert.match(app, /<span>估算网络丢帧率<\/span>/);
  assert.match(app, /\['估算网络丢帧数', dropCountText\]/);
  assert.match(app, /\['估算网络丢帧率', dropRateText\]/);
  assert.match(app, /<span>运行时长<\/span>/);
});

test('monitor view contains an accessible per-output detail dialog and exact time controls', () => {
  assert.match(html, /<dialog[^>]+id="monitorDetailDialog"/);
  assert.match(html, /aria-labelledby="monitorDetailTitle"/);
  assert.match(html, /id="monitorDetailRangePreset"/);
  assert.match(html, /id="monitorDetailFrom"[^>]+type="datetime-local"/);
  assert.match(html, /id="monitorDetailTo"[^>]+type="datetime-local"/);
  assert.match(html, /id="queryMonitorDetailBtn"/);
  assert.match(html, /id="monitorDetailLiveBtn"/);
  assert.match(app, /data-monitor-detail/);
  assert.match(app, /function openMonitorDetail/);
});

test('monitor detail queries one output with rolling or exact time parameters', () => {
  assert.match(app, /let monitorDetailState/);
  assert.match(app, /function monitorDetailQuery/);
  assert.match(app, /outputId/);
  assert.match(app, /params\.set\('from'/);
  assert.match(app, /params\.set\('to'/);
  assert.match(app, /function applyMonitorDetailPeriod/);
  assert.match(app, /结束时间不能早于开始时间/);
  assert.match(app, /function returnMonitorDetailToLive/);
});

test('monitor range preset change triggers an immediate reload', () => {
  assert.match(app, /function handleMonitorRangePresetChange\(\{ load = true \} = \{\}\)[\s\S]{0,260}if \(load && preset !== 'custom'\) applyMonitorRange\(\)/);
  assert.match(app, /handleMonitorRangePresetChange\(\{ load: false \}\)/);
  assert.match(app, /monitorRangePreset'\)\.addEventListener\('change', handleMonitorRangePresetChange\)/);
});

test('dangerous room and pipeline operations require confirmation before API calls', () => {
  assert.match(app, /function confirmDangerousAction/);
  assert.match(app, /confirmDangerousAction\(`确认\$\{enabled \? '启用' : '禁用'\}直播间/);
  assert.match(app, /confirmDangerousAction\('确认开始这个分发任务/);
  assert.match(app, /confirmDangerousAction\('确认停止这个分发任务/);
});

test('pipeline destinations use explicit picker and selected output list', () => {
  const pipelineForm = formMarkup('pipelineForm');
  assert.doesNotMatch(pipelineForm, /<select[^>]+id="pipelineDestinations"[^>]+multiple/);
  assert.match(pipelineForm, /id="destinationPicker"/);
  assert.match(pipelineForm, /id="addDestinationBtn"/);
  assert.match(pipelineForm, /id="selectedDestinationList"/);

  assert.match(app, /let selectedDestinationIds = \[\]/);
  assert.match(app, /function renderDestinationPicker/);
  assert.match(app, /function renderSelectedDestinations/);
  assert.match(app, /function addSelectedDestination/);
  assert.match(app, /function removeSelectedDestination/);
  assert.match(app, /function setSelectedDestinationIds/);
  assert.match(app, /destinationIds: selectedDestinationIds/);
});

test('output target management lives on a dedicated signal-routing page', () => {
  assert.ok(html.indexOf('data-view="distribution"') < html.indexOf('data-view="rooms"'));
  assert.ok(html.indexOf('data-view="rooms"') < html.indexOf('data-view="destinations"'));

  const destinationsView = html.match(/<section class="view" id="view-destinations">[\s\S]*?<\/section>/);
  assert.ok(destinationsView, 'destination view should exist');
  assert.match(destinationsView[0], /id="destinationForm"/);
  assert.match(destinationsView[0], /id="destinationCards"/);

  const distributionView = html.match(/<section class="view" id="view-distribution">[\s\S]*?<\/section>/);
  assert.ok(distributionView, 'distribution view should exist');
  assert.doesNotMatch(distributionView[0], /id="destinationForm"/);
  assert.doesNotMatch(distributionView[0], /id="destinationCards"/);
  assert.match(distributionView[0], /id="destinationPicker"/);
  assert.match(distributionView[0], /id="selectedDestinationList"/);
});

test('push platform cards expose edit actions and the destination form has edit state', () => {
  assert.match(html, /id="cancelDestinationEditBtn"/);
  assert.match(app, /let editingDestinationId/);
  assert.match(app, /function editDestination/);
  assert.match(app, /function resetDestinationForm/);
  assert.match(app, /data-action="edit-destination"/);
  assert.match(app, /editingDestinationId \? `\/api\/destinations\/\$\{editingDestinationId\}` : '\/api\/destinations'/);
  assert.match(app, /method: editingDestinationId \? 'PUT' : 'POST'/);
  assert.match(app, /destinationPayloadFromForm\(event\.target, existingDestination\)/);
  assert.match(app, /existingDestination \? existingDestination\.enabled !== false : true/);
});

test('monitor polling does not rerender the distribution form destination picker', () => {
  assert.match(app, /function renderPipelineCards/);
  assert.match(app, /function renderPipelineFormOptions/);
  assert.match(app, /setInterval\([\s\S]*renderPipelineCards\(\)/);
  assert.doesNotMatch(app, /setInterval\([\s\S]*renderPipelines\(\)/);
});

test('live monitor merge preserves history by output id and rolling bound', () => {
  const merge = appFunction('mergeLiveMonitorSnapshot');
  const previous = {
    outputs: [
      { id: 'out-a', history: [{ time: 1000, bitrateKbps: 15000, fps: 60 }] },
      { id: 'out-b', history: [{ time: 1000, bitrateKbps: 7000, fps: 60 }] },
    ],
    range: { rangeSec: 2, from: 1000, to: 3000 },
  };
  const live = {
    outputs: [
      { id: 'out-a', bitrateKbps: 15100, actualBitrateAvailable: true, actualBitrateStatus: 'available', fps: 60 },
      { id: 'out-b', bitrateKbps: 6900, actualBitrateAvailable: true, actualBitrateStatus: 'available', fps: 60 },
    ],
    range: { now: 3000, rangeSec: 0 },
  };

  const merged = merge(previous, live, 2);

  assert.deepEqual(merged.outputs[0].history.map(point => point.bitrateKbps), [15000, 15100]);
  assert.deepEqual(merged.outputs[1].history.map(point => point.bitrateKbps), [7000, 6900]);
  assert.equal(merged.outputs[0].history.some(point => point.bitrateKbps === 6900), false);
  assert.equal(merged.outputs[1].history.some(point => point.bitrateKbps === 15100), false);
});

test('live monitor merge preserves unavailable actual bitrate as a chart gap', () => {
  const merge = appFunction('mergeLiveMonitorSnapshot');
  const merged = merge({
    outputs: [{
      id: 'out-a',
      history: [{ time: 1000, bitrateKbps: 15000, actualBitrateAvailable: true, actualBitrateStatus: 'available', fps: 60 }],
    }],
    range: { rangeSec: 2, from: 1000, to: 3000 },
  }, {
    outputs: [{ id: 'out-a', bitrateKbps: null, actualBitrateAvailable: false, actualBitrateStatus: 'sampling', fps: 60 }],
    range: { now: 3000, rangeSec: 0 },
  }, 2);

  assert.deepEqual(merged.outputs[0].history.map(point => point.bitrateKbps), [15000, null]);
  assert.equal(merged.outputs[0].history.at(-1).actualBitrateAvailable, false);
  assert.equal(merged.outputs[0].history.at(-1).actualBitrateStatus, 'sampling');
});

test('monitor chart breaks actual bitrate lines across unavailable samples', () => {
  const drawChartSeries = appFunction('drawChartSeries');
  const calls = [];
  const ctx = {
    beginPath() { calls.push('beginPath'); },
    moveTo() { calls.push('moveTo'); },
    lineTo() { calls.push('lineTo'); },
    stroke() { calls.push('stroke'); },
  };
  drawChartSeries(
    ctx,
    [{ time: 0, value: 100 }, { time: 1000, value: null }, { time: 2000, value: 200 }],
    { left: 0, top: 0, width: 200, height: 100 },
    { start: 0, end: 2000 },
    { max: 200 },
    point => point.value,
    '#2388ff',
  );

  assert.equal(calls.filter(call => call === 'moveTo').length, 2);
  assert.equal(calls.filter(call => call === 'lineTo').length, 0);
});

test('monitor polling uses one current-only request and skips exact detail', () => {
  const timerStart = app.indexOf('setInterval(async () =>');
  const timerEnd = app.indexOf('}, 2000);', timerStart);
  const timer = app.slice(timerStart, timerEnd);

  assert.match(app, /let monitorPollPending = false/);
  assert.match(timer, /if \(monitorPollPending\) return/);
  assert.match(timer, /\/api\/monitor\?history=none/);
  assert.match(timer, /finally\s*\{[\s\S]*monitorPollPending = false/);
  assert.match(timer, /monitorDetailState\.mode !== 'exact'/);
  assert.doesNotMatch(timer, /loadMonitorDetail\(\{ silent: true \}\)/);
});

test('monitor initialization avoids duplicate history-bearing state loads', () => {
  assert.match(app, /async function loadState\(\)[\s\S]{0,180}\/api\/state\?history=none/);
  assert.match(app, /handleMonitorRangePresetChange\(\{ load: false \}\)/);
  assert.match(app, /async function loadMonitorHistory\(\)[\s\S]{0,260}monitorQuery\(mode\)/);
  assert.match(app, /params\.set\('history', historyMode\)/);
});

test('monitor fps display prefers current fps before legacy measured fps', () => {
  const displayFpsValue = appFunction('displayFpsValue');

  assert.equal(displayFpsValue({ fps: 60, recentMeasuredFps: 8000 }, 59.94), '59.94');
  assert.equal(displayFpsValue({ fps: 50, recentMeasuredFps: 12 }, 50), '50.0');
  assert.equal(displayFpsValue({ fps: 0, recentMeasuredFps: 8000 }, 59.94), '0');
  assert.equal(displayFpsValue({ recentMeasuredFps: 29.97 }, 0), '30.0');
});

test('monitor chart points prefer fps before legacy measured fps', () => {
  const pointFps = appFunction('pointFps');

  assert.equal(pointFps({ fps: 59.94, measuredFps: 8000 }), 59.94);
  assert.equal(pointFps({ fps: 0, measuredFps: 8000 }), 0);
  assert.equal(pointFps({ measuredFps: 29.97 }), 29.97);
});

test('monitor cards and details display current fps without appending target fps', () => {
  assert.equal(app.includes('${displayFpsValue(o, targetFps)} / ${formatFpsValue(targetFps)}'), false);
  assert.equal(app.includes('${displayFpsValue(output, targetFps)} / ${formatFpsValue(targetFps)}'), false);
  assert.doesNotMatch(app, /FPS（当前\/目标）/);
});

test('monitor hides standalone UDP warnings while retaining network-loss UI', () => {
  assert.match(app, /实际输出码率/);
  assert.match(app, /实际输出码率 Kbps/);
  assert.match(app, /<span>FPS<\/span>/);
  assert.match(app, /\['FPS', fpsText\]/);
  assert.doesNotMatch(app, /推流码率|实际码率|送达 FPS/);
  assert.doesNotMatch(app, /UDP 缓冲溢出/);
  assert.match(app, /实际发送低于固定码率/);
  assert.match(app, /带宽不足或传输丢包/);
  assert.match(app, /估算网络丢帧数/);
  assert.match(app, /估算网络丢帧率/);
  assert.match(app, /编码性能不足/);
  assert.match(app, /encoderSpeed > 0 && encoderSpeed < 0\.98/);
  assert.match(css, /\.warning\s*\{[^}]*color:var\(--warn\)/);
  assert.match(css, /\.monitor-detail-metrics\s*\{[^}]*repeat\(auto-fit,minmax\(130px,1fr\)\)/);
});

test('monitor contains no video-stall product metric or warning', () => {
  const combined = `${html}\n${app}`;
  assert.doesNotMatch(combined, /视频卡顿/);
  for (const removed of [
    'videoStallDelta',
    'videoStallFrames',
    'videoStallRatePercent',
    'recentVideoStallFrames',
    'recentVideoStallRatePercent',
  ]) {
    assert.equal(app.includes(removed), false, `app still contains ${removed}`);
  }
  assert.match(app, /估算网络丢帧数/);
  assert.match(app, /估算网络丢帧率/);
  assert.match(app, /重置.*网络丢帧/);
  assert.match(app, /encoderSpeed > 0 && encoderSpeed < 0\.98/);
});

test('distribution form exposes ordered multi-watermark and slideshow controls', () => {
  const pipelineForm = formMarkup('pipelineForm');
  assert.match(pipelineForm, /id="watermarkFile"[^>]+type="file"[^>]+multiple/);
  assert.match(pipelineForm, /id="uploadWatermarkBtn"/);
  assert.match(pipelineForm, /id="watermarkList"/);
  assert.match(pipelineForm, /id="slideshowFile"[^>]+type="file"[^>]+multiple/);
  assert.match(pipelineForm, /id="uploadSlideshowBtn"/);
  assert.match(pipelineForm, /id="slideshowList"/);
  assert.match(pipelineForm, /id="slideshowIntervalMs"[^>]+value="2000"/);
  assert.match(pipelineForm, /id="slideshowTransitionMs"[^>]+value="700"/);
  assert.match(app, /let pipelineWatermarks = \[\]/);
  assert.match(app, /let pipelineSlideshow = \{/);
  assert.match(app, /function uploadOverlayFiles/);
  assert.match(app, /watermarks: pipelineWatermarks/);
  assert.match(app, /slideshow: \{/);
  assert.match(app, /\/api\/watermarks/);
  assert.match(app, /data-overlay-kind="\$\{escapeHtml\(/);
  assert.match(app, /data-overlay-action="(?:up|down|remove)"/);
  assert.match(app, /bindOverlayActions/);
  assert.match(css, /\.overlay-list/);
  assert.match(pipelineForm, /全画面/);
  assert.match(pipelineForm, /幻灯片放映/);
  assert.doesNotMatch(app, /let pipelineWatermark = null/);
});

test('brand image is used for the sidebar mark and favicon', () => {
  const logoPath = path.join(root, 'app', 'assets', 'streamhub-logo.png');
  assert.equal(fs.existsSync(logoPath), true);
  const signature = fs.readFileSync(logoPath).subarray(0, 8);
  assert.deepEqual([...signature], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  assert.match(html, /<link rel="icon" type="image\/png" href="\/assets\/streamhub-logo\.png">/);
  assert.match(html, /class="brand-mark"[^>]+src="\/assets\/streamhub-logo\.png"/);
  assert.match(html, /alt="StreamHub"/);
  assert.match(server, /'\.png': 'image\/png'/);
});

test('static application assets disable caching and version the main script', () => {
  const staticHandler = server.slice(server.indexOf('function serveStatic'), server.indexOf('function collectionFor'));
  assert.match(staticHandler, /'cache-control': 'no-store'/);
  assert.match(html, /<script src="\/app\.js\?v=[a-z0-9.-]+"><\/script>/i);
});

test('bitrate shortfall warning begins at thirty percent in overview and detail', () => {
  assert.match(app, /const BITRATE_SHORTFALL_WARNING_PERCENT = 30/);
  assert.equal((app.match(/transportShortfallPercent >= BITRATE_SHORTFALL_WARNING_PERCENT/g) || []).length, 2);
});

test('monitor detail exposes a server-persisted dropped-frame reset action', () => {
  assert.match(html, /id="resetMonitorDropsBtn"/);
  assert.match(html, /id="monitorDropResetInfo"/);
  assert.match(app, /async function resetMonitorDrops/);
  assert.match(app, /\/api\/monitor\/outputs\/\$\{encodeURIComponent\(monitorDetailState\.outputId\)\}\/reset-drops/);
  assert.match(app, /resetMonitorDropsBtn'\)\.addEventListener\('click', resetMonitorDrops\)/);
  assert.match(app, /dropDisplayResetAt/);
  assert.match(app, /网络丢帧展示统计/);
  assert.match(app, /原始监控历史不会删除/);
});

test('disabled outputs have a dedicated monitor state label', () => {
  assert.match(app, /status === 'disabled'/);
});

test('pipeline save and start guard against missing or disabled output targets', () => {
  const submitStart = app.indexOf("$('#pipelineForm').addEventListener('submit'");
  const submitEnd = app.indexOf("$('#destinationForm').addEventListener('submit'", submitStart);
  const submitHandler = app.slice(submitStart, submitEnd);
  assert.match(submitHandler, /pipelineEnabledDestinations\(\{ destinationIds: selectedDestinationIds \}\)/);
  assert.ok(submitHandler.indexOf('pipelineEnabledDestinations') < submitHandler.indexOf('await api('));
  assert.match(submitHandler, /请至少添加一个已启用的推流平台/);

  const startHandler = appFunctionSource('startPipeline');
  assert.match(startHandler, /pipelineEnabledDestinations\(pipeline\)/);
  assert.ok(startHandler.indexOf('pipelineEnabledDestinations') < startHandler.indexOf('await api('));
  assert.match(startHandler, /这个分发任务没有启用的输出目标/);
});

test('distribution input controls provide an accessible preview dialog', () => {
  const pipelineForm = formMarkup('pipelineForm');
  assert.match(pipelineForm, /id="previewInputBtn"[^>]+type="button"/);
  assert.ok(pipelineForm.indexOf('id="previewInputBtn"') < pipelineForm.indexOf('class="destination-picker-box"'));
  assert.match(html, /<dialog[^>]+id="inputPreviewDialog"[^>]+aria-labelledby="inputPreviewTitle"/);
  assert.match(html, /id="inputPreviewImage"/);
  assert.match(html, /id="inputPreviewStatus"[^>]+role="status"/);
  assert.match(html, /id="retryInputPreviewBtn"/);
  assert.match(css, /\.input-preview-frame\{[^}]*aspect-ratio:16\/9/);
});

test('input preview reuses the live form payload and releases its stream on close', () => {
  assert.match(app, /let inputPreviewState = \{ id: '', pipelineId: '', pollTimer: null, closing: false \}/);
  assert.match(app, /function buildPreviewRequest\(form\)\s*\{\s*return buildPipelineInput\(form\);\s*\}/);
  assert.match(app, /async function openInputPreview\(/);
  assert.match(app, /await api\('\/api\/previews', \{[\s\S]*method: 'POST'/);
  assert.match(app, /\/api\/previews\/\$\{encodeURIComponent\(preview\.id\)\}\/stream/);
  assert.match(app, /async function pollInputPreview\(/);
  assert.match(app, /async function releaseInputPreview\(/);
  assert.match(app, /\/api\/previews\/\$\{encodeURIComponent\(id\)\}\/stop/);
  assert.match(app, /inputPreviewDialog'\)\.addEventListener\('close'/);
  assert.match(app, /window\.addEventListener\('pagehide'/);
});

test('fallback pipelines show a Chinese active status and remain non-editable', () => {
  const context = appFunctions(['pipelineRuntimeStatus', 'pipelineStatusLabel'], {
    state: { monitor: { activePipelines: [{ pipelineId: 'pipe-a', status: 'fallback' }] } },
  });
  assert.equal(context.pipelineRuntimeStatus({ id: 'pipe-a', status: 'running' }), 'fallback');
  assert.equal(context.pipelineStatusLabel('fallback'), '黑屏回退中');
  assert.ok((app.match(/pipelineStatusLabel\(status\)/g) || []).length >= 2);
  assert.match(app, /\['running', 'starting', 'fallback', 'draining'\]\.includes\(pipelineRuntimeStatus\(pipeline\)\)/);
});

test('system status navigation follows push status and exposes performance regions', () => {
  assert.match(html, /data-view="monitor">推流状态<\/button>\s*<button data-view="system">系统状态<\/button>/);
  const view = html.match(/<section class="view" id="view-system">[\s\S]*?<\/section>\s*<section class="view" id="view-devices">/);
  assert.ok(view, 'system status view should exist before devices');
  assert.match(view[0], /id="systemResourceList"[^>]+role="tablist"/);
  assert.match(view[0], /id="systemDetailTitle"/);
  assert.match(view[0], /id="systemDetailChart"[^>]*><\/canvas>/);
  assert.match(view[0], /id="systemDetailMetrics"/);
  assert.match(view[0], /id="systemStatusMessage"[^>]+role="status"/);
});

test('system page keeps its navigation label and separates hardware and process status', () => {
  assert.match(html, /data-view="system">系统状态<\/button>/);
  const view = html.match(/<section class="view" id="view-system">[\s\S]*?<\/section>\s*<section class="view" id="view-devices">/);
  assert.ok(view, 'system view should exist');
  assert.match(view[0], /<h1>硬件状态<\/h1>/);
  assert.match(view[0], /id="processStatusSection"/);
  assert.match(view[0], /id="processSortCpu"[^>]+aria-pressed="true"/);
  assert.match(view[0], /id="processSortMemory"[^>]+aria-pressed="false"/);
  assert.match(view[0], /id="processStatusBody"/);
  assert.match(view[0], /id="processStatusMessage"[^>]+role="status"/);
  for (const label of ['名称', 'PID', '状态', 'CPU', '内存', '磁盘读取', '磁盘写入']) {
    assert.ok(view[0].includes(label), `process table should include ${label}`);
  }
});

test('system history is isolated by resource and bounded to thirty points', () => {
  const context = appFunctions(['systemResources', 'mergeSystemHistory'], {
    SYSTEM_HISTORY_LIMIT: 30,
  });
  let histories = {};
  for (let index = 0; index < 35; index += 1) {
    histories = context.mergeSystemHistory(histories, {
      sampledAt: new Date(index * 2000).toISOString(),
      cpu: { available: true, usagePercent: index },
      memory: { available: true, usagePercent: 70 + index / 10 },
      gpu: { available: true, devices: [{ id: 'gpu-0', index: 0, usagePercent: index / 2 }] },
    }, 30);
  }

  assert.equal(histories.cpu.length, 30);
  assert.equal(histories.cpu[0].value, 5);
  assert.equal(histories.memory.at(-1).value, 73.4);
  assert.equal(histories['gpu-0'].at(-1).value, 17);
});

test('system polling feeds global telemetry and guards against overlapping requests', () => {
  assert.match(app, /let systemStatusPollPending = false/);
  assert.match(app, /function systemStatusViewActive/);
  assert.match(app, /if \(!systemStatusViewActive\(\) \|\| systemStatusPollPending\) return/);
  assert.match(app, /api\('\/api\/system-status'\)/);
  assert.match(app, /function systemStatusViewActive\(\) \{\s*return authState\.authenticated;\s*\}/);
  assert.match(app, /setInterval\(\(\) => \{\s*if \(authState\.authenticated\) loadSystemStatus\(\{ silent: true \}\);\s*\}, 1000\)/);
});

test('system status has task-manager-style responsive resource layout', () => {
  assert.match(css, /\.system-status-workspace\{[^}]*grid-template-columns:minmax\(220px,280px\) minmax\(0,1fr\)/);
  assert.match(css, /\.system-resource-button\{[^}]*grid-template-columns:minmax\(0,1fr\) 112px/);
  assert.match(css, /\.system-mini-chart\{[^}]*height:54px[^}]*width:112px/);
  assert.match(css, /\.system-detail-chart-wrap canvas\{[^}]*height:360px[^}]*width:100%/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.system-resource-list\{[^}]*grid-auto-flow:column[^}]*overflow-x:auto/);
});

test('system status renders selectors details and unavailable GPU state', () => {
  for (const name of [
    'renderSystemStatus',
    'renderSystemResourceList',
    'renderSystemDetail',
    'drawSystemChart',
    'loadSystemStatus',
  ]) {
    assert.notEqual(app.indexOf(`function ${name}`), -1, `${name} should exist`);
  }
  assert.match(app, /data-system-resource/);
  assert.match(app, /未检测到可用的 NVIDIA GPU/);
  assert.match(app, /最后更新/);
  for (const label of ['逻辑处理器', '系统负载', '已使用', '可用', '显存', '温度', '编码器', '解码器']) {
    assert.ok(app.includes(label), `system details should include ${label}`);
  }
});

test('system resource polling keeps existing tab nodes when resource ids are unchanged', () => {
  assert.match(app, /resourceSignature: ''/);
  const renderer = appFunctionSource('renderSystemResourceList');
  assert.match(renderer, /const signature = resources\.map\(resource => resource\.id\)\.join\('\|'\)/);
  assert.match(renderer, /if \(signature !== systemStatusState\.resourceSignature\)/);
  assert.match(renderer, /systemStatusState\.resourceSignature = signature/);
  assert.match(renderer, /button\.querySelector\('\.system-resource-summary'\)\.textContent/);
});

test('memory resource summary keeps capacity and percentage visible in a narrow rail', () => {
  const context = appFunctions([
    'systemResourceAvailable',
    'formatSystemPercent',
    'formatSystemBytes',
    'formatSystemClock',
    'formatSystemResourceSummary',
  ]);
  assert.equal(context.formatSystemResourceSummary({
    id: 'memory',
    type: 'memory',
    data: { available: true, usedBytes: 14.6 * 1024 ** 3, totalBytes: 15.7 * 1024 ** 3 },
    value: 93,
  }), '14.6 / 15.7 GB (93%)');
});

test('hardware resources place disks and active networks before GPUs', () => {
  const context = appFunctions(['systemResources']);
  const resources = context.systemResources({
    cpu: { available: true, usagePercent: 20 },
    memory: { available: true, usagePercent: 40 },
    disk: {
      available: true,
      devices: [{ id: 'disk-259-2', name: 'KINGSTON', activityPercent: 10 }],
    },
    network: {
      available: true,
      interfaces: [{ id: 'network-eno1', name: 'eno1', totalBytesPerSec: 2048 }],
    },
    gpu: {
      available: true,
      devices: [{ id: 'gpu-0', index: 0, name: 'RTX', usagePercent: 5 }],
    },
  });

  assert.deepEqual(Array.from(resources, resource => resource.id), [
    'cpu', 'memory', 'disk-259-2', 'network-eno1', 'gpu-0',
  ]);
  assert.deepEqual(Array.from(resources, resource => resource.type), [
    'cpu', 'memory', 'disk', 'network', 'gpu',
  ]);
  assert.equal(resources[2].label, '磁盘 0');
  assert.equal(resources[3].label, '网卡 eno1');
  assert.equal(resources[3].chartMode, 'throughput');
});

test('hardware resource fallbacks remain selectable when Linux metrics are unavailable', () => {
  const context = appFunctions(['systemResources']);
  const resources = context.systemResources({
    cpu: { available: true },
    memory: { available: true },
    disk: { available: false, message: '磁盘状态读取失败', devices: [] },
    network: { available: false, message: '网卡状态读取失败', interfaces: [] },
    gpu: { available: false, message: 'GPU 状态读取失败', devices: [] },
  });

  assert.deepEqual(Array.from(resources, resource => resource.id), [
    'cpu', 'memory', 'disk-unavailable', 'network-unavailable', 'gpu-unavailable',
  ]);
});

test('system rates and network chart scale use readable dynamic units', () => {
  const context = appFunctions(['formatSystemRate', 'formatSystemNetworkRate', 'systemChartMax']);
  assert.equal(context.formatSystemRate(null), '采样中');
  assert.equal(context.formatSystemRate(1536), '1.5 KB/s');
  assert.equal(context.formatSystemRate(2.5 * 1024 ** 2), '2.5 MB/s');
  assert.equal(context.formatSystemNetworkRate(null), '采样中');
  assert.equal(context.formatSystemNetworkRate(0), '0 Kbps');
  assert.equal(context.formatSystemNetworkRate(8000), '64.0 Kbps');
  assert.equal(context.formatSystemNetworkRate(1_000_000), '8.0 Mbps');
  assert.equal(context.formatSystemNetworkRate(125_000_000), '1.0 Gbps');
  assert.equal(context.systemChartMax({ chartMode: 'percent' }, [{ value: 20 }]), 100);
  assert.equal(context.systemChartMax({ chartMode: 'throughput' }, [{ value: 1536 }]), 2048);
});

test('network summaries details and chart labels use bit rates', () => {
  assert.match(appFunctionSource('formatSystemResourceSummary'), /formatSystemNetworkRate\(data\.receiveBytesPerSec\)/);
  assert.match(appFunctionSource('formatSystemResourceSummary'), /formatSystemNetworkRate\(data\.sendBytesPerSec\)/);
  assert.match(appFunctionSource('systemDetailRows'), /formatSystemNetworkRate\(data\.totalBytesPerSec\)/);
  assert.match(appFunctionSource('systemPrimaryValue'), /formatSystemNetworkRate\(resource\.value\)/);
  assert.match(appFunctionSource('renderSystemDetail'), /formatSystemNetworkRate\(maxValue, '--'\)/);
});

test('process status defaults to CPU and selects the server-ranked top ten', () => {
  assert.match(app, /processSort: 'cpu'/);
  const context = appFunctions(['selectSystemProcesses']);
  const byCpu = Array.from({ length: 12 }, (_, index) => ({ pid: index, name: `cpu-${index}` }));
  const byMemory = Array.from({ length: 12 }, (_, index) => ({ pid: index, name: `memory-${index}` }));
  const snapshot = { processes: { available: true, byCpu, byMemory } };

  assert.deepEqual(
    Array.from(context.selectSystemProcesses(snapshot, 'cpu'), process => process.name),
    byCpu.slice(0, 10).map(process => process.name),
  );
  assert.deepEqual(
    Array.from(context.selectSystemProcesses(snapshot, 'memory'), process => process.name),
    byMemory.slice(0, 10).map(process => process.name),
  );
});

test('process renderer is read-only and sort controls do not refetch status', () => {
  for (const name of ['renderProcessStatus', 'formatProcessState', 'selectSystemProcesses']) {
    assert.notEqual(app.indexOf(`function ${name}`), -1, `${name} should exist`);
  }
  const renderer = appFunctionSource('renderProcessStatus');
  assert.match(renderer, /escapeHtml\(process\.name\)/);
  assert.doesNotMatch(renderer, /commandLine|arguments|environment|destination/);
  assert.match(app, /\$\$\('\[data-process-sort\]'\)\.forEach/);
  assert.match(app, /systemStatusState\.processSort = button\.dataset\.processSort/);
  assert.doesNotMatch(app, /data-process-sort[\s\S]{0,240}loadSystemStatus/);
});

test('process status table is dense responsive and internally scrollable', () => {
  assert.match(css, /\.process-status-section\{[^}]*border-top:1px solid var\(--line\)/);
  assert.match(css, /\.process-status-head\{[^}]*display:flex[^}]*justify-content:space-between/);
  assert.match(css, /\.process-sort-control\{[^}]*display:grid[^}]*grid-template-columns:repeat\(2,minmax\(72px,1fr\)\)/);
  assert.match(css, /\.process-status-table-wrap\{[^}]*max-width:100%[^}]*overflow-x:auto/);
  assert.match(css, /\.process-status-table\{[^}]*min-width:860px[^}]*width:100%/);
  assert.match(css, /\.process-number\{[^}]*font-variant-numeric:tabular-nums[^}]*text-align:right/);
  assert.match(css, /@media\(max-width:760px\)[\s\S]*\.process-status-head\{[^}]*align-items:stretch[^}]*flex-direction:column/);
});
