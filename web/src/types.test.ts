import { describe, expect, it } from "vitest";
import { displayType, enumDefinitionsMatch, isNumericField, isStateField, kindsMatch, parseDrop, seriesKind, valueKind, type Selected, type Topic } from "./types";

const topics: Topic[] = [
  {
    topic: "/pose",
    schema_name: "Pose",
    fields: [
      { path: ["position", "x"], data_type: "f64" },
      ...["string", "bool", "enum", "u8[]", "struct"].map((data_type) => ({
        path: [data_type],
        data_type,
      })),
    ],
    message_count: 10,
    error: null,
  },
  {
    topic: "/unreadable",
    schema_name: null,
    fields: [],
    message_count: 10,
    error: "No decoder",
  },
];

describe("topic drops", () => {
  it("accepts known topics and fields independently of plot support", () => {
    expect(parseDrop('{"topic":"/pose"}', topics)).toEqual({ topic: "/pose" });
    expect(
      parseDrop('{"topic":"/pose","path":["position","x"]}', topics),
    ).toEqual({ topic: "/pose", path: ["position", "x"] });
    expect(parseDrop('{"topic":"/unreadable"}', topics)).toEqual({
      topic: "/unreadable",
    });
    for (const field of topics[0].fields) {
      expect(
        parseDrop(JSON.stringify({ topic: "/pose", path: field.path }), topics),
      ).toEqual({ topic: "/pose", path: field.path });
      expect(isNumericField(field)).toBe(field.data_type === "f64");
      expect(isStateField(field)).toBe(["bool", "enum"].includes(field.data_type));
    }
  });
  it("matches enum domains by variant names and values regardless of declaration order", () => {
    expect(enumDefinitionsMatch([{ name: "IDLE", value: 0 }, { name: "RUN", value: 1 }], [{ name: "RUN", value: 1 }, { name: "IDLE", value: 0 }])).toBe(true);
    expect(enumDefinitionsMatch([{ name: "RUN", value: 1 }], [{ name: "ACTIVE", value: 1 }])).toBe(false);
  });
  it("rejects unknown fields and malformed payloads", () => {
    for (const text of [
      "null",
      "{}",
      "hello",
      '{"topic":"/unknown"}',
      '{"topic":"/pose","path":"position.x"}',
      '{"topic":"/pose","path":["unknown"]}',
    ])
      expect(parseDrop(text, topics)).toBeNull();
  });
  it("derives the widget kind from its first series and treats an empty widget as unconstrained", () => {
    const idle = [{ name: "IDLE", value: 0 }];
    const selected = (dataType: string, enumValues?: typeof idle): Selected => ({
      key: dataType, topic: "/t", path: [dataType], color: "", lineWidth: 1, hidden: false, dataType, enumValues,
    });
    expect(seriesKind([])).toBeNull();
    expect(seriesKind([selected("f64"), selected("bool")])).toEqual({ type: "numeric" });
    expect(kindsMatch(valueKind("u8"), valueKind("f32"))).toBe(true);
    expect(kindsMatch(valueKind("f64"), valueKind("bool"))).toBe(false);
    expect(kindsMatch(valueKind("enum", idle), valueKind("enum", [...idle]))).toBe(true);
    expect(kindsMatch(valueKind("enum", idle), valueKind("enum", [{ name: "RUN", value: 0 }]))).toBe(false);
    expect(valueKind("string")).toBeNull();
  });
  it("names primitive types in the schema's own language", () => {
    expect(displayType("u32", "ros2msg")).toBe("uint32");
    expect(displayType("f32[36]", "ros2idl")).toBe("float32[36]");
    expect(displayType("bytes[<=16]", "ros2msg")).toBe("uint8[]");
    expect(displayType("string[<=8]", "ros2msg")).toBe("string");
    expect(displayType("f64", "protobuf")).toBe("double");
    expect(displayType("bytes", "protobuf")).toBe("bytes");
    expect(displayType("u32")).toBe("u32");
  });
});
