import {
  PublicClientApplication,
  type AccountInfo,
  type DeviceCodeRequest,
} from "@azure/msal-node";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";

const SCOPES = [
  "DeviceManagementManagedDevices.ReadWrite.All",
  "DeviceManagementManagedDevices.PrivilegedOperations.All",
  "Device.Read.All",
  "GroupMember.ReadWrite.All",
  "Directory.Read.All",
  "User.Read.All",
];

const CACHE_DIR = path.join(os.homedir(), ".intune-mcp-write");
const CACHE_FILE = path.join(CACHE_DIR, "token-cache.json");

function getConfig() {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID;
  if (!clientId || !tenantId) {
    throw new Error(
      "AZURE_CLIENT_ID and AZURE_TENANT_ID environment variables are required. " +
        "Copy .env.example to .env and fill in your Azure AD app registration values."
    );
  }
  return { clientId, tenantId };
}

function createApp(): PublicClientApplication {
  const { clientId, tenantId } = getConfig();
  return new PublicClientApplication({
    auth: {
      clientId,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  });
}

async function ensureCacheDir(): Promise<void> {
  await fs.mkdir(CACHE_DIR, { recursive: true, mode: 0o700 });
}

async function loadCache(app: PublicClientApplication): Promise<void> {
  await ensureCacheDir();
  let data: string;
  try {
    data = await fs.readFile(CACHE_FILE, "utf-8");
  } catch {
    return;
  }
  try {
    app.getTokenCache().deserialize(data);
  } catch {
    await fs.unlink(CACHE_FILE).catch(() => {});
  }
}

async function saveCache(app: PublicClientApplication): Promise<void> {
  await ensureCacheDir();
  const data = app.getTokenCache().serialize();
  await fs.writeFile(CACHE_FILE, data, { encoding: "utf-8", mode: 0o600 });
}

export class AuthManager {
  private app?: PublicClientApplication;
  private pendingTokens = new Map<string, Promise<string>>();

  private async getApp(): Promise<PublicClientApplication> {
    if (!this.app) {
      this.app = createApp();
      await loadCache(this.app);
    }
    return this.app;
  }

  async authenticate(
    onDeviceCode: (message: string) => void
  ): Promise<AccountInfo> {
    const app = await this.getApp();

    const request: DeviceCodeRequest = {
      scopes: SCOPES,
      deviceCodeCallback: (response) => {
        onDeviceCode(response.message);
      },
    };

    const result = await app.acquireTokenByDeviceCode(request);
    if (!result?.account) {
      throw new Error("Authentication failed — no account returned.");
    }

    await saveCache(app);
    return result.account;
  }

  getAccessToken(account: AccountInfo): Promise<string> {
    const key = account.homeAccountId;
    const existing = this.pendingTokens.get(key);
    if (existing) return existing;

    const promise = this.acquireTokenForAccount(account).finally(() => {
      this.pendingTokens.delete(key);
    });
    this.pendingTokens.set(key, promise);
    return promise;
  }

  private async acquireTokenForAccount(
    account: AccountInfo
  ): Promise<string> {
    const app = await this.getApp();
    try {
      const result = await app.acquireTokenSilent({
        scopes: SCOPES,
        account,
      });
      if (!result.fromCache) await saveCache(app);
      return result.accessToken;
    } catch {
      throw new Error(
        `Token for ${account.username} expired and could not be refreshed. Please re-authenticate.`
      );
    }
  }

  async getFirstAccount(): Promise<AccountInfo | undefined> {
    const app = await this.getApp();
    const accounts = await app.getTokenCache().getAllAccounts();
    return accounts[0];
  }
}
