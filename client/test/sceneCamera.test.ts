import * as THREE from "three";
import { expect, it } from "vitest";
import { reframeCamera } from "../src/views/sceneCamera";

it("converts the viewpoint, target and up direction while preserving zoom", () => {
  const camera = new THREE.PerspectiveCamera();
  camera.position.set(2, 0, 1);
  camera.up.set(0, 0, 1);
  const target = new THREE.Vector3(1, 0, 0);
  const distance = camera.position.distanceTo(target);
  reframeCamera(camera, target, {
    translation: [10, 20, 30],
    rotation: [0, 0, Math.SQRT1_2, Math.SQRT1_2],
  });
  expect(camera.position.x).toBeCloseTo(10);
  expect(camera.position.y).toBeCloseTo(22);
  expect(camera.position.z).toBeCloseTo(31);
  expect(target.x).toBeCloseTo(10);
  expect(target.y).toBeCloseTo(21);
  expect(target.z).toBeCloseTo(30);
  expect(camera.position.distanceTo(target)).toBeCloseTo(distance);
  expect(camera.up.toArray()).toEqual([0, 0, 1]);
});
