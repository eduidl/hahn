import { describe, expect, it } from "vitest";
import {
  displayType,
  flattenFields,
  enumDefinitionsMatch,
  isNumericField,
  kindsMatch,
  parseDrop,
  seriesKind,
  valueKind,
  type Selected,
  type Topic,
} from "../src/types";

const topics: Topic[] = [
  {
    source: "r/0",
    topic: "/pose",
    schema_name: "Pose",
    schema_encoding: null,
    views: [],
    fields: [
      { path: ["position", "x"], data_type: "float64" },
      ...(["string", "bool", "enum", "list", "struct"] as const).map((data_type) => ({
        path: [data_type],
        data_type,
      })),
    ],
    message_count: 10,
    error: null,
  },
  {
    source: "r/0",
    topic: "/unreadable",
    schema_name: null,
    schema_encoding: null,
    views: [],
    fields: [],
    message_count: 10,
    error: "No decoder",
  },
];

describe("topic drops", () => {
  it("recognizes numeric kinds returned by mcapdecode", () => {
    for (const kind of [
      "int8",
      "int16",
      "int32",
      "int64",
      "uint8",
      "uint16",
      "uint32",
      "uint64",
      "float32",
      "float64",
    ])
      expect(valueKind(kind)).toEqual({ type: "numeric" });
    expect(valueKind("float64[]")).toEqual({ type: "other" });
    expect(displayType("float64", "protobuf")).toBe("double");
  });
  it("accepts known topics and fields independently of plot support", () => {
    expect(parseDrop('{"source":"r/0","topic":"/pose"}', topics)).toEqual({
      source: "r/0",
      topic: "/pose",
    });
    expect(parseDrop('{"source":"r/0","topic":"/pose","path":["position","x"]}', topics)).toEqual({
      source: "r/0",
      topic: "/pose",
      path: ["position", "x"],
    });
    expect(parseDrop('{"source":"r/0","topic":"/unreadable"}', topics)).toEqual({
      source: "r/0",
      topic: "/unreadable",
    });
    for (const field of topics[0].fields) {
      expect(
        parseDrop(JSON.stringify({ source: "r/0", topic: "/pose", path: field.path }), topics),
      ).toEqual({ source: "r/0", topic: "/pose", path: field.path });
      expect(isNumericField(field)).toBe(field.data_type === "float64");
    }
  });
  it("matches enum domains by variant names and values regardless of declaration order", () => {
    expect(
      enumDefinitionsMatch(
        [
          { name: "IDLE", value: "0" },
          { name: "RUN", value: "1" },
        ],
        [
          { name: "RUN", value: "1" },
          { name: "IDLE", value: "0" },
        ],
      ),
    ).toBe(true);
    expect(
      enumDefinitionsMatch([{ name: "RUN", value: "1" }], [{ name: "ACTIVE", value: "1" }]),
    ).toBe(false);
  });
  it("rejects unknown fields and malformed payloads", () => {
    for (const text of [
      "null",
      "{}",
      "hello",
      '{"topic":"/unknown"}',
      // Topic names are only unique within their recording.
      '{"source":"r/1","topic":"/pose"}',
      '{"topic":"/pose"}',
      '{"topic":"/pose","path":"position.x"}',
      '{"topic":"/pose","path":["unknown"]}',
    ])
      expect(parseDrop(text, topics)).toBeNull();
  });
  it("derives the widget kind from its first series and treats an empty widget as unconstrained", () => {
    const idle = [{ name: "IDLE", value: "0" }];
    const selected = (dataType: string, enumValues?: typeof idle): Selected => ({
      key: dataType,
      source: "r/0",
      topic: "/t",
      path: [dataType],
      color: "",
      lineWidth: 1,
      hidden: false,
      dataType,
      enumValues,
    });
    expect(seriesKind([])).toBeNull();
    expect(seriesKind([selected("float64"), selected("bool")])).toEqual({ type: "numeric" });
    expect(kindsMatch(valueKind("uint8"), valueKind("float32"))).toBe(true);
    expect(kindsMatch(valueKind("float64"), valueKind("bool"))).toBe(false);
    expect(kindsMatch(valueKind("enum", idle), valueKind("enum", [...idle]))).toBe(true);
    expect(
      kindsMatch(valueKind("enum", idle), valueKind("enum", [{ name: "RUN", value: "0" }])),
    ).toBe(false);
    expect(valueKind("u8[]")).toEqual({ type: "other" });
  });
  it("names primitive types in the schema's own language", () => {
    expect(displayType("uint32", "ros2msg")).toBe("uint32");
    expect(displayType("float32[36]", "ros2idl")).toBe("float32[36]");
    expect(displayType("bytes[<=16]", "ros2msg")).toBe("uint8[]");
    expect(displayType("string[<=8]", "ros2msg")).toBe("string");
    expect(displayType("float64", "protobuf")).toBe("double");
    expect(displayType("bytes", "protobuf")).toBe("bytes");
    expect(displayType("uint32")).toBe("uint32");
  });
  it("classifies strings, including bounded ones, as their own kind", () => {
    expect(valueKind("string")).toEqual({ type: "string" });
    expect(valueKind("string[<=8]")).toEqual({ type: "string" });
    expect(valueKind("wstring")).toEqual({ type: "string" });
    expect(valueKind("string[]")).toEqual({ type: "other" });
  });
});

describe("flattenFields", () => {
  it("flattens structs but not list elements", () => {
    const fields = flattenFields([
      { name: "pose", data_type: "struct", fields: [{ name: "x", data_type: "float64" }] },
      {
        name: "points",
        data_type: "list",
        element: { data_type: "struct", fields: [{ name: "y", data_type: "float64" }] },
      },
    ]);
    expect(fields.map((field) => field.path)).toEqual([["pose"], ["pose", "x"], ["points"]]);
  });
});
