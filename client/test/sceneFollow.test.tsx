// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { gridOffset } from "../src/views/sceneCamera";
import { FollowContext, useFramePlacement } from "../src/views/sceneLayers";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { reviveWorkspace } from "../src/workspace/persistence";
import { WidgetSettings } from "../src/workspace/WidgetSettings";
import { initialWorkspace, widget } from "../src/workspace/widgets";

const mocks = vi.hoisted(() => ({ frames: [] as any[] }));
const transformMocks = vi.hoisted(() => ({ frames: {} as any, lastTarget: null as string | null }));
vi.mock("../src/data/useViewData", async (original) => ({
  ...(await original<typeof import("../src/data/useViewData")>()),
  useFrames: () => ({ frames: mocks.frames, error: "" }),
  useTransforms: (_source: string, target: string | null, ns: string | null) => {
    transformMocks.lastTarget = target;
    return {
      transforms: target ? { target, time_ns: ns, frames: transformMocks.frames } : undefined,
      error: "",
    };
  },
}));

afterEach(cleanup);

const turned = (yaw: number) => [0, 0, Math.sin(yaw / 2), Math.cos(yaw / 2)];
const close = (vector: THREE.Vector3, expected: number[]) =>
  vector.toArray().forEach((value, i) => expect(value).toBeCloseTo(expected[i]));

it("forgets a saved fixed frame and a broken followed frame", () => {
  const saved = JSON.parse(JSON.stringify(initialWorkspace()));
  saved.widgets["widget-1"].fixedFrame = "lidar";
  saved.widgets["widget-1"].followFrame = 3;
  const revived = reviveWorkspace(saved)!.widgets["widget-1"];
  expect(revived.followFrame).toBeNull();
  expect("fixedFrame" in revived).toBe(false);
});

