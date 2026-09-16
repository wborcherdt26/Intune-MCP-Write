import { describe, it, expect } from "vitest";
import {
  modifyListClauseValue,
  readListClauseValues,
  MEMBERSHIP_RULE_MAX_LENGTH,
} from "../tools/membership-rule.js";

// A realistic rule shaped like the production Dutchie groups: an accountEnabled guard
// -and'd with a jobTitle -in [...] list, bare commas, double quotes, and values that
// themselves contain commas ("Administrator, Finance Systems", "Director,IT GRC").
const DUTCHIE_RULE =
  '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant","Administrator, Finance Systems","Director,IT GRC","Manager, Area"])';

describe("modifyListClauseValue — add", () => {
  it("appends a new value and preserves the rest of the rule byte-for-byte", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", "Manager, Dual District");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.newCount).toBe(r.previousCount + 1);
    expect(r.newRule).toBe(
      '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant","Administrator, Finance Systems","Director,IT GRC","Manager, Area","Manager, Dual District"])'
    );
    // Guard clause untouched.
    expect(r.newRule.startsWith("(user.accountEnabled -eq true) and ")).toBe(true);
  });

  it("is idempotent when the value already exists (case-insensitive)", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", "accountant");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.newRule).toBe(DUTCHIE_RULE);
    expect(r.newCount).toBe(r.previousCount);
  });

  it("does not treat a prefix as an existing value (adds 'Manager' even though 'Manager, Area' exists)", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", "Manager");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.values).toContain("Manager");
    expect(r.values).toContain("Manager, Area");
  });

  it("unwraps a value the caller supplied already quoted", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", '"Buyer"');
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRule).toContain('"Buyer"');
    expect(r.newRule).not.toContain('""Buyer""');
  });
});

describe("modifyListClauseValue — remove", () => {
  it("removes an existing value and keeps commas correct", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "remove", "Director,IT GRC");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.values).not.toContain("Director,IT GRC");
    expect(r.newRule).toBe(
      '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant","Administrator, Finance Systems","Manager, Area"])'
    );
  });

  it("is a no-op when the value is absent", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "remove", "Nonexistent Title");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(false);
    expect(r.newRule).toBe(DUTCHIE_RULE);
  });

  it("removes case-insensitively", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "remove", "MANAGER, AREA");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.changed).toBe(true);
    expect(r.values).not.toContain("Manager, Area");
  });
});

describe("round-trip guard (refuses unsafe edits, no write)", () => {
  it("refuses when the list holds an unquoted token", () => {
    const rule = 'user.jobTitle -in ["Accountant", foo, "Buyer"]';
    const r = modifyListClauseValue(rule, "user.jobTitle", "add", "X");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/can't safely parse|full rule/i);
  });

  it("refuses on an unterminated quote", () => {
    const rule = 'user.jobTitle -in ["Accountant","Buyer]';
    const r = modifyListClauseValue(rule, "user.jobTitle", "add", "X");
    expect(r.ok).toBe(false);
  });

  it("does not let a ']' inside a quoted value end the list", () => {
    const rule = 'user.jobTitle -in ["Weird] Title","Buyer"]';
    const r = readListClauseValues(rule, "user.jobTitle");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual(["Weird] Title", "Buyer"]);
  });
});

describe("clause location", () => {
  it("refuses when the attribute is not present as an -in list (e.g. -eq chain)", () => {
    const rule = '(user.jobTitle -eq "A") -or (user.jobTitle -eq "B")';
    const r = modifyListClauseValue(rule, "user.jobTitle", "add", "C");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/-eq\/-or chain|different operator|No .* clause/i);
  });

  it("refuses when the same attribute+operator appears in multiple clauses", () => {
    const rule = 'user.jobTitle -in ["A"] -or user.jobTitle -in ["B"]';
    const r = modifyListClauseValue(rule, "user.jobTitle", "add", "C");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/ambiguous|multiple/i);
  });

  it("does not false-match an attribute that is a prefix of a longer one", () => {
    const rule = 'user.jobTitleExtended -in ["A","B"]';
    const r = modifyListClauseValue(rule, "user.jobTitle", "add", "C");
    expect(r.ok).toBe(false); // no `user.jobTitle -in [` clause
  });

  it("handles the -notIn operator", () => {
    const rule = 'user.department -notIn ["Sales","Legal"]';
    const r = modifyListClauseValue(rule, "user.department", "add", "Finance", "-notIn");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.newRule).toBe('user.department -notIn ["Sales","Legal","Finance"]');
  });
});

describe("input validation", () => {
  it("rejects a value containing a double-quote", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", 'Bad"Title');
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/double-quote/i);
  });

  it("rejects an empty value", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", "   ");
    expect(r.ok).toBe(false);
  });

  it("rejects an unsupported operator", () => {
    const r = modifyListClauseValue(DUTCHIE_RULE, "user.jobTitle", "add", "X", "-eq");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.reason).toMatch(/operator/i);
  });
});

describe("readListClauseValues", () => {
  it("returns the parsed values in document order", () => {
    const r = readListClauseValues(DUTCHIE_RULE, "user.jobTitle");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.values).toEqual([
      "Accountant",
      "Administrator, Finance Systems",
      "Director,IT GRC",
      "Manager, Area",
    ]);
  });
});

describe("MEMBERSHIP_RULE_MAX_LENGTH", () => {
  it("is Entra's documented cap", () => {
    expect(MEMBERSHIP_RULE_MAX_LENGTH).toBe(3072);
  });
});
