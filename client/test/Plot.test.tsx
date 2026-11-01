// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Plot } from "../src/views/Plot";
import { PlaybackContext, createPlaybackStore } from "../src/workspace/playback";
import { initialWorkspace } from "../src/workspace/widgets";

