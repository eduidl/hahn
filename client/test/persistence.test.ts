// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  clearSession,
  loadSession,
  reviveWorkspace,
  saveSession,
  type Session,
} from "../src/workspace/persistence";
import { initialWorkspace, workspaceReducer as reduce } from "../src/workspace/widgets";

