/**
 * Pure (Graph-free) helpers for editing a single `attribute -in [...]` / `-notIn [...]`
 * clause inside an Entra ID dynamic-group membership rule.
 *
 * DESIGN — safety over cleverness. Membership rules are arbitrary boolean expressions
 * (-and/-or, parentheses, negation, -eq/-ne/-contains/-match/-startsWith, -any/-all on
 * multivalued props). We deliberately do NOT parse that grammar. We locate exactly one
 * `<attribute> <operator> [ <quoted,list> ]` clause and edit only its bracketed list,
 * splicing the rest of the rule back byte-for-byte.
 *
 * The core safety rail is the ROUND-TRIP GUARD (see parseQuotedList): if the bracketed
 * content is not a clean sequence of double-quoted strings — i.e. it contains nested
 * expressions, unquoted tokens, or anything we can't fully account for — we refuse to
 * edit and tell the caller to use the full-rule-replacement tool. This turns
 * "silently corrupt a 90-item rule" into "safely decline".
 */

export type RuleValueAction = "add" | "remove";

export interface RuleEditSuccess {
  ok: true;
  newRule: string;
  /** false when the edit was a no-op (add of an existing value / remove of an absent one). */
  changed: boolean;
  /** Resulting values, in document order. */
  values: string[];
  previousCount: number;
  newCount: number;
}

export interface RuleEditFailure {
  ok: false;
  /** Human-readable guidance. Callers surface this as a plain (non-error) result. */
  reason: string;
}

export type RuleEditOutcome = RuleEditSuccess | RuleEditFailure;

/** Entra caps membershipRule at 3072 characters. */
export const MEMBERSHIP_RULE_MAX_LENGTH = 3072;

const DEFAULT_OPERATOR = "-in";
const SUPPORTED_OPERATORS = new Set(["-in", "-notin"]);

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Remove insignificant whitespace — whitespace that is OUTSIDE double-quoted strings.
 * Whitespace inside a value (e.g. "Administrator, Finance Systems") is preserved.
 */
function stripInsignificantWhitespace(s: string): string {
  let out = "";
  let inQuote = false;
  for (const ch of s) {
    if (ch === '"') {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && /\s/.test(ch)) continue;
    out += ch;
  }
  return out;
}

/** Serialize values to canonical bracket-list body: "a","b","c" (no spaces). */
function serializeValues(values: string[]): string {
  return values.map((v) => `"${v}"`).join(",");
}

interface LocatedClause {
  /** Index of the opening '[' of the list. */
  listStart: number;
  /** Index of the closing ']' of the list. */
  listEnd: number;
  /** Raw text between '[' and ']' (exclusive). */
  rawList: string;
}

/**
 * Find the single `<attribute> <operator> [ ... ]` clause. Returns a failure reason if
 * the clause is missing or appears more than once (ambiguous). Bracket matching is
 * quote-aware so a ']' inside a quoted value does not end the list.
 */
function locateClause(
  rule: string,
  attribute: string,
  operator: string
): LocatedClause | { error: string } {
  // `\s*` (not `\s+`) between tokens: rules almost always have spaces, but the operator
  // starts with '-' (non-word) and we anchor on a following '[', so prefix false-matches
  // like "user.jobTitleExtended" are already excluded.
  const pattern = new RegExp(
    `${escapeRegex(attribute)}\\s*${escapeRegex(operator)}\\s*\\[`,
    "gi"
  );

  const opens: number[] = [];
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(rule)) !== null) {
    opens.push(m.index + m[0].length - 1); // index of the '['
    if (m.index === pattern.lastIndex) pattern.lastIndex++; // guard against zero-width
  }

  if (opens.length === 0) {
    return {
      error:
        `No \`${attribute} ${operator} [...]\` clause found in the rule. ` +
        `The attribute may use a different operator, or be expressed as an ` +
        `-eq/-or chain rather than a list. Use update_group_membership_rule to set the full rule.`,
    };
  }
  if (opens.length > 1) {
    return {
      error:
        `Found ${opens.length} \`${attribute} ${operator} [...]\` clauses — ambiguous which to edit. ` +
        `Use update_group_membership_rule to set the full rule.`,
    };
  }

  const listStart = opens[0];
  // Quote-aware scan for the matching ']'.
  let inQuote = false;
  for (let i = listStart + 1; i < rule.length; i++) {
    const ch = rule[i];
    if (ch === '"') inQuote = !inQuote;
    else if (ch === "]" && !inQuote) {
      return { listStart, listEnd: i, rawList: rule.slice(listStart + 1, i) };
    }
  }
  return {
    error:
      `The \`${attribute} ${operator}\` list is not properly closed (no matching ']'). ` +
      `Use update_group_membership_rule to set the full rule.`,
  };
}

/**
 * Parse the bracketed body into values, and verify the parse is FAITHFUL (round-trip
 * guard). Extracts only double-quoted strings; if re-serializing them does not reproduce
 * the body (modulo insignificant whitespace), the body held something we cannot safely
 * edit, so `faithful` is false.
 */
function parseQuotedList(rawList: string): { values: string[]; faithful: boolean } {
  const values: string[] = [];
  let inQuote = false;
  let current = "";
  for (const ch of rawList) {
    if (ch === '"') {
      if (inQuote) {
        values.push(current);
        current = "";
      }
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) current += ch;
  }

  // Unterminated quote → not faithful.
  if (inQuote) return { values, faithful: false };

  const faithful =
    stripInsignificantWhitespace(rawList) === serializeValues(values);
  return { values, faithful };
}

/** Normalize a value for idempotent comparison: trim ends + case-insensitive. */
function normalizeForMatch(v: string): string {
  return v.trim().toLowerCase();
}

/** Strip a single pair of surrounding double quotes, if the caller included them. */
function unwrapValue(value: string): string {
  const v = value.trim();
  if (v.length >= 2 && v.startsWith('"') && v.endsWith('"')) {
    return v.slice(1, -1);
  }
  return v;
}

/**
 * Add or remove a value from a single `attribute operator [...]` clause.
 * Preserves the rest of the rule exactly. Matching for idempotency/removal is
 * case-insensitive and end-trimmed; the stored casing is what the caller supplies (add)
 * or what already exists (unchanged values are left byte-for-byte).
 */
export function modifyListClauseValue(
  rule: string,
  attribute: string,
  action: RuleValueAction,
  value: string,
  operator: string = DEFAULT_OPERATOR
): RuleEditOutcome {
  const op = operator.toLowerCase();
  if (!SUPPORTED_OPERATORS.has(op)) {
    return {
      ok: false,
      reason: `Unsupported operator "${operator}". This tool edits -in / -notIn list clauses only.`,
    };
  }

  const cleanValue = unwrapValue(value);
  if (cleanValue.length === 0) {
    return { ok: false, reason: "Value is empty after trimming." };
  }
  if (cleanValue.includes('"')) {
    return {
      ok: false,
      reason: `Value contains a double-quote character, which cannot be represented in a rule list: ${value}`,
    };
  }

  const located = locateClause(rule, attribute, operator);
  if ("error" in located) return { ok: false, reason: located.error };

  const { listStart, listEnd, rawList } = located;
  const { values, faithful } = parseQuotedList(rawList);
  if (!faithful) {
    return {
      ok: false,
      reason:
        `The \`${attribute} ${operator}\` list contains content this tool can't safely parse ` +
        `(nested expressions, unquoted tokens, or malformed quoting). ` +
        `Use update_group_membership_rule to set the full rule.`,
    };
  }

  const previousCount = values.length;
  const target = normalizeForMatch(cleanValue);
  const existingIndex = values.findIndex((v) => normalizeForMatch(v) === target);

  let newValues: string[];
  let changed: boolean;
  if (action === "add") {
    if (existingIndex !== -1) {
      newValues = values;
      changed = false;
    } else {
      newValues = [...values, cleanValue];
      changed = true;
    }
  } else {
    if (existingIndex === -1) {
      newValues = values;
      changed = false;
    } else {
      newValues = values.filter((_, i) => i !== existingIndex);
      changed = true;
    }
  }

  if (!changed) {
    return {
      ok: true,
      newRule: rule,
      changed: false,
      values: newValues,
      previousCount,
      newCount: newValues.length,
    };
  }

  const newBody = serializeValues(newValues);
  const newRule = rule.slice(0, listStart + 1) + newBody + rule.slice(listEnd);

  return {
    ok: true,
    newRule,
    changed: true,
    values: newValues,
    previousCount,
    newCount: newValues.length,
  };
}

/**
 * Read-only helper: list the values of a single `attribute operator [...]` clause,
 * applying the same round-trip guard. Used to preview a rule before editing.
 */
export function readListClauseValues(
  rule: string,
  attribute: string,
  operator: string = DEFAULT_OPERATOR
): { ok: true; values: string[] } | RuleEditFailure {
  const located = locateClause(rule, attribute, operator);
  if ("error" in located) return { ok: false, reason: located.error };
  const { values, faithful } = parseQuotedList(located.rawList);
  if (!faithful) {
    return {
      ok: false,
      reason:
        `The \`${attribute} ${operator}\` list contains content this tool can't safely parse. ` +
        `Use update_group_membership_rule to inspect/set the full rule.`,
    };
  }
  return { ok: true, values };
}
