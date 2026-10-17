import { useEffect, useRef, useState } from "react";
import { appendPoints, consumeStream, point } from "./data";
import type { Series } from "./Plot";
import { errorMessage, type Info, type Selected } from "./types";

export type CachedSeries = Series & {
  topic: string;
  status: "loading" | "complete" | "stopped" | "error";
  received: number;
  error?: string;
};

