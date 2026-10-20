import { expect, it } from "vitest";
import { writerOptions } from "../src/writer-options.js";
import { testConfig } from "./utils/state.js";

it("sends to the configured endpoint under the project the turn asked for", () => {
  const config = { ...testConfig("/state.json"), apiKey: "key", apiUrl: "https://ls.test" };
  expect(writerOptions(config, "turn-project")).toMatchObject({
    destinations: [{ apiKey: "key", apiUrl: "https://ls.test", projectName: "turn-project" }],
    redact: true,
  });
});

it("passes replicas and extra redaction rules through, and only when there are some", () => {
  const plain = writerOptions(testConfig("/state.json"), "p");
  expect(plain).not.toHaveProperty("replicas");
  expect(plain).not.toHaveProperty("redactExtraRules");

  const config = {
    ...testConfig("/state.json"),
    replicas: [{ projectName: "mirror", apiUrl: "https://mirror.test" }],
    redactExtraRules: [{ pattern: "secret-[0-9]+", replace: "X" }],
  };
  expect(writerOptions(config, "p")).toMatchObject({
    replicas: config.replicas,
    redactExtraRules: config.redactExtraRules,
  });
});
