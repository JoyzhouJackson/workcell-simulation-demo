const kinds = {
  prep: { name: '前处理', className: 'prep' },
  print: { name: '批处理', className: 'print' },
  post: { name: '后处理', className: 'post' },
  process: { name: '加工', className: 'process' },
  rest: { name: '静置', className: 'rest' },
  assembly: { name: '合装', className: 'assembly' },
  empty: { name: '空驶', className: 'empty' },
  wait: { name: '等装卸口', className: 'wait' },
  load: { name: '装货', className: 'load' },
  loaded: { name: '载货', className: 'loaded' },
  unload: { name: '卸货', className: 'unload' },
};

const numberOrder = new Intl.Collator('zh-CN', { numeric: true });

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function button(text, className, action) {
  const control = element('button', className, text);
  control.type = 'button';
  control.addEventListener('click', action);
  return control;
}

function clock(time, precise = true) {
  const seconds = Math.max(0, Math.floor(time));
  const fields = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60];
  if (precise) fields.push(seconds % 60);
  return fields.map((field) => String(field).padStart(2, '0')).join(':');
}

function taskPart(task) {
  return task.order == null ? '' : `订单 ${task.order}${task.part ? ` · ${task.part}` : ''}`;
}

function rangedTask(start, end, kind, label, detail) {
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return null;
  return { start, end, kind, label, detail };
}

function splitIntoLanes(tasks) {
  const lanes = [];
  for (const task of tasks.sort((a, b) => a.start - b.start || a.end - b.end)) {
    const available = lanes.find((lane) => lane.at(-1).end <= task.start);
    if (available) available.push(task);
    else lanes.push([task]);
  }
  return lanes.length ? lanes : [[]];
}

function ganttGroups(plan) {
  const byIsland = new Map();
  const groups = [];
  const nodes = plan.layout?.nodes || {};
  for (const op of plan.operations || []) {
    const kind = kinds[op.kind] ? op.kind : 'process';
    const label = op.label || taskPart(op) || kinds[kind].name;
    const task = rangedTask(op.start, op.end, kind, label, [op.island, taskPart(op)].filter(Boolean).join(' · '));
    if (!task) continue;
    if (!byIsland.has(op.island)) byIsland.set(op.island, new Map());
    const resources = byIsland.get(op.island);
    const resource = kind === 'rest' ? op.island : (op.resource || op.island);
    if (!resources.has(resource)) resources.set(resource, []);
    resources.get(resource).push(task);
  }

  const processing = [];
  const islandIds = new Set([...Object.keys(nodes).filter((id) => /^S\d/.test(id)), ...byIsland.keys()]);
  for (const islandId of Array.from(islandIds).sort(numberOrder.compare)) {
    const node = nodes[islandId];
    const resources = byIsland.get(islandId) || new Map([[islandId, []]]);
    const title = node?.label?.includes(islandId) ? node.label : islandId;
    for (const [resource, tasks] of resources) {
      const lanes = splitIntoLanes(tasks);
      const sub = String(resource).replace(new RegExp(`^${islandId}[- /]`, 'i'), '');
      for (let i = 0; i < lanes.length; i += 1) {
        const laneNumber = lanes.length > 1 ? ` · ${i + 1}` : '';
        const subtitle = resource !== islandId ? `${sub}${laneNumber}` :
          (lanes.length > 1 ? `${kinds[lanes[i][0].kind].name} ${i + 1}` : (node?.label && node.label !== title ? node.label : ''));
        processing.push({ id: title, subtitle, tasks: lanes[i] });
      }
    }
  }
  if (processing.length) groups.push({ id: 'work', label: '工艺岛与设备', rows: processing });

  const byVehicle = new Map((plan.vehicles || []).map((vehicle) => [vehicle, []]));
  for (const trip of plan.trips || []) {
    if (!byVehicle.has(trip.vehicle)) byVehicle.set(trip.vehicle, []);
    const route = `${trip.source} → ${trip.target}`;
    const cargo = (trip.parts || []).map(taskPart).filter(Boolean);
    const detail = [`车次 ${trip.id}`, route, ...cargo].join(' / ');
    const emptyArrival = trip.emptyArrival ?? trip.pickup;
    const unloadStart = trip.unloadStart ?? trip.arrival;
    const segments = [
      rangedTask(trip.start, emptyArrival, 'empty', `空驶至 ${trip.source}`, detail),
      rangedTask(emptyArrival, trip.pickup, 'wait', `${trip.source} 等待装货`, detail),
      rangedTask(trip.pickup, trip.loadEnd, 'load', `装货 ${cargo.length} 件`, detail),
      rangedTask(trip.loadEnd, trip.arrival, 'loaded', route, detail),
      rangedTask(trip.arrival, unloadStart, 'wait', `${trip.target} 等待卸货`, detail),
      rangedTask(unloadStart, trip.end, 'unload', `卸货 ${cargo.length} 件`, detail),
    ];
    byVehicle.get(trip.vehicle).push(...segments.filter(Boolean));
  }
  if (byVehicle.size) {
    const rows = [...byVehicle.entries()].sort(([a], [b]) => numberOrder.compare(a, b))
      .map(([id, tasks]) => ({ id, subtitle: '', tasks }));
    groups.push({ id: 'agv', label: '车辆任务', rows });
  }
  return groups;
}

function tickStep(duration, width) {
  const ideal = duration / Math.max(2, width / 105);
  const intervals = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 172800, 345600];
  return intervals.find((step) => step >= ideal) || Math.ceil(ideal / 86400) * 86400;
}

export function createGantt(container, onSeek) {
  const root = element('div', 'jg-root');
  const toolbar = element('div', 'jg-toolbar');
  const filters = element('div', 'jg-filters');
  const tools = element('div', 'jg-tools');
  const legend = element('ul', 'jg-legend');
  const scroll = element('div', 'jg-scroll');
  const chart = element('div', 'jg-chart');
  const tooltip = element('div', 'jg-tooltip');
  const detail = element('div', 'jg-detail', '点击任务可查看时间和订单。');
  const rowsSummary = element('span', 'jg-summary');
  const follow = element('input');
  const followLabel = element('label', 'jg-follow');
  const filterButtons = new Map();
  let model = null;
  let groups = [];
  let zoom = 1;
  let mode = 'all';
  let now = 0;
  let lastScrollLeft = 0;
  let programmedScroll = null;
  let timelineWidth = 0;
  let visiblePlotWidth = 0;
  let axis;
  let axisClock;
  let marker;
  let rowStates = [];
  let selected = null;

  const duration = () => Math.max(1, Number(model?.duration) || 0);
  const fraction = (time) => Math.max(0, Math.min(1, time / duration()));

  function hideTooltip() {
    tooltip.hidden = true;
  }

  function setScroll(left) {
    const maximum = Math.max(0, scroll.scrollWidth - scroll.clientWidth);
    programmedScroll = Math.max(0, Math.min(maximum, Math.round(left)));
    scroll.scrollLeft = programmedScroll;
    lastScrollLeft = scroll.scrollLeft;
  }

  function followTime(force = false) {
    if (!model || (!force && !follow.checked)) return;
    if (visiblePlotWidth <= 0) return;
    const position = fraction(now) * timelineWidth;
    if (force || position < lastScrollLeft || position > lastScrollLeft + (visiblePlotWidth * 0.82)) {
      const desired = Math.max(0, Math.min(timelineWidth - visiblePlotWidth, position - visiblePlotWidth * 0.32));
      if (Math.abs(desired - lastScrollLeft) > 1) setScroll(desired);
    }
  }

  function drawAxis() {
    if (!axis) return;
    const step = tickStep(duration(), timelineWidth);
    const fragment = document.createDocumentFragment();
    const add = (time, final = false) => {
      const tick = element('span', `jg-tick${time === 0 ? ' jg-zero' : ''}${final ? ' jg-end' : ''}`,
        clock(time, step < 60));
      tick.style.left = `${fraction(time) * 100}%`;
      fragment.append(tick);
    };
    add(0);
    for (let time = step; time < duration(); time += step) {
      if ((1 - fraction(time)) * timelineWidth >= 56) add(time);
    }
    add(duration(), true);
    axis.replaceChildren(fragment, axisClock);
    chart.style.setProperty('--jg-tick-width', `${step / duration() * timelineWidth}px`);
  }

  function applySize(force = false) {
    if (!model || !chart.firstElementChild) return;
    const labelWidth = chart.firstElementChild.getBoundingClientRect().width;
    visiblePlotWidth = scroll.clientWidth - labelWidth;
    const value = Math.max(288, visiblePlotWidth) * zoom;
    if (!force && value === timelineWidth) return;
    timelineWidth = value;
    chart.style.setProperty('--jg-plot-width', `${timelineWidth}px`);
    chart.style.setProperty('--jg-clock-offset', `${fraction(now) * timelineWidth}px`);
    drawAxis();
    followTime();
  }

  function showTask(event, task) {
    tooltip.replaceChildren(
      element('strong', '', `${kinds[task.kind].name} · ${task.label}`),
      element('time', '', `${clock(task.start)} → ${clock(task.end)}`),
      element('span', '', task.detail),
    );
    tooltip.hidden = false;
    const rect = root.getBoundingClientRect();
    const taskRect = event.currentTarget.getBoundingClientRect();
    const x = event.clientX || taskRect.left + taskRect.width * 0.5;
    const y = event.clientY || taskRect.top + taskRect.height;
    const left = Math.max(5, Math.min(rect.width - tooltip.offsetWidth - 5, x - rect.left + 12));
    const above = y + tooltip.offsetHeight + 18 > window.innerHeight;
    const top = above ? y - rect.top - tooltip.offsetHeight - 12 : y - rect.top + 13;
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function selectTask(bar, task) {
    selected?.removeAttribute('aria-current');
    selected = bar;
    selected.setAttribute('aria-current', 'true');
    detail.textContent = `${clock(task.start)} – ${clock(task.end)} · ${kinds[task.kind].name} · ${task.label}${task.detail ? ` · ${task.detail}` : ''}`;
    onSeek?.(task.start);
  }

  function addBar(row, task) {
    const bar = button(task.label, `jg-bar jg-${kinds[task.kind].className}`, (event) => {
      event.stopPropagation();
      selectTask(bar, task);
    });
    bar.style.left = `${fraction(task.start) * 100}%`;
    bar.style.width = `${(fraction(task.end) - fraction(task.start)) * 100}%`;
    bar.setAttribute('aria-label', [kinds[task.kind].name, task.label, task.detail, `${clock(task.start)} 至 ${clock(task.end)}`].filter(Boolean).join('，'));
    bar.addEventListener('pointerenter', (event) => showTask(event, task));
    bar.addEventListener('pointerleave', hideTooltip);
    bar.addEventListener('focus', (event) => showTask(event, task));
    bar.addEventListener('blur', hideTooltip);
    row.append(bar);
    return bar;
  }

  function activeBar(bars, time) {
    let start = 0;
    let end = bars.length;
    while (start < end) {
      const middle = (start + end) >>> 1;
      if (bars[middle].task.start <= time) start = middle + 1;
      else end = middle;
    }
    const candidate = bars[start - 1];
    return candidate && time < candidate.task.end ? candidate.bar : null;
  }

  function seekOnChart(event) {
    if (event.button !== 0 || !model || event.target.closest('button, .jg-label, .jg-corner')) return;
    const rect = axis.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right) return;
    onSeek?.(Math.min(model.duration, Math.max(0, (event.clientX - rect.left) / rect.width * duration())));
  }

  function drawChart() {
    hideTooltip();
    selected = null;
    rowStates = [];
    const corner = element('div', 'jg-corner', '资源');
    axis = element('div', 'jg-axis');
    axis.setAttribute('aria-hidden', 'true');
    axisClock = element('span', 'jg-axis-clock');
    marker = element('div', 'jg-playhead');
    marker.setAttribute('aria-hidden', 'true');
    const fragment = document.createDocumentFragment();
    fragment.append(corner, axis);

    let rowCount = 0;
    for (const group of groups.filter((item) => mode === 'all' || item.id === mode)) {
      const groupLabel = element('div', 'jg-label jg-group-label', group.label);
      fragment.append(groupLabel, element('div', 'jg-group-track'));
      for (const row of group.rows) {
        const label = element('div', 'jg-label jg-row-label');
        label.append(element('strong', '', row.id));
        if (row.subtitle) label.append(element('span', '', row.subtitle));
        label.title = `${row.id}${row.subtitle ? ` · ${row.subtitle}` : ''}`;
        const track = element('div', 'jg-row-track');
        const bars = row.tasks.slice().sort((a, b) => a.start - b.start)
          .map((task) => ({ task, bar: addBar(track, task) }));
        rowStates.push({ label, bars, active: null });
        fragment.append(label, track);
        rowCount += 1;
      }
    }

    if (!rowCount) {
      fragment.append(element('div', 'jg-label'), element('div', 'jg-no-data', '该视图暂无计划任务。'));
    }
    fragment.append(marker);
    chart.replaceChildren(fragment);
    rowsSummary.textContent = `${rowCount} 条资源轨道`;
    applySize(true);
    update(now);
  }

  function update(time) {
    const value = Number(time);
    now = Number.isFinite(value) ? Math.max(0, Math.min(model?.duration ?? 0, value)) : 0;
    if (!marker || !axisClock) return;
    chart.style.setProperty('--jg-clock-ratio', `${fraction(now) * 100}%`);
    chart.style.setProperty('--jg-clock-offset', `${fraction(now) * timelineWidth}px`);
    const stamp = clock(now);
    if (axisClock.textContent !== stamp) axisClock.textContent = stamp;
    axisClock.classList.toggle('jg-clock-end', fraction(now) > 0.9);
    for (const row of rowStates) {
      const active = activeBar(row.bars, now);
      if (row.active === active) continue;
      row.active?.classList.remove('jg-bar-live');
      active?.classList.add('jg-bar-live');
      row.label.classList.toggle('jg-label-live', Boolean(active));
      row.active = active;
    }
    followTime();
  }

  function setZoom(newZoom) {
    zoom = Math.max(1, Math.min(16, newZoom));
    resetZoom.textContent = zoom === 1 ? '适应宽度' : `${Number(zoom.toFixed(2))}×`;
    zoomOut.disabled = zoom === 1;
    zoomIn.disabled = zoom === 16;
    applySize(true);
    followTime(true);
  }

  function setFilter(filter) {
    mode = filter;
    filterButtons.forEach((control, id) => control.setAttribute('aria-pressed', String(id === filter)));
    detail.textContent = '点击任务可查看时间和订单。';
    if (model) drawChart();
  }

  for (const [id, label] of [['all', '全部'], ['work', '工艺岛'], ['agv', 'AGV']]) {
    const control = button(label, 'jg-btn jg-filter', () => setFilter(id));
    filterButtons.set(id, control);
    filters.append(control);
  }
  filters.setAttribute('role', 'group');
  filters.setAttribute('aria-label', '甘特图显示范围');
  const zoomOut = button('−', 'jg-btn jg-zoom', () => setZoom(zoom / 2));
  zoomOut.setAttribute('aria-label', '缩小时间轴');
  const resetZoom = button('适应宽度', 'jg-btn jg-fit', () => setZoom(1));
  resetZoom.title = '恢复到全时段';
  const zoomIn = button('+', 'jg-btn jg-zoom', () => setZoom(zoom * 2));
  zoomIn.setAttribute('aria-label', '放大时间轴');
  follow.type = 'checkbox';
  follow.checked = true;
  follow.addEventListener('change', () => { if (follow.checked) followTime(true); });
  followLabel.append(follow, document.createTextNode('跟随时间线'));
  tools.append(rowsSummary, zoomOut, resetZoom, zoomIn, followLabel);
  toolbar.append(filters, tools);

  for (const kind of Object.values(kinds)) {
    const item = element('li', 'jg-key');
    item.append(element('i', `jg-swatch jg-${kind.className}`), document.createTextNode(kind.name));
    legend.append(item);
  }

  scroll.tabIndex = 0;
  scroll.setAttribute('role', 'region');
  scroll.setAttribute('aria-label', '联排甘特图。左右方向键移动仿真时间，Shift 加大步长。');
  scroll.addEventListener('click', seekOnChart);
  scroll.addEventListener('keydown', (event) => {
    if (!model || event.target !== scroll || !['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
    event.preventDefault();
    if (event.key === 'Home' || event.key === 'End') onSeek?.(event.key === 'Home' ? 0 : model.duration);
    else onSeek?.(Math.max(0, Math.min(model.duration, now + (event.key === 'ArrowLeft' ? -1 : 1) * (event.shiftKey ? 60 : 5))));
  });
  scroll.addEventListener('scroll', () => {
    hideTooltip();
    const current = scroll.scrollLeft;
    if (Math.abs(current - lastScrollLeft) > 1 && (programmedScroll == null || Math.abs(current - programmedScroll) > 1)) {
      follow.checked = false;
    }
    lastScrollLeft = current;
    programmedScroll = null;
  }, { passive: true });
  scroll.append(chart);
  tooltip.hidden = true;
  tooltip.setAttribute('role', 'tooltip');
  detail.setAttribute('aria-live', 'polite');
  root.append(toolbar, legend, scroll, detail, tooltip);
  container.replaceChildren(root);
  const resize = new ResizeObserver(() => applySize());
  resize.observe(scroll);
  setFilter('all');
  setZoom(1);

  return {
    load(plan) {
      model = plan;
      groups = ganttGroups(plan);
      now = 0;
      detail.textContent = '点击任务可查看时间和订单。';
      drawChart();
      setScroll(0);
      scroll.scrollTop = 0;
    },
    update,
    destroy() {
      resize.disconnect();
      root.remove();
    },
  };
}
