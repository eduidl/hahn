// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useReducer } from "react";
import { PanelSettings } from "./PanelSettings";
import { TableView, messageAt } from "./TableView";
import { buildFieldIndex } from "./fieldIndex";
import { createPlaybackStore, PlaybackContext } from "./playback";
import { initialWorkspace, workspaceReducer } from "./widgets";
import { keyOf, type Topic } from "./types";

