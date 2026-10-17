import { useEffect, useMemo, useRef, useState } from "react";
import { stateLabel } from "./data";
import type { Series } from "./Plot";
import { usePlayback, usePlaybackStore } from "./playback";
import { timeFormatter } from "./timeDisplay";
import type { Widget } from "./widgets";

