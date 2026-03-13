/**
 * Gloves hand overlay — loads gloves.glb, applies WiggleRig, drives from MediaPipe landmarks.
 * Replaces the 2D ghost hands with a reactive 3D glove model.
 */
import * as THREE from "https://cdn.jsdelivr.net/npm/three@0.160.0/build/three.module.js";
import { GLTFLoader } from "https://cdn.jsdelivr.net/npm/three@0.160.0/examples/jsm/loaders/GLTFLoader.js";
import { WiggleRig } from "https://cdn.jsdelivr.net/npm/wiggle@0.0.17/dist/WiggleRig.mjs";

const GLOVES_SCALE = 0.8;
const GLOVES_Y_OFFSET = 0.05;

let glovesScene, glovesCamera, glovesRenderer;
let glovesGroup = null;
let wiggleRigs = [];
let glovesReady = false;
let glovesEnabled = true;

export function initGloves(canvasEl) {
  if (!canvasEl) return;

  glovesScene = new THREE.Scene();
  glovesCamera = new THREE.OrthographicCamera(-1, 1, 1, -1, 0.1, 10);
  glovesCamera.position.set(0, 0, 2);
  glovesCamera.lookAt(0, 0, 0);

  glovesRenderer = new THREE.WebGLRenderer({ canvas: canvasEl, alpha: true, antialias: true });
  glovesRenderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  glovesRenderer.setSize(window.innerWidth, window.innerHeight);
  glovesRenderer.setClearColor(0x000000, 0);

  const loader = new GLTFLoader();
  loader.load("model/gloves.glb", (gltf) => {
    glovesGroup = gltf.scene;
    glovesGroup.scale.setScalar(GLOVES_SCALE);
    glovesGroup.position.y = GLOVES_Y_OFFSET;

    glovesGroup.traverse((obj) => {
      if (obj.isSkinnedMesh) {
        obj.frustumCulled = false;
        obj.skeleton.bones.forEach((bone) => {
          if (bone.parent && bone.parent.isBone) {
            bone.userData.wiggleVelocity = 0.35;
          }
        });
        wiggleRigs.push(new WiggleRig(obj.skeleton));
      }
    });

    glovesScene.add(glovesGroup);
    glovesReady = true;
  });

  window.addEventListener("resize", () => {
    if (!glovesRenderer) return;
    glovesRenderer.setSize(window.innerWidth, window.innerHeight);
  });
}

export function updateGloves(landmarks) {
  if (!glovesRenderer || !glovesScene) return;
  if (!glovesReady || !glovesEnabled || !glovesGroup || !landmarks || landmarks.length === 0) {
    if (glovesGroup) glovesGroup.visible = false;
    glovesRenderer.render(glovesScene, glovesCamera);
    return;
  }

  glovesGroup.visible = true;
  const lm = landmarks[0];
  const wristX = (1 - lm[0].x) * 2 - 1;
  const wristY = -(lm[0].y * 2 - 1);
  glovesGroup.position.set(wristX, wristY, 0);

  wiggleRigs.forEach((rig) => rig.update());

  glovesRenderer.render(glovesScene, glovesCamera);
}

export function setGlovesEnabled(enabled) {
  glovesEnabled = enabled;
}

export function isGlovesReady() {
  return glovesReady;
}

export function clearGloves() {
  if (glovesRenderer) glovesRenderer.clear();
}
