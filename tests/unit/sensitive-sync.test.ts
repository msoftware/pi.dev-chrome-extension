import { describe, expect, it } from "vitest";
import * as shared from "../../packages/shared/src/sensitive";
import * as local from "../../extension/src/content/sensitive";

describe("content-script copy of the sensitive-field definition", () => {
  it("matches the shared definition", () => {
    expect(local.SENSITIVE_AUTOCOMPLETE).toEqual(shared.SENSITIVE_AUTOCOMPLETE);
    expect(local.SENSITIVE_TYPES).toEqual(shared.SENSITIVE_TYPES);
    expect(local.REDACTED).toBe(shared.REDACTED);
    for (const a of [{ type: "password" }, { type: "text", autocomplete: "cc-csc" }, { type: "email" }, { type: "hidden" }]) {
      expect(local.isSensitiveField(a)).toBe(shared.isSensitiveField(a));
    }
  });
});
