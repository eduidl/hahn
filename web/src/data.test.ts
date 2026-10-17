describe("plot data", () => {
  it("subtracts nanoseconds before converting to a JS number", () => {
    expect(secondsFrom("1760000000123456790", "1760000000123456789")).toBe(
      1e-9,
    );
    const p = point(
      { time_ns: "1760000000123456790", values: ["9007199254740993"] },
      0,
      "1760000000123456789",
    );
    expect(p.raw).toBe("9007199254740993");
    expect(p.x).toBe(1e-9);
  });
  it("preserves gaps and handles duplicates in cursor lookup", () => {
    const points = [1, 1, 3].map((x, i) => ({
      x,
      y: i,
      raw: i,
      ns: String(x),
    }));
    expect(nearest(points, 1)).toBe(points[0]);
    expect(nearest(points, 2.9)).toBe(points[2]);
    expect(nearest([], 0)).toBeUndefined();
    expect(point({ time_ns: "1", values: [null] }, 0, "0").y).toBeNull();
  });
  it("maps enum labels to their numeric discrete-axis category while preserving the label", () => {
    const p = point(
      { time_ns: "12", values: ["ACTIVE"] },
      0,
      "10",
      [{ name: "IDLE", value: 0 }, { name: "ACTIVE", value: 1 }],
    );
    expect(p.y).toBe(1);
    expect(p.raw).toBe("ACTIVE");
    expect(p.x).toBe(2e-9);
  });
  it("merges out-of-order batches stably while retaining duplicate timestamps", () => {
    const p = (x: number, raw: string) => ({ x, y: x, ns: String(x), raw });
    const existing = [p(1, "first"), p(3, "old")];
    const result = appendPoints(existing, [p(3, "new"), p(2, "middle")]);
    expect(result.map((p) => p.raw)).toEqual(["first", "middle", "old", "new"]);
    expect(appendPoints(result, [p(4, "last")])).toBe(result);
  });
});
describe("NDJSON", () => {
  it("accepts arbitrary network chunk boundaries", async () => {
    const encoder = new TextEncoder();
    const chunks = [
      '{"type":"batch","rows":[',
      '],"scanned_messages":0}\n{"type":"com',
      'plete","scanned_messages":0}\n',
    ];
    const response = new Response(
      new ReadableStream({
        start(c) {
          chunks.forEach((s) => c.enqueue(encoder.encode(s)));
          c.close();
        },
      }),
    );
    const events: StreamEvent[] = [];
    await consumeStream(response, (event) => events.push(event));
    expect(events.map((e) => e.type)).toEqual(["batch", "complete"]);
  });
  it("reports truncation and in-stream failures", async () => {
    await expect(
      consumeStream(
        new Response('{"type":"batch","rows":[],"scanned_messages":0}\n'),
        () => {},
      ),
    ).rejects.toThrow("before completion");
    await expect(
      consumeStream(
        new Response('{"type":"error","message":"Decode failed"}\n'),
        () => {},
      ),
    ).rejects.toThrow("Decode failed");
  });
});
