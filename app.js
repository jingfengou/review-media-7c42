import * as THREE from 'three';
import { OrbitControls } from './vendor/OrbitControls.js';

const $ = (s, root = document) => root.querySelector(s);
const $$ = (s, root = document) => [...root.querySelectorAll(s)];
const escape = (s = '') => String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const icons = () => window.lucide?.createIcons();
let data;
let currentScene;
let phaseFilter = 'all';
let search = '';
let pointViewer;
let pointChoices;
let pointLoad = 0;
let playingPoints = false;
let pointFrame = 0;
let lastPointTime = 0;
let playbackEnabled = true;
let playerObserver;
let inViewport = new Set();
let heldVideos = new WeakSet();
let playbackIntent = new WeakMap();
const dialog = $('#trajectory-dialog');
const phaseNames = {solid:'Solid',gas:'Gas',interaction:'Solid + gas'};

function button(icon, title, attrs = '') {
  return `<button class="icon-button" title="${title}" aria-label="${title}" ${attrs}><i data-lucide="${icon}"></i></button>`;
}
function videoCard(v, name, {ours = false, trajectory = '', sub = ''} = {}) {
  return `<figure class="video-cell">
    <figcaption class="video-caption"><span class="method-name ${ours ? 'ours' : ''}">${escape(name)}</span><span class="video-spec">${v.frames} frames / ${Number(v.fps.toFixed(2))} fps</span></figcaption>
    <video controls muted loop playsinline preload="none" poster="${v.poster}" data-src="${v.src}" aria-label="${escape(name)} video"></video>
    <div class="video-footer"><span>${escape(sub)}</span><span>${trajectory ? `<a href="#" data-point="${trajectory}">Point cloud</a> &nbsp; ` : ''}<a href="${v.src}" download>MP4</a></span></div>
  </figure>`;
}
function playerBar() {
  return `<div class="toolbar" role="group" aria-label="Group video controls">
    ${button('play','Play videos','data-play-all')}
    ${button('pause','Pause videos','data-pause-all')}
    ${button('rotate-ccw','Restart visible videos','data-restart-all')}
    <span class="toolbar-label">Displayed clips</span>
    <input type="range" min="0" max="1000" value="0" step="1" aria-label="Clip progress" data-video-progress>
    <output class="progress-label">0%</output>
  </div>`;
}
function visibleVideos() {
  return $$('#app video').filter(v => {
    const r = v.getBoundingClientRect();
    return v.getClientRects().length && r.bottom > 0 && r.top < innerHeight &&
      r.right > 0 && r.left < innerWidth;
  });
}
function loadVideo(v) {
  if (!v.hasAttribute('src')) v.src = v.dataset.src;
}
function pauseVideo(v) {
  playbackIntent.set(v, false);
  v.autoplay = false;
  v.pause();
}
function syncPlayback() {
  $$('#app video').forEach(v => {
    const shouldPlay = playbackEnabled && inViewport.has(v) && v.getClientRects().length &&
      !document.hidden && !dialog.open && !heldVideos.has(v);
    if (!shouldPlay) { pauseVideo(v); return; }
    loadVideo(v);
    v.autoplay = true;
    playbackIntent.set(v, true);
    if (v.paused) v.play().catch(() => {});
  });
}
function bindPlayers() {
  const videos = $$('#app video');
  inViewport = new Set();
  heldVideos = new WeakSet();
  playbackIntent = new WeakMap();
  playerObserver = new IntersectionObserver(entries => {
    entries.forEach(({target, isIntersecting}) => {
      if (isIntersecting) inViewport.add(target);
      else inViewport.delete(target);
    });
    syncPlayback();
  });
  videos.forEach(v => {
    v.muted = true;
    v.defaultMuted = true;
    v.addEventListener('pause', () => {
      if (playbackIntent.get(v)) {
        heldVideos.add(v);
        playbackIntent.set(v, false);
        v.autoplay = false;
      }
    });
    v.addEventListener('play', () => heldVideos.delete(v));
    v.addEventListener('timeupdate', () => {
      if (v !== visibleVideos()[0] || !Number.isFinite(v.duration) || v.paused) return;
      const f = v.currentTime / v.duration;
      $$('[data-video-progress]').forEach(x => x.value = f * 1000);
      $$('.progress-label').forEach(x => x.textContent = `${Math.round(f * 100)}%`);
    });
    playerObserver.observe(v);
  });
  $$('#app details').forEach(d => d.addEventListener('toggle', () => {
    if (!d.open) $$('video', d).forEach(pauseVideo);
    syncPlayback();
  }));
  $$('[data-play-all]').forEach(b => b.onclick = () => {
    playbackEnabled = true;
    heldVideos = new WeakSet();
    syncPlayback();
  });
  $$('[data-pause-all]').forEach(b => b.onclick = () => {
    playbackEnabled = false;
    videos.forEach(pauseVideo);
  });
  $$('[data-restart-all]').forEach(b => b.onclick = () => {
    playbackEnabled = true;
    heldVideos = new WeakSet();
    visibleVideos().forEach(v => { loadVideo(v); v.currentTime = 0; });
    syncPlayback();
  });
  $$('[data-video-progress]').forEach(slider => slider.oninput = () => {
    playbackEnabled = false;
    videos.forEach(pauseVideo);
    const progress = Number(slider.value) / 1000;
    visibleVideos().forEach(v => {
      loadVideo(v);
      const seek = () => { if (Number.isFinite(v.duration)) v.currentTime = progress * Math.max(0, v.duration - 1/60); };
      if (v.readyState) seek(); else { v.addEventListener('loadedmetadata', seek, {once:true}); v.load(); }
    });
    $$('.progress-label').forEach(x => x.textContent = `${Math.round(progress * 100)}%`);
  });
  videos.forEach(v => v.addEventListener('error', () => {
    if (!$('.video-error', v.parentElement)) {
      const p = document.createElement('p');
      p.className = 'video-error'; p.textContent = 'Video could not load. Use the MP4 link to open the file.';
      v.after(p);
    }
  }));
  $$('[data-point]').forEach(a => a.onclick = e => {
    e.preventDefault();
    const [collection, sid, method = 'mpact'] = a.dataset.point.split(':');
    if (collection === 'paper') {
      const s = data.scenes.find(x => x.id === sid);
      openPoints(s.name, 'Original paper prediction', s.trajectories, method);
    } else {
      const s = data.external.find(x => x.id === sid);
      openPoints(s.name, 'Additional Physics-IQ experiment', {pavg:s.trajectory}, 'pavg');
    }
  });
  icons();
}
function filteredScenes() {
  const q = search.trim().toLowerCase();
  return data.scenes.filter(s => (phaseFilter === 'all' || s.phase === phaseFilter) &&
    `${s.id} ${s.name}`.toLowerCase().includes(q));
}
function updateList() {
  const scenes = filteredScenes();
  $('#scene-list').innerHTML = scenes.length ? scenes.map(s =>
    `<a class="scene-link ${s.id === currentScene.id ? 'active' : ''}" href="#paper/${s.id}" ${s.id === currentScene.id ? 'aria-current="true"' : ''}><img src="${s.image}" alt="" loading="lazy"><span class="scene-name">${escape(s.name)}<small>${s.id}</small></span></a>`).join('') : '<p class="empty">No matching scenes.</p>';
  $('#scene-count').textContent = `${scenes.length} / 32`;
  $('#mobile-scene').innerHTML = scenes.map(s => `<option value="${s.id}" ${s.id === currentScene.id ? 'selected' : ''}>${escape(s.name)} (${s.id})</option>`).join('');
  if (!scenes.some(s => s.id === currentScene.id)) $('#mobile-scene').selectedIndex = -1;
}
function paperPage(id) {
  currentScene = data.scenes.find(s => s.id === id) || data.scenes[0];
  const s = currentScene;
  const index = data.scenes.indexOf(s);
  $('#app').innerHTML = `<div class="layout">
    <aside class="sidebar" aria-label="Scene selection">
      <div class="side-head"><span>Scenes</span><span id="scene-count"></span></div>
      <div class="filters"><input id="scene-search" type="search" aria-label="Search scenes" placeholder="Search scenes" value="${escape(search)}">
        <select id="phase-filter" aria-label="Phase category"><option value="all">All phases (32)</option><option value="gas">Gas (8)</option><option value="solid">Solid (8)</option><option value="interaction">Solid + gas (16)</option></select>
        <select class="mobile-scene" id="mobile-scene" aria-label="Select scene"></select>
      </div><div id="scene-list" class="scene-list"></div>
    </aside>
    <main id="main" class="main">
      <div class="topline"><span class="eyebrow">Original paper / ${phaseNames[s.phase]}</span>
        <div class="scene-pagination"><span>${index + 1} / 32</span>${button('chevron-left','Previous scene',`data-step="-1" ${index === 0 ? 'disabled' : ''}`)}${button('chevron-right','Next scene',`data-step="1" ${index === 31 ? 'disabled' : ''}`)}</div></div>
      <h1>${escape(s.name)}</h1>
      <div class="scene-overview">
        <div><img class="input-image" src="${s.image}" alt="Initial image for ${escape(s.name)}"><div class="input-caption">Initial image / ${s.id}</div></div>
        <div class="scene-context"><p>11 methods. Videos from the frozen original-paper comparison set.</p>
          <div class="actions"><a class="action" href="#" data-point="paper:${s.id}:mpact"><i data-lucide="box"></i>PAVG point cloud</a><a class="action" href="#" data-point="paper:${s.id}:physctrl_stage1"><i data-lucide="box"></i>PhysCtrl point cloud</a></div>
          <details><summary>Input conditions and generation prompt</summary><p>${escape(s.condition)}</p><p>${escape(s.prompt)}</p></details>
        </div>
      </div>
      <div class="notice">These are the original comparison videos, with their native frame rates. PAVG and PhysCtrl have saved 3D predictions. The other nine methods do not have corresponding saved 3D trajectories in this release. <a href="#protocol">Comparison protocol</a></div>
      ${playerBar()}
      <div class="video-grid">${data.methods.map(m => videoCard(s.videos[m.id], m.name, {ours:m.id==='mpact',trajectory:s.trajectories[m.id]?`paper:${s.id}:${m.id}`:'',sub:m.id==='mpact'?'Ours':''})).join('')}</div>
    </main></div>`;
  $('#phase-filter').value = phaseFilter;
  $('#phase-filter').onchange = e => { phaseFilter = e.target.value; updateList(); };
  $('#scene-search').oninput = e => { search = e.target.value; updateList(); };
  $('#mobile-scene').onchange = e => { location.hash = `paper/${e.target.value}`; };
  $$('[data-step]').forEach(b => b.onclick = () => { location.hash = `paper/${data.scenes[index + Number(b.dataset.step)].id}`; });
  updateList();
}
function failurePage() {
  const scene = id => data.scenes.find(x => x.id === id);
  const card = (id, sub) => videoCard(scene(id).videos.mpact, scene(id).name, {ours:true,trajectory:`paper:${id}:mpact`,sub});
  const metric = data.failureMetric;
  $('#app').innerHTML = `<main id="main" class="page">
    <span class="eyebrow">Failure cases / scope of applicability</span>
    <h1>Where the trajectory and video stages fall short</h1>
    <p class="lede">Failure observations are separated from successful examples. Original-paper outputs appear below; additional controlled diagnostics are labeled separately. Geometric diagnostics are not ground-truth physical errors.</p>
    <section class="failure-section">
      <span class="eyebrow">Original paper output / trajectory stage</span>
      <h2>Rigid shape is not a hard constraint</h2>
      <div class="failure-intro"><div class="failure-copy">
        <p>The tennis ball's predicted solid point cloud deforms before video synthesis. This separates a trajectory failure from a rendering artifact. The point viewer exposes the same saved initial state and 24 future keyframes used by the original-paper run.</p>
        <p class="metric">Final rigid-fit residual / initial RMS radius: <strong>${metric.normalizedRigidResidual.toFixed(3)}</strong>. Shortest principal-axis ratio: <strong>${metric.shortAxisRatio.toFixed(3)}</strong>.</p>
        <p>Rigid alignment removes rotation and translation only. No shape correction or scale fitting is applied. These values quantify shape change; they are not errors against a simulated reference trajectory.</p>
        <a class="action" href="#" data-point="paper:scene03a:mpact"><i data-lucide="box"></i>Inspect original point cloud</a>
      </div><div>${card('scene03a','Original paper')}</div></div>
    </section>
    <section class="failure-section">
      <span class="eyebrow">Original paper outputs / video stage</span><h2>Visibility, texture artifacts, and framing</h2>
      <div class="video-grid">${card('sandbag_drop','Banded dust texture')}${card('scene05c','Faint steam / haze')}${card('scene07c','Late motion near image boundary')}</div>
      <div class="failure-row"><div><h3>Dust appearance</h3><p>Banded plume textures can appear even with smooth point trajectories. Image realism and trajectory accuracy need separate assessment.</p></div><div><h3>Weak visible motion</h3><p>Thin, transparent gas may remain faint or show little visible motion. The lack of image change does not establish a stationary physical flow.</p></div><div><h3>Limited field of view</h3><p>Objects or gas can approach the image boundary. Occlusion and visibility limit what can be judged from a single generated view.</p></div></div>
    </section>
    <section class="failure-section">
      <span class="eyebrow added">Additional diagnostic / not part of the 352-video cohort</span>
      <h2>Gas control can produce little visible response</h2>
      <p class="failure-copy">The same image, prompt, and random seed are retained while the gas control is predicted, frozen, or doubled. In this diagnostic, the mean adjacent-frame flow in the dust region is approximately 0.0175, 0.0170, and 0.9933 pixels/frame, respectively. Optical flow measures texture change, not material-particle motion.</p>
      ${playerBar()}<div class="video-grid">${data.diagnostics.map(d=>videoCard(d.video,d.name,{sub:'Additional controlled diagnostic'})).join('')}</div>
      <details><summary>Corresponding 2D trajectory controls</summary><div class="video-grid">${data.diagnostics.map(d=>videoCard(d.control,`${d.name}: 2D control`,{sub:'Control visualization, not generated video'})).join('')}</div></details>
    </section>
    <section class="failure-section"><h2>Current scope</h2>
      <p class="failure-copy">The evidence concerns short-horizon trajectories for existing particles, given phase regions and physical conditions, with predominantly solid-to-gas influence. It does not establish long-rollout stability, strict conservation, strong gas-to-solid feedback, liquid free surfaces, combustion, or continued creation of smoke particles.</p>
      <p class="failure-copy">The <a href="#physicsiq/physiq_0140">additional Physics-IQ smoke example</a> tests some of these boundaries: faint or nearly static predicted smoke, despite ongoing smoke production in the held-out reference.</p>
    </section></main>`;
}
function externalPage(id) {
  const s = data.external.find(x => x.id === id) || data.external[0];
  $('#app').innerHTML = `<main id="main" class="page">
    <span class="eyebrow added">Added during rebuttal / external qualitative test</span>
    <h1>Physics-IQ: paper smoke</h1>
    <p class="lede">One physical event, three camera views, three generation methods. The held-out reference is shown for inspection. This is a boundary test, not an official Physics-IQ benchmark score.</p>
    <div class="benchmark-tabs" aria-label="Camera view">${data.external.map(x=>`<a class="${x.id===s.id?'active':''}" href="#physicsiq/${x.id}" ${x.id===s.id?'aria-current="true"':''}>${x.view} / ${x.id.replace('physiq_','')}</a>`).join('')}</div>
    <div class="scene-overview"><div><img class="input-image" src="${s.image}" alt="${s.view} view initial image"><div class="input-caption">Initial image / ${s.id}</div></div>
      <div class="scene-context"><p>Fixed interval: 0-2 seconds, sampled at 49 common timestamps. PAVG uses the confirmed original-paper checkpoint; no fine-tuning on this event.</p>
      <a class="action" href="#" data-point="physicsiq:${s.id}:pavg"><i data-lucide="box"></i>PAVG predicted point cloud</a>
      <details><summary>Conditions and limitations</summary><p>PAVG receives a manually specified smoke region and upward velocity [0, 0.12, 0] in normalized model coordinates per second. The paper remains static context. The smoke reconstruction is an unvalidated volumetric prior. Image-to-video baselines receive the initial image and prompt. Future reference frames were not used to choose generation conditions.</p><p>Combustion, paper deformation, and continued emission of new smoke particles are not modeled. The three camera views are dependent observations of one event.</p></details></div>
    </div>
    <div class="notice added">These display clips use nearest-frame sampling over the same 0-2 s interval. PAVG is presented using the declared 24 fps trajectory clock; its native DaS export is 8 fps. Native exports remain available below. Wan2.2-TI2V-5B differs from the original paper's Wan2.2-I2V-A14B baseline.</div>
    ${playerBar()}
    <div class="video-grid external-grid">
      ${videoCard(s.videos.reference,'Held-out reference',{sub:'Recorded reference, not a model output'})}
      ${videoCard(s.videos.pavg,'PAVG',{ours:true,trajectory:`physicsiq:${s.id}:pavg`,sub:'Added experiment / existing checkpoint'})}
      ${videoCard(s.videos.cogvideox15,'CogVideoX1.5-5B-I2V',{sub:'Added experiment'})}
      ${videoCard(s.videos.wan22_ti2v5b,'Wan2.2-TI2V-5B',{sub:'Added experiment / 5B variant'})}
    </div>
    <h2 style="margin-top:28px">Native exports</h2>
    <div class="native-links"><a href="${s.native.pavg_8fps.src}" download>PAVG / native DaS 8 fps</a><a href="${s.native.pavg_24fps.src}" download>PAVG / trajectory clock 24 fps</a><a href="${s.native.cogvideox15.src}" download>CogVideoX / native 16 fps</a><a href="${s.native.wan22_ti2v5b.src}" download>Wan2.2 / native 24 fps</a></div>
    <section class="failure-section"><h2>Observed limits</h2><p class="failure-copy">PAVG retains a stable background but often produces very thin smoke; the center and right views show little visible change. The image-to-video baselines can produce much larger flames, brightness changes, or thicker plumes than the reference. These qualitative differences do not establish a physical-accuracy ranking.</p>
    <p class="failure-copy">Brightness-based motion masks are unreliable for faint smoke. Assigning perfect overlap to two empty masks can reward nearly static outputs, so no aggregate benchmark score is claimed here.</p></section>
  </main>`;
}
function protocolPage() {
  $('#app').innerHTML = `<main id="main" class="page">
    <span class="eyebrow">Protocol &amp; provenance</span><h1>What each collection contains</h1>
    <p class="lede">Original results and additional tests are kept separate. The page reorganizes retained artifacts; interactive point-cloud previews do not change predictions.</p>
    <section class="protocol-grid"><h2>Original paper</h2><div>
      <p>32 scenes: 8 solid-only, 8 gas-only, and 16 solid-gas interactions. Each scene has 11 videos, for 352 original-paper videos in total. The original PAVG and PhysCtrl outputs are retained; later presentation reruns are excluded from this comparison.</p>
      <p>The nine other baselines retain their frozen source controls. Their controls are not identical to the updated PAVG and PhysCtrl controls. PhysCtrl is solid-trained; gas and interaction cases use the paper's declared input adaptation. This is not a gas-trained PhysCtrl checkpoint.</p>
      <p>Native frame counts and frame rates are shown for each clip. Playback duration is not a claim about physical rollout duration.</p>
    </div></section>
    <section class="protocol-grid"><h2>Corresponding point clouds</h2><div>
      <p>All 32 scenes include PAVG and PhysCtrl numeric prediction files: 64 trajectories. Each contains the initial point cloud and 24 future keyframes. Active phases and point counts are read from the saved arrays, including PhysCtrl's joint 2,048-point adaptation where applicable.</p>
      <p>Coordinates are displayed as saved, without shape repair or per-frame recentering. The viewer camera fits the whole trajectory once. Playback advances six keyframes per second for inspection and does not represent calibrated physical time. Gas is blue; solid is coral.</p>
      <p>These are predicted trajectories, not ground-truth reconstructions. Corresponding 3D predictions were not retained for the other nine video methods. Their absence is not replaced with a shared PAVG trajectory.</p>
    </div></section>
    <section class="protocol-grid"><h2>Additional Physics-IQ test</h2><div>
      <p>One event with three dependent camera views (0139, 0140, 0141). Nine generated videos compare PAVG, CogVideoX1.5-5B-I2V, and Wan2.2-TI2V-5B. Three held-out reference clips are shown separately. Generation uses seed 42.</p>
      <p>The fixed evaluation interval is the first 2 seconds at 49 common timestamps. Nearest-frame sampling is used; images retain their full field of view with letterboxing. Native exports and the PAVG 8 fps export remain downloadable. This is not the official 5-second/full-suite Physics-IQ evaluation.</p>
      <p>PAVG uses specified phase regions and an upward velocity prior. The I2V baselines use image and prompt. Future reference frames were obtained for evaluation after generation conditions were fixed.</p>
      <p>Dataset attribution: <a href="https://physics-iq.github.io/" rel="noreferrer noopener">Physics-IQ original benchmark</a>, paper-smoke event. Copyright 2025 Google LLC. Reference images and videos are used under <a href="https://creativecommons.org/licenses/by/4.0/" rel="noreferrer noopener">CC BY 4.0</a>. The reference clips shown here are trimmed to 0-2 seconds, resampled, and letterboxed. No endorsement is implied. No claim of additional independent events or official benchmark ranking is made.</p>
    </div></section>
    <section class="protocol-grid"><h2>Failure diagnostics</h2><div>
      <p>The rigid-shape metric is recomputed from the original-paper tennis-ball prediction. The gas-control intervention clips are separate additional diagnostics with the same image, prompt, and seed. They are not added to the original-paper video scores.</p>
      <p>Trajectory geometry, control visualization, and generated appearance are presented as distinct evidence. Motion visibility and shape diagnostics are not substitutes for ground-truth physical errors.</p>
    </div></section>
    <section class="protocol-grid"><h2>Checkpoint and files</h2><div>
      <p>PAVG uses the confirmed main Stage-2 checkpoint at update 60,000. The ongoing unified-model ablation is not substituted into these results.</p>
      <p class="hash">Checkpoint SHA-256: ${data.checkpoint}</p>
      <p>MP4 video streams are copied without re-encoding. Ancillary container metadata, chapters, and audio are omitted in the anonymous publication copy. Numeric NPZ downloads are byte-identical to the retained source. Source and published-file checksums are available in the <a href="asset-manifest.json" download>asset manifest</a>.</p>
    </div></section>
    <section class="protocol-grid"><h2>Anonymous access</h2><div>
      <p>No author names, affiliations, email addresses, source-repository links, or local filesystem paths are included in the published material. Fonts, scripts, videos, and point-cloud files are served from this site. No application analytics, visitor counters, tracking pixels, cookies, or local-storage identifiers are used.</p>
      <p>The page requires no sign-in. Search indexing is discouraged using noindex metadata and robots.txt.</p>
    </div></section>
  </main>`;
}
function route() {
  playerObserver?.disconnect();
  $$('#app video').forEach(pauseVideo);
  playbackEnabled = true;
  const [tab = 'paper', id] = location.hash.slice(1).split('/');
  const active = ['paper','failures','physicsiq','protocol'].includes(tab) ? tab : 'paper';
  $$('#nav a').forEach(a => a.toggleAttribute('aria-current',false));
  $(`#nav a[data-tab="${active}"]`).setAttribute('aria-current','page');
  if (active === 'failures') failurePage();
  else if (active === 'physicsiq') externalPage(id);
  else if (active === 'protocol') protocolPage();
  else paperPage(id);
  window.scrollTo(0,0);
  bindPlayers();
}

async function openPoints(title, origin, choices, method) {
  $$('#app video').forEach(pauseVideo);
  pointChoices = choices;
  $('#trajectory-title').textContent = title;
  $('#trajectory-origin').textContent = origin;
  $('#trajectory-method').innerHTML = Object.keys(choices).map(k=>`<option value="${k}">${k==='physctrl_stage1'?'PhysCtrl':'PAVG'}</option>`).join('');
  $('#trajectory-method').value = method;
  if (!dialog.open) dialog.showModal();
  icons();
  await loadPoints(method);
}
function disposePoints() {
  if (!pointViewer) return;
  pointViewer.observer.disconnect();
  pointViewer.controls.dispose();
  pointViewer.objects.forEach(o => { o.geometry.dispose(); o.material.dispose(); });
  pointViewer.renderer.dispose();
  pointViewer.renderer.domElement.remove();
  pointViewer = null;
}
async function loadPoints(method) {
  const token = ++pointLoad;
  playingPoints = false;
  pointFrame = 0;
  updatePointButton();
  disposePoints();
  const info = pointChoices[method];
  $('#trajectory-download').href = info.download;
  $('#trajectory-note').textContent = `${info.points.toLocaleString()} points across ${info.phases.map(x=>`${x.count.toLocaleString()} ${x.name.toLowerCase()}`).join(' + ')}. Initial + 24 predicted keyframes. Saved normalized coordinates; no shape repair. Playback: 6 keyframes/s, not physical time.`;
  const status = $('#point-status');
  status.hidden = false; status.textContent = 'Loading point cloud...';
  try {
    const response = await fetch(info.data);
    if (!response.ok) throw new Error('Point-cloud file unavailable');
    const positions = new Float32Array(await response.arrayBuffer());
    if (token !== pointLoad || !dialog.open) return;
    if (positions.length !== info.frames * info.points * 3) throw new Error('Point-cloud size mismatch');
    const container = $('#point-view');
    const renderer = new THREE.WebGLRenderer({antialias:true,alpha:false,preserveDrawingBuffer:true});
    renderer.setPixelRatio(Math.min(devicePixelRatio,2));
    const scene = new THREE.Scene();
    scene.background = new THREE.Color(0xf3f5f6);
    const camera = new THREE.PerspectiveCamera(40,1,.001,10000);
    const controls = new OrbitControls(camera,renderer.domElement);
    controls.enableDamping = true;
    const center = new THREE.Vector3().fromArray(info.bounds[0]).add(new THREE.Vector3().fromArray(info.bounds[1])).multiplyScalar(.5);
    const span = new THREE.Vector3().fromArray(info.bounds[1]).sub(new THREE.Vector3().fromArray(info.bounds[0]));
    const radius = Math.max(span.length() / 2,.01);
    const objects = [];
    let start = 0;
    for (const phase of info.phases) {
      const geometry = new THREE.BufferGeometry();
      geometry.setAttribute('position',new THREE.BufferAttribute(new Float32Array(phase.count*3),3));
      const material = new THREE.PointsMaterial({color:phase.name==='Gas'?0x247bbd:0xcd624b,size:Number($('#point-size').value),sizeAttenuation:false});
      const object = new THREE.Points(geometry,material);
      object.frustumCulled = false;
      object.userData.start = start;
      object.userData.count = phase.count;
      start += phase.count;
      scene.add(object); objects.push(object);
    }
    const resetCamera = () => {
      const effectiveFov = Math.min(camera.fov*Math.PI/180,2*Math.atan(Math.tan(camera.fov*Math.PI/360)*camera.aspect));
      const distance = radius / Math.sin(effectiveFov/2) * 1.12;
      camera.position.copy(center).add(new THREE.Vector3(.35,.18,1).normalize().multiplyScalar(distance));
      camera.near = radius / 1000; camera.far = distance + radius * 20;
      camera.updateProjectionMatrix();
      controls.target.copy(center); controls.update();
    };
    const resize = () => {
      const w = container.clientWidth, h = container.clientHeight;
      renderer.setSize(w,h,false); camera.aspect = w/h; camera.updateProjectionMatrix();
    };
    const observer = new ResizeObserver(resize);
    pointViewer = {renderer,scene,camera,controls,objects,positions,info,observer,resetCamera};
    container.append(renderer.domElement);
    resize(); resetCamera(); observer.observe(container);
    status.hidden = true;
    setPointFrame(0);
    renderer.render(scene,camera);
  } catch(e) {
    if (token !== pointLoad) return;
    status.textContent = 'Interactive preview unavailable in this browser. The original NPZ remains downloadable.';
    console.error(e);
  }
}
function setPointFrame(frame) {
  pointFrame = frame;
  $('#trajectory-frame').value = frame;
  $('#trajectory-position').textContent = frame ? `Keyframe ${frame} / 24` : 'Initial / 24';
  if (!pointViewer) return;
  const {objects,positions,info} = pointViewer;
  objects.forEach(o=>{
    const offset = (frame*info.points+o.userData.start)*3;
    o.geometry.attributes.position.array.set(positions.subarray(offset,offset+o.userData.count*3));
    o.geometry.attributes.position.needsUpdate = true;
  });
}
function updatePointButton() {
  $('#trajectory-play').innerHTML = `<i data-lucide="${playingPoints?'pause':'play'}"></i>`;
  $('#trajectory-play').setAttribute('aria-label',playingPoints?'Pause trajectory':'Play trajectory');
  $('#trajectory-play').title = playingPoints?'Pause trajectory':'Play trajectory';
  icons();
}
$('#close-trajectory').onclick = () => dialog.close();
dialog.addEventListener('close',()=> { ++pointLoad; playingPoints=false; disposePoints(); syncPlayback(); });
$('#trajectory-method').onchange = e => loadPoints(e.target.value);
$('#reset-camera').onclick = () => pointViewer?.resetCamera();
$('#point-size').oninput = e => pointViewer?.objects.forEach(o=>o.material.size=Number(e.target.value));
$('#trajectory-frame').oninput = e => { playingPoints=false; updatePointButton(); setPointFrame(Number(e.target.value)); };
$('#trajectory-play').onclick = () => { playingPoints=!playingPoints; lastPointTime=performance.now(); updatePointButton(); };
function animate(now) {
  requestAnimationFrame(animate);
  if (!pointViewer || !dialog.open) return;
  if (playingPoints && now-lastPointTime>1000/6) { setPointFrame((pointFrame+1)%25); lastPointTime=now; }
  pointViewer.controls.update();
  pointViewer.renderer.render(pointViewer.scene,pointViewer.camera);
}
requestAnimationFrame(animate);
window.addEventListener('hashchange',route);
document.addEventListener('visibilitychange',syncPlayback);
try {
  const response = await fetch('data.json');
  if (!response.ok) throw new Error('Comparison index unavailable');
  data = await response.json();
  route();
} catch(e) {
  $('#app').innerHTML = '<main class="page"><h1>Comparison index could not load</h1><p>Reload the page or download the asset manifest below.</p></main>';
  console.error(e);
}
