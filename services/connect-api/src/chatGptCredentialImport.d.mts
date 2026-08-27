export const chatGptCredentialImportResourcePrefix: string;
export const maxChatGptCredentialTokenBytes: number;
export const maxChatGptCredentialAccountBytes: number;

export type ChatGptCredentialImport = Readonly<{
  access_token: string;
  refresh_token: string;
  account_id: string;
  expires_at: number;
  fedramp: boolean;
}>;

export function parseChatGptCredentialImport(value: unknown): ChatGptCredentialImport;
export function chatGptCredentialImportDigest(value: unknown): Promise<string>;
export function chatGptCredentialImportResource(value: unknown): Promise<string>;
export function credentialImportDigestFromResources(resources: unknown): string | undefined;
export function isAllowedChatGptCredentialImportResource(resource: unknown): boolean;
