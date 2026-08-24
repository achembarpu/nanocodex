import { describe, expect, it } from "vitest";

import {
  buildGitHubAuthorizationParams,
  buildGitHubAuthorizationUrl,
  buildGitHubIdentityRequest,
  buildGitHubTokenRequest,
  decodeGitHubIdentity,
  decodeGitHubTokenResponse,
  GITHUB_PROVIDER,
} from "../src/connectors/github";

const CHALLENGE = "A".repeat(43);
const VERIFIER = "v".repeat(43);

describe("GitHub OAuth connector", () => {
  it("publishes the repository-work GitHub provider policy", () => {
    expect(GITHUB_PROVIDER).toEqual({
      id: "github",
      authorizationUrl: "https://github.com/login/oauth/authorize",
      tokenUrl: "https://github.com/login/oauth/access_token",
      identityUrl: "https://api.github.com/user",
      scopes: ["repo", "workflow"],
    });
    expect(GITHUB_PROVIDER.scopes).toContain("repo");
    expect(GITHUB_PROVIDER.scopes).toContain("workflow");
    expect(GITHUB_PROVIDER.scopes.some((scope) => scope.startsWith("admin:"))).toBe(false);
    expect(GITHUB_PROVIDER.scopes).not.toContain("delete_repo");
  });

  it("builds authorization parameters with state and PKCE S256", () => {
    const input = {
      clientId: "client-id",
      redirectUri: "https://connector.example/callback?provider=github",
      state: "unguessable-state",
      codeChallenge: CHALLENGE,
    };
    const params = buildGitHubAuthorizationParams(input);
    const url = buildGitHubAuthorizationUrl(input);

    expect(Object.fromEntries(params)).toEqual({
      client_id: "client-id",
      redirect_uri: "https://connector.example/callback?provider=github",
      scope: GITHUB_PROVIDER.scopes.join(" "),
      state: "unguessable-state",
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
    });
    expect(url.origin + url.pathname).toBe(GITHUB_PROVIDER.authorizationUrl);
    expect(url.searchParams.get("state")).toBe("unguessable-state");
    expect(() => buildGitHubAuthorizationParams({ ...input, codeChallenge: "short" }))
      .toThrow("43-character base64url");
  });

  it("builds a JSON-negotiated form token exchange including the PKCE verifier", async () => {
    const request = buildGitHubTokenRequest({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "temporary-code",
      redirectUri: "https://connector.example/callback",
      codeVerifier: VERIFIER,
    });

    expect(request.url).toBe(GITHUB_PROVIDER.tokenUrl);
    expect(request.method).toBe("POST");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(Object.fromEntries(await request.formData())).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "temporary-code",
      redirect_uri: "https://connector.example/callback",
      code_verifier: VERIFIER,
    });
    expect(() => buildGitHubTokenRequest({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "temporary-code",
      redirectUri: "https://connector.example/callback",
      codeVerifier: "short",
    })).toThrow("valid PKCE verifier");
  });

  it("strictly decodes non-expiring and expiring token responses", () => {
    expect(decodeGitHubTokenResponse({
      access_token: "github-access-secret",
      token_type: "bearer",
      scope: "read:user",
    })).toEqual({
      accessToken: "github-access-secret",
      tokenType: "bearer",
      scopes: ["read:user"],
    });
    expect(decodeGitHubTokenResponse({
      access_token: "github-access-secret",
      token_type: "Bearer",
      scope: "read:user,repo:status",
      expires_in: 28_800,
      refresh_token: "github-refresh-secret",
      refresh_token_expires_in: 15_897_600,
    })).toEqual({
      accessToken: "github-access-secret",
      tokenType: "bearer",
      scopes: ["read:user", "repo:status"],
      expiresIn: 28_800,
      refreshToken: "github-refresh-secret",
      refreshTokenExpiresIn: 15_897_600,
    });
  });

  it("rejects malformed token responses without reflecting secrets", () => {
    const malformed = [
      null,
      { access_token: "secret", token_type: "mac", scope: "read:user" },
      { access_token: "secret", token_type: "bearer", scope: 1 },
      { access_token: "secret", token_type: "bearer", scope: "read:user", extra: true },
      { access_token: "secret", token_type: "bearer", scope: "read:user", expires_in: -1 },
    ];

    for (const value of malformed) {
      expect(() => decodeGitHubTokenResponse(value)).toThrow("invalid GitHub token response");
      try {
        decodeGitHubTokenResponse(value);
      } catch (error) {
        expect(String(error)).not.toContain("secret");
      }
    }
  });

  it("builds and strictly decodes the authenticated identity lookup", () => {
    const request = buildGitHubIdentityRequest("github-access-secret");

    expect(request.url).toBe(GITHUB_PROVIDER.identityUrl);
    expect(request.method).toBe("GET");
    expect(request.headers.get("authorization")).toBe("Bearer github-access-secret");
    expect(request.headers.get("accept")).toBe("application/vnd.github+json");
    expect(request.headers.get("user-agent")).toBe("nanocodex-egress");
    expect(request.headers.get("x-github-api-version")).toBe("2026-03-10");
    expect(decodeGitHubIdentity({ id: 1, login: "octocat", name: "Mona Lisa", extra: true }))
      .toEqual({ accountId: "1", displayLabel: "Mona Lisa (octocat)" });
    expect(decodeGitHubIdentity({ id: 2, login: "hubot", name: null }))
      .toEqual({ accountId: "2", displayLabel: "hubot" });
  });

  it("rejects malformed identities", () => {
    expect(() => decodeGitHubIdentity({ id: 0, login: "octocat" }))
      .toThrow("invalid GitHub identity response");
    expect(() => decodeGitHubIdentity({ id: 1, login: " " }))
      .toThrow("invalid GitHub identity response");
    expect(() => decodeGitHubIdentity({ id: 1, login: "octocat", name: 7 }))
      .toThrow("invalid GitHub identity response");
  });
});
