import * as THREE from "three";
import { GLTFLoader } from "three/addons/loaders/GLTFLoader.js";
import { RoundedBoxGeometry } from "three/addons/geometries/RoundedBoxGeometry.js";

const canvas = document.querySelector("#c");
const resultEl = document.querySelector("#result");
const instructionEl = document.querySelector("#instruction");
const retryBtn = document.querySelector("#retry");
const difficultyFieldEl = document.querySelector(".difficulty-field");
const difficultyTabs = document.querySelector("#difficulty-tabs");
const customPanelEl = document.querySelector("#custom-panel");
const customSwingMinEl = document.querySelector("#custom-swing-min");
const customSwingMinValEl = document.querySelector("#custom-swing-min-val");
const customSwingMaxEl = document.querySelector("#custom-swing-max");
const customSwingMaxValEl = document.querySelector("#custom-swing-max-val");
const customSpeedEl = document.querySelector("#custom-speed");
const customSpeedValEl = document.querySelector("#custom-speed-val");
const customTurnMinEl = document.querySelector("#custom-turn-min");
const customTurnMinValEl = document.querySelector("#custom-turn-min-val");
const customTurnMaxEl = document.querySelector("#custom-turn-max");
const customTurnMaxValEl = document.querySelector("#custom-turn-max-val");
const bootEl = document.querySelector("#boot");
const impactOverlay = document.querySelector("#impact-overlay");
const scoreEl = document.querySelector("#stat-score");
const comboEl = document.querySelector("#stat-combo");
const bestEl = document.querySelector("#stat-best");
const rankEl = document.querySelector("#stat-rank");
const musicToggleBtn = document.querySelector("#music-toggle");
const winToggleBtn = document.querySelector("#win-toggle");
const loseToggleBtn = document.querySelector("#lose-toggle");
const mobileOptionsOverlayEl = document.querySelector("#mobile-options-overlay");
const mobileOptionsContentEl = document.querySelector("#mobile-options-content");
const mobileSwitchBtns = document.querySelectorAll(".mobile-switch-btn");
const topBarEl = document.querySelector("#top-bar");

/**
 * φ (degrés) : 0° main contre la jambe ; 90° ≈ horizontal avant ; 180° ≈ haut.
 * rotation.x épaule (rad) = rad(90° − φ).
 */
const PHI_SWING_MIN = -20;
const PHI_SWING_MAX = 200;
const PHI_FORBIDDEN_MIN = 95;
const PHI_FORBIDDEN_MAX = 150;

function phiDegToShoulderRx(phiDeg) {
  return THREE.MathUtils.degToRad(90 - phiDeg);
}

function shoulderRxToPhiDeg(rxRad) {
  return 90 - THREE.MathUtils.radToDeg(rxRad);
}

/** Vitesses nettement plus élevées (plafond pour rester jouable sans flou total). */
const BASE_SWING_SPEED = 4.6;
const MAX_EFFECTIVE_SPEED = 22;
const FIGURE_SCALE = 0.46;

const LEVELS = [
  {
    id: "normal",
    label: "Normal",
    speed: 1.2,
    turnS: [2.3, 3.8],
    wobble: 0.018,
  },
  {
    id: "hard",
    label: "Difficile",
    speed: 1.46,
    turnS: [1.55, 2.7],
    wobble: 0.029,
  },
  {
    id: "expert",
    label: "Expert",
    speed: 1.72,
    turnS: [1.0, 1.85],
    wobble: 0.04,
  },
  {
    id: "extreme",
    label: "Extrême",
    speed: 1.98,
    turnS: [0.74, 1.3],
    wobble: 0.053,
  },
  {
    id: "nightmare",
    label: "Cauchemar",
    speed: 2.22,
    turnS: [0.58, 1.02],
    wobble: 0.06,
  },
  {
    id: "chaos",
    label: "Chaos",
    speed: 2.34,
    turnS: [0.4, 0.74],
    wobble: 0.072,
  },
  {
    id: "mythic",
    label: "Mythique",
    speed: 3.3,
    turnS: [0.24, 0.42],
    wobble: 0.11,
  },
  {
    id: "custom",
    label: "Custom",
    speed: 1.6,
    turnS: [1.2, 2.1],
    wobble: 0.04,
    swingMin: -20,
    swingMax: 200,
  },
];

let currentLevelIndex = 0;
let frozen = false;
let frozenAngle = 0;
let lastAnimNow = performance.now();
let wobbleSeed = 0;
let impactTimer = null;
let motionPhi = 0;
let motionDir = 1;
let motionTime = 0;
let motionVelDeg = 0;
let smoothRx = phiDegToShoulderRx(0);
let nextDirectionSwitchAt = Infinity;
let score = 0;
let combo = 0;
let winCount = 0;
let rank = 1;
let bestScore = Number(localStorage.getItem("arret-net-best") || "0");

let audioUnlocked = false;
let musicEnabled = false;
let winSfxEnabled = false;
let loseSfxEnabled = true;
let sfxCtx = null;
let bgMusic = null;
let loseAudio = null;
let bgMusicCurrentVolume = 0.24;
let mobileView = "game";
let optionsMountedInMobileOverlay = false;

const AUDIO_CANDIDATES = {
  bg: ["assets/audio.mp3", "audio.mp3", "audio/audio.mp3"],
  lose: ["assets/defaite.mp3", "assets/défaite.mp3", "defaite.mp3", "audio/defaite.mp3"],
};

/**
 * bone drive:
 * - baseQuat/baseDirParent = pose de référence de l'upper-arm
 * - chaque frame, on oriente l'upper-arm vers une direction cible (bas/avant/haut)
 *   au lieu d'ajouter un angle sur un axe local (qui crée un twist).
 */
/** @type {{ type: 'pivot' } | { type: 'bone', bone: THREE.Bone, baseQuat: THREE.Quaternion, baseDirParent: THREE.Vector3 }}} */
let armDrive = { type: "pivot" };
/** @type {null | { bone: THREE.Bone, baseQuat: THREE.Quaternion, baseDirParent: THREE.Vector3 }} */
let leftArmLock = null;

let shoulderPivot;
let proceduralRoot;
let proceduralHandGroup = null;
let figure;
let importedScene = null;

function getLevel() {
  return LEVELS[currentLevelIndex];
}

function effectiveSwingSpeed() {
  const streak = Math.min(combo, 5);
  const levelBoost = 1 + currentLevelIndex * 0.14;
  // La montée de difficulté doit être nette en <= 5 réussites d'affilée.
  const streakBoost = 1 + streak * (0.12 + currentLevelIndex * 0.02);
  return Math.min(BASE_SWING_SPEED * getLevel().speed * levelBoost * streakBoost, MAX_EFFECTIVE_SPEED);
}

function levelSwingMin() {
  return getLevel().swingMin ?? PHI_SWING_MIN;
}

function levelSwingMax() {
  return getLevel().swingMax ?? PHI_SWING_MAX;
}

function scheduleNextDirectionSwitch(nowMs) {
  const L = getLevel();
  if (!L.turnS) {
    nextDirectionSwitchAt = Infinity;
    return;
  }
  const [a, b] = L.turnS;
  const streak = Math.min(combo, 5);
  const levelAggro = 1 + currentLevelIndex * 0.22;
  // Accélère fortement les retournements sur les premières séries.
  const streakAggro = 1 + streak * (0.18 + currentLevelIndex * 0.03);
  const turnAggro = Math.min(levelAggro * streakAggro, 7.2);
  const minS = Math.max(0.12, a / turnAggro);
  const maxS = Math.max(minS + 0.06, b / turnAggro);
  nextDirectionSwitchAt = nowMs + (minS + Math.random() * (maxS - minS)) * 1000;
}

function difficultyMultiplier() {
  return 1 + currentLevelIndex * 0.22;
}

function updateStatsUI() {
  if (scoreEl) scoreEl.textContent = String(score);
  if (comboEl) comboEl.textContent = `x${combo}`;
  if (bestEl) bestEl.textContent = String(bestScore);
  if (rankEl) rankEl.textContent = String(rank);
}

function createAudioWithFallback(candidates, { loop = false, volume = 0.4 } = {}) {
  const audio = new Audio();
  audio.preload = "auto";
  audio.loop = loop;
  audio.volume = volume;
  let index = 0;
  const loadNext = () => {
    if (index >= candidates.length) return;
    audio.src = candidates[index++];
    audio.load();
  };
  audio.addEventListener("error", () => {
    loadNext();
  });
  loadNext();
  return audio;
}

function ensureAudioCtx() {
  if (!sfxCtx) sfxCtx = new (window.AudioContext || window.webkitAudioContext)();
  if (sfxCtx.state === "suspended") sfxCtx.resume();
}

function ensureAudioPlayers() {
  if (bgMusic && loseAudio) return;
  bgMusic = createAudioWithFallback(AUDIO_CANDIDATES.bg, { loop: true, volume: bgMusicCurrentVolume });
  loseAudio = createAudioWithFallback(AUDIO_CANDIDATES.lose, { loop: true, volume: 0.95 });
}

async function safePlay(audio, restart = false) {
  if (!audio || !audioUnlocked) return;
  if (restart) {
    audio.pause();
    audio.currentTime = 0;
  }
  try {
    await audio.play();
  } catch {
    /* lecture bloquee par le navigateur */
  }
}

function setMusicVolume(volume) {
  bgMusicCurrentVolume = THREE.MathUtils.clamp(volume, 0, 1);
  if (bgMusic) bgMusic.volume = bgMusicCurrentVolume;
}

function startMusic() {
  ensureAudioPlayers();
  if (!musicEnabled) return;
  if (!bgMusic) return;
  if (loseAudio) {
    loseAudio.pause();
    loseAudio.currentTime = 0;
  }
  bgMusic.volume = bgMusicCurrentVolume;
  safePlay(bgMusic, false);
}

function stopMusic() {
  if (bgMusic) bgMusic.pause();
}

function stopLoseSound() {
  if (!loseAudio) return;
  loseAudio.pause();
  loseAudio.currentTime = 0;
}

function setAudioButtonState(btn, enabled, onLabel, offLabel) {
  if (!btn) return;
  btn.classList.toggle("on", enabled);
  btn.textContent = enabled ? onLabel : offLabel;
}

function syncAudioButtons() {
  setAudioButtonState(musicToggleBtn, musicEnabled, "Musique on", "Musique off");
  setAudioButtonState(winToggleBtn, winSfxEnabled, "Victoire on", "Victoire off");
  setAudioButtonState(loseToggleBtn, loseSfxEnabled, "Défaite on", "Défaite off");
}

function setMusicEnabled(enabled) {
  musicEnabled = enabled;
  syncAudioButtons();
  if (!audioUnlocked) return;
  if (musicEnabled) startMusic();
  else stopMusic();
}

function setWinSfxEnabled(enabled) {
  winSfxEnabled = enabled;
  syncAudioButtons();
}

function setLoseSfxEnabled(enabled) {
  loseSfxEnabled = enabled;
  syncAudioButtons();
  if (!loseSfxEnabled) stopLoseSound();
}

function unlockAudio() {
  if (audioUnlocked) return;
  ensureAudioPlayers();
  ensureAudioCtx();
  audioUnlocked = true;
  if (musicEnabled) startMusic();
  syncAudioButtons();
}

function sfxTone(f0, f1, dur, type, vol, at) {
  if (!sfxCtx) return;
  const t0 = sfxCtx.currentTime + at;
  const osc = sfxCtx.createOscillator();
  const g = sfxCtx.createGain();
  osc.type = type;
  osc.frequency.setValueAtTime(f0, t0);
  if (f1) osc.frequency.exponentialRampToValueAtTime(f1, t0 + dur);
  g.gain.setValueAtTime(0.0001, t0);
  g.gain.exponentialRampToValueAtTime(vol, t0 + 0.012);
  g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
  osc.connect(g);
  g.connect(sfxCtx.destination);
  osc.start(t0);
  osc.stop(t0 + dur + 0.03);
}

function playWinSound() {
  if (!audioUnlocked || !winSfxEnabled) return;
  stopLoseSound();
  setMusicVolume(0.24);
  sfxTone(523, null, 0.07, "triangle", 0.13, 0);
  sfxTone(659, null, 0.09, "triangle", 0.15, 0.06);
  sfxTone(880, null, 0.18, "sine", 0.18, 0.12);
}

function playLoseSound() {
  if (!audioUnlocked || !loseSfxEnabled) return;
  ensureAudioPlayers();
  setMusicVolume(0.1);
  safePlay(loseAudio, true);
}

function handlePrimaryAction() {
  if (isMobileLayout() && mobileView === "options") return;
  if (frozen) resetRound();
  else stopArm();
}

function isMobileLayout() {
  return window.matchMedia("(max-width: 820px)").matches || window.matchMedia("(pointer:coarse)").matches;
}

function mountOptionsIntoMobileOverlay() {
  if (optionsMountedInMobileOverlay) return;
  if (!difficultyFieldEl || !mobileOptionsContentEl) return;
  difficultyFieldEl.classList.add("mobile-options-mounted");
  mobileOptionsContentEl.appendChild(difficultyFieldEl);
  optionsMountedInMobileOverlay = true;
}

function mountOptionsIntoTopBar() {
  if (!optionsMountedInMobileOverlay) return;
  if (!difficultyFieldEl || !topBarEl) return;
  difficultyFieldEl.classList.remove("mobile-options-mounted");
  topBarEl.appendChild(difficultyFieldEl);
  optionsMountedInMobileOverlay = false;
}

function setMobileView(view) {
  if (!isMobileLayout()) {
    mobileView = "game";
    document.body.classList.remove("mobile-options-open");
    if (mobileOptionsOverlayEl) {
      mobileOptionsOverlayEl.setAttribute("aria-hidden", "true");
    }
    mobileSwitchBtns.forEach((btn) => {
      btn.classList.toggle("active", btn.dataset.mobileView === "game");
    });
    mountOptionsIntoTopBar();
    return;
  }
  mountOptionsIntoMobileOverlay();
  mobileView = view === "options" ? "options" : "game";
  const open = mobileView === "options";
  document.body.classList.toggle("mobile-options-open", open);
  if (mobileOptionsOverlayEl) {
    mobileOptionsOverlayEl.setAttribute("aria-hidden", open ? "false" : "true");
  }
  mobileSwitchBtns.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mobileView === mobileView);
  });
}

function setupMobileOptionsLayout() {
  mobileSwitchBtns.forEach((btn) => {
    btn.addEventListener("click", () => {
      setMobileView(btn.dataset.mobileView || "game");
    });
  });
  setMobileView("game");
}

function physMat(color, rough = 0.42, metal = 0.06, clear = 0.12) {
  return new THREE.MeshPhysicalMaterial({
    color,
    roughness: rough,
    metalness: metal,
    clearcoat: clear,
    clearcoatRoughness: 0.35,
    envMapIntensity: 0.9,
  });
}

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileLayout() ? 1.5 : 2));
renderer.setSize(window.innerWidth, window.innerHeight, false);
renderer.outputColorSpace = THREE.SRGBColorSpace;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.08;
renderer.shadowMap.enabled = true;
renderer.shadowMap.type = THREE.PCFSoftShadowMap;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x07080d);
scene.fog = new THREE.Fog(0x07080d, 5.5, 16.5);

const camera = new THREE.PerspectiveCamera(
  52,
  window.innerWidth / window.innerHeight,
  0.1,
  100
);
camera.up.set(0, 1, 0);

const hemi = new THREE.HemisphereLight(0xd8e4f5, 0x12151c, 0.55);
scene.add(hemi);
const key = new THREE.DirectionalLight(0xffffff, 1.05);
key.position.set(-2.2, 6.5, 4.2);
key.castShadow = true;
key.shadow.mapSize.setScalar(2048);
key.shadow.bias = -0.00015;
key.shadow.camera.near = 0.5;
key.shadow.camera.far = 22;
key.shadow.camera.left = -4;
key.shadow.camera.right = 4;
key.shadow.camera.top = 4;
key.shadow.camera.bottom = -3;
scene.add(key);
const fill = new THREE.DirectionalLight(0x7ab8ff, 0.28);
fill.position.set(4, 3, -2);
scene.add(fill);
const rim = new THREE.DirectionalLight(0x5eead4, 0.22);
rim.position.set(0.5, 2.5, -4);
scene.add(rim);

const floorMat = new THREE.MeshStandardMaterial({
  color: 0x0a0c12,
  roughness: 0.92,
  metalness: 0.08,
});
const floor = new THREE.Mesh(new THREE.CircleGeometry(3.8, 96), floorMat);
floor.rotation.x = -Math.PI / 2;
floor.receiveShadow = true;
scene.add(floor);

const ringGeo = new THREE.RingGeometry(1.15, 1.22, 64);
const ringMat = new THREE.MeshBasicMaterial({
  color: 0x5eead4,
  transparent: true,
  opacity: 0.22,
  depthWrite: false,
});
const ring = new THREE.Mesh(ringGeo, ringMat);
ring.rotation.x = -Math.PI / 2;
ring.position.y = 0.002;
scene.add(ring);

function limbCapsule(radius, length, mat) {
  const cap = 2 * radius;
  const cylLen = Math.max(length - cap, 0.02);
  const g = new THREE.CapsuleGeometry(radius, cylLen, 6, 16);
  const mesh = new THREE.Mesh(g, mat);
  mesh.castShadow = true;
  return mesh;
}

function buildProceduralMannequin() {
  const root = new THREE.Group();
  const skin = physMat(0xb8c0cc, 0.38, 0.04, 0.18);
  const joint = physMat(0x8d96a3, 0.48, 0.12, 0.08);

  const pelvis = limbCapsule(0.095, 0.26, joint);
  pelvis.position.y = 0.9;
  root.add(pelvis);

  const torso = new THREE.Mesh(
    new RoundedBoxGeometry(0.2, 0.46, 0.12, 3, 0.028),
    skin
  );
  torso.position.y = 1.18;
  torso.castShadow = true;
  root.add(torso);

  const neck = limbCapsule(0.048, 0.1, joint);
  neck.position.y = 1.46;
  root.add(neck);

  const head = new THREE.Mesh(new THREE.SphereGeometry(0.095, 32, 28), skin);
  head.scale.set(0.94, 1.06, 0.98);
  head.position.y = 1.56;
  head.castShadow = true;
  root.add(head);

  const legL = limbCapsule(0.042, 0.64, skin);
  legL.position.set(-0.065, 0.5, 0);
  root.add(legL);
  const legR = limbCapsule(0.042, 0.64, skin);
  legR.position.set(0.065, 0.5, 0);
  root.add(legR);

  const armL = limbCapsule(0.034, 0.54, skin);
  armL.position.set(-0.18, 1.28, 0);
  armL.rotation.z = 0.07;
  armL.rotation.x = 0.03;
  root.add(armL);

  const pivot = new THREE.Group();
  pivot.position.set(0.18, 1.3, 0);
  root.add(pivot);

  const armLen = 0.52;
  const armGeo = new THREE.CylinderGeometry(0.028, 0.026, armLen - 0.07, 14);
  armGeo.rotateX(Math.PI / 2);
  armGeo.translate(0, 0, (armLen - 0.07) / 2);
  const armMesh = new THREE.Mesh(armGeo, skin);
  armMesh.castShadow = true;

  const handMat = skin.clone();
  const handGroup = createFlatHand(handMat, armLen);
  pivot.add(armMesh, handGroup);
  pivot.rotation.order = "XYZ";

  return { root, shoulderPivot: pivot, armLength: armLen, handGroup };
}

function createFlatHand(handMat, armLength) {
  const g = new THREE.Group();
  const palmT = 0.006;
  const palm = new THREE.Mesh(
    new THREE.BoxGeometry(palmT, 0.04, 0.05),
    handMat
  );
  palm.position.set(0, 0, 0.024);
  palm.castShadow = true;
  g.add(palm);

  const nF = 4;
  const rowW = 0.045;
  const gap = 0.0018;
  const fw = (rowW - gap * (nF - 1)) / nF;
  const fz = 0.042;
  const fy = 0.0078;
  const zKnuckle = 0.047 + fz * 0.5;
  for (let i = 0; i < nF; i++) {
    const f = new THREE.Mesh(new THREE.BoxGeometry(fw - 0.001, fy, fz), handMat);
    const x = -rowW / 2 + fw / 2 + i * (fw + gap);
    f.position.set(x, 0.011, zKnuckle);
    f.castShadow = true;
    g.add(f);
  }
  const thumb = new THREE.Mesh(new THREE.BoxGeometry(0.016, 0.008, 0.028), handMat);
  thumb.position.set(-0.028, -0.0035, 0.019);
  thumb.rotation.set(0, 0.4, 0.16);
  thumb.castShadow = true;
  g.add(thumb);

  g.position.set(0, 0, armLength - 0.016);
  return g;
}

const built = buildProceduralMannequin();
shoulderPivot = built.shoulderPivot;
proceduralRoot = built.root;
proceduralHandGroup = built.handGroup;

figure = new THREE.Group();
figure.add(proceduralRoot);
figure.scale.setScalar(FIGURE_SCALE);
scene.add(figure);

/** Vérifie la visibilité effective (ancêtres inclus). */
function isEffectivelyVisible(obj) {
  let o = obj;
  while (o) {
    if (o.visible === false) return false;
    o = o.parent;
  }
  return true;
}

/**
 * AABB monde fiable (SkinnedMesh : setFromObject est souvent faux / minuscule).
 * Union des boundingBox des géométries transformées par matrixWorld.
 */
function computeWorldMeshBounds(root) {
  const box = new THREE.Box3();
  let first = true;
  root.updateMatrixWorld(true);
  root.traverse((obj) => {
    if (!obj.isMesh || !isEffectivelyVisible(obj)) return;
    const g = obj.geometry;
    if (!g.boundingBox) g.computeBoundingBox();
    const lb = g.boundingBox.clone();
    lb.applyMatrix4(obj.matrixWorld);
    if (first) {
      box.copy(lb);
      first = false;
    } else {
      box.union(lb);
    }
  });
  return box;
}

figure.updateMatrixWorld(true);
const b0 = computeWorldMeshBounds(figure);
if (!b0.isEmpty()) figure.position.y -= b0.min.y;

/**
 * Profil : si la bbox mesh est trop basse (skinned), on étend vers le haut pour représenter tout le corps.
 * Cible haute + œil plus bas + grande distance → tête, bras et jambes dans le cadre.
 */
function frameCameraOnFigure() {
  const raw = computeWorldMeshBounds(figure);
  if (raw.isEmpty() || !isFinite(raw.min.y)) return;

  const box = raw.clone();
  let ymin = box.min.y;
  let ymax = box.max.y;
  let h = ymax - ymin;
  /** Beaucoup de GLB skinnés sous-estiment la hauteur : on force au moins ~1,7 m depuis le sol détecté. */
  if (h < 1.22) {
    ymax = ymin + 1.74;
    h = ymax - ymin;
    box.max.y = ymax;
  }

  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);

  const margin = 1.58;
  const vFovRad = THREE.MathUtils.degToRad(camera.fov);
  const tanHalf = Math.tan(vFovRad * 0.5);
  let dist = (h * margin) / (2 * tanHalf);

  const aspect = Math.max(camera.aspect, 0.5);
  const hFovHalf = Math.atan(tanHalf * aspect);
  const distH = (Math.max(size.z, size.x * 0.55) * margin * 0.62) / hFovHalf;
  dist = Math.max(dist, distH, 4.1);
  dist = THREE.MathUtils.clamp(dist, 4.1, 18);

  const cx = center.x;
  /** Un peu au-dessus et légèrement de côté pour mieux lire la profondeur du geste. */
  const lookY = ymin + h * 0.77;
  const eyeY = ymin + h * 0.86;

  camera.position.set(cx + dist * 1.02, eyeY, center.z + 0.88);
  camera.near = 0.08;
  camera.far = 140;
  camera.lookAt(cx, lookY, center.z + 0.16);
}

frameCameraOnFigure();

function findArmBone(root, side = "right") {
  const sideKey = side.toLowerCase();
  /** @type {THREE.Bone | null} */
  let best = null;
  root.traverse((o) => {
    if (!o.isBone) return;
    const n = o.name;
    const low = n.toLowerCase();
    if (low.includes("fore") || low.includes("hand") || low.includes("wrist")) return;
    if (low.includes("thumb") || low.includes("index")) return;
    const isSideArm =
      sideKey === "right"
        ? /rightarm$/i.test(n) ||
          /mixamorig:rightarm$/i.test(low) ||
          low === "rightarm" ||
          (low.includes("right") && low.endsWith("arm") && !low.includes("fore"))
        : /leftarm$/i.test(n) ||
          /mixamorig:leftarm$/i.test(low) ||
          low === "leftarm" ||
          (low.includes("left") && low.endsWith("arm") && !low.includes("fore"));
    if (isSideArm) {
      best = /** @type {THREE.Bone} */ (o);
    }
  });
  return best;
}

function findFirstBoneChild(bone) {
  for (const c of bone.children) {
    if (c.isBone) return c;
  }
  return null;
}

function fitModelToGround(model, targetHeight = 1.68) {
  model.updateMatrixWorld(true);
  let box = computeWorldMeshBounds(model);
  let h = box.max.y - box.min.y || 1;
  if (h < 0.25) {
    model.updateMatrixWorld(true);
    box = new THREE.Box3().setFromObject(model);
    h = box.max.y - box.min.y || 1;
  }
  const s = targetHeight / h;
  model.scale.setScalar(s);
  model.updateMatrixWorld(true);
  const b = computeWorldMeshBounds(model);
  if (!b.isEmpty()) model.position.y -= b.min.y;
}

async function tryLoadCharacterGlb() {
  const loader = new GLTFLoader();
  const candidates = [
    new URL("assets/character.glb", import.meta.url).href,
    "https://threejs.org/examples/models/gltf/Xbot.glb",
  ];

  for (const url of candidates) {
    try {
      const gltf = await loader.loadAsync(url);
      const model = gltf.scene;
      model.traverse((o) => {
        if (o.isMesh) {
          o.castShadow = true;
          o.receiveShadow = true;
        }
      });

      const bone = findArmBone(model, "right");
      const leftBone = findArmBone(model, "left");
      proceduralRoot.visible = false;
      figure.add(model);
      importedScene = model;
      fitModelToGround(model, 1.66);

      if (bone) {
        bone.rotation.order = "XYZ";
        const childBone = findFirstBoneChild(bone);
        const dLocal = childBone
          ? childBone.position.clone().normalize()
          : new THREE.Vector3(1, 0, 0);
        const baseDirParent = dLocal.applyQuaternion(bone.quaternion).normalize();
        armDrive = {
          type: "bone",
          bone,
          baseQuat: bone.quaternion.clone(),
          baseDirParent,
        };
        if (leftBone) {
          leftBone.rotation.order = "XYZ";
          const leftChild = findFirstBoneChild(leftBone);
          const leftDLocal = leftChild
            ? leftChild.position.clone().normalize()
            : new THREE.Vector3(1, 0, 0);
          const leftBaseDirParent = leftDLocal
            .applyQuaternion(leftBone.quaternion)
            .normalize();
          leftArmLock = {
            bone: leftBone,
            baseQuat: leftBone.quaternion.clone(),
            baseDirParent: leftBaseDirParent,
          };
        } else {
          leftArmLock = null;
        }
      } else {
        armDrive = { type: "pivot" };
        leftArmLock = null;
        proceduralRoot.visible = true;
        if (importedScene) {
          figure.remove(importedScene);
          importedScene = null;
        }
      }

      figure.updateMatrixWorld(true);
      const bb = computeWorldMeshBounds(figure);
      if (!bb.isEmpty()) figure.position.y -= bb.min.y;
      frameCameraOnFigure();
      return;
    } catch {
      /* essai suivant */
    }
  }
}

const _handDesiredQ = new THREE.Quaternion().setFromAxisAngle(
  new THREE.Vector3(0, 0, 1),
  -Math.PI / 2
);
const _pivotQ = new THREE.Quaternion();

function applyShoulderRx(rx) {
  shoulderPivot.rotation.x = rx;
  if (!importedScene && proceduralHandGroup) {
    shoulderPivot.getWorldQuaternion(_pivotQ);
    _pivotQ.invert();
    proceduralHandGroup.quaternion.copy(_pivotQ).multiply(_handDesiredQ);
  }
  const solveArm = (bone, baseQuat, baseDirParent, phiDeg, sideBias = 0) => {
    if (!bone || !bone.parent) return;
    const phiRad = THREE.MathUtils.degToRad(phiDeg);
    const parentWorldQ = new THREE.Quaternion();
    bone.parent.getWorldQuaternion(parentWorldQ);
    const invParentWorldQ = parentWorldQ.clone().invert();

    const downParent = new THREE.Vector3(0, -1, 0)
      .applyQuaternion(invParentWorldQ)
      .normalize();
    const forwardParent = new THREE.Vector3(0, 0, 1)
      .applyQuaternion(invParentWorldQ);
    forwardParent.addScaledVector(downParent, -forwardParent.dot(downParent));
    if (forwardParent.lengthSq() < 1e-6) forwardParent.set(0, 0, 1);
    forwardParent.normalize();

    const sideParent = new THREE.Vector3(1, 0, 0)
      .applyQuaternion(invParentWorldQ)
      .normalize();

    const targetDir = downParent
      .clone()
      .multiplyScalar(Math.cos(phiRad))
      .add(forwardParent.multiplyScalar(Math.sin(phiRad)))
      .addScaledVector(sideParent, sideBias)
      .normalize();

    const delta = new THREE.Quaternion().setFromUnitVectors(
      baseDirParent,
      targetDir
    );
    bone.quaternion.copy(delta).multiply(baseQuat);
  };

  if (armDrive.type === "bone" && armDrive.bone) {
    // Bras droit: animé
    const phi = THREE.MathUtils.clamp(shoulderRxToPhiDeg(rx), -6, 160);
    solveArm(
      armDrive.bone,
      armDrive.baseQuat,
      armDrive.baseDirParent,
      phi,
      0
    );
  }
  if (leftArmLock) {
    // Bras gauche non utilisé: parallèle au corps avec un léger déport latéral (évite l'illusion "collé dans la jambe").
    solveArm(
      leftArmLock.bone,
      leftArmLock.baseQuat,
      leftArmLock.baseDirParent,
      6,
      -0.2
    );
  }
}

function triggerImpact(kind) {
  document.body.classList.remove("state-win", "state-lose");
  if (impactOverlay) {
    impactOverlay.classList.remove("show", "win", "lose");
    void impactOverlay.offsetWidth;
    impactOverlay.classList.add(kind, "show");
  }
  document.body.classList.add(kind === "win" ? "state-win" : "state-lose");

  if (impactTimer) clearTimeout(impactTimer);
  impactTimer = setTimeout(() => {
    if (impactOverlay) impactOverlay.classList.remove("show", "win", "lose");
    document.body.classList.remove("state-win", "state-lose");
  }, kind === "win" ? 420 : 560);

  if (kind === "win") playWinSound();
  else playLoseSound();
}

function readShoulderRx() {
  return shoulderPivot.rotation.x;
}

function currentShoulderRx(dt, nowMs) {
  const L = getLevel();
  motionTime += dt;
  const swingMin = levelSwingMin();
  const swingMax = levelSwingMax();

  const speedDegPerSec = effectiveSwingSpeed() * 76;
  const targetVel = motionDir * speedDegPerSec;
  const velAlpha = 1 - Math.exp(-dt * 9.5);
  motionVelDeg = THREE.MathUtils.lerp(motionVelDeg, targetVel, velAlpha);
  motionPhi += motionVelDeg * dt;

  // Evite que le bras "traine" dans la zone 0..90 qui rend le jeu trop permissif.
  const inEasyBand = motionPhi >= 0 && motionPhi <= 90;
  if (inEasyBand) {
    const distToCenter = Math.abs(motionPhi - 45);
    const centerWeight = 1 - THREE.MathUtils.clamp(distToCenter / 45, 0, 1);
    const escapeBoost = 1 + centerWeight * (0.38 + currentLevelIndex * 0.04);
    motionPhi += motionDir * speedDegPerSec * (escapeBoost - 1) * dt;
  }

  // Evite aussi l'effet "bloqué" dans la zone haute 170..200 (surtout en Mythique).
  const highBandMin = Math.max(swingMin + 8, swingMax - 30);
  const inHighBand = motionPhi >= highBandMin && motionPhi <= swingMax;
  if (inHighBand) {
    const distToCenter = Math.abs(motionPhi - (highBandMin + swingMax) * 0.5);
    const halfSpan = Math.max(6, (swingMax - highBandMin) * 0.5);
    const centerWeight = 1 - THREE.MathUtils.clamp(distToCenter / halfSpan, 0, 1);
    const escapeBoost = 1 + centerWeight * (0.48 + currentLevelIndex * 0.06);
    motionPhi += motionDir * speedDegPerSec * (escapeBoost - 1) * dt;
  }

  // Rebond sans pause aux extrêmes : on réfléchit l'overshoot.
  while (motionPhi < swingMin || motionPhi > swingMax) {
    if (motionPhi < swingMin) {
      motionPhi = swingMin + (swingMin - motionPhi);
      motionDir = 1;
      motionVelDeg = Math.abs(motionVelDeg);
    } else if (motionPhi > swingMax) {
      motionPhi = swingMax - (motionPhi - swingMax);
      motionDir = -1;
      motionVelDeg = -Math.abs(motionVelDeg);
    }
  }

  if (nowMs >= nextDirectionSwitchAt) {
    // Pas d'inversion aléatoire dans 0..90 ni dans la bande haute: on force la traversée.
    if ((motionPhi >= 0 && motionPhi <= 90) || (motionPhi >= highBandMin && motionPhi <= swingMax)) {
      nextDirectionSwitchAt = nowMs + 220 + Math.random() * 180;
    } else {
      // Inversion spontanée de direction sans téléporter la position.
      const streak = Math.min(combo, 24);
      motionDir *= -1;
      const snapFactor = THREE.MathUtils.clamp(0.8 - streak * 0.014 - currentLevelIndex * 0.03, 0.42, 0.8);
      motionVelDeg *= snapFactor;
      scheduleNextDirectionSwitch(nowMs);
    }
  }

  const wobbleDeg =
    Math.sin(motionTime * effectiveSwingSpeed() * 1.7 + wobbleSeed) *
    (L.wobble * 18);
  const targetPhi = THREE.MathUtils.clamp(
    motionPhi + wobbleDeg,
    swingMin,
    swingMax
  );
  const targetRx = phiDegToShoulderRx(targetPhi);
  const alpha = 1 - Math.exp(-dt * 15.8);
  smoothRx = THREE.MathUtils.lerp(smoothRx, targetRx, alpha);
  return smoothRx;
}

function isForbidden(shoulderRxRad) {
  const phi = shoulderRxToPhiDeg(shoulderRxRad);
  return phi >= PHI_FORBIDDEN_MIN && phi <= PHI_FORBIDDEN_MAX;
}

function updateDebugPanel() {}

function syncDifficultyTabs() {
  if (!difficultyTabs) return;
  difficultyTabs.querySelectorAll(".diff-tab").forEach((btn, i) => {
    btn.setAttribute("aria-selected", i === currentLevelIndex ? "true" : "false");
  });
  if (!customPanelEl) return;
  customPanelEl.hidden = getLevel().id !== "custom";
}

function setupCustomControls() {
  if (
    !customSwingMinEl || !customSwingMinValEl ||
    !customSwingMaxEl || !customSwingMaxValEl ||
    !customSpeedEl || !customSpeedValEl ||
    !customTurnMinEl || !customTurnMinValEl ||
    !customTurnMaxEl || !customTurnMaxValEl
  ) {
    return;
  }

  const customLevel = LEVELS.find((l) => l.id === "custom");
  if (!customLevel) return;
  if (customPanelEl) customPanelEl.hidden = true;

  const refreshLabels = () => {
    customSwingMinValEl.textContent = `${Number(customSwingMinEl.value).toFixed(0)}°`;
    customSwingMaxValEl.textContent = `${Number(customSwingMaxEl.value).toFixed(0)}°`;
    customSpeedValEl.textContent = `${Number(customSpeedEl.value).toFixed(2)}x`;
    customTurnMinValEl.textContent = `${Number(customTurnMinEl.value).toFixed(2)}s`;
    customTurnMaxValEl.textContent = `${Number(customTurnMaxEl.value).toFixed(2)}s`;
  };

  const applyValues = () => {
    let min = Number(customSwingMinEl.value);
    let max = Number(customSwingMaxEl.value);
    if (min > max - 8) min = max - 8;
    if (max < min + 8) max = min + 8;
    min = THREE.MathUtils.clamp(min, -30, 210);
    max = THREE.MathUtils.clamp(max, -22, 220);
    customSwingMinEl.value = String(min);
    customSwingMaxEl.value = String(max);

    let turnMin = Number(customTurnMinEl.value);
    let turnMax = Number(customTurnMaxEl.value);
    if (turnMin > turnMax - 0.08) turnMin = turnMax - 0.08;
    if (turnMax < turnMin + 0.08) turnMax = turnMin + 0.08;
    turnMin = THREE.MathUtils.clamp(turnMin, 0.12, 4.8);
    turnMax = THREE.MathUtils.clamp(turnMax, 0.2, 5.2);
    customTurnMinEl.value = String(turnMin);
    customTurnMaxEl.value = String(turnMax);

    customLevel.swingMin = min;
    customLevel.swingMax = max;
    customLevel.speed = THREE.MathUtils.clamp(Number(customSpeedEl.value), 0.8, 3.5);
    customLevel.turnS = [turnMin, turnMax];
    customLevel.wobble = THREE.MathUtils.lerp(0.01, 0.08, (customLevel.speed - 0.8) / (3.5 - 0.8));
    refreshLabels();

    if (getLevel().id === "custom") {
      resetRound();
    }
  };

  customSwingMinEl.addEventListener("input", applyValues);
  customSwingMaxEl.addEventListener("input", applyValues);
  customSpeedEl.addEventListener("input", applyValues);
  customTurnMinEl.addEventListener("input", applyValues);
  customTurnMaxEl.addEventListener("input", applyValues);

  refreshLabels();
}

function resetRound() {
  frozen = false;
  frozenAngle = 0;
  const now = performance.now();
  lastAnimNow = now;
  wobbleSeed = Math.random() * Math.PI * 2;
  motionTime = Math.random() * 4;
  motionPhi = THREE.MathUtils.lerp(levelSwingMin(), levelSwingMax(), Math.random());
  motionDir = Math.random() < 0.5 ? -1 : 1;
  motionVelDeg = motionDir * effectiveSwingSpeed() * 42;
  smoothRx = phiDegToShoulderRx(motionPhi);
  resultEl.textContent = "";
  resultEl.style.color = "";
  document.body.classList.remove("state-win", "state-lose");
  if (impactOverlay) impactOverlay.classList.remove("show", "win", "lose");
  if (impactTimer) {
    clearTimeout(impactTimer);
    impactTimer = null;
  }
  stopLoseSound();
  setMusicVolume(0.24);
  if (musicEnabled && audioUnlocked) startMusic();
  instructionEl.hidden = false;
  retryBtn.hidden = true;
  scheduleNextDirectionSwitch(now);
  updateStatsUI();
}

function stopArm() {
  if (frozen) return;
  frozen = true;
  frozenAngle = readShoulderRx();
  instructionEl.hidden = true;
  retryBtn.hidden = false;
  const phi = shoulderRxToPhiDeg(frozenAngle);
  console.log("[jeu] figé φ =", phi.toFixed(2), "° · interdit ?", isForbidden(frozenAngle));
  updateDebugPanel(frozenAngle, { frozen: true });
  if (isForbidden(frozenAngle)) {
    resultEl.textContent = "Mauvaise zone !";
    resultEl.style.color = "var(--danger)";
    combo = 0;
    triggerImpact("lose");
  } else {
    winCount += 1;
    combo += 1;
    rank = 1 + Math.floor(winCount / 5);
    const base = 120;
    const pts = Math.round(
      base * difficultyMultiplier() * (1 + combo * 0.25) * (1 + (rank - 1) * 0.08)
    );
    score += pts;
    if (score > bestScore) {
      bestScore = score;
      localStorage.setItem("arret-net-best", String(bestScore));
    }
    resultEl.textContent = "Parfait !";
    resultEl.style.color = "var(--ok)";
    triggerImpact("win");
  }
  updateStatsUI();
}

window.addEventListener("keydown", (e) => {
  unlockAudio();
  if (e.code === "Space") {
    e.preventDefault();
    handlePrimaryAction();
  }
});
canvas.addEventListener("pointerdown", () => {
  unlockAudio();
  handlePrimaryAction();
});
retryBtn.addEventListener("click", () => resetRound());
if (musicToggleBtn) {
  syncAudioButtons();
  musicToggleBtn.addEventListener("click", () => {
    unlockAudio();
    setMusicEnabled(!musicEnabled);
  });
}
if (winToggleBtn) {
  syncAudioButtons();
  winToggleBtn.addEventListener("click", () => {
    unlockAudio();
    setWinSfxEnabled(!winSfxEnabled);
  });
}
if (loseToggleBtn) {
  syncAudioButtons();
  loseToggleBtn.addEventListener("click", () => {
    unlockAudio();
    setLoseSfxEnabled(!loseSfxEnabled);
  });
}
setupCustomControls();
setupMobileOptionsLayout();

if (difficultyTabs) {
  LEVELS.forEach((L, i) => {
    const b = document.createElement("button");
    b.type = "button";
    b.className = "diff-tab";
    b.role = "tab";
    b.textContent = L.label;
    b.addEventListener("click", () => {
      currentLevelIndex = i;
      syncDifficultyTabs();
      resetRound();
    });
    difficultyTabs.appendChild(b);
  });
  syncDifficultyTabs();
}

window.addEventListener("resize", () => {
  const ww = window.innerWidth;
  const hh = window.innerHeight;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, isMobileLayout() ? 1.5 : 2));
  camera.aspect = ww / hh;
  camera.updateProjectionMatrix();
  renderer.setSize(ww, hh, false);
  frameCameraOnFigure();
  setMobileView(mobileView);
});

function animate(now) {
  requestAnimationFrame(animate);
  const dt = Math.min((now - lastAnimNow) / 1000, 0.1);
  lastAnimNow = now;

  if (!frozen) {
    const rx = currentShoulderRx(dt, now);
    applyShoulderRx(rx);
  } else {
    applyShoulderRx(frozenAngle);
  }
  ring.material.opacity = 0.22;
  ring.material.color.setHex(0x5eead4);
  updateDebugPanel(readShoulderRx(), { frozen });
  renderer.render(scene, camera);
}

async function boot() {
  await tryLoadCharacterGlb();
  resetRound();
  requestAnimationFrame(animate);
  if (bootEl) bootEl.classList.add("done");
}

boot();
