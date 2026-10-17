import { memo, useMemo, useRef } from "react";
import { secondsFrom } from "./data";
import { useCurrentMessage } from "./useCurrentMessage";
import { timeFormatter } from "./timeDisplay";
import { type Info } from "./types";
import type { Widget } from "./widgets";

