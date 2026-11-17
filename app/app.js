const $ = selector => document.querySelector(selector);
const $$ = selector => Array.from(document.querySelectorAll(selector));

const THEME_STORAGE_KEY = 'streamhub-console-theme';
const VIEW_META = {
  dashboard: { title: '总览', kicker: 'CONTROL CENTER' },
  distribution: { title: '推流分发', kicker: 'OUTPUT ORCHESTRATION' },
  rooms: { title: '本地直播间', kicker: 'LOCAL INGEST' },
  scenes: { title: '场景编排', kicker: 'SCENE COMPOSER' },
  destinations: { title: '推流目标', kicker: 'DESTINATION ROUTING' },
  monitor: { title: '输出监测', kicker: 'OUTPUT TELEMETRY' },
  devices: { title: '采集设备', kicker: 'CAPTURE HARDWARE' },
  logs: { title: '日志', kicker: 'SYSTEM EVENTS' },
  settings: { title: '设置', kicker: 'SYSTEM CONFIGURATION' },
};

const PARAMETER_HELP = Object.freeze({
  videoEncoder: {
    title: '视频编码器',
    description: '决定由 CPU、NVIDIA GPU 或其他硬件完成压缩。copy 不重新编码，只适用于格式已经符合输出要求的网络流。',
    recommendation: '采集卡和画面叠加优先使用 NVIDIA NVENC；纯 RTMP 转推且无需处理时使用自动选择。',
  },
  rateControl: {
    title: '码率控制',
    description: '决定编码器如何分配码率。CBR 稳定占用带宽；VBR 会随画面复杂度变化；CRF 以画质为目标，带宽不可预测。',
    recommendation: '直播推流使用 CBR；本地录制或带宽宽裕时再考虑 VBR / CRF。',
  },
  bitrateKbps: {
    title: '目标码率',
    description: '视频平均每秒传输的数据量。码率越高通常越清晰，同时占用更多上行带宽。',
    recommendation: '1080p50/60 建议 8,000–15,000 Kbps；1080p25/30 建议 6,000–10,000；720p 建议 3,500–6,000。',
  },
  maxBitrateKbps: {
    title: '峰值码率',
    description: 'VBR 或恒定质量模式允许达到的瞬时上限。CBR 模式通常与目标码率相同。',
    recommendation: 'CBR：与目标码率一致；VBR：设置为目标码率的 1.2–1.5 倍。',
  },
  bufferSizeKbps: {
    title: '码率缓冲区',
    description: '控制编码器短时间内平滑码率波动的范围。数值过小容易影响画质，过大则可能增加延迟。',
    recommendation: '低延迟直播一般设置为目标码率的 2 倍，例如 15,000 Kbps 对应 30,000 Kbits。',
  },
  crf: {
    title: 'CRF 质量值',
    description: '数值越小画质越高、文件或码率越大。该模式不保证固定带宽。',
    recommendation: 'x264 通常使用 18–23；NVENC 恒定质量通常从 20–24 开始测试。',
  },
  profile: {
    title: '编码档 Profile',
    description: '定义 H.264 可使用的压缩特性。档位越高压缩效率越好，但老旧设备兼容性可能下降。',
    recommendation: '现代直播平台使用 High；仅兼容非常老的播放器时使用 Main 或 Baseline。',
  },
  level: {
    title: '编码 Level',
    description: '限制分辨率、帧率和码率上限。设置过低会导致编码器拒绝当前组合。',
    recommendation: '优先选择自动；需要固定规范时，1080p60 通常使用 4.2，1080p30 通常使用 4.1。',
  },
  preset: {
    title: 'Preset',
    description: '控制编码速度、GPU/CPU 占用和压缩效率。更慢的预设通常画质更好，但资源占用更高。',
    recommendation: 'NVENC 从 p4 开始，资源宽裕可用 p5；x264 直播通常使用 veryfast。',
  },
  tune: {
    title: 'Tune',
    description: '针对低延迟、画质或特定内容调整编码器行为。低延迟模式会减少缓存和部分前向分析。',
    recommendation: '实时导播使用 LL 低延迟；更重视画质且允许额外延迟时使用 HQ。',
  },
  multipass: {
    title: '多次编码',
    description: '让编码器额外分析画面后再分配码率，可提升复杂场景质量，但会增加 GPU 占用和延迟。',
    recommendation: '低延迟直播使用单次编码；GPU 余量充足时可使用 1/4 分辨率二次编码。',
  },
  keyframeSec: {
    title: 'GOP 关键帧间隔',
    description: '两个关键帧之间的时间。间隔越短，平台切流和恢复越快，但压缩效率略低。',
    recommendation: '绝大多数直播平台使用 2 秒；没有平台明确要求时不要超过 4 秒。',
  },
  bFrames: {
    title: 'B 帧数',
    description: 'B 帧可提高压缩效率，但需要参考前后画面，会增加少量编码和播放延迟。',
    recommendation: '普通直播使用 2；超低延迟使用 0；画质优先可测试 3–4。',
  },
  referenceFrames: {
    title: '参考帧数',
    description: '编码器分析多少个历史画面来提高压缩效率。数值越高，显存和解码复杂度越高。',
    recommendation: '直播通常使用 2–3；低延迟或兼容性优先时使用 1–2。NVENC 在 1080p59.94/60、Level 4.2 下会自动限制为 2。',
  },
  lookahead: {
    title: '前向考虑',
    description: '编码器提前分析后续画面，动态调整 B 帧和码率分配，可改善复杂运动画面。',
    recommendation: '低延迟直播关闭；体育或高运动内容在 GPU 余量充足时开启。',
  },
  adaptiveQuantization: {
    title: '自适应量化',
    description: '把更多码率分配给纹理、边缘和视觉上更重要的区域，通常能提升主观画质。',
    recommendation: '一般保持开启；只有排查编码器兼容问题时才关闭。',
  },
  aqStrength: {
    title: 'AQ 强度',
    description: '控制自适应量化对画面区域的调整力度。过高可能让局部细节显得不均衡。',
    recommendation: 'NVENC 从 8 开始；画面复杂时可在 6–10 范围内微调。',
  },
  sceneDetection: {
    title: '场景检测',
    description: '检测镜头切换并在合适位置插入关键帧，改善快速切换后的画质恢复。',
    recommendation: '一般开启；需要严格固定 GOP 的特殊传输链路可关闭。',
  },
  pixelFormat: {
    title: '输出像素格式',
    description: '决定色度采样和位深。格式越高级，兼容性要求和带宽通常越高。',
    recommendation: '通用直播使用 yuv420p；10-bit HDR 链路使用 p010le，并确认平台完整支持。',
  },
  colorRange: {
    title: '色彩范围',
    description: 'TV/Limited 使用广播视频范围，PC/Full 使用完整数字范围。两端不匹配会导致画面发灰或黑位压死。',
    recommendation: '直播和广播链路使用 Limited / TV；明确为全范围电脑画面时才使用 Full / PC。',
  },
  repeatHeaders: {
    title: '关键帧重发 SPS/PPS',
    description: '在每个关键帧重新发送解码参数，便于播放器中途加入或断线后快速恢复。',
    recommendation: 'RTMP、MPEG-TS 和长时间直播保持开启。',
  },
  customOptions: {
    title: '编码器自定义参数',
    description: '直接追加受限制的 FFmpeg 编码器选项。错误参数可能导致任务无法启动。',
    recommendation: '通常留空；仅在明确查阅当前编码器文档并完成测试后填写。',
  },
});

function currentTheme() {
  return $('#consoleApp')?.dataset.theme === 'night' ? 'night' : 'day';
}

function themeColor(name, fallback) {
  const app = $('#consoleApp');
  if (!app) return fallback;
  const value = getComputedStyle(app).getPropertyValue(name).trim();
  return value || fallback;
}

function redrawThemeCharts() {
  if (!state) return;
  renderDashboardResources();
  if (state.monitor) renderMonitor(state.monitor);
  if ($('#monitorDetailDialog')?.open && monitorDetailState.lastOutput) {
    renderMonitorDetail(monitorDetailState.lastOutput, monitorDetailState.lastRange || {});
  }
}

function applyTheme(theme, persist = false) {
  const nextTheme = theme === 'night' ? 'night' : 'day';
  const app = $('#consoleApp');
  const toggle = $('#themeToggle');
  if (!app) return;
  app.dataset.theme = nextTheme;
  if (persist) {
    try { localStorage.setItem(THEME_STORAGE_KEY, nextTheme); } catch { /* storage may be unavailable */ }
  }
  if (toggle) {
    const isNight = nextTheme === 'night';
    toggle.setAttribute('aria-pressed', String(isNight));
    toggle.setAttribute('aria-label', isNight ? '切换到白天模式' : '切换到夜间模式');
    toggle.title = isNight ? '切换到白天模式' : '切换到夜间模式';
  }
  redrawThemeCharts();
}

function initializeTheme() {
  let savedTheme = 'day';
  try {
    savedTheme = localStorage.getItem(THEME_STORAGE_KEY) || 'day';
  } catch { /* use the requested daytime default */ }
  applyTheme(savedTheme);
}

let activeParameterHelpButton = null;

function parameterHelpIsOpen() {
  const popover = $('#parameterHelpPopover');
  return Boolean(popover && popover.matches(':popover-open'));
}

function positionParameterHelp(button) {
  const popover = $('#parameterHelpPopover');
  if (!popover || !button || !parameterHelpIsOpen()) return;
  const margin = 12;
  const gap = 8;
  const buttonRect = button.getBoundingClientRect();
  const popoverRect = popover.getBoundingClientRect();
  const maxLeft = Math.max(margin, window.innerWidth - popoverRect.width - margin);
  const left = Math.min(Math.max(margin, buttonRect.left), maxLeft);
  const roomBelow = window.innerHeight - buttonRect.bottom - margin;
  const top = roomBelow >= popoverRect.height + gap
    ? buttonRect.bottom + gap
    : Math.max(margin, buttonRect.top - popoverRect.height - gap);
  popover.style.left = `${Math.round(left)}px`;
  popover.style.top = `${Math.round(top)}px`;
}

function closeParameterHelp({ restoreFocus = false } = {}) {
  const popover = $('#parameterHelpPopover');
  const button = activeParameterHelpButton;
  if (popover && parameterHelpIsOpen()) popover.hidePopover();
  if (button) button.setAttribute('aria-expanded', 'false');
  activeParameterHelpButton = null;
  if (restoreFocus && button) button.focus();
}

function openParameterHelp(button) {
  const item = PARAMETER_HELP[button?.dataset.parameterHelp];
  const popover = $('#parameterHelpPopover');
  if (!item || !popover) return;

  $('#parameterHelpTitle').textContent = item.title;
  $('#parameterHelpDescription').textContent = item.description;
  $('#parameterHelpRecommendation').textContent = item.recommendation;
  if (activeParameterHelpButton && activeParameterHelpButton !== button) {
    activeParameterHelpButton.setAttribute('aria-expanded', 'false');
  }
  activeParameterHelpButton = button;
  button.setAttribute('aria-expanded', 'true');
  button.setAttribute('aria-controls', 'parameterHelpPopover');
  if (!parameterHelpIsOpen()) popover.showPopover();
  requestAnimationFrame(() => positionParameterHelp(button));
}

function initializeParameterHelp() {
  const popover = $('#parameterHelpPopover');
  if (!popover) return;
  $$('[data-parameter-help]').forEach(button => {
    button.setAttribute('aria-expanded', 'false');
    button.setAttribute('aria-controls', 'parameterHelpPopover');
    button.addEventListener('click', event => {
      event.preventDefault();
      event.stopPropagation();
      openParameterHelp(button);
    });
  });
  $('#closeParameterHelpBtn')?.addEventListener('click', () => closeParameterHelp({ restoreFocus: true }));
  popover.addEventListener('beforetoggle', event => {
    if (event.newState !== 'closed') return;
    activeParameterHelpButton?.setAttribute('aria-expanded', 'false');
    activeParameterHelpButton = null;
  });
  window.addEventListener('resize', () => closeParameterHelp());
  window.addEventListener('scroll', () => closeParameterHelp(), true);
}

let state = null;
let systemShutdownPending = false;
let systemShutdownAccepted = false;
let editingRoomId = null;
let editingPipelineId = null;
let editingDestinationId = null;
let selectedDestinationIds = [];
let pipelineFormGeneration = 0;
let pipelineSubmitPending = false;
let pipelineCardFilters = { status: 'all', query: '' };
const PIPELINE_SECTION_ORDER = ['basic', 'input', 'output', 'video', 'audio', 'processing', 'advanced'];
let activePipelineSection = 'basic';
let pipelineCardStructureSignature = '';
const pipelineCardMonitorState = {
  sessions: new Map(),
  visible: new Set(),
  observer: null,
  maxActive: 3,
};
let pendingLiveDelayStopPipelineId = null;
let pipelineWatermarks = [];
let pipelineNoSignalImage = null;
let pipelineSlideshow = {
  images: [], intervalMs: 2000, transitionMs: 700, loop: true,
};
let captureDeviceCache = null;
let captureDeviceLoadPromise = null;
const BITRATE_SHORTFALL_WARNING_PERCENT = 30;
const MAX_OVERLAY_IMAGES = 20;
const SYSTEM_HISTORY_LIMIT = 30;
const DASHBOARD_NETWORK_WINDOW_MS = 5 * 60_000;
let monitorRangeSec = 900;
let monitorPollPending = false;
let monitorHistoryRequestId = 0;
let monitorHistoryAbortController = null;
let systemStatusPollPending = false;
let monitorPollTimer = null;
let systemStatusPollTimer = null;
let encodingCapabilities = { checked: false, nvencAvailable: true, message: '', encoders: {} };
const authState = {
  authenticated: false,
  username: '',
  resolving: true,
  signingOut: false,
  loginPending: false,
};
let systemStatusState = {
  snapshot: null,
  selectedId: 'cpu',
  processSort: 'cpu',
  histories: {},
  error: '',
  lastUpdatedAt: 0,
  resourceSignature: '',
};
let dashboardNetworkHistory = [];
let monitorDetailState = {
  outputId: '',
  mode: 'rolling',
  rangeSec: 900,
  from: 0,
  to: 0,
  lastOutput: null,
  lastRange: null,
  loading: false,
};
let inputPreviewState = { id: '', pipelineId: '', pollTimer: null, closing: false };
let overlayLayoutState = {
  kind: '',
  selectedIndex: 0,
  editing: false,
  draftLayout: null,
  previewId: '',
  previewPollTimer: null,
  slideshowTimer: null,
  slideshowIndex: 0,
  closing: false,
  requestToken: 0,
  pointer: null,
  imageDimensions: new Map(),
};
let studioTab = 'scenes';
let selectedSceneId = '';
let sceneDraft = null;
let selectedMediaPreviewId = '';
let studioActionPending = false;
let mediaUploadCancel = null;
let mediaUploadCancelRequested = false;
let recordingCapacityRequestId = 0;
let recordingCapacityState = { pipelineId: '', data: null, loading: false, error: '' };
let logCatalog = new Map();
let studioSwitcherState = {
  pipelineId: '',
  sceneId: '',
  previewMode: 'scene',
  previousProgram: null,
  previewIndex: 0,
  previewPlaying: false,
  previewSessionId: '',
  programSessionId: '',
  busy: false,
};

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.error || `HTTP ${response.status}`);
    error.status = response.status;
    error.payload = payload;
    if (response.status === 401 && !path.startsWith('/api/auth/')) handleUnauthorized();
    throw error;
  }
  return payload;
}

function setUserMenuOpen(open) {
  const menu = $('#userMenu');
  const button = $('#userMenuButton');
  menu.hidden = !open;
  button.setAttribute('aria-expanded', String(open));
}

function detachInputPreview() {
  const id = inputPreviewState.id;
  inputPreviewState.id = '';
  inputPreviewState.pipelineId = '';
  inputPreviewState.closing = false;
  clearInputPreviewPoll();
  const image = $('#inputPreviewImage');
  const video = $('#inputPreviewVideo');
  video.pause();
  video.removeAttribute('src');
  video.hidden = true;
  image.removeAttribute('src');
  image.hidden = true;
  const dialog = $('#inputPreviewDialog');
  if (dialog.open) dialog.close();
  return id;
}

async function enterConsole(username) {
  authState.authenticated = true;
  authState.username = String(username || '');
  authState.resolving = false;
  $('#currentUsername').textContent = authState.username;
  $('#userMenu').hidden = true;
  $('#userMenuButton').setAttribute('aria-expanded', 'false');
  $('#loginView').hidden = true;
  $('#consoleApp').hidden = false;
  try {
    await loadState();
    if (typeof loadEncodingCapabilities === 'function') await loadEncodingCapabilities();
  } catch (error) {
    leaveConsole();
    throw error;
  }
  startPolling();
}

function leaveConsole() {
  if (!authState.authenticated && $('#consoleApp').hidden && !authState.resolving) return;
  authState.authenticated = false;
  authState.username = '';
  authState.resolving = false;
  state = null;
  monitorPollPending = false;
  monitorHistoryRequestId += 1;
  monitorHistoryAbortController?.abort();
  monitorHistoryAbortController = null;
  systemStatusPollPending = false;
  stopPolling();
  releaseAllPipelineCardMonitors();
  detachInputPreview();
  const overlayPreviewId = detachOverlayLayoutPreview();
  detachStudioSwitcher();
  $$('#consoleApp dialog[open]').forEach(dialog => dialog.close());
  setUserMenuOpen(false);
  $('#currentUsername').textContent = '';
  $('#consoleApp').hidden = true;
  $('#loginView').hidden = false;
  $('#loginPassword').value = '';
  $('#loginUsername').focus();
  if (overlayPreviewId) {
    fetch(`/api/previews/${encodeURIComponent(overlayPreviewId)}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
    }).catch(() => {});
  }
}

function handleUnauthorized() {
  if (!authState.authenticated && !authState.resolving) return;
  leaveConsole();
}

async function resolveSession() {
  authState.resolving = true;
  const error = $('#loginError');
  error.hidden = true;
  try {
    const session = await api('/api/auth/session');
    if (session.authenticated) await enterConsole(session.username);
    else leaveConsole();
  } catch {
    leaveConsole();
    error.textContent = '\u65e0\u6cd5\u8fde\u63a5\u5230\u670d\u52a1';
    error.hidden = false;
  } finally {
    authState.resolving = false;
  }
}

async function submitLogin(event) {
  event.preventDefault();
  if (authState.loginPending) return;
  const form = event.currentTarget;
  const username = String(form.elements.username.value || '');
  const password = String(form.elements.password.value || '');
  const error = $('#loginError');
  const submit = $('#loginSubmit');
  error.hidden = true;
  authState.loginPending = true;
  submit.disabled = true;
  submit.textContent = '\u767b\u5f55\u4e2d...';
  try {
    const session = await api('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ username, password }),
    });
    $('#loginPassword').value = '';
    await enterConsole(session.username);
  } catch (loginError) {
    $('#loginPassword').value = '';
    error.textContent = loginError.message || '\u7528\u6237\u540d\u6216\u5bc6\u7801\u9519\u8bef';
    error.hidden = false;
    $('#loginPassword').focus();
  } finally {
    authState.loginPending = false;
    submit.disabled = false;
    submit.textContent = '\u767b\u5f55';
  }
}

async function logout() {
  if (authState.signingOut) return;
  authState.signingOut = true;
  $('#logoutButton').disabled = true;
  try {
    await releaseOverlayLayoutPreview();
    await releaseInputPreview();
    await api('/api/auth/logout', { method: 'POST', body: '{}' });
  } catch {
  } finally {
    authState.signingOut = false;
    $('#logoutButton').disabled = false;
    leaveConsole();
  }
}

function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, ch => ({
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#39;',
  }[ch]));
}

function captureContainerFocus(container) {
  const active = document.activeElement;
  if (!container || !active || !container.contains(active) || !active.dataset) return null;
  const action = active.dataset.action;
  const key = active.dataset.id != null ? 'id' : active.dataset.value != null ? 'value' : '';
  if (!action || !key) return null;
  return { action, key, value: active.dataset[key] };
}

function restoreContainerFocus(container, identity) {
  if (!container || !identity) return;
  const match = Array.from(container.querySelectorAll('[data-action]')).find(element => (
    element.dataset.action === identity.action && element.dataset[identity.key] === identity.value
  ));
  if (match) match.focus({ preventScroll: true });
}

function replaceContainerHtmlPreservingFocus(container, markup) {
  const identity = captureContainerFocus(container);
  container.innerHTML = markup;
  restoreContainerFocus(container, identity);
}

function finiteMetric(value, options = {}) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;
  const min = Number.isFinite(options.min) ? options.min : 0;
  const max = Number.isFinite(options.max) ? options.max : Number.MAX_SAFE_INTEGER;
  return Math.min(max, Math.max(min, number));
}

function hasEncoderPerformanceWarning(output = {}) {
  const encoderSpeed = finiteMetric(output.encoderSpeed ?? (output.metrics && output.metrics.speed));
  if (!['nvenc', 'cpu'].includes(output.encodingMode) || encoderSpeed <= 0 || encoderSpeed >= 0.98) {
    return false;
  }
  if (output.pipelineStatus !== 'fallback') return true;

  const targetFps = finiteMetric(output.targetFps);
  const recentFps = finiteMetric(output.recentMeasuredFps);
  const fallbackHealthy = targetFps > 0
    && recentFps >= targetFps * 0.98
    && output.networkLossActive !== true;
  return !fallbackHealthy;
}

function formatActualBitrate(output = {}) {
  const value = output.bitrateKbps;
  const bitrate = Number(value);
  if (output.actualBitrateAvailable && value !== null && value !== undefined && Number.isFinite(bitrate) && bitrate >= 0) {
    return `${Math.round(bitrate)} Kbps`;
  }
  return output.actualBitrateStatus === 'sampling' ? '采样中' : '不可用';
}

function formatEstimatedNetworkDropCount(output = {}) {
  if (!output.networkDropAvailable) return '不可用';
  return String(Math.round(finiteMetric(output.totalDroppedFrames ?? output.droppedFrames)));
}

function formatEstimatedNetworkDropRate(output = {}) {
  if (!output.networkDropAvailable) return '不可用';
  const value = finiteMetric(output.totalDropRatePercent ?? output.dropRatePercent, { max: 100 });
  return `${value.toFixed(2)}%`;
}

function showToast(message) {
  const toast = $('#toast');
  toast.textContent = message;
  toast.classList.add('show');
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => toast.classList.remove('show'), 1800);
}

function refreshIcons() {
  if (typeof window === 'undefined' || !window.lucide || typeof window.lucide.createIcons !== 'function') return;
  window.lucide.createIcons({ attrs: { 'stroke-width': 1.75, 'aria-hidden': 'true' } });
}

function iconButtonMarkup(icon, label) {
  return `<i data-lucide="${escapeHtml(icon)}" aria-hidden="true"></i><span>${escapeHtml(label)}</span>`;
}

function appendSceneMedia(playlist, mediaId) {
  const id = String(mediaId || '').trim();
  return id ? [...(Array.isArray(playlist) ? playlist : []), id] : [...(Array.isArray(playlist) ? playlist : [])];
}

function removeSceneMedia(playlist, index) {
  const items = [...(Array.isArray(playlist) ? playlist : [])];
  if (Number.isInteger(index) && index >= 0 && index < items.length) items.splice(index, 1);
  return items;
}

function moveSceneMedia(playlist, index, direction) {
  const items = [...(Array.isArray(playlist) ? playlist : [])];
  const target = index + Number(direction || 0);
  if (!Number.isInteger(index) || index < 0 || index >= items.length || target < 0 || target >= items.length) return items;
  [items[index], items[target]] = [items[target], items[index]];
  return items;
}

function nextScenePlaylistIndex(index, total) {
  const length = Number(total);
  if (!Number.isInteger(length) || length < 1) return -1;
  return (Math.max(0, Number(index) || 0) + 1) % length;
}

function createSceneSwitchRequest(pipelineId, sceneId) {
  return {
    path: `/api/pipelines/${encodeURIComponent(pipelineId)}/switch-scene`,
    options: { method: 'POST', body: JSON.stringify({ sceneId }) },
  };
}

function createRestoreProgramRequest(pipelineId) {
  return {
    path: `/api/pipelines/${encodeURIComponent(pipelineId)}/restore-program`,
    options: { method: 'POST', body: '{}' },
  };
}

function createProgramPreviewRequest(pipelineId) {
  return { pipelineId };
}

function createPipelineInputPreviewRequest(pipeline = {}) {
  if (pipeline.input) return { input: pipeline.input };
  return { sourceId: String(pipeline.sourceId || '') };
}

function previousProgramPreviewTarget(program, pipeline) {
  if (program && program.kind === 'scene' && program.sceneId) {
    return { kind: 'scene', sceneId: String(program.sceneId) };
  }
  return { kind: 'original', request: createPipelineInputPreviewRequest(pipeline) };
}

function runningStudioPipelines(pipelines = [], monitor = {}) {
  const active = new Map((monitor.activePipelines || []).map(item => [item.pipelineId, item.status]));
  return (pipelines || []).filter(pipeline => (
    (pipeline.mode || 'shared-relay') === 'shared-relay' && ['running', 'fallback'].includes(active.get(pipeline.id))
  ));
}

function show(view) {
  if (view === 'system') view = 'dashboard';
  $$('.view').forEach(el => el.classList.toggle('active', el.id === `view-${view}`));
  $$('#nav button').forEach(el => el.classList.toggle('active', el.dataset.view === view));
  const meta = VIEW_META[view] || VIEW_META.dashboard;
  if ($('#topbarPageTitle')) $('#topbarPageTitle').textContent = meta.title;
  if ($('#topbarPageKicker')) $('#topbarPageKicker').textContent = meta.kicker;
  if ($('#consoleApp')) $('#consoleApp').dataset.currentView = view;
  if (view !== 'distribution') releaseAllPipelineCardMonitors();
  else requestAnimationFrame(syncPipelineCardMonitors);
  if (typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
    window.scrollTo({ top: 0, left: 0, behavior: 'instant' });
  }
  if (view === 'devices') loadDevices();
  if (view === 'logs') loadLogs();
  if (view === 'dashboard') {
    renderSystemStatus();
    loadSystemStatus();
  }
  if (view === 'scenes') renderStudioWorkspace();
}

function systemResources(snapshot = {}) {
  const cpu = snapshot.cpu || { available: false };
  const memory = snapshot.memory || { available: false };
  const disk = snapshot.disk || { available: false, devices: [] };
  const network = snapshot.network || { available: false, interfaces: [] };
  const gpu = snapshot.gpu || { available: false, devices: [] };
  const resources = [
    { id: 'cpu', type: 'cpu', label: 'CPU', accent: '#0c8abd', chartMode: 'percent', data: cpu, value: cpu.usagePercent },
    { id: 'memory', type: 'memory', label: '内存', accent: '#7559c7', chartMode: 'percent', data: memory, value: memory.usagePercent },
  ];
  const disks = Array.isArray(disk.devices) ? disk.devices : [];
  disks.forEach((device, index) => resources.push({
    id: device.id,
    type: 'disk',
    label: `磁盘 ${index}`,
    accent: '#67a52f',
    chartMode: 'percent',
    data: device,
    value: device.activityPercent,
  }));
  if (!disks.length) {
    resources.push({
      id: 'disk-unavailable',
      type: 'disk',
      label: '磁盘',
      accent: '#67a52f',
      chartMode: 'percent',
      data: { available: false, message: disk.message || '未检测到已挂载的物理磁盘' },
      value: null,
    });
  }
  const interfaces = Array.isArray(network.interfaces) ? network.interfaces : [];
  interfaces.forEach(device => resources.push({
    id: device.id,
    type: 'network',
    label: `网卡 ${device.name}`,
    accent: '#c23c67',
    chartMode: 'throughput',
    data: device,
    value: device.totalBytesPerSec,
  }));
  if (!interfaces.length) {
    resources.push({
      id: 'network-unavailable',
      type: 'network',
      label: '网卡',
      accent: '#c23c67',
      chartMode: 'throughput',
      data: { available: false, message: network.message || '未检测到运行中的网卡' },
      value: null,
    });
  }
  const devices = Array.isArray(gpu.devices) ? gpu.devices : [];
  devices.forEach(device => resources.push({
    id: device.id,
    type: 'gpu',
    label: `GPU ${device.index}`,
    accent: '#168b68',
    chartMode: 'percent',
    data: device,
    value: device.usagePercent,
  }));
  if (!devices.length) {
    resources.push({
      id: 'gpu-unavailable',
      type: 'gpu',
      label: 'GPU',
      accent: '#168b68',
      chartMode: 'percent',
      data: { available: false, message: gpu.message || '未检测到可用的 NVIDIA GPU' },
      value: null,
    });
  }
  return resources;
}

function mergeSystemHistory(histories = {}, snapshot = {}, limit = SYSTEM_HISTORY_LIMIT) {
  const next = Object.fromEntries(Object.entries(histories).map(([id, points]) => [id, points.slice()]));
  const time = Date.parse(snapshot.sampledAt);
  systemResources(snapshot).forEach(resource => {
    if (!Number.isFinite(resource.value) || !Number.isFinite(time)) return;
    next[resource.id] = [...(next[resource.id] || []), { time, value: resource.value }].slice(-limit);
  });
  return next;
}

function systemResourceAvailable(resource) {
  return Boolean(
    resource &&
    resource.data &&
    resource.data.available !== false
  );
}

function formatSystemPercent(value, fallback = '--') {
  return Number.isFinite(value) ? `${Math.round(Math.max(0, Math.min(100, value)))}%` : fallback;
}

function formatSystemBytes(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function formatSystemRate(value, fallback = '采样中') {
  if (!Number.isFinite(value) || value < 0) return fallback;
  if (value < 1024) return `${Math.round(value)} B/s`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB/s`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB/s`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB/s`;
}

function formatSystemNetworkRate(value, fallback = '采样中') {
  if (!Number.isFinite(value) || value < 0) return fallback;
  const bitsPerSecond = value * 8;
  if (!Number.isFinite(bitsPerSecond)) return fallback;
  if (bitsPerSecond === 0) return '0 Kbps';
  if (bitsPerSecond < 1_000_000) return `${(bitsPerSecond / 1_000).toFixed(1)} Kbps`;
  if (bitsPerSecond < 1_000_000_000) return `${(bitsPerSecond / 1_000_000).toFixed(1)} Mbps`;
  return `${(bitsPerSecond / 1_000_000_000).toFixed(1)} Gbps`;
}

function formatProcessMemory(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  if (value < 1024 ** 2) return `${Math.round(value / 1024)} KB`;
  if (value < 1024 ** 3) return `${(value / (1024 ** 2)).toFixed(1)} MB`;
  return `${(value / (1024 ** 3)).toFixed(1)} GB`;
}

function systemChartMax(resource, points = []) {
  if (!resource || resource.chartMode !== 'throughput') return 100;
  const values = points.map(point => point.value).filter(value => Number.isFinite(value) && value >= 0);
  if (Number.isFinite(resource.value) && resource.value >= 0) values.push(resource.value);
  const peak = Math.max(1024, ...values);
  return 2 ** Math.ceil(Math.log2(peak));
}

function formatSystemMib(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  if (value < 1024) return `${Math.round(value)} MB`;
  return `${(value / 1024).toFixed(1)} GB`;
}

function formatSystemClock(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  return value >= 1000 ? `${(value / 1000).toFixed(2)} GHz` : `${Math.round(value)} MHz`;
}

function formatSystemUptime(value) {
  if (!Number.isFinite(value) || value < 0) return '--';
  const total = Math.floor(value);
  const days = Math.floor(total / 86400);
  const hours = String(Math.floor(total % 86400 / 3600)).padStart(2, '0');
  const minutes = String(Math.floor(total % 3600 / 60)).padStart(2, '0');
  const seconds = String(total % 60).padStart(2, '0');
  return `${days} 天 ${hours}:${minutes}:${seconds}`;
}

function formatSystemResourceSummary(resource) {
  if (!systemResourceAvailable(resource)) return '不可用';
  const data = resource.data || {};
  if (resource.type === 'cpu') {
    return `${formatSystemPercent(resource.value, '采样中')}  ${formatSystemClock(data.averageSpeedMhz)}`;
  }
  if (resource.type === 'memory') {
    const used = Number.isFinite(data.usedBytes) && data.usedBytes >= 0
      ? (data.usedBytes / (1024 ** 3)).toFixed(1)
      : '--';
    return `${used} / ${formatSystemBytes(data.totalBytes)} (${formatSystemPercent(resource.value)})`;
  }
  if (resource.type === 'disk') {
    return `${formatSystemPercent(resource.value, '采样中')}  读 ${formatSystemRate(data.readBytesPerSec)}`;
  }
  if (resource.type === 'network') {
    return `收 ${formatSystemNetworkRate(data.receiveBytesPerSec)}  发 ${formatSystemNetworkRate(data.sendBytesPerSec)}`;
  }
  const usage = formatSystemPercent(resource.value, '利用率不可用');
  const temperature = Number.isFinite(data.temperatureC) ? `  ${Math.round(data.temperatureC)} °C` : '';
  return `${usage}${temperature}`;
}

function systemDetailRows(resource) {
  if (!systemResourceAvailable(resource)) return [];
  const data = resource.data || {};
  if (resource.type === 'cpu') {
    return [
      ['利用率', formatSystemPercent(resource.value, '采样中')],
      ['速度', formatSystemClock(data.averageSpeedMhz)],
      ['逻辑处理器', Number.isFinite(data.logicalCores) ? String(data.logicalCores) : '--'],
      ['系统负载', Number.isFinite(data.loadAverage1m) ? data.loadAverage1m.toFixed(2) : '--'],
      ['正常运行时间', formatSystemUptime(data.uptimeSec)],
    ];
  }
  if (resource.type === 'memory') {
    return [
      ['已使用', formatSystemBytes(data.usedBytes)],
      ['可用', formatSystemBytes(data.availableBytes)],
      ['总计', formatSystemBytes(data.totalBytes)],
      ['利用率', formatSystemPercent(resource.value)],
    ];
  }
  if (resource.type === 'disk') {
    return [
      ['活动时间', formatSystemPercent(resource.value, '采样中')],
      ['读取速度', formatSystemRate(data.readBytesPerSec)],
      ['写入速度', formatSystemRate(data.writeBytesPerSec)],
      ['已使用', formatSystemBytes(data.usedBytes)],
      ['可用', formatSystemBytes(data.availableBytes)],
      ['容量', formatSystemBytes(data.totalBytes)],
      ['挂载点', data.mountPoint || '--'],
      ['文件系统', data.filesystem || '--'],
      ['类型', data.type || '--'],
    ];
  }
  if (resource.type === 'network') {
    return [
      ['接收', formatSystemNetworkRate(data.receiveBytesPerSec)],
      ['发送', formatSystemNetworkRate(data.sendBytesPerSec)],
      ['总吞吐量', formatSystemNetworkRate(data.totalBytesPerSec)],
      ['链路速度', Number.isFinite(data.speedMbps) ? `${data.speedMbps} Mbps` : '--'],
      ['IPv4 地址', data.ipv4 || '--'],
      ['IPv6 地址', data.ipv6 || '--'],
      ['MAC 地址', data.mac || '--'],
    ];
  }

  const rows = [
    ['利用率', formatSystemPercent(resource.value, '不可用')],
  ];
  if (Number.isFinite(data.memoryUsedMib) && Number.isFinite(data.memoryTotalMib)) {
    rows.push(['显存', `${formatSystemMib(data.memoryUsedMib)} / ${formatSystemMib(data.memoryTotalMib)}`]);
  }
  if (Number.isFinite(data.temperatureC)) rows.push(['温度', `${Math.round(data.temperatureC)} °C`]);
  if (Number.isFinite(data.encoderUsagePercent)) rows.push(['编码器', formatSystemPercent(data.encoderUsagePercent)]);
  if (Number.isFinite(data.decoderUsagePercent)) rows.push(['解码器', formatSystemPercent(data.decoderUsagePercent)]);
  return rows;
}

function systemResourceSubtitle(resource) {
  const data = resource.data || {};
  if (!systemResourceAvailable(resource)) return data.message || '未检测到可用的 NVIDIA GPU';
  if (resource.type === 'cpu') return data.model || '处理器';
  if (resource.type === 'memory') return `${formatSystemBytes(data.totalBytes)} 内存`;
  if (resource.type === 'disk') {
    return [data.name || data.device || '磁盘', data.mountPoint].filter(Boolean).join(' - ');
  }
  if (resource.type === 'network') {
    const speed = Number.isFinite(data.speedMbps) ? `${data.speedMbps} Mbps` : '';
    return [data.name || '网络接口', speed].filter(Boolean).join(' - ');
  }
  return data.name || 'NVIDIA GPU';
}

function drawSystemChart(canvas, points = [], color = '#0c8abd', maxValue = 100) {
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const width = canvas.width;
  const height = canvas.height;
  const inset = Math.max(3, Math.round(width / 160));
  const chart = { left: inset, top: inset, width: width - inset * 2, height: height - inset * 2 };
  ctx.clearRect(0, 0, width, height);

  ctx.strokeStyle = themeColor('--ui-chart-grid', '#dfe8ef');
  ctx.lineWidth = 1;
  for (let index = 0; index <= 10; index += 1) {
    const x = chart.left + chart.width * index / 10;
    ctx.beginPath();
    ctx.moveTo(x, chart.top);
    ctx.lineTo(x, chart.top + chart.height);
    ctx.stroke();
  }
  for (let index = 0; index <= 4; index += 1) {
    const y = chart.top + chart.height * index / 4;
    ctx.beginPath();
    ctx.moveTo(chart.left, y);
    ctx.lineTo(chart.left + chart.width, y);
    ctx.stroke();
  }

  const valid = points.filter(point => Number.isFinite(point.time) && Number.isFinite(point.value));
  if (!valid.length) return;
  const end = valid.at(-1).time;
  const start = end - 60_000;
  const plotted = valid.filter(point => point.time >= start && point.time <= end).map(point => ({
    x: chart.left + (point.time - start) / 60_000 * chart.width,
    y: chart.top + (1 - Math.max(0, Math.min(maxValue, point.value)) / maxValue) * chart.height,
  }));
  if (!plotted.length) return;

  ctx.save();
  ctx.globalAlpha = 0.12;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(plotted[0].x, chart.top + chart.height);
  plotted.forEach(point => ctx.lineTo(point.x, point.y));
  ctx.lineTo(plotted.at(-1).x, chart.top + chart.height);
  ctx.closePath();
  ctx.fill();
  ctx.restore();

  ctx.strokeStyle = color;
  ctx.lineWidth = Math.max(1.5, width / 480);
  ctx.beginPath();
  plotted.forEach((point, index) => {
    if (index === 0) ctx.moveTo(point.x, point.y);
    else ctx.lineTo(point.x, point.y);
  });
  ctx.stroke();
  if (plotted.length === 1) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(plotted[0].x, plotted[0].y, Math.max(2, width / 240), 0, Math.PI * 2);
    ctx.fill();
  }
}

function renderSystemResourceList(resources) {
  const list = $('#systemResourceList');
  if (!list) return;
  const signature = resources.map(resource => resource.id).join('|');
  if (signature !== systemStatusState.resourceSignature) {
    const focused = document.activeElement && document.activeElement.dataset
      ? document.activeElement.dataset.systemResource
      : '';
    const scrollLeft = list.scrollLeft;
    list.innerHTML = resources.map(resource => `
      <button class="system-resource-button" type="button" role="tab" aria-controls="systemResourceDetail"
        data-system-resource="${escapeHtml(resource.id)}">
        <span class="system-resource-copy">
          <strong>${escapeHtml(resource.label)}</strong>
          <small class="system-resource-summary"></small>
        </span>
        <canvas class="system-mini-chart" width="224" height="108" aria-hidden="true"></canvas>
      </button>`).join('');
    list.scrollLeft = scrollLeft;
    systemStatusState.resourceSignature = signature;
    $$('[data-system-resource]').forEach(button => button.addEventListener('click', () => {
      systemStatusState.selectedId = button.dataset.systemResource;
      renderSystemStatus();
    }));
    if (focused) {
      const nextFocus = $$('[data-system-resource]').find(button => button.dataset.systemResource === focused);
      if (nextFocus) nextFocus.focus({ preventScroll: true });
    }
  }

  $$('[data-system-resource]').forEach((button, index) => {
    const resource = resources[index];
    const selected = resource.id === systemStatusState.selectedId;
    button.classList.toggle('active', selected);
    button.setAttribute('aria-selected', String(selected));
    button.style.setProperty('--resource-accent', resource.accent);
    button.querySelector('.system-resource-summary').textContent = formatSystemResourceSummary(resource);
    drawSystemChart(
      button.querySelector('.system-mini-chart'),
      systemStatusState.histories[resource.id] || [],
      resource.accent,
      systemChartMax(resource, systemStatusState.histories[resource.id] || []),
    );
  });
}

function systemPrimaryValue(resource) {
  if (!systemResourceAvailable(resource)) return '--';
  if (resource.type === 'network') return formatSystemNetworkRate(resource.value);
  return formatSystemPercent(resource.value, '采样中');
}

function renderSystemDetail(resource) {
  const detail = $('#systemResourceDetail');
  if (!detail || !resource) return;
  detail.style.setProperty('--resource-accent', resource.accent);
  $('#systemDetailTitle').textContent = resource.label;
  $('#systemDetailSubtitle').textContent = systemResourceSubtitle(resource);
  $('#systemDetailValue').textContent = systemPrimaryValue(resource);
  $('#systemDetailMetrics').innerHTML = systemDetailRows(resource).map(([label, value]) => `
    <div><dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('');

  const chart = $('#systemDetailChart');
  const history = systemStatusState.histories[resource.id] || [];
  const maxValue = systemChartMax(resource, history);
  const throughput = resource.chartMode === 'throughput';
  $('#systemChartLabel').textContent = throughput ? '吞吐量' : '% 利用率';
  $('#systemChartMax').textContent = throughput ? formatSystemNetworkRate(maxValue, '--') : '100%';
  chart.setAttribute('aria-label', `${resource.label}最近 60 秒${throughput ? '吞吐量' : '利用率'}`);
  drawSystemChart(chart, history, resource.accent, maxValue);

  const messages = [];
  if (!systemResourceAvailable(resource)) messages.push(systemResourceSubtitle(resource));
  if (systemStatusState.error) messages.push(systemStatusState.lastUpdatedAt ? '数据暂时无法更新' : `系统状态读取失败：${systemStatusState.error}`);
  if (systemStatusState.lastUpdatedAt) {
    messages.push(`最后更新 ${new Date(systemStatusState.lastUpdatedAt).toLocaleTimeString('zh-CN', { hour12: false })}`);
  }
  $('#systemStatusMessage').textContent = messages.join(' · ');
}

function formatProcessState(value) {
  return ({
    running: '运行',
    sleeping: '休眠',
    waiting: '等待 I/O',
    stopped: '已停止',
    zombie: '僵尸',
    unknown: '未知',
  })[value] || '未知';
}

function selectSystemProcesses(snapshot = {}, sort = 'cpu') {
  const processes = snapshot.processes || {};
  const selected = sort === 'memory' ? processes.byMemory : processes.byCpu;
  return Array.isArray(selected) ? selected.slice(0, 10) : [];
}

function renderProcessStatus() {
  const snapshot = systemStatusState.snapshot || {};
  const data = snapshot.processes || { available: false, message: '正在采样...' };
  const processes = selectSystemProcesses(snapshot, systemStatusState.processSort);
  $$('[data-process-sort]').forEach(button => {
    const active = button.dataset.processSort === systemStatusState.processSort;
    button.setAttribute('aria-pressed', String(active));
    button.classList.toggle('active', active);
  });
  $('#processStatusSummary').textContent = processes.length
    ? `按 ${systemStatusState.processSort === 'memory' ? '内存' : 'CPU'} 排序 · ${processes.length} 个进程`
    : '没有可显示的进程';
  $('#processStatusBody').innerHTML = processes.length ? processes.map(process => `
    <tr data-process-pid="${escapeHtml(process.pid)}">
      <td class="process-name" title="${escapeHtml(process.name)}"><strong>${escapeHtml(process.name)}</strong></td>
      <td>${escapeHtml(process.pid)}</td>
      <td>${escapeHtml(formatProcessState(process.state))}</td>
      <td class="process-number">${escapeHtml(formatSystemPercent(process.cpuPercent, '采样中'))}</td>
      <td class="process-number">${escapeHtml(formatProcessMemory(process.memoryBytes))}</td>
      <td class="process-number">${escapeHtml(formatSystemRate(process.readBytesPerSec))}</td>
      <td class="process-number">${escapeHtml(formatSystemRate(process.writeBytesPerSec))}</td>
    </tr>`).join('') : '<tr><td colspan="7">暂无可读取的进程</td></tr>';
  $('#processStatusMessage').textContent = data.available === false ? data.message || '进程状态不可用' : '';
}

function renderSystemStatus() {
  const resources = systemResources(systemStatusState.snapshot || {});
  let selected = resources.find(resource => resource.id === systemStatusState.selectedId);
  if (!selected) {
    selected = resources.find(systemResourceAvailable) || resources[0];
    systemStatusState.selectedId = selected.id;
  }
  renderSystemResourceList(resources);
  renderSystemDetail(selected);
  renderProcessStatus();
  renderDashboardResources();
}

function systemStatusViewActive() {
  return authState.authenticated;
}

async function loadSystemStatus({ silent = false } = {}) {
  if (!systemStatusViewActive() || systemStatusPollPending) return;
  systemStatusPollPending = true;
  try {
    const snapshot = await api('/api/system-status');
    systemStatusState.snapshot = snapshot;
    systemStatusState.histories = mergeSystemHistory(systemStatusState.histories, snapshot);
    systemStatusState.error = '';
    systemStatusState.lastUpdatedAt = Date.parse(snapshot.sampledAt) || Date.now();
    renderSystemStatus();
    renderDashboardResources();
  } catch (error) {
    systemStatusState.error = String(error && error.message || '未知错误');
    renderSystemStatus();
    renderDashboardResources();
  } finally {
    systemStatusPollPending = false;
  }
}

function metric(label, value, unit = '') {
  return `<div class="metric-card"><span class="metric-label">${label}</span><strong class="metric-value">${escapeHtml(value)}${unit ? ` <small>${escapeHtml(unit)}</small>` : ''}</strong></div>`;
}

function currentHost() {
  return window.location.hostname || '127.0.0.1';
}

function roomPublishInfo(room) {
  const port = Number(state.settings && state.settings.rtmpPort || 1935);
  const host = currentHost();
  const publishServer = `rtmp://${host}:${port}/live`;
  const streamKey = `${room.streamName}?secret=${room.publishSecret}`;
  return {
    publishServer,
    streamKey,
    publishUrl: `${publishServer}/${streamKey}`,
    localPlaybackUrl: `rtmp://127.0.0.1:${port}/live/${room.streamName}`,
  };
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    showToast('已复制');
  } catch {
    window.prompt('复制下面的内容', text);
  }
}

function confirmDangerousAction(message) {
  return window.confirm(message);
}

function advancePipelineFormGeneration() {
  pipelineFormGeneration += 1;
  return pipelineFormGeneration;
}

function pipelineFormOwns(generation, pipelineId) {
  return generation === pipelineFormGeneration
    && (pipelineId || null) === (editingPipelineId || null);
}

function showPipelineValidationError(message) {
  const friendly = friendlyPipelineError(message);
  const summary = $('#pipelineValidationSummary');
  if (summary) {
    summary.textContent = friendly;
    summary.hidden = false;
  }
  const status = $('#encodingModeStatus');
  status.textContent = friendly;
  status.classList.add('error');
  const section = /输入|采集|DeckLink|URL|素材|场景/.test(friendly)
    ? 'input'
    : /输出目标|端点/.test(friendly)
      ? 'output'
      : /编码|码率|Profile|Level|NVENC|QSV|AMF|x264|像素|GOP|B 帧|参考帧/.test(friendly)
        ? 'video'
        : activePipelineSection;
  switchPipelineSection(section, { focus: false });
  status.focus();
}

function friendlyPipelineError(message) {
  const text = String(message || '保存任务失败')
    .replace(/^Invalid FFmpeg configuration:\s*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (/h264_nvenc.*rc.*22|rc.*value 22/i.test(text)) {
    return 'NVENC 码率控制参数无效。质量值不能作为 NVENC 的 RC 模式。';
  }
  if (/Error setting option rc|Unable to parse option value.*rc|rc.*Invalid argument/i.test(text)) {
    return '码率控制参数无效。请为当前编码器选择 CBR、VBR、ABR 或恒定质量中的可用模式。';
  }
  if (/CUDA_ERROR_NO_DEVICE|Cannot load libcuda|NVIDIA driver|nvidia-smi/i.test(text)) {
    return 'NVIDIA 编码器当前不可用，请检查驱动状态和 GPU 可见性，或改用 x264 软件编码。';
  }
  if (/Invalid argument|Conversion failed|Error initializing output stream/i.test(text)) {
    return '编码器拒绝了当前参数组合，请检查码率控制、Preset、Profile、像素格式和高级参数。';
  }
  if (/ffmpeg version|configuration:|libav(?:util|codec|format)|Stream mapping:/i.test(text)) {
    return 'FFmpeg 未能应用当前任务配置，请检查输入信号、编码器能力和高级参数。';
  }
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function switchPipelineSection(section, { focus = true } = {}) {
  const next = PIPELINE_SECTION_ORDER.includes(section) ? section : 'basic';
  activePipelineSection = next;
  $$('[data-pipeline-section]').forEach(button => {
    const active = button.dataset.pipelineSection === next;
    button.classList.toggle('active', active);
    if (active) button.setAttribute('aria-current', 'step');
    else button.removeAttribute('aria-current');
  });
  $$('[data-pipeline-panel]').forEach(panel => {
    const active = panel.dataset.pipelinePanel === next;
    panel.hidden = !active;
    panel.classList.toggle('active', active);
  });
  const index = PIPELINE_SECTION_ORDER.indexOf(next);
  const previous = $('#pipelinePreviousSectionBtn');
  const following = $('#pipelineNextSectionBtn');
  if (previous) previous.disabled = index <= 0;
  if (following) following.hidden = index >= PIPELINE_SECTION_ORDER.length - 1;
  if ($('#pipelineSectionProgress')) $('#pipelineSectionProgress').textContent = `${index + 1} / ${PIPELINE_SECTION_ORDER.length}`;
  if (focus) $('[data-pipeline-panel]:not([hidden]) h3')?.focus?.();
}

function validatePipelineInput(values, currentState = state || {}) {
  const get = name => {
    const value = values && typeof values.get === 'function' ? values.get(name) : values && values[name];
    return String(value ?? '').trim();
  };
  const inputType = get('inputType');
  if (inputType === 'room') {
    const room = (currentState.rooms || []).find(item => item.id === get('roomId'));
    return room && room.enabled !== false ? '' : '请选择有效且已启用的本地直播间';
  }
  if (inputType === 'legacy') {
    const source = (currentState.sources || []).find(item => item.id === get('sourceId'));
    return source && source.enabled !== false ? '' : '请选择有效且已启用的已保存输入源';
  }
  if (inputType === 'url') return get('url') ? '' : '请填写 URL 输入地址';
  if (inputType === 'file') {
    const asset = (currentState.mediaAssets || []).find(item => item.id === get('mediaId'));
    return asset ? '' : '请选择有效的视频素材';
  }
  if (inputType === 'scene') {
    const scene = (currentState.scenes || []).find(item => item.id === get('sceneId'));
    return scene ? '' : '请选择有效的画面场景';
  }
  if (inputType === 'capture') {
    const backend = get('captureBackend') || 'v4l2';
    if (backend === 'decklink') return get('decklinkDevice') ? '' : '请选择或填写 DeckLink 设备名称';
    return get('videoDevice') ? '' : '请选择采集卡视频设备';
  }
  return '请选择有效的输入源类型';
}

function formControlValue(form, fd, name, fallback) {
  const submittedValue = fd.get(name);
  if (submittedValue !== null && submittedValue !== '') return submittedValue;
  const control = form && form.elements && form.elements[name];
  return control && control.value !== '' ? control.value : fallback;
}

function assetHasPath(asset) {
  if (typeof asset === 'string') return asset.length > 0;
  return Boolean(asset && asset.path);
}

function normalizeEditorLayout(layout, dimensions = {}, fallbackMode = 'legacy') {
  const sourceWidth = Number(dimensions.width);
  const sourceHeight = Number(dimensions.height);
  const hasAspect = Number.isFinite(sourceWidth) && sourceWidth > 0
    && Number.isFinite(sourceHeight) && sourceHeight > 0;
  const aspectRatio = hasAspect ? sourceWidth / sourceHeight : 16 / 9;
  const valid = layout
    && Number.isFinite(layout.x)
    && Number.isFinite(layout.y)
    && Number.isFinite(layout.width)
    && layout.width > 0;
  if (valid) {
    return {
      x: layout.x,
      y: layout.y,
      width: layout.width,
      height: layout.width / aspectRatio,
      legacy: false,
    };
  }
  if (fallbackMode === 'legacy') {
    return { x: 0, y: 0, width: 1920, height: 1080, legacy: true };
  }
  return { x: 0, y: 0, width: 1920, height: 1920 / aspectRatio, legacy: false };
}

function layoutToCss(layout = {}, canvasRect = {}) {
  const scaleX = Number(canvasRect.width) / 1920;
  const scaleY = Number(canvasRect.height) / 1080;
  return {
    left: `${Number(layout.x) * scaleX}px`,
    top: `${Number(layout.y) * scaleY}px`,
    width: `${Number(layout.width) * scaleX}px`,
    height: `${Number(layout.height) * scaleY}px`,
  };
}

function serializeOverlayLayout(layout = {}) {
  if (!Number.isFinite(layout.x) || !Number.isFinite(layout.y)
    || !Number.isFinite(layout.width) || layout.width <= 0) return null;
  const rounded = value => Math.round((Number(value) + Number.EPSILON) * 1000) / 1000;
  return { x: rounded(layout.x), y: rounded(layout.y), width: rounded(layout.width) };
}

function commitOverlayDraft(kind, index, layout, watermarks = [], slideshow = {}) {
  const serialized = serializeOverlayLayout(layout);
  const nextWatermarks = (Array.isArray(watermarks) ? watermarks : []).map(item => ({
    ...item,
    ...(item.layout ? { layout: { ...item.layout } } : {}),
  }));
  const nextSlideshow = {
    ...slideshow,
    images: (Array.isArray(slideshow.images) ? slideshow.images : []).map(item => ({ ...item })),
    ...(slideshow.layout ? { layout: { ...slideshow.layout } } : {}),
  };
  if (!serialized) return { watermarks: nextWatermarks, slideshow: nextSlideshow };
  if (kind === 'watermark' && Number.isInteger(index) && nextWatermarks[index]) {
    nextWatermarks[index] = { ...nextWatermarks[index], layout: serialized };
  }
  if (kind === 'slideshow') nextSlideshow.layout = serialized;
  return { watermarks: nextWatermarks, slideshow: nextSlideshow };
}

function visualProcessingActive(settings = {}) {
  const watermarks = Array.isArray(settings.watermarks) ? settings.watermarks : [];
  const slideshow = settings.slideshow || {};
  const slideshowImages = Array.isArray(slideshow.images) ? slideshow.images : [];
  return watermarks.some(assetHasPath)
    || assetHasPath(settings.watermark)
    || assetHasPath(slideshow.preparedPath)
    || slideshowImages.some(assetHasPath);
}

function formHasVisualProcessing() {
  return visualProcessingActive({
    watermarks: pipelineWatermarks,
    slideshow: pipelineSlideshow,
  });
}

function normalizeEncodingInput(input = {}) {
  return {
    type: input.type === 'pull' ? 'url' : String(input.type || ''),
    url: String(input.inputUrl || input.url || ''),
  };
}

async function loadEncodingCapabilities() {
  try {
    const data = await api('/api/encoding-capabilities');
    const encoders = Object.fromEntries((data.encoders || []).map(item => [item.id, item]));
    encodingCapabilities = {
      checked: true,
      nvencAvailable: data.nvencAvailable === true,
      message: String(data.message || ''),
      encoders,
    };
  } catch (error) {
    encodingCapabilities = {
      checked: true,
      nvencAvailable: false,
      message: String(error && error.message || '无法读取编码能力'),
      encoders: {},
    };
  }
  syncEncodingControls($('#pipelineForm'));
}

function formEncodingInput(form) {
  const elements = form && form.elements ? form.elements : {};
  const inputType = elements.inputType ? elements.inputType.value : '';
  if (inputType === 'legacy') {
    const sourceId = elements.sourceId ? elements.sourceId.value : '';
    const source = state && (state.sources || []).find(item => item.id === sourceId);
    return normalizeEncodingInput(source);
  }
  return normalizeEncodingInput({
    type: inputType,
    url: elements.url ? elements.url.value.trim() : '',
  });
}

function resolveEncodingMode(requested, input, hasVisualProcessing) {
  const inputType = input && input.type || '';
  const inputUrl = input && input.url || '';
  const nvencAvailable = typeof encodingCapabilities === 'undefined'
    || !encodingCapabilities.checked
    || encodingCapabilities.nvencAvailable;
  if (requested === 'libx264') return 'cpu';
  if (requested === 'h264_nvenc') return 'nvenc';
  if (requested === 'h264_qsv') return 'qsv';
  if (requested === 'h264_amf') return 'amf';
  if (requested === 'copy') return 'copy';
  if (requested !== 'auto') return 'unsupported';
  if (inputType === 'capture') return nvencAvailable ? 'nvenc' : 'cpu';
  if (inputType === 'room') return hasVisualProcessing && nvencAvailable ? 'nvenc' : hasVisualProcessing ? 'cpu' : 'copy';
  if (inputType === 'url' && /^rtmps?:\/\//i.test(inputUrl)) {
    return hasVisualProcessing ? (nvencAvailable ? 'nvenc' : 'cpu') : 'copy';
  }
  return 'unsupported';
}

function replaceSelectChoices(select, choices, preferred) {
  if (!select) return;
  const value = String(preferred || select.value || '');
  select.innerHTML = choices.map(choice => `<option value="${escapeHtml(choice.value)}">${escapeHtml(choice.label)}</option>`).join('');
  select.value = choices.some(choice => choice.value === value) ? value : choices[0]?.value || '';
}

function encoderFormProfile(form, mode) {
  const requested = form && form.elements && form.elements.videoEncoder
    ? form.elements.videoEncoder.value
    : 'auto';
  const encoder = requested === 'auto'
    ? ({ nvenc: 'h264_nvenc', cpu: 'libx264', qsv: 'h264_qsv', amf: 'h264_amf', copy: 'copy' }[mode] || '')
    : requested;
  const presets = {
    libx264: ['veryfast', 'ultrafast', 'superfast', 'faster', 'fast', 'medium', 'slow', 'slower', 'veryslow'],
    h264_nvenc: ['p4', 'p1', 'p2', 'p3', 'p5', 'p6', 'p7'],
    h264_qsv: ['medium', 'veryfast', 'faster', 'fast', 'slow', 'slower', 'veryslow'],
    h264_amf: ['balanced', 'speed', 'quality'],
  }[encoder] || ['veryfast'];
  const tunes = encoder === 'h264_nvenc'
    ? [{ value: 'll', label: 'LL 低延迟' }, { value: 'hq', label: 'HQ 高质量' }, { value: 'ull', label: 'ULL 超低延迟' }, { value: 'lossless', label: 'Lossless 无损' }]
    : encoder === 'libx264'
      ? [{ value: 'none', label: '无' }, { value: 'zerolatency', label: 'Zero Latency' }, { value: 'film', label: 'Film' }, { value: 'animation', label: 'Animation' }, { value: 'grain', label: 'Grain' }]
      : [{ value: 'none', label: '此编码器不使用 Tune' }];
  return {
    encoder,
    presets: presets.map(value => ({ value, label: value })),
    tunes,
  };
}

function resolveFormEncodingMode(form) {
  const elements = form && form.elements ? form.elements : {};
  const requested = elements.videoEncoder ? elements.videoEncoder.value : 'auto';
  return resolveEncodingMode(requested, formEncodingInput(form), formHasVisualProcessing());
}

function syncEncodingControls(form = $('#pipelineForm')) {
  const elements = form && form.elements ? form.elements : {};
  const requested = elements.videoEncoder ? elements.videoEncoder.value : 'auto';
  const input = formEncodingInput(form);
  const mode = resolveFormEncodingMode(form);
  const pipelineMode = elements.mode ? elements.mode.value : 'shared-relay';
  const invalidCopy = requested === 'copy' && (input.type === 'capture' || formHasVisualProcessing());
  const capabilities = typeof encodingCapabilities === 'undefined'
    ? { checked: false, nvencAvailable: true, message: '', encoders: {} }
    : encodingCapabilities;
  const encoderProfile = encoderFormProfile(form, mode);
  const selectedCapability = capabilities.encoders && capabilities.encoders[encoderProfile.encoder];
  const selectedUnavailable = capabilities.checked && selectedCapability && selectedCapability.available === false;
  let error = '';
  let statusTone = '';
  if (invalidCopy) {
    error = '原样复制不能用于采集卡输入、水印或幻灯片，请选择自动或明确的视频编码器';
    statusTone = 'error';
  }
  else if (selectedUnavailable) {
    error = `${selectedCapability.label || encoderProfile.encoder} 当前不可用：${selectedCapability.reason || '硬件或 FFmpeg 不支持'}`;
    statusTone = 'warning';
  }
  else if (mode === 'copy' && pipelineMode === 'direct') {
    error = '原样复制必须使用共享转推，直连推送只支持 CPU 或 NVENC 编码';
    statusTone = 'error';
  }

  for (const encoder of ['libx264', 'h264_nvenc', 'h264_qsv', 'h264_amf']) {
    const option = elements.videoEncoder && elements.videoEncoder.querySelector(`option[value="${encoder}"]`);
    const capability = capabilities.encoders && capabilities.encoders[encoder];
    if (!option || !capability || !capabilities.checked) continue;
    option.disabled = capability.available === false;
    option.textContent = capability.available === false
      ? `${capability.label || encoder}（本机不可用）`
      : capability.label || encoder;
  }
  if (mode === 'unsupported') {
    error = requested === 'auto'
      ? '自动模式无法识别当前输入，请选择明确的视频编码器'
      : '当前视频编码器无法识别，请选择自动或明确的视频编码器';
    statusTone = 'error';
  }

  const copyMode = mode === 'copy';
  const currentPreset = elements.preset && elements.preset.value;
  const currentTune = elements.tune && elements.tune.value;
  replaceSelectChoices(elements.preset, encoderProfile.presets, currentPreset);
  replaceSelectChoices(elements.tune, encoderProfile.tunes, currentTune);
  if (elements.multipass) elements.multipass.disabled = copyMode || encoderProfile.encoder !== 'h264_nvenc';

  const rateControl = elements.rateControl ? elements.rateControl.value : 'cbr';
  if (encoderProfile.encoder === 'h264_nvenc' && rateControl === 'abr') {
    error = 'NVENC 不支持 ABR，请选择 CBR、VBR 或恒定质量';
    statusTone = 'error';
  }
  $$('[data-rate-field]').forEach(label => {
    const kind = label.dataset.rateField;
    label.hidden = kind === 'crf' ? rateControl !== 'crf' : kind === 'bitrate' ? rateControl === 'crf' : false;
  });

  for (const name of [
    'rateControl', 'bitrateKbps', 'maxBitrateKbps', 'bufferSizeKbps', 'crf', 'outputResolution', 'fps',
    'keyframeSec', 'preset', 'tune', 'multipass', 'profile', 'level', 'bFrames', 'referenceFrames',
    'lookahead', 'adaptiveQuantization', 'aqStrength', 'sceneDetection', 'pixelFormat', 'colorRange',
    'repeatHeaders', 'customOptions',
  ]) {
    const control = elements[name];
    if (!control) continue;
    if (name !== 'multipass') control.disabled = copyMode;
    if (copyMode) control.setAttribute('aria-disabled', 'true');
    else control.removeAttribute('aria-disabled');
  }

  const status = $('#encodingModeStatus');
  if (status) {
    const modeText = {
      copy: '实际模式：原样复制',
      nvenc: '实际模式：NVIDIA NVENC',
      cpu: '实际模式：CPU 编码',
      qsv: '实际模式：Intel Quick Sync',
      amf: '实际模式：AMD AMF',
      unsupported: '请选择明确的视频编码器',
    }[mode];
    status.textContent = error || modeText || '请选择明确的视频编码器';
    status.classList.toggle('error', statusTone === 'error');
    status.classList.toggle('warning', statusTone === 'warning');
  }
  return { mode, error };
}

function encodingModeLabel(mode) {
  return { copy: 'copy', nvenc: 'NVENC', qsv: 'QSV', amf: 'AMF', cpu: 'CPU' }[mode] || '未知';
}

function estimateLiveDelayMemoryMib(delaySeconds, videoKbps, audioKbps) {
  const seconds = Math.max(0, Number(delaySeconds) || 0);
  const totalKbps = Math.max(0, Number(videoKbps) || 0) + Math.max(0, Number(audioKbps) || 0);
  return Number((totalKbps * 1000 / 8 * seconds / (1024 ** 2)).toFixed(1));
}

function syncLiveDelayControls(form = $('#pipelineForm')) {
  const delayEnabledControl = form && form.elements && form.elements.delayEnabled;
  const delaySecondsControl = form && form.elements && form.elements.delaySeconds;
  const modeControl = form && form.elements && form.elements.mode;
  const estimate = $('#liveDelayMemoryEstimate');
  if (!delayEnabledControl || !delaySecondsControl || !modeControl) return { enabled: false, delaySeconds: 20 };

  const enabled = Boolean(delayEnabledControl.checked);
  const delaySeconds = Number(delaySecondsControl.value || 20);
  delaySecondsControl.disabled = !enabled;
  if (enabled) modeControl.value = 'shared-relay';
  modeControl.disabled = enabled;
  modeControl.setAttribute('aria-disabled', String(enabled));

  if (estimate) {
    if (!enabled) {
      estimate.textContent = '启用后将使用内存缓冲编码后的直播内容。';
    } else if (resolveFormEncodingMode(form) === 'copy') {
      estimate.textContent = '原样复制模式下，内存占用按实际输入码率计算；输入预览不受延时影响。';
    } else {
      const memoryMib = estimateLiveDelayMemoryMib(
        delaySeconds,
        form.elements.bitrateKbps && form.elements.bitrateKbps.value,
        form.elements.audioBitrateKbps && form.elements.audioBitrateKbps.value,
      );
      estimate.textContent = `预计内存占用：约 ${memoryMib.toFixed(1)} MiB；输入预览不受延时影响。`;
    }
  }
  return { enabled, delaySeconds };
}

function settingsFromForm(form) {
  const fd = new FormData(form);
  const delayEnabled = Boolean(form && form.elements && form.elements.delayEnabled && form.elements.delayEnabled.checked);
  const delaySeconds = Number(formControlValue(form, fd, 'delaySeconds', 20));
  if (delayEnabled && (!Number.isInteger(delaySeconds) || delaySeconds < 1 || delaySeconds > 300)) {
    throw new Error('直播延时必须在 1 至 300 秒之间');
  }
  const intervalMs = Number(fd.get('slideshowIntervalMs') || 2000);
  const transitionMs = Number(fd.get('slideshowTransitionMs') || 700);
  if (!Number.isFinite(intervalMs) || intervalMs < 500 || intervalMs > 60000) {
    throw new Error('幻灯片播放间隔必须在 500 至 60000 ms 之间');
  }
  if (!Number.isFinite(transitionMs) || transitionMs < 0 || transitionMs > 5000) {
    throw new Error('幻灯片淡入淡出时长必须在 0 至 5000 ms 之间');
  }
  if (transitionMs > intervalMs) throw new Error('幻灯片淡入淡出时长不能超过播放间隔');
  return {
    live: {
      videoEncoder: formControlValue(form, fd, 'videoEncoder', 'auto'),
      audioEncoder: fd.get('audioEncoder') || 'aac',
      rateControl: formControlValue(form, fd, 'rateControl', 'cbr'),
      bitrateKbps: Number(formControlValue(form, fd, 'bitrateKbps', 8000)),
      maxBitrateKbps: Number(formControlValue(form, fd, 'maxBitrateKbps', 8000)),
      bufferSizeKbps: Number(formControlValue(form, fd, 'bufferSizeKbps', 16000)),
      crf: Number(formControlValue(form, fd, 'crf', 23)),
      keyframeSec: Number(formControlValue(form, fd, 'keyframeSec', 2)),
      preset: formControlValue(form, fd, 'preset', 'veryfast'),
      tune: formControlValue(form, fd, 'tune', 'zerolatency'),
      multipass: formControlValue(form, fd, 'multipass', 'disabled'),
      profile: formControlValue(form, fd, 'profile', 'high'),
      level: formControlValue(form, fd, 'level', 'auto'),
      bFrames: Number(formControlValue(form, fd, 'bFrames', 2)),
      referenceFrames: Number(formControlValue(form, fd, 'referenceFrames', 3)),
      lookahead: Boolean(form.elements.lookahead && form.elements.lookahead.checked),
      adaptiveQuantization: Boolean(form.elements.adaptiveQuantization && form.elements.adaptiveQuantization.checked),
      aqStrength: Number(formControlValue(form, fd, 'aqStrength', 8)),
      sceneDetection: Boolean(form.elements.sceneDetection && form.elements.sceneDetection.checked),
      pixelFormat: formControlValue(form, fd, 'pixelFormat', 'yuv420p'),
      colorRange: formControlValue(form, fd, 'colorRange', 'tv'),
      repeatHeaders: Boolean(form.elements.repeatHeaders && form.elements.repeatHeaders.checked),
      customOptions: formControlValue(form, fd, 'customOptions', ''),
      delayEnabled,
      delaySeconds,
    },
    video: {
      outputResolution: formControlValue(form, fd, 'outputResolution', '1920x1080'),
      fps: formControlValue(form, fd, 'fps', '59.94'),
    },
    audio: {
      sampleRate: fd.get('sampleRate') || '48000',
      channels: fd.get('channels') || 'stereo',
      tracks: [{ bitrateKbps: Number(fd.get('audioBitrateKbps') || 320) }],
    },
    noSignalImage: typeof pipelineNoSignalImage !== 'undefined' && pipelineNoSignalImage
      ? { ...pipelineNoSignalImage }
      : null,
    watermarks: pipelineWatermarks.map(item => ({
      ...item,
      ...(item.layout ? { layout: { ...item.layout } } : {}),
    })),
    slideshow: {
      images: pipelineSlideshow.images.map(item => ({ ...item })),
      intervalMs,
      transitionMs,
      loop: true,
      ...(pipelineSlideshow.layout ? { layout: { ...pipelineSlideshow.layout } } : {}),
    },
  };
}

function overlayItems(kind) {
  return kind === 'watermark' ? pipelineWatermarks : pipelineSlideshow.images;
}

function setOverlayItems(kind, items) {
  if (kind === 'watermark') pipelineWatermarks = items;
  else pipelineSlideshow.images = items;
}

function renderOverlayList(kind) {
  const list = kind === 'watermark' ? $('#watermarkList') : $('#slideshowList');
  const items = overlayItems(kind);
  list.innerHTML = items.map((item, index) => `<div class="overlay-item">
    <img class="overlay-thumb" src="${escapeHtml(item.url || '')}" alt="">
    <div>
      <strong>${escapeHtml(item.name || item.id || '未命名图片')}</strong>
      <small>${kind === 'watermark' ? `图层 ${index + 1}` : `第 ${index + 1} 张`}${item.layout || kind === 'slideshow' && pipelineSlideshow.layout ? ' · 已调节' : ''}</small>
    </div>
    <div class="overlay-item-actions">
      <button class="icon-button" type="button" data-overlay-kind="${escapeHtml(kind)}" data-overlay-action="up" data-overlay-index="${index}" aria-label="上移 ${escapeHtml(item.name || '图片')}" title="上移" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up" aria-hidden="true"></i></button>
      <button class="icon-button" type="button" data-overlay-kind="${escapeHtml(kind)}" data-overlay-action="down" data-overlay-index="${index}" aria-label="下移 ${escapeHtml(item.name || '图片')}" title="下移" ${index === items.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down" aria-hidden="true"></i></button>
      <button type="button" class="danger icon-button" data-overlay-kind="${escapeHtml(kind)}" data-overlay-action="remove" data-overlay-index="${index}" aria-label="移除 ${escapeHtml(item.name || '图片')}" title="移除"><i data-lucide="trash-2" aria-hidden="true"></i></button>
    </div>
  </div>`).join('');
  bindOverlayActions(list);
  refreshIcons();
}

function renderPipelineOverlays() {
  renderOverlayList('watermark');
  renderOverlayList('slideshow');
  const watermarkStatus = $('#watermarkStatus');
  const slideshowStatus = $('#slideshowStatus');
  if (!watermarkStatus.classList.contains('error')) {
    watermarkStatus.textContent = pipelineWatermarks.length
      ? `已添加 ${pipelineWatermarks.length} 张，保存任务后按列表顺序叠加。`
      : '当前任务不叠加静态水印。';
  }
  if (!slideshowStatus.classList.contains('error')) {
    slideshowStatus.textContent = pipelineSlideshow.images.length
      ? `已添加 ${pipelineSlideshow.images.length} 张，保存任务后循环播放。`
      : '当前任务不播放幻灯片。';
  }
  $('#previewWatermarkBtn').disabled = pipelineWatermarks.length === 0;
  $('#previewSlideshowBtn').disabled = pipelineSlideshow.images.length === 0;
  syncEncodingControls();
}

function renderNoSignalImage() {
  const list = $('#noSignalImagePreview');
  const status = $('#noSignalImageStatus');
  if (!list || !status) return;
  if (!pipelineNoSignalImage) {
    list.innerHTML = '';
    if (!status.classList.contains('error')) status.textContent = '未选择图片，信号丢失时使用默认黑屏。';
    return;
  }
  list.innerHTML = `<div class="overlay-item no-signal-image-item">
    <img class="overlay-thumb" src="${escapeHtml(pipelineNoSignalImage.url || '')}" alt="">
    <div><strong>${escapeHtml(pipelineNoSignalImage.name || '无信号画面')}</strong><small>信号丢失时使用</small></div>
    <div class="overlay-item-actions"><button type="button" class="danger icon-button" id="removeNoSignalImageBtn" aria-label="移除无信号推送画面" title="移除"><i data-lucide="trash-2" aria-hidden="true"></i></button></div>
  </div>`;
  $('#removeNoSignalImageBtn').addEventListener('click', () => {
    pipelineNoSignalImage = null;
    renderNoSignalImage();
  });
  refreshIcons();
  if (!status.classList.contains('error')) status.textContent = '已选择自定义无信号推送画面。';
}

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(new Error('读取本地图片失败'));
    reader.readAsDataURL(file);
  });
}

async function uploadOverlayFiles({ kind, inputId, statusId, buttonId }) {
  const fileInput = $(`#${inputId}`);
  const files = Array.from(fileInput.files || []);
  const status = $(`#${statusId}`);
  const button = $(`#${buttonId}`);
  const uploadGeneration = pipelineFormGeneration;
  const uploadEditingPipelineId = editingPipelineId;
  const current = overlayItems(kind);
  if (!files.length) return alert('请先选择至少一张本地图片');
  if (current.length + files.length > MAX_OVERLAY_IMAGES) return alert(`每组最多添加 ${MAX_OVERLAY_IMAGES} 张图片`);
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) {
    return alert('图片仅支持 PNG、JPEG 或 WebP');
  }
  if (files.some(file => file.size > 10 * 1024 * 1024)) return alert('每张图片不能超过 10 MiB');

  button.disabled = true;
  status.classList.remove('error');
  status.textContent = `正在上传 ${files.length} 张图片...`;
  try {
    const uploaded = [];
    for (const file of files) {
      const data = await readFileAsDataUrl(file);
      if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
      const uploadedItem = await api('/api/watermarks', {
        method: 'POST',
        body: JSON.stringify({ name: file.name, mimeType: file.type, data }),
      });
      if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
      uploaded.push(uploadedItem);
    }
    if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
    setOverlayItems(kind, [...current, ...uploaded.map(item => ({ ...item }))]);
    fileInput.value = '';
    renderPipelineOverlays();
    showToast(`已添加 ${uploaded.length} 张图片`);
  } catch (error) {
    if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    if (pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) button.disabled = false;
  }
}

async function uploadNoSignalImage() {
  const fileInput = $('#noSignalImageFile');
  const status = $('#noSignalImageStatus');
  const button = $('#uploadNoSignalImageBtn');
  const file = fileInput && fileInput.files && fileInput.files[0];
  const uploadGeneration = pipelineFormGeneration;
  const uploadEditingPipelineId = editingPipelineId;
  if (!file) return alert('请先选择一张本地图片');
  if (!['image/png', 'image/jpeg', 'image/webp'].includes(file.type)) return alert('图片仅支持 PNG、JPEG 或 WebP');
  if (file.size > 10 * 1024 * 1024) return alert('图片不能超过 10 MiB');
  button.disabled = true;
  status.classList.remove('error');
  status.textContent = '正在上传无信号推送画面...';
  try {
    const data = await readFileAsDataUrl(file);
    if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
    const uploaded = await api('/api/watermarks', {
      method: 'POST',
      body: JSON.stringify({ name: file.name, mimeType: file.type, data }),
    });
    if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
    pipelineNoSignalImage = { ...uploaded };
    fileInput.value = '';
    renderNoSignalImage();
    showToast('已设置无信号推送画面');
  } catch (error) {
    if (!pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) return;
    status.classList.add('error');
    status.textContent = error.message;
  } finally {
    if (pipelineFormOwns(uploadGeneration, uploadEditingPipelineId)) button.disabled = false;
  }
}

function bindOverlayActions(container) {
  container.querySelectorAll('[data-overlay-action]').forEach(button => {
    button.addEventListener('click', () => {
      const kind = button.dataset.overlayKind;
      const action = button.dataset.overlayAction;
      const index = Number(button.dataset.overlayIndex);
      const items = [...overlayItems(kind)];
      if (!Number.isInteger(index) || index < 0 || index >= items.length) return;
      if (action === 'remove') items.splice(index, 1);
      if (action === 'up' && index > 0) [items[index - 1], items[index]] = [items[index], items[index - 1]];
      if (action === 'down' && index < items.length - 1) [items[index + 1], items[index]] = [items[index], items[index + 1]];
      setOverlayItems(kind, items);
      renderPipelineOverlays();
    });
  });
}

function setControlValue(form, name, value, historicalLabel = '历史值') {
  const control = form.elements[name];
  if (!control) return;
  const normalized = String(value ?? '');
  if (control.tagName === 'SELECT' && normalized && !Array.from(control.options).some(option => option.value === normalized)) {
    control.add(new Option(`${normalized}（${historicalLabel}）`, normalized));
  }
  control.value = normalized;
}

function fillSettingsForm(form, settings = {}) {
  const live = settings.live || {};
  const video = settings.video || {};
  const audio = settings.audio || {};
  const firstTrack = Array.isArray(audio.tracks) && audio.tracks.length ? audio.tracks[0] : {};
  setControlValue(form, 'videoEncoder', live.videoEncoder || 'auto');
  setControlValue(form, 'audioEncoder', live.audioEncoder || 'aac');
  setControlValue(form, 'rateControl', live.rateControl || 'cbr');
  setControlValue(form, 'bitrateKbps', live.bitrateKbps || 8000);
  setControlValue(form, 'maxBitrateKbps', live.maxBitrateKbps || live.bitrateKbps || 8000);
  setControlValue(form, 'bufferSizeKbps', live.bufferSizeKbps || (Number(live.bitrateKbps || 8000) * 2));
  setControlValue(form, 'crf', live.crf ?? 23);
  setControlValue(form, 'keyframeSec', live.keyframeSec || 2);
  setControlValue(form, 'preset', live.preset || 'veryfast');
  setControlValue(form, 'tune', live.tune || 'zerolatency');
  setControlValue(form, 'multipass', live.multipass || 'disabled');
  setControlValue(form, 'profile', live.profile || 'high');
  setControlValue(form, 'level', live.level || 'auto');
  setControlValue(form, 'bFrames', live.bFrames ?? 2);
  setControlValue(form, 'referenceFrames', live.referenceFrames ?? 3);
  setControlValue(form, 'aqStrength', live.aqStrength ?? 8);
  setControlValue(form, 'pixelFormat', live.pixelFormat || 'yuv420p');
  setControlValue(form, 'colorRange', live.colorRange || 'tv');
  setControlValue(form, 'customOptions', live.customOptions || '');
  if (form.elements.lookahead) form.elements.lookahead.checked = live.lookahead === true;
  if (form.elements.adaptiveQuantization) form.elements.adaptiveQuantization.checked = live.adaptiveQuantization !== false;
  if (form.elements.sceneDetection) form.elements.sceneDetection.checked = live.sceneDetection !== false;
  if (form.elements.repeatHeaders) form.elements.repeatHeaders.checked = live.repeatHeaders !== false;
  setControlValue(form, 'outputResolution', video.outputResolution || '1920x1080');
  setControlValue(form, 'fps', video.fps || '59.94');
  setControlValue(form, 'sampleRate', audio.sampleRate || '48000');
  setControlValue(form, 'channels', audio.channels || 'stereo');
  setControlValue(form, 'audioBitrateKbps', firstTrack.bitrateKbps || 320);
  if (form.elements.delayEnabled) form.elements.delayEnabled.checked = live.delayEnabled === true;
  setControlValue(form, 'delaySeconds', live.delaySeconds ?? 20);
}

function updateRoomEditUi() {
  $('#roomFormTitle').textContent = editingRoomId ? '修改本地直播间' : '创建本地直播间';
  $('#roomSubmitBtn').textContent = editingRoomId ? '保存修改' : '保存直播间';
  $('#cancelRoomEditBtn').hidden = !editingRoomId;
}

function resetRoomForm() {
  editingRoomId = null;
  $('#roomForm').reset();
  updateRoomEditUi();
}

function setEntityFormVisible(selector, visible, { focus = false } = {}) {
  const form = $(selector);
  if (!form) return;
  form.hidden = !visible;
  if (!visible) return;
  refreshIcons();
  requestAnimationFrame(() => {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focus && form.elements.name) form.elements.name.focus();
  });
}

function openNewRoomForm() {
  resetRoomForm();
  show('rooms');
  setEntityFormVisible('#roomForm', true, { focus: true });
}

function closeRoomForm() {
  resetRoomForm();
  setEntityFormVisible('#roomForm', false);
}

function updatePipelineEditUi() {
  const editing = Boolean(editingPipelineId);
  const title = $('#pipelineForm h2');
  if (title) title.textContent = editing ? '修改分发任务' : '创建分发任务';
  $('#pipelineSubmitBtn').textContent = pipelineSubmitPending ? '正在保存...' : editing ? '保存修改' : '保存任务';
  $('#pipelineSubmitBtn').disabled = pipelineSubmitPending;
  $('#cancelPipelineEditBtn').hidden = !editing;
}

function setPipelineSubmitPending(pending) {
  pipelineSubmitPending = Boolean(pending);
  updatePipelineEditUi();
}

function resetPipelineForm() {
  advancePipelineFormGeneration();
  editingPipelineId = null;
  pipelineWatermarks = [];
  pipelineNoSignalImage = null;
  pipelineSlideshow = { images: [], intervalMs: 2000, transitionMs: 700, loop: true };
  $('#pipelineForm').reset();
  fillSettingsForm($('#pipelineForm'), {});
  setControlValue($('#pipelineForm'), 'captureResolution', '1920x1080');
  setControlValue($('#pipelineForm'), 'captureFps', '59.94');
  setControlValue($('#pipelineForm'), 'captureBackend', 'v4l2');
  setControlValue($('#pipelineForm'), 'decklinkFormatCode', 'auto');
  setControlValue($('#pipelineForm'), 'decklinkRawFormat', 'uyvy422');
  setControlValue($('#pipelineForm'), 'decklinkAudioChannels', '2');
  setSelectedDestinationIds([]);
  $('#watermarkStatus').classList.remove('error');
  $('#slideshowStatus').classList.remove('error');
  $('#noSignalImageStatus').classList.remove('error');
  $('#uploadWatermarkBtn').disabled = false;
  $('#uploadSlideshowBtn').disabled = false;
  if ($('#pipelineValidationSummary')) {
    $('#pipelineValidationSummary').hidden = true;
    $('#pipelineValidationSummary').textContent = '';
  }
  renderPipelineOverlays();
  renderNoSignalImage();
  updateInputFields();
  syncLiveDelayControls();
  syncEncodingControls();
  switchPipelineSection('basic', { focus: false });
  updatePipelineEditUi();
}

function setPipelineFormVisible(visible, { focus = false } = {}) {
  const form = $('#pipelineForm');
  if (!form) return;
  form.hidden = !visible;
  if (!visible) return;
  refreshIcons();
  requestAnimationFrame(() => {
    form.scrollIntoView({ behavior: 'smooth', block: 'start' });
    if (focus) form.elements.name && form.elements.name.focus();
  });
}

function openNewPipelineForm() {
  resetPipelineForm();
  show('distribution');
  setPipelineFormVisible(true, { focus: true });
}

function closePipelineForm() {
  resetPipelineForm();
  setPipelineFormVisible(false);
}

function updateDestinationEditUi() {
  const editing = Boolean(editingDestinationId);
  $('#destinationFormTitle').textContent = editing ? '修改输出目标' : '新建输出目标';
  $('#destinationSubmitBtn').textContent = editing ? '保存修改' : '保存输出目标';
  $('#cancelDestinationEditBtn').hidden = !editing;
}

function resetDestinationForm() {
  editingDestinationId = null;
  $('#destinationForm').reset();
  updateDestinationEditUi();
}

function openNewDestinationForm() {
  resetDestinationForm();
  show('destinations');
  setEntityFormVisible('#destinationForm', true, { focus: true });
}

function closeDestinationForm() {
  resetDestinationForm();
  setEntityFormVisible('#destinationForm', false);
}

async function loadState() {
  const previousMonitor = state && state.monitor;
  const nextState = await api('/api/state?history=none');
  if (previousMonitor && nextState.monitor) {
    nextState.monitor = mergeLiveMonitorSnapshot(previousMonitor, nextState.monitor, monitorRangeSec);
  }
  state = nextState;
  renderAll();
}

function emptySceneDraft() {
  return { name: '', sourceType: 'playlist', playlist: [], stream: { url: '' }, watermarks: [] };
}

function cloneSceneDraft(scene) {
  if (!scene) return emptySceneDraft();
  return {
    name: String(scene.name || ''),
    sourceType: scene.sourceType === 'stream' ? 'stream' : 'playlist',
    playlist: Array.isArray(scene.playlist) ? [...scene.playlist] : [],
    stream: { url: String(scene.stream && scene.stream.url || '') },
    watermarks: Array.isArray(scene.watermarks) ? scene.watermarks.map(item => ({ ...item })) : [],
  };
}

function findScene(id) {
  return (state && state.scenes || []).find(scene => scene.id === id);
}

function findMediaAsset(id) {
  return (state && state.mediaAssets || []).find(asset => asset.id === id);
}

function selectStudioScene(id) {
  const scene = findScene(id);
  selectedSceneId = scene ? scene.id : '';
  sceneDraft = cloneSceneDraft(scene);
  renderSceneWorkspace();
}

function startNewScene() {
  selectedSceneId = '';
  sceneDraft = emptySceneDraft();
  studioTab = 'scenes';
  renderStudioWorkspace();
  $('#sceneName').focus();
}

function switchStudioTab(tab) {
  if (!['scenes', 'media', 'recordings'].includes(tab)) return;
  studioTab = tab;
  renderStudioWorkspace();
}

function renderStudioTabs() {
  $$('[data-studio-tab]').forEach(button => {
    const active = button.dataset.studioTab === studioTab;
    button.classList.toggle('active', active);
    button.setAttribute('aria-selected', String(active));
  });
  $$('[data-studio-panel]').forEach(panel => {
    panel.hidden = panel.dataset.studioPanel !== studioTab;
  });
}

function renderSceneRail() {
  const scenes = state.scenes || [];
  $('#sceneCount').textContent = String(scenes.length);
  $('#sceneRail').innerHTML = scenes.map(scene => {
    const active = scene.id === selectedSceneId;
    const sourceLabel = scene.sourceType === 'stream'
      ? '网络流'
      : `${(scene.playlist || []).length} 个视频`;
    return `<div class="scene-rail-item ${active ? 'active' : ''}">
      <button type="button" data-action="select-scene" data-id="${escapeHtml(scene.id)}" aria-current="${active ? 'true' : 'false'}">
        <strong>${escapeHtml(scene.name)}</strong><span>${escapeHtml(sourceLabel)}</span>
      </button>
      <button class="danger scene-delete-icon icon-button" type="button" data-action="delete-scene" data-id="${escapeHtml(scene.id)}" title="删除场景" aria-label="删除场景 ${escapeHtml(scene.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
    </div>`;
  }).join('') || '<p class="studio-empty">还没有场景。</p>';
  bindRendererActions($('#sceneRail'));
  refreshIcons();
}

function renderSceneSourceType() {
  const type = sceneDraft.sourceType === 'stream' ? 'stream' : 'playlist';
  $$('[data-scene-source-type]').forEach(button => {
    const active = button.dataset.sceneSourceType === type;
    button.classList.toggle('active', active);
    button.setAttribute('aria-pressed', String(active));
  });
  $$('[data-scene-source-panel]').forEach(panel => {
    panel.hidden = panel.dataset.sceneSourcePanel !== type;
  });
}

function renderScenePlaylist() {
  const playlist = sceneDraft.playlist || [];
  $('#scenePlaylist').innerHTML = playlist.map((mediaId, index) => {
    const asset = findMediaAsset(mediaId);
    return `<div class="scene-playlist-item">
      <span class="scene-playlist-order">${index + 1}</span>
      <div><strong>${escapeHtml(asset ? asset.name : '素材已删除')}</strong><small>${escapeHtml(asset ? formatMediaDuration(asset.durationSec) : mediaId)}</small></div>
      <div class="scene-playlist-actions">
        <button class="icon-button" type="button" data-action="move-scene-media" data-index="${index}" data-direction="-1" title="上移" aria-label="上移 ${escapeHtml(asset && asset.name || '视频')}" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up" aria-hidden="true"></i></button>
        <button class="icon-button" type="button" data-action="move-scene-media" data-index="${index}" data-direction="1" title="下移" aria-label="下移 ${escapeHtml(asset && asset.name || '视频')}" ${index === playlist.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down" aria-hidden="true"></i></button>
        <button class="danger" type="button" data-action="remove-scene-media" data-index="${index}">移除</button>
      </div>
    </div>`;
  }).join('') || '<p class="studio-empty">播放列表为空，点击“添加视频”从素材库选择。</p>';
  bindRendererActions($('#scenePlaylist'));
  refreshIcons();
}

function renderSceneWatermarks() {
  const watermarks = sceneDraft.watermarks || [];
  $('#sceneWatermarkList').innerHTML = watermarks.map((item, index) => `<div class="overlay-item">
    <img class="overlay-thumb" src="${escapeHtml(item.url || '')}" alt="">
    <div><strong>${escapeHtml(item.name || item.id || '未命名水印')}</strong><small>图层 ${index + 1}</small></div>
    <div class="overlay-item-actions">
      <button class="icon-button" type="button" data-action="move-scene-watermark" data-index="${index}" data-direction="-1" title="上移" aria-label="上移水印 ${index + 1}" ${index === 0 ? 'disabled' : ''}><i data-lucide="chevron-up" aria-hidden="true"></i></button>
      <button class="icon-button" type="button" data-action="move-scene-watermark" data-index="${index}" data-direction="1" title="下移" aria-label="下移水印 ${index + 1}" ${index === watermarks.length - 1 ? 'disabled' : ''}><i data-lucide="chevron-down" aria-hidden="true"></i></button>
      <button class="danger icon-button" type="button" data-action="remove-scene-watermark" data-index="${index}" title="移除" aria-label="移除水印 ${index + 1}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
    </div>
  </div>`).join('');
  $('#sceneWatermarkStatus').textContent = watermarks.length
    ? `已添加 ${watermarks.length} 张，越靠后的水印层级越高。`
    : '当前场景不叠加独立水印。';
  bindRendererActions($('#sceneWatermarkList'));
  refreshIcons();
}

function renderSceneWorkspace() {
  const scenes = state.scenes || [];
  if (selectedSceneId && !findScene(selectedSceneId)) selectedSceneId = '';
  if (!sceneDraft) {
    if (scenes.length) {
      selectedSceneId = scenes[0].id;
      sceneDraft = cloneSceneDraft(scenes[0]);
    } else {
      sceneDraft = emptySceneDraft();
    }
  }
  renderSceneRail();
  $('#sceneFormTitle').textContent = selectedSceneId ? '编辑场景' : '新建场景';
  $('#sceneName').value = sceneDraft.name || '';
  $('#sceneStreamUrl').value = sceneDraft.stream && sceneDraft.stream.url || '';
  $('#deleteSceneBtn').hidden = !selectedSceneId;
  $('#saveSceneBtn').textContent = studioActionPending ? '正在保存…' : selectedSceneId ? '保存修改' : '保存场景';
  $('#saveSceneBtn').disabled = studioActionPending;
  renderSceneSourceType();
  renderScenePlaylist();
  renderSceneWatermarks();
}

function formatMediaBytes(value) {
  const bytes = Number(value) || 0;
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GB`;
  if (bytes >= 1024 ** 2) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function formatMediaDuration(value) {
  const seconds = Math.max(0, Math.round(Number(value) || 0));
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const remainder = seconds % 60;
  return hours
    ? `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`
    : `${String(minutes).padStart(2, '0')}:${String(remainder).padStart(2, '0')}`;
}

function renderMediaLibrary() {
  const assets = state.mediaAssets || [];
  if (selectedMediaPreviewId && !findMediaAsset(selectedMediaPreviewId)) selectedMediaPreviewId = '';
  $('#mediaLibrary').innerHTML = assets.map(asset => `<article class="media-item ${asset.id === selectedMediaPreviewId ? 'active' : ''}">
    <button class="media-item-main" type="button" data-action="preview-media" data-id="${escapeHtml(asset.id)}">
      <span class="media-file-mark" aria-hidden="true"><i data-lucide="play" aria-hidden="true"></i></span>
      <span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(formatMediaDuration(asset.durationSec))} · ${escapeHtml(asset.width || 0)}×${escapeHtml(asset.height || 0)} · ${escapeHtml(formatMediaBytes(asset.sizeBytes))}</small></span>
    </button>
    <button class="danger" type="button" data-action="delete-media" data-id="${escapeHtml(asset.id)}">删除</button>
  </article>`).join('') || '<p class="studio-empty">还没有视频素材，请先上传。</p>';
  bindRendererActions($('#mediaLibrary'));
  refreshIcons();
  renderMediaPreview();
}

function renderMediaPreview() {
  const asset = findMediaAsset(selectedMediaPreviewId);
  const video = $('#mediaPreview');
  if (!asset) {
    video.pause();
    video.removeAttribute('src');
    video.dataset.assetId = '';
    video.hidden = true;
    $('#mediaPreviewEmpty').hidden = false;
    $('#mediaPreviewMeta').textContent = '';
    return;
  }
  if (video.dataset.assetId !== asset.id) {
    video.src = asset.url;
    video.dataset.assetId = asset.id;
    video.load();
  }
  video.hidden = false;
  $('#mediaPreviewEmpty').hidden = true;
  $('#mediaPreviewMeta').textContent = `${asset.name} · ${formatMediaDuration(asset.durationSec)} · ${asset.videoCodec || '未知编码'}`;
}

function recordingStatusLabel(status) {
  return ({ recording: '录制中', finalizing: '正在保存', completed: '已完成', failed: '失败' })[status] || status || '未知';
}

function renderRecordingCapacity() {
  const panel = $('#recordingCapacity');
  const data = recordingCapacityState.data;
  const bitrate = Number(data && data.bitrateKbps);
  const hourlyBytes = Number(data && data.requiredBytesPerHour);
  const availableBytes = data && data.availableBytes !== null ? Number(data.availableBytes) : null;
  const availableHours = data && data.availableHours !== null ? Number(data.availableHours) : null;
  $('#recordingBitrateValue').textContent = Number.isFinite(bitrate) && bitrate > 0
    ? `${Math.round(bitrate)} Kbps${data.bitrateSource === 'measured' ? ' · 实测' : ' · 按配置估算'}`
    : '--';
  $('#recordingHourlyStorage').textContent = Number.isFinite(hourlyBytes) && hourlyBytes > 0
    ? formatMediaBytes(hourlyBytes)
    : '--';
  $('#recordingAvailableStorage').textContent = availableBytes !== null && Number.isFinite(availableBytes) && availableBytes >= 0
    ? formatMediaBytes(availableBytes)
    : '--';
  $('#recordingAvailableHours').textContent = availableHours !== null && Number.isFinite(availableHours) && availableHours >= 0
    ? `${availableHours.toFixed(1)} 小时`
    : '--';
  const warning = Boolean(recordingCapacityState.error || data && !data.sufficient);
  panel.classList.toggle('warning', warning);
  if (recordingCapacityState.loading) {
    $('#recordingCapacityMessage').textContent = '正在读取录制盘容量…';
  } else if (recordingCapacityState.error) {
    $('#recordingCapacityMessage').textContent = recordingCapacityState.error;
  } else if (!data) {
    $('#recordingCapacityMessage').textContent = '请选择运行中的分发任务。';
  } else if (data.availableBytes === null || data.availableHours === null) {
    $('#recordingCapacityMessage').textContent = '无法读取录制盘的可用空间。';
  } else if (data.sufficient) {
    $('#recordingCapacityMessage').textContent = '当前磁盘空间足够录制至少 1 小时。';
  } else {
    $('#recordingCapacityMessage').textContent = '当前磁盘空间不足以录制 1 小时。';
  }
}

async function loadRecordingCapacity(pipelineId) {
  const selectedPipelineId = String(pipelineId || '');
  const requestId = ++recordingCapacityRequestId;
  recordingCapacityState = {
    pipelineId: selectedPipelineId,
    data: null,
    loading: Boolean(selectedPipelineId),
    error: '',
  };
  renderRecordingCapacity();
  if (!selectedPipelineId) return;
  try {
    const data = await api(`/api/recordings/capacity?pipelineId=${encodeURIComponent(selectedPipelineId)}`);
    if (requestId !== recordingCapacityRequestId) return;
    recordingCapacityState = { pipelineId: selectedPipelineId, data, loading: false, error: '' };
  } catch (error) {
    if (requestId !== recordingCapacityRequestId) return;
    recordingCapacityState = {
      pipelineId: selectedPipelineId,
      data: null,
      loading: false,
      error: error.message || '无法读取录制盘容量。',
    };
  }
  renderRecordingCapacity();
}

function renderRecordingWorkspace() {
  const running = runningStudioPipelines(state.pipelines || [], state.monitor || {});
  const select = $('#recordingPipeline');
  const current = select.value;
  select.innerHTML = running.map(pipeline => `<option value="${escapeHtml(pipeline.id)}">${escapeHtml(pipeline.name)}</option>`).join('')
    || '<option value="">没有运行中的共享转推任务</option>';
  if (running.some(pipeline => pipeline.id === current)) select.value = current;
  $('#startRecordingBtn').disabled = studioActionPending || !running.length;
  if (recordingCapacityState.pipelineId !== select.value) loadRecordingCapacity(select.value);
  else renderRecordingCapacity();

  const jobs = state.recordingJobs || [];
  $('#recordingJobs').innerHTML = jobs.map(job => {
    const active = job.status === 'recording';
    const removable = ['completed', 'failed'].includes(job.status);
    const startedAt = job.startedAt ? new Date(job.startedAt).toLocaleString('zh-CN', { hour12: false }) : '-';
    return `<article class="recording-job">
      <div><span class="recording-dot ${active ? 'active' : ''}" aria-hidden="true"></span><strong>${escapeHtml(job.name || '未命名录制')}</strong><small>${escapeHtml(job.pipelineName || job.pipelineId || '')} · ${escapeHtml(startedAt)}</small></div>
      <span class="badge ${escapeHtml(job.status || '')}">${escapeHtml(recordingStatusLabel(job.status))}</span>
      ${job.error ? `<p class="error">${escapeHtml(job.error)}</p>` : ''}
      ${active ? `<div class="recording-job-actions">
        <button type="button" data-action="stop-recording" data-id="${escapeHtml(job.id)}">停止并保存</button>
        <button class="primary" type="button" data-action="replay-recording" data-id="${escapeHtml(job.id)}">停止并重播</button>
      </div>` : removable ? `<div class="recording-job-actions">
        <button class="danger" type="button" data-action="delete-recording" data-id="${escapeHtml(job.id)}">删除</button>
      </div>` : ''}
    </article>`;
  }).join('') || '<p class="studio-empty">还没有录制任务。</p>';
  bindRendererActions($('#recordingJobs'));
  refreshIcons();
}

function renderStudioWorkspace() {
  if (!state) return;
  renderStudioTabs();
  renderSceneWorkspace();
  renderMediaLibrary();
  renderRecordingWorkspace();
}

function scenePayloadFromEditor() {
  sceneDraft.name = String($('#sceneName').value || '').trim();
  sceneDraft.stream = { url: String($('#sceneStreamUrl').value || '').trim() };
  return {
    name: sceneDraft.name,
    sourceType: sceneDraft.sourceType,
    playlist: [...sceneDraft.playlist],
    stream: { ...sceneDraft.stream },
    watermarks: sceneDraft.watermarks.map(item => ({ ...item })),
  };
}

async function saveScene() {
  if (studioActionPending) return;
  const payload = scenePayloadFromEditor();
  if (!payload.name) return alert('请输入场景名称');
  if (payload.sourceType === 'playlist' && !payload.playlist.length) return alert('请至少添加一个视频素材');
  if (payload.sourceType === 'stream' && !/^(?:rtmps?|srt|https?):\/\//i.test(payload.stream.url)) {
    return alert('请输入有效的 RTMP、RTMPS、SRT、HTTP 或 HTTPS 流地址');
  }
  studioActionPending = true;
  renderSceneWorkspace();
  try {
    const saved = await api(selectedSceneId ? `/api/scenes/${encodeURIComponent(selectedSceneId)}` : '/api/scenes', {
      method: selectedSceneId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    selectedSceneId = saved.id;
    sceneDraft = cloneSceneDraft(saved);
    await loadState();
    showToast('场景已保存');
  } catch (error) {
    $('#sceneFormStatus').textContent = error.message;
    $('#sceneFormStatus').classList.add('error');
  } finally {
    studioActionPending = false;
    renderStudioWorkspace();
  }
}

async function deleteScene(id) {
  const scene = findScene(id);
  if (!scene || !confirm(`确认删除场景“${scene.name}”？`)) return;
  await api(`/api/scenes/${encodeURIComponent(id)}`, { method: 'DELETE' });
  if (selectedSceneId === id) {
    selectedSceneId = '';
    sceneDraft = null;
  }
  await loadState();
  showToast('场景已删除');
}

function openMediaPicker() {
  const assets = state.mediaAssets || [];
  $('#mediaPickerList').innerHTML = assets.map(asset => `<label class="media-picker-item">
    <input type="checkbox" value="${escapeHtml(asset.id)}">
    <span><strong>${escapeHtml(asset.name)}</strong><small>${escapeHtml(formatMediaDuration(asset.durationSec))} · ${escapeHtml(formatMediaBytes(asset.sizeBytes))}</small></span>
  </label>`).join('') || '<p class="studio-empty">素材库为空，请先到“视频素材”上传视频。</p>';
  $('#confirmMediaSelectionBtn').disabled = !assets.length;
  const dialog = $('#mediaPickerDialog');
  if (!dialog.open) dialog.showModal();
}

function confirmMediaSelection() {
  const selected = $$('#mediaPickerList input[type="checkbox"]:checked').map(input => input.value);
  if (!selected.length) return alert('请至少选择一个视频');
  for (const mediaId of selected) sceneDraft.playlist = appendSceneMedia(sceneDraft.playlist, mediaId);
  $('#mediaPickerDialog').close();
  renderScenePlaylist();
}

function uploadMediaFileWithProgress(file, onProgress) {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();
    const cancel = () => {
      if (request.readyState !== XMLHttpRequest.DONE) request.abort();
    };
    const cleanup = () => {
      if (mediaUploadCancel === cancel) mediaUploadCancel = null;
    };
    request.open('POST', `/api/media-assets?name=${encodeURIComponent(file.name)}`);
    mediaUploadCancel = cancel;
    request.setRequestHeader('content-type', file.type || 'application/octet-stream');
    request.upload.addEventListener('progress', event => {
      if (event.lengthComputable) onProgress(Math.min(100, event.loaded / event.total * 100));
    });
    request.addEventListener('load', () => {
      let payload = {};
      try { payload = JSON.parse(request.responseText || '{}'); } catch {}
      cleanup();
      if (request.status >= 200 && request.status < 300) resolve(payload);
      else reject(new Error(payload.error || `HTTP ${request.status}`));
    });
    request.addEventListener('error', () => {
      cleanup();
      reject(new Error('网络连接中断，上传未完成'));
    });
    request.addEventListener('abort', () => {
      cleanup();
      const error = new Error('上传已取消');
      error.code = 'UPLOAD_CANCELLED';
      reject(error);
    });
    request.send(file);
  });
}

function renderMediaUploadSelection() {
  const input = $('#mediaUploadInput');
  const label = $('#mediaUploadSelection');
  if (!input || !label) return;
  const files = Array.from(input.files || []);
  const names = files.map(file => file.name);
  label.textContent = names.length === 0
    ? '选择视频文件'
    : names.length === 1
      ? names[0]
      : `已选择 ${names.length} 个视频`;
  label.title = names.join('\n');
}

function updateMediaUploadProgress(fileIndex, fileCount, percent, fileName) {
  const progress = $('#mediaUploadProgress');
  progress.hidden = false;
  const overall = Math.round(((fileIndex + percent / 100) / fileCount) * 100);
  $('#mediaUploadProgressLabel').textContent = `${fileIndex + 1}/${fileCount} · ${fileName}`;
  $('#mediaUploadProgressValue').textContent = `${overall}%`;
  $('#mediaUploadProgressBar').value = overall;
}

async function uploadMediaFiles() {
  if (studioActionPending) return;
  const input = $('#mediaUploadInput');
  const files = Array.from(input.files || []);
  if (!files.length) return alert('请先选择视频文件');
  studioActionPending = true;
  mediaUploadCancelRequested = false;
  $('#uploadMediaBtn').disabled = true;
  $('#cancelMediaUploadBtn').hidden = false;
  $('#mediaUploadProgress').hidden = false;
  $('#mediaUploadProgressBar').value = 0;
  $('#mediaUploadProgressLabel').textContent = `准备上传 ${files.length} 个视频`;
  $('#mediaUploadProgressValue').textContent = '0%';
  $('#mediaUploadStatus').classList.remove('error');
  try {
    let lastAsset = null;
    for (let index = 0; index < files.length; index += 1) {
      if (mediaUploadCancelRequested) throw Object.assign(new Error('上传已取消'), { code: 'UPLOAD_CANCELLED' });
      const file = files[index];
      $('#mediaUploadStatus').textContent = `正在上传 ${index + 1}/${files.length}：${file.name}`;
      lastAsset = await uploadMediaFileWithProgress(file, percent => {
        updateMediaUploadProgress(index, files.length, percent, file.name);
      });
      updateMediaUploadProgress(index, files.length, 100, file.name);
    }
    input.value = '';
    renderMediaUploadSelection();
    selectedMediaPreviewId = lastAsset && lastAsset.id || '';
    await loadState();
    $('#mediaUploadStatus').textContent = `已上传 ${files.length} 个视频`;
    showToast('视频素材已上传');
  } catch (error) {
    const cancelled = error && error.code === 'UPLOAD_CANCELLED';
    $('#mediaUploadStatus').textContent = cancelled ? '已取消上传' : error.message;
    $('#mediaUploadStatus').classList.toggle('error', !cancelled);
    $('#mediaUploadProgressLabel').textContent = cancelled ? '上传已取消' : '上传失败';
  } finally {
    studioActionPending = false;
    mediaUploadCancel = null;
    mediaUploadCancelRequested = false;
    $('#uploadMediaBtn').disabled = false;
    $('#cancelMediaUploadBtn').hidden = true;
  }
}

function cancelMediaUpload() {
  if (!studioActionPending) return;
  mediaUploadCancelRequested = true;
  if (mediaUploadCancel) mediaUploadCancel();
}

async function deleteMediaAsset(id) {
  const asset = findMediaAsset(id);
  if (!asset || !confirm(`确认删除视频素材“${asset.name}”？`)) return;
  try {
    await api(`/api/media-assets/${encodeURIComponent(id)}`, { method: 'DELETE' });
    if (selectedMediaPreviewId === id) selectedMediaPreviewId = '';
    await loadState();
    showToast('视频素材已删除');
  } catch (error) {
    alert(error.message);
  }
}

async function uploadSceneWatermarks() {
  const files = Array.from($('#sceneWatermarkFile').files || []);
  if (!files.length) return alert('请先选择水印图片');
  if (sceneDraft.watermarks.length + files.length > MAX_OVERLAY_IMAGES) return alert(`场景最多添加 ${MAX_OVERLAY_IMAGES} 张水印`);
  if (files.some(file => !['image/png', 'image/jpeg', 'image/webp'].includes(file.type))) return alert('水印仅支持 PNG、JPEG 或 WebP');
  if (files.some(file => file.size > 10 * 1024 * 1024)) return alert('每张水印不能超过 10 MiB');
  $('#uploadSceneWatermarkBtn').disabled = true;
  try {
    for (const file of files) {
      const data = await readFileAsDataUrl(file);
      const uploaded = await api('/api/watermarks', {
        method: 'POST', body: JSON.stringify({ name: file.name, mimeType: file.type, data }),
      });
      sceneDraft.watermarks.push({ ...uploaded });
    }
    $('#sceneWatermarkFile').value = '';
    renderSceneWatermarks();
    showToast('场景水印已添加');
  } catch (error) {
    $('#sceneWatermarkStatus').textContent = error.message;
    $('#sceneWatermarkStatus').classList.add('error');
  } finally {
    $('#uploadSceneWatermarkBtn').disabled = false;
  }
}

async function startStudioRecording(form) {
  if (studioActionPending) return;
  const fd = new FormData(form);
  const pipelineId = String(fd.get('pipelineId') || '');
  const name = String(fd.get('name') || '').trim();
  if (!pipelineId) return alert('请选择运行中的共享转推任务');
  if (!name) return alert('请输入录制名称');
  studioActionPending = true;
  renderRecordingWorkspace();
  try {
    await api('/api/recordings', { method: 'POST', body: JSON.stringify({ pipelineId, name }) });
    form.elements.name.value = '';
    await loadState();
    loadRecordingCapacity(pipelineId);
    showToast('已开始录制 Program 画面');
  } catch (error) {
    $('#recordingStatus').textContent = error.message;
  } finally {
    studioActionPending = false;
    renderRecordingWorkspace();
  }
}

async function stopStudioRecording(id, replay) {
  const message = replay ? '确认停止录制并立即从头重播？' : '确认停止录制并保存为视频素材？';
  if (studioActionPending || !confirm(message)) return;
  studioActionPending = true;
  renderRecordingWorkspace();
  try {
    await api(`/api/recordings/${encodeURIComponent(id)}/stop`, {
      method: 'POST', body: JSON.stringify({ replay: Boolean(replay) }),
    });
    await loadState();
    showToast(replay ? '录制已完成并从 00:00:00 开始重播' : '录制已保存到视频素材');
  } catch (error) {
    alert(error.message);
  } finally {
    studioActionPending = false;
    renderRecordingWorkspace();
  }
}

async function deleteStudioRecording(id) {
  if (studioActionPending || !confirm('确认删除这条录制任务记录？已生成的视频素材会保留。')) return;
  studioActionPending = true;
  renderRecordingWorkspace();
  try {
    await api(`/api/recordings/${encodeURIComponent(id)}`, { method: 'DELETE' });
    await loadState();
    showToast('录制任务记录已删除');
  } catch (error) {
    alert(error.message);
  } finally {
    studioActionPending = false;
    renderRecordingWorkspace();
  }
}

function switcherPipeline() {
  return (state && state.pipelines || []).find(pipeline => pipeline.id === studioSwitcherState.pipelineId);
}

function switcherScene() {
  return findScene(studioSwitcherState.sceneId);
}

function describeProgram(program, pipeline) {
  if (!program || program.kind === 'original') return {
    title: '当前直播源',
    source: program && program.sourceLabel || describePipelineInput(pipeline || {}),
  };
  if (program.kind === 'scene') return { title: program.label || '画面场景', source: program.sourceLabel || '场景输入源' };
  if (program.kind === 'recording') return { title: program.label || '录制重播', source: program.sourceLabel || '录制文件' };
  return { title: program.label || '视频素材', source: program.sourceLabel || '视频素材' };
}

function renderSwitcherProgramLabels() {
  const pipeline = switcherPipeline();
  const program = state && state.programs && state.programs[studioSwitcherState.pipelineId];
  const descriptor = describeProgram(program, pipeline);
  $('#programSceneLabel').textContent = descriptor.title;
  $('#programSourceLabel').textContent = descriptor.source;
}

function renderSwitcherSceneOptions() {
  const scenes = state.scenes || [];
  $('#switcherSceneSelect').innerHTML = scenes.map(scene => (
    `<option value="${escapeHtml(scene.id)}">${escapeHtml(scene.name)}</option>`
  )).join('') || '<option value="">还没有可用场景</option>';
  if (scenes.some(scene => scene.id === studioSwitcherState.sceneId)) {
    $('#switcherSceneSelect').value = studioSwitcherState.sceneId;
  }
  $('#switchSceneBtn').disabled = studioSwitcherState.busy || !scenes.length;
  $('#restoreProgramBtn').disabled = studioSwitcherState.busy;
}

function renderSwitcherPreviewOverlays(scene) {
  $('#switcherPreviewOverlays').innerHTML = (scene && scene.watermarks || []).map(item => (
    `<img src="${escapeHtml(item.url || '')}" alt="">`
  )).join('');
}

function resetSwitcherPreviewElements() {
  const video = $('#switcherPreviewVideo');
  video.pause();
  video.removeAttribute('src');
  video.dataset.assetId = '';
  video.hidden = true;
  const image = $('#switcherPreviewImage');
  image.removeAttribute('src');
  image.hidden = true;
  $('#switcherPreviewEmpty').hidden = false;
  $('#previewPlaybackBtn').hidden = true;
  $('#switcherPreviewProgress').textContent = '待命';
  studioSwitcherState.previewPlaying = false;
}

async function stopStudioPreviewSession(id) {
  if (!id) return;
  try {
    await api(`/api/previews/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' });
  } catch {
  }
}

async function releaseScenePreviewSession() {
  const id = studioSwitcherState.previewSessionId;
  studioSwitcherState.previewSessionId = '';
  $('#switcherPreviewImage').removeAttribute('src');
  await stopStudioPreviewSession(id);
}

function updateSwitcherPlaybackUi() {
  const scene = switcherScene();
  const playlist = scene && scene.sourceType === 'playlist' ? scene.playlist || [] : [];
  const asset = findMediaAsset(playlist[studioSwitcherState.previewIndex]);
  $('#previewPlaybackBtn').textContent = studioSwitcherState.previewPlaying ? '暂停' : '播放';
  $('#switcherPreviewProgress').textContent = asset
    ? `${studioSwitcherState.previewIndex + 1}/${playlist.length} · ${asset.name}`
    : '等待视频素材';
}

async function playSwitcherVideoAt(index, { restart = false } = {}) {
  const scene = switcherScene();
  const playlist = scene && scene.sourceType === 'playlist' ? scene.playlist || [] : [];
  if (!playlist.length) {
    resetSwitcherPreviewElements();
    $('#switcherPreviewEmpty').textContent = '这个场景的播放列表为空。';
    return;
  }
  const normalizedIndex = Math.max(0, Math.min(Number(index) || 0, playlist.length - 1));
  const asset = findMediaAsset(playlist[normalizedIndex]);
  if (!asset) {
    resetSwitcherPreviewElements();
    $('#switcherPreviewEmpty').textContent = '播放列表中的视频素材已不存在。';
    return;
  }
  studioSwitcherState.previewIndex = normalizedIndex;
  const video = $('#switcherPreviewVideo');
  $('#switcherPreviewImage').hidden = true;
  $('#switcherPreviewEmpty').hidden = true;
  video.hidden = false;
  $('#previewPlaybackBtn').hidden = false;
  if (video.dataset.assetId !== asset.id) {
    video.src = asset.url;
    video.dataset.assetId = asset.id;
    video.load();
  }
  if (restart) {
    try { video.currentTime = 0; } catch {}
  }
  try {
    await video.play();
    studioSwitcherState.previewPlaying = true;
  } catch {
    studioSwitcherState.previewPlaying = false;
  }
  updateSwitcherPlaybackUi();
}

async function selectSwitcherScene(sceneId, { restart = true } = {}) {
  await releaseScenePreviewSession();
  studioSwitcherState.previewMode = 'scene';
  studioSwitcherState.sceneId = String(sceneId || '');
  studioSwitcherState.previewIndex = 0;
  const scene = switcherScene();
  renderSwitcherSceneOptions();
  resetSwitcherPreviewElements();
  renderSwitcherPreviewOverlays(scene);
  $('#previewSceneLabel').textContent = scene ? scene.name : '未选择场景';
  if (!scene) return;
  if (scene.sourceType === 'playlist') {
    await playSwitcherVideoAt(0, { restart });
    return;
  }
  $('#switcherPreviewEmpty').textContent = '正在连接场景网络流…';
  $('#switcherPreviewEmpty').hidden = false;
  try {
    const preview = await api('/api/previews', {
      method: 'POST',
      body: JSON.stringify({ input: { type: 'url', url: scene.stream && scene.stream.url || '' } }),
    });
    if (studioSwitcherState.sceneId !== scene.id || !$('#studioSwitcherDialog').open) {
      await stopStudioPreviewSession(preview.id);
      return;
    }
    studioSwitcherState.previewSessionId = preview.id;
    const image = $('#switcherPreviewImage');
    image.src = `/api/previews/${encodeURIComponent(preview.id)}/stream`;
    image.hidden = false;
    $('#switcherPreviewEmpty').hidden = true;
    $('#switcherPreviewProgress').textContent = scene.stream && scene.stream.url || '网络流';
  } catch (error) {
    $('#switcherPreviewEmpty').textContent = error.message;
  }
}

async function startProgramMonitor() {
  const pipelineId = studioSwitcherState.pipelineId;
  if (!pipelineId) return;
  $('#switcherProgramStatus').hidden = false;
  $('#switcherProgramStatus').textContent = '正在连接当前直播画面…';
  try {
    const preview = await api('/api/previews', {
      method: 'POST', body: JSON.stringify(createProgramPreviewRequest(pipelineId)),
    });
    if (studioSwitcherState.pipelineId !== pipelineId || !$('#studioSwitcherDialog').open) {
      await stopStudioPreviewSession(preview.id);
      return;
    }
    studioSwitcherState.programSessionId = preview.id;
    const image = $('#switcherProgramImage');
    image.src = `/api/previews/${encodeURIComponent(preview.id)}/stream?epoch=${Date.now()}`;
    image.hidden = false;
  } catch (error) {
    $('#switcherProgramStatus').textContent = error.message;
  }
}

async function releaseProgramPreviewSession() {
  const id = studioSwitcherState.programSessionId;
  studioSwitcherState.programSessionId = '';
  const image = $('#switcherProgramImage');
  image.removeAttribute('src');
  image.hidden = true;
  await stopStudioPreviewSession(id);
}

async function restartProgramMonitor() {
  await releaseProgramPreviewSession();
  await startProgramMonitor();
}

async function showPreviousProgramInPreview(program, pipeline) {
  const target = previousProgramPreviewTarget(program, pipeline);
  studioSwitcherState.previousProgram = program || null;
  if (target.kind === 'scene') {
    await selectSwitcherScene(target.sceneId, { restart: true });
    return;
  }

  await releaseScenePreviewSession();
  resetSwitcherPreviewElements();
  studioSwitcherState.previewMode = 'original';
  $('#previewSceneLabel').textContent = '原直播源';
  $('#switcherPreviewEmpty').textContent = '正在连接原直播输入…';
  $('#switcherPreviewEmpty').hidden = false;
  try {
    const preview = await api('/api/previews', {
      method: 'POST', body: JSON.stringify(target.request),
    });
    if (studioSwitcherState.previewMode !== 'original' || !$('#studioSwitcherDialog').open) {
      await stopStudioPreviewSession(preview.id);
      return;
    }
    studioSwitcherState.previewSessionId = preview.id;
    const image = $('#switcherPreviewImage');
    image.src = `/api/previews/${encodeURIComponent(preview.id)}/stream?epoch=${Date.now()}`;
    image.hidden = false;
    $('#switcherPreviewEmpty').hidden = true;
    $('#switcherPreviewProgress').textContent = describePipelineInput(pipeline);
  } catch (error) {
    $('#switcherPreviewEmpty').textContent = error.message;
  }
}

async function openStudioSwitcher(pipelineId) {
  const pipeline = (state.pipelines || []).find(item => item.id === pipelineId);
  const available = runningStudioPipelines(state.pipelines || [], state.monitor || {}).some(item => item.id === pipelineId);
  if (!pipeline || !available) return alert('切换台只支持正在运行的共享转推任务');
  await releaseStudioSwitcher();
  studioSwitcherState.pipelineId = pipelineId;
  studioSwitcherState.sceneId = (state.scenes || [])[0] && state.scenes[0].id || '';
  studioSwitcherState.previewMode = 'scene';
  studioSwitcherState.previousProgram = null;
  $('#studioSwitcherTitle').textContent = `画面切换台 · ${pipeline.name}`;
  $('#studioSwitcherPipeline').textContent = describePipelineInput(pipeline);
  $('#studioSwitcherStatus').textContent = '';
  renderSwitcherSceneOptions();
  renderSwitcherProgramLabels();
  const dialog = $('#studioSwitcherDialog');
  if (!dialog.open) dialog.showModal();
  await Promise.all([
    startProgramMonitor(),
    selectSwitcherScene(studioSwitcherState.sceneId, { restart: true }),
  ]);
}

function setStudioSwitcherBusy(busy, message = '') {
  studioSwitcherState.busy = Boolean(busy);
  $('#studioSwitcherStatus').textContent = message;
  renderSwitcherSceneOptions();
}

async function switchSceneToProgram() {
  const scene = switcherScene();
  if (!scene || studioSwitcherState.busy) return;
  const pipeline = switcherPipeline();
  const previousProgram = state.programs && state.programs[studioSwitcherState.pipelineId] || null;
  await selectSwitcherScene(scene.id, { restart: true });
  setStudioSwitcherBusy(true, '正在切换画面…');
  try {
    await releaseProgramPreviewSession();
    const request = createSceneSwitchRequest(studioSwitcherState.pipelineId, scene.id);
    await api(request.path, request.options);
    await loadState();
    renderSwitcherProgramLabels();
    await restartProgramMonitor();
    await showPreviousProgramInPreview(previousProgram, pipeline);
    $('#studioSwitcherStatus').textContent = `已切换到“${scene.name}”，从第一个视频开始播放`;
  } catch (error) {
    await restartProgramMonitor();
    $('#studioSwitcherStatus').textContent = error.message;
  } finally {
    studioSwitcherState.busy = false;
    renderSwitcherSceneOptions();
  }
}

async function restoreStudioProgram() {
  if (studioSwitcherState.busy) return;
  const sceneId = studioSwitcherState.sceneId;
  setStudioSwitcherBusy(true, '正在切回直播源…');
  try {
    await releaseScenePreviewSession();
    resetSwitcherPreviewElements();
    await releaseProgramPreviewSession();
    const request = createRestoreProgramRequest(studioSwitcherState.pipelineId);
    await api(request.path, request.options);
    await loadState();
    renderSwitcherProgramLabels();
    await restartProgramMonitor();
    await selectSwitcherScene(sceneId, { restart: true });
    $('#studioSwitcherStatus').textContent = '已切回当前分发任务的直播输入源';
  } catch (error) {
    await restartProgramMonitor();
    $('#studioSwitcherStatus').textContent = error.message;
  } finally {
    studioSwitcherState.busy = false;
    renderSwitcherSceneOptions();
  }
}

function detachStudioSwitcher() {
  const ids = [studioSwitcherState.previewSessionId, studioSwitcherState.programSessionId].filter(Boolean);
  const video = $('#switcherPreviewVideo');
  if (video) {
    video.pause();
    video.removeAttribute('src');
    video.dataset.assetId = '';
  }
  for (const selector of ['#switcherPreviewImage', '#switcherProgramImage']) {
    const image = $(selector);
    if (image) image.removeAttribute('src');
  }
  studioSwitcherState = {
    pipelineId: '', sceneId: '', previewMode: 'scene', previousProgram: null,
    previewIndex: 0, previewPlaying: false,
    previewSessionId: '', programSessionId: '', busy: false,
  };
  return ids;
}

async function releaseStudioSwitcher() {
  const ids = detachStudioSwitcher();
  await Promise.all(ids.map(stopStudioPreviewSession));
}

function renderAll() {
  renderSummary();
  renderDashboardResources();
  renderRooms();
  renderPipelines();
  renderDestinations();
  renderStudioWorkspace();
  renderMonitor(state.monitor || { outputs: [], totals: {} });
  refreshIcons();
}

function describePipelineInput(pipeline) {
  const input = pipeline.input || {};
  if (input.type === 'room') {
    const room = (state.rooms || []).find(item => item.id === input.roomId);
    return room ? `本地直播间：${room.name}` : '本地直播间：未找到';
  }
  if (input.type === 'url') return `URL：${input.url || '-'}`;
  if (input.type === 'file') return `本地视频：${input.path || input.url || '-'}`;
  if (input.type === 'capture') {
    const capture = input.capture || {};
    if (capture.backend === 'decklink') {
      return `DeckLink：${capture.device || '未配置'}（${capture.formatCode || 'auto'}）`;
    }
    return `采集卡：${capture.videoDevice || '/dev/video0'}`;
  }
  if (pipeline.sourceId) {
    const source = (state.sources || []).find(item => item.id === pipeline.sourceId);
    return source ? `已保存输入源：${source.name}` : '已保存输入源：未找到';
  }
  return '未配置';
}

function pipelineRuntimeStatus(pipeline) {
  const active = state.monitor && (state.monitor.activePipelines || []).find(item => item.pipelineId === pipeline.id);
  if (active) return active.status || 'running';
  return pipeline.status || 'stopped';
}

function pipelineStatusLabel(status) {
  if (status === 'fallback') return '无信号画面推送中';
  if (status === 'running') return '运行中';
  if (status === 'starting') return '启动中';
  if (status === 'draining') return '正在播完';
  if (status === 'stopped') return '已停止';
  if (status === 'disabled') return '已禁用';
  if (status === 'error') return '异常';
  return status || '已停止';
}

function pipelineRuntimeMessage(pipeline) {
  const active = state.monitor && (state.monitor.activePipelines || []).find(item => item.pipelineId === pipeline.id);
  if (!active) return '';
  if (active.status === 'fallback') {
    return active.message || '输入信号不可用，正在推送无信号画面和静音并等待恢复';
  }
  if (active.status === 'draining') {
    const remainingSeconds = Math.max(0, Math.ceil(Number(active.liveDelay && active.liveDelay.remainingSeconds) || 0));
    return remainingSeconds > 0
      ? `输入已停止，正在播完延时内容，预计还需 ${remainingSeconds} 秒。`
      : '输入已停止，延时内容即将播完。';
  }
  return '';
}

function renderSummary() {
  const monitor = state.monitor || { totals: {} };
  const totalBitrate = formatActualBitrate({
    bitrateKbps: monitor.totals.bitrateKbps,
    actualBitrateAvailable: Boolean(monitor.totals.actualBitrateAvailable),
    actualBitrateStatus: monitor.totals.actualBitrateSampling ? 'sampling' : 'unavailable',
  });
  $('#summaryCards').innerHTML = [
    metric('本地直播间', (state.rooms || []).length),
    metric('运行任务', monitor.totals.pipelines || 0),
    metric('输出路数', monitor.totals.outputs || 0),
    metric('实际输出总码率', totalBitrate),
    metric('异常输出', monitor.totals.errors || 0),
  ].join('');

  const rows = (state.pipelines || []).map(p => {
    const destinations = (p.destinationIds || []).map(id => (state.destinations || []).find(d => d.id === id)).filter(Boolean);
    const status = pipelineRuntimeStatus(p);
    return `<tr>
      <td>${escapeHtml(p.name)}</td>
      <td>${escapeHtml(describePipelineInput(p))}</td>
      <td>${destinations.length}</td>
      <td><span class="badge ${escapeHtml(status)}">${escapeHtml(pipelineStatusLabel(status))}</span></td>
      <td>${escapeHtml(p.mode || 'shared-relay')}</td>
    </tr>`;
  }).join('');

  const cards = (state.pipelines || []).map(p => {
    const status = pipelineRuntimeStatus(p);
    const destinations = (p.destinationIds || []).length;
    const message = pipelineRuntimeMessage(p);
    return `<article class="dashboard-pipeline-card ${escapeHtml(status)}">
      <div class="dashboard-pipeline-card-head"><div><strong>${escapeHtml(p.name)}</strong><small>${escapeHtml(describePipelineInput(p))}</small></div><span class="badge ${escapeHtml(status)}">${escapeHtml(pipelineStatusLabel(status))}</span></div>
      <div class="dashboard-pipeline-card-meta"><span>${destinations} 路输出</span><span>${escapeHtml(p.mode || 'shared-relay')}</span></div>
      ${message ? `<p class="dashboard-pipeline-message">${escapeHtml(message)}</p>` : ''}
    </article>`;
  }).join('');
  $('#dashboardPipelineCards').innerHTML = cards || '<p class="dashboard-empty">还没有分发任务。</p>';
  renderTopbarTelemetry();
}

function dashboardResourceCard(resource) {
  const available = systemResourceAvailable(resource);
  const value = available && Number.isFinite(resource.value) ? Math.max(0, Math.min(100, resource.value)) : 0;
  const summary = formatSystemResourceSummary(resource);
  return `<article class="dashboard-resource-card ${available ? '' : 'is-unavailable'}" style="--resource-accent:${escapeHtml(resource.accent)}">
    <div class="dashboard-gauge" style="--gauge-value:${value * 3.6}deg"><div><strong>${available ? escapeHtml(formatSystemPercent(resource.value, '采样中')) : '--'}</strong><span>${escapeHtml(resource.label)}</span></div></div>
    <div class="dashboard-resource-copy"><strong>${escapeHtml(resource.label)}</strong><span>${escapeHtml(summary)}</span></div>
  </article>`;
}

function renderDashboardResources() {
  const snapshot = systemStatusState.snapshot || {};
  const resources = systemResources(snapshot).filter(resource => ['cpu', 'memory', 'disk', 'gpu'].includes(resource.type));
  const preferred = resources.filter(resource => resource.type !== 'gpu' || systemResourceAvailable(resource));
  $('#dashboardResources').innerHTML = preferred.slice(0, 6).map(dashboardResourceCard).join('') || '<p class="dashboard-empty">正在读取系统资源...</p>';
  renderDashboardNetwork(snapshot);
  renderTopbarTelemetry();
}

function renderTopbarTelemetry() {
  const snapshot = systemStatusState.snapshot || {};
  const monitor = state && state.monitor || { totals: {} };
  const cpuValue = Number(snapshot.cpu && snapshot.cpu.usagePercent);
  const gpuDevices = Array.isArray(snapshot.gpu && snapshot.gpu.devices) ? snapshot.gpu.devices : [];
  const gpuValue = Number(gpuDevices[0] && gpuDevices[0].usagePercent);
  const interfaces = Array.isArray(snapshot.network && snapshot.network.interfaces) ? snapshot.network.interfaces : [];
  const networkDevice = interfaces.find(item => item.name === 'enp86s0') || interfaces[0];
  const setText = (selector, value) => {
    const element = $(selector);
    if (element) element.textContent = value;
  };
  setText('#topbarOutputCount', String(Number(monitor.totals && monitor.totals.outputs) || 0));
  setText('#topbarCpu', Number.isFinite(cpuValue) ? `${Math.round(cpuValue)}%` : '--');
  setText('#topbarGpu', Number.isFinite(gpuValue) ? `${Math.round(gpuValue)}%` : '--');
  setText('#topbarUplink', networkDevice ? formatSystemNetworkRate(networkDevice.sendBytesPerSec, '--') : '--');
}

function drawDashboardNetworkChart(canvas, history) {
  if (!canvas) return;
  const { ctx, w, h } = prepareChartCanvas(canvas);
  const left = 64; const top = 30; const right = 22; const bottom = 48;
  const width = Math.max(1, w - left - right); const height = Math.max(1, h - top - bottom);
  const now = Date.now();
  const start = now - DASHBOARD_NETWORK_WINDOW_MS;
  const pointsInWindow = history.filter(point => point.time >= start && point.time <= now);
  const values = pointsInWindow.flatMap(point => [point.receive, point.send]).filter(Number.isFinite);
  const max = Math.max(1024, ...values) * 1.15;
  ctx.clearRect(0, 0, w, h); ctx.fillStyle = themeColor('--ui-chart-surface', '#fff'); ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = themeColor('--ui-chart-grid', '#e1eaee'); ctx.lineWidth = 1;
  ctx.font = '11px Inter, system-ui, sans-serif';
  for (let i = 0; i <= 4; i += 1) {
    const ratio = i / 4; const y = top + height * ratio; const rate = max * (1 - ratio);
    ctx.beginPath(); ctx.moveTo(left, y); ctx.lineTo(left + width, y); ctx.stroke();
    ctx.fillStyle = themeColor('--ui-chart-label', '#687982'); ctx.textAlign = 'right'; ctx.textBaseline = 'middle';
    ctx.fillText(formatSystemNetworkRate(rate / 8, '0 bps'), left - 8, y);
  }
  const draw = (key, color) => {
    const points = pointsInWindow.map(point => ({ x: left + ((point.time - start) / DASHBOARD_NETWORK_WINDOW_MS) * width, y: top + height - (Number(point[key]) || 0) / max * height })).filter(point => Number.isFinite(point.y));
    if (!points.length) return;
    ctx.strokeStyle = color; ctx.lineWidth = 2.5; ctx.beginPath();
    points.forEach((point, index) => index ? ctx.lineTo(point.x, point.y) : ctx.moveTo(point.x, point.y)); ctx.stroke();
  };
  draw('receive', '#1b9b72'); draw('send', '#2388ff');
  const formatAxisTime = time => new Date(time).toLocaleTimeString('zh-CN', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
  ctx.font = '11px Inter, system-ui, sans-serif'; ctx.fillStyle = themeColor('--ui-chart-label', '#687982'); ctx.textAlign = 'center'; ctx.textBaseline = 'top';
  for (let i = 0; i <= 5; i += 1) {
    const time = start + i * 60_000; const x = left + i / 5 * width;
    ctx.beginPath(); ctx.strokeStyle = themeColor('--ui-chart-grid', '#e1eaee'); ctx.moveTo(x, top + height); ctx.lineTo(x, top + height + 4); ctx.stroke();
    ctx.fillText(formatAxisTime(time), x, top + height + 9);
  }
  ctx.textAlign = 'left'; ctx.textBaseline = 'middle'; ctx.fillStyle = themeColor('--ui-chart-label', '#687982'); ctx.fillText('下载', left, 13); ctx.fillStyle = '#1b9b72'; ctx.fillRect(left + 34, 8, 18, 3); ctx.fillStyle = themeColor('--ui-chart-label', '#687982'); ctx.fillText('上传', left + 68, 13); ctx.fillStyle = '#2388ff'; ctx.fillRect(left + 102, 8, 18, 3);
  if (!pointsInWindow.length) { ctx.fillStyle = themeColor('--ui-chart-label', '#687982'); ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText('正在收集最近 5 分钟流量数据', left + width / 2, top + height / 2); }
}

function renderDashboardNetwork(snapshot = {}) {
  const interfaces = Array.isArray(snapshot.network && snapshot.network.interfaces) ? snapshot.network.interfaces : [];
  const device = interfaces.find(item => item.name === 'enp86s0') || interfaces[0];
  const now = Date.parse(snapshot.sampledAt) || Date.now();
  if (device && Number.isFinite(device.receiveBytesPerSec) && Number.isFinite(device.sendBytesPerSec)) {
    const previous = dashboardNetworkHistory.at(-1);
    if (!previous || previous.time !== now) dashboardNetworkHistory.push({ time: now, receive: device.receiveBytesPerSec, send: device.sendBytesPerSec });
    dashboardNetworkHistory = dashboardNetworkHistory.filter(point => point.time >= now - DASHBOARD_NETWORK_WINDOW_MS).slice(-360);
  }
  const receive = device ? formatSystemNetworkRate(device.receiveBytesPerSec, '--') : '--';
  const send = device ? formatSystemNetworkRate(device.sendBytesPerSec, '--') : '--';
  $('#dashboardNetworkReceive').textContent = receive;
  $('#dashboardNetworkSend').textContent = send;
  $('#dashboardNetworkInterface').textContent = device ? `${device.name || '网卡'} · 实际吞吐` : '等待网卡采样';
  drawDashboardNetworkChart($('#dashboardNetworkChart'), dashboardNetworkHistory);
}

function optionList(items, selected = []) {
  return (items || []).map(item => `<option value="${escapeHtml(item.id)}" ${selected.includes(item.id) ? 'selected' : ''}>${escapeHtml(item.name)} (${escapeHtml(item.id)})</option>`).join('');
}

function replaceReferenceOptions(select, items, preserveMissing = false) {
  if (!select) return;
  const currentValue = String(select.value || '');
  const exists = (items || []).some(item => String(item.id) === currentValue);
  let markup = optionList(items, exists ? [currentValue] : []);
  if (currentValue && !exists && preserveMissing) {
    markup += `<option value="${escapeHtml(currentValue)}" selected>${escapeHtml(currentValue)}（原引用已不存在）</option>`;
  }
  select.innerHTML = markup;
  if (currentValue && (exists || preserveMissing)) select.value = currentValue;
  else if (currentValue) select.value = '';
}

function renderPipelineInputReferences() {
  replaceReferenceOptions($('#pipelineMedia'), state.mediaAssets || [], Boolean(editingPipelineId));
  replaceReferenceOptions($('#pipelineScene'), state.scenes || [], Boolean(editingPipelineId));
}

function hasUrlScheme(value) {
  return /^[a-z][a-z0-9+.-]*:\/\//i.test(String(value || ''));
}

function normalizeDestinationTarget(protocol, value) {
  const text = String(value || '').trim();
  if (!text) return '';
  const type = String(protocol || '').toLowerCase();
  if ((type === 'rtmp' || type === 'rtmps') && !hasUrlScheme(text)) return `${type}://${text.replace(/^\/+/, '')}`;
  if (type === 'srt' && !hasUrlScheme(text)) return `srt://${text.replace(/^\/+/, '')}`;
  return text;
}

function destinationTarget(destination) {
  const protocol = destination.protocol || 'rtmp';
  if (destination.url) return normalizeDestinationTarget(protocol, destination.url);
  const server = normalizeDestinationTarget(protocol, destination.server);
  return [server, destination.streamKey].filter(Boolean).join('/');
}

function destinationPayloadFromForm(form, existingDestination = null) {
  const fd = new FormData(form);
  const protocol = fd.get('protocol') || 'rtmp';
  return {
    name: fd.get('name'),
    protocol,
    server: normalizeDestinationTarget(protocol, fd.get('server')),
    streamKey: fd.get('streamKey'),
    url: normalizeDestinationTarget(protocol, fd.get('url')),
    enabled: existingDestination ? existingDestination.enabled !== false : true,
  };
}

function findDestination(id) {
  return (state.destinations || []).find(item => item.id === id);
}

function pipelineEnabledDestinations(pipeline) {
  return (pipeline && pipeline.destinationIds || [])
    .map(id => findDestination(id))
    .filter(item => item && item.enabled !== false);
}

function setSelectedDestinationIds(values = []) {
  const existing = new Set((state && state.destinations || []).map(item => item.id));
  selectedDestinationIds = Array.from(new Set(values.filter(Boolean))).filter(id => existing.has(id));
  renderDestinationPicker();
  renderSelectedDestinations();
}

function renderDestinationPicker() {
  const picker = $('#destinationPicker');
  if (!picker) return;

  const destinations = state.destinations || [];
  if (!destinations.length) {
    picker.innerHTML = '<option value="">还没有输出目标，请先新建</option>';
    picker.disabled = true;
    return;
  }

  picker.disabled = false;
  picker.innerHTML = '<option value="">选择一个输出目标</option>' + destinations.map(destination => {
    const alreadySelected = selectedDestinationIds.includes(destination.id);
    const disabled = destination.enabled === false || alreadySelected;
    const suffix = destination.enabled === false ? '（已禁用）' : alreadySelected ? '（已添加）' : '';
    return `<option value="${escapeHtml(destination.id)}" ${disabled ? 'disabled' : ''}>${escapeHtml(destination.name)}${suffix}</option>`;
  }).join('');
}

function renderSelectedDestinations() {
  const list = $('#selectedDestinationList');
  if (!list) return;

  const destinations = selectedDestinationIds.map(id => findDestination(id)).filter(Boolean);
  if (!destinations.length) {
    list.innerHTML = '<p class="empty-selection">还没有添加输出目标。请选择目标后点击“添加目标”。</p>';
    return;
  }

  list.innerHTML = destinations.map(destination => {
    const target = destinationTarget(destination);
    const disabled = destination.enabled === false;
    return `<div class="selected-destination ${disabled ? 'disabled' : ''}">
      <div>
        <strong>${escapeHtml(destination.name)}</strong>
        <span>${escapeHtml((destination.protocol || 'rtmp').toUpperCase())} · ${escapeHtml(target || '未填写地址')}</span>
      </div>
      <div class="selected-destination-actions">
        ${disabled ? '<small>已禁用</small>' : ''}
        <button type="button" data-action="remove-selected-destination" data-id="${escapeHtml(destination.id)}">移除</button>
      </div>
    </div>`;
  }).join('');
  bindRendererActions(list);
}

function handleRendererAction(button) {
  const { action, id, value, collection, enabled } = button.dataset;
  if (action === 'copy-text') return copyText(value);
  if (action === 'remove-selected-destination') return removeSelectedDestination(id);
  if (action === 'edit-room') return editRoom(id);
  if (action === 'create-room') return openNewRoomForm();
  if (action === 'toggle-room') return toggleRoom(id, enabled === 'true');
  if (action === 'edit-pipeline') return editPipeline(id);
  if (action === 'start-pipeline') return startPipeline(id);
  if (action === 'stop-pipeline') return stopPipeline(id);
  if (action === 'preview-pipeline') return openPipelinePreview(id);
  if (action === 'duplicate-pipeline') return duplicatePipeline(id);
  if (action === 'create-pipeline') return openNewPipelineForm();
  if (action === 'refresh-program') return refreshPipelineProgram(id);
  if (action === 'edit-destination') return editDestination(id);
  if (action === 'create-destination') return openNewDestinationForm();
  if (action === 'toggle-destination') return toggleDestination(id, enabled === 'true');
  if (action === 'delete-item') return deleteItem(collection, id);
  if (action === 'select-scene') return selectStudioScene(id);
  if (action === 'delete-scene') return deleteScene(id);
  if (action === 'remove-scene-media') {
    sceneDraft.playlist = removeSceneMedia(sceneDraft.playlist, Number(button.dataset.index));
    return renderScenePlaylist();
  }
  if (action === 'move-scene-media') {
    sceneDraft.playlist = moveSceneMedia(sceneDraft.playlist, Number(button.dataset.index), Number(button.dataset.direction));
    return renderScenePlaylist();
  }
  if (action === 'remove-scene-watermark') {
    sceneDraft.watermarks = removeSceneMedia(sceneDraft.watermarks, Number(button.dataset.index));
    return renderSceneWatermarks();
  }
  if (action === 'move-scene-watermark') {
    sceneDraft.watermarks = moveSceneMedia(sceneDraft.watermarks, Number(button.dataset.index), Number(button.dataset.direction));
    return renderSceneWatermarks();
  }
  if (action === 'preview-media') {
    selectedMediaPreviewId = id;
    return renderMediaLibrary();
  }
  if (action === 'delete-media') return deleteMediaAsset(id);
  if (action === 'delete-recording') return deleteStudioRecording(id);
  if (action === 'stop-recording') return stopStudioRecording(id, false);
  if (action === 'replay-recording') return stopStudioRecording(id, true);
  if (action === 'open-studio-switcher') return openStudioSwitcher(id);
}

function bindRendererActions(container) {
  if (!container) return;
  container.querySelectorAll('[data-action]').forEach(button => {
    button.addEventListener('click', event => handleRendererAction(event.currentTarget));
  });
}

function addSelectedDestination() {
  const picker = $('#destinationPicker');
  const id = picker && picker.value;
  if (!id) return alert('请先从下拉菜单选择一个输出目标');
  const destination = findDestination(id);
  if (!destination) return alert('未找到这个输出目标，请刷新后重试');
  if (destination.enabled === false) return alert('这个输出目标已停用，请先启用后再添加');
  if (selectedDestinationIds.includes(id)) return alert('这个输出目标已经添加过了');
  setSelectedDestinationIds([...selectedDestinationIds, id]);
}

function removeSelectedDestination(id) {
  setSelectedDestinationIds(selectedDestinationIds.filter(item => item !== id));
}

function renderRooms() {
  renderPipelineInputReferences();
  const rooms = state.rooms || [];
  replaceReferenceOptions($('#pipelineRoom'), rooms, Boolean(editingPipelineId));
  const liveCount = rooms.filter(room => room.enabled !== false && room.status === 'live').length;
  if ($('#roomBoardSummary')) $('#roomBoardSummary').textContent = `${rooms.length} 个直播间 · ${liveCount} 路有信号`;
  $('#roomCards').innerHTML = rooms.map(room => {
    const info = roomPublishInfo(room);
    const status = room.enabled === false ? 'disabled' : (room.status || 'idle');
    const statusLabel = status === 'live' ? '信号接入中' : status === 'disabled' ? '已停用' : '等待信号';
    return `<article class="entity-control-card input-channel-card ${escapeHtml(status)}">
      <div class="entity-card-visual">
        <span class="entity-card-status"><i aria-hidden="true"></i>${statusLabel}</span>
        <div class="entity-card-symbol"><i data-lucide="radio-receiver" aria-hidden="true"></i><strong>LOCAL ROOM</strong><small>固定 RTMP 接入</small></div>
        <span class="entity-card-technical">${escapeHtml(room.streamName)} · TCP 1935</span>
      </div>
      <div class="entity-card-body">
        <div class="entity-card-title">
        <div>
          <h3>${escapeHtml(room.name)}</h3>
            <p>直播间标识 <code>${escapeHtml(room.streamName)}</code></p>
        </div>
      </div>
        <div class="entity-copy-list">
          <div><span>接入服务器</span><code title="${escapeHtml(info.publishServer)}">${escapeHtml(info.publishServer)}</code><button class="icon-button" data-action="copy-text" data-value="${escapeHtml(info.publishServer)}" title="复制接入服务器" aria-label="复制接入服务器"><i data-lucide="copy" aria-hidden="true"></i></button></div>
          <div><span>安全密钥</span><code title="${escapeHtml(info.streamKey)}">${escapeHtml(info.streamKey)}</code><button class="icon-button" data-action="copy-text" data-value="${escapeHtml(info.streamKey)}" title="复制安全密钥" aria-label="复制安全密钥"><i data-lucide="copy" aria-hidden="true"></i></button></div>
          <div><span>完整推流地址</span><code title="${escapeHtml(info.publishUrl)}">${escapeHtml(info.publishUrl)}</code><button class="icon-button" data-action="copy-text" data-value="${escapeHtml(info.publishUrl)}" title="复制完整推流地址" aria-label="复制完整推流地址"><i data-lucide="copy" aria-hidden="true"></i></button></div>
        </div>
      </div>
      <footer class="entity-card-actions">
        <span>${status === 'live' ? '上游设备已建立连接' : status === 'disabled' ? '直播间已停止接收信号' : '等待上游设备推流'}</span>
        <div>
          <button class="icon-button" data-action="edit-room" data-id="${escapeHtml(room.id)}" title="修改本地直播间" aria-label="修改 ${escapeHtml(room.name)}"><i data-lucide="pencil" aria-hidden="true"></i></button>
          <button class="icon-button" data-action="toggle-room" data-id="${escapeHtml(room.id)}" data-enabled="${room.enabled === false}" title="${room.enabled === false ? '启用本地直播间' : '停用本地直播间'}" aria-label="${room.enabled === false ? '启用' : '停用'} ${escapeHtml(room.name)}"><i data-lucide="power" aria-hidden="true"></i></button>
          <button class="danger icon-button" data-action="delete-item" data-collection="rooms" data-id="${escapeHtml(room.id)}" title="删除本地直播间" aria-label="删除 ${escapeHtml(room.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </div>
      </footer>
    </article>`;
  }).join('') || '<div class="entity-empty"><i data-lucide="radio-receiver" aria-hidden="true"></i><h3>还没有本地直播间</h3><p>创建直播间后即可获得固定 RTMP 接入地址和密钥。</p><button class="primary" type="button" data-action="create-room"><i data-lucide="plus" aria-hidden="true"></i>新建直播间</button></div>';
  bindRendererActions($('#roomCards'));
  refreshIcons();
}

function renderPipelines() {
  renderPipelineFormOptions();
  renderPipelineCards();
}

function renderPipelineFormOptions() {
  replaceReferenceOptions($('#pipelineSource'), state.sources || [], Boolean(editingPipelineId));
  selectedDestinationIds = selectedDestinationIds.filter(id => findDestination(id));
  renderDestinationPicker();
  renderSelectedDestinations();
  syncLiveDelayControls();
  syncEncodingControls();
}

function pipelineStatusBucket(status) {
  if (['error', 'fallback'].includes(status)) return 'error';
  if (['running', 'starting', 'draining'].includes(status)) return 'running';
  return 'stopped';
}

function pipelineStatusIsActive(status) {
  return ['running', 'starting', 'fallback', 'draining'].includes(status);
}

function pipelineInputTypeMeta(pipeline = {}) {
  const input = pipeline.input || {};
  if (input.type === 'room') return { label: '本地直播间', icon: 'radio-receiver' };
  if (input.type === 'url') return { label: '网络流', icon: 'link' };
  if (input.type === 'file' || input.type === 'playlist') return { label: '视频素材', icon: 'file-video-2' };
  if (input.type === 'capture') {
    return input.capture && input.capture.backend === 'decklink'
      ? { label: 'DeckLink 采集', icon: 'video' }
      : { label: '采集卡', icon: 'webcam' };
  }
  if (input.type === 'scene') return { label: '画面场景', icon: 'layers-3' };
  return { label: '输入源', icon: 'radio' };
}

function compactBitrate(kbps) {
  const value = Number(kbps);
  if (!Number.isFinite(value) || value <= 0) return '--';
  if (value < 1000) return `${Math.round(value)} Kbps`;
  const mbps = value / 1000;
  const precision = mbps >= 10 ? 1 : 2;
  return `${Number(mbps.toFixed(precision))} Mbps`;
}

function pipelineMonitorSummary(pipeline = {}) {
  const outputs = (state.monitor && state.monitor.outputs || []).filter(output => (
    output.pipelineId === pipeline.id && !['disabled', 'stopped'].includes(output.status)
  ));
  const bitrateSamples = outputs
    .filter(output => output.actualBitrateAvailable)
    .map(output => Number(output.bitrateKbps))
    .filter(value => Number.isFinite(value) && value > 0);
  const fpsSamples = outputs
    .map(output => Number(output.fps))
    .filter(value => Number.isFinite(value) && value > 0);
  const totalBitrate = bitrateSamples.reduce((sum, value) => sum + value, 0);
  const lowestFps = fpsSamples.length ? Math.min(...fpsSamples) : 0;
  return {
    bitrate: bitrateSamples.length ? compactBitrate(totalBitrate) : '--',
    fps: lowestFps > 0 ? `${formatPreviewFps(lowestFps)} fps` : '--',
    activeOutputs: outputs.length,
  };
}

function pipelineMatchesCardFilters(pipeline, status, destinations) {
  if (pipelineCardFilters.status !== 'all' && pipelineStatusBucket(status) !== pipelineCardFilters.status) return false;
  const query = pipelineCardFilters.query.trim().toLocaleLowerCase('zh-CN');
  if (!query) return true;
  const haystack = [
    pipeline.name,
    describePipelineInput(pipeline),
    pipeline.mode,
    ...destinations.flatMap(destination => [destination.name, destination.protocol]),
  ].filter(Boolean).join(' ').toLocaleLowerCase('zh-CN');
  return haystack.includes(query);
}

function renderPipelineTaskSummary(pipelines = []) {
  const counts = pipelines.reduce((result, pipeline) => {
    const status = pipelineRuntimeStatus(pipeline);
    result.total += 1;
    if (pipelineStatusIsActive(status)) result.active += 1;
    if (pipelineStatusBucket(status) === 'error') result.errors += 1;
    return result;
  }, { total: 0, active: 0, errors: 0 });
  const summary = $('#pipelineTaskSummary');
  if (!summary) return;
  summary.innerHTML = `
    <span><i data-lucide="layout-grid" aria-hidden="true"></i><strong>${counts.total}</strong> 个任务</span>
    <span class="is-running"><i data-lucide="radio" aria-hidden="true"></i><strong>${counts.active}</strong> 路运行</span>
    <span class="${counts.errors ? 'is-error' : ''}"><i data-lucide="triangle-alert" aria-hidden="true"></i><strong>${counts.errors}</strong> 个异常</span>`;
}

function updatePipelineCardRuntime(pipelines = []) {
  for (const pipeline of pipelines) {
    const summary = pipelineMonitorSummary(pipeline);
    const bitrate = document.querySelector(`[data-runtime-bitrate="${CSS.escape(pipeline.id)}"]`);
    const fps = document.querySelector(`[data-runtime-fps="${CSS.escape(pipeline.id)}"]`);
    if (bitrate) bitrate.textContent = summary.bitrate;
    if (fps) fps.textContent = summary.fps;
  }
}

function pipelineCardMonitorElements(pipelineId) {
  const escaped = CSS.escape(String(pipelineId || ''));
  return {
    frame: document.querySelector(`[data-monitor-pipeline-id="${escaped}"]`),
    image: document.querySelector(`[data-monitor-image="${escaped}"]`),
    placeholder: document.querySelector(`[data-monitor-placeholder="${escaped}"]`),
    status: document.querySelector(`[data-monitor-status="${escaped}"]`),
    meta: document.querySelector(`[data-monitor-meta="${escaped}"]`),
  };
}

function pipelineCardMonitorMessage(preview = {}) {
  if (preview.state === 'receiving') return '低帧率实时监看';
  if (preview.state === 'no-signal') return '暂无输入源';
  if (preview.state === 'failed') return preview.message || '监看暂不可用';
  return '正在连接输入源';
}

function renderPipelineCardMonitor(pipelineId, preview = {}) {
  const elements = pipelineCardMonitorElements(pipelineId);
  if (!elements.frame) return;
  const receiving = preview.state === 'receiving';
  elements.frame.classList.toggle('is-receiving', receiving);
  elements.frame.classList.toggle('is-unavailable', ['failed', 'no-signal'].includes(preview.state));
  if (elements.image) elements.image.hidden = !receiving;
  if (elements.placeholder) elements.placeholder.hidden = receiving;
  if (elements.status) elements.status.textContent = pipelineCardMonitorMessage(preview);
  if (elements.meta) {
    const details = [];
    const width = Number(preview.width);
    const height = Number(preview.height);
    const fps = formatPreviewFps(preview.fps);
    const bitrate = Number(preview.bitrateKbps);
    if (width > 0 && height > 0) details.push(`${width}x${height}`);
    if (fps) details.push(`${fps} fps`);
    if (bitrate > 0) details.push(compactBitrate(bitrate));
    elements.meta.textContent = details.length ? details.join(' / ') : '480p / 2 fps 低负载监看';
  }
}

function clearPipelineCardMonitorPoll(session) {
  if (session && session.pollTimer) clearTimeout(session.pollTimer);
  if (session) session.pollTimer = null;
}

async function pollPipelineCardMonitor(pipelineId, session) {
  if (pipelineCardMonitorState.sessions.get(pipelineId) !== session || !session.id) return;
  try {
    const preview = await api(`/api/previews/${encodeURIComponent(session.id)}`);
    if (pipelineCardMonitorState.sessions.get(pipelineId) !== session) return;
    renderPipelineCardMonitor(pipelineId, preview);
  } catch (error) {
    if (pipelineCardMonitorState.sessions.get(pipelineId) !== session) return;
    renderPipelineCardMonitor(pipelineId, { state: 'failed', message: friendlyPipelineError(error.message) });
    session.pollTimer = setTimeout(() => {
      if (pipelineCardMonitorState.sessions.get(pipelineId) !== session) return;
      releasePipelineCardMonitor(pipelineId).finally(pumpPipelineCardMonitors);
    }, 10_000);
    return;
  }
  session.pollTimer = setTimeout(() => pollPipelineCardMonitor(pipelineId, session), 1500);
}

async function startPipelineCardMonitor(pipelineId) {
  if (pipelineCardMonitorState.sessions.has(pipelineId)) return;
  const pipeline = (state && state.pipelines || []).find(item => item.id === pipelineId);
  if (!pipeline) return;
  const session = { id: '', pollTimer: null, starting: true };
  pipelineCardMonitorState.sessions.set(pipelineId, session);
  renderPipelineCardMonitor(pipelineId, { state: 'connecting' });
  try {
    const preview = await api('/api/previews?format=mjpeg', {
      method: 'POST',
      body: JSON.stringify({ ...createPipelineInputPreviewRequest(pipeline), format: 'mjpeg', monitor: true }),
    });
    if (pipelineCardMonitorState.sessions.get(pipelineId) !== session) {
      await api(`/api/previews/${encodeURIComponent(preview.id)}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      return;
    }
    session.id = preview.id;
    session.starting = false;
    const elements = pipelineCardMonitorElements(pipelineId);
    if (elements.image) {
      elements.image.src = `/api/previews/${encodeURIComponent(preview.id)}/stream?format=mjpeg&monitor=1`;
      elements.image.addEventListener('load', () => {
        if (pipelineCardMonitorState.sessions.get(pipelineId) === session) {
          renderPipelineCardMonitor(pipelineId, { ...preview, state: 'receiving' });
        }
      }, { once: true });
    }
    renderPipelineCardMonitor(pipelineId, preview);
    pollPipelineCardMonitor(pipelineId, session);
  } catch (error) {
    session.starting = false;
    renderPipelineCardMonitor(pipelineId, {
      state: /未检测到输入|没有可用|不存在/.test(error.message) ? 'no-signal' : 'failed',
      message: /直连采集/.test(error.message) ? '直连采集占用设备，停止任务后可监看' : friendlyPipelineError(error.message),
    });
    session.pollTimer = setTimeout(() => {
      if (pipelineCardMonitorState.sessions.get(pipelineId) !== session) return;
      pipelineCardMonitorState.sessions.delete(pipelineId);
      pumpPipelineCardMonitors();
    }, 10_000);
  }
}

async function releasePipelineCardMonitor(pipelineId) {
  const session = pipelineCardMonitorState.sessions.get(pipelineId);
  if (!session) return;
  pipelineCardMonitorState.sessions.delete(pipelineId);
  clearPipelineCardMonitorPoll(session);
  const elements = pipelineCardMonitorElements(pipelineId);
  if (elements.image) {
    elements.image.removeAttribute('src');
    elements.image.hidden = true;
  }
  if (session.id) {
    await api(`/api/previews/${encodeURIComponent(session.id)}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
  }
}

function releaseAllPipelineCardMonitors() {
  const ids = Array.from(pipelineCardMonitorState.sessions.keys());
  pipelineCardMonitorState.visible.clear();
  for (const id of ids) releasePipelineCardMonitor(id);
}

function pumpPipelineCardMonitors() {
  const active = pipelineCardMonitorState.sessions.size;
  if (active >= pipelineCardMonitorState.maxActive) return;
  const candidates = Array.from(pipelineCardMonitorState.visible).filter(id => !pipelineCardMonitorState.sessions.has(id));
  for (const id of candidates.slice(0, pipelineCardMonitorState.maxActive - active)) startPipelineCardMonitor(id);
}

function syncPipelineCardMonitors() {
  const frames = $$('[data-monitor-pipeline-id]');
  const ids = new Set(frames.map(frame => frame.dataset.monitorPipelineId));
  for (const id of Array.from(pipelineCardMonitorState.sessions.keys())) {
    if (!ids.has(id)) releasePipelineCardMonitor(id);
  }
  if (!('IntersectionObserver' in window)) {
    pipelineCardMonitorState.visible = new Set(Array.from(ids).slice(0, pipelineCardMonitorState.maxActive));
    pumpPipelineCardMonitors();
    return;
  }
  if (pipelineCardMonitorState.observer) pipelineCardMonitorState.observer.disconnect();
  pipelineCardMonitorState.visible.clear();
  pipelineCardMonitorState.observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const id = entry.target.dataset.monitorPipelineId;
      if (!id) continue;
      if (entry.isIntersecting && entry.intersectionRatio >= 0.15 && !document.hidden) {
        pipelineCardMonitorState.visible.add(id);
      } else {
        pipelineCardMonitorState.visible.delete(id);
        releasePipelineCardMonitor(id).finally(pumpPipelineCardMonitors);
      }
    }
    pumpPipelineCardMonitors();
  }, { threshold: [0, 0.15, 0.5] });
  frames.forEach(frame => {
    pipelineCardMonitorState.observer.observe(frame);
    const session = pipelineCardMonitorState.sessions.get(frame.dataset.monitorPipelineId);
    if (session && session.id) {
      const image = frame.querySelector('[data-monitor-image]');
      if (image) image.src = `/api/previews/${encodeURIComponent(session.id)}/stream?format=mjpeg&monitor=1`;
    }
  });
}

function renderPipelineCards() {
  const switchableIds = new Set(runningStudioPipelines(state.pipelines || [], state.monitor || {}).map(item => item.id));
  const pipelines = state.pipelines || [];
  renderPipelineTaskSummary(pipelines);
  const visiblePipelines = pipelines.filter(pipeline => {
    const destinations = (pipeline.destinationIds || []).map(id => findDestination(id)).filter(Boolean);
    return pipelineMatchesCardFilters(pipeline, pipelineRuntimeStatus(pipeline), destinations);
  });
  const resultCount = $('#pipelineResultCount');
  if (resultCount) {
    resultCount.textContent = visiblePipelines.length === pipelines.length
      ? `共 ${pipelines.length} 个任务`
      : `显示 ${visiblePipelines.length} 个，共 ${pipelines.length} 个任务`;
  }
  const structureSignature = JSON.stringify(visiblePipelines.map(p => ({
    id: p.id,
    name: p.name,
    input: p.input,
    sourceId: p.sourceId,
    destinationIds: p.destinationIds,
    mode: p.mode,
    settings: p.settings,
    status: pipelineRuntimeStatus(p),
    statusMessage: pipelineRuntimeMessage(p),
    program: state.programs && state.programs[p.id],
    switchable: switchableIds.has(p.id),
  })));
  if (pipelineCardStructureSignature === structureSignature && $('#pipelineCards')?.children.length) {
    updatePipelineCardRuntime(visiblePipelines);
    return;
  }
  pipelineCardStructureSignature = structureSignature;
  const markup = visiblePipelines.map(p => {
    const destinations = (p.destinationIds || []).map(id => (state.destinations || []).find(d => d.id === id)).filter(Boolean);
    const enabledDestinations = pipelineEnabledDestinations(p);
    const status = pipelineRuntimeStatus(p);
    const statusMessage = pipelineRuntimeMessage(p);
    const liveSettings = p.settings && p.settings.live || {};
    const delayText = liveSettings.delayEnabled
      ? `直播延时：${Number(liveSettings.delaySeconds) || 20} 秒`
      : '';
    const program = state.programs && state.programs[p.id];
    const programDescriptor = describeProgram(program, p);
    const switchable = switchableIds.has(p.id);
    const resolution = p.settings?.video?.outputResolution || '1920x1080';
    const fps = p.settings?.video?.fps || '59.94';
    const outputCount = enabledDestinations.length;
    const processing = visualProcessingActive(p.settings || {}) ? '画面叠加' : '原样转推';
    const relayMode = (p.mode || 'shared-relay') === 'shared-relay' ? '共享转推' : '独立输出';
    const inputMeta = pipelineInputTypeMeta(p);
    const monitorSummary = pipelineMonitorSummary(p);
    const active = pipelineStatusIsActive(status);
    const destinationTags = destinations.length
      ? destinations.slice(0, 3).map(destination => `<span class="pipeline-destination-tag ${destination.enabled === false ? 'is-disabled' : ''}">${escapeHtml(destination.name)}<small>${escapeHtml((destination.protocol || 'rtmp').toUpperCase())}</small></span>`).join('')
      : '<span class="pipeline-destination-empty">未配置输出平台</span>';
    const destinationOverflow = destinations.length > 3 ? `<span class="pipeline-destination-more">+${destinations.length - 3}</span>` : '';
    const primaryAction = active
      ? `<button class="pipeline-primary-control is-stop" data-action="stop-pipeline" data-id="${escapeHtml(p.id)}" type="button"><i data-lucide="square" aria-hidden="true"></i><span>停止</span></button>`
      : `<button class="pipeline-primary-control is-start" data-action="start-pipeline" data-id="${escapeHtml(p.id)}" type="button"><i data-lucide="play" aria-hidden="true"></i><span>启动</span></button>`;
    return `<article class="pipeline-task-card ${escapeHtml(status)}" data-pipeline-id="${escapeHtml(p.id)}">
      <div class="pipeline-card-preview" data-monitor-pipeline-id="${escapeHtml(p.id)}">
        <img class="pipeline-card-monitor-image" data-monitor-image="${escapeHtml(p.id)}" alt="" hidden>
        <div class="pipeline-card-preview-top">
          <span class="pipeline-card-state"><i aria-hidden="true"></i>${escapeHtml(pipelineStatusLabel(status))}</span>
          <span class="pipeline-card-output-count"><i data-lucide="radio-tower" aria-hidden="true"></i>${outputCount} 路输出</span>
        </div>
        <button class="pipeline-card-preview-trigger" data-action="preview-pipeline" data-id="${escapeHtml(p.id)}" type="button" aria-label="预览 ${escapeHtml(p.name)} 的输入源">
          <span class="pipeline-card-monitor-placeholder" data-monitor-placeholder="${escapeHtml(p.id)}">
            <i data-lucide="${inputMeta.icon}" aria-hidden="true"></i>
            <strong data-monitor-status="${escapeHtml(p.id)}">正在等待监看</strong>
            <small>${escapeHtml(inputMeta.label)}</small>
          </span>
        </button>
        <div class="pipeline-card-preview-meta">
          <span data-monitor-meta="${escapeHtml(p.id)}"><i data-lucide="video" aria-hidden="true"></i>${escapeHtml(resolution)} / ${escapeHtml(fps)} fps</span>
          <span>${escapeHtml(processing)}</span>
        </div>
      </div>
      <div class="pipeline-card-body">
        <div class="pipeline-card-title-row">
        <div>
          <h3>${escapeHtml(p.name)}</h3>
            <p title="${escapeHtml(describePipelineInput(p))}">${escapeHtml(describePipelineInput(p))}</p>
        </div>
          <button class="program-refresh-button icon-button" data-action="refresh-program" data-id="${escapeHtml(p.id)}" type="button" title="刷新当前播出内容" aria-label="刷新 ${escapeHtml(p.name)} 的当前播出内容"><i data-lucide="refresh-cw" aria-hidden="true"></i></button>
      </div>
        ${statusMessage ? `<p class="pipeline-card-alert">${escapeHtml(statusMessage)}</p>` : ''}
        <div class="pipeline-card-tags" aria-label="任务配置摘要">
          <span>${escapeHtml(relayMode)}</span>
          <span>${escapeHtml(delayText || '无直播延时')}</span>
          <span>${escapeHtml(processing)}</span>
      </div>
        <div class="pipeline-card-destinations" aria-label="输出平台">${destinationTags}${destinationOverflow}</div>
        <div class="pipeline-card-program">
          <span>当前播出</span>
          <strong>${escapeHtml(programDescriptor.title)}</strong>
          <small title="${escapeHtml(programDescriptor.source)}">${escapeHtml(programDescriptor.source)}</small>
      </div>
      </div>
      <footer class="pipeline-card-footer">
        <div class="pipeline-card-live-metrics" aria-label="实时输出指标">
          <span><strong data-runtime-bitrate="${escapeHtml(p.id)}">${escapeHtml(monitorSummary.bitrate)}</strong><small>实时总码率</small></span>
          <span><strong data-runtime-fps="${escapeHtml(p.id)}">${escapeHtml(monitorSummary.fps)}</strong><small>最低输出帧率</small></span>
        </div>
        <div class="pipeline-card-actions">
          ${primaryAction}
          <button class="icon-button" data-action="edit-pipeline" data-id="${escapeHtml(p.id)}" type="button" title="修改任务" aria-label="修改 ${escapeHtml(p.name)}" ${active ? 'disabled' : ''}><i data-lucide="pencil" aria-hidden="true"></i></button>
          <button class="icon-button" data-action="duplicate-pipeline" data-id="${escapeHtml(p.id)}" type="button" title="复制任务" aria-label="复制 ${escapeHtml(p.name)}"><i data-lucide="copy" aria-hidden="true"></i></button>
          <button class="icon-button" data-action="open-studio-switcher" data-id="${escapeHtml(p.id)}" type="button" ${switchable ? '' : 'disabled'} title="${switchable ? '打开画面切换台' : '共享转推任务运行后可打开切换台'}" aria-label="打开 ${escapeHtml(p.name)} 的画面切换台"><i data-lucide="sliders-horizontal" aria-hidden="true"></i></button>
          <button class="danger icon-button" data-action="delete-item" data-collection="pipelines" data-id="${escapeHtml(p.id)}" type="button" title="删除任务" aria-label="删除 ${escapeHtml(p.name)}" ${active ? 'disabled' : ''}><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </div>
      </footer>
    </article>`;
  }).join('') || `<div class="pipeline-card-empty">
      <i data-lucide="${pipelines.length ? 'search-x' : 'layout-grid'}" aria-hidden="true"></i>
      <h3>${pipelines.length ? '没有符合条件的任务' : '还没有分发任务'}</h3>
      <p>${pipelines.length ? '调整状态筛选或搜索关键词后重试。' : '创建第一个任务后，可以在卡片中直接启动、停止、预览和管理。'}</p>
      ${pipelines.length ? '' : '<button class="primary" type="button" data-action="create-pipeline"><i data-lucide="plus" aria-hidden="true"></i>新建任务</button>'}
      </div>
    `;
  replaceContainerHtmlPreservingFocus($('#pipelineCards'), markup);
  bindRendererActions($('#pipelineCards'));
  refreshIcons();
  syncPipelineCardMonitors();
}

function renderDestinations() {
  const destinations = state.destinations || [];
  const enabledCount = destinations.filter(destination => destination.enabled !== false).length;
  if ($('#destinationBoardSummary')) $('#destinationBoardSummary').textContent = `${destinations.length} 个目标 · ${enabledCount} 个已启用`;
  $('#destinationCards').innerHTML = destinations.map(d => {
    const target = destinationTarget(d);
    const enabled = d.enabled !== false;
    const protocol = String(d.protocol || 'rtmp').toUpperCase();
    return `<article class="entity-control-card output-target-card ${enabled ? 'enabled' : 'disabled'}">
      <div class="entity-card-visual">
        <span class="entity-card-status"><i aria-hidden="true"></i>${enabled ? '已启用' : '已停用'}</span>
        <div class="entity-card-symbol"><i data-lucide="send" aria-hidden="true"></i><strong>${escapeHtml(protocol)} OUTPUT</strong><small>直播输出端点</small></div>
        <span class="entity-card-technical">${escapeHtml(protocol)} · ${enabled ? 'READY' : 'DISABLED'}</span>
      </div>
      <div class="entity-card-body">
        <div class="entity-card-title">
        <div>
          <h3>${escapeHtml(d.name)}</h3>
            <p>输出协议 <code>${escapeHtml(protocol)}</code></p>
        </div>
      </div>
        <div class="entity-target-address"><span>目标地址</span><code title="${escapeHtml(target || '')}">${escapeHtml(target || '未填写地址')}</code></div>
      </div>
      <footer class="entity-card-actions">
        <span>${enabled ? '可加入分发任务' : '不会建立输出连接'}</span>
        <div>
          <button class="icon-button" data-action="edit-destination" data-id="${escapeHtml(d.id)}" title="修改输出目标" aria-label="修改 ${escapeHtml(d.name)}"><i data-lucide="pencil" aria-hidden="true"></i></button>
          <button class="icon-button" data-action="toggle-destination" data-id="${escapeHtml(d.id)}" data-enabled="${d.enabled === false}" title="${enabled ? '停用输出目标' : '启用输出目标'}" aria-label="${enabled ? '停用' : '启用'} ${escapeHtml(d.name)}"><i data-lucide="power" aria-hidden="true"></i></button>
          <button class="danger icon-button" data-action="delete-item" data-collection="destinations" data-id="${escapeHtml(d.id)}" title="删除输出目标" aria-label="删除 ${escapeHtml(d.name)}"><i data-lucide="trash-2" aria-hidden="true"></i></button>
        </div>
      </footer>
    </article>`;
  }).join('') || '<div class="entity-empty"><i data-lucide="send" aria-hidden="true"></i><h3>还没有输出目标</h3><p>添加直播平台或 SRT 端点后即可用于任务编排。</p><button class="primary" type="button" data-action="create-destination"><i data-lucide="plus" aria-hidden="true"></i>新建输出目标</button></div>';
  bindRendererActions($('#destinationCards'));
  refreshIcons();
}

function renderMonitor(monitor) {
  const outputs = monitor.outputs || [];
  const markup = outputs.map(o => {
    const targetFps = Number(o.targetFps || 0);
    const bitrateText = formatActualBitrate(o);
    const dropCountText = formatEstimatedNetworkDropCount(o);
    const dropRateText = formatEstimatedNetworkDropRate(o);
    const transportShortfallPercent = finiteMetric(o.transportShortfallPercent, { max: 100 });
    const encoderSpeed = finiteMetric(o.encoderSpeed ?? (o.metrics && o.metrics.speed));
    const encodingMode = o.encodingMode;
    const encoderWarning = hasEncoderPerformanceWarning(o);
    const fpsText = displayFpsValue(o, targetFps);
    const displayStatus = ['fallback', 'draining'].includes(o.pipelineStatus) ? o.pipelineStatus : o.status;
    const statusText = pipelineStatusLabel(displayStatus);
    return `<article class="monitor-card ${['disabled', 'stopped'].includes(o.status) ? 'is-disabled' : ''}">
    <header>
      <h3>${escapeHtml((o.destination && o.destination.name) || o.id)}</h3>
      <div class="monitor-card-actions">
        <button class="monitor-detail-button" type="button" data-action="monitor-detail" data-id="${escapeHtml(o.id)}" data-monitor-detail="${escapeHtml(o.id)}">详情</button>
        <span class="badge ${escapeHtml(displayStatus)}">${escapeHtml(statusText)}</span>
      </div>
    </header>
    <p>${escapeHtml(o.pipelineName || '')} · ${escapeHtml(o.sourceName || '')}</p>
    <div class="monitor-grid">
      <div class="kv"><span>实际输出码率</span><strong>${escapeHtml(bitrateText)}</strong></div>
      <div class="kv"><span>FPS</span><strong>${escapeHtml(fpsText)}</strong></div>
      <div class="kv"><span>实际编码</span><strong>${escapeHtml(encodingModeLabel(encodingMode))}</strong></div>
      <div class="kv"><span>估算网络丢帧数</span><strong>${escapeHtml(dropCountText)}</strong></div>
      <div class="kv"><span>估算网络丢帧率</span><strong>${escapeHtml(dropRateText)}</strong></div>
      <div class="kv"><span>运行时长</span><strong>${escapeHtml(o.uptime || '00:00:00')}</strong></div>
    </div>
    ${o.pipelineStatus !== 'fallback' && o.actualBitrateAvailable && transportShortfallPercent >= BITRATE_SHORTFALL_WARNING_PERCENT ? `<p class="error">实际发送低于固定码率 ${transportShortfallPercent.toFixed(1)}%，可能存在带宽不足或传输丢包</p>` : ''}
    ${encoderWarning ? `<p class="warning">编码性能不足，当前速度 ${encoderSpeed.toFixed(2)}x</p>` : ''}
    ${o.pipelineStatus === 'fallback' ? `<p class="warning">${escapeHtml(o.pipelineMessage || '输入信号不可用，正在推送黑屏和静音并等待恢复')}</p>` : ''}
    <div class="output-chart-wrap">
      <canvas data-output-chart="${escapeHtml(o.id)}" width="640" height="220" aria-label="${escapeHtml((o.destination && o.destination.name) || o.id)} 码率和帧率折线图"></canvas>
    </div>
    ${o.lastError ? `<p class="error">${escapeHtml(o.lastError)}</p>` : ''}
  </article>`;
  }).join('') || '<div class="panel"><p>暂无运行中的输出。启动分发任务后，这里会显示每路输出的实际输出码率、FPS 和估算网络丢帧。</p></div>';
  replaceContainerHtmlPreservingFocus($('#monitorCards'), markup);
  outputs.forEach(o => {
    const canvas = document.querySelector(`[data-output-chart="${CSS.escape(o.id)}"]`);
    if (canvas) drawOutputBitrateChart(canvas, o.history || [], o, monitor.range || {});
  });
  $$('[data-monitor-detail]').forEach(button => button.addEventListener('click', () => openMonitorDetail(button.dataset.monitorDetail)));
  refreshIcons();
}

function displayFpsValue(output, targetFps = 0) {
  const current = Number(output && output.fps);
  const legacy = Number(output && output.recentMeasuredFps);
  const hasCurrent = Boolean(output) && output.fps != null && Number.isFinite(current) && current >= 0;
  let value = hasCurrent
    ? current
    : (Number.isFinite(legacy) && legacy > 0 ? legacy : 0);
  if (targetFps && Math.abs(value - Number(targetFps)) <= 0.1) value = Number(targetFps);
  if (targetFps && !Number.isInteger(Number(targetFps))) return value.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
  return value.toFixed(1);
}

function formatTimeLabel(timestamp) {
  return new Date(timestamp).toLocaleTimeString('zh-CN', {
    hour12: false,
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });
}

function niceBitrateScale(value) {
  const rawMax = Math.max(1000, Math.ceil((Number(value) || 0) * 1.08));
  const candidates = [100, 200, 250, 500, 750, 1000, 1500, 2000, 2500, 5000, 7500, 10000, 15000, 20000, 25000, 50000];
  const step = candidates.find(candidate => Math.ceil(rawMax / candidate) <= 7) || 50000;
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, step, ticks };
}

function niceFpsScale(value) {
  const rawMax = Math.max(30, Number(value) || 0);
  const step = rawMax <= 30 ? 5 : rawMax <= 60 ? 10 : rawMax <= 120 ? 20 : 30;
  const max = Math.max(step, Math.ceil(rawMax / step) * step);
  const ticks = [];
  for (let value = 0; value <= max; value += step) ticks.push(value);
  return { max, step, ticks };
}

function drawBitrateAxisLabels(ctx, chart, scale) {
  ctx.fillStyle = themeColor('--ui-chart-label', '#5c6b7a');
  ctx.textAlign = 'right';
  ctx.textBaseline = 'middle';
  ctx.font = '12px Inter, system-ui, sans-serif';
  for (const value of scale.ticks) {
    const y = chart.top + chart.height - (value / scale.max) * chart.height;
    ctx.fillText(`${value} Kbps`, chart.left - 10, y);
  }
}

function drawFpsAxisLabels(ctx, chart, scale) {
  ctx.fillStyle = themeColor('--ui-chart-label', '#5c6b7a');
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = '12px Inter, system-ui, sans-serif';
  for (const value of scale.ticks) {
    const y = chart.top + chart.height - (value / scale.max) * chart.height;
    ctx.fillText(`${value} FPS`, chart.left + chart.width + 10, y);
  }
}

function chartTimeWindow(history, range = {}) {
  const points = Array.isArray(history) ? history : [];
  const rangeSec = Number(range.rangeSec || 0);
  const to = Number(range.to || range.now || Date.now());
  if (rangeSec > 0) {
    const start = Number(range.from || (to - rangeSec * 1000));
    return { start, end: Math.max(start + 1000, to) };
  }
  if (!points.length) return { start: to - 60_000, end: to };
  const start = Math.min(...points.map(point => Number(point.time) || to));
  const end = Math.max(...points.map(point => Number(point.time) || to), to);
  return { start, end: Math.max(start + 1000, end) };
}

function drawXAxisLabels(ctx, chart, timeWindow) {
  const span = Math.max(1000, timeWindow.end - timeWindow.start);
  const tickCount = Math.max(3, Math.min(7, Math.floor(chart.width / 90) + 1));
  ctx.fillStyle = themeColor('--ui-chart-label', '#5c6b7a');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.font = '12px Inter, system-ui, sans-serif';
  for (let i = 0; i < tickCount; i += 1) {
    const ratio = tickCount === 1 ? 0 : i / (tickCount - 1);
    const x = chart.left + ratio * chart.width;
    const time = timeWindow.start + span * ratio;
    ctx.fillText(formatTimeLabel(time), x, chart.top + chart.height + 12);
  }
}

function pointBitrate(point) {
  if (!point || point.actualBitrateAvailable !== true) return null;
  const raw = point.bitrateKbps ?? point.bitrate;
  const value = Number(raw);
  return raw !== null && raw !== undefined && Number.isFinite(value) && value >= 0 ? value : null;
}

function pointFps(point) {
  const current = Number(point && point.fps);
  if (point && point.fps != null && Number.isFinite(current) && current >= 0) return current;
  const legacy = Number(point && point.measuredFps);
  return Number.isFinite(legacy) && legacy > 0 ? legacy : 0;
}

function prepareChartCanvas(canvas) {
  const cssWidth = Math.max(320, Math.floor(canvas.getBoundingClientRect().width || canvas.width || 560));
  const cssHeight = Math.max(200, Math.floor(Number(canvas.dataset.height) || 220));
  const ratio = window.devicePixelRatio || 1;
  if (canvas.width !== Math.floor(cssWidth * ratio) || canvas.height !== Math.floor(cssHeight * ratio)) {
    canvas.width = Math.floor(cssWidth * ratio);
    canvas.height = Math.floor(cssHeight * ratio);
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(ratio, 0, 0, ratio, 0, 0);
  return { ctx, w: cssWidth, h: cssHeight };
}

function drawEmptyChart(ctx, chart, message) {
  ctx.fillStyle = themeColor('--ui-chart-label', '#5c6b7a');
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = '13px Inter, system-ui, sans-serif';
  ctx.fillText(message, chart.left + chart.width / 2, chart.top + chart.height / 2);
}

function drawChartSeries(ctx, points, chart, timeWindow, scale, valueForPoint, color) {
  const timeSpan = Math.max(1000, timeWindow.end - timeWindow.start);
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';
  ctx.beginPath();
  let penDown = false;
  let validCount = 0;
  let hasLine = false;
  let onlyPoint = null;
  for (const point of points) {
    const rawValue = valueForPoint(point);
    const value = Number(rawValue);
    if (rawValue === null || rawValue === undefined || !Number.isFinite(value)) {
      penDown = false;
      continue;
    }
    const rawTime = Number(point.time);
    const pointTime = Number.isFinite(rawTime) ? rawTime : timeWindow.end;
    const coordinate = {
      x: chart.left + Math.max(0, Math.min(1, (pointTime - timeWindow.start) / timeSpan)) * chart.width,
      y: chart.top + chart.height - (Math.max(0, value) / scale.max) * chart.height,
    };
    validCount += 1;
    onlyPoint = coordinate;
    if (!penDown) {
      ctx.moveTo(coordinate.x, coordinate.y);
      penDown = true;
    } else {
      ctx.lineTo(coordinate.x, coordinate.y);
      hasLine = true;
    }
  }
  if (hasLine) ctx.stroke();
  if (validCount === 1 && onlyPoint) {
    ctx.fillStyle = color;
    ctx.beginPath();
    ctx.arc(onlyPoint.x, onlyPoint.y, 4, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawChartLegend(ctx, chart) {
  const items = [
    { label: '实际输出码率 Kbps', color: '#2388ff' },
    { label: 'FPS', color: '#19a974' },
  ];
  let x = chart.left;
  ctx.font = '12px Inter, system-ui, sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  for (const item of items) {
    ctx.strokeStyle = item.color;
    ctx.lineWidth = 3;
    ctx.beginPath();
    ctx.moveTo(x, 17);
    ctx.lineTo(x + 18, 17);
    ctx.stroke();
    ctx.fillStyle = themeColor('--ui-chart-label', '#5c6b7a');
    ctx.fillText(item.label, x + 24, 17);
    x += item.label === '实际输出码率 Kbps' ? 150 : 110;
  }
}

function drawOutputBitrateChart(canvas, history, output = {}, range = {}) {
  if (!canvas) return;
  const { ctx, w, h } = prepareChartCanvas(canvas);
  const points = Array.isArray(history) ? history : [];
  const chart = { left: 82, top: 38, right: 66, bottom: 48 };
  chart.width = w - chart.left - chart.right;
  chart.height = h - chart.top - chart.bottom;
  const bitrateValues = points.map(pointBitrate).filter(Number.isFinite);
  const bitrateScale = niceBitrateScale(Math.max(0, ...bitrateValues));
  const fpsScale = niceFpsScale(Math.max(Number(output.targetFps) || 0, ...points.map(pointFps)));
  const timeWindow = chartTimeWindow(points, range);

  ctx.clearRect(0, 0, w, h);
  ctx.fillStyle = themeColor('--ui-chart-surface', '#ffffff');
  ctx.fillRect(0, 0, w, h);
  ctx.strokeStyle = themeColor('--ui-chart-grid', '#dde7ef');
  ctx.lineWidth = 1;
  for (const value of bitrateScale.ticks) {
    const y = chart.top + chart.height - (value / bitrateScale.max) * chart.height;
    ctx.beginPath();
    ctx.moveTo(chart.left, y);
    ctx.lineTo(chart.left + chart.width, y);
    ctx.stroke();
  }
  ctx.strokeStyle = themeColor('--ui-chart-axis', '#c8d6e4');
  ctx.beginPath();
  ctx.moveTo(chart.left, chart.top);
  ctx.lineTo(chart.left, chart.top + chart.height);
  ctx.lineTo(chart.left + chart.width, chart.top + chart.height);
  ctx.lineTo(chart.left + chart.width, chart.top);
  ctx.stroke();
  drawBitrateAxisLabels(ctx, chart, bitrateScale);
  drawFpsAxisLabels(ctx, chart, fpsScale);
  drawXAxisLabels(ctx, chart, timeWindow);
  drawChartLegend(ctx, chart);

  if (points.length) {
    drawChartSeries(ctx, points, chart, timeWindow, bitrateScale, pointBitrate, '#2388ff');
    drawChartSeries(ctx, points, chart, timeWindow, fpsScale, pointFps, '#19a974');
  } else {
    drawEmptyChart(ctx, chart, '该时间段暂无监控数据');
  }
}

function monitorQuery(historyMode = 'persistent') {
  const params = new URLSearchParams();
  if (monitorRangeSec > 0) params.set('rangeSec', String(monitorRangeSec));
  params.set('history', historyMode);
  return `?${params.toString()}`;
}

function mergeLiveMonitorSnapshot(previous = {}, live = {}, rangeSec = 900) {
  const previousById = new Map((previous.outputs || []).map(output => [output.id, output]));
  const now = Number(live.range && (live.range.now || live.range.to)) || Date.now();
  const seconds = Math.max(1, Number(rangeSec) || 900);
  const minTime = now - seconds * 1000;
  const outputs = (live.outputs || []).map(output => {
    const previousOutput = previousById.get(output.id) || {};
    const pointsByTime = new Map((previousOutput.history || [])
      .filter(point => Number(point.time) >= minTime && Number(point.time) <= now)
      .map(point => [Number(point.time), { ...point }]));
    if (!['disabled', 'stopped'].includes(output.status)) {
      pointsByTime.set(now, {
        time: now,
        bitrateKbps: output.actualBitrateAvailable ? Number(output.bitrateKbps) : null,
        actualBitrateAvailable: Boolean(output.actualBitrateAvailable),
        actualBitrateStatus: output.actualBitrateStatus || 'unavailable',
        fps: Number(output.fps) || 0,
        measuredFps: Number(output.recentMeasuredFps) || Number(output.fps) || 0,
      });
    }
    const history = Array.from(pointsByTime.values())
      .sort((left, right) => Number(left.time) - Number(right.time))
      .slice(-1200);
    return { ...previousOutput, ...output, history };
  });
  return {
    ...previous,
    ...live,
    outputs,
    range: {
      ...(previous.range || {}),
      ...(live.range || {}),
      now,
      from: minTime,
      to: now,
      rangeSec: seconds,
    },
  };
}

async function loadMonitorHistory() {
  monitorHistoryAbortController?.abort();
  const requestId = ++monitorHistoryRequestId;
  const controller = new AbortController();
  monitorHistoryAbortController = controller;
  const applyButton = $('#applyMonitorRangeBtn');
  applyButton.disabled = true;
  applyButton.setAttribute('aria-busy', 'true');
  const mode = monitorRangeSec <= 3600 ? 'memory' : 'persistent';
  try {
    const monitor = await api(`/api/monitor${monitorQuery(mode)}`, { signal: controller.signal });
    if (requestId !== monitorHistoryRequestId) return null;
    if (state) state.monitor = mergeLiveMonitorSnapshot(monitor, state.monitor || {}, monitorRangeSec);
    const current = state && state.monitor || monitor;
    renderMonitor(current);
    renderSummary();
    renderPipelineCards();
    return current;
  } finally {
    if (requestId === monitorHistoryRequestId) {
      monitorHistoryAbortController = null;
      applyButton.disabled = false;
      applyButton.removeAttribute('aria-busy');
    }
  }
}

function reportMonitorHistoryError(error) {
  if (error && error.name === 'AbortError') return;
  alert(error.message);
}

function applyMonitorRange() {
  const preset = $('#monitorRangePreset').value;
  if (preset === 'custom') {
    const minutes = Math.max(1, Number($('#monitorCustomMinutes').value || 15));
    monitorRangeSec = Math.round(minutes * 60);
  } else {
    monitorRangeSec = Number(preset) || 900;
  }
  loadMonitorHistory().then(monitor => {
    if (monitor) show('monitor');
  }).catch(reportMonitorHistoryError);
}

function handleMonitorRangePresetChange({ load = true } = {}) {
  const preset = $('#monitorRangePreset').value;
  $('#monitorCustomMinutes').disabled = preset !== 'custom';
  if (load && preset !== 'custom') applyMonitorRange();
}

function monitorDetailQuery() {
  const params = new URLSearchParams();
  params.set('outputId', monitorDetailState.outputId);
  params.set('history', 'persistent');
  if (monitorDetailState.mode === 'exact') {
    params.set('from', String(monitorDetailState.from));
    params.set('to', String(monitorDetailState.to));
  } else if (monitorDetailState.rangeSec > 0) {
    params.set('rangeSec', String(monitorDetailState.rangeSec));
  }
  return `?${params.toString()}`;
}

function toDateTimeLocalValue(timestamp) {
  const date = new Date(timestamp);
  const localTime = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return localTime.toISOString().slice(0, 19);
}

function formatDateTimeLabel(timestamp) {
  return new Date(timestamp).toLocaleString('zh-CN', { hour12: false });
}

function formatMonitorRange(seconds) {
  const value = Number(seconds) || 0;
  if (value >= 86400 && value % 86400 === 0) return `最近 ${value / 86400} 天`;
  if (value >= 3600 && value % 3600 === 0) return `最近 ${value / 3600} 小时`;
  return `最近 ${Math.max(1, Math.round(value / 60))} 分钟`;
}

function setMonitorDetailError(message = '') {
  const error = $('#monitorDetailError');
  error.textContent = message;
  error.hidden = !message;
}

function renderMonitorDetail(output, range = {}, stopped = false) {
  if (!output) return;
  const targetFps = Number(output.targetFps || 0);
  const bitrateText = formatActualBitrate(output);
  const dropCountText = formatEstimatedNetworkDropCount(output);
  const dropRateText = formatEstimatedNetworkDropRate(output);
  const transportShortfallPercent = finiteMetric(output.transportShortfallPercent, { max: 100 });
  const encoderSpeed = finiteMetric(output.encoderSpeed ?? (output.metrics && output.metrics.speed));
  const encodingMode = output.encodingMode;
  const encoderWarning = hasEncoderPerformanceWarning(output);
  const fpsText = displayFpsValue(output, targetFps);
  const outputName = (output.destination && output.destination.name) || output.id || '输出';
  const status = stopped ? 'stopped' : (output.status || 'running');

  $('#monitorDetailTitle').textContent = `输出监测详情：${outputName}`;
  $('#monitorDetailSubtitle').textContent = `${output.pipelineName || '未命名任务'} · ${output.sourceName || '未命名输入源'}`;
  $('#monitorDetailMetrics').innerHTML = [
    ['实际输出码率', bitrateText],
    ['FPS', fpsText],
    ['实际编码', encodingModeLabel(encodingMode)],
    ['估算网络丢帧数', dropCountText],
    ['估算网络丢帧率', dropRateText],
    ['运行时长', output.uptime || '00:00:00'],
  ].map(([label, value]) => `<div class="kv"><span>${escapeHtml(label)}</span><strong>${escapeHtml(value)}</strong></div>`).join('');
  $('#monitorDropResetInfo').textContent = output.dropDisplayResetAt
    ? `网络丢帧展示统计已于 ${formatDateTimeLabel(output.dropDisplayResetAt)} 重置；原始监控历史不会删除。`
    : '显示本次推流开始以来的累计网络丢帧。';

  const rangeText = range.exact
    ? `${formatDateTimeLabel(range.from)} 至 ${formatDateTimeLabel(range.to)}`
    : formatMonitorRange(monitorDetailState.rangeSec || 900);
  const statusText = stopped || status === 'stopped' ? '已停止' : status === 'disabled' ? '已禁用' : status;
  const bandwidthWarning = output.pipelineStatus !== 'fallback' && output.actualBitrateAvailable && transportShortfallPercent >= BITRATE_SHORTFALL_WARNING_PERCENT
    ? `实际发送低于固定码率 ${transportShortfallPercent.toFixed(1)}%，可能存在带宽不足或传输丢包`
    : '';
  const encoderWarningText = encoderWarning
    ? `编码性能不足，当前速度 ${encoderSpeed.toFixed(2)}x`
    : '';
  $('#monitorDetailStatus').innerHTML = [
    `<div><span class="badge ${escapeHtml(status)}">${escapeHtml(statusText)}</span> · ${escapeHtml(rangeText)}</div>`,
    bandwidthWarning ? `<p class="error">${escapeHtml(bandwidthWarning)}</p>` : '',
    encoderWarningText ? `<p class="warning">${escapeHtml(encoderWarningText)}</p>` : '',
  ].join('');

  const canvas = $('#monitorDetailChart');
  canvas.setAttribute('aria-label', `${outputName} 码率和帧率折线图`);
  drawOutputBitrateChart(canvas, output.history || [], output, range);
}

function mergeLiveMonitorDetail(live) {
  if (!monitorDetailState.outputId || !monitorDetailState.lastOutput) return;
  const current = (live.outputs || []).find(output => output.id === monitorDetailState.outputId);
  if (!current) return;
  const merged = mergeLiveMonitorSnapshot({
    outputs: [monitorDetailState.lastOutput],
    range: monitorDetailState.lastRange || {},
  }, {
    outputs: [current],
    range: live.range || {},
  }, monitorDetailState.rangeSec || 900);
  monitorDetailState.lastOutput = merged.outputs[0];
  monitorDetailState.lastRange = merged.range;
  renderMonitorDetail(monitorDetailState.lastOutput, monitorDetailState.lastRange);
}

async function loadMonitorDetail({ silent = false } = {}) {
  if (!monitorDetailState.outputId || monitorDetailState.loading) return;
  const requestedOutputId = monitorDetailState.outputId;
  monitorDetailState.loading = true;
  if (!silent) $('#monitorDetailStatus').textContent = '正在查询监控数据...';
  setMonitorDetailError('');
  try {
    const monitor = await api(`/api/monitor${monitorDetailQuery()}`);
    if (monitorDetailState.outputId !== requestedOutputId) return;
    const output = (monitor.outputs || []).find(item => item.id === requestedOutputId);
    if (output) {
      monitorDetailState.lastOutput = output;
      monitorDetailState.lastRange = monitor.range || {};
      renderMonitorDetail(output, monitor.range || {});
    } else if (monitorDetailState.lastOutput) {
      renderMonitorDetail(monitorDetailState.lastOutput, monitorDetailState.lastRange || monitor.range || {}, true);
    } else {
      $('#monitorDetailStatus').textContent = '这路输出已停止，当前没有可显示的会话数据。';
    }
  } catch (error) {
    if (monitorDetailState.outputId === requestedOutputId) {
      setMonitorDetailError(`查询失败：${error.message}。请检查时间范围后重试。`);
      if (monitorDetailState.lastOutput) {
        renderMonitorDetail(monitorDetailState.lastOutput, monitorDetailState.lastRange || {}, true);
      }
    }
  } finally {
    monitorDetailState.loading = false;
  }
}

function handleMonitorDetailRangePresetChange() {
  const exact = $('#monitorDetailRangePreset').value === 'exact';
  const fromInput = $('#monitorDetailFrom');
  const toInput = $('#monitorDetailTo');
  fromInput.disabled = !exact;
  toInput.disabled = !exact;
  if (exact && (!fromInput.value || !toInput.value)) {
    const now = Date.now();
    fromInput.value = toDateTimeLocalValue(now - 15 * 60_000);
    toInput.value = toDateTimeLocalValue(now);
  }
}

async function applyMonitorDetailPeriod(event) {
  if (event) event.preventDefault();
  const preset = $('#monitorDetailRangePreset').value;
  setMonitorDetailError('');
  if (preset === 'exact') {
    const from = new Date($('#monitorDetailFrom').value).getTime();
    const to = new Date($('#monitorDetailTo').value).getTime();
    if (!Number.isFinite(from) || !Number.isFinite(to)) {
      setMonitorDetailError('请选择有效的开始时间和结束时间。');
      return;
    }
    if (to < from) {
      setMonitorDetailError('结束时间不能早于开始时间。');
      return;
    }
    monitorDetailState.mode = 'exact';
    monitorDetailState.from = from;
    monitorDetailState.to = to;
    monitorDetailState.rangeSec = 0;
  } else {
    monitorDetailState.mode = 'rolling';
    monitorDetailState.rangeSec = Number(preset) || 900;
    monitorDetailState.from = 0;
    monitorDetailState.to = 0;
  }
  await loadMonitorDetail();
}

function returnMonitorDetailToLive() {
  monitorDetailState.mode = 'rolling';
  monitorDetailState.rangeSec = 900;
  monitorDetailState.from = 0;
  monitorDetailState.to = 0;
  $('#monitorDetailRangePreset').value = '900';
  $('#monitorDetailFrom').value = '';
  $('#monitorDetailTo').value = '';
  handleMonitorDetailRangePresetChange();
  loadMonitorDetail();
}

function openMonitorDetail(outputId) {
  const output = state && state.monitor && (state.monitor.outputs || []).find(item => item.id === outputId);
  monitorDetailState = {
    outputId,
    mode: 'rolling',
    rangeSec: 900,
    from: 0,
    to: 0,
    lastOutput: output || null,
    lastRange: state && state.monitor && state.monitor.range || null,
    loading: false,
  };
  $('#monitorDetailRangePreset').value = '900';
  $('#monitorDetailFrom').value = '';
  $('#monitorDetailTo').value = '';
  handleMonitorDetailRangePresetChange();
  setMonitorDetailError('');
  if (output) renderMonitorDetail(output, state.monitor.range || {});
  const dialog = $('#monitorDetailDialog');
  if (!dialog.open) dialog.showModal();
  loadMonitorDetail();
}

function closeMonitorDetail() {
  $('#monitorDetailDialog').close();
}

async function resetMonitorDrops() {
  if (!monitorDetailState.outputId || monitorDetailState.loading) return;
  if (!confirmDangerousAction('确认重置这一路输出的网络丢帧展示统计，并从当前时刻重新计算？原始监控历史不会删除。')) return;
  const button = $('#resetMonitorDropsBtn');
  button.disabled = true;
  setMonitorDetailError('');
  try {
    await api(`/api/monitor/outputs/${encodeURIComponent(monitorDetailState.outputId)}/reset-drops`, {
      method: 'POST',
      body: '{}',
    });
    await loadState();
    await loadMonitorDetail();
    showToast('网络丢帧展示统计已重新计算');
  } catch (error) {
    setMonitorDetailError(error.message);
  } finally {
    button.disabled = false;
  }
}

function capturePayloadFromValues(values) {
  const get = name => {
    const value = values && typeof values.get === 'function' ? values.get(name) : values && values[name];
    return String(value ?? '').trim();
  };
  const backend = get('captureBackend') || 'v4l2';
  if (backend === 'decklink') {
    return {
      backend,
      device: get('decklinkDevice'),
      formatCode: get('decklinkFormatCode') || 'auto',
      rawFormat: get('decklinkRawFormat') || 'uyvy422',
      audioChannels: Number(get('decklinkAudioChannels') || 2),
    };
  }
  return {
    backend: 'v4l2',
    videoDevice: get('videoDevice') || '/dev/video0',
    audioDevice: get('audioDevice') || 'disabled',
    resolution: get('captureResolution') || '1920x1080',
    fps: get('captureFps') || '59.94',
  };
}

function buildPipelineInput(form) {
  const fd = new FormData(form);
  const type = fd.get('inputType');
  if (type === 'room') return { input: { type: 'room', roomId: fd.get('roomId') } };
  if (type === 'url') return { input: { type: 'url', url: fd.get('url') } };
  if (type === 'file') {
    const asset = (state.mediaAssets || []).find(item => item.id === fd.get('mediaId'));
    return { input: { type: 'file', mediaId: asset ? asset.id : '', loop: fd.get('fileLoop') === 'on' } };
  }
  if (type === 'scene') return { input: { type: 'scene', sceneId: fd.get('sceneId') } };
  if (type === 'capture') {
    return {
      input: {
        type: 'capture',
        capture: capturePayloadFromValues(fd),
      },
    };
  }
  return { sourceId: fd.get('sourceId'), input: null };
}

function buildPreviewRequest(form) {
  const request = buildPipelineInput(form);
  const input = request.input || {};
  if (input.type === 'file' && input.mediaId) {
    return { input: { type: 'file', mediaId: input.mediaId, loop: input.loop !== false } };
  }
  return request;
}

function previewStatusMessage(preview) {
  if (preview && preview.message) return preview.message;
  return {
    connecting: '正在连接输入源…',
    receiving: '正在接收画面…',
    'no-signal': '未检测到输入信号',
    failed: '预览失败',
  }[preview && preview.state] || '正在连接输入源…';
}

function formatPreviewFps(value) {
  const fps = Number(value);
  if (!Number.isFinite(fps) || fps <= 0) return '';
  return Number.isInteger(fps) ? String(fps) : fps.toFixed(2).replace(/0+$/, '').replace(/\.$/, '');
}

function renderInputPreview(preview = {}) {
  const image = $('#inputPreviewImage');
  const video = $('#inputPreviewVideo');
  const status = $('#inputPreviewStatus');
  const source = $('#inputPreviewSource');
  const meta = $('#inputPreviewMeta');
  const retry = $('#retryInputPreviewBtn');
  const receiving = preview.state === 'receiving';
  const width = Number(preview.width);
  const height = Number(preview.height);
  const fps = formatPreviewFps(preview.fps);
  const bitrateKbps = Number(preview.bitrateKbps);
  const latencyMs = Number(preview.latencyMs);
  const details = [];

  source.textContent = preview.sourceLabel || '当前输入源';
  status.textContent = previewStatusMessage(preview);
  status.hidden = receiving;
  const browserVideo = Boolean(preview.browserVideoUrl);
  image.hidden = true;
  video.hidden = !receiving;
  video.muted = false;
  if (browserVideo && video.src !== preview.browserVideoUrl) video.src = preview.browserVideoUrl;
  if (Number.isFinite(width) && width > 0 && Number.isFinite(height) && height > 0) details.push(`${width} x ${height}`);
  if (fps) details.push(`${fps} fps`);
  if (Number.isFinite(bitrateKbps) && bitrateKbps > 0) {
    const prefix = preview.bitrateSource === 'input' ? '输入' : '预览';
    details.push(`${prefix} ${compactBitrate(bitrateKbps)}`);
  }
  if (preview.videoCodec) details.push(String(preview.videoCodec).toUpperCase());
  if (Number.isFinite(latencyMs) && latencyMs > 0) details.push(`约 ${Math.round(latencyMs / 100) / 10} 秒延迟`);
  meta.textContent = details.join(' · ');
  meta.hidden = !details.length;
  retry.hidden = preview.state !== 'no-signal' && preview.state !== 'failed';
}

function overlayLayoutItems(kind = overlayLayoutState.kind) {
  return kind === 'watermark' ? pipelineWatermarks : pipelineSlideshow.images;
}

function overlayLayoutAssetKey(item = {}, index = 0) {
  return String(item.id || item.path || item.url || index);
}

function overlayLayoutDimensions(item, index) {
  if (overlayLayoutState.kind === 'slideshow') return { width: 1920, height: 1080 };
  return overlayLayoutState.imageDimensions.get(overlayLayoutAssetKey(item, index)) || { width: 16, height: 9 };
}

function overlayLayoutSavedValue(item) {
  return overlayLayoutState.kind === 'slideshow' ? pipelineSlideshow.layout : item && item.layout;
}

function activeOverlayLayoutItem() {
  const items = overlayLayoutItems();
  if (overlayLayoutState.kind === 'slideshow') return items[0] || null;
  return items[overlayLayoutState.selectedIndex] || null;
}

function activeOverlayEditorLayout() {
  const item = activeOverlayLayoutItem();
  if (!item) return null;
  if (overlayLayoutState.editing && overlayLayoutState.draftLayout) return overlayLayoutState.draftLayout;
  const dimensions = overlayLayoutDimensions(item, overlayLayoutState.selectedIndex);
  const saved = overlayLayoutSavedValue(item);
  return normalizeEditorLayout(saved, dimensions, saved ? 'editable' : 'legacy');
}

function setOverlayLayoutStatus(message) {
  $('#overlayLayoutStatus').textContent = message;
}

function refreshOverlayLayoutGeometry() {
  const canvas = $('#overlayLayoutCanvas');
  const rect = canvas.getBoundingClientRect();
  const items = overlayLayoutItems();
  $('#overlayLayoutLayers').querySelectorAll('.overlay-layout-layer').forEach(layer => {
    const index = Number(layer.dataset.index);
    const item = overlayLayoutState.kind === 'slideshow' ? items[0] : items[index];
    if (!item) return;
    const active = overlayLayoutState.kind === 'slideshow' || index === overlayLayoutState.selectedIndex;
    const saved = overlayLayoutSavedValue(item);
    const dimensions = overlayLayoutDimensions(item, index);
    const layout = active && overlayLayoutState.editing && overlayLayoutState.draftLayout
      ? overlayLayoutState.draftLayout
      : normalizeEditorLayout(saved, dimensions, saved ? 'editable' : 'legacy');
    Object.assign(layer.style, layoutToCss(layout, rect));
    layer.classList.toggle('legacy', layout.legacy === true);
  });
  const layout = activeOverlayEditorLayout();
  $('#overlayLayoutReadout').textContent = layout
    ? `X ${Math.round(layout.x)} · Y ${Math.round(layout.y)} · W ${Math.round(layout.width)} · H ${Math.round(layout.height)}`
    : '1920 x 1080';
}

function renderOverlayLayoutPicker() {
  const picker = $('#overlayLayoutLayerPicker');
  const items = overlayLayoutItems();
  if (overlayLayoutState.kind === 'slideshow') {
    const first = items[0];
    picker.innerHTML = first ? `<button class="active" type="button" disabled>
      <img src="${escapeHtml(first.url || '')}" alt=""><span>幻灯片公共图层</span>
    </button>` : '';
    return;
  }
  picker.innerHTML = items.map((item, index) => `<button type="button" data-overlay-layout-index="${index}" class="${index === overlayLayoutState.selectedIndex ? 'active' : ''}" aria-pressed="${index === overlayLayoutState.selectedIndex}" ${overlayLayoutState.editing ? 'disabled' : ''}>
    <img src="${escapeHtml(item.url || '')}" alt=""><span>${escapeHtml(item.name || `水印 ${index + 1}`)}</span>
  </button>`).join('');
  picker.querySelectorAll('[data-overlay-layout-index]').forEach(button => {
    button.addEventListener('click', () => {
      if (overlayLayoutState.editing) return;
      overlayLayoutState.selectedIndex = Number(button.dataset.overlayLayoutIndex);
      overlayLayoutState.draftLayout = null;
      renderOverlayLayoutEditor();
    });
  });
}

function renderOverlayLayoutLayers() {
  const items = overlayLayoutItems();
  const displayed = overlayLayoutState.kind === 'slideshow'
    ? (items.length ? [items[overlayLayoutState.slideshowIndex % items.length]] : [])
    : items;
  const layers = $('#overlayLayoutLayers');
  layers.innerHTML = displayed.map((item, displayIndex) => {
    const index = overlayLayoutState.kind === 'slideshow' ? 0 : displayIndex;
    const active = overlayLayoutState.kind === 'slideshow' || index === overlayLayoutState.selectedIndex;
    const classes = ['overlay-layout-layer', active ? 'active' : '', active && overlayLayoutState.editing ? 'editing' : '']
      .filter(Boolean).join(' ');
    return `<div class="${classes}" data-index="${index}">
      <img src="${escapeHtml(item.url || '')}" alt="">
      ${active && overlayLayoutState.editing ? '<span class="overlay-layout-resize-handle" aria-hidden="true"></span>' : ''}
    </div>`;
  }).join('');
  layers.querySelectorAll('.overlay-layout-layer img').forEach(image => {
    const layer = image.closest('.overlay-layout-layer');
    const index = Number(layer.dataset.index);
    const item = overlayLayoutState.kind === 'slideshow' ? displayed[0] : items[index];
    image.addEventListener('load', () => {
      if (overlayLayoutState.kind === 'watermark' && item && image.naturalWidth && image.naturalHeight) {
        overlayLayoutState.imageDimensions.set(
          overlayLayoutAssetKey(item, index),
          { width: image.naturalWidth, height: image.naturalHeight },
        );
        if (overlayLayoutState.editing && index === overlayLayoutState.selectedIndex && overlayLayoutState.draftLayout) {
          overlayLayoutState.draftLayout = normalizeEditorLayout(
            serializeOverlayLayout(overlayLayoutState.draftLayout),
            { width: image.naturalWidth, height: image.naturalHeight },
            'editable',
          );
        }
      }
      refreshOverlayLayoutGeometry();
    });
    image.addEventListener('error', () => {
      if (index === overlayLayoutState.selectedIndex) setOverlayLayoutStatus('无法读取图片尺寸，正在使用安全默认比例');
    });
  });
  refreshOverlayLayoutGeometry();
}

function renderOverlayLayoutEditor() {
  const kindLabel = overlayLayoutState.kind === 'watermark' ? '画面水印' : '幻灯片';
  $('#overlayLayoutTitle').textContent = `${kindLabel}布局预览`;
  $('#overlayLayoutAdjustBtn').textContent = overlayLayoutState.editing ? '保存' : '调节';
  $('#overlayLayoutAdjustBtn').disabled = !activeOverlayLayoutItem();
  $('#overlayLayoutCanvas').classList.toggle('editing', overlayLayoutState.editing);
  renderOverlayLayoutPicker();
  renderOverlayLayoutLayers();
}

function clearOverlayLayoutPreviewPoll() {
  if (overlayLayoutState.previewPollTimer) clearTimeout(overlayLayoutState.previewPollTimer);
  overlayLayoutState.previewPollTimer = null;
}

function clearOverlayLayoutSlideshowTimer() {
  if (overlayLayoutState.slideshowTimer) clearTimeout(overlayLayoutState.slideshowTimer);
  overlayLayoutState.slideshowTimer = null;
}

function scheduleOverlayLayoutSlideshow() {
  clearOverlayLayoutSlideshowTimer();
  if (overlayLayoutState.kind !== 'slideshow' || !$('#overlayLayoutDialog').open) return;
  const images = pipelineSlideshow.images || [];
  if (images.length < 2) return;
  const intervalMs = Math.max(500, Number(pipelineSlideshow.intervalMs) || 2000);
  overlayLayoutState.slideshowTimer = setTimeout(() => {
    if (overlayLayoutState.kind !== 'slideshow' || !$('#overlayLayoutDialog').open) return;
    overlayLayoutState.slideshowIndex = (overlayLayoutState.slideshowIndex + 1) % images.length;
    renderOverlayLayoutLayers();
    scheduleOverlayLayoutSlideshow();
  }, intervalMs);
}

function scheduleOverlayLayoutPreviewPoll() {
  clearOverlayLayoutPreviewPoll();
  if (!overlayLayoutState.previewId || !$('#overlayLayoutDialog').open) return;
  overlayLayoutState.previewPollTimer = setTimeout(() => pollOverlayLayoutPreview(), 1000);
}

async function pollOverlayLayoutPreview() {
  const id = overlayLayoutState.previewId;
  if (!id || !$('#overlayLayoutDialog').open) return;
  try {
    const preview = await api(`/api/previews/${encodeURIComponent(id)}`);
    if (id !== overlayLayoutState.previewId || !$('#overlayLayoutDialog').open) return;
    setOverlayLayoutStatus(preview.state === 'receiving'
      ? `${preview.sourceLabel || '当前输入源'} · 预览已连接`
      : previewStatusMessage(preview));
    scheduleOverlayLayoutPreviewPoll();
  } catch (error) {
    if (id !== overlayLayoutState.previewId || !$('#overlayLayoutDialog').open) return;
    setOverlayLayoutStatus(`${error.message}；仍可调节画面布局`);
    clearOverlayLayoutPreviewPoll();
  }
}

function detachOverlayLayoutPreview() {
  const id = overlayLayoutState.previewId;
  overlayLayoutState.previewId = '';
  overlayLayoutState.requestToken += 1;
  clearOverlayLayoutPreviewPoll();
  clearOverlayLayoutSlideshowTimer();
  const image = $('#overlayLayoutBackground');
  image.removeAttribute('src');
  image.hidden = true;
  return id;
}

async function releaseOverlayLayoutPreview() {
  if (overlayLayoutState.closing) return;
  overlayLayoutState.closing = true;
  const id = detachOverlayLayoutPreview();
  try {
    if (id) await api(`/api/previews/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' });
  } catch {
  } finally {
    overlayLayoutState.closing = false;
  }
}

async function openOverlayLayoutEditor(kind) {
  const items = overlayLayoutItems(kind);
  if (!items.length) return alert(kind === 'watermark' ? '请先添加水印图片' : '请先添加幻灯片图片');
  const dialog = $('#overlayLayoutDialog');
  overlayLayoutState.kind = kind;
  overlayLayoutState.selectedIndex = 0;
  overlayLayoutState.editing = false;
  overlayLayoutState.draftLayout = null;
  overlayLayoutState.pointer = null;
  overlayLayoutState.slideshowIndex = 0;
  overlayLayoutState.imageDimensions = new Map();
  overlayLayoutState.requestToken += 1;
  const requestToken = overlayLayoutState.requestToken;
  $('#overlayLayoutBackground').hidden = true;
  $('#overlayLayoutEmpty').hidden = false;
  setOverlayLayoutStatus('正在连接当前输入源…');
  renderOverlayLayoutEditor();
  if (!dialog.open) dialog.showModal();

  const form = $('#pipelineForm');
  const validationError = validatePipelineInput(new FormData(form));
  if (validationError) {
    setOverlayLayoutStatus(`${validationError}；仍可调节画面布局`);
    return;
  }
  try {
    const preview = await api('/api/previews', {
      method: 'POST',
      body: JSON.stringify(buildPreviewRequest(form)),
    });
    if (requestToken !== overlayLayoutState.requestToken || !dialog.open) {
      await api(`/api/previews/${encodeURIComponent(preview.id)}/stop`, { method: 'POST', body: '{}' }).catch(() => {});
      return;
    }
    overlayLayoutState.previewId = preview.id;
    $('#overlayLayoutBackground').src = `/api/previews/${encodeURIComponent(preview.id)}/stream?format=mjpeg&epoch=${Date.now()}`;
    setOverlayLayoutStatus(previewStatusMessage(preview));
    scheduleOverlayLayoutPreviewPoll();
    scheduleOverlayLayoutSlideshow();
  } catch (error) {
    if (requestToken !== overlayLayoutState.requestToken || !dialog.open) return;
    setOverlayLayoutStatus(`${error.message}；仍可调节画面布局`);
  }
}

function toggleOverlayLayoutAdjustment() {
  const item = activeOverlayLayoutItem();
  if (!item) return;
  if (!overlayLayoutState.editing) {
    const saved = overlayLayoutSavedValue(item);
    overlayLayoutState.draftLayout = normalizeEditorLayout(
      saved,
      overlayLayoutDimensions(item, overlayLayoutState.selectedIndex),
      'editable',
    );
    overlayLayoutState.editing = true;
    renderOverlayLayoutEditor();
    $('#overlayLayoutCanvas').focus();
    return;
  }
  const committed = commitOverlayDraft(
    overlayLayoutState.kind,
    overlayLayoutState.selectedIndex,
    overlayLayoutState.draftLayout,
    pipelineWatermarks,
    pipelineSlideshow,
  );
  pipelineWatermarks = committed.watermarks;
  pipelineSlideshow = committed.slideshow;
  overlayLayoutState.editing = false;
  overlayLayoutState.draftLayout = null;
  overlayLayoutState.pointer = null;
  renderPipelineOverlays();
  renderOverlayLayoutEditor();
  showToast('画面布局已保存到当前任务草稿');
}

function bindOverlayLayoutPointerEvents() {
  const canvas = $('#overlayLayoutCanvas');
  canvas.addEventListener('pointerdown', event => {
    if (!overlayLayoutState.editing || !overlayLayoutState.draftLayout) return;
    const layer = event.target.closest('.overlay-layout-layer.active');
    if (!layer) return;
    overlayLayoutState.pointer = {
      id: event.pointerId,
      mode: event.target.closest('.overlay-layout-resize-handle') ? 'resize' : 'move',
      clientX: event.clientX,
      clientY: event.clientY,
      layout: { ...overlayLayoutState.draftLayout },
    };
    canvas.setPointerCapture(event.pointerId);
    event.preventDefault();
  });
  canvas.addEventListener('pointermove', event => {
    const pointer = overlayLayoutState.pointer;
    if (!pointer || pointer.id !== event.pointerId) return;
    const rect = canvas.getBoundingClientRect();
    const deltaX = (event.clientX - pointer.clientX) * 1920 / rect.width;
    const deltaY = (event.clientY - pointer.clientY) * 1080 / rect.height;
    if (pointer.mode === 'move') {
      overlayLayoutState.draftLayout = {
        ...pointer.layout,
        x: pointer.layout.x + deltaX,
        y: pointer.layout.y + deltaY,
      };
    } else {
      const item = activeOverlayLayoutItem();
      const dimensions = overlayLayoutDimensions(item, overlayLayoutState.selectedIndex);
      const aspectRatio = dimensions.width / dimensions.height;
      const width = Math.max(1, pointer.layout.width + deltaX);
      overlayLayoutState.draftLayout = { ...pointer.layout, width, height: width / aspectRatio };
    }
    renderOverlayLayoutLayers();
  });
  const finish = event => {
    if (!overlayLayoutState.pointer || overlayLayoutState.pointer.id !== event.pointerId) return;
    overlayLayoutState.pointer = null;
    if (canvas.hasPointerCapture(event.pointerId)) canvas.releasePointerCapture(event.pointerId);
  };
  canvas.addEventListener('pointerup', finish);
  canvas.addEventListener('pointercancel', finish);
}

function handleOverlayLayoutKeydown(event) {
  if (!overlayLayoutState.editing || !overlayLayoutState.draftLayout) return;
  const directions = {
    ArrowUp: [0, -1],
    ArrowDown: [0, 1],
    ArrowLeft: [-1, 0],
    ArrowRight: [1, 0],
  };
  const direction = directions[event.key];
  if (!direction) return;
  const step = event.shiftKey ? 10 : 1;
  overlayLayoutState.draftLayout = {
    ...overlayLayoutState.draftLayout,
    x: overlayLayoutState.draftLayout.x + direction[0] * step,
    y: overlayLayoutState.draftLayout.y + direction[1] * step,
  };
  event.preventDefault();
  renderOverlayLayoutLayers();
}

function clearInputPreviewPoll() {
  if (inputPreviewState.pollTimer) clearTimeout(inputPreviewState.pollTimer);
  inputPreviewState.pollTimer = null;
}

function scheduleInputPreviewPoll() {
  clearInputPreviewPoll();
  if (!inputPreviewState.id || !$('#inputPreviewDialog').open) return;
  inputPreviewState.pollTimer = setTimeout(() => {
    pollInputPreview();
  }, 1000);
}

async function pollInputPreview() {
  const id = inputPreviewState.id;
  if (!id || !$('#inputPreviewDialog').open) return;
  try {
    const preview = await api(`/api/previews/${encodeURIComponent(id)}`);
    if (inputPreviewState.id !== id || !$('#inputPreviewDialog').open) return;
    renderInputPreview(preview);
    scheduleInputPreviewPoll();
  } catch (error) {
    if (inputPreviewState.id !== id || !$('#inputPreviewDialog').open) return;
    renderInputPreview({ state: 'failed', message: error.message, sourceLabel: '当前输入源' });
    clearInputPreviewPoll();
  }
}

async function releaseInputPreview() {
  if (inputPreviewState.closing) return;
  inputPreviewState.closing = true;
  clearInputPreviewPoll();
  const id = inputPreviewState.id;
  inputPreviewState.id = '';
  inputPreviewState.pipelineId = '';
  const image = $('#inputPreviewImage');
  const video = $('#inputPreviewVideo');
  video.pause();
  video.removeAttribute('src');
  video.load();
  video.hidden = true;
  image.removeAttribute('src');
  image.hidden = true;
  try {
    if (id) await api(`/api/previews/${encodeURIComponent(id)}/stop`, { method: 'POST', body: '{}' });
  } catch {
  } finally {
    inputPreviewState.closing = false;
  }
}

async function openInputPreview() {
  if (inputPreviewState.closing) return;
  inputPreviewState.pipelineId = '';
  const form = $('#pipelineForm');
  const validationError = validatePipelineInput(new FormData(form));
  if (validationError) return showPipelineValidationError(validationError);
  const cardMonitorPipelineId = editingPipelineId || '';
  const dialog = $('#inputPreviewDialog');
  renderInputPreview({ state: 'connecting', sourceLabel: '当前输入源', latencyMs: 1000 });
  if (!dialog.open) dialog.showModal();
  try {
    if (cardMonitorPipelineId) await releasePipelineCardMonitor(cardMonitorPipelineId);
    const formData = new FormData(form);
    const inputType = formData.get('inputType');
    if (inputType === 'file') {
      const asset = findMediaAsset(formData.get('mediaId'));
      if (!asset) throw new Error('请选择有效的视频素材');
      renderInputPreview({ state: 'receiving', sourceLabel: asset.name, width: asset.width, height: asset.height, fps: asset.fps || 0, browserVideoUrl: asset.url });
    $('#inputPreviewVideo').play().catch(() => {});
      return;
    }
    if (inputType === 'scene') {
      const scene = findScene(formData.get('sceneId'));
      const asset = scene && scene.sourceType === 'playlist' ? findMediaAsset((scene.playlist || [])[0]) : null;
      if (asset) {
        renderInputPreview({ state: 'receiving', sourceLabel: scene.name, width: asset.width, height: asset.height, fps: asset.fps || 0, browserVideoUrl: asset.url });
        $('#inputPreviewVideo').play().catch(() => {});
        return;
      }
    }
    const preview = await api('/api/previews?format=mp4', {
      method: 'POST',
      body: JSON.stringify({ ...buildPreviewRequest(form), format: 'mp4' }),
    });
    inputPreviewState.id = preview.id;
    renderInputPreview(preview);
    const previewVideo = $('#inputPreviewVideo');
    previewVideo.hidden = false;
    previewVideo.src = `/api/previews/${encodeURIComponent(preview.id)}/stream?format=mp4&epoch=${Date.now()}`;
    previewVideo.load();
    previewVideo.play().catch(() => {});
    scheduleInputPreviewPoll();
  } catch (error) {
    renderInputPreview({ state: 'failed', message: friendlyPipelineError(error.message), sourceLabel: '当前输入源' });
  }
}

function setDecklinkStatus(message = '', error = false) {
  const status = $('#decklinkStatus');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', Boolean(error));
}

function setV4l2Status(message = '', error = false) {
  const status = $('#v4l2Status');
  if (!status) return;
  status.textContent = message;
  status.classList.toggle('error', Boolean(error));
}

function renderCaptureDeviceSelect(select, devices, selected, emptyLabel, firstOption = null) {
  if (!select) return '';
  const current = String(selected ?? select.value ?? '').trim();
  const items = Array.isArray(devices) ? devices : [];
  select.replaceChildren();
  if (firstOption) select.add(new Option(firstOption.label, firstOption.value));
  items.forEach(device => {
    const value = String(device && (device.id || device.path) || '').trim();
    if (!value) return;
    const label = String(device.label || device.name || value);
    select.add(new Option(label, value));
  });
  const hasCurrent = current && Array.from(select.options).some(option => option.value === current);
  if (current && !hasCurrent) {
    select.add(new Option(`当前配置：${current}（设备暂未发现）`, current));
  }
  if (current && Array.from(select.options).some(option => option.value === current)) {
    select.value = current;
  } else if (!items.length && !firstOption) {
    select.add(new Option(emptyLabel, ''));
    select.value = '';
  } else if (!current && select.options.length) {
    select.selectedIndex = 0;
  }
  return select.value;
}

function renderDecklinkDeviceOptions(devices = []) {
  const list = $('#decklinkDeviceOptions');
  if (!list) return;
  list.innerHTML = devices.map(name => `<option value="${escapeHtml(name)}"></option>`).join('');
}

function renderDecklinkFormatOptions(formats = []) {
  const list = $('#decklinkFormatOptions');
  if (!list) return;
  list.innerHTML = ['<option value="auto">自动检测</option>'].concat(formats.map(format => (
    `<option value="${escapeHtml(format.code)}">${escapeHtml(`${format.width}x${format.height} ${format.fps} ${format.scan || ''}`.trim())}</option>`
  ))).join('');
}

async function loadCaptureDevices({ force = false } = {}) {
  if (force) captureDeviceCache = null;
  if (!captureDeviceCache) {
    if (!captureDeviceLoadPromise) {
      captureDeviceLoadPromise = api('/api/devices').finally(() => {
        captureDeviceLoadPromise = null;
      });
    }
    captureDeviceCache = await captureDeviceLoadPromise;
  }
  const v4l2 = captureDeviceCache.v4l2 || {};
  const alsa = captureDeviceCache.alsa || {};
  const form = $('#pipelineForm');
  const selectedVideo = form && form.elements.videoDevice ? form.elements.videoDevice.value : '';
  const selectedAudio = form && form.elements.audioDevice ? form.elements.audioDevice.value : 'disabled';
  renderCaptureDeviceSelect($('#videoDevice'), v4l2.devices || [], selectedVideo, '未发现视频设备');
  renderCaptureDeviceSelect($('#audioDevice'), alsa.devices || [], selectedAudio, '未发现音频设备', {
    value: 'disabled',
    label: '不使用音频',
  });

  const videoCount = Array.isArray(v4l2.devices) ? v4l2.devices.length : 0;
  const audioCount = Array.isArray(alsa.devices) ? alsa.devices.length : 0;
  const errors = [];
  if (!videoCount && v4l2.error) errors.push(`视频设备发现失败：${v4l2.error}`);
  if (!audioCount && alsa.error) errors.push(`音频设备发现失败：${alsa.error}`);
  if (errors.length) {
    setV4l2Status(`${errors.join('；')}。请检查采集卡连接和设备工具安装。`, true);
  } else if (!videoCount) {
    setV4l2Status('未发现视频设备，请连接采集卡后点击“刷新设备”。', true);
  } else {
    const audioSummary = audioCount ? `、${audioCount} 个音频设备` : '，暂无音频设备（可保持“不使用音频”）';
    setV4l2Status(`已发现 ${videoCount} 个视频设备${audioSummary}，请选择要使用的信号。`);
  }

  const decklink = captureDeviceCache.decklink || {};
  renderDecklinkDeviceOptions(decklink.devices || []);
  if (decklink.devices && decklink.devices.length) {
    setDecklinkStatus(`已发现 ${decklink.devices.length} 个 DeckLink 输入设备`);
  } else {
    setDecklinkStatus(decklink.error || '未自动发现 DeckLink 设备，可继续手工输入设备名', true);
  }
  return captureDeviceCache;
}

async function loadDecklinkFormats(device) {
  const name = String(device || '').trim();
  renderDecklinkFormatOptions([]);
  if (!name) return;
  try {
    const result = await api(`/api/devices?decklinkDevice=${encodeURIComponent(name)}`);
    const decklink = result.decklink || {};
    renderDecklinkFormatOptions(decklink.formats || []);
    if (decklink.formats && decklink.formats.length) {
      setDecklinkStatus(`已读取 ${decklink.formats.length} 个输入格式`);
    } else {
      setDecklinkStatus(decklink.error || '未读取到格式，可保留 auto 后在启动时重新检测', true);
    }
  } catch (error) {
    setDecklinkStatus(`格式读取失败：${error.message}；仍可手工输入格式码`, true);
  }
}

function updateCaptureBackendFields() {
  const form = $('#pipelineForm');
  if (!form) return;
  const backend = form.elements.captureBackend ? form.elements.captureBackend.value : 'v4l2';
  $$('[data-capture-backend]').forEach(group => {
    group.hidden = group.dataset.captureBackend !== backend;
  });
  if (form.elements.inputType && form.elements.inputType.value === 'capture' && backend === 'decklink') {
    loadCaptureDevices().catch(error => setDecklinkStatus(`设备发现失败：${error.message}；可手工输入设备名`, true));
  } else if (form.elements.inputType && form.elements.inputType.value === 'capture') {
    loadCaptureDevices().catch(error => setV4l2Status(`设备发现失败：${error.message}`, true));
  }
}

function updateInputFields() {
  const type = $('#inputType').value;
  $$('.input-mode').forEach(el => {
    el.hidden = el.dataset.inputMode !== type;
  });
  updateCaptureBackendFields();
  syncLiveDelayControls();
  syncEncodingControls();
}

function pipelineInputValues(pipeline) {
  const input = pipeline && pipeline.input || {};
  if (input.type === 'room') return { inputType: 'room', roomId: input.roomId };
  if (input.type === 'url') return { inputType: 'url', url: input.url };
  if (input.type === 'file' || input.type === 'playlist') return { inputType: 'file', mediaId: input.mediaId || (input.mediaIds || [])[0] || '' };
  if (input.type === 'scene') return { inputType: 'scene', sceneId: input.sceneId || '' };
  if (input.type === 'capture') {
    const capture = input.capture || {};
    if (capture.backend === 'decklink') {
      return {
        inputType: 'capture',
        captureBackend: 'decklink',
        decklinkDevice: capture.device,
        decklinkFormatCode: capture.formatCode || 'auto',
        decklinkRawFormat: capture.rawFormat || 'uyvy422',
        decklinkAudioChannels: Number(capture.audioChannels || 2),
      };
    }
    return {
      inputType: 'capture',
      captureBackend: 'v4l2',
      videoDevice: capture.videoDevice,
      audioDevice: capture.audioDevice || 'disabled',
    };
  }
  return { inputType: 'legacy', sourceId: pipeline && pipeline.sourceId };
}

function pipelineEncodingInput(pipeline) {
  if (pipeline && pipeline.input && pipeline.input.type) return normalizeEncodingInput(pipeline.input);
  const source = pipeline && pipeline.sourceId && state
    ? (state.sources || []).find(item => item.id === pipeline.sourceId)
    : null;
  return normalizeEncodingInput(source);
}

function pipelineEncodingValidationError(pipeline) {
  const settings = pipeline && pipeline.settings || {};
  const live = settings.live || {};
  const input = pipelineEncodingInput(pipeline);
  const requested = live.videoEncoder || 'auto';
  const hasVisual = visualProcessingActive(settings);
  if (requested === 'copy' && (input.type === 'capture' || hasVisual)) {
    return '原样复制不能用于采集卡输入、水印或幻灯片，请选择自动或明确的视频编码器';
  }
  const mode = resolveEncodingMode(requested, input, hasVisual);
  const pipelineMode = pipeline.mode
    || (pipelineEnabledDestinations(pipeline).length > 1 || input.type === 'capture' ? 'shared-relay' : 'direct');
  if (mode === 'copy' && pipelineMode === 'direct') {
    return '原样复制必须使用共享转推，直连推送只支持 CPU 或 NVENC 编码';
  }
  if (mode !== 'unsupported') return '';
  return requested === 'auto'
    ? '自动模式无法识别当前输入，请选择明确的视频编码器'
    : '当前视频编码器无法识别，请选择自动或明确的视频编码器';
}

async function startPipeline(id) {
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return alert('未找到分发任务');
  const inputError = validatePipelineInput(pipelineInputValues(pipeline));
  if (inputError) {
    editPipeline(id);
    showPipelineValidationError(inputError);
    return;
  }
  const encodingError = pipelineEncodingValidationError(pipeline);
  if (encodingError) {
    editPipeline(id);
    showPipelineValidationError(encodingError);
    return;
  }
  if (!pipelineEnabledDestinations(pipeline).length) {
    editPipeline(id);
    showPipelineValidationError('这个分发任务没有启用的输出目标，请先添加至少一个已启用的目标端点');
    return;
  }
  if (!confirmDangerousAction('确认开始这个分发任务？开始后会调用 FFmpeg 并向已选平台推流。')) return;
  try {
    await api(`/api/pipelines/${id}/start`, { method: 'POST', body: '{}' });
    await loadState();
    show('monitor');
  } catch (e) {
    alert(e.message);
  }
}

function openLiveDelayStopDialog(pipeline) {
  const dialog = $('#liveDelayStopDialog');
  const active = state.monitor && (state.monitor.activePipelines || []).find(item => item.pipelineId === pipeline.id);
  const configuredSeconds = Number(pipeline.settings && pipeline.settings.live && pipeline.settings.live.delaySeconds) || 20;
  const remainingSeconds = Math.max(0, Math.ceil(Number(active && active.liveDelay && active.liveDelay.remainingSeconds) || configuredSeconds));
  pendingLiveDelayStopPipelineId = pipeline.id;
  $('#liveDelayStopMessage').textContent = active && active.status === 'draining'
    ? `当前仍有约 ${remainingSeconds} 秒延时内容待播。可以继续等待播完，或立即切断并丢弃剩余内容。`
    : `当前直播设置了 ${configuredSeconds} 秒延时。停止直播会先停止输入并播完缓冲内容；切断直播会立即丢弃延时内容并断流。`;
  if (!dialog.open) dialog.showModal();
  $('#cancelLiveDelayStopBtn').focus();
}

function setLiveDelayStopPending(pending) {
  for (const id of ['drainLiveDelayBtn', 'discardLiveDelayBtn', 'cancelLiveDelayStopBtn']) {
    $(`#${id}`).disabled = Boolean(pending);
  }
}

async function requestPipelineStop(id, mode) {
  setLiveDelayStopPending(true);
  try {
    await api(`/api/pipelines/${id}/stop`, {
      method: 'POST',
      body: JSON.stringify({ mode }),
    });
    if ($('#liveDelayStopDialog').open) $('#liveDelayStopDialog').close();
    await loadState();
    showToast(mode === 'drain' ? '输入已停止，将播完延时内容后结束直播' : '直播已切断');
  } catch (e) {
    alert(e.message);
  } finally {
    setLiveDelayStopPending(false);
  }
}

async function stopPipeline(id) {
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return alert('未找到分发任务');
  const active = state.monitor && (state.monitor.activePipelines || []).find(item => item.pipelineId === id);
  const liveSettings = pipeline.settings && pipeline.settings.live || {};
  const hasLiveDelay = liveSettings.delayEnabled === true || Boolean(active && active.liveDelay && active.liveDelay.enabled);
  if (hasLiveDelay && ['running', 'starting', 'fallback', 'draining'].includes(pipelineRuntimeStatus(pipeline))) {
    return openLiveDelayStopDialog(pipeline);
  }
  if (!confirmDangerousAction('确认停止这个分发任务？停止后当前输出平台会断流。')) return;
  return requestPipelineStop(id, 'discard');
}

async function openPipelinePreview(id) {
  if (inputPreviewState.closing) return;
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return alert('未找到分发任务');
  await releasePipelineCardMonitor(id);
  await releaseInputPreview();
  inputPreviewState.pipelineId = id;
  const dialog = $('#inputPreviewDialog');
  renderInputPreview({ state: 'connecting', sourceLabel: describePipelineInput(pipeline), latencyMs: 1000 });
  if (!dialog.open) dialog.showModal();
  try {
    const preview = await api('/api/previews?format=mp4', {
      method: 'POST',
      body: JSON.stringify({ ...createPipelineInputPreviewRequest(pipeline), format: 'mp4' }),
    });
    inputPreviewState.id = preview.id;
    renderInputPreview(preview);
    const video = $('#inputPreviewVideo');
    video.hidden = false;
    video.src = `/api/previews/${encodeURIComponent(preview.id)}/stream?format=mp4&epoch=${Date.now()}`;
    video.load();
    video.play().catch(() => {});
    scheduleInputPreviewPoll();
  } catch (error) {
    renderInputPreview({ state: 'failed', message: friendlyPipelineError(error.message), sourceLabel: describePipelineInput(pipeline) });
  }
}

async function duplicatePipeline(id) {
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return alert('未找到分发任务');
  const payload = {
    name: `${pipeline.name || '分发任务'} 副本`,
    ...(pipeline.input ? { input: JSON.parse(JSON.stringify(pipeline.input)) } : { sourceId: pipeline.sourceId }),
    destinationIds: Array.isArray(pipeline.destinationIds) ? [...pipeline.destinationIds] : [],
    mode: pipeline.mode || 'shared-relay',
    settings: JSON.parse(JSON.stringify(pipeline.settings || {})),
  };
  try {
    await api('/api/pipelines', { method: 'POST', body: JSON.stringify(payload) });
    await loadState();
    showToast(`已创建“${payload.name}”`);
  } catch (error) {
    showToast(error.message);
  }
}

async function refreshPipelineProgram(id) {
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return;
  try {
    await loadState();
    showToast('当前 Program 已刷新');
  } catch (error) {
    showToast(error.message);
  }
}

async function deleteItem(collection, id) {
  if (!confirm('确认删除？')) return;
  await api(`/api/${collection}/${id}`, { method: 'DELETE' });
  await loadState();
  showToast('已删除');
}

async function toggleRoom(id, enabled) {
  const room = (state.rooms || []).find(item => item.id === id);
  const name = room ? `“${room.name}”` : '';
  if (!confirmDangerousAction(`确认${enabled ? '启用' : '停用'}本地直播间${name}？`)) return;
  await api(`/api/rooms/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  await loadState();
}

async function toggleDestination(id, enabled) {
  const destination = (state.destinations || []).find(item => item.id === id);
  const name = destination ? `“${destination.name}”` : '';
  const detail = enabled
    ? '启用后，正在运行且已选择此平台的任务会立即接入该输出。'
    : '禁用后，仅该平台会立即断流，其他平台和共享中继保持运行。';
  if (!confirmDangerousAction(`确认${enabled ? '启用' : '停用'}输出目标${name}？\n\n${detail}`)) return;
  await api(`/api/destinations/${id}`, { method: 'PUT', body: JSON.stringify({ enabled }) });
  await loadState();
}

function editDestination(id) {
  const destination = (state.destinations || []).find(item => item.id === id);
  if (!destination) return alert('未找到输出目标');
  editingDestinationId = id;
  const form = $('#destinationForm');
  setControlValue(form, 'name', destination.name || '');
  setControlValue(form, 'protocol', destination.protocol || 'rtmp');
  setControlValue(form, 'server', destination.server || '');
  setControlValue(form, 'streamKey', destination.streamKey || '');
  setControlValue(form, 'url', destination.url || '');
  updateDestinationEditUi();
  show('destinations');
  setEntityFormVisible('#destinationForm', true);
}

function editRoom(id) {
  const room = (state.rooms || []).find(item => item.id === id);
  if (!room) return alert('未找到本地直播间');
  editingRoomId = id;
  const form = $('#roomForm');
  setControlValue(form, 'name', room.name || '');
  setControlValue(form, 'streamName', room.streamName || '');
  updateRoomEditUi();
  show('rooms');
  setEntityFormVisible('#roomForm', true);
}

function editPipeline(id) {
  const pipeline = (state.pipelines || []).find(item => item.id === id);
  if (!pipeline) return alert('未找到分发任务');
  if (['running', 'starting', 'fallback', 'draining'].includes(pipelineRuntimeStatus(pipeline))) {
    return alert('任务正在运行，请先停止后再修改');
  }

  advancePipelineFormGeneration();
  editingPipelineId = id;
  const form = $('#pipelineForm');
  $('#uploadWatermarkBtn').disabled = false;
  $('#uploadSlideshowBtn').disabled = false;
  $('#watermarkStatus').classList.remove('error');
  $('#slideshowStatus').classList.remove('error');
  setControlValue(form, 'name', pipeline.name || '');
  setControlValue(form, 'mode', pipeline.mode || 'shared-relay');
  setSelectedDestinationIds(pipeline.destinationIds || []);

  const input = pipeline.input || {};
  if (input.type === 'room') {
    setControlValue(form, 'inputType', 'room');
    updateInputFields();
    setControlValue(form, 'roomId', input.roomId || '', '原引用已不存在');
  } else if (input.type === 'url') {
    setControlValue(form, 'inputType', 'url');
    updateInputFields();
    setControlValue(form, 'url', input.url || '');
  } else if (input.type === 'file') {
    setControlValue(form, 'inputType', 'file');
    updateInputFields();
    setControlValue(form, 'mediaId', input.mediaId || (input.mediaIds || [])[0] || '');
    form.elements.fileLoop.checked = input.loop !== false;
  } else if (input.type === 'capture') {
    const capture = input.capture || {};
    setControlValue(form, 'inputType', 'capture');
    setControlValue(form, 'captureBackend', capture.backend || 'v4l2');
    setControlValue(form, 'videoDevice', capture.videoDevice || '/dev/video0');
    setControlValue(form, 'audioDevice', capture.audioDevice || 'disabled');
    setControlValue(form, 'captureResolution', capture.resolution || '1920x1080');
    setControlValue(form, 'captureFps', capture.fps || '59.94');
    setControlValue(form, 'decklinkDevice', capture.device || '');
    setControlValue(form, 'decklinkFormatCode', capture.formatCode || 'auto');
    setControlValue(form, 'decklinkRawFormat', capture.rawFormat || 'uyvy422');
    setControlValue(form, 'decklinkAudioChannels', capture.audioChannels || 2);
    updateInputFields();
    if (capture.backend === 'decklink' && capture.device) loadDecklinkFormats(capture.device);
  } else if (input.type === 'scene') {
    setControlValue(form, 'inputType', 'scene');
    updateInputFields();
    setControlValue(form, 'sceneId', input.sceneId || '', '原场景已不存在');
  } else {
    setControlValue(form, 'inputType', 'legacy');
    updateInputFields();
    setControlValue(form, 'sourceId', pipeline.sourceId || '', '原引用已不存在');
  }

  fillSettingsForm(form, pipeline.settings || {});
  const settings = pipeline.settings || {};
  pipelineNoSignalImage = settings.noSignalImage && settings.noSignalImage.path
    ? { ...settings.noSignalImage }
    : null;
  pipelineWatermarks = Array.isArray(settings.watermarks)
    ? settings.watermarks.map(item => ({ ...item }))
    : settings.watermark ? [{ ...settings.watermark }] : [];
  const slideshow = settings.slideshow || {};
  pipelineSlideshow = {
    images: Array.isArray(slideshow.images) ? slideshow.images.map(item => ({ ...item })) : [],
    intervalMs: Number(slideshow.intervalMs) || 2000,
    transitionMs: Number.isFinite(Number(slideshow.transitionMs)) ? Number(slideshow.transitionMs) : 700,
    loop: true,
    ...(slideshow.layout ? { layout: { ...slideshow.layout } } : {}),
  };
  setControlValue(form, 'slideshowIntervalMs', pipelineSlideshow.intervalMs);
  setControlValue(form, 'slideshowTransitionMs', pipelineSlideshow.transitionMs);
  renderPipelineOverlays();
  renderNoSignalImage();
  syncLiveDelayControls(form);
  syncEncodingControls(form);
  if ($('#pipelineValidationSummary')) {
    $('#pipelineValidationSummary').hidden = true;
    $('#pipelineValidationSummary').textContent = '';
  }
  switchPipelineSection('basic', { focus: false });
  updatePipelineEditUi();
  show('distribution');
  setPipelineFormVisible(true);
}

window.startPipeline = startPipeline;
window.stopPipeline = stopPipeline;
window.deleteItem = deleteItem;
window.toggleRoom = toggleRoom;
window.toggleDestination = toggleDestination;
window.copyText = copyText;
window.confirmDangerousAction = confirmDangerousAction;
window.editRoom = editRoom;
window.editPipeline = editPipeline;
window.editDestination = editDestination;
window.addSelectedDestination = addSelectedDestination;
window.removeSelectedDestination = removeSelectedDestination;

async function loadDevices() {
  const d = await api('/api/devices');
  $('#deviceText').textContent = JSON.stringify(d, null, 2);
}

function selectedLogEntry() {
  return logCatalog.get($('#logSelect').value) || null;
}

function syncLogDeleteButton() {
  const entry = selectedLogEntry();
  $('#deleteLogBtn').disabled = !entry || entry.deletable !== true;
}

function syncLogReportButton() {
  const entry = selectedLogEntry();
  $('#downloadLogReportBtn').disabled = !entry || !entry.pipelineId;
}

async function loadLogs(selectedFile = '') {
  const select = $('#logSelect');
  const preferredFile = selectedFile || select.value;
  const data = await api('/api/logs');
  const logs = Array.isArray(data.logs)
    ? data.logs
    : (data.files || []).map(file => ({ file, displayName: file, active: false, deletable: true }));
  logCatalog = new Map(logs.map(entry => [entry.file, entry]));
  select.innerHTML = '<option value="">请选择日志文件</option>' + logs.map(entry => (
    `<option value="${escapeHtml(entry.file)}">${escapeHtml(entry.displayName)}${entry.active ? '（运行中）' : ''}</option>`
  )).join('');
  select.value = preferredFile && logCatalog.has(preferredFile) ? preferredFile : '';
  syncLogDeleteButton();
  syncLogReportButton();
  if (!select.value) $('#logText').textContent = data.content || '请选择日志文件';
}

$('#logSelect').addEventListener('change', async event => {
  const file = event.target.value;
  syncLogDeleteButton();
  syncLogReportButton();
  if (!file) {
    $('#logText').textContent = '请选择日志文件';
    return;
  }
  const data = await api(`/api/logs?file=${encodeURIComponent(file)}`);
  $('#logText').textContent = data.content || '空日志';
});

async function deleteSelectedLog() {
  const entry = selectedLogEntry();
  if (!entry || entry.deletable !== true) return;
  if (!confirmDangerousAction(`确认删除日志“${entry.displayName}”？`)) return;
  try {
    await api(`/api/logs?file=${encodeURIComponent(entry.file)}`, { method: 'DELETE' });
    await loadLogs();
    $('#logText').textContent = '请选择日志文件';
    showToast('日志已删除');
  } catch (error) {
    showToast(error.status === 409 ? '日志正在运行，无法删除' : error.message);
    syncLogDeleteButton();
  }
}

async function downloadSelectedLogReport() {
  const entry = selectedLogEntry();
  if (!entry || !entry.pipelineId) return;
  const button = $('#downloadLogReportBtn');
  button.disabled = true;
  try {
    const reportUrl = new URL(`/api/reports/pipelines/${encodeURIComponent(entry.pipelineId)}`, window.location.origin);
    if (entry.destinationId) reportUrl.searchParams.set('destinationId', entry.destinationId);
    const response = await fetch(`${reportUrl.pathname}${reportUrl.search}`, {
      headers: { accept: 'application/pdf' },
    });
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}));
      if (response.status === 401) handleUnauthorized();
      throw new Error(payload.error || `HTTP ${response.status}`);
    }
    const contentType = response.headers.get('content-type') || 'application/pdf';
    if (!contentType.includes('application/pdf')) throw new Error('报告文件格式异常');
    const blob = await response.blob();
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = entry.destinationId
      ? `streamhub-output-report-${entry.pipelineId}-${entry.destinationId}.pdf`
      : `streamhub-pipeline-report-${entry.pipelineId}.pdf`;
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showToast('报告已下载');
  } catch (error) {
    showToast(error.message);
  } finally {
    syncLogReportButton();
  }
}

$('#deleteLogBtn').addEventListener('click', deleteSelectedLog);
$('#downloadLogReportBtn').addEventListener('click', downloadSelectedLogReport);

$('#roomForm').addEventListener('submit', async event => {
  event.preventDefault();
  const fd = new FormData(event.target);
  const wasEditing = Boolean(editingRoomId);
  const payload = {
    name: fd.get('name'),
    streamName: fd.get('streamName'),
  };
  await api(editingRoomId ? `/api/rooms/${editingRoomId}` : '/api/rooms', {
    method: editingRoomId ? 'PUT' : 'POST',
    body: JSON.stringify({
      ...payload,
    }),
  });
  resetRoomForm();
  setEntityFormVisible('#roomForm', false);
  await loadState();
  showToast(wasEditing ? '本地直播间已修改' : '本地直播间已保存');
});

$('#pipelineForm').addEventListener('submit', async event => {
  event.preventDefault();
  if (pipelineSubmitPending) return;
  const delayState = syncLiveDelayControls(event.target);
  const fd = new FormData(event.target);
  const inputError = validatePipelineInput(fd);
  if (inputError) return showPipelineValidationError(inputError);
  const encodingState = syncEncodingControls(event.target);
  if (encodingState.error) return showPipelineValidationError(encodingState.error);
  if (!pipelineEnabledDestinations({ destinationIds: selectedDestinationIds }).length) {
    return showPipelineValidationError('请至少添加一个已启用的输出目标');
  }
  const submitGeneration = pipelineFormGeneration;
  const submitEditingPipelineId = editingPipelineId;
  const wasEditing = Boolean(submitEditingPipelineId);
  try {
    const payload = {
      name: fd.get('name'),
      ...buildPipelineInput(event.target),
      destinationIds: selectedDestinationIds,
      mode: delayState.enabled ? 'shared-relay' : fd.get('mode'),
      settings: settingsFromForm(event.target),
    };
    setPipelineSubmitPending(true);
    await api(submitEditingPipelineId ? `/api/pipelines/${submitEditingPipelineId}` : '/api/pipelines', {
      method: submitEditingPipelineId ? 'PUT' : 'POST',
      body: JSON.stringify(payload),
    });
    const ownsSavedForm = pipelineFormOwns(submitGeneration, submitEditingPipelineId);
    if (pipelineFormOwns(submitGeneration, submitEditingPipelineId)) {
      resetPipelineForm();
      setPipelineFormVisible(false);
    }
    await loadState();
    if (ownsSavedForm) showToast(wasEditing ? '分发任务已修改' : '分发任务已保存');
  } catch (error) {
    if (pipelineFormOwns(submitGeneration, submitEditingPipelineId)) showPipelineValidationError(error.message);
  } finally {
    setPipelineSubmitPending(false);
  }
});

$('#destinationForm').addEventListener('submit', async event => {
  event.preventDefault();
  const wasEditing = Boolean(editingDestinationId);
  const existingDestination = editingDestinationId
    ? (state.destinations || []).find(item => item.id === editingDestinationId)
    : null;
  await api(editingDestinationId ? `/api/destinations/${editingDestinationId}` : '/api/destinations', {
    method: editingDestinationId ? 'PUT' : 'POST',
    body: JSON.stringify(destinationPayloadFromForm(event.target, existingDestination)),
  });
  resetDestinationForm();
  setEntityFormVisible('#destinationForm', false);
  await loadState();
  showToast(wasEditing ? '输出目标已修改' : '输出目标已保存');
});

$$('[data-studio-tab]').forEach(button => button.addEventListener('click', () => switchStudioTab(button.dataset.studioTab)));
$('#newSceneBtn').addEventListener('click', startNewScene);
$('#sceneForm').addEventListener('submit', event => {
  event.preventDefault();
  saveScene();
});
$('#resetSceneBtn').addEventListener('click', () => selectStudioScene(selectedSceneId));
$('#deleteSceneBtn').addEventListener('click', () => {
  if (selectedSceneId) deleteScene(selectedSceneId);
});
$$('[data-scene-source-type]').forEach(button => button.addEventListener('click', () => {
  sceneDraft.sourceType = button.dataset.sceneSourceType;
  renderSceneSourceType();
}));
$('#openMediaPickerBtn').addEventListener('click', openMediaPicker);
$('#closeMediaPickerBtn').addEventListener('click', () => $('#mediaPickerDialog').close());
$('#cancelMediaSelectionBtn').addEventListener('click', () => $('#mediaPickerDialog').close());
$('#confirmMediaSelectionBtn').addEventListener('click', confirmMediaSelection);
$('#uploadMediaBtn').addEventListener('click', uploadMediaFiles);
$('#cancelMediaUploadBtn').addEventListener('click', cancelMediaUpload);
$('#mediaUploadInput').addEventListener('change', renderMediaUploadSelection);
$('#uploadSceneWatermarkBtn').addEventListener('click', uploadSceneWatermarks);
$('#recordingForm').addEventListener('submit', event => {
  event.preventDefault();
  startStudioRecording(event.currentTarget);
});
$('#recordingPipeline').addEventListener('change', event => loadRecordingCapacity(event.currentTarget.value));

$('#switcherSceneSelect').addEventListener('change', event => {
  selectSwitcherScene(event.target.value, { restart: true });
});
$('#previewPlaybackBtn').addEventListener('click', async () => {
  const video = $('#switcherPreviewVideo');
  if (video.paused) {
    try {
      await video.play();
      studioSwitcherState.previewPlaying = true;
    } catch {
      studioSwitcherState.previewPlaying = false;
    }
  } else {
    video.pause();
    studioSwitcherState.previewPlaying = false;
  }
  updateSwitcherPlaybackUi();
});
$('#switcherPreviewVideo').addEventListener('ended', () => {
  const scene = switcherScene();
  const next = nextScenePlaylistIndex(studioSwitcherState.previewIndex, scene && scene.playlist && scene.playlist.length || 0);
  if (next >= 0) playSwitcherVideoAt(next, { restart: true });
});
$('#switcherPreviewVideo').addEventListener('play', () => {
  studioSwitcherState.previewPlaying = true;
  updateSwitcherPlaybackUi();
});
$('#switcherPreviewVideo').addEventListener('pause', () => {
  studioSwitcherState.previewPlaying = false;
  updateSwitcherPlaybackUi();
});
$('#switcherProgramImage').addEventListener('load', () => {
  $('#switcherProgramStatus').hidden = true;
});
$('#switcherProgramImage').addEventListener('error', () => {
  $('#switcherProgramStatus').hidden = false;
  $('#switcherProgramStatus').textContent = 'Program 预览暂时不可用，正在等待画面';
});
$('#switchSceneBtn').addEventListener('click', switchSceneToProgram);
$('#restoreProgramBtn').addEventListener('click', restoreStudioProgram);
$('#closeStudioSwitcherBtn').addEventListener('click', () => $('#studioSwitcherDialog').close());
$('#studioSwitcherDialog').addEventListener('close', () => {
  releaseStudioSwitcher();
});

$$('[data-view]').forEach(btn => btn.addEventListener('click', () => {
  const view = btn.dataset.view;
  show(view);
  if (view === 'monitor') loadMonitorHistory().catch(reportMonitorHistoryError);
  const target = btn.dataset.scroll ? document.querySelector(btn.dataset.scroll) : null;
  if (target) target.scrollIntoView({ behavior: 'smooth', block: 'start' });
}));

$$('[data-process-sort]').forEach(button => button.addEventListener('click', () => {
  systemStatusState.processSort = button.dataset.processSort;
  renderProcessStatus();
}));

$('#inputType').addEventListener('change', updateInputFields);
$('#captureBackend').addEventListener('change', updateCaptureBackendFields);
$('#refreshCaptureDevicesBtn').addEventListener('click', async () => {
  const button = $('#refreshCaptureDevicesBtn');
  button.disabled = true;
  setV4l2Status('正在重新发现视频和音频设备…');
  try {
    await loadCaptureDevices({ force: true });
    showToast('采集设备列表已刷新');
  } catch (error) {
    setV4l2Status(`设备发现失败：${error.message}`, true);
  } finally {
    button.disabled = false;
  }
});
$('#previewInputBtn').addEventListener('click', openInputPreview);
$('#closeInputPreviewBtn').addEventListener('click', () => $('#inputPreviewDialog').close());
$('#retryInputPreviewBtn').addEventListener('click', async () => {
  const pipelineId = inputPreviewState.pipelineId;
  await releaseInputPreview();
  if (pipelineId) openPipelinePreview(pipelineId);
  else openInputPreview();
});
$('#inputPreviewDialog').addEventListener('close', () => {
  releaseInputPreview().finally(pumpPipelineCardMonitors);
});
$('#previewWatermarkBtn').addEventListener('click', () => openOverlayLayoutEditor('watermark'));
$('#previewSlideshowBtn').addEventListener('click', () => openOverlayLayoutEditor('slideshow'));
$('#overlayLayoutAdjustBtn').addEventListener('click', toggleOverlayLayoutAdjustment);
$('#overlayLayoutCloseBtn').addEventListener('click', () => $('#overlayLayoutDialog').close());
$('#overlayLayoutCanvas').addEventListener('keydown', handleOverlayLayoutKeydown);
$('#overlayLayoutBackground').addEventListener('load', () => {
  $('#overlayLayoutBackground').hidden = false;
  $('#overlayLayoutEmpty').hidden = true;
});
$('#overlayLayoutBackground').addEventListener('error', () => {
  $('#overlayLayoutBackground').hidden = true;
  $('#overlayLayoutEmpty').hidden = false;
  setOverlayLayoutStatus('当前输入源预览暂不可用，仍可调节画面布局');
});
$('#overlayLayoutDialog').addEventListener('close', () => {
  releaseOverlayLayoutPreview();
  overlayLayoutState.kind = '';
  overlayLayoutState.editing = false;
  overlayLayoutState.draftLayout = null;
  overlayLayoutState.pointer = null;
  overlayLayoutState.slideshowIndex = 0;
});
window.addEventListener('resize', () => {
  if ($('#overlayLayoutDialog').open) refreshOverlayLayoutGeometry();
});
bindOverlayLayoutPointerEvents();
$('#pipelineForm').elements.decklinkDevice.addEventListener('change', event => loadDecklinkFormats(event.target.value));
$('#pipelineForm').elements.videoEncoder.addEventListener('change', () => {
  syncLiveDelayControls($('#pipelineForm'));
  syncEncodingControls($('#pipelineForm'));
});
$('#pipelineForm').elements.rateControl.addEventListener('change', () => syncEncodingControls($('#pipelineForm')));
$('#pipelineForm').elements.mode.addEventListener('change', () => syncEncodingControls($('#pipelineForm')));
$('#pipelineForm').elements.url.addEventListener('input', () => {
  syncLiveDelayControls($('#pipelineForm'));
  syncEncodingControls($('#pipelineForm'));
});
for (const inputName of ['sourceId', 'mediaId', 'sceneId']) {
  const input = $('#pipelineForm').elements[inputName];
  if (input) input.addEventListener('change', () => {
    syncLiveDelayControls($('#pipelineForm'));
    syncEncodingControls($('#pipelineForm'));
  });
}
$('#pipelineForm').elements.delayEnabled.addEventListener('change', () => {
  syncLiveDelayControls($('#pipelineForm'));
  syncEncodingControls($('#pipelineForm'));
});
for (const name of ['delaySeconds', 'bitrateKbps', 'audioBitrateKbps']) {
  $('#pipelineForm').elements[name].addEventListener('input', () => syncLiveDelayControls($('#pipelineForm')));
}
$$('[data-pipeline-section]').forEach(button => button.addEventListener('click', () => {
  switchPipelineSection(button.dataset.pipelineSection);
}));
$('#pipelinePreviousSectionBtn').addEventListener('click', () => {
  const index = PIPELINE_SECTION_ORDER.indexOf(activePipelineSection);
  switchPipelineSection(PIPELINE_SECTION_ORDER[Math.max(0, index - 1)]);
});
$('#pipelineNextSectionBtn').addEventListener('click', () => {
  const index = PIPELINE_SECTION_ORDER.indexOf(activePipelineSection);
  switchPipelineSection(PIPELINE_SECTION_ORDER[Math.min(PIPELINE_SECTION_ORDER.length - 1, index + 1)]);
});
$('#drainLiveDelayBtn').addEventListener('click', () => {
  const pipelineId = pendingLiveDelayStopPipelineId;
  if (pipelineId) requestPipelineStop(pipelineId, 'drain');
});
$('#discardLiveDelayBtn').addEventListener('click', () => {
  const pipelineId = pendingLiveDelayStopPipelineId;
  if (pipelineId) requestPipelineStop(pipelineId, 'discard');
});
$('#cancelLiveDelayStopBtn').addEventListener('click', () => $('#liveDelayStopDialog').close());
$('#liveDelayStopDialog').addEventListener('close', () => {
  pendingLiveDelayStopPipelineId = null;
  setLiveDelayStopPending(false);
});
$('#addDestinationBtn').addEventListener('click', addSelectedDestination);
$('#uploadWatermarkBtn').addEventListener('click', () => uploadOverlayFiles({
  kind: 'watermark', inputId: 'watermarkFile', statusId: 'watermarkStatus', buttonId: 'uploadWatermarkBtn',
}));
$('#uploadSlideshowBtn').addEventListener('click', () => uploadOverlayFiles({
  kind: 'slideshow', inputId: 'slideshowFile', statusId: 'slideshowStatus', buttonId: 'uploadSlideshowBtn',
}));
$('#uploadNoSignalImageBtn').addEventListener('click', uploadNoSignalImage);
$('#newRoomBtn').addEventListener('click', openNewRoomForm);
$('#closeRoomFormBtn').addEventListener('click', closeRoomForm);
$('#cancelRoomEditBtn').addEventListener('click', closeRoomForm);
$('#newPipelineBtn').addEventListener('click', openNewPipelineForm);
$('#closePipelineFormBtn').addEventListener('click', closePipelineForm);
$('#cancelPipelineEditBtn').addEventListener('click', closePipelineForm);
$$('[data-pipeline-filter]').forEach(button => button.addEventListener('click', () => {
  pipelineCardFilters.status = button.dataset.pipelineFilter || 'all';
  $$('[data-pipeline-filter]').forEach(item => {
    const active = item.dataset.pipelineFilter === pipelineCardFilters.status;
    item.classList.toggle('active', active);
    item.setAttribute('aria-pressed', String(active));
  });
  renderPipelineCards();
}));
$('#pipelineSearchInput').addEventListener('input', event => {
  pipelineCardFilters.query = event.currentTarget.value || '';
  renderPipelineCards();
});
$('#newDestinationBtn').addEventListener('click', openNewDestinationForm);
$('#closeDestinationFormBtn').addEventListener('click', closeDestinationForm);
$('#cancelDestinationEditBtn').addEventListener('click', closeDestinationForm);
$('#applyMonitorRangeBtn').addEventListener('click', applyMonitorRange);
$('#monitorRangePreset').addEventListener('change', handleMonitorRangePresetChange);
$('#monitorDetailRangeForm').addEventListener('submit', applyMonitorDetailPeriod);
$('#monitorDetailRangePreset').addEventListener('change', handleMonitorDetailRangePresetChange);
$('#monitorDetailLiveBtn').addEventListener('click', returnMonitorDetailToLive);
$('#resetMonitorDropsBtn').addEventListener('click', resetMonitorDrops);
$('#closeMonitorDetailBtn').addEventListener('click', closeMonitorDetail);
$('#monitorDetailDialog').addEventListener('close', () => {
  monitorDetailState = {
    outputId: '',
    mode: 'rolling',
    rangeSec: 900,
    from: 0,
    to: 0,
    lastOutput: null,
    lastRange: null,
    loading: false,
  };
});
$('#refreshBtn').addEventListener('click', loadState);
$('#loginForm').addEventListener('submit', submitLogin);
$('#userMenuButton').addEventListener('click', event => {
  event.stopPropagation();
  setUserMenuOpen($('#userMenu').hidden);
});
$('#logoutButton').addEventListener('click', logout);
$('#shutdownMenuButton').addEventListener('click', () => {
  setUserMenuOpen(false);
  const dialog = $('#systemShutdownDialog');
  const status = $('#systemShutdownStatus');
  status.hidden = true;
  status.classList.remove('is-error');
  status.textContent = '';
  $('#confirmSystemShutdownButton').disabled = false;
  $('#confirmSystemShutdownButton').textContent = '确认';
  $('#cancelSystemShutdownButton').disabled = false;
  systemShutdownPending = false;
  systemShutdownAccepted = false;
  if (!dialog.open) dialog.showModal();
  $('#cancelSystemShutdownButton').focus();
});
$('#cancelSystemShutdownButton').addEventListener('click', () => {
  if (!systemShutdownPending && !systemShutdownAccepted) $('#systemShutdownDialog').close();
});
$('#confirmSystemShutdownButton').addEventListener('click', async () => {
  if (systemShutdownPending || systemShutdownAccepted) return;
  systemShutdownPending = true;
  const status = $('#systemShutdownStatus');
  const confirmButton = $('#confirmSystemShutdownButton');
  const cancelButton = $('#cancelSystemShutdownButton');
  confirmButton.disabled = true;
  cancelButton.disabled = true;
  confirmButton.textContent = '正在停止服务…';
  status.hidden = false;
  status.classList.remove('is-error');
  status.textContent = '正在停止推流任务并通知服务器关机，请稍候。';
  try {
    await api('/api/system/shutdown', { method: 'POST', body: '{}' });
    systemShutdownAccepted = true;
    status.textContent = '关机请求已确认。推流服务正在停止，服务器即将关机；网页连接断开属于正常现象。';
    confirmButton.textContent = '已确认';
  } catch (error) {
    systemShutdownPending = false;
    status.classList.add('is-error');
    status.textContent = error.message || '无法启动关机流程，请检查服务器服务状态。';
    confirmButton.disabled = false;
    confirmButton.textContent = '重试';
    cancelButton.disabled = false;
  }
});
$('#systemShutdownDialog').addEventListener('cancel', event => {
  if (systemShutdownPending || systemShutdownAccepted) event.preventDefault();
});
document.addEventListener('click', event => {
  const user = $('.console-user');
  if (!$('#userMenu').hidden && !user.contains(event.target)) setUserMenuOpen(false);
});
document.addEventListener('keydown', event => {
  if (event.key === 'Escape' && !$('#userMenu').hidden) {
    setUserMenuOpen(false);
    $('#userMenuButton').focus();
  }
});
document.addEventListener('visibilitychange', () => {
  if (document.hidden) releaseAllPipelineCardMonitors();
  else syncPipelineCardMonitors();
});

window.addEventListener('pagehide', () => {
  const id = detachInputPreview();
  const overlayId = detachOverlayLayoutPreview();
  const studioIds = detachStudioSwitcher();
  const cardIds = Array.from(pipelineCardMonitorState.sessions.values()).map(session => session.id).filter(Boolean);
  pipelineCardMonitorState.sessions.clear();
  for (const previewId of [id, overlayId, ...studioIds, ...cardIds].filter(Boolean)) {
    fetch(`/api/previews/${encodeURIComponent(previewId)}/stop`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{}',
      keepalive: true,
    }).catch(() => {});
  }
});

function startPolling() {
  if (!systemStatusPollTimer) {
    systemStatusPollTimer = setInterval(() => {
      if (authState.authenticated) loadSystemStatus({ silent: true });
    }, 1000);
  }
  if (!monitorPollTimer) {
    monitorPollTimer = setInterval(async () => {
      if (!authState.authenticated) return;
      if (monitorPollPending) return;
      monitorPollPending = true;
      try {
        const monitor = await api('/api/monitor?history=none');
        if (state) {
          state.monitor = mergeLiveMonitorSnapshot(state.monitor, monitor, monitorRangeSec);
          renderMonitor(state.monitor);
          renderSummary();
          renderDashboardResources();
          renderPipelineCards();
        }
        if (
          $('#monitorDetailDialog').open &&
          monitorDetailState.outputId &&
          monitorDetailState.mode !== 'exact'
        ) {
          mergeLiveMonitorDetail(monitor);
        }
      } catch {
      } finally {
        monitorPollPending = false;
      }
    }, 1000);
  }
}

function stopPolling() {
  if (systemStatusPollTimer) {
    clearInterval(systemStatusPollTimer);
    systemStatusPollTimer = null;
  }
  if (monitorPollTimer) {
    clearInterval(monitorPollTimer);
    monitorPollTimer = null;
  }
}

updateInputFields();
updateRoomEditUi();
updatePipelineEditUi();
updateDestinationEditUi();
renderPipelineOverlays();
renderNoSignalImage();
handleMonitorRangePresetChange({ load: false });
handleMonitorDetailRangePresetChange();
initializeTheme();
initializeParameterHelp();
$('#themeToggle').addEventListener('click', () => {
  applyTheme(currentTheme() === 'night' ? 'day' : 'night', true);
});
refreshIcons();
resolveSession();
