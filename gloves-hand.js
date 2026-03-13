/**
 * Gloves hand overlay — loads gloves.glb, applies WiggleRig, and renders
 * one glove per detected hand. Falls back cleanly when the model is not ready.
 */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { clone as skeletonClone } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/utils/SkeletonUtils.js";

let WiggleRigClass = null;

const HAND_COUNT = 2;
const ORTHO_HEIGHT = 1.15;
const MODEL_TARGET_HEIGHT = 0.42;

let glovesScene, glovesCamera, glovesRenderer, glovesCanvas;
let glovesEnabled = true;
let glovesReady = false;
let glovesInitStarted = false;
let gloveTemplate = null;
let gloveInstances = [];

function log(...args) {
  console.log("%c[Gloves]", "color:#ff0;font-weight:bold", ...args);
}

function resizeCamera(w, h) {
  const aspect = w / Math.max(1, h);
  glovesCamera.left = -ORTHO_HEIGHT * aspect;
  glovesCamera.right = ORTHO_HEIGHT * aspect;
  glovesCamera.top = ORTHO_HEIGHT;
  glovesCamera.bottom = -ORTHO_HEIGHT;
  glovesCamera.updateProjectionMatrix();
}

function sizeRenderer() {
  if (!glovesRenderer || !glovesCanvas || !glovesCamera) return;
  const w = Math.max(1, glovesCanvas.clientWidth || window.innerWidth);
  const h = Math.max(1, glovesCanvas.clientHeight || window.innerHeight);
  glovesCanvas.width = w;
  glovesCanvas.height = h;
  glovesRenderer.setSize(w, h, false);
  resizeCamera(w, h);
}

function inspectScene(root, label) {
  let meshCount = 0, skinnedCount = 0, boneCount = 0, childCount = 0;
  root.traverse((obj) => {
    childCount++;
    if (obj.isMesh) meshCount++;
    if (obj.isSkinnedMesh) skinnedCount++;
    if (obj.isBone) boneCount++;
  });
  log(`${label} — children: ${childCount}, meshes: ${meshCount}, skinned: ${skinnedCount}, bones: ${boneCount}`);
}

function prepareClone(root) {
  let instance;
  try {
    instance = skeletonClone(root);
    log("SkeletonUtils.clone succeeded");
  } catch (e) {
    log("SkeletonUtils.clone failed, using .clone(true):", e.message);
    instance = root.clone(true);
  }

  const box = new THREE.Box3().setFromObject(instance);
  const size = new THREE.Vector3();
  const center = new THREE.Vector3();
  box.getSize(size);
  box.getCenter(center);
  log("Model bounding box — size:", size.toArray().map(v => v.toFixed(3)).join(", "), "center:", center.toArray().map(v => v.toFixed(3)).join(", "));

  const wrapper = new THREE.Group();
  wrapper.add(instance);
  instance.position.sub(center);

  const height = Math.max(size.y, 0.001);
  const baseScale = MODEL_TARGET_HEIGHT / height;
  wrapper.scale.setScalar(baseScale);
  wrapper.visible = false;
  log("Normalized scale:", baseScale.toFixed(4));

  const rigs = [];
  let skinCount = 0;
  instance.traverse((obj) => {
    if (obj.isSkinnedMesh) {
      skinCount++;
      obj.frustumCulled = false;
      if (obj.material) {
        obj.material = obj.material.clone();
        obj.material.side = THREE.DoubleSide;
        obj.material.needsUpdate = true;
        log(`SkinnedMesh "${obj.name}" — material: ${obj.material.type}, color: ${obj.material.color?.getHexString()}`);
      }
      const boneNames = obj.skeleton.bones.map(b => b.name);
      log(`SkinnedMesh "${obj.name}" — ${obj.skeleton.bones.length} bones: [${boneNames.slice(0, 8).join(", ")}${boneNames.length > 8 ? "..." : ""}]`);
      obj.skeleton.bones.forEach((bone) => {
        if (bone.parent && bone.parent.isBone) bone.userData.wiggleVelocity = 0.25;
      });
      if (WiggleRigClass) {
        try {
          rigs.push(new WiggleRigClass(obj.skeleton));
          log("WiggleRig attached to", obj.name);
        } catch (e) {
          log("WiggleRig failed for", obj.name, e.message);
        }
      }
    }
    if (obj.isMesh && !obj.isSkinnedMesh) {
      obj.frustumCulled = false;
      if (obj.material) {
        obj.material = obj.material.clone();
        obj.material.side = THREE.DoubleSide;
        obj.material.needsUpdate = true;
      }
      log(`Regular Mesh "${obj.name}" — material: ${obj.material?.type}`);
    }
  });
  log(`Cloned instance has ${skinCount} skinned meshes, ${rigs.length} wiggle rigs`);

  return { root: wrapper, rigs, baseScale };
}

function updateInstanceFromLandmarks(instance, lm) {
  const wrist = lm[0];
  const indexMcp = lm[5];
  const pinkyMcp = lm[17];

  const x = (1 - wrist.x) * 2 - 1;
  const y = -(wrist.y * 2 - 1);
  instance.root.position.set(x, y, 0);

  const palmAngle = Math.atan2(indexMcp.y - pinkyMcp.y, indexMcp.x - pinkyMcp.x);
  instance.root.rotation.set(0, 0, -palmAngle);

  const palmSpan = Math.hypot(indexMcp.x - pinkyMcp.x, indexMcp.y - pinkyMcp.y);
  const scaleMultiplier = 0.85 + palmSpan * 1.5;
  instance.root.scale.setScalar(instance.baseScale * scaleMultiplier);
  instance.root.visible = true;

  instance.rigs.forEach((rig) => rig.update());
}

export function initGloves(canvasEl) {
  if (!canvasEl || glovesInitStarted) return;
  glovesInitStarted = true;
  glovesCanvas = canvasEl;
  log("initGloves called, canvas:", canvasEl.id, canvasEl.clientWidth + "x" + canvasEl.clientHeight);

  requestAnimationFrame(() => {
    const w = Math.max(1, glovesCanvas.clientWidth || window.innerWidth);
    const h = Math.max(1, glovesCanvas.clientHeight || window.innerHeight);
    glovesCanvas.width = w;
    glovesCanvas.height = h;
    log("Canvas sized to", w, "x", h);

    glovesScene = new THREE.Scene();
    glovesCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.01, 20);
    glovesCamera.position.set(0, 0, 5);
    glovesCamera.lookAt(0, 0, 0);
    resizeCamera(w, h);

    glovesRenderer = new THREE.WebGLRenderer({
      canvas: glovesCanvas,
      alpha: true,
      antialias: true,
      premultipliedAlpha: true,
    });
    glovesRenderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
    glovesRenderer.setClearColor(0x000000, 0);
    glovesRenderer.setSize(w, h, false);
    log("WebGL renderer created OK");

    glovesScene.add(new THREE.AmbientLight(0xffffff, 2.5));
    const keyLight = new THREE.DirectionalLight(0xffffff, 3.0);
    keyLight.position.set(2, 3, 5);
    glovesScene.add(keyLight);
    const fillLight = new THREE.DirectionalLight(0xbfd7ff, 1.5);
    fillLight.position.set(-2, 1, 3);
    glovesScene.add(fillLight);
    log("Lights added");

    log("Loading WiggleRig module...");
    import("https://cdn.jsdelivr.net/npm/wiggle@0.0.17/dist/WiggleRig.mjs")
      .then((mod) => {
        WiggleRigClass = mod.WiggleRig;
        log("WiggleRig module loaded OK");
        loadModel();
      })
      .catch((e) => {
        log("WiggleRig module FAILED, proceeding without wiggle:", e.message);
        loadModel();
      });

    function loadModel() {
      log("Loading model/gloves.glb...");
      const loader = new GLTFLoader();
      loader.load(
        "model/gloves.glb",
        (gltf) => {
          log("GLB loaded OK");
          gloveTemplate = gltf.scene;
          inspectScene(gloveTemplate, "gloveTemplate");

          gloveInstances = [];
          for (let i = 0; i < HAND_COUNT; i++) {
            log(`Creating clone ${i}...`);
            const instance = prepareClone(gloveTemplate);
            glovesScene.add(instance.root);
            gloveInstances.push(instance);
          }

          glovesReady = gloveInstances.length > 0;
          log(`glovesReady = ${glovesReady}, instances: ${gloveInstances.length}`);

          testRender();
        },
        (progress) => {
          if (progress.total > 0) {
            log(`Loading: ${Math.round(progress.loaded / progress.total * 100)}% (${(progress.loaded / 1e6).toFixed(1)}MB / ${(progress.total / 1e6).toFixed(1)}MB)`);
          }
        },
        (err) => {
          console.error("[Gloves] FAILED to load gloves.glb:", err);
        }
      );
    }

    function testRender() {
      if (gloveInstances.length > 0) {
        gloveInstances[0].root.visible = true;
        gloveInstances[0].root.position.set(0, 0, 0);
        gloveInstances[0].root.scale.setScalar(gloveInstances[0].baseScale);
      }
      glovesRenderer.render(glovesScene, glovesCamera);
      const gl = glovesRenderer.getContext();
      const pixels = new Uint8Array(4);
      gl.readPixels(w / 2, h / 2, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
      log("Test render center pixel:", pixels[0], pixels[1], pixels[2], pixels[3]);
      if (pixels[3] === 0) {
        log("WARNING: center pixel is fully transparent — model may be invisible");
      }
      if (gloveInstances.length > 0) {
        gloveInstances[0].root.visible = false;
      }
    }

    window.addEventListener("resize", sizeRenderer);
  });
}

let updateCount = 0;

export function updateGloves(landmarks) {
  if (!glovesRenderer || !glovesScene) {
    if (updateCount++ < 3) log("updateGloves skipped: renderer/scene not ready");
    return;
  }

  gloveInstances.forEach((inst) => { inst.root.visible = false; });

  if (!glovesEnabled || !glovesReady || !landmarks || landmarks.length === 0) {
    glovesRenderer.render(glovesScene, glovesCamera);
    return;
  }

  const count = Math.min(landmarks.length, gloveInstances.length);
  if (updateCount < 5) {
    log(`updateGloves: ${landmarks.length} hands detected, rendering ${count}`);
    updateCount++;
  }

  for (let i = 0; i < count; i++) {
    updateInstanceFromLandmarks(gloveInstances[i], landmarks[i]);
  }

  glovesRenderer.render(glovesScene, glovesCamera);
}

export function setGlovesEnabled(enabled) {
  glovesEnabled = enabled;
  log("setGlovesEnabled:", enabled);
}

export function isGlovesReady() {
  return glovesReady;
}

export function clearGloves() {
  if (!glovesRenderer || !glovesScene) return;
  gloveInstances.forEach((inst) => { inst.root.visible = false; });
  glovesRenderer.render(glovesScene, glovesCamera);
}
