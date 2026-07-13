import { expect, test } from "vitest";
import { SDK_VERSION, TriggairError, createClient } from "./index";

test("public entry exports the client factory, error, and version", () => {
  expect(typeof createClient).toBe("function");
  expect(TriggairError.prototype).toBeInstanceOf(Error);
  expect(SDK_VERSION).toBe("0.1.0");
});
