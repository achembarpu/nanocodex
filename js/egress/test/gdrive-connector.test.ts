import { describe, expect, it } from "vitest";

import {
  buildGDriveAuthorizationParams,
  buildGDriveAuthorizationUrl,
  buildGDriveIdentityRequest,
  buildGDriveTokenRequest,
  decodeGDriveIdentity,
  decodeGDriveTokenResponse,
  GDRIVE_PROVIDER,
} from "../src/connectors/gdrive";

const CODE_CHALLENGE = "A".repeat(43);
const SCOPES = [
  "openid",
  "email",
  "profile",
  "https://www.googleapis.com/auth/drive",
];

describe("Google Drive OAuth connector", () => {
  it("publishes the fixed Google endpoints and full Drive access", () => {
    expect(GDRIVE_PROVIDER).toEqual({
      id: "gdrive",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      identityUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: SCOPES,
    });
  });

  it("builds an offline authorization request with state and S256 PKCE", () => {
    const input = {
      clientId: "worker-client.apps.googleusercontent.com",
      redirectUri: "https://broker.example.test/oauth/gdrive/callback",
      state: "opaque-state",
      codeChallenge: CODE_CHALLENGE,
    };
    const params = buildGDriveAuthorizationParams(input);
    expect(Object.fromEntries(params)).toEqual({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: SCOPES.join(" "),
      state: input.state,
      code_challenge: CODE_CHALLENGE,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });

    const url = buildGDriveAuthorizationUrl(input);
    expect(url.origin + url.pathname).toBe(GDRIVE_PROVIDER.authorizationUrl);
    expect(url.searchParams.toString()).toBe(params.toString());
    expect(url.href).not.toContain("client-secret");
    expect(() => buildGDriveAuthorizationParams({ ...input, codeChallenge: "plain" }))
      .toThrow(/base64url-encoded SHA-256/);
  });

  it("builds a form-encoded authorization-code exchange without putting secrets in the URL", async () => {
    const request = buildGDriveTokenRequest({
      clientId: "worker-client.apps.googleusercontent.com",
      clientSecret: "google-client-secret",
      redirectUri: "https://broker.example.test/oauth/gdrive/callback",
      authorizationCode: "google-authorization-code",
      codeVerifier: "pkce-verifier-secret",
    });

    expect(request.url).toBe(GDRIVE_PROVIDER.tokenUrl);
    expect(request.url).not.toContain("google-client-secret");
    expect(request.method).toBe("POST");
    expect(request.headers.get("content-type")).toBe(
      "application/x-www-form-urlencoded;charset=UTF-8",
    );
    const encodedBody = new TextDecoder().decode(await request.arrayBuffer());
    expect(Object.fromEntries(new URLSearchParams(encodedBody))).toEqual({
      client_id: "worker-client.apps.googleusercontent.com",
      client_secret: "google-client-secret",
      redirect_uri: "https://broker.example.test/oauth/gdrive/callback",
      code: "google-authorization-code",
      code_verifier: "pkce-verifier-secret",
      grant_type: "authorization_code",
    });
  });

  it("decodes Google token responses with an optional refresh token", () => {
    const response = decodeGDriveTokenResponse({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      expires_in: 3_599,
      token_type: "Bearer",
      scope: SCOPES.join(" "),
      ignored_future_field: "allowed",
    });
    expect(response).toEqual({
      accessToken: "google-access-token",
      refreshToken: "google-refresh-token",
      expiresInSeconds: 3_599,
      grantedScopes: SCOPES,
    });

    expect(decodeGDriveTokenResponse({
      access_token: "google-access-token",
      expires_in: 3_599,
      token_type: "Bearer",
    })).toEqual({
      accessToken: "google-access-token",
      expiresInSeconds: 3_599,
      grantedScopes: SCOPES,
    });
    const normalizedScopes = [
      "openid",
      "https://www.googleapis.com/auth/userinfo.email",
      "https://www.googleapis.com/auth/userinfo.profile",
      "https://www.googleapis.com/auth/drive",
    ];
    expect(decodeGDriveTokenResponse({
      access_token: "google-access-token",
      expires_in: 3_599,
      token_type: "Bearer",
      scope: normalizedScopes.join(" "),
    })).toEqual({
      accessToken: "google-access-token",
      expiresInSeconds: 3_599,
      grantedScopes: normalizedScopes,
    });
    expect(() => decodeGDriveTokenResponse({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      expires_in: "3599",
      token_type: "Bearer",
      scope: SCOPES.join(" "),
    })).toThrow(/expires_in/);
    expect(() => decodeGDriveTokenResponse({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      expires_in: 3_599,
      token_type: "bearer",
      scope: SCOPES.join(" "),
    })).toThrow(/token_type/);
    expect(() => decodeGDriveTokenResponse({
      access_token: "google-access-token",
      refresh_token: "google-refresh-token",
      expires_in: 3_599,
      token_type: "Bearer",
      scope: "openid email profile",
    })).toThrow(/auth\/drive/);
  });

  it("builds a bearer UserInfo request and derives a stable account label", () => {
    const request = buildGDriveIdentityRequest("google-access-token");
    expect(request.url).toBe(GDRIVE_PROVIDER.identityUrl);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer google-access-token");

    expect(decodeGDriveIdentity({
      sub: "google-account-123",
      email: "drive.user@example.test",
      email_verified: true,
      name: "Drive User",
    })).toEqual({
      accountId: "google-account-123",
      displayLabel: "drive.user@example.test",
    });
    expect(decodeGDriveIdentity({
      sub: "google-account-456",
      name: "Drive User",
    })).toEqual({ accountId: "google-account-456", displayLabel: "Drive User" });

    expect(() => decodeGDriveIdentity({ email: "drive.user@example.test" }))
      .toThrow(/sub/);
    expect(() => decodeGDriveIdentity({ sub: "google-account-123" }))
      .toThrow(/email or name/);
    expect(() => decodeGDriveIdentity({
      sub: "google-account-123",
      email: "drive.user@example.test",
      email_verified: "true",
    })).toThrow(/email_verified/);
  });
});
