export type TopicDrag = { topic: string; path?: string[] };
export const dragMime = "application/x-hahn-topic";

/** Only accept known sources; a browser drop is untrusted input. */
export function parseDrop(text: string, topics: Topic[]): TopicDrag | null {
  try {
    const payload = JSON.parse(text) as TopicDrag;
    const topic = topics.find((t) => t.topic === payload.topic);
    if (!topic) return null;
    if (
      payload.path !== undefined &&
      (!Array.isArray(payload.path) ||
        !topic.fields.some(
          (f) => JSON.stringify(f.path) === JSON.stringify(payload.path),
        ))
    )
      return null;
    return { topic: topic.topic, path: payload.path };
  } catch {
    return null;
  }
}
