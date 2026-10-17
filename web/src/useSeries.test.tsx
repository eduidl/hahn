const info: Info = {
  start_ns: "1000000000",
  end_ns: "2000000000",
  message_count: 2,
};
const field = (name: string): Selected => ({
  key: keyOf("/pose", [name]),
  topic: "/pose",
  path: [name],
  color: "#91b8ff",
  lineWidth: 1.5,
  hidden: false,
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

