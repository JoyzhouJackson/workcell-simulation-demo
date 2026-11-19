import * as THREE from "./vendor/three.module.min.js";

const PALETTE = {
  S01: 0x607de8, S02: 0x17918c, S03: 0xd37843, S04: 0x7471ac,
  S05: 0xc39536, S06: 0x2e8cc0, S07: 0x5e8a62,
};
const PALE_PARTS = { A: 0xa9d6ff, B: 0xddb0ff, C: 0xf5d288, P: 0xc4faad, M: 0xc4faad };
const BUTTONS = [
  ["↺", "复位视角", "reset"], ["⊥", "切换俯视", "top"],
  ["−", "缩小", "out"], ["+", "放大", "in"],
];

function colorCode(id) {
  return PALETTE[id.slice(0, 3)] ?? 0x718a9b;
}

function cssColor(hex) {
  return "#" + hex.toString(16).padStart(6, "0");
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function upperBound(items, time) {
  let left = 0;
  let right = items.length;
  while (left < right) {
    const mid = (left + right) >>> 1;
    if (items[mid].start <= time) left = mid + 1;
    else right = mid;
  }
  return left;
}

function pointOf(value) {
  return Array.isArray(value) ? [+value[0], +value[1]] : [+value.x, +value.y];
}

function pathBetween(path, from, to) {
  const points = path?.length ? path.map(pointOf) : [from, to];
  const lengths = [0];
  for (let i = 1; i < points.length; i++) {
    lengths.push(lengths[i - 1] + Math.hypot(
      points[i][0] - points[i - 1][0], points[i][1] - points[i - 1][1],
    ));
  }
  return { points, lengths, total: lengths.at(-1) };
}

function pointOnPath(path, progress) {
  const distance = clamp(progress, 0, 1) * path.total;
  let i = 1;
  while (i < path.lengths.length && (path.lengths[i] < distance ||
      path.lengths[i] === path.lengths[i - 1])) i++;
  if (i === path.lengths.length) return [...path.points.at(-1), null];
  const [x0, z0] = path.points[i - 1];
  const [x1, z1] = path.points[i];
  const fraction = (distance - path.lengths[i - 1]) / (path.lengths[i] - path.lengths[i - 1]);
  return [x0 + (x1 - x0) * fraction, z0 + (z1 - z0) * fraction, Math.atan2(x1 - x0, z1 - z0)];
}

function pathProgress(time, start, end) {
  return end > start ? (time - start) / (end - start) : 1;
}

function newLabel(overlay, id) {
  const label = document.createElement("div");
  label.className = "factory-label";
  label.style.setProperty("--factory-color", cssColor(colorCode(id)));
  const title = document.createElement("b");
  title.textContent = id === "PARK" ? "AGV 停车区" : id;
  const status = document.createElement("span");
  label.append(title, status);
  overlay.append(label);
  return { label, status, point: new THREE.Vector3() };
}

export function createFactoryView(container) {
  container.classList.add("joint-factory");
  const stage = document.createElement("div");
  stage.className = "factory-stage";
  const overlay = document.createElement("div");
  overlay.className = "factory-overlay";
  overlay.setAttribute("aria-hidden", "true");
  const toolbar = document.createElement("div");
  toolbar.className = "factory-tools";
  toolbar.setAttribute("aria-label", "车间视角");
  const legend = document.createElement("div");
  legend.className = "factory-legend";
  legend.innerHTML = '<span><i class="factory-loaded"></i>载货</span>' +
    '<span><i class="factory-moving"></i>空驶</span>' +
    '<span><i class="factory-busy"></i>加工中</span>' +
    '<span><i class="factory-reserved"></i>库位预留</span>';
  stage.append(overlay, toolbar, legend);
  container.replaceChildren(stage);
  let renderer;
  try {
    renderer = new THREE.WebGLRenderer({ antialias: true, alpha: false, powerPreference: "high-performance" });
  } catch {
    const unavailable = document.createElement("p");
    unavailable.className = "factory-unavailable";
    unavailable.textContent = "此浏览器的 WebGL 不可用。仍可用甘特图和状态面板查看排程。";
    stage.replaceChildren(unavailable);
    return { load() {}, update() {}, destroy() { stage.remove(); } };
  }
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.7));
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1.10;
  const canvas = renderer.domElement;
  canvas.tabIndex = 0;
  canvas.setAttribute("aria-label", "三维车间，拖动或按方向键旋转，使用加减键或按钮缩放");
  stage.prepend(canvas);

  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0xe2eaf0);
  const camera = new THREE.OrthographicCamera(-10, 10, 10, -10, 0.1, 600);
  scene.add(new THREE.HemisphereLight(0xf3fbff, 0x627180, 2.15));
  const keyLight = new THREE.DirectionalLight(0xfff0d7, 2.45);
  keyLight.position.set(-60, 85, 32);
  scene.add(keyLight);
  const fillLight = new THREE.DirectionalLight(0xb4d6ff, 1.10);
  fillLight.position.set(36, 18, -40);
  scene.add(fillLight);
  const target = new THREE.Vector3();
  const projected = new THREE.Vector3();
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const cube = new THREE.BoxGeometry();
  const cylinder = new THREE.CylinderGeometry(1, 1, 1, 12);
  const materialCache = new Map();
  let factory = null;
  let nodes = {};
  let cells = new Map();
  let vehicles = new Map();
  let park;
  let width = 1;
  let height = 1;
  let extentX = 20;
  let extentZ = 12;
  let theta = 0.30;
  let elevation = 0.77;
  let zoom = 1;
  let renderRequest = 0;
  let pointer = null;
  let latestTime = 0;
  let latestFrame = {};

  function material(hex) {
    if (!materialCache.has(hex)) {
      materialCache.set(hex, new THREE.MeshStandardMaterial({ color: hex, roughness: 0.75, metalness: 0.12 }));
    }
    return materialCache.get(hex);
  }

  function blocks(parent, specs) {
    for (const spec of specs) box(parent, ...spec);
  }

  function box(parent, w, h, d, x, y, z, hex) {
    const mesh = new THREE.Mesh(cube, material(hex));
    mesh.scale.set(w, h, d);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function tube(parent, radius, heightValue, x, y, z, hex) {
    const mesh = new THREE.Mesh(cylinder, material(hex));
    mesh.scale.set(radius, heightValue, radius);
    mesh.position.set(x, y, z);
    parent.add(mesh);
    return mesh;
  }

  function strip(parent, a, b, band, level, hex) {
    const [ax, az] = a;
    const [bx, bz] = b;
    const length = Math.hypot(bx - ax, bz - az);
    if (!length) return;
    const mesh = box(parent, band, 0.018, length, (ax + bx) / 2, level, (az + bz) / 2, hex);
    mesh.rotation.y = Math.atan2(bx - ax, bz - az);
  }

  function drawRoad(a, b) {
    strip(factory, a, b, 2.6, 0.038, 0x465967);
    const [dx, dz] = [b[0] - a[0], b[1] - a[1]];
    const distance = Math.hypot(dx, dz);
    if (!distance) return;
    const normal = [-dz / distance, dx / distance];
    for (const side of [-1.17, 1.17]) {
      const offset = ([x, z]) => [x + side * normal[0], z + side * normal[1]];
      strip(factory, offset(a), offset(b), 0.055, 0.053, 0xc9ac72);
    }
    for (let i = 0.7; i < distance - 0.4; i += 2.0) {
      const along = length => [a[0] + dx * length / distance, a[1] + dz * length / distance];
      strip(factory, along(i), along(Math.min(i + 0.85, distance)), 0.06, 0.056, 0xcdd6dc);
    }
  }

  function activeAccent(group, color) {
    const light = box(group, 0.19, 0.25, 0.19, 0.87, 2.13, 0.46, 0x597488);
    light.material = new THREE.MeshStandardMaterial({
      color: 0x597488, emissive: 0x25e29f, emissiveIntensity: 0, roughness: 0.38,
    });
    box(group, 0.22, 0.09, 0.22, 0.87, 1.96, 0.46, color);
    return light;
  }

  function drawMachine(base, type, color, x, z, scale) {
    const group = new THREE.Group();
    group.position.set(x, 0.08, z);
    group.scale.setScalar(scale);
    base.add(group);
    const cream = 0xe3ebf0;
    const graph = 0x273a4b;
    const steel = 0x6c8292;
    let motion;
    box(group, 2.12, 0.14, 1.53, 0, 0.07, 0, graph);
    if (type === "S01" || type === "S03") {
      blocks(group, [
        [2.08, 1.83, 1.45, 0, 1.05, 0, color],
        [2.13, 0.31, 1.50, 0, 1.94, 0, cream],
        [1.5, 1.13, 0.06, -0.15, 1.20, 0.74, graph],
        [0.22, 0.31, 0.07, 0.77, 1.41, 0.765, 0x7bbfdf],
        [1.32, 0.08, 0.08, -0.15, 0.78, 0.795, steel],
        [1.42, 0.065, 0.08, -0.15, 1.60, 0.797, 0xa4c1d4],
        [1.85, 0.12, 0.08, 0, 0.47, 0.765, cream],
      ]);
      motion = box(group, 0.23, 0.22, 0.12, 0, 1.28, 0.815, type === "S03" ? 0xf7ad58 : 0x87c5ff);
    } else if (type === "S02" || type === "S06") {
      blocks(group, [
        [2.06, 0.78, 1.44, 0, 0.50, 0, cream],
        [2.13, 0.16, 1.49, 0, 0.94, 0, steel],
        [1.62, 0.06, 0.9, 0, 1.05, 0.08, graph],
        [0.22, 1.43, 0.19, -0.99, 1.64, -0.56, cream],
        [0.22, 1.43, 0.19, 0.99, 1.64, -0.56, cream],
        [2.1, 0.15, 0.17, 0, 2.30, -0.56, color],
        [0.22, 0.25, 0.07, 0.77, 0.76, 0.76, 0x98dbe1],
      ]);
      if (type === "S02") {
        const swivel = new THREE.Group();
        swivel.position.set(-0.49, 1.08, -0.12);
        group.add(swivel);
        tube(swivel, 0.25, 0.18, 0, 0.09, 0, graph);
        const boom = box(swivel, 0.23, 0.93, 0.22, 0.12, 0.54, 0, 0xf3b757);
        boom.rotation.z = -0.32;
        const arm = box(swivel, 0.80, 0.18, 0.2, 0.54, 0.91, 0, 0xe9a746);
        arm.rotation.z = -0.22;
        box(swivel, 0.14, 0.28, 0.20, 0.89, 0.72, 0, graph);
        motion = swivel;
      } else {
        const press = new THREE.Group();
        press.position.set(0, 2.14, -0.39);
        group.add(press);
        box(press, 0.35, 0.32, 0.32, 0, -0.12, 0.03, color);
        box(press, 0.11, 0.52, 0.1, 0, -0.38, 0.03, graph);
        motion = press;
      }
    } else if (type === "S04") {
      blocks(group, [
        [2.05, 0.05, 1.47, 0, 0.53, 0, steel],
        [2.05, 0.05, 1.47, 0, 1.22, 0, steel],
        [2.05, 0.05, 1.47, 0, 1.91, 0, steel],
      ]);
      for (const dx of [-0.99, 0.99]) {
        for (const dz of [-0.70, 0.70]) box(group, 0.11, 2.0, 0.11, dx, 1.02, dz, color);
      }
      for (let i = 0; i < 6; i++) {
        box(group, 0.69, 0.17, 0.93, (i % 2 - 0.5) * 0.82, 0.65 + Math.floor(i / 2) * 0.69, 0, cream);
      }
    } else {
      blocks(group, [
        [2.04, 0.82, 1.40, 0, 0.52, 0, cream],
        [2.13, 0.14, 1.47, 0, 1.0, 0, color],
        [1.28, 0.06, 0.75, -0.16, 1.10, 0.13, graph],
        [0.55, 0.42, 0.10, 0.53, 1.52, -0.41, graph],
        [0.46, 0.30, 0.015, 0.53, 1.52, -0.35, 0xa8cde4],
        [0.10, 0.37, 0.11, 0.53, 1.23, -0.41, steel],
        [0.84, 0.052, 0.05, -0.42, 0.79, 0.71, steel],
        [0.84, 0.052, 0.05, -0.42, 0.57, 0.71, steel],
      ]);
      motion = box(group, 0.42, 0.16, 0.31, -0.3, 1.20, 0.25, type === "S05" ? 0xf8c071 : 0xdce8b9);
    }
    return { motion, light: activeAccent(group, color), originalY: motion?.position.y };
  }

  function buildCell(id, node) {
    const [x, dockZ] = pointOf(node);
    const side = Math.sign(dockZ) || 1;
    const z = dockZ + side * 3.6;
    const type = id.slice(0, 3);
    const color = colorCode(id);
    const root = new THREE.Group();
    root.position.set(x, 0, z);
    if (side > 0) root.rotation.y = Math.PI;
    factory.add(root);
    box(root, 9.48, 0.21, 6.02, 0, 0.11, 0, 0xebf1f5);
    box(root, 9.44, 0.06, 0.13, 0, 0.243, 2.92, color);
    box(root, 9.44, 0.06, 0.13, 0, 0.243, -2.92, color);
    for (const xOffset of [-4.4, 4.4]) {
      box(root, 0.19, 0.66, 0.19, xOffset, 0.54, 2.73, 0xfab349);
    }
    const dock = pointOf(node);
    box(factory, 1.83, 0.04, 0.82, dock[0], 0.063, dock[1], 0x748796);
    for (const stripe of [-0.72, 0.72]) {
      box(factory, 0.075, 0.021, 0.78, dock[0] + stripe, 0.098, dock[1], 0xfbd678);
    }
    const count = type === "S01" ? clamp(Number(node.workstations) || 1, 1, 12) : 1;
    const columns = count > 2 ? 3 : count;
    const rows = Math.ceil(count / columns);
    const widthValue = count > 2 ? Math.min(0.91, 2.36 / rows) : 1.53;
    const machines = [];
    for (let index = 0; index < count; index++) {
      const slotX = count > 2 ? -3.26 + (index % columns) * 1.83 :
        (count === 1 ? -1.76 : -2.88 + index * 3.30);
      const slotZ = count > 2 ? (Math.floor(index / columns) - (rows - 1) / 2) * 1.13 : -0.32;
      machines.push({ ...drawMachine(root, type, color, slotX, slotZ, widthValue), operations: [] });
    }
    // The rack is a schematic inventory marker. The label shows the exact count.
    const rack = new THREE.Group();
    rack.position.set(2.96, 0.20, -0.40);
    rack.scale.set(1.27, 1.76, 1.35);
    root.add(rack);
    const rackX = 0;
    const binMeshes = [];
    for (const heightValue of [0.22, 0.62, 1.03]) {
      box(rack, 1.63, 0.085, 1.75, rackX, heightValue, -0.34, 0x526b7a);
    }
    for (const posX of [rackX - 0.79, rackX + 0.79]) {
      for (const posZ of [-1.18, 0.5]) box(rack, 0.09, 1.21, 0.09, posX, 0.64, posZ, color);
    }
    for (let index = 0; index < 12; index++) {
      const row = Math.floor(index / 4);
      const mesh = box(rack, 0.50, 0.25, 0.55, rackX - 0.43 + (index % 2) * 0.79,
        0.39 + row * 0.408, -0.78 + (Math.floor(index / 2) % 2) * 0.82, 0x83d9b1);
      mesh.visible = false;
      binMeshes.push(mesh);
    }
    const chip = newLabel(overlay, id);
    chip.point.set(x, side < 0 ? 4.65 : 0.42, z + side * 4.5);
    return {
      ...chip, machines, binMeshes, capacity: Number(node.buffer ?? node.capacity ?? 0), type,
    };
  }

  function buildVan(id, start) {
    const body = new THREE.Group();
    body.position.set(start[0], 0.10, start[1]);
    factory.add(body);
    const blue = 0x4196de;
    blocks(body, [
      [0.86, 0.23, 1.34, 0, 0.24, 0, 0x263847],
      [0.90, 0.14, 1.26, 0, 0.38, 0, blue],
      [0.78, 0.076, 0.97, 0, 0.49, -0.08, 0xe9f2f7],
      [0.83, 0.12, 0.095, 0, 0.28, 0.68, 0x273747],
      [0.83, 0.10, 0.09, 0, 0.27, -0.68, 0x273747],
      [0.12, 0.075, 0.03, -0.30, 0.36, 0.73, 0xc7f9ff],
      [0.12, 0.075, 0.03, 0.30, 0.36, 0.73, 0xc7f9ff],
    ]);
    for (const side of [-1, 1]) {
      for (const front of [-0.42, 0.42]) {
        const wheel = tube(body, 0.13, 0.14, side * 0.40, 0.15, front, 0x25313a);
        wheel.rotateZ(Math.PI / 2);
      }
    }
    const beacon = box(body, 0.16, 0.14, 0.12, 0.30, 0.55, 0.49, blue);
    const payload = Array.from({ length: 5 }, (_, index) =>
      box(body, 0.225, 0.17, 0.25, (index % 2 - 0.5) * 0.30, 0.61, 0.26 - Math.floor(index / 2) * 0.32, 0xf5d288));
    const label = document.createElement("div");
    label.className = "factory-vehicle-label";
    label.textContent = id.replace(/^AGV-/, "V");
    overlay.append(label);
    return { body, beacon, payload, label, point: new THREE.Vector3(), start };
  }

  function clearFactory() {
    if (factory) {
      factory.traverse(item => {
        if (item.geometry && item.geometry !== cube && item.geometry !== cylinder) item.geometry.dispose();
        if (item.material && item.material.emissive?.getHex() === 0x25e29f) item.material.dispose();
        if (item.type === "GridHelper") item.material.dispose();
      });
      scene.remove(factory);
    }
    overlay.replaceChildren();
    cells = new Map();
    vehicles = new Map();
    park = null;
  }

  function load(plan) {
    clearFactory();
    factory = new THREE.Group();
    scene.add(factory);
    nodes = plan.layout.nodes;
    const allPoints = Object.values(nodes).map(pointOf);
    if (!allPoints.length) {
      requestRender();
      return;
    }
    const minX = Math.min(...allPoints.map(point => point[0]));
    const maxX = Math.max(...allPoints.map(point => point[0]));
    const minZ = Math.min(...allPoints.map(point => point[1]));
    const maxZ = Math.max(...allPoints.map(point => point[1]));
    extentX = Math.max(12, maxX - minX + 17);
    extentZ = Math.max(15, maxZ - minZ + 16);
    target.set((minX + maxX) / 2 - 0.9, 0, (minZ + maxZ) / 2);
    box(factory, extentX, 0.64, extentZ, target.x, -0.33, target.z, 0xb7c9d4);
    box(factory, extentX - 0.25, 0.08, extentZ - 0.25, target.x, 0, target.z, 0xdce6ec);
    for (let x = -Math.floor(extentX / 4); x <= Math.floor(extentX / 4); x++) {
      box(factory, 0.023, 0.014, extentZ - 0.42, target.x + x * 2, 0.047, target.z, 0xcbd8df);
    }
    for (let z = -Math.floor(extentZ / 4); z <= Math.floor(extentZ / 4); z++) {
      box(factory, extentX - 0.42, 0.014, 0.023, target.x, 0.048, target.z + z * 2, 0xcbd8df);
    }
    const rearWall = target.z - extentZ / 2 + 0.15;
    const sideWall = target.x - extentX / 2 + 0.15;
    box(factory, extentX - 0.12, 2.7, 0.24, target.x, 1.37, rearWall, 0xa2b4c3);
    box(factory, extentX - 0.12, 0.14, 0.33, target.x, 2.75, rearWall, 0x6f879c);
    box(factory, extentX - 0.12, 0.25, 0.24, target.x, 0.23, rearWall + 0.17, 0x556c81);
    box(factory, 0.21, 1.15, extentZ - 0.12, sideWall, 0.61, target.z, 0x95acbd);
    box(factory, 0.31, 0.12, extentZ - 0.12, sideWall, 1.23, target.z, 0x688296);
    for (let x = sideWall + 4.8; x <= target.x + extentX / 2 - 3; x += 7.6) {
      box(factory, 3.7, 0.93, 0.11, x, 1.88, rearWall + 0.15, 0x7497b2);
      box(factory, 3.69, 0.08, 0.17, x, 1.41, rearWall + 0.23, 0xd7e4ec);
      box(factory, 0.12, 0.96, 0.15, x, 1.88, rearWall + 0.20, 0xd7e4ec);
      box(factory, 0.30, 2.73, 0.33, x + 3.5, 1.37, rearWall + 0.11, 0x71899d);
    }

    for (const [from, to] of plan.layout.edges || []) {
      if (nodes[from] && nodes[to]) drawRoad(pointOf(nodes[from]), pointOf(nodes[to]));
    }
    for (const [id, node] of Object.entries(nodes)) {
      if (/^S0[1-7](?:-|$)/.test(id)) cells.set(id, buildCell(id, node));
    }
    const [px, pz] = pointOf(nodes.PARK || { x: minX, y: 0 });
    park = newLabel(overlay, "PARK");
    park.point.set(px - 3.45, 2.25, pz - 3.95);
    const numberOfVehicles = plan.vehicles.length;
    const parked = Math.min(12, numberOfVehicles);
    const rows = Math.max(1, Math.ceil(parked / 2));
    const parkZ = pz - (rows - 1) * 0.55;
    box(factory, 3.2, 0.07, Math.max(4.25, rows * 1.13 + 0.35), px - 3.25, 0.07, pz, 0x81949d);
    const tripsByVehicle = new Map(plan.vehicles.map(id => [id, []]));
    for (const trip of plan.trips) {
      const source = pointOf(nodes[trip.source]);
      const destination = pointOf(nodes[trip.target]);
      const empty = pathBetween(trip.emptyPath, source, source);
      const loaded = pathBetween(trip.loadedPath, source, destination);
      tripsByVehicle.get(trip.vehicle)?.push({ ...trip, source, destination, empty, loaded });
    }
    plan.vehicles.forEach((id, index) => {
      const coordinate = [px - 4.0 + (index % 2) * 1.4, parkZ + Math.floor(index / 2) * 1.1];
      const van = buildVan(id, coordinate);
      van.visibleAtStart = index < parked;
      van.trips = tripsByVehicle.get(id).sort((a, b) => a.start - b.start);
      for (let j = 0; j < van.trips.length; j++) {
        const trip = van.trips[j];
        const from = j === 0 ? [px, pz] : van.trips[j - 1].destination;
        if (!trip.emptyPath?.length) trip.empty = pathBetween(null, from, trip.source);
      }
      vehicles.set(id, van);
      if (index < parked) box(factory, 1.19, 0.019, 1.06, coordinate[0], 0.12, coordinate[1], 0xbccbd1);
    });
    for (const operation of plan.operations) {
      const cell = cells.get(operation.island);
      if (!cell || operation.kind === "prep" || operation.kind === "post" || operation.kind === "rest") continue;
      const printer = cell.type === "S01" ? +(operation.resource || "").match(/\d+$/)?.[0] - 1 : 0;
      const machine = cell.machines[printer] || cell.machines[0];
      machine.operations.push(operation);
    }
    for (const cell of cells.values()) {
      for (const machine of cell.machines) machine.operations.sort((a, b) => a.start - b.start);
    }
    toolbar.querySelector("[data-factory-action=top]").setAttribute("aria-pressed", "false");
    theta = 0.30;
    elevation = 0.77;
    zoom = 1;
    update(0, {});
  }

  function setVehicle(van, time) {
    const i = upperBound(van.trips, time) - 1;
    const trip = van.trips[i];
    let pos;
    let loaded = 0;
    let state = "idle";
    if (!trip) {
      pos = [...van.start, 0];
      van.body.visible = van.visibleAtStart;
    } else {
      van.body.visible = true;
      if (time >= trip.end) {
        const side = Math.sign(trip.destination[1]) || 1;
        const suffix = Number(van.label.textContent.slice(1)) || 0;
        pos = [trip.destination[0] + 1.8 + (suffix % 2) * 0.95, trip.destination[1] + side * 0.18, 0];
      } else if (time < (trip.emptyArrival ?? trip.pickup)) {
        pos = pointOnPath(trip.empty, pathProgress(time, trip.start, trip.emptyArrival ?? trip.pickup));
        state = "moving";
      } else if (time < trip.pickup) {
        pos = [...trip.source, pointOnPath(trip.loaded, 0)[2]];
        state = "waiting";
      } else if (time < trip.loadEnd) {
        pos = [...trip.source, pointOnPath(trip.loaded, 0)[2]];
        loaded = Math.floor((trip.parts?.length ?? 0) * pathProgress(time, trip.pickup, trip.loadEnd));
        state = "moving";
      } else if (time < trip.arrival) {
        pos = pointOnPath(trip.loaded, pathProgress(time, trip.loadEnd, trip.arrival));
        loaded = trip.parts?.length ?? 0;
        state = "loaded";
      } else {
        pos = [...trip.destination, pointOnPath(trip.loaded, 1)[2]];
        const unloadStart = trip.unloadStart ?? trip.arrival;
        if (time < unloadStart) {
          loaded = trip.parts?.length ?? 0;
          state = "waiting";
        } else {
          loaded = Math.ceil((trip.parts?.length ?? 0) * (1 - pathProgress(time, unloadStart, trip.end)));
          state = "loaded";
        }
      }
    }
    van.body.position.set(pos[0], 0.10, pos[1]);
    if (pos[2] !== null) van.body.rotation.y = pos[2];
    van.beacon.material = material(state === "waiting" ? 0x9c88ca :
      state === "loaded" ? 0xf5a744 : state === "moving" ? 0x62d8fc : 0xa1b8c5);
    van.label.dataset.state = state;
    van.point.set(pos[0], 1.06, pos[1]);
    for (let index = 0; index < van.payload.length; index++) {
      van.payload[index].visible = index < loaded;
      if (index < loaded) {
        const part = trip.parts[index]?.part;
        van.payload[index].material = material(PALE_PARTS[part] || 0xf5d288);
      }
    }
    return state === "idle";
  }

  function setCell(cell, time, status) {
    const used = Number(status.used ?? 0);
    const reserved = Number(status.reserved ?? 0);
    const busy = Number(status.busy ?? 0);
    const cap = status.capacity ?? cell.capacity;
    const shownUsed = Math.min(cell.binMeshes.length, used);
    const shownReserved = Math.min(cell.binMeshes.length - shownUsed, reserved);
    for (let index = 0; index < cell.binMeshes.length; index++) {
      const bin = cell.binMeshes[index];
      bin.visible = index < shownUsed + shownReserved;
      bin.material = material(index < shownUsed ? 0x85d6a5 : 0xf5c167);
    }
    const active = cell.machines.map(machine => {
      const operation = machine.operations[upperBound(machine.operations, time) - 1];
      return operation?.end > time ? operation : null;
    });
    const setup = active.filter(operation => operation?.kind === "setup").length;
    const label = used + (reserved ? " +" + reserved : "") + "/" + cap + " 格" +
      (busy ? " · " + (cell.type === "S04" ? "静置 " : "进行中 ") + busy : "") +
      (setup ? " · 切换 " + setup : "");
    if (label !== cell.status.textContent) cell.status.textContent = label;
    cell.label.classList.toggle("factory-active", busy > 0 || setup > 0);
    cell.machines.forEach((machine, index) => {
      const operation = active[index];
      const occupied = operation || (cell.type === "S04" && busy);
      machine.light.material.emissiveIntensity = occupied ? 2.05 : 0;
      if (!machine.motion || reduceMotion.matches) return;
      const animationProgress = operation && operation.kind !== "setup" ?
        pathProgress(time, operation.start, operation.end) : 0;
      if (cell.type === "S02") machine.motion.rotation.y = -0.5 + Math.sin(animationProgress * Math.PI * 3) * 1.0;
      else if (cell.type === "S01" || cell.type === "S03") machine.motion.position.x = Math.sin(animationProgress * Math.PI * 7) * 0.65;
      else machine.motion.position.y = machine.originalY + Math.sin(animationProgress * Math.PI * 4) * 0.12;
    });
  }

  function update(time, frame = {}) {
    latestTime = time;
    latestFrame = frame;
    if (!factory) return;
    let parked = 0;
    for (const [id, cell] of cells) setCell(cell, time, frame.islands?.[id] || {});
    for (const van of vehicles.values()) {
      setVehicle(van, time);
      if (!van.trips.length || time < van.trips[0].start) parked++;
    }
    if (park) {
      const label = parked + " 辆待命";
      if (park.status.textContent !== label) park.status.textContent = label;
    }
    requestRender();
  }

  function resize() {
    const rect = stage.getBoundingClientRect();
    width = Math.max(1, Math.floor(rect.width));
    height = Math.max(1, Math.floor(rect.height));
    renderer.setSize(width, height, false);
    requestRender();
  }

  function projectLabel(label, point, visible = true) {
    projected.copy(point).project(camera);
    const screenX = (projected.x + 1) * width / 2;
    const screenY = (1 - projected.y) * height / 2;
    label.hidden = !visible || projected.z < -1 || projected.z > 1 ||
      screenX < 24 || screenX > width - 24 || screenY < 22 || screenY > height - 12;
    if (!label.hidden) label.style.transform = "translate3d(" + screenX + "px," + screenY + "px,0) translate(-50%,-50%)";
  }

  function render() {
    renderRequest = 0;
    const aspect = width / height;
    const sin = Math.abs(Math.sin(theta));
    const cos = Math.abs(Math.cos(theta));
    const spanW = extentX * cos + extentZ * sin + 2.1;
    const spanH = (extentX * sin + extentZ * cos) * Math.sin(elevation) + 5.3;
    const half = Math.max(spanW / aspect, spanH) * 0.54 / zoom;
    camera.left = -half * aspect;
    camera.right = half * aspect;
    camera.top = half;
    camera.bottom = -half;
    const radius = Math.max(extentX, extentZ) * 1.7;
    camera.position.copy(target).add(new THREE.Vector3(
      radius * Math.cos(elevation) * Math.sin(theta),
      radius * Math.sin(elevation),
      radius * Math.cos(elevation) * Math.cos(theta),
    ));
    camera.lookAt(target);
    camera.updateProjectionMatrix();
    renderer.render(scene, camera);
    if (park) projectLabel(park.label, park.point);
    for (const cell of cells.values()) projectLabel(cell.label, cell.point);
    for (const van of vehicles.values()) projectLabel(van.label, van.point, van.body.visible && van.label.dataset.state !== "idle");
  }

  function requestRender() {
    if (!renderRequest) renderRequest = requestAnimationFrame(render);
  }

  function cameraAction(action) {
    const top = toolbar.querySelector("[data-factory-action=top]");
    if (action === "top") {
      const showTop = top.getAttribute("aria-pressed") !== "true";
      elevation = showTop ? Math.PI / 2 - 0.01 : 0.77;
      theta = showTop ? 0 : 0.30;
      top.setAttribute("aria-pressed", String(showTop));
    } else if (action === "reset") {
      elevation = 0.77;
      theta = 0.30;
      zoom = 1;
      top.setAttribute("aria-pressed", "false");
    } else {
      zoom = clamp(zoom * (action === "in" ? 1.17 : 1 / 1.17), 0.7, 3.0);
    }
    requestRender();
  }

  for (const [symbol, label, action] of BUTTONS) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = symbol;
    button.title = label;
    button.setAttribute("aria-label", label);
    button.dataset.factoryAction = action;
    if (action === "top") button.setAttribute("aria-pressed", "false");
    button.addEventListener("click", () => cameraAction(action));
    toolbar.append(button);
  }
  canvas.addEventListener("pointerdown", event => {
    if (event.button !== 0) return;
    pointer = { id: event.pointerId, x: event.clientX, y: event.clientY };
    canvas.setPointerCapture(pointer.id);
    canvas.classList.add("factory-dragging");
  });
  canvas.addEventListener("pointermove", event => {
    if (!pointer || event.pointerId !== pointer.id) return;
    theta -= (event.clientX - pointer.x) * 0.009;
    elevation = clamp(elevation + (event.clientY - pointer.y) * 0.008, 0.28, 1.56);
    pointer.x = event.clientX;
    pointer.y = event.clientY;
    toolbar.querySelector("[data-factory-action=top]").setAttribute("aria-pressed", "false");
    requestRender();
  });
  for (const type of ["pointerup", "pointercancel", "lostpointercapture"]) {
    canvas.addEventListener(type, () => { pointer = null; canvas.classList.remove("factory-dragging"); });
  }
  canvas.addEventListener("wheel", event => {
    if (!event.ctrlKey && !event.metaKey && document.activeElement !== canvas) return;
    event.preventDefault();
    zoom = clamp(zoom * Math.exp(-event.deltaY * 0.007), 0.7, 3.0);
    requestRender();
  }, { passive: false });
  canvas.addEventListener("keydown", event => {
    if (event.key === "ArrowLeft") theta += 0.16;
    else if (event.key === "ArrowRight") theta -= 0.16;
    else if (event.key === "ArrowUp") elevation = clamp(elevation + 0.13, 0.28, 1.56);
    else if (event.key === "ArrowDown") elevation = clamp(elevation - 0.13, 0.28, 1.56);
    else if (event.key === "+") cameraAction("in");
    else if (event.key === "-") cameraAction("out");
    else if (event.key === "Home") cameraAction("reset");
    else return;
    event.preventDefault();
    requestRender();
  });
  const observer = new ResizeObserver(resize);
  observer.observe(stage);
  const onReducedMotion = () => update(latestTime, latestFrame);
  reduceMotion.addEventListener("change", onReducedMotion);
  resize();
  return {
    load, update,
    destroy() {
      observer.disconnect();
      reduceMotion.removeEventListener("change", onReducedMotion);
      cancelAnimationFrame(renderRequest);
      clearFactory();
      materialCache.forEach(value => value.dispose());
      cube.dispose();
      cylinder.dispose();
      renderer.dispose();
      stage.remove();
    },
  };
}
