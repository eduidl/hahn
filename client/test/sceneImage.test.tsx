// @vitest-environment jsdom
import { act, render, waitFor } from "@testing-library/react";
import * as THREE from "three";
import { afterEach, expect, it, vi } from "vitest";
import { CameraLayer } from "../src/views/Scene3D";
import { buildFieldIndex } from "../src/workspace/fieldIndex";

