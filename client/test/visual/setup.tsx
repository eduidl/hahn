import "react-mosaic-component/react-mosaic-component.css";
import "../../src/styles/base.css";
import "../../src/styles/shared.css";
import "../../src/App.css";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeAll, vi } from "vitest";

// These draw with the GPU or fetch map tiles, so they would differ between machines.
vi.mock("../../src/views/Plot", async (original) => ({
  ...(await original<typeof import("../../src/views/Plot")>()),
  Plot: () => <div className="widget-fill" />,
}));
vi.mock("../../src/views/Scene3D", () => ({ default: () => <div className="widget-fill" /> }));
vi.mock("../../src/views/MapView", () => ({ default: () => <div className="widget-fill" /> }));

beforeAll(() => document.fonts.ready);
afterEach(cleanup);
