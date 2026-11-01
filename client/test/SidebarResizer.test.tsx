// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { clampSidebarWidth, SidebarResizer } from "../src/workspace/SidebarResizer";

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

