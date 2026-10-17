import { describe, expect, it } from "vitest";
import {
  canMove, containerLayout, initialWorkspace, leaves, ownerOf, requestedSeries, subtreeIds,
  workspaceReducer as reduce, type Container, type WorkspaceState,
} from "./widgets";
import { keyOf, type Selected } from "./types";

