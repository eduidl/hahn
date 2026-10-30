// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { TimeZoneSelect } from "./TimeZoneSelect";
import { browserTimeZone } from "./timeDisplay";

const select = () => screen.getByLabelText("タイムゾーン") as HTMLSelectElement;
afterEach(cleanup);

