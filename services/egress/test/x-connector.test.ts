import { describe, expect, it } from "vitest";

import {
  buildXAuthorizationParams,
  buildXIdentityRequest,
  buildXRefreshRequest,
  buildXRevocationRequest,
  buildXTokenRequest,
  decodeXIdentity,
  decodeXTokenResponse,
  X_PROVIDER,
} from "../src/connectors/x";

const CHALLENGE = "A".repeat(43);
const VERIFIER = "v".repeat(64);

describe("X OAuth connector", () => {
  it("requests durable read and social action scopes", () => {
    expect(X_PROVIDER.authorizationUrl).toBe("https://x.com/i/oauth2/authorize");
    expect(X_PROVIDER.tokenUrl).toBe("https://api.x.com/2/oauth2/token");
    expect(X_PROVIDER.revocationUrl).toBe("https://api.x.com/2/oauth2/revoke");
    expect(X_PROVIDER.identityUrl).toBe("https://api.x.com/2/users/me");
    expect(X_PROVIDER.scopes).toEqual(expect.arrayContaining([
      "tweet.read", "tweet.write", "users.read", "follows.write", "like.write",
      "bookmark.write", "list.write", "dm.write", "media.write", "offline.access",
    ]));
  });

  it("builds state-bound S256 authorization parameters", () => {
    const params = buildXAuthorizationParams({
      clientId: "x-client",
      redirectUri: "https://nanocodex.example/v1/connectors/x/callback",
      state: "opaque-state",
      codeChallenge: CHALLENGE,
    });
    expect(Object.fromEntries(params)).toEqual({
      response_type: "code",
      client_id: "x-client",
      redirect_uri: "https://nanocodex.example/v1/connectors/x/callback",
      scope: X_PROVIDER.scopes.join(" "),
      state: "opaque-state",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    expect(() => buildXAuthorizationParams({
      clientId: "x-client",
      redirectUri: "https://nanocodex.example/callback",
      state: "state",
      codeChallenge: "plain",
    })).toThrow("S256 PKCE challenge");
  });

  it("exchanges and refreshes confidential-client tokens without URL credentials", async () => {
    const exchange = buildXTokenRequest({
      clientId: "x-client",
      clientSecret: "x-secret",
      code: "authorization-code",
      redirectUri: "https://nanocodex.example/v1/connectors/x/callback",
      codeVerifier: VERIFIER,
    });
    expect(exchange.url).toBe(X_PROVIDER.tokenUrl);
    expect(exchange.headers.get("authorization")).toMatch(/^Basic /);
    expect(exchange.url).not.toContain("x-secret");
    expect(Object.fromEntries(await exchange.formData())).toEqual({
      code: "authorization-code",
      grant_type: "authorization_code",
      redirect_uri: "https://nanocodex.example/v1/connectors/x/callback",
      code_verifier: VERIFIER,
    });

    const refresh = buildXRefreshRequest("x-client", "x-secret", "refresh-secret");
    expect(refresh.url).toBe(X_PROVIDER.tokenUrl);
    expect(refresh.headers.get("authorization")).toMatch(/^Basic /);
    expect(Object.fromEntries(await refresh.formData())).toEqual({
      refresh_token: "refresh-secret",
      grant_type: "refresh_token",
    });

    const revocation = buildXRevocationRequest("x-client", "refresh-secret");
    expect(revocation.url).toBe(X_PROVIDER.revocationUrl);
    expect(revocation.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(await revocation.formData())).toEqual({
      token: "refresh-secret",
      client_id: "x-client",
    });
  });

  it("decodes rotating tokens and the authenticated user", () => {
    expect(decodeXTokenResponse({
      token_type: "bearer",
      expires_in: 7_200,
      access_token: "x-access",
      scope: X_PROVIDER.scopes.join(" "),
      refresh_token: "x-refresh",
    })).toEqual({
      tokenType: "bearer",
      expiresIn: 7_200,
      accessToken: "x-access",
      scopes: [...X_PROVIDER.scopes],
      refreshToken: "x-refresh",
    });

    const identity = buildXIdentityRequest("x-access");
    expect(identity.headers.get("authorization")).toBe("Bearer x-access");
    expect(decodeXIdentity({
      data: { id: "2244994945", name: "X Developers", username: "XDevelopers" },
    })).toEqual({ accountId: "2244994945", displayLabel: "X Developers (@XDevelopers)" });
  });

  it("rejects malformed provider responses", () => {
    expect(() => decodeXTokenResponse({ access_token: "secret", expires_in: 1 }))
      .toThrow("invalid X token response");
    expect(() => decodeXTokenResponse({
      access_token: "secret",
      expires_in: 7_200,
      token_type: "bearer",
      scope: "tweet.read users.read offline.access",
    })).toThrow("invalid X token response");
    expect(() => decodeXIdentity({ data: { id: "abc", name: "Name", username: "user" } }))
      .toThrow("invalid X identity response");
  });

});
