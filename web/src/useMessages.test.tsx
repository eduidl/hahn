// @vitest-environment jsdom
import { StrictMode } from "react";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMessages } from "./useMessages";
import { initialWorkspace, workspaceReducer, type Widget } from "./widgets";
import { keyOf, type Selected } from "./types";

