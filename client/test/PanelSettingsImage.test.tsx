// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { useReducer } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { PanelSettings } from "../src/workspace/PanelSettings";
import { buildFieldIndex } from "../src/workspace/fieldIndex";
import { addFieldAction, initialWorkspace, workspaceReducer } from "../src/workspace/widgets";
import type { Topic } from "../src/types";

