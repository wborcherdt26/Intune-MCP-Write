import { describe, it, expect } from "vitest";
import { GraphError } from "../graph.js";
import {
  errorText,
  textResult,
  errorResult,
  odataTypeLabel,
  sanitizeSearchQuery,
  formatList,
} from "../tools/shared.js";

describe("errorText", () => {
  it("returns auth message for 401", () => {
    expect(errorText(new GraphError(401, "Unauthorized"))).toContain(
      "token may have expired"
    );
  });

  it("returns access denied for 403", () => {
    const text = errorText(new GraphError(403, "Forbidden"));
    expect(text).toContain("Access denied");
    expect(text).toContain("write permissions");
  });

  it("returns not found for 404", () => {
    expect(errorText(new GraphError(404, "Not Found"))).toContain("Not found");
  });

  it("returns conflict message for 409", () => {
    expect(errorText(new GraphError(409, "Conflict"))).toContain("Conflict");
  });

  it("returns message for regular Error", () => {
    expect(errorText(new Error("something broke"))).toBe("something broke");
  });
});

describe("textResult", () => {
  it("wraps text in MCP content format", () => {
    expect(textResult("hello")).toEqual({
      content: [{ type: "text", text: "hello" }],
    });
  });
});

describe("errorResult", () => {
  it("sets isError and wraps error message", () => {
    const result = errorResult(new Error("fail"));
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toBe("fail");
  });
});

describe("odataTypeLabel", () => {
  const labels: Record<string, string> = {
    "#microsoft.graph.testType": "Test Label",
  };

  it("returns label for known type", () => {
    expect(odataTypeLabel("#microsoft.graph.testType", labels)).toBe("Test Label");
  });

  it("strips prefix for unknown type", () => {
    expect(odataTypeLabel("#microsoft.graph.unknownType", labels)).toBe("unknownType");
  });

  it("returns 'Unknown' for undefined input instead of throwing", () => {
    expect(odataTypeLabel(undefined, labels)).toBe("Unknown");
  });
});

describe("sanitizeSearchQuery", () => {
  it("doubles single quotes for OData filter safety", () => {
    expect(sanitizeSearchQuery("O'Brien")).toBe("O''Brien");
  });

  it("strips control characters", () => {
    expect(sanitizeSearchQuery("abc\x00\x1fdef")).toBe("abcdef");
  });

  it("caps length at 255 characters", () => {
    const long = "a".repeat(300);
    expect(sanitizeSearchQuery(long).length).toBe(255);
  });
});

describe("formatList", () => {
  it("joins with a single newline in compact format", () => {
    expect(formatList(["a", "b"], "compact")).toBe("a\nb");
  });

  it("joins with a separator in full format", () => {
    expect(formatList(["a", "b"], "full")).toBe("a\n\n---\n\nb");
  });
});
