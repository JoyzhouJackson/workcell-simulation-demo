const defaultSettings = {
  orders: 10, glueCount: 2, restCount: 2, buffer: 50, restBuffer: 999,
  agvs: 0, maxLoad: 5, speed: 1, loadSeconds: 5, unloadSeconds: 5, combine: true,
  printMachines: 3, prepMinutes: 4, postMinutes: 7, switchMinutes: 3,
  routeTimes: {}, printTimes: {},
};
const printTimeDefaults = [18, 25, 31, 38, 44, 51, 57, 64];
const islandColors = {
  S01: '#537aab', S02: '#298474', S03: '#b06b31', S04: '#8170a9',
  S05: '#3c81aa', S06: '#a86383', S07: '#7b853f',
};
const storageKey = 'workcell-joint-planner-settings-v1';
const get = (id) => document.getElementById(id);
const form = get('scenario-form');
const settingInputs = [...form.querySelectorAll('[data-setting]')];
const routePanel = get('routes');
const playback = { time: 0, playing: false, lastWallTime: 0, request: 0 };

let draft = readDraft();
let activePlan = null;
let routeCatalog = null;
let activeFrame = null;
let runId = 0;
let worker = null;
let factory;
let gantt;

function readDraft() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    const values = Object.fromEntries(Object.entries(defaultSettings).map(([key, value]) => [
      key, saved && typeof saved[key] === typeof value && saved[key] !== null ? saved[key] : value,
    ]));
    return values;
  } catch {
    return { ...defaultSettings };
  }
}

function persistDraft() {
  try { localStorage.setItem(storageKey, JSON.stringify(draft)); } catch { /* Private mode may disable storage. */ }
}

function fillSettings() {
  for (const input of settingInputs) {
    const value = draft[input.dataset.setting];
    if (input.type === 'checkbox') input.checked = value;
    else input.value = value;
  }
}

function sameSettings(left, right) {
  return Object.keys(defaultSettings).every((key) => {
    const first = left?.[key] ?? defaultSettings[key];
    const second = right?.[key] ?? defaultSettings[key];
    if (typeof first !== 'object') return first === second;
    return Object.keys(first).length === Object.keys(second).length &&
      Object.keys(first).every((item) => first[item] === second[item]);
  });
}

function viewFailed(kind, label) {
  const viewport = kind === 'factory' ? get('factory-view') : get('gantt-view');
  if (kind === 'factory') {
    factory?.destroy();
    factory = null;
  } else {
    gantt?.destroy();
    gantt = null;
  }
  viewport.replaceChildren(makeElement('p', `${label}暂时不可用，请检查浏览器设置后刷新。`, 'view-fallback'));
}

function updateView(kind, view, callback) {
  if (!view) return;
  try {
    callback(view);
  } catch {
    viewFailed(kind, kind === 'factory' ? '3D 车间' : '甘特图');
  }
}

function showDraftStatus() {
  const hasInvalid = [...document.querySelectorAll('[data-setting], [data-time-key]')]
    .some((input) => !input.validity.valid);
  get('parameter-status').hidden = !hasInvalid && (!activePlan || sameSettings(draft, activePlan.settings));
}

function setSettingsOpen(open) {
  get('scenario-settings').hidden = !open;
  get('settings-toggle').setAttribute('aria-expanded', open ? 'true' : 'false');
}

function status(message, state = '') {
  const label = get('run-status');
  label.textContent = message;
  label.dataset.state = state;
}

function errorMessage(message) {
  const panel = get('error-panel');
  panel.textContent = message;
  panel.hidden = !message;
}

function formatTime(seconds, rounded = false) {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  const whole = Math.max(0, rounded ? Math.round(seconds) : Math.floor(seconds));
  return [Math.floor(whole / 3600), Math.floor(whole / 60) % 60, whole % 60]
    .map((value) => String(value).padStart(2, '0')).join(':');
}

function makeElement(tag, value, className) {
  const element = document.createElement(tag);
  if (value != null) element.textContent = value;
  if (className) element.className = className;
  return element;
}

function frameAt(plan, seconds) {
  const frames = plan.frames;
  let first = 0;
  let last = frames.length;
  while (first < last) {
    const mid = (first + last) >>> 1;
    if (frames[mid].time <= seconds) first = mid + 1;
    else last = mid;
  }
  return frames[Math.max(0, first - 1)] ?? { islands: {}, completed: 0 };
}

function renderTime() {
  if (!activePlan) return;
  const now = playback.time;
  const frame = frameAt(activePlan, now);
  get('clock-slider').value = now;
  get('clock-slider').setAttribute('aria-valuetext', formatTime(now));
  get('time-label').value = formatTime(now);
  get('metric-complete').textContent = `${frame.completed ?? 0} / ${activePlan.settings.orders}`;
  const moving = activePlan.trips.filter((trip) => trip.start <= now && now < trip.end).length;
  get('metric-vehicles').textContent = `${moving} / ${activePlan.vehicles.length}`;
  if (activeFrame !== frame) renderBuffers(frame);
  activeFrame = frame;
  updateView('factory', factory, (view) => view.update(now, frame));
  updateView('gantt', gantt, (view) => view.update(now, frame));
}

function seek(seconds) {
  if (!activePlan || !Number.isFinite(seconds)) return;
  playback.time = Math.max(0, Math.min(seconds, activePlan.duration));
  renderTime();
}

function updatePlayButton() {
  get('play-icon').textContent = playback.playing ? 'Ⅱ' : '▶';
  get('play-label').textContent = playback.playing ? '暂停' : '播放';
  get('play-button').setAttribute('aria-label', playback.playing ? '暂停回放' : '播放回放');
}

function pause() {
  playback.playing = false;
  cancelAnimationFrame(playback.request);
  playback.request = 0;
  playback.lastWallTime = 0;
  updatePlayButton();
}

function tick(wallTime) {
  if (!playback.playing) return;
  const elapsed = playback.lastWallTime ? Math.min(0.1, (wallTime - playback.lastWallTime) / 1000) : 0;
  playback.lastWallTime = wallTime;
  seek(playback.time + elapsed * Number(get('play-speed').value));
  if (playback.time >= activePlan.duration) pause();
  else playback.request = requestAnimationFrame(tick);
}

function togglePlayback() {
  if (!activePlan) return;
  if (playback.playing) {
    pause();
    return;
  }
  if (playback.time >= activePlan.duration) seek(0);
  playback.playing = true;
  updatePlayButton();
  playback.request = requestAnimationFrame(tick);
}

function renderBuffers(frame) {
  const fragment = document.createDocumentFragment();
  for (const [island, values] of Object.entries(frame.islands)) {
    const { used = 0, reserved = 0, capacity = activePlan.layout.nodes[island]?.buffer ?? 0 } = values;
    const total = used + reserved;
    const row = makeElement('div', null, 'buffer-row');
    const bar = makeElement('div', null, 'buffer-bar');
    bar.setAttribute('aria-hidden', 'true');
    for (const [type, amount] of [['used', used], ['reserved', reserved]]) {
      const fill = makeElement('span', null, `buffer-${type}`);
      fill.style.width = `${capacity ? 100 * amount / capacity : 0}%`;
      bar.append(fill);
    }
    row.title = `实占 ${used} 格 · 预留 ${reserved} 格`;
    row.append(makeElement('span', island, 'buffer-name'), bar,
      makeElement('span', `${total} / ${capacity} 格`, 'buffer-value'));
    fragment.append(row);
  }
  get('buffer-list').replaceChildren(fragment);
}

function routeInput(key, duration, type, ariaLabel) {
  const input = makeElement('input', null, 'route-time');
  input.type = 'number';
  input.min = '1';
  input.max = type === 'printTimes' ? '1440' : '86400';
  input.step = '1';
  input.required = true;
  input.dataset.timeKey = key;
  input.dataset.timeType = type;
  input.dataset.original = duration;
  input.setAttribute('aria-label', ariaLabel);
  input.value = draft[type][key] ?? duration;
  return input;
}

function routeCard(name, place, input, unit) {
  const card = makeElement('label', null, 'route-card');
  card.style.setProperty('--island-color', islandColors[place] || islandColors.S01);
  const text = makeElement('b', name);
  if (place) text.append(makeElement('span', place));
  card.append(text, input, makeElement('span', unit, 'route-unit'));
  return card;
}

function routeBranch(name, segments) {
  const branch = makeElement('section', null, 'route-branch');
  const row = makeElement('div', null, 'route-sequence');
  segments.forEach((segment, index) => {
    if (index) {
      const arrow = makeElement('span', '→', 'route-arrow');
      arrow.setAttribute('aria-hidden', 'true');
      row.append(arrow);
    }
    row.append(segment);
  });
  branch.append(makeElement('h3', name), row);
  return branch;
}

function renderRoutes() {
  const holder = get('route-list');
  const branches = ['A', 'B', 'C', 'P'].map((kind) => {
    const visits = routeCatalog?.[kind] ?? [];
    return routeBranch(`${kind} 段`, visits.map((visit, index) => {
      const key = visit.label ?? `${kind}${String(index + 1).padStart(2, '0')}`;
      return routeCard(key, visit.island, routeInput(key, visit.duration, 'routeTimes', `${key} 加工秒数`), '秒');
    }));
  }).filter((branch) => branch.lastElementChild.children.length);
  if (!branches.length) {
    holder.replaceChildren(makeElement('p', '载入排程后可以编辑工艺路线。', 'muted'));
    return;
  }
  const batchSizes = printTimeDefaults.map((duration, index) => {
    const size = index + 1;
    return routeCard(`${size} 单`, '', routeInput(String(size), duration, 'printTimes', `S01 ${size} 单批加工分钟数`), '分钟');
  });
  const batchRow = routeBranch('S01 批量', batchSizes);
  batchRow.classList.add('batch-sizes');
  batchRow.querySelectorAll('.route-arrow').forEach((arrow) => arrow.remove());
  holder.replaceChildren(batchRow, ...branches);
  get('route-run-button').disabled = get('run-button').disabled;
}

function renderValidation(plan) {
  const { stats } = plan;
  const complete = stats.validation === true && stats.completed === plan.settings.orders;
  const pairs = [
    ['订单全部完工', `${stats.completed ?? 0} / ${plan.settings.orders}`],
    ['计划资源校验', complete ? '通过' : '计划未通过'],
    ...(stats.policy ? [['采用的排程方案', stats.policy]] : []),
    ['空驶总时长', formatTime(stats.emptySeconds, true)],
    ['载货行驶总时长', formatTime(stats.loadedSeconds, true)],
    ['等待合批的车次', String(stats.waitedTrips ?? 0)],
    ['路径潜在争用', String(stats.trafficConflicts ?? 0)],
  ];
  const rows = pairs.map(([label, value]) => {
    const pair = makeElement('div');
    pair.append(makeElement('dt', label), makeElement('dd', value));
    return pair;
  });
  get('validation-list').replaceChildren(...rows);
  get('traffic-note').textContent = '固定路径重叠仅用于识别后续需要核对的路段和装卸口。';
  const conflicts = plan.trafficConflicts ?? [];
  get('traffic-details').hidden = !conflicts.length;
  get('traffic-list').replaceChildren(...conflicts.map((conflict) => {
    const row = makeElement('li');
    const jump = makeElement('button', formatTime(conflict.time));
    jump.type = 'button';
    jump.setAttribute('aria-label', `跳到争用时刻 ${formatTime(conflict.time)}`);
    jump.addEventListener('click', () => {
      pause();
      seek(conflict.time);
      get('workspace').scrollIntoView({ block: 'start' });
    });
    row.append(jump, ` ${conflict.kind} · ${conflict.trips.join(' / ')}`);
    return row;
  }));
  const blocked = plan.blocked?.length ? plan.blocked : ['尚未生成能完成所有订单的可行计划。'];
  get('blocking-panel').hidden = complete;
  get('blocking-list').replaceChildren(...blocked.map((message) => makeElement('li', message)));
  get('metric-flow').textContent = complete ? formatTime(stats.averageFlow, true) : '—';
  get('metric-trips').textContent = `${stats.trips ?? plan.trips.length} 趟`;
  return complete;
}

function renderOrders(plan) {
  const rows = plan.orders.map((order) => {
    const row = makeElement('tr');
    row.append(makeElement('td', order.id), makeElement('td', formatTime(order.arrival)),
      makeElement('td', order.completed == null ? '未完成' : formatTime(order.completed)),
      makeElement('td', formatTime(order.flow)));
    return row;
  });
  get('order-rows').replaceChildren(...rows);
  get('export-button').disabled = !rows.length;
}

function loadPlan(plan, source) {
  pause();
  activePlan = plan;
  activeFrame = null;
  if (!routeCatalog && plan.routes) {
    routeCatalog = plan.routes;
    renderRoutes();
  }
  const complete = renderValidation(plan);
  const duration = plan.duration;
  renderOrders(plan);
  updateView('factory', factory, (view) => view.load(plan));
  updateView('gantt', gantt, (view) => view.load(plan));
  get('duration-label').textContent = `/ ${formatTime(duration, true)}`;
  get('clock-slider').max = String(duration || 1);
  get('play-button').disabled = !duration;
  get('reset-button').disabled = !duration;
  get('first-trip').disabled = !plan.trips.length;
  get('clock-slider').disabled = !duration;
  seek(0);
  status(`${source} · ${plan.stats.completed ?? 0}/${plan.settings.orders} 单完成${complete ? ' · 可执行' : ' · 未排空'}`, complete ? 'success' : 'warning');
  showDraftStatus();
}

function exportOrders() {
  if (!activePlan) return;
  const escape = (value) => value == null ? '' : `"${String(value).replaceAll('"', '""')}"`;
  const lines = ['订单,到达秒数,完工秒数,流动秒数', ...activePlan.orders.map(({ id, arrival, completed, flow }) => (
    [id, arrival, completed, flow].map(escape).join(',')
  ))];
  const url = URL.createObjectURL(new Blob(['\uFEFF', lines.join('\r\n')], { type: 'text/csv;charset=utf-8' }));
  const link = makeElement('a');
  link.href = url;
  link.download = 'order-flow-times.csv';
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function finishRun(message, plan) {
  get('run-button').disabled = false;
  get('route-run-button').disabled = !routeCatalog;
  get('run-button').textContent = '运行联合排程';
  if (plan) {
    loadPlan(plan, '本轮计划');
  } else {
    errorMessage(message);
    status(activePlan ? '计算失败 · 当前继续显示上次回放' : '计算失败', 'warning');
  }
}

function getWorker() {
  if (worker) return worker;
  worker = new Worker(new URL('./planner-worker.js', import.meta.url), { type: 'module' });
  worker.onmessage = ({ data }) => {
    if (data.id !== runId) return;
    if (typeof data.progress === 'string') status(data.progress);
    else finishRun(data.error, data.plan);
  };
  worker.onerror = () => {
    worker.terminate();
    worker = null;
    finishRun('计算环境加载失败。请检查网络后重试。');
  };
  return worker;
}

function requestRun(event) {
  event.preventDefault();
  const invalidTime = routePanel.querySelector('[data-time-key]:invalid');
  if (invalidTime) {
    routePanel.open = true;
    invalidTime.reportValidity();
    return;
  }
  errorMessage('');
  pause();
  setSettingsOpen(false);
  get('workspace').scrollIntoView({ block: 'start' });
  get('run-button').disabled = true;
  get('route-run-button').disabled = true;
  get('run-button').textContent = '正在计算…';
  status('正在准备计算环境…');
  try {
    getWorker().postMessage({ id: ++runId, settings: draft });
  } catch (error) {
    finishRun(`启动计算失败。${error.message}`);
  }
}

async function mountView(kind, selectModule, label) {
  try {
    const view = await selectModule();
    if (kind === 'factory') factory = view;
    else gantt = view;
    if (activePlan) {
      view.load(activePlan);
      view.update(playback.time, frameAt(activePlan, playback.time));
    }
  } catch {
    viewFailed(kind, label);
  }
}

fillSettings();
renderRoutes();
get('settings-toggle').addEventListener('click', () => setSettingsOpen(get('scenario-settings').hidden));
get('defaults-button').addEventListener('click', () => {
  draft = { ...defaultSettings };
  fillSettings();
  renderRoutes();
  persistDraft();
  showDraftStatus();
});
form.addEventListener('input', (event) => {
  const input = event.target;
  if (input.dataset.setting && input.validity.valid) {
    draft[input.dataset.setting] = input.type === 'checkbox' ? input.checked : input.valueAsNumber;
    persistDraft();
  }
  showDraftStatus();
});
routePanel.addEventListener('input', (event) => {
  const input = event.target;
  if (input.dataset.timeKey && input.validity.valid) {
    const { timeKey: key, timeType: type, original } = input.dataset;
    const values = { ...draft[type] };
    if (input.valueAsNumber === Number(original)) delete values[key];
    else values[key] = input.valueAsNumber;
    draft[type] = values;
    persistDraft();
  }
  showDraftStatus();
});
document.querySelector('a[href="#routes"]').addEventListener('click', () => { routePanel.open = true; });
if (location.hash === '#routes') routePanel.open = true;
form.addEventListener('submit', requestRun);
get('route-run-button').addEventListener('click', () => {
  if (!form.checkValidity()) setSettingsOpen(true);
  form.requestSubmit();
});
get('play-button').addEventListener('click', togglePlayback);
get('reset-button').addEventListener('click', () => { pause(); seek(0); });
get('first-trip').addEventListener('click', () => { pause(); seek(activePlan.trips[0].start); });
get('clock-slider').addEventListener('input', (event) => { pause(); seek(event.target.valueAsNumber); });
get('export-button').addEventListener('click', exportOrders);

const factoryContainer = get('factory-view');
const ganttContainer = get('gantt-view');
void mountView('factory', async () => (await import('./factory-view.js')).createFactoryView(factoryContainer), '3D 车间');
void mountView('gantt', async () => (await import('./gantt.js')).createGantt(ganttContainer, (seconds) => {
  pause();
  seek(seconds);
}), '甘特图');

fetch(new URL('./default-plan.json', import.meta.url)).then((response) => {
  if (!response.ok) throw new Error('示例排程读取失败');
  return response.json();
}).then((plan) => {
  if (!activePlan && !runId) loadPlan(plan, '首轮示例');
  else if (!routeCatalog && plan.routes) { routeCatalog = plan.routes; renderRoutes(); }
}).catch(() => {
  if (!activePlan && !runId) status('示例排程未能加载。可打开参数生成一轮计划。', 'warning');
});
