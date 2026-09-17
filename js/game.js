/* HOLLOW WOODS — procedural, mobile-first survival horror. No external game assets. */
'use strict';
(() => {
  const elements = new Map();
  const $ = id => { if (!elements.has(id)) elements.set(id, document.getElementById(id)); return elements.get(id); };
  const setText = (id, value) => { const node = $(id), text = String(value); if (node.textContent !== text) node.textContent = text; };
  const touch = matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  document.body.classList.toggle('touch-device', touch);
  const STORE = 'hollow-woods-v1';
  const params = new URLSearchParams(location.search);
  const requestedSeed = Number(params.get('seed'));
  const fixedSeed = params.has('seed') && Number.isSafeInteger(requestedSeed) && requestedSeed >= 1 && requestedSeed <= 0xFFFFFF ? requestedSeed : null;
  const defaults = { audio: false, brightness: 1.2, sensitivity: 1, quality: touch ? 'low' : 'medium', adaptive: true, fps: 60, reduced: matchMedia('(prefers-reduced-motion: reduce)').matches };
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(STORE) || '{}'); } catch (_) { /* Storage can be unavailable in private mode. */ }
  function validatedSettings(value) {
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const clean = { ...defaults };
    for (const key of ['audio', 'reduced', 'adaptive']) if (typeof source[key] === 'boolean') clean[key] = source[key];
    for (const [key, min, max] of [['brightness', .7, 1.9], ['sensitivity', .4, 2]]) if (Number.isFinite(source[key])) clean[key] = Math.max(min, Math.min(max, source[key]));
    if (['low', 'medium', 'high'].includes(source.quality)) clean.quality = source.quality;
    if (source.fps === 30 || source.fps === 60) clean.fps = source.fps;
    return clean;
  }
  const settings = validatedSettings(saved);
  let difficulty = 'normal';
  const levels = {
    wander: { name: 'EXPLORATION', speed: .66, drain: 12, recovery: 22, grace: 25 },
    normal: { name: 'STANDARD', speed: 1, drain: 19, recovery: 16, grace: 18 },
    nightmare: { name: 'NIGHTMARE', speed: 1.27, drain: 24, recovery: 13, grace: 12 }
  };
  let testRunning = false;
  let state = 'menu', scene, camera, renderer, worldGroup, menuGroup, flashlight, lightTarget, exitGroup, atmosphere;
  let grid = [], walkable = [], pies = [], enemies = [], distanceField = [], visited, mazeSeed = 1;
  const SIZE = 29, TILE = 6, HALF = TILE / 2, WORLD = SIZE * TILE;
  const total = SIZE * SIZE;
  const navigation = new ForestEngine.GridNavigation(SIZE, TILE);
  let worldChunks = [], fieldCell = -1, visualTimer = 0, hudTimer = 0, mapDirty = true;
  const flowBuffer = new Int16Array(total);
  const mapCache = document.createElement('canvas'); mapCache.width = mapCache.height = 540;
  const stepper = new ForestEngine.FixedStepper();
  let renderDirty = true, lastRenderTime = 0, adaptiveScale = 1, frameSum = 0, frameSamples = 0, goodWindows = 0, measuredFPS = 0;
  let lastAudioLevel = -1, lastThreatOpacity = -1;
  const player = { x: TILE, z: -TILE, yaw: 0, pitch: 0, stamina: 100, moving: false, running: false, exhausted: false };
  const input = { keys: new Set(), moveX: 0, moveY: 0, run: false, stickSprint: false, lookId: null, stickId: null, runId: null, mouseDown: false };
  let elapsed = 0, collected = 0, lampOn = true, lastTime = 0, frameCount = 0, lastCell = -1;
  let toastRemaining = 0, threat = 0, nextFootstep = 0, nextHeartbeat = 0, mapOpen = false;
  let headBob = 0, capturedBy = '', catchTime = 0, exitIndex = 0, gpuReady = false;
  let best = {};
  try {
    const storedRecords = JSON.parse(localStorage.getItem('hollow-woods-records') || '{}');
    for (const level of Object.keys(levels)) if (Number.isFinite(storedRecords?.[level]) && storedRecords[level] > 0) best[level] = storedRecords[level];
  } catch (_) {}

  // Audio owns its short-lived nodes and stays suspended until a real user gesture.
  const audio = new ForestAudio(() => settings, () => !testRunning);

  function saveSettings() { try { localStorage.setItem(STORE, JSON.stringify(settings)); } catch (_) {} }
  function resizeRenderer() {
    if (!renderer) return;
    const cap = { low: 1, medium: 1.5, high: 2 }[settings.quality];
    const pixelRatio = Math.min(window.devicePixelRatio || 1, cap) * (settings.adaptive ? adaptiveScale : 1);
    if (Math.abs(renderer.getPixelRatio() - pixelRatio) > .01) renderer.setPixelRatio(pixelRatio);
    if (renderer.domElement.width !== Math.floor(innerWidth * pixelRatio) || renderer.domElement.height !== Math.floor(innerHeight * pixelRatio)) renderer.setSize(innerWidth, innerHeight, false);
    renderDirty = true;
  }
  function samplePerformance(seconds) {
    if (!settings.adaptive || testRunning || state !== 'playing' || seconds <= 0 || seconds > .25) return;
    frameSum += seconds; frameSamples++;
    if (frameSum < 2) return;
    const average = frameSum / frameSamples, budget = 1 / settings.fps;
    measuredFPS = Math.round(1 / average);
    if (average > budget * 1.35 && adaptiveScale > .65) { adaptiveScale = Math.max(.65, adaptiveScale - .1); goodWindows = 0; resizeRenderer(); }
    else if (average < budget * 1.08 && adaptiveScale < 1 && ++goodWindows >= 3) { adaptiveScale = Math.min(1, adaptiveScale + .05); goodWindows = 0; resizeRenderer(); }
    else if (average >= budget * 1.08) goodWindows = 0;
    frameSum = 0; frameSamples = 0;
  }
  function syncSettings() {
    $('audio-setting').checked = settings.audio;
    $('brightness-setting').value = settings.brightness;
    $('sensitivity-setting').value = settings.sensitivity;
    $('quality-setting').value = settings.quality;
    $('reduced-setting').checked = settings.reduced;
    $('adaptive-setting').checked = settings.adaptive;
    $('fps-setting').value = settings.fps;
    document.body.dataset.quality = settings.quality;
    document.body.classList.toggle('reduced-motion', settings.reduced);
    $('sound-toggle').classList.toggle('sound-enabled', settings.audio);
    $('sound-toggle').querySelector('span').textContent = settings.audio ? 'SOUND ON' : 'SOUND OFF';
    $('sound-toggle').setAttribute('aria-label', settings.audio ? 'サウンドを無効にする' : 'サウンドを有効にする');
    if (renderer) {
      renderer.toneMappingExposure = Number(settings.brightness);
      renderer.shadowMap.enabled = settings.quality === 'high';
      flashlight.castShadow = settings.quality === 'high';
      if (groundMist) groundMist.visible = settings.quality !== 'low';
      resizeRenderer();
    }
  }
  $('sound-toggle').addEventListener('click', () => { audio.setEnabled(!settings.audio); syncSettings(); saveSettings(); });
  $('audio-setting').addEventListener('change', e => { audio.setEnabled(e.target.checked); syncSettings(); saveSettings(); });
  for (const key of ['brightness', 'sensitivity', 'quality', 'reduced', 'adaptive', 'fps']) {
    $(`${key}-setting`).addEventListener('input', e => {
      settings[key] = ['reduced', 'adaptive'].includes(key) ? e.target.checked : key === 'quality' ? e.target.value : Number(e.target.value);
      if (['quality', 'adaptive', 'fps'].includes(key)) { adaptiveScale = 1; frameSum = frameSamples = goodWindows = 0; }
      syncSettings(); saveSettings();
    });
  }
  document.querySelectorAll('[data-difficulty]').forEach(btn => btn.addEventListener('click', () => {
    difficulty = btn.dataset.difficulty;
    document.querySelectorAll('[data-difficulty]').forEach(b => { b.classList.toggle('selected', b === btn); b.setAttribute('aria-pressed', b === btn ? 'true' : 'false'); });
    updateDifficultyInfo();
  }));
  function updateDifficultyInfo() {
    setText('difficulty-description', {wander:'初めての探索に。怪異は遅く、長く走れます。',normal:'静かな探索と、息をのむ追跡。標準の恐怖体験。',nightmare:'怪異は速く、息は続かない。生還者のための森。'}[difficulty]);
    setText('menu-record', best[difficulty] ? `BEST ${formatTime(best[difficulty])}` : 'NO RECORD YET');
  }
  updateDifficultyInfo();
  $('howto-button').onclick = () => $('help-dialog').showModal();
  $('settings-button').onclick = $('pause-settings').onclick = () => $('settings-dialog').showModal();
  document.querySelectorAll('[data-close-dialog]').forEach(btn => btn.onclick = () => btn.closest('dialog').close());
  document.querySelectorAll('dialog').forEach(dialog => dialog.addEventListener('click', e => { if (e.target === dialog) { const r = dialog.getBoundingClientRect(); if (e.clientX < r.left || e.clientX > r.right || e.clientY < r.top || e.clientY > r.bottom) dialog.close(); } }));
  syncSettings();

  function randomGenerator(seed) { return () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t ^= t + Math.imul(t ^ t >>> 7, 61 | t); return ((t ^ t >>> 14) >>> 0) / 4294967296; }; }
  function position(index) { return navigation.positions[index]; }
  function cellAt(x, z) { const col = Math.round(x / TILE), row = Math.round(-z / TILE); return col < 0 || row < 0 || col >= SIZE || row >= SIZE ? -1 : row * SIZE + col; }
  function distances(start, output) { return navigation.distances(grid, start, output); }
  function buildMaze(seed) {
    const rand = randomGenerator(seed); grid = new Uint8Array(total); grid.fill(1);
    const start = SIZE + 1, stack = [start]; grid[start] = 0;
    while (stack.length) {
      const current = stack[stack.length - 1], x = current % SIZE, y = Math.floor(current / SIZE), available = [];
      for (const [dx, dy] of [[2, 0], [-2, 0], [0, 2], [0, -2]]) { const nx = x + dx, ny = y + dy; if (nx > 0 && ny > 0 && nx < SIZE - 1 && ny < SIZE - 1 && grid[ny * SIZE + nx]) available.push(ny * SIZE + nx); }
      if (!available.length) { stack.pop(); continue; }
      const next = available[Math.floor(rand() * available.length)]; grid[(current + next) / 2] = 0; grid[next] = 0; stack.push(next);
    }
    // Cross-links break dead-end mazes into a network with alternate escape routes.
    for (let y = 1; y < SIZE - 1; y++) for (let x = 1; x < SIZE - 1; x++) {
      const idx = y * SIZE + x;
      if (grid[idx] && ((grid[idx - 1] === 0 && grid[idx + 1] === 0) || (grid[idx - SIZE] === 0 && grid[idx + SIZE] === 0)) && rand() < .21) grid[idx] = 0;
    }
    for (let y = 1; y <= 3; y++) for (let x = 1; x <= 3; x++) grid[y * SIZE + x] = 0;
    for (let y = SIZE - 4; y < SIZE - 1; y++) for (let x = SIZE - 4; x < SIZE - 1; x++) grid[y * SIZE + x] = 0;
    exitIndex = (SIZE - 2) * SIZE + SIZE - 2;
    walkable = [];
    for (let i = 0; i < total; i++) if (grid[i] === 0) walkable.push(i);
    visited = new Uint8Array(total); fieldCell = -1; mapDirty = true; return rand;
  }

  const mat = (color, extra = {}) => new THREE.MeshStandardMaterial({ color, roughness: .93, ...extra });
  let materials, geometries, glowTexture, groundMist, moonDisc, handheld;
  const windUniform = { value: 0 };
  const atmosphereTime = { value: 0 };
  let presentationTime = 0;
  function mesh(geometry, material, parent, x = 0, y = 0, z = 0, sx = 1, sy = sx, sz = sx) {
    const m = new THREE.Mesh(geometry, material); m.position.set(x, y, z); m.scale.set(sx, sy, sz); if (parent) parent.add(m); return m;
  }
  function makeGlowTexture() {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 64; const ctx = canvas.getContext('2d');
    const g = ctx.createRadialGradient(32, 32, 0, 32, 32, 32); g.addColorStop(0, 'rgba(255,255,255,1)'); g.addColorStop(.13, 'rgba(255,255,255,.75)'); g.addColorStop(.4, 'rgba(255,255,255,.16)'); g.addColorStop(1, 'rgba(255,255,255,0)'); ctx.fillStyle = g; ctx.fillRect(0, 0, 64, 64);
    return new THREE.CanvasTexture(canvas);
  }
  function glow(parent, color, x, y, z, size) {
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: glowTexture, color, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending, opacity: .65 }));
    sprite.position.set(x, y, z); sprite.scale.set(size, size, 1); parent.add(sprite); return sprite;
  }
  function init3D() {
    if (!window.THREE) throw new Error('3Dライブラリを読み込めませんでした。ネット接続を確認して再読み込みしてください。');
    renderer = new THREE.WebGLRenderer({ canvas: $('world'), antialias: !touch, alpha: false, powerPreference: 'high-performance' });
    renderer.setSize(innerWidth, innerHeight, false); renderer.setClearColor(0x101c20); renderer.outputColorSpace = THREE.SRGBColorSpace; renderer.toneMapping = THREE.ACESFilmicToneMapping;
    scene = new THREE.Scene(); scene.background = new THREE.Color(0x101c20); scene.fog = new THREE.FogExp2(0x101c20, .032);
    renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    camera = new THREE.PerspectiveCamera(68, innerWidth / innerHeight, .08, 110); camera.rotation.order = 'YXZ'; scene.add(camera);
    const hemi = new THREE.HemisphereLight(0x8daab8, 0x242619, .85); scene.add(hemi);
    const moon = new THREE.DirectionalLight(0xa5c6d9, 2.1); moon.position.set(-25, 65, 10); scene.add(moon);
    flashlight = new THREE.SpotLight(0xf3edcf, 36, 40, Math.PI / 6.5, .82, 1.2); flashlight.position.set(0, -.16, -.15); camera.add(flashlight);
    lightTarget = new THREE.Object3D(); lightTarget.position.set(0, -.12, -12); camera.add(lightTarget); flashlight.target = lightTarget;
    flashlight.shadow.mapSize.set(1024, 1024); flashlight.shadow.bias = -.001; flashlight.shadow.normalBias = .035;
    flashlight.shadow.camera.near = .15; flashlight.shadow.camera.far = 40;
    const fill = new THREE.PointLight(0xb8c8a5, .5, 7, 1); camera.add(fill);
    glowTexture = makeGlowTexture();
    materials = { bark: mat(0x38362c), leaves: mat(0x233d35), needles: mat(0x253c2e), ground: mat(0x657064), rock: mat(0x46514d), moss: mat(0x2c3c24), bush: mat(0x192a1c), path: mat(0x394235), bone: mat(0xc5c7a9), black: mat(0x070a08), eyes: mat(0xc1e9ca, { emissive: 0xbad4ae, emissiveIntensity: 1.4 }), teeth: mat(0xd7ceb1), cloth: mat(0x829c8f), wood: mat(0x473b2d), crust: mat(0xb77b35), filling: mat(0x4f1717), gold: mat(0xffd27d, { emissive: 0xe6ac45, emissiveIntensity: .9 }), shrine: mat(0x623b30) };
    materials.batched = mat(0xffffff, { vertexColors: true });
    addSurfaceDetail(materials.batched);
    materials.ground.map = makeGroundTexture();
    materials.ground.bumpMap = materials.ground.map; materials.ground.bumpScale = .16;
    geometries = { sphere: new THREE.SphereGeometry(1, 16, 12), rock: new THREE.IcosahedronGeometry(1, 1), cone: new THREE.ConeGeometry(1, 1, 7), trunk: new THREE.CylinderGeometry(.10, .24, 1, 8), branch: new THREE.CylinderGeometry(.07, .17, 1, 5), cylinder: new THREE.CylinderGeometry(1, 1, 1, 12), box: new THREE.BoxGeometry(1, 1, 1) };
    geometries.pine = makePineGeometry(); geometries.fern = makeFernGeometry();
    const floor = mesh(new THREE.PlaneGeometry(1200, 1200), materials.ground, scene, 170, -.11, -55);
    floor.rotation.x = -Math.PI / 2; floor.receiveShadow = true;
    createHandheld();
    createMenu(); createAtmosphere(); syncSettings(); gpuReady = true;
    $('start-button').disabled = false; $('start-button').innerHTML = '<span class="start-label">森に入る<span>ENTER THE FOREST</span></span><span class="button-arrow">↗</span>';
    renderer.domElement.addEventListener('webglcontextlost', e => { e.preventDefault(); if (state === 'playing') pauseGame(); gpuReady = false; showError('描画が一時停止しました。復旧を待つか、ほかのアプリを閉じて再読み込みしてください。'); });
    renderer.domElement.addEventListener('webglcontextrestored', () => { gpuReady = true; renderDirty = true; lastTime = 0; resizeRenderer(); $('load-error').classList.add('hidden'); });
    requestAnimationFrame(animate);
  }
  // Original procedural assets: no network textures, models or postprocessing dependency.
  function makeGroundTexture() {
    const canvas = document.createElement('canvas'); canvas.width = canvas.height = 512;
    const ctx = canvas.getContext('2d'), rand = randomGenerator(29017);
    ctx.fillStyle = '#55584b'; ctx.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 7000; i++) {
      const x = rand() * 512, y = rand() * 512, r = 1 + rand() * 18;
      ctx.fillStyle = `rgba(${rand() > .6 ? '102,110,69' : '22,27,25'},${.03 + rand() * .1})`;
      ctx.beginPath(); ctx.ellipse(x, y, r, r * .5, rand() * 6.28, 0, 6.28); ctx.fill();
    }
    for (let i = 0; i < 3200; i++) {
      const x = rand() * 512, y = rand() * 512;
      ctx.strokeStyle = ['#383d32', '#74725a', '#454331', '#696451'][i % 4];
      ctx.lineWidth = .5 + rand(); ctx.beginPath(); ctx.moveTo(x, y); ctx.lineTo(x + rand() * 7 - 3, y + rand() * 6); ctx.stroke();
    }
    const texture = new THREE.CanvasTexture(canvas); texture.colorSpace = THREE.SRGBColorSpace;
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping; texture.repeat.set(120, 120);
    texture.anisotropy = Math.min(8, renderer.capabilities.getMaxAnisotropy()); return texture;
  }
  function addSurfaceDetail(material) {
    material.onBeforeCompile = shader => {
      shader.uniforms.forestWind = windUniform;
      shader.vertexShader = 'varying vec3 forestPosition;\nuniform float forestWind;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        // Batches contain world-space vertices. Bend only the canopy, never collision boundaries.
        float canopy = smoothstep(4.0, 14.0, position.y);
        transformed.x += sin(position.z * .17 + forestWind) * canopy * .13;
        transformed.z += cos(position.x * .12 + forestWind * .7) * canopy * .09;
        forestPosition = transformed;`);
      shader.uniforms.forestDetail = { value: materials.ground.map };
      shader.fragmentShader = 'varying vec3 forestPosition;\nuniform sampler2D forestDetail;\n' + shader.fragmentShader;
      shader.fragmentShader = shader.fragmentShader.replace('#include <color_fragment>', `#include <color_fragment>
        float grain = texture2D(forestDetail, vec2(forestPosition.x + forestPosition.z, forestPosition.y * .12) * .6).g * 3.0;
        float moss = texture2D(forestDetail, forestPosition.xz * .08).g * 3.0;
        diffuseColor.rgb *= .67 + grain * .48 + moss * .22;
        diffuseColor.rgb = mix(diffuseColor.rgb, diffuseColor.rgb * vec3(.74,1.12,.8), (1.0-smoothstep(0.0,2.5,forestPosition.y)) * moss * .45);`);
    };
    material.customProgramCacheKey = () => 'forest-surface-v3';
  }
  function makePineGeometry() {
    const verts = [], rand = randomGenerator(13);
    // Broken, serrated branch whorls rather than stacked cones.
    for (let tier = 0; tier < 6; tier++) {
      const y = .32 + tier * .105, radius = (.24 - tier * .033), count = 13;
      for (let i = 0; i < count; i++) {
        const a = i / count * Math.PI * 2 + tier * .73, b = (i + 1) / count * Math.PI * 2 + tier * .73;
        const ra = radius * (.7 + rand() * .45), rb = radius * (.7 + rand() * .45);
        verts.push(0, y + .25, 0, Math.cos(b)*rb, y + rand()*.04, Math.sin(b)*rb, Math.cos(a)*ra, y + rand()*.04, Math.sin(a)*ra);
        verts.push(0,y+.02,0,Math.cos(a)*ra,y,Math.sin(a)*ra,Math.cos(b)*rb,y,Math.sin(b)*rb);
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3)); geo.computeVertexNormals(); return geo;
  }
  function makeFernGeometry() {
    const verts = [];
    for (let j = 0; j < 5; j++) {
      const a = j * 2.399, dx = Math.cos(a), dz = Math.sin(a);
      for (let k = 1; k <= 4; k++) {
        const t = k / 5, reach = t * .9, height = Math.sin(t * 2.5) * .7;
        const width = (1 - t) * .31;
        for (const side of [-1, 1]) {
          const leaf = [dx*reach,height,dz*reach, dx*(reach+.15)-dz*width*side,height-.045,dz*(reach+.15)+dx*width*side, dx*(reach+.2),height+.04,dz*(reach+.2)];
          if (side === -1) verts.push(...leaf.slice(0,3),...leaf.slice(6,9),...leaf.slice(3,6)); else verts.push(...leaf);
        }
      }
    }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.Float32BufferAttribute(verts,3)); geo.computeVertexNormals(); return geo;
  }
  function makeForestInstances(parent, entries) {
    const trunks = new THREE.InstancedMesh(geometries.trunk, materials.bark, entries.length);
    const crowns = new THREE.InstancedMesh(geometries.pine, materials.leaves, entries.length);
    const limbs = new THREE.InstancedMesh(geometries.branch, materials.bark, entries.length * 5);
    const dummy = new THREE.Object3D();
    entries.forEach((t, i) => {
      dummy.position.set(t.x, t.h / 2, t.z); dummy.rotation.set(0, t.rot, t.lean || 0); dummy.scale.set(t.w, t.h, t.w); dummy.updateMatrix(); trunks.setMatrixAt(i, dummy.matrix);
      dummy.position.set(t.x, 0, t.z); dummy.scale.set(t.h, t.h, t.h); dummy.updateMatrix(); crowns.setMatrixAt(i, dummy.matrix);
      for (let j = 0; j < 5; j++) {
        const a = t.rot + j * 2.4, reach = t.h * (.13 - j * .014);
        dummy.position.set(t.x + Math.cos(a)*reach*.45, t.h*(.36+j*.095), t.z + Math.sin(a)*reach*.45);
        dummy.rotation.set(Math.sin(a)*.95, 0, -Math.cos(a)*.95); dummy.scale.set(t.w*.35, reach*1.5, t.w*.35); dummy.updateMatrix(); limbs.setMatrixAt(i*5+j,dummy.matrix);
      }
    });
    for (const obj of [trunks, crowns, limbs]) { obj.instanceMatrix.needsUpdate = true; parent.add(obj); }
  }
  function addUndergrowth(parent, entries) {
    const ferns = new THREE.InstancedMesh(geometries.fern, materials.moss, entries.length), dummy = new THREE.Object3D();
    entries.forEach((e,i) => { dummy.position.set(e.x, 0, e.z); dummy.rotation.set(0,e.rot,0); dummy.scale.setScalar(e.h); dummy.updateMatrix(); ferns.setMatrixAt(i,dummy.matrix); });
    parent.add(ferns);
  }
  function makeLantern(parent, x, z, light = false) {
    const g = new THREE.Group(); g.position.set(x,0,z); parent.add(g);
    mesh(geometries.box, materials.rock, g, 0,.1,0,.65,.2,.65);
    mesh(geometries.cylinder, materials.wood, g, 0,.42,0,.15,.65,.15);
    mesh(geometries.box, materials.black, g, 0,.84,0,.44,.08,.44);
    mesh(geometries.box, materials.gold, g, 0,1.03,0,.23,.32,.23);
    for (const a of [-1,1]) for (const b of [-1,1]) mesh(geometries.box,materials.wood,g,a*.18,1.04,b*.18,.035,.4,.035);
    mesh(geometries.cone, materials.rock, g, 0,1.33,0,.4,.25,.4);
    const halo = glow(g,0xffb85e,0,1.04,0,2.3); halo.material.opacity = .55;
    if (light) { const lamp = new THREE.PointLight(0xffb363,8,11,1.5); lamp.position.set(0,1.2,0); g.add(lamp); }
    ForestEngine.batchRigid(g); return g;
  }
  function createMenu() {
    menuGroup = new THREE.Group(); scene.add(menuGroup); const rand = randomGenerator(83), trees = [], ferns = [];
    for (let i = 0; i < 430; i++) {
      const z = 35 - rand() * 115, x = 320 + (rand() - .5) * 110;
      const trail = 320 + Math.sin(z * .055) * 3;
      if (Math.abs(x - trail) < 3.4 && z > -45) continue;
      trees.push({ x, z, h: 10 + rand() * 16, w: 1.5 + rand() * 2.5, rot: rand() * 6.28, lean: (rand() - .5) * .1 });
      if (z > -30) ferns.push({x,z,h:1+rand()*1.5,rot:rand()*6.28});
    }
    makeForestInstances(menuGroup, trees); addUndergrowth(menuGroup, ferns);
    for (let i = 0; i < 44; i++) {
      const z = 28 - i * 1.6, x = 320 + Math.sin(z * .055) * 3;
      const side = i % 2 ? -1 : 1;
      mesh(geometries.rock, materials.rock, menuGroup, x + side * (3.4+rand()*2), .1, z, .4+rand(), .35+rand()*.6, .6+rand());
    }
    // A real, explorable-looking shrine tableau, composed around the negative space of the UI.
    const shrine = new THREE.Group(); shrine.position.set(321,0,-4); shrine.scale.setScalar(1.35); menuGroup.add(shrine);
    buildTorii(shrine);
    const face = createEntity('face'); face.position.set(324.8, 3.5, -18); face.scale.setScalar(.85); menuGroup.add(face); menuGroup.userData.face = face;
    const tall = createEntity('tall'); tall.position.set(314.2, 0, 3); tall.rotation.y = .4; menuGroup.add(tall);
    makeLantern(menuGroup,317,8,true); makeLantern(menuGroup,324,1,true); makeLantern(menuGroup,318.4,-6,true);
    const fogLight = new THREE.PointLight(0x83bfcf,16,40,1); fogLight.position.set(320,8,-9); menuGroup.add(fogLight);
    const moon = new THREE.Sprite(new THREE.SpriteMaterial({map:glowTexture,color:0xa6d5e4,opacity:.26,transparent:true,depthWrite:false,fog:false,blending:THREE.AdditiveBlending}));
    moon.position.set(316,27,-65); moon.scale.set(32,32,1); menuGroup.add(moon);
    moonDisc = mesh(new THREE.SphereGeometry(1,24,16),new THREE.MeshBasicMaterial({color:0xd4e2d5,fog:false}),menuGroup,316,27,-65,1.3);
    moonDisc.userData.noBatch = true;
    ForestEngine.batchStatic(menuGroup, materials.batched);
  }
  function createAtmosphere() {
    const count = 220, positions = new Float32Array(count * 3), rand = randomGenerator(72);
    for (let i = 0; i < count; i++) { positions[i * 3] = (rand() - .5) * 65; positions[i * 3 + 1] = rand() * 10; positions[i * 3 + 2] = (rand() - .5) * 65; }
    const geo = new THREE.BufferGeometry(); geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    const particleMaterial = new THREE.PointsMaterial({ color: 0xb3cdbd, size: .07, map: glowTexture, transparent: true, opacity: .55, depthWrite: false });
    particleMaterial.onBeforeCompile = shader => {
      shader.uniforms.atmosphereTime = atmosphereTime;
      shader.vertexShader = 'uniform float atmosphereTime;\n' + shader.vertexShader;
      shader.vertexShader = shader.vertexShader.replace('#include <begin_vertex>', `#include <begin_vertex>
        transformed.x += sin(atmosphereTime * .4 + position.z) * .35;
        transformed.y += sin(atmosphereTime * .6 + position.x) * .3;`);
    };
    atmosphere = new THREE.Points(geo, particleMaterial); scene.add(atmosphere);
    groundMist = new THREE.Group(); scene.add(groundMist);
    for (let i = 0; i < 12; i++) {
      const mist = new THREE.Sprite(new THREE.SpriteMaterial({map:glowTexture,color:0x9dbac0,opacity:.055,transparent:true,depthWrite:false}));
      mist.userData.offset = new THREE.Vector3((rand()-.5)*60,.35+rand()*1.4,(rand()-.5)*60);
      mist.scale.set(20+rand()*16,2+rand()*2,1); groundMist.add(mist);
    }
  }
  function createHandheld() {
    handheld = new THREE.Group(); handheld.position.set(.27,-.3,-.46); handheld.rotation.set(-Math.PI/2+.13,0,-.15); camera.add(handheld);
    const metal = mat(0x293434,{metalness:.75,roughness:.3}), rim = mat(0x777f79,{metalness:.8,roughness:.25});
    mesh(geometries.cylinder,metal,handheld,0,0,0,.045,.24,.045);
    mesh(geometries.cylinder,rim,handheld,0,.12,0,.062,.055,.062);
    mesh(geometries.cylinder,materials.gold,handheld,0,.151,0,.048,.004,.048);
    ForestEngine.batchRigid(handheld); handheld.traverse(obj => { obj.castShadow = false; obj.receiveShadow = false; }); handheld.visible = false;
  }
  function buildTorii(parent) {
    for (const side of [-1,1]) {
      const post = mesh(geometries.cylinder,materials.shrine,parent,side*1.8,2.5,0,.24,5,.24); post.rotation.z = side*.025;
      mesh(geometries.cylinder,materials.rock,parent,side*1.86,.24,0,.4,.48,.4);
      mesh(geometries.box,materials.wood,parent,side*1.8,4.85,0,.65,.14,.7);
    }
    mesh(geometries.box,materials.shrine,parent,0,4.75,0,5,.32,.5);
    mesh(geometries.box,materials.black,parent,0,5.06,0,5.5,.23,.7);
    for (const side of [-1,1]) { const tip=mesh(geometries.box,materials.black,parent,side*2.7,5.15,0,.8,.23,.7);tip.rotation.z=side*.18; }
    mesh(geometries.box,materials.shrine,parent,0,3.7,0,4.6,.23,.28);
    mesh(geometries.box,materials.wood,parent,0,4.23,.3,.5,.9,.13);
    for (let j=0;j<3;j++) mesh(geometries.box,materials.gold,parent,0,4.43-j*.18,.375,.12,.055,.01);
    for (let i=-3;i<=3;i++) {
      const paper = mesh(geometries.box,materials.bone,parent,i*.39,3.18+Math.abs(i)*.08,.04,.13,.4,.025); paper.rotation.z=i%2?.25:-.25;
      const rope = mesh(geometries.box,materials.wood,parent,i*.46,3.49+Math.abs(i)*.05,0,.5,.045,.04);rope.rotation.z=i*.06;
    }
    ForestEngine.batchRigid(parent);
  }
  function createEntity(type) {
    const g = new THREE.Group(), G = geometries, M = materials;
    if (type === 'face') {
      mesh(G.sphere, M.bone, g, 0, 0, 0, 1.34, 1.8, .65);
      mesh(G.sphere, M.bone, g, 0, -.87, .16, .94, 1, .62);
      for (const s of [-1, 1]) {
        mesh(G.sphere, M.black, g, s * .54, .38, .53, .42, .43, .19);
        mesh(G.sphere, M.eyes, g, s * .54, .37, .7, .038, .046, .035);
        const brow = mesh(G.box, M.bark, g, s * .56, .91, .54, .77, .12, .12); brow.rotation.z = s * -.2;
        mesh(G.sphere, M.bark, g, s * .8, -.55, .53, .07, .54, .04).rotation.z = s * .13;
      }
      mesh(G.cone, M.bone, g, 0, .02, .76, .24, .65, .38).rotation.x = -.2;
      mesh(G.sphere, M.black, g, 0, -.88, .64, .53, .62, .13);
      for (let i = 0; i < 7; i++) { const x = (i - 3) * .128; mesh(G.cone, M.teeth, g, x, -.48, .75, .08, .29 + Math.abs(i - 3) * .025, .07).rotation.z = Math.PI; mesh(G.cone, M.teeth, g, x, -1.26, .74, .07, .24, .07); }
    } else if (type === 'ghost') {
      mesh(G.cone, M.cloth, g, 0, 1.15, 0, 1.05, 2.5, .62);
      mesh(G.sphere, M.bone, g, 0, 2.53, .02, .43, .58, .34);
      mesh(G.sphere, M.black, g, 0, 2.08, .3, .16, .35, .05);
      for (const s of [-1, 1]) {
        mesh(G.sphere, M.black, g, s * .17, 2.64, .31, .12, .18, .06);
        mesh(G.sphere, M.eyes, g, s * .17, 2.63, .36, .03, .04, .03);
        const arm = mesh(G.cone, M.cloth, g, s * .74, 1.62, 0, .25, 1.5, .23); arm.rotation.z = s * .67;
        mesh(G.sphere, M.bone, g, s * 1.12, 1.03, .13, .12, .4, .12);
      }
      for (let i = 0; i < 7; i++) mesh(G.cone, M.cloth, g, (i - 3) * .27, .12 + Math.sin(i) * .08, .03, .2, .55, .4).rotation.z = Math.PI;
    } else {
      mesh(G.sphere, M.black, g, 0, 3.53, 0, .36, 1.15, .22);
      mesh(G.sphere, M.bone, g, 0, 5.04, 0, .28, .66, .26);
      for (const s of [-1, 1]) {
        const leg = mesh(G.cylinder, M.black, g, s * .26, 1.49, 0, .105, 3.1, .105); leg.rotation.z = s * -.07;
        const arm = mesh(G.cylinder, M.black, g, s * .66, 2.67, 0, .075, 3.6, .075); arm.rotation.z = s * .15;
        mesh(G.sphere, M.bone, g, s * .91, .98, 0, .085, .38, .1);
        mesh(G.sphere, M.black, g, s * .105, 5.17, .239, .09, .18, .03);
        mesh(G.sphere, M.eyes, g, s * .1, 5.15, .268, .025, .037, .012);
      }
      mesh(G.sphere, M.black, g, 0, 4.84, .25, .07, .21, .03);
    }
    if (type === 'face') {
      for (let i=0;i<9;i++) {
        const side=i%2?1:-1, fissure=mesh(G.box,M.black,g,side*(.24+(i%3)*.26),.9-Math.floor(i/3)*.58,.625,.016,.28+(i%3)*.11,.014);
        fissure.rotation.z=side*(.1+i*.07);
      }
      g.scale.x = .87;
    } else if (type === 'ghost') {
      for (let i=0;i<11;i++) {
        const fold = mesh(G.cone,M.cloth,g,(i-5)*.14,.56+Math.sin(i)*.12,.23,.07,1.8,.08);
        fold.rotation.z=(i-5)*.025;
      }
    }
    ForestEngine.batchRigid(g);
    return g;
  }
  function disposeWorld() {
    if (!worldGroup) return;
    worldGroup.traverse(obj => { if (obj.isInstancedMesh) obj.dispose(); if (obj.isSprite) obj.material.dispose(); if (obj.userData.ownedGeometry) obj.geometry.dispose(); });
    scene.remove(worldGroup); renderer.renderLists.dispose(); worldGroup = null; pies = []; enemies = []; worldChunks = []; exitGroup = null;
  }
  function buildWorld() {
    disposeWorld(); mazeSeed = fixedSeed ?? Math.floor(Math.random() * 0xFFFFFF); const rand = buildMaze(mazeSeed);
    worldGroup = new THREE.Group(); scene.add(worldGroup);
    const trees = [], shrubEntries = [], stoneEntries = [], fernEntries = [];
    for (let i = 0; i < total; i++) {
      const p = position(i);
      if (grid[i]) {
        // Dense thorn/moss blocks make the collision boundary visually readable.
        shrubEntries.push({ x: p.x, z: p.z, h: 1.5 + rand() * .8, rot: rand() * 6.28 });
        for (let f = 0; f < 6; f++) { const a = f / 6 * Math.PI * 2; fernEntries.push({x:p.x+Math.cos(a)*2.35,z:p.z+Math.sin(a)*2.35,h:1.3+rand(),rot:rand()*6.28}); }
        const n = 3 + (rand() > .5 ? 1 : 0);
        for (let j = 0; j < n; j++) trees.push({ x: p.x + (rand() - .5) * 4.7, z: p.z + (rand() - .5) * 4.7, h: 7 + rand() * 10, w: 1.3 + rand() * 2.2, rot: rand() * 6.28 });
        if (rand() > .5) stoneEntries.push({ x: p.x + (rand() - .5) * 4, z: p.z + (rand() - .5) * 4, h: 1 + rand() * 1.3, rot: rand() * 6.28 });
      } else {
        rand(); // Seeded scenery variation remains deterministic.
        if (rand() < .25) stoneEntries.push({ x: p.x + (rand() < .5 ? -2.6 : 2.6), z: p.z + (rand() - .5) * 4, h: .15 + rand() * .3, rot: rand() * 6.28 });
      }
    }
    makeForestInstances(worldGroup, trees);
    const dummy = new THREE.Object3D();
    const bushes = new THREE.InstancedMesh(geometries.rock, materials.bush, shrubEntries.length);
    shrubEntries.forEach((e, i) => { dummy.position.set(e.x, .15, e.z); dummy.rotation.set(0, e.rot, 0); dummy.scale.set(3.25, e.h, 3.25); dummy.updateMatrix(); bushes.setMatrixAt(i, dummy.matrix); });
    bushes.instanceMatrix.needsUpdate = true; worldGroup.add(bushes);
    const rocks = new THREE.InstancedMesh(geometries.rock, materials.rock, stoneEntries.length);
    stoneEntries.forEach((e, i) => { dummy.position.set(e.x, e.h * .4, e.z); dummy.rotation.set(e.rot, e.rot, 0); dummy.scale.set(e.h * 1.5, e.h, e.h); dummy.updateMatrix(); rocks.setMatrixAt(i, dummy.matrix); });
    rocks.instanceMatrix.needsUpdate = true; worldGroup.add(rocks);
    addUndergrowth(worldGroup, fernEntries);
    // Breadcrumb mushrooms, weathered direction signs and cairns.
    walkable.forEach((idx, n) => {
      const p = position(idx);
      if (n % 17 === 0) {
        const sign = mesh(geometries.box, materials.wood, worldGroup, p.x + 2.1, 1.1, p.z + 1.9, .14, 2.2, .14);
        const board = mesh(geometries.box, materials.wood, worldGroup, p.x + 2.1, 1.9, p.z + 1.9, 1.5, .4, .1); board.rotation.z = -.12;
        mesh(geometries.box, materials.bone, worldGroup, p.x + 2.1, 1.9, p.z + 1.97, .7, .04, .02);
      }
      if (n % 9 === 0) { const x = p.x - 2.25, z = p.z + .9; mesh(geometries.sphere, materials.moss, worldGroup, x, .09, z, .22, .13, .22); }
    });
    worldChunks = ForestEngine.batchStatic(worldGroup, materials.batched);
    const origin = SIZE + 1, d = distances(origin), chosen = [];
    // Farthest-point placement yields ten offerings spread over the connected map.
    let candidates = walkable.filter(i => d[i] >= 7 && i !== exitIndex);
    const first = candidates.filter(i => d[i] <= 12); chosen.push(first[Math.floor(rand() * first.length)] || candidates[0]);
    while (chosen.length < 10) {
      let bestIdx = -1, bestScore = -1;
      for (const idx of candidates) {
        if (chosen.includes(idx)) continue;
        const p = position(idx); let score = Infinity;
        for (const selected of chosen) { const q = position(selected); score = Math.min(score, Math.hypot(p.x - q.x, p.z - q.z)); }
        score *= .9 + rand() * .2;
        if (score > bestScore) { bestScore = score; bestIdx = idx; }
      }
      chosen.push(bestIdx);
    }
    chosen.forEach((idx, i) => createPie(idx, i));
    createExit();
    makeLantern(worldGroup, TILE-2, -TILE-2, true);
    const spawnCandidates = walkable.filter(i => d[i] > 35 && d[i] < 70);
    ['face', 'ghost', 'tall'].forEach((type, i) => {
      const pool = spawnCandidates.length ? spawnCandidates : walkable.filter(idx => d[idx] > 20);
      const idx = pool[Math.floor(rand() * pool.length)], p = position(idx), group = createEntity(type); worldGroup.add(group);
      const baseY = type === 'face' ? 2.4 : type === 'ghost' ? .45 : 0; group.position.set(p.x, baseY, p.z);
      enemies.push({ type, group, x: p.x, z: p.z, baseY, cell: idx, target: null, baseSpeed: [2.25, 2.02, 2.5][i], offset: rand() * 6.28, blinkAt: 35 + i * 6, soundAt: 0 });
    });
    // Every generated run is checked for connectivity before it can begin.
    if (pies.length !== 10 || pies.some(p => d[p.index] < 0) || d[exitIndex] < 0 || enemies.length !== 3) throw new Error('森の生成に失敗しました。再読み込みしてください。');
    console.info('[Hollow Woods] World validated:', { seed: mazeSeed, reachableCells: walkable.length, offerings: pies.length, entities: enemies.length, extent: `${WORLD}m × ${WORLD}m` });
  }
  function createPie(index, number) {
    const p = position(index), group = new THREE.Group(); group.position.set(p.x, 0, p.z); worldGroup.add(group);
    mesh(geometries.cylinder, materials.wood, group, 0, .35, 0, .54, .7, .54);
    mesh(geometries.cylinder, materials.bone, group, 0, .74, 0, .51, .04, .51);
    const pastry = new THREE.Group(); pastry.position.y = .84; group.add(pastry);
    mesh(geometries.cylinder, materials.crust, pastry, 0, 0, 0, .43, .16, .43);
    mesh(geometries.cylinder, materials.filling, pastry, 0, .09, 0, .365, .018, .365);
    for (let i = -2; i <= 2; i++) for (let axis = 0; axis < 2; axis++) { const length = Math.sqrt(.35 * .35 - (i * .12) ** 2) * 2; mesh(geometries.box, materials.crust, pastry, axis ? 0 : i * .12, .12 + axis * .01, axis ? i * .12 : 0, axis ? length : .055, .035, axis ? .055 : length); }
    const halo = glow(group, 0xffc66e, 0, 1.35, 0, 2.8);
    for (let j = 0; j < 3; j++) mesh(geometries.sphere, materials.gold, group, Math.sin(j * 2.1) * .4, 1.35 + j * .43, Math.cos(j * 2.1) * .4, .035);
    ForestEngine.batchRigid(pastry); ForestEngine.batchRigid(group);
    pies.push({ index, number, group, pastry, halo, x: p.x, z: p.z, collected: false });
  }
  function createExit() {
    const p = position(exitIndex); exitGroup = new THREE.Group(); exitGroup.position.set(p.x, 0, p.z); worldGroup.add(exitGroup);
    buildTorii(exitGroup);
    for (const side of [-1,1]) makeLantern(exitGroup,side*2.6,1.5);
    const beacon = glow(exitGroup, 0x82dbbc, 0, 3, -.1, 7); beacon.material.opacity = .15; exitGroup.userData.beacon = beacon;
    const light = new THREE.PointLight(0x89cebb, 9, 17, 1); light.position.set(0, 3, 1); exitGroup.add(light);
    ForestEngine.batchRigid(exitGroup);
  }

  function showError(message) { $('load-error-text').textContent = message; $('load-error').classList.remove('hidden'); }
  function toast(message, duration = 4000) { setText('toast', message); $('toast').classList.add('visible'); toastRemaining = duration / 1000; }
  function resetInput() {
    const captures = [['move-stick', input.stickId], ['look-zone', input.lookId], ['run-button', input.runId]];
    input.keys.clear(); input.moveX = input.moveY = 0; input.run = false; input.stickSprint = false;
    input.lookId = input.stickId = input.runId = null; input.mouseDown = false;
    for (const [id, pointerId] of captures) {
      const node = $(id);
      if (pointerId !== null && node.hasPointerCapture?.(pointerId)) { try { node.releasePointerCapture(pointerId); } catch (_) {} }
    }
    $('stick-knob').style.transform = ''; $('move-stick').classList.remove('sprinting'); $('run-button').classList.remove('active');
  }
  function exitPointer() { if (document.pointerLockElement) document.exitPointerLock?.(); }
  function requestPointer() { if (testRunning || touch || state !== 'playing' || (navigator.userActivation && !navigator.userActivation.isActive)) return; try { const p = $('world').requestPointerLock?.(); if (p && p.catch) p.catch(() => {}); } catch (_) {} }
  function startGame() {
    if (!gpuReady) return;
    audio.init(); resetInput();
    try { buildWorld(); } catch (err) { console.error(err); showError(err.message); return; }
    elapsed = 0; collected = 0; player.x = TILE; player.z = -TILE; player.yaw = -Math.PI / 4; player.pitch = 0; player.stamina = 100; player.exhausted = false; player.moving = player.running = false;
    camera.fov = 68; camera.updateProjectionMatrix(); lastThreatOpacity = lastAudioLevel = -1; frameSum = frameSamples = 0;
    $('look-tip').style.opacity = ''; $('map-button').setAttribute('aria-pressed', 'false');
    lampOn = true; lastCell = -1; fieldCell = -1; visualTimer = 0; hudTimer = 0; stepper.reset(); lastTime = 0; renderDirty = true; nextFootstep = nextHeartbeat = 0; headBob = threat = 0; capturedBy = ''; mapOpen = false;
    state = 'playing'; $('chapter-intro').classList.remove('hidden'); menuGroup.visible = false; worldGroup.visible = true;
    document.body.classList.add('playing');
    for (const id of ['menu-screen', 'pause-screen', 'result-screen', 'map-panel']) $(id).classList.add('hidden');
    $('game-hud').inert = false; $('game-hud').classList.remove('hidden'); $('pie-count').innerHTML = '0 <span>/ 10</span>'; $('objective-text').textContent = 'パイを集める'; $('difficulty-label').textContent = levels[difficulty].name;
    $('danger-overlay').style.opacity = 0; $('flash-overlay').style.opacity = 0; $('threat-text').textContent = ''; $('interact-prompt').classList.add('hidden');
    $('lamp-status').textContent = '● LIGHT ON'; $('lamp-button').classList.add('active');
    scene.fog.density = .038; toast('琥珀色の灯りを探して。10個集めたら、北の鳥居へ。', 6500);
    revealMap(); updateCamera(0); updateHud(); requestPointer();
  }
  function pauseGame() {
    if (state !== 'playing') return;
    state = 'paused'; stepper.reset(); lastTime = 0; renderDirty = true; resetInput(); exitPointer(); $('pause-screen').classList.remove('hidden');
    audio.setAmbient(.04); audio.stopEffects();
    $('game-hud').inert = true; $('resume-button').focus({preventScroll:true});
  }
  function resumeGame() { if (state !== 'paused' || !gpuReady || document.hidden) return; state = 'playing'; stepper.reset(); lastTime = 0; lastAudioLevel = -1; frameSum = frameSamples = 0; renderDirty = true; $('pause-screen').classList.add('hidden'); $('game-hud').inert = false; audio.init(); requestPointer(); }
  function returnMenu() {
    state = 'menu'; resetInput(); exitPointer(); toastRemaining = 0; menuGroup.visible = true; disposeWorld(); renderDirty = true; stepper.reset();
    document.body.classList.remove('playing'); for (const id of ['game-hud', 'pause-screen', 'result-screen']) $(id).classList.add('hidden'); $('menu-screen').classList.remove('hidden');
    updateDifficultyInfo(); $('start-button').focus({preventScroll:true});
    $('danger-overlay').style.opacity = 0; $('flash-overlay').style.opacity = 0; scene.fog.density = .032;
    camera.fov = 68; camera.updateProjectionMatrix(); lastTime = 0; audio.stopEffects(); audio.setAmbient(.16);
  }
  function finishGame(won) {
    state = won ? 'won' : 'lost'; renderDirty = true; stepper.reset(); audio.setAmbient(.04); resetInput(); exitPointer(); $('game-hud').classList.add('hidden'); $('result-screen').classList.remove('hidden'); $('flash-overlay').style.opacity = 0; $('danger-overlay').style.opacity = won ? 0 : .22;
    $('result-eyebrow').textContent = won ? 'YOU OWE THE FOREST NOTHING' : 'THE FOREST REMEMBERS'; $('result-title').textContent = won ? '夜が、明ける。' : '見つかった。';
    $('result-description').textContent = won ? '10個の供物は届いた。あなたの足音だけが、森を出た。' : `${capturedBy}に捕まった。森は、またひとつ秘密を増やした。`;
    $('retry-button').focus({preventScroll:true});
    $('result-pies').textContent = `${collected} / 10`; $('result-time').textContent = formatTime(elapsed); $('result-record').textContent = '';
    if (won && !testRunning) {
      const previous = best[difficulty]; if (!previous || elapsed < previous) { best[difficulty] = elapsed; try { localStorage.setItem('hollow-woods-records', JSON.stringify(best)); } catch (_) {} $('result-record').textContent = 'この端末の最速記録を更新しました。'; } else $('result-record').textContent = `この難易度の最速記録：${formatTime(previous)}`;
      audio.tone(261.6, 2.5, .12); audio.tone(392, 3, .08); audio.tone(523.2, 3.8, .045);
    }
  }
  function capture(enemy) {
    if (state !== 'playing') return; state = 'caught'; renderDirty = true; visualTimer = 0; resetInput(); exitPointer(); capturedBy = { face: '巨大な顔', ghost: '幽霊', tall: 'ノッポ' }[enemy.type]; catchTime = 0;
    // A short, non-strobing reveal. Reduced mode skips the close-up altogether.
    audio.noise(.8, .8, 1600); audio.tone(85, 1.1, .32, 'sawtooth', 28);
    if (settings.reduced) { finishGame(false); return; }
    const eyeY = enemy.type === 'face' ? enemy.baseY + .2 : enemy.type === 'ghost' ? 3.0 : 5.1;
    camera.position.set(enemy.x + Math.sin(enemy.group.rotation.y) * 2.05, eyeY, enemy.z + Math.cos(enemy.group.rotation.y) * 2.05);
    camera.lookAt(enemy.x, eyeY, enemy.z); flashlight.intensity = 50; $('flash-overlay').style.opacity = .12;
  }
  function toggleLamp() { if (state !== 'playing') return; lampOn = !lampOn; $('lamp-status').textContent = lampOn ? '● LIGHT ON' : '○ LIGHT OFF'; $('lamp-button').classList.toggle('active', lampOn); audio.noise(.05, .18, 1800); }
  function toggleMap(force) {
    if (state !== 'playing') return;
    mapOpen = typeof force === 'boolean' ? force : !mapOpen; resetInput();
    $('map-panel').classList.toggle('hidden', !mapOpen); $('map-button').setAttribute('aria-pressed', String(mapOpen));
    if (mapOpen) { drawMap(); exitPointer(); } else requestPointer();
  }
  $('start-button').onclick = $('retry-button').onclick = startGame; $('pause-button').onclick = pauseGame; $('resume-button').onclick = resumeGame;
  $('quit-button').onclick = $('result-menu').onclick = returnMenu; $('map-button').onclick = () => toggleMap(); $('close-map').onclick = () => toggleMap(false); $('lamp-button').onclick = toggleLamp;

  // Keyboard, pointer-lock mouse, drag-to-look and simultaneous two-thumb touch input.
  addEventListener('keydown', e => {
    if (e.target.matches?.('input,select,textarea') || $('help-dialog').open || $('settings-dialog').open) return;
    if (state === 'playing' && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
    if (e.repeat) return;
    if (e.code === 'Escape' || e.code === 'KeyP') { if (state === 'playing') { if (mapOpen) toggleMap(false); else pauseGame(); } else if (state === 'paused') resumeGame(); return; }
    if (state !== 'playing') return;
    input.keys.add(e.code); if (e.code === 'KeyF') toggleLamp(); if (e.code === 'KeyM') toggleMap();
  });
  addEventListener('keyup', e => input.keys.delete(e.code));
  function look(dx, dy) { if (state !== 'playing') return; const factor = touch ? .004 : .0021; player.yaw = Math.atan2(Math.sin(player.yaw - dx * factor * settings.sensitivity), Math.cos(player.yaw - dx * factor * settings.sensitivity)); player.pitch = Math.max(-1.22, Math.min(1.18, player.pitch - dy * factor * settings.sensitivity)); }
  let mouseX = 0, mouseY = 0;
  $('world').addEventListener('pointerdown', e => { if (state !== 'playing' || e.pointerType === 'touch') return; input.mouseDown = true; mouseX = e.clientX; mouseY = e.clientY; requestPointer(); });
  addEventListener('pointermove', e => {
    if (e.pointerType === 'touch' || state !== 'playing') return;
    if (document.pointerLockElement === $('world')) look(e.movementX, e.movementY);
    else if (input.mouseDown) { look(e.clientX - mouseX, e.clientY - mouseY); mouseX = e.clientX; mouseY = e.clientY; }
  });
  addEventListener('pointerup', () => { input.mouseDown = false; });
  document.addEventListener('pointerlockchange', () => { if (!document.pointerLockElement && state === 'playing' && !touch && !mapOpen) pauseGame(); });
  let stickCenter = { x: 0, y: 0 }, lastLook = { x: 0, y: 0 }, stickWidth = 118;
  const stick = $('move-stick');
  function capturePointer(node, pointerId) { try { node.setPointerCapture(pointerId); } catch (_) { /* Synthetic tests and browsers without capture still receive local events. */ } }
  function updateStick(e) {
    const radius = stickWidth * .34, dx = e.clientX - stickCenter.x, dy = e.clientY - stickCenter.y, length = Math.hypot(dx, dy), ratio = length > radius ? radius / length : 1;
    input.moveX = length < radius * .12 ? 0 : dx * ratio / radius; input.moveY = length < radius * .12 ? 0 : -dy * ratio / radius;
    input.stickSprint = length > stickWidth * (input.stickSprint ? .45 : .53);
    stick.classList.toggle('sprinting', input.stickSprint); $('stick-knob').style.transform = `translate(${dx * ratio}px, ${dy * ratio}px)`;
  }
  stick.addEventListener('pointerdown', e => { if (state !== 'playing' || input.stickId !== null) return; e.preventDefault(); input.stickId = e.pointerId; capturePointer(stick, e.pointerId); const rect = stick.getBoundingClientRect(); stickWidth = rect.width; stickCenter = { x: rect.left + rect.width / 2, y: rect.top + rect.height / 2 }; updateStick(e); });
  stick.addEventListener('pointermove', e => { if (e.pointerId === input.stickId) { e.preventDefault(); updateStick(e); } });
  function releaseStick(e) { if (e.pointerId !== input.stickId) return; input.stickId = null; input.moveX = input.moveY = 0; input.stickSprint = false; stick.classList.remove('sprinting'); $('stick-knob').style.transform = ''; }
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) stick.addEventListener(type, releaseStick);
  const lookZone = $('look-zone');
  lookZone.addEventListener('pointerdown', e => { if (state !== 'playing' || input.lookId !== null) return; e.preventDefault(); input.lookId = e.pointerId; lastLook = { x: e.clientX, y: e.clientY }; capturePointer(lookZone, e.pointerId); $('look-tip').style.opacity = 0; });
  lookZone.addEventListener('pointermove', e => { if (e.pointerId !== input.lookId) return; e.preventDefault(); look(e.clientX - lastLook.x, e.clientY - lastLook.y); lastLook = { x: e.clientX, y: e.clientY }; });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) lookZone.addEventListener(type, e => { if (e.pointerId === input.lookId) input.lookId = null; });
  $('run-button').addEventListener('pointerdown', e => { if (state !== 'playing' || input.runId !== null) return; e.preventDefault(); input.runId = e.pointerId; capturePointer(e.currentTarget, e.pointerId); input.run = true; $('run-button').classList.add('active'); });
  for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) $('run-button').addEventListener(type, e => { if (e.pointerId !== input.runId) return; input.runId = null; input.run = false; $('run-button').classList.remove('active'); });
  addEventListener('blur', () => { resetInput(); if (state === 'playing') pauseGame(); });
  document.addEventListener('visibilitychange', () => { if (document.hidden) { resetInput(); if (state === 'playing') pauseGame(); audio.ctx?.suspend().catch(() => {}); } else if (settings.audio) audio.ctx?.resume().catch(() => {}); });
  addEventListener('resize', () => { if (!renderer) return; camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); resizeRenderer(); resetInput(); });
  document.addEventListener('contextmenu', e => { if (state === 'playing') e.preventDefault(); });
  document.addEventListener('pointerdown', () => { if (settings.audio && (state === 'playing' || state === 'menu')) audio.init(); }, { passive: true });
  addEventListener('pagehide', e => { if (state === 'playing') pauseGame(); if (!e.persisted) audio.dispose(); });
  addEventListener('pageshow', () => { lastTime = 0; renderDirty = true; });
  for (const dialog of [$('help-dialog'), $('settings-dialog')]) dialog.addEventListener('close', () => { renderDirty = true; lastTime = 0; });

  function canOccupy(x, z, radius = .38) {
    const minX = Math.floor((x - radius + HALF) / TILE), maxX = Math.floor((x + radius + HALF) / TILE), minY = Math.floor((-z - radius + HALF) / TILE), maxY = Math.floor((-z + radius + HALF) / TILE);
    for (let row = minY; row <= maxY; row++) for (let col = minX; col <= maxX; col++) { if (row < 0 || col < 0 || row >= SIZE || col >= SIZE || grid[row * SIZE + col]) return false; }
    return true;
  }
  function movePlayer(dt) {
    let mx = input.moveX + (input.keys.has('KeyD') || input.keys.has('ArrowRight') ? 1 : 0) - (input.keys.has('KeyA') || input.keys.has('ArrowLeft') ? 1 : 0);
    let my = input.moveY + (input.keys.has('KeyW') || input.keys.has('ArrowUp') ? 1 : 0) - (input.keys.has('KeyS') || input.keys.has('ArrowDown') ? 1 : 0);
    let length = Math.hypot(mx, my); if (length <= .1) { mx = my = 0; length = 0; } else if (length > 1) { mx /= length; my /= length; }
    const moving = length > .1, wantsRun = input.run || input.stickSprint || input.keys.has('ShiftLeft') || input.keys.has('ShiftRight');
    if (player.exhausted && player.stamina > 24) player.exhausted = false;
    player.running = moving && wantsRun && !player.exhausted && player.stamina > 0; const level = levels[difficulty];
    if (player.running) { player.stamina = Math.max(0, player.stamina - level.drain * dt); if (player.stamina === 0) { player.exhausted = true; toast('息が切れた。少し歩いて呼吸を整えて。', 2200); } } else player.stamina = Math.min(100, player.stamina + level.recovery * dt);
    const speed = (player.running ? 6.35 : 3.35) * dt;
    const dx = (Math.cos(player.yaw) * mx - Math.sin(player.yaw) * my) * speed;
    const dz = (-Math.sin(player.yaw) * mx - Math.cos(player.yaw) * my) * speed;
    const oldX = player.x, oldZ = player.z;
    if (canOccupy(player.x + dx, player.z)) player.x += dx;
    if (canOccupy(player.x, player.z + dz)) player.z += dz;
    player.moving = Math.hypot(player.x - oldX, player.z - oldZ) > .001;
    if (player.moving) { headBob += dt * (player.running ? 14 : 9); if (elapsed > nextFootstep) { audio.noise(.14, player.running ? .30 : .16, 460 + Math.random() * 200); nextFootstep = elapsed + (player.running ? .32 : .52); } }
    if (cellAt(player.x, player.z) !== lastCell) revealMap();
  }
  function revealMap() {
    lastCell = cellAt(player.x, player.z); if (lastCell < 0) return;
    const x = lastCell % SIZE, y = Math.floor(lastCell / SIZE);
    for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) { const col = x + dx, row = y + dy; if (col >= 0 && row >= 0 && col < SIZE && row < SIZE) visited[row * SIZE + col] = 1; }
    mapDirty = true;
    if (mapOpen) drawMap();
  }
  function hasLineOfSight(ax, az, bx, bz) { return navigation.lineClear(grid, ax, az, bx, bz); }
  function updateEnemies(dt) {
    const currentCell = cellAt(player.x, player.z);
    if (fieldCell !== currentCell) { distanceField = distances(currentCell, flowBuffer); fieldCell = currentCell; }
    let nearest = Infinity; const grace = levels[difficulty].grace;
    for (const e of enemies) {
      const distance = Math.hypot(player.x - e.x, player.z - e.z);
      if (elapsed > grace) {
        // Ghost reappears on a connected distant path, never directly on the player.
        if (e.type === 'ghost' && elapsed > e.blinkAt && distance > 15) {
          const pool = walkable.filter(idx => distanceField[idx] >= 10 && distanceField[idx] <= 15);
          if (pool.length) { e.cell = pool[Math.floor(Math.random() * pool.length)]; const p = position(e.cell); e.x = p.x; e.z = p.z; e.target = null; }
          e.blinkAt = elapsed + 40;
        }
        let tx, tz;
        if (distance < 13 && navigation.corridorClear(grid, e.x, e.z, player.x, player.z)) { tx = player.x; tz = player.z; e.target = null; }
        else {
          if (e.target === null) {
            // Return to cell center before turning so corners cannot trap the AI.
            const idx = cellAt(e.x, e.z), center = position(idx);
            if (Math.hypot(center.x - e.x, center.z - e.z) > .15) e.target = idx;
            else e.target = navigation.descend(grid, distanceField, idx);
          }
          const p = position(e.target); tx = p.x; tz = p.z;
        }
        const dx = tx - e.x, dz = tz - e.z, dist = Math.hypot(dx, dz), speed = e.baseSpeed * levels[difficulty].speed * (1 + collected * .014), step = Math.min(dist, speed * dt);
        if (dist > .01) {
          const nx = e.x + dx / dist * step, nz = e.z + dz / dist * step;
          if (canOccupy(nx, nz, .2)) { e.x = nx; e.z = nz; } else { e.target = cellAt(e.x, e.z); }
          if (dist < .12 || step >= dist) e.target = null;
        } else e.target = null;
      }
      e.group.position.set(e.x, e.baseY + Math.sin(elapsed * (e.type === 'face' ? 1.8 : 2.4) + e.offset) * (e.type === 'tall' ? .025 : .16), e.z);
      e.group.rotation.y = Math.atan2(player.x - e.x, player.z - e.z);
      e.group.visible = Math.hypot(player.x - e.x, player.z - e.z) < 62;
      if (e.type === 'face') e.group.rotation.z = Math.sin(elapsed * .8) * .075;
      const actualDistance = Math.hypot(player.x - e.x, player.z - e.z), los = actualDistance < 20 && hasLineOfSight(e.x, e.z, player.x, player.z);
      const perceived = los ? actualDistance : actualDistance + 11;
      if (perceived < nearest) nearest = perceived;
      if (elapsed > grace && actualDistance < (e.type === 'face' ? 1.18 : .92) && los) { capture(e); return; }
      if (elapsed > grace && perceived < 23 && elapsed > e.soundAt) {
        const pan = ((e.x - player.x) * Math.cos(player.yaw) - (e.z - player.z) * Math.sin(player.yaw)) / Math.max(actualDistance, .001);
        audio.tone(e.type === 'face' ? 51 : e.type === 'ghost' ? 630 : 110, .6, .05 * (1 - perceived / 25), e.type === 'ghost' ? 'sine' : 'triangle', e.type === 'ghost' ? 210 : 40, pan);
        e.soundAt = elapsed + 2.2 + Math.random() * 2;
      }
    }
    threat = elapsed < grace ? 0 : Math.max(0, Math.min(1, 1 - (nearest - 2) / 20));
    const opacity = Math.round((settings.reduced ? threat * .15 : threat * .52) * 100) / 100;
    if (opacity !== lastThreatOpacity) { $('danger-overlay').style.opacity = opacity; lastThreatOpacity = opacity; }
    setText('threat-text', threat > .72 ? '走れ。振り返るな。' : threat > .4 ? '足音が、近い。' : '');
    if (threat > .15 && elapsed > nextHeartbeat) { audio.tone(62, .15, .13 * threat, 'sine', 34); nextHeartbeat = elapsed + 1.05 - threat * .59; }
    const ambientLevel = Math.round((.14 + threat * .1) * 50) / 50;
    if (ambientLevel !== lastAudioLevel) { audio.setAmbient(ambientLevel); lastAudioLevel = ambientLevel; }
  }
  function collectPies(dt) {
    let nearby = false;
    for (const pie of pies) {
      if (pie.collected) continue;
      const distance = Math.hypot(player.x - pie.x, player.z - pie.z);
      pie.group.visible = distance < 58;
      if (pie.group.visible) { pie.pastry.rotation.y = elapsed * .3; pie.halo.material.opacity = .5 + Math.sin(elapsed * 2 + pie.number) * .14; }
      if (distance < 5 && hasLineOfSight(player.x, player.z, pie.x, pie.z)) nearby = true;
      if (distance < 1.5) {
        pie.collected = true; pie.group.visible = false; collected++; mapDirty = true;
        $('pie-count').innerHTML = `${collected} <span>/ 10</span>`; updateHud(); audio.tone(660, .45, .1); audio.tone(990, .65, .04); if (touch && !testRunning && navigator.vibrate && !settings.reduced && navigator.userActivation?.hasBeenActive) navigator.vibrate(30);
        if (collected === 10) { toast('10個の供物が揃った。北の鳥居へ。コンパスの矢印を追って。', 6500); $('objective-text').textContent = '北の鳥居へ脱出'; exitGroup.userData.beacon.material.opacity = .65; }
        else toast(`パイを見つけた。 ${collected} / 10${collected === 5 ? ' — 森が、ざわめいている。' : ''}`, 2700);
        if (mapOpen) drawMap();
      }
    }
    const exit = position(exitIndex), exitDistance = Math.hypot(player.x - exit.x, player.z - exit.z);
    const prompt = $('interact-prompt');
    if (exitDistance < 5) { setText('interact-prompt', collected === 10 ? '鳥居の下へ。もう、帰れる。' : `供物が足りない。あと ${10 - collected} 個。`); prompt.classList.remove('hidden'); }
    else { if (nearby) setText('interact-prompt', 'パイの甘い香りがする'); prompt.classList.toggle('hidden', !nearby); }
    if (collected === 10 && exitDistance < 2.1) finishGame(true);
  }
  function updateCamera(dt) {
    const bob = player.moving && !settings.reduced ? Math.sin(headBob) * (player.running ? .052 : .022) : 0;
    camera.position.set(player.x, 1.68 + bob, player.z); camera.rotation.set(player.pitch, player.yaw, !settings.reduced && player.running ? Math.sin(headBob / 2) * .008 : 0, 'YXZ');
    const targetFov = player.running && !settings.reduced ? 74 : 68;
    if (Math.abs(camera.fov - targetFov) > .02) { camera.fov += (targetFov - camera.fov) * Math.min(dt * 5, 1); camera.updateProjectionMatrix(); }
    flashlight.intensity = lampOn ? 48 : 0;
    const sway = settings.reduced ? 0 : Math.sin(headBob*.5) * (player.moving ? .025 : .006);
    handheld.position.x = .27 + sway; handheld.position.y = -.3 - Math.abs(sway)*.4;
    handheld.rotation.z = -.15 + sway;
    lightTarget.position.x = THREE.MathUtils.lerp(lightTarget.position.x, sway*8, Math.min(dt*7,1));
    lightTarget.position.y = THREE.MathUtils.lerp(lightTarget.position.y, -.12+bob*3, Math.min(dt*7,1));
  }
  function formatTime(seconds) { return `${String(Math.floor(seconds / 60)).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`; }
  function updateHud() {
    $('offering-progress').style.setProperty('--collected', collected);
    $('offering-progress').setAttribute('aria-valuenow', collected);
    $('stamina-meter').setAttribute('aria-valuenow', Math.ceil(player.stamina));
    $('chapter-intro').classList.toggle('hidden', elapsed > 5 || threat > .2);
    setText('forest-state', threat > .4 ? '気配が近づいている' : elapsed < levels[difficulty].grace ? 'まだ、静かだ' : '森は、目を覚ました');
    $('forest-state').classList.toggle('alert', threat > .4);
    $('stamina-fill').style.transform = `scaleX(${(player.stamina / 100).toFixed(3)})`; $('stamina-fill').style.background = player.exhausted ? '#c09570' : 'var(--mint)'; setText('stamina-value', Math.ceil(player.stamina)); setText('game-time', formatTime(elapsed));
    const bearing = ((-player.yaw * 180 / Math.PI) % 360 + 360) % 360;
    setText('compass-heading', ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'][Math.round(bearing / 45) % 8]);
    if (collected === 10) { const exit = position(exitIndex), angle = Math.atan2(exit.x - player.x, -(exit.z - player.z)) + player.yaw; const diff = Math.atan2(Math.sin(angle), Math.cos(angle)); $('compass-bearing').textContent = `${Math.abs(diff) < .3 ? '↑' : diff > 0 ? '→' : '←'} 鳥居 ${Math.round(Math.hypot(exit.x - player.x, exit.z - player.z))}m`; }
    else setText('compass-bearing', `${String(Math.round(bearing) % 360).padStart(3, '0')}°`);
    if (mapOpen) drawMap();
  }
  function drawMap() {
    const canvas = $('map-canvas'), ctx = canvas.getContext('2d'), s = canvas.width / SIZE;
    if (mapDirty) {
      const base = mapCache.getContext('2d'); base.fillStyle = '#08110c'; base.fillRect(0, 0, mapCache.width, mapCache.height);
      for (let i = 0; i < total; i++) { if (!visited[i]) continue; base.fillStyle = grid[i] ? '#24392b' : '#60715a'; base.fillRect(i % SIZE * s + .5, Math.floor(i / SIZE) * s + .5, s - 1, s - 1); }
      for (const p of pies) { if (p.collected || !visited[p.index]) continue; base.fillStyle = '#efbc66'; base.beginPath(); base.arc(p.index % SIZE * s + s / 2, Math.floor(p.index / SIZE) * s + s / 2, s * .25, 0, Math.PI * 2); base.fill(); }
      mapDirty = false;
    }
    ctx.drawImage(mapCache, 0, 0);
    const ep = position(exitIndex), ex = (ep.x / TILE + .5) * s, ey = (-ep.z / TILE + .5) * s;
    ctx.strokeStyle = '#83d4bc'; ctx.lineWidth = 2; ctx.strokeRect(ex - 5, ey - 5, 10, 10);
    const x = (player.x / TILE + .5) * s, y = (-player.z / TILE + .5) * s;
    ctx.save(); ctx.translate(x, y); ctx.rotate(-player.yaw); ctx.fillStyle = '#e3f2d3'; ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(5.5, 6); ctx.lineTo(0, 3); ctx.lineTo(-5.5, 6); ctx.closePath(); ctx.fill(); ctx.restore();
  }
  function tick(dt) {
    if (state !== 'playing') return;
    elapsed += dt; movePlayer(dt); updateEnemies(dt);
    if (state !== 'playing') return;
    collectPies(dt);
    if (toastRemaining > 0) { toastRemaining -= dt; if (toastRemaining <= 0) $('toast').classList.remove('visible'); }
    if (elapsed >= levels[difficulty].grace && elapsed - dt < levels[difficulty].grace) toast('森の奥で、何かが目を覚ました。', 3400);
  }
  function animate(time) {
    requestAnimationFrame(animate);
    if (document.hidden || !gpuReady) { lastTime = 0; return; }
    const modalOpen = $('help-dialog').open || $('settings-dialog').open;
    const active = state === 'playing' || state === 'caught' || (state === 'menu' && !modalOpen && !settings.reduced);
    if (!active && !renderDirty) { lastTime = 0; return; }
    const interval = 1000 / (state === 'menu' ? 30 : settings.fps);
    if (!renderDirty && time - lastRenderTime < interval - .8) return;
    const seconds = lastTime ? Math.max(0, (time - lastTime) / 1000) : 0;
    lastTime = time; lastRenderTime = renderDirty ? time : time - ((time - lastRenderTime) % interval); frameCount++; renderDirty = false;
    const dt = Math.min(seconds, .1);
    if (state === 'menu') {
      const t = settings.reduced ? 0 : time * .00015; camera.position.set(318.2 + Math.sin(t) * .18, 2.15, 18); camera.lookAt(319.2 + Math.sin(t * .5) * .25, 3.6, -10); flashlight.intensity = 9;
      menuGroup.userData.face.position.y = 3.5 + (settings.reduced ? 0 : Math.sin(time * .0007) * .15);
    } else if (state === 'playing') {
      samplePerformance(seconds); stepper.advance(seconds, tick);
      if (state === 'playing') updateCamera(dt);
      hudTimer -= dt; if (hudTimer <= 0) { updateHud(); hudTimer = .1; }
    } else if (state === 'caught') {
      catchTime += dt; $('flash-overlay').style.opacity = Math.max(0, .12 - catchTime * .24); if (catchTime > .85) finishGame(false);
    }
    if (active && !settings.reduced) presentationTime += dt;
    windUniform.value = presentationTime * .6; atmosphereTime.value = presentationTime;
    handheld.visible = state === 'playing' || state === 'paused';
    atmosphere.position.set(camera.position.x, 0, camera.position.z); atmosphere.rotation.y = settings.reduced ? 0 : presentationTime * .009;
    for (let i = 0; i < groundMist.children.length; i++) {
      const mist = groundMist.children[i], offset = mist.userData.offset;
      mist.position.set(camera.position.x + ((offset.x + presentationTime*.25 + 45) % 90)-45,offset.y,camera.position.z + offset.z);
    }
    if (state === 'playing' || state === 'caught') { visualTimer -= dt; if (visualTimer <= 0) { ForestEngine.updateChunks(worldChunks, camera.position.x, camera.position.z, {low:42,medium:54,high:64}[settings.quality]); visualTimer = .15; } }
    renderer.render(scene, camera);
  }

  // Optional, read-only diagnostics plus deterministic browser self-tests (?selftest=1).
  window.HollowWoods = {
    get diagnostics() { return { state, seed: mazeSeed, collected, enemies: enemies.length, walkable: walkable.length, elapsed: Math.round(elapsed), drawCalls: renderer?.info.render.calls, triangles: renderer?.info.render.triangles, geometries: renderer?.info.memory.geometries, textures: renderer?.info.memory.textures, renderedFrames: frameCount, measuredFPS, pixelRatio: renderer?.getPixelRatio(), resolutionScale: adaptiveScale, pathfieldBuilds: navigation.builds, activeAudioVoices: audio.voices.size, simulationDroppedSeconds: stepper.droppedSeconds, touch }; },
    benchmark() {
      testRunning = true;
      startGame();
      const samples = [];
      for (const cell of [walkable[0], walkable[Math.floor(walkable.length / 3)], walkable[Math.floor(walkable.length * 2 / 3)], exitIndex]) {
        const p = position(cell); player.x = p.x; player.z = p.z;
        for (const pie of pies) pie.group.visible = Math.hypot(pie.x - p.x, pie.z - p.z) < 58;
        for (const enemy of enemies) enemy.group.visible = Math.hypot(enemy.x - p.x, enemy.z - p.z) < 62;
        for (const yaw of [0, Math.PI * 2 / 3, Math.PI * 4 / 3]) {
          player.yaw = yaw; updateCamera(0); ForestEngine.updateChunks(worldChunks, player.x, player.z, {low:42,medium:54,high:64}[settings.quality]); renderer.render(scene, camera);
          samples.push({ calls: renderer.info.render.calls, triangles: renderer.info.render.triangles });
        }
      }
      const result = { seed: mazeSeed, samples: samples.length, meanDrawCalls: Math.round(samples.reduce((n, s) => n + s.calls, 0) / samples.length), meanTriangles: Math.round(samples.reduce((n, s) => n + s.triangles, 0) / samples.length), maxTriangles: Math.max(...samples.map(s => s.triangles)), geometries: renderer.info.memory.geometries, textures: renderer.info.memory.textures };
      console.info('[Hollow Woods] BENCHMARK', JSON.stringify(result));
      returnMenu(); testRunning = false; document.body.dataset.benchmark = 'complete'; window.HollowWoods.lastBenchmark = result; return result;
    },
    selfTest() {
      testRunning = true;
      const checks = [];
      function check(name, value) { checks.push({ name, passed: !!value }); if (!value) throw new Error(`Self-test failed: ${name}`); }
      const fpsResults = [20, 30, 60, 120].map(fps => { const clock = new ForestEngine.FixedStepper(); let seconds = 0; for (let i = 0; i < fps * 2; i++) clock.advance(1 / fps, dt => { seconds += dt; }); return seconds; });
      check('simulation speed identical at 20/30/60/120 FPS', fpsResults.every(s => Math.abs(s - 2) < 1e-8));
      const stallClock = new ForestEngine.FixedStepper(); let stallSteps = 0; stallClock.advance(10, () => stallSteps++); check('long stalls bounded to six simulation steps', stallSteps === 6 && stallClock.droppedSeconds > 9);
      const invalid = validatedSettings({ brightness: Infinity, sensitivity: -50, quality: 'invalid', fps: 5, audio: 'yes' });
      check('corrupt settings cannot break rendering', invalid.brightness === defaults.brightness && invalid.sensitivity === .4 && invalid.quality === defaults.quality && invalid.fps === 60 && invalid.audio === false);
      const nav = new ForestEngine.GridNavigation(5, 6), fixture = new Uint8Array(25); fixture.fill(1);
      for (let row = 1; row <= 3; row++) for (let col = 1; col <= 3; col++) fixture[row * 5 + col] = 0;
      check('DDA accepts open corridors', nav.lineClear(fixture, 6, -6, 18, -18));
      fixture[7] = 1; check('DDA blocks diagonal corner cuts', !nav.lineClear(fixture, 6, -6, 12, -12));
      fixture[7] = 0; fixture[12] = 1; check('DDA blocks obstructed lines both ways', !nav.lineClear(fixture, 6, -12, 18, -12) && !nav.lineClear(fixture, 18, -12, 6, -12));
      check('invalid pathfinding origins rejected', nav.distances(fixture, -1).every(v => v === -1));
      for (let seed = 1; seed <= 100; seed++) { buildMaze(seed * 8191); const field = distances(SIZE + 1); if (walkable.some(i => field[i] < 0) || field[exitIndex] < 0) throw new Error(`Unreachable maze: ${seed}`); }
      check('100 seeded mazes fully connected', true);
      buildWorld(); const d = distances(SIZE + 1);
      check('all paths connected', walkable.every(i => d[i] >= 0)); check('ten unique reachable pies', new Set(pies.map(p => p.index)).size === 10 && pies.every(p => d[p.index] > 0)); check('exit reachable', d[exitIndex] > 0); check('three distinct hunters', new Set(enemies.map(e => e.type)).size === 3); check('spawn has room', canOccupy(TILE, -TILE)); check('outer forest blocks movement', !canOccupy(0, 0));
      startGame(); const emptyExit = position(exitIndex); player.x = emptyExit.x; player.z = emptyExit.z; collectPies(0); check('exit rejects incomplete offerings', state === 'playing' && collected === 0); player.x = TILE; player.z = -TILE;
      const x = player.x, z = player.z;
      input.moveX = .04; input.moveY = .04; movePlayer(.05); check('joystick deadzone prevents drift', player.x === x && player.z === z); resetInput();
      document.body.dispatchEvent(new KeyboardEvent('keydown', { code: 'KeyW', bubbles: true })); movePlayer(.05); document.body.dispatchEvent(new KeyboardEvent('keyup', { code: 'KeyW', bubbles: true })); check('keyboard events move and release', Math.hypot(player.x - x, player.z - z) > 0 && !input.keys.has('KeyW'));
      const yawBefore = player.yaw; look(20, 0); check('look input changes view', player.yaw !== yawBefore); player.yaw = yawBefore;
      if (touch) {
        const rect = stick.getBoundingClientRect(), cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
        const pointer = (type, id, px, py) => new PointerEvent(type, { pointerId: id, pointerType: 'touch', clientX: px, clientY: py, bubbles: true, cancelable: true });
        stick.dispatchEvent(pointer('pointerdown', 101, cx, cy)); stick.dispatchEvent(pointer('pointermove', 101, cx, cy - rect.width * .8));
        check('outer-ring sprint supports two-thumb control', input.moveY > .9 && input.stickSprint);
        const lx = innerWidth * .7, ly = innerHeight * .48;
        check('mobile look region receives hit tests', document.elementFromPoint(lx, ly) === lookZone);
        lookZone.dispatchEvent(pointer('pointerdown', 102, lx, ly)); lookZone.dispatchEvent(pointer('pointermove', 102, lx + 35, ly));
        check('simultaneous movement and look remain independent', input.stickId === 101 && input.lookId === 102 && input.moveY > .9 && player.yaw !== yawBefore);
        lookZone.dispatchEvent(pointer('pointercancel', 102, lx, ly)); check('look cancel does not cancel movement', input.lookId === null && input.moveY > .9);
        stick.dispatchEvent(pointer('pointercancel', 101, cx, cy)); check('touch cancel clears movement and sprint', input.moveX === 0 && input.moveY === 0 && !input.stickSprint);
        const b = $('pause-button').getBoundingClientRect(); check('mobile pause button is unobstructed', document.elementFromPoint(b.left + b.width / 2, b.top + b.height / 2) === $('pause-button'));
      }
      resetInput(); player.yaw = yawBefore;
      const firstPie = pies[0]; player.x = firstPie.x; player.z = firstPie.z; collectPies(0); check('pie collected exactly once', collected === 1 && firstPie.collected); collectPies(0); check('no duplicate collection', collected === 1);
      player.stamina = 100; input.keys.add('KeyW'); input.run = true; movePlayer(.05); check('sprint drains stamina', player.stamina < 100); input.run = false; input.keys.clear(); const stamina = player.stamina; movePlayer(.05); check('walking recovers stamina', player.stamina > stamina);
      const oldLamp = lampOn; toggleLamp(); check('flashlight toggles', lampOn !== oldLamp); toggleMap(true); check('map opens', mapOpen && !$('map-panel').classList.contains('hidden')); toggleMap(false);
      elapsed = 50; distanceField = distances(cellAt(player.x, player.z)); const e = enemies[0], before = { x: e.x, z: e.z }; updateEnemies(.1); check('hunters advance', Math.hypot(e.x - before.x, e.z - before.z) > 0);
      pauseGame(); check('pause state', state === 'paused'); const frozenTime = elapsed, frozenToast = toastRemaining; tick(1); check('pause freezes simulation and toast lifetime', elapsed === frozenTime && toastRemaining === frozenToast); resumeGame(); check('resume state', state === 'playing' && lastTime === 0);
      elapsed = 0; fieldCell = -1; updateEnemies(.01); const fieldsBefore = navigation.builds; for (let i = 0; i < 120; i++) updateEnemies(1 / 60); check('stationary player reuses one navigation field', navigation.builds === fieldsBefore);
      player.stamina = .01; input.run = true; input.keys.add('KeyW'); movePlayer(.05); check('empty stamina triggers exhaustion', player.exhausted && player.stamina === 0); resetInput(); player.stamina = 25; movePlayer(.05); check('stamina recovery clears exhaustion', !player.exhausted);
      const originalPosition = { x: player.x, z: player.z }; const far = distances(cellAt(player.x, player.z)); const farCell = walkable.find(i => far[i] >= 28 && far[i] < 35); const fp = position(farCell);
      for (const enemy of enemies) { enemy.x = fp.x; enemy.z = fp.z; enemy.target = null; enemy.blinkAt = Infinity; }
      const startDepth = far[farCell]; elapsed = 50; let validHunters = true;
      for (let i = 0; i < 600; i++) { updateEnemies(1 / 60); for (const enemy of enemies) if (!canOccupy(enemy.x, enemy.z, .19)) validHunters = false; }
      check('hunters remain inside corridors during sustained pursuit', validHunters && state === 'playing');
      check('all hunters make multi-cell navigation progress', enemies.every(enemy => far[cellAt(enemy.x, enemy.z)] < startDepth));
      check('AI does not move the player', player.x === originalPosition.x && player.z === originalPosition.z);
      for (const pie of pies) if (!pie.collected) { player.x = pie.x; player.z = pie.z; collectPies(0); }
      check('all ten counted', collected === 10); const exit = position(exitIndex); player.x = exit.x; player.z = exit.z; collectPies(0); check('exit wins only after collection', state === 'won');
      startGame(); const hunter = enemies[0]; elapsed = 50; player.x = hunter.x; player.z = hunter.z; updateEnemies(.01); check('contact causes capture', state === 'caught' || state === 'lost'); finishGame(false); check('loss screen', state === 'lost');
      const owned = new Set(); worldGroup.traverse(obj => { if (obj.userData.ownedGeometry) owned.add(obj.geometry); }); let disposed = 0;
      for (const geometry of owned) geometry.addEventListener('dispose', () => disposed++);
      returnMenu(); check('return to title disposes all owned world geometry', disposed === owned.size && worldGroup === null && worldChunks.length === 0 && enemies.length === 0);
      for (let cycle = 0; cycle < 3; cycle++) { startGame(); const geometriesToRelease = new Set(); worldGroup.traverse(obj => { if (obj.userData.ownedGeometry) geometriesToRelease.add(obj.geometry); }); let released = 0; for (const geometry of geometriesToRelease) geometry.addEventListener('dispose', () => released++); renderer.render(scene, camera); returnMenu(); check(`restart ${cycle + 1} releases generated buffers`, released === geometriesToRelease.size); }
      testRunning = false; document.body.dataset.selftest = 'passed'; window.HollowWoods.lastTests = checks;
      console.info('[Hollow Woods] SELF TEST PASS', `${checks.length} checks; mobile=${touch}`);
      for (const check of checks) console.info('[PASS]', check.name);
      const report = document.createElement('output'); report.id = 'test-report'; report.textContent = `SELF TEST PASS — ${checks.length} checks — ${touch ? 'MOBILE' : 'DESKTOP'}`; report.style.cssText = 'position:fixed;left:50%;top:86px;transform:translateX(-50%);z-index:70;background:#152e20;color:#d7edbd;border:1px solid #9bbc8c;padding:12px;font:11px monospace;white-space:nowrap'; $('test-report')?.remove(); elements.delete('test-report'); document.body.append(report);
      return checks;
    }
  };
  try {
    init3D();
    if (params.get('benchmark') === '1') setTimeout(() => window.HollowWoods.benchmark(), 500);
    if (params.get('play') === '1') startGame();
    if (params.get('selftest') === '1') setTimeout(() => { try { window.HollowWoods.selfTest(); } catch (e) { testRunning = false; document.body.dataset.selftest = 'failed'; console.error(e); showError(`自動診断に失敗しました: ${e.message}`); } }, 500);
  } catch (error) { console.error(error); showError(error.message || 'このブラウザーでは3D描画を開始できませんでした。'); }
})();
