import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { registerGroupMembershipTools } from "../tools/group-membership.js";
import { GraphError } from "../graph.js";

vi.mock("../logger.js", () => ({
  logger: { info: vi.fn(), error: vi.fn() },
}));

const mockGroup = {
  id: "group-uuid-1",
  displayName: "Test Group",
  description: "A test group",
  groupTypes: [],
  membershipRule: null,
  membershipRuleProcessingState: null,
  mailEnabled: false,
  securityEnabled: true,
};

const mockDynamicGroup = {
  ...mockGroup,
  id: "dynamic-group-uuid",
  displayName: "Dynamic Group",
  groupTypes: ["DynamicMembership"],
  membershipRule: "(user.department -eq \"IT\")",
  membershipRuleProcessingState: "On",
};

const mockUser = {
  id: "user-uuid-1",
  displayName: "Alice Smith",
  userPrincipalName: "alice@contoso.com",
};

type ToolHandler = (params: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}>;

function createMockServer() {
  const tools = new Map<string, ToolHandler>();
  return {
    tool: vi.fn((name: string, _desc: string, _schema: unknown, handler: ToolHandler) => {
      tools.set(name, handler);
    }),
    getHandler(name: string): ToolHandler {
      const h = tools.get(name);
      if (!h) throw new Error(`Tool "${name}" not registered`);
      return h;
    },
  };
}

function createMockGraph() {
  return {
    get: vi.fn(),
    getAll: vi.fn().mockResolvedValue({ items: [], hasMore: false }),
    getBeta: vi.fn(),
    getAllBeta: vi.fn(),
    post: vi.fn().mockResolvedValue(undefined),
    postBeta: vi.fn(),
    patch: vi.fn(),
    patchBeta: vi.fn(),
    delete: vi.fn().mockResolvedValue(undefined),
    put: vi.fn(),
  };
}

function getText(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0].text;
}

describe("add_user_to_group", () => {
  it("adds a user by UPN to an assigned group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User added to group successfully");
    expect(getText(result)).toContain("Alice Smith");
    expect(getText(result)).toContain("alice@contoso.com");
    expect(getText(result)).toContain("Test Group");
    expect(graph.post).toHaveBeenCalledWith(
      "/groups/group-uuid-1/members/$ref",
      { "@odata.id": "https://graph.microsoft.com/v1.0/directoryObjects/user-uuid-1" },
      { tool: "add_user_to_group" }
    );
  });

  it("adds a user by object ID", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "user-uuid-1" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User added to group successfully");
  });

  it("rejects adding to a dynamic group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDynamicGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "dynamic-group-uuid", userId: "alice@contoso.com" });

    expect(getText(result)).toContain("dynamic group");
    expect(getText(result)).toContain("membership controlled by a rule");
    expect(graph.post).not.toHaveBeenCalled();
  });

  it("returns error when user not found", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockRejectedValueOnce(new GraphError(404, "Not found"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "nobody@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Could not resolve");
  });

  it("returns error on 403 forbidden", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    graph.post.mockRejectedValueOnce(new GraphError(403, "Insufficient privileges"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("add_user_to_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Access denied");
  });
});

describe("remove_user_from_group", () => {
  it("removes a user by UPN from a group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("User removed from group successfully");
    expect(getText(result)).toContain("Alice Smith");
    expect(graph.delete).toHaveBeenCalledWith(
      "/groups/group-uuid-1/members/user-uuid-1/$ref",
      { tool: "remove_user_from_group" }
    );
  });

  it("rejects removing from a dynamic group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockDynamicGroup)
      .mockResolvedValueOnce(mockUser);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "dynamic-group-uuid", userId: "alice@contoso.com" });

    expect(getText(result)).toContain("dynamic group");
    expect(graph.delete).not.toHaveBeenCalled();
  });

  it("returns error when member not found (404)", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockGroup)
      .mockResolvedValueOnce(mockUser);
    graph.delete.mockRejectedValueOnce(new GraphError(404, "Resource not found"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("remove_user_from_group");
    const result = await handler({ groupId: "group-uuid-1", userId: "alice@contoso.com" });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Not found");
  });
});

describe("search_groups", () => {
  it("returns matching groups from server-side filter, full format by default", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockGroup], hasMore: false });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("search_groups");
    const result = await handler({ query: "Test" });

    expect(getText(result)).toContain("Description: A test group");
    expect(graph.getAll).toHaveBeenCalledWith(
      "/groups",
      expect.objectContaining({ $filter: "startsWith(displayName,'Test')" }),
      { tool: "search_groups" },
      25
    );
  });

  it("returns a compact one-liner per group when format is compact", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.getAll.mockResolvedValueOnce({ items: [mockGroup], hasMore: false });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("search_groups");
    const result = await handler({ query: "Test", format: "compact" });

    expect(getText(result)).toContain("Test Group | group-uuid-1 | Assigned");
    expect(getText(result)).not.toContain("Description:");
  });

  it("matches names with apostrophes via the client-side fallback (v1.3.1 regression)", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    const apostropheGroup = { ...mockGroup, displayName: "O'Brien's Team" };
    graph.getAll
      .mockResolvedValueOnce({ items: [], hasMore: false }) // server-side startsWith filter
      .mockResolvedValueOnce({ items: [apostropheGroup], hasMore: false }); // 200-item fallback
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("search_groups");
    const result = await handler({ query: "O'Brien" });

    expect(getText(result)).toContain("O'Brien's Team");
  });
});

describe("list_group_members", () => {
  const mockMember = {
    "@odata.type": "#microsoft.graph.user",
    id: "user-uuid-1",
    displayName: "Alice Smith",
    userPrincipalName: "alice@contoso.com",
    accountEnabled: true,
  };

  it("defaults to a compact one-liner per member", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    graph.getAll.mockResolvedValueOnce({ items: [mockMember], hasMore: false });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("list_group_members");
    const result = await handler({ groupId: "group-uuid-1" });

    expect(getText(result)).toContain("[User] Alice Smith (alice@contoso.com)");
  });

  it("adds account status and OS version when format is full", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    graph.getAll.mockResolvedValueOnce({ items: [mockMember], hasMore: false });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("list_group_members");
    const result = await handler({ groupId: "group-uuid-1", format: "full" });

    expect(getText(result)).toContain("Account Enabled: true");
  });
});

describe("list_device_groups", () => {
  const mockAadDevice = {
    id: "device-object-id-1",
    displayName: "LAPTOP-TEST01",
    deviceId: "aad-device-id-1",
    operatingSystem: "Windows",
    operatingSystemVersion: "10.0.19045",
    accountEnabled: true,
    trustType: "AzureAd",
  };

  it("lists the groups a device belongs to, full format by default", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockAadDevice) // resolveToObjectId's direct object-ID lookup
      .mockResolvedValueOnce(mockAadDevice); // device fetch for the header
    graph.getAll.mockResolvedValueOnce({
      items: [{ ...mockGroup, "@odata.type": "#microsoft.graph.group" }],
      hasMore: false,
    });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("list_device_groups");
    const result = await handler({ deviceId: "device-object-id-1" });

    expect(getText(result)).toContain("Description: A test group");
  });

  it("returns a compact one-liner per group when format is compact", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get
      .mockResolvedValueOnce(mockAadDevice)
      .mockResolvedValueOnce(mockAadDevice);
    graph.getAll.mockResolvedValueOnce({
      items: [{ ...mockGroup, "@odata.type": "#microsoft.graph.group" }],
      hasMore: false,
    });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("list_device_groups");
    const result = await handler({ deviceId: "device-object-id-1", format: "compact" });

    expect(getText(result)).toContain("Test Group | group-uuid-1 | Assigned");
  });
});

// A dynamic group shaped like the production Dutchie SSO groups.
const mockRuleGroup = {
  ...mockGroup,
  id: "rule-group-uuid",
  displayName: "App - Dutchie.SSO.Remote.1.Users",
  groupTypes: ["DynamicMembership"],
  membershipRule:
    '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant","Manager, Area"])',
  membershipRuleProcessingState: "On",
};

describe("rule-editing tools — destructive gate", () => {
  afterEach(() => {
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
  });

  it("does not register when ENABLE_DESTRUCTIVE_ACTIONS is not 'true'", () => {
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
    const server = createMockServer();
    const graph = createMockGraph();
    registerGroupMembershipTools(server as never, graph as never);

    expect(() => server.getHandler("update_group_membership_rule")).toThrow();
    expect(() => server.getHandler("modify_membership_rule_value")).toThrow();
  });

  it("registers both tools when the flag is enabled", () => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
    const server = createMockServer();
    const graph = createMockGraph();
    registerGroupMembershipTools(server as never, graph as never);

    expect(server.getHandler("update_group_membership_rule")).toBeTypeOf("function");
    expect(server.getHandler("modify_membership_rule_value")).toBeTypeOf("function");
  });
});

describe("update_group_membership_rule", () => {
  beforeEach(() => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
  });
  afterEach(() => {
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
  });

  const NEW_RULE = '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant"])';

  it("previews without writing by default (dryRun defaults to true)", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("DRY RUN");
    expect(getText(result)).toContain("--- New rule ---");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("applies the new rule when dryRun is false and the name matches", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("Membership rule updated");
    expect(graph.patch).toHaveBeenCalledWith(
      "/groups/rule-group-uuid",
      { membershipRule: NEW_RULE },
      { tool: "update_group_membership_rule" }
    );
  });

  it("includes processingState in the patch body when supplied", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      processingState: "Paused",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(graph.patch).toHaveBeenCalledWith(
      "/groups/rule-group-uuid",
      { membershipRule: NEW_RULE, membershipRuleProcessingState: "Paused" },
      { tool: "update_group_membership_rule" }
    );
  });

  it("rejects a name-confirmation mismatch without writing", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      confirmGroupName: "Wrong Name",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("Safety check failed");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("refuses to edit an assigned (non-dynamic) group", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "group-uuid-1",
      membershipRule: NEW_RULE,
      confirmGroupName: "Test Group",
      dryRun: false,
    });

    expect(getText(result)).toContain("not a dynamic group");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("refuses a rule that exceeds the 3072-character limit", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: "x".repeat(3100),
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(getText(result)).toContain("exceeding Entra's 3072");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("gives a Group.ReadWrite.All-specific message on 403", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    graph.patch.mockRejectedValueOnce(new GraphError(403, "Insufficient privileges"));
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBe(true);
    expect(getText(result)).toContain("Group.ReadWrite.All");
  });

  it("warns when processing state is Paused", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({ ...mockRuleGroup, membershipRuleProcessingState: "Paused" });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("update_group_membership_rule");
    const result = await handler({
      groupId: "rule-group-uuid",
      membershipRule: NEW_RULE,
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
    });

    expect(getText(result)).toContain("Paused");
  });
});

describe("modify_membership_rule_value", () => {
  beforeEach(() => {
    process.env.ENABLE_DESTRUCTIVE_ACTIONS = "true";
  });
  afterEach(() => {
    delete process.env.ENABLE_DESTRUCTIVE_ACTIONS;
  });

  it("adds a job title and patches the updated rule", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "add",
      value: "Manager, Dual District",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("Membership rule updated");
    expect(graph.patch).toHaveBeenCalledWith(
      "/groups/rule-group-uuid",
      {
        membershipRule:
          '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant","Manager, Area","Manager, Dual District"])',
      },
      { tool: "modify_membership_rule_value" }
    );
  });

  it("previews by default without writing and shows the list-size delta", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "add",
      value: "Buyer",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
    });

    expect(getText(result)).toContain("DRY RUN");
    expect(getText(result)).toContain("List size: 2 → 3");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("is a no-op when adding a value that already exists", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "add",
      value: "Accountant",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(getText(result)).toContain("No change");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("refuses (no write) when the clause can't be safely parsed", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({
      ...mockRuleGroup,
      membershipRule: 'user.jobTitle -in ["Accountant", foo]',
    });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "add",
      value: "Buyer",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(getText(result)).toContain("Cannot edit the rule");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("rejects a name-confirmation mismatch", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "add",
      value: "Buyer",
      confirmGroupName: "Nope",
      dryRun: false,
    });

    expect(getText(result)).toContain("Safety check failed");
    expect(graph.patch).not.toHaveBeenCalled();
  });

  it("removes a value and PATCHes the shortened rule", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce(mockRuleGroup);
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "remove",
      value: "Manager, Area",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("Membership rule updated");
    expect(graph.patch).toHaveBeenCalledWith(
      "/groups/rule-group-uuid",
      { membershipRule: '(user.accountEnabled -eq true) and (user.jobTitle -in ["Accountant"])' },
      { tool: "modify_membership_rule_value" }
    );
  });

  it("targets a -notIn clause when operator is supplied", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({
      ...mockRuleGroup,
      membershipRule: 'user.department -notIn ["Sales","Legal"]',
    });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.department",
      action: "add",
      value: "Finance",
      operator: "-notIn",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(graph.patch).toHaveBeenCalledWith(
      "/groups/rule-group-uuid",
      { membershipRule: 'user.department -notIn ["Sales","Legal","Finance"]' },
      { tool: "modify_membership_rule_value" }
    );
  });

  it("refuses (no write) to remove the last value, which would leave an empty list", async () => {
    const server = createMockServer();
    const graph = createMockGraph();
    graph.get.mockResolvedValueOnce({
      ...mockRuleGroup,
      membershipRule: '(user.jobTitle -in ["Accountant"])',
    });
    registerGroupMembershipTools(server as never, graph as never);

    const handler = server.getHandler("modify_membership_rule_value");
    const result = await handler({
      groupId: "rule-group-uuid",
      attribute: "user.jobTitle",
      action: "remove",
      value: "Accountant",
      confirmGroupName: "App - Dutchie.SSO.Remote.1.Users",
      dryRun: false,
    });

    expect(result.isError).toBeUndefined();
    expect(getText(result)).toContain("would leave the user.jobTitle -in list empty");
    expect(graph.patch).not.toHaveBeenCalled();
  });
});
