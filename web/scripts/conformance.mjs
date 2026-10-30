// Checks a running server against protocol/openapi.json over HTTP, independent of its language.
// The server must serve the recordings in data/samples/.
import { readFileSync } from "node:fs";
import Ajv from "ajv/dist/2020.js";

const base = process.env.BASE_URL;
if (!base) throw new Error("Set BASE_URL to the server under test");
const spec = JSON.parse(readFileSync(new URL("../../protocol/openapi.json", import.meta.url), "utf8"));
const ajv = new Ajv({ strict: false, validateFormats: false, allErrors: true });
const exercised = new Set();
const failures = [];
// Report on exit too, so failures explain a later crash on missing data.
process.on("exit", () => failures.forEach((failure) => console.error(`FAIL ${failure}`)));

const parse = (media, bytes) => {
  if (media === FRAMES) return parseFrames(bytes);
  const text = new TextDecoder().decode(bytes);
  if (media === "application/x-ndjson")
    return text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return [JSON.parse(text)];
};

/** Sends the request and checks the response against `method path` in the spec. */
async function check(path, url, expected, init = {}) {
  const method = (init.method ?? "GET").toLowerCase();
  const context = `${method} ${url} -> ${expected}`;
  exercised.add(`${method} ${path}`);
  const response = await fetch(base + url, init);
  const bytes = await response.arrayBuffer();
  const fail = (reason) => {
    failures.push(`${context}: ${reason}`);
    return [];
  };
  if (response.status !== expected) return fail(`got ${response.status}: ${new TextDecoder().decode(bytes).slice(0, 200)}`);
  const media = response.headers.get("content-type")?.split(";")[0] ?? "";
  const declared = spec.paths[path]?.[method]?.responses[expected];
  // A response shared between operations is a reference into components.
  const described = declared?.$ref ? spec.components.responses[declared.$ref.split("/").at(-1)] : declared;
  const schema = described?.content?.[media]?.schema;
  if (!schema) return fail(`${media} is not in the spec`);
  const validate = ajv.compile({ allOf: [schema], components: spec.components });
  let values;
  try {
    values = parse(media, bytes);
  } catch (error) {
    return fail(`unparsable ${media}: ${error}`);
  }
  for (const value of values)
    if (!validate(value))
      return fail(`${ajv.errorsText(validate.errors)}\n  ${JSON.stringify(value).slice(0, 300)}`);
  return values;
}

const endsComplete = (url, events) => {
  if (!events.some((e) => e.type === "batch")) failures.push(`${url}: no batch event`);
  if (events.at(-1)?.type !== "complete") failures.push(`${url}: does not end with complete`);
};

const unknown = "/api/runs/no-such-run";
const [{ items: runs }] = await check("/api/runs", "/api/runs?limit=200", 200);
for (const limit of ["0", "201", "x"]) await check("/api/runs", `/api/runs?limit=${limit}`, 400);
const [limited] = await check("/api/runs", "/api/runs?limit=1", 200);
if (limited.items.length !== 1 || limited.truncated !== runs.length > 1)
  failures.push("limit=1: wrong items or truncated");
const named = runs[0].name;
const [found] = await check("/api/runs", `/api/runs?${new URLSearchParams({ q: named.toUpperCase() })}`, 200);
if (!found.items.some((r) => r.id === runs[0].id) || found.items.some((r) => !r.name.toLowerCase().includes(named.toLowerCase())))
  failures.push(`q=${named}: wrong matches`);
const [noRuns] = await check("/api/runs", "/api/runs?q=no-such-run", 200);
if (noRuns.items.length || noRuns.truncated) failures.push("q=no-such-run: expected nothing");
await check("/api/runs/{run}", unknown, 404);
let root;
let visual;
for (const run of runs) {
  const [detail] = await check("/api/runs/{run}", `/api/runs/${run.id}`, 200);
  const demo = detail.groups.find((g) => g.name.includes("demo"));
  if (demo) root = `/api/runs/${run.id}/groups/${demo.id}`;
  const recorded = detail.groups.find((g) => g.name.includes("visual"));
  if (recorded) visual = `/api/runs/${run.id}/groups/${recorded.id}`;
}
if (!root) throw new Error("data/samples/demo.mcap is not being served");
if (!visual) throw new Error("data/samples/visual.mcap is not being served");
const runRoot = root.slice(0, root.indexOf("/groups/"));

const info = "/api/runs/{run}/groups/{group}";
await check(info, root, 200);
await check(info, `${unknown}/groups/x`, 404);
await check(info, `${runRoot}/groups/no-such-group`, 404);
const topicsPath = `${info}/topics`;
const [topics] = await check(topicsPath, `${root}/topics`, 200);
await check(topicsPath, `${unknown}/groups/x/topics`, 404);
const topic = topics.find((t) => !t.error && t.message_count);
const scalarPaths = (fields, prefix = []) =>
  fields.flatMap((f) => {
    const path = [...prefix, f.name];
    if (f.fields) return scalarPaths(f.fields, path);
    return f.element ? [] : [path];
  });
const scalars = scalarPaths(topic.fields);

const messages = `${info}/messages`;
const historyUrl = (params, at = root) => `${at}/messages?${new URLSearchParams(params)}`;
const whole = await check(messages, historyUrl({ topic: topic.topic }), 200);
endsComplete(messages, whole);
const first = whole.find((e) => e.type === "batch")?.rows[0].value;
if (topic.fields.some((f) => !(f.name in (first ?? {}))))
  failures.push(`${messages}: a struct must name its fields`);
for (const path of scalars) {
  const exact = await check(messages, historyUrl({ topic: topic.topic, path: JSON.stringify(path), preview: "false" }), 200);
  endsComplete(`${messages} ${path}`, exact);
}
await check(messages, historyUrl({ topic: topic.topic, start_ns: "2", end_ns: "1" }), 400);
await check(messages, historyUrl({ topic: topic.topic, start_ns: "x" }), 400);
await check(messages, historyUrl({ topic: topic.topic, path: "nope" }), 400);
await check(messages, historyUrl({ topic: topic.topic, preview: "maybe" }), 400);
await check(messages, `${root}/messages`, 400);
await check(messages, historyUrl({ topic: topic.topic }, `${unknown}/groups/x`), 404);
await check(messages, historyUrl({ topic: "/nope" }), 422);
await check(messages, historyUrl({ topic: topic.topic, path: '["nope"]' }), 422);
await check(messages, historyUrl({ topic: topic.topic, preview: "false" }), 422);

for (const { name } of topic.meta_fields) {
  endsComplete(`${messages} ${name}`, await check(messages, historyUrl({ topic: topic.topic, meta: name }), 200));
}
await check(messages, historyUrl({ topic: topic.topic, meta: "no-such-meta" }), 422);
await check(messages, historyUrl({ topic: topic.topic, meta: "x", path: "[]" }), 400);

const message = `${info}/messages/latest`;
const query = (params) => `${root}/messages/latest?${new URLSearchParams(params)}`;
await check(message, query({ topic: topic.topic, time_ns: "18446744073709551615" }), 200);
await check(message, query({ topic: topic.topic, time_ns: "x" }), 400);
await check(message, query({ topic: topic.topic }), 400);
await check(message, `${unknown}/groups/x/messages/latest?topic=x&time_ns=1`, 404);
await check(message, query({ topic: "/nope", time_ns: "1" }), 422);

const [visualTopics] = await check(topicsPath, `${visual}/topics`, 200);
const viewed = visualTopics.filter((t) => t.views.length);
if (!viewed.length) failures.push(`${topicsPath}: no topic declares a view`);
if (topics.some((t) => t.views.length)) failures.push(`${topicsPath}: plain samples declare a view`);
const viewsPath = `${info}/views`;
const latestViewPath = `${info}/views/latest`;
const viewUrl = (path, params, at = visual) => `${at}/${path}?${new URLSearchParams(params)}`;
for (const { topic: name, views } of viewed)
  for (const { id: view, kind } of views) {
    const events = await check(viewsPath, viewUrl("views", { topic: name, view }), 200);
    if (events.at(-1)?.type !== "complete") failures.push(`${viewsPath} ${name}: does not end with complete`);
    const frame = events.find((e) => e.type === "frame" && e.value);
    if (frame?.value.kind !== kind) failures.push(`${viewsPath} ${name}: no ${kind} frame`);
    const params = { topic: name, view, time_ns: frame.time_ns };
    const [current] = await check(latestViewPath, viewUrl("views/latest", params), 200);
    if (current.type !== "frame" || current.time_ns !== frame.time_ns)
      failures.push(`${latestViewPath} ${name}: expected the frame at its own time`);
    const [held] = await check(latestViewPath, viewUrl("views/latest", { ...params, known_time_ns: frame.time_ns }), 200);
    if (held.type !== "unchanged") failures.push(`${latestViewPath} ${name}: expected unchanged`);
    const [none] = await check(latestViewPath, viewUrl("views/latest", { ...params, time_ns: "0" }), 200);
    if (none.type !== "complete") failures.push(`${latestViewPath} ${name}: expected no frame before the start`);
  }
const [{ topic: viewedTopic, views: [{ id: viewId }] }] = viewed;
await check(viewsPath, viewUrl("views", { topic: viewedTopic, view: viewId, start_ns: "2", end_ns: "1" }), 400);
await check(viewsPath, viewUrl("views", { topic: viewedTopic, view: "no-such-view" }), 422);
await check(viewsPath, viewUrl("views", { topic: "/nope", view: viewId }), 422);
await check(viewsPath, viewUrl("views", { topic: viewedTopic, view: viewId }, `${unknown}/groups/x`), 404);
await check(latestViewPath, viewUrl("views/latest", { topic: viewedTopic, view: viewId }), 400);
await check(latestViewPath, viewUrl("views/latest", { topic: viewedTopic, view: viewId, time_ns: "1", known_time_ns: "x" }), 400);
await check(latestViewPath, viewUrl("views/latest", { topic: viewedTopic, view: "no-such-view", time_ns: "1" }), 422);
await check(latestViewPath, viewUrl("views/latest", { topic: viewedTopic, view: viewId, time_ns: "1" }, `${unknown}/groups/x`), 404);

// An operation added to the spec must be implemented and exercised here.
for (const [path, item] of Object.entries(spec.paths))
  for (const method of Object.keys(item))
    if (!exercised.has(`${method} ${path}`)) failures.push(`${method} ${path}: not exercised`);

process.exitCode = failures.length ? 1 : 0;
console.log(failures.length ? `${failures.length} failures` : `OK: ${exercised.size} operations conform`);
