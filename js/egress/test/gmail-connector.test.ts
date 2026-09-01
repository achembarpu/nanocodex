import { describe, expect, it } from "vitest";

import {
  buildGmailAuthorizationParams,
  buildGmailAuthorizationUrl,
  buildGmailIdentityRequest,
  buildGmailTokenRequest,
  decodeGmailIdentity,
  decodeGmailTokenResponse,
  GMAIL_PROVIDER,
} from "../src/connectors/gmail";

const CHALLENGE = "A".repeat(43);
const VERIFIER = "v".repeat(64);

describe("Gmail OAuth connector", () => {
  it("declares fixed Google endpoints and full Gmail access", () => {
    expect(GMAIL_PROVIDER).toEqual({
      id: "gmail",
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      tokenUrl: "https://oauth2.googleapis.com/token",
      identityUrl: "https://openidconnect.googleapis.com/v1/userinfo",
      scopes: [
        "openid",
        "email",
        "https://mail.google.com/",
      ],
    });
  });

  it("builds authorization parameters for state, S256 PKCE, and durable offline access", () => {
    const input = {
      clientId: "worker-client.apps.googleusercontent.com",
      redirectUri: "https://broker.example/oauth/gmail/callback",
      state: "opaque-state",
      codeChallenge: CHALLENGE,
    };
    const params = buildGmailAuthorizationParams(input);

    expect(Object.fromEntries(params)).toEqual({
      client_id: input.clientId,
      redirect_uri: input.redirectUri,
      response_type: "code",
      scope: GMAIL_PROVIDER.scopes.join(" "),
      state: input.state,
      code_challenge: CHALLENGE,
      code_challenge_method: "S256",
      access_type: "offline",
      prompt: "consent",
      include_granted_scopes: "true",
    });
    expect(params.has("client_secret")).toBe(false);

    const url = buildGmailAuthorizationUrl(input);
    expect(url.origin + url.pathname).toBe(GMAIL_PROVIDER.authorizationUrl);
    expect(url.searchParams.toString()).toBe(params.toString());
  });

  it("rejects a non-S256 authorization challenge", () => {
    expect(() => buildGmailAuthorizationParams({
      clientId: "client-id",
      redirectUri: "https://broker.example/callback",
      state: "state",
      codeChallenge: "plain-verifier",
    })).toThrow("S256 PKCE challenge");
  });

  it("builds a form-encoded authorization-code exchange with the PKCE verifier", async () => {
    const request = buildGmailTokenRequest({
      clientId: "client-id",
      clientSecret: "client-secret",
      code: "authorization-code",
      codeVerifier: VERIFIER,
      redirectUri: "https://broker.example/oauth/gmail/callback",
    });

    expect(request.url).toBe(GMAIL_PROVIDER.tokenUrl);
    expect(request.method).toBe("POST");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("content-type")).toBe("application/x-www-form-urlencoded");
    expect(request.url).not.toContain("client-secret");
    expect(request.headers.get("authorization")).toBeNull();
    expect(Object.fromEntries(await request.formData())).toEqual({
      client_id: "client-id",
      client_secret: "client-secret",
      code: "authorization-code",
      code_verifier: VERIFIER,
      grant_type: "authorization_code",
      redirect_uri: "https://broker.example/oauth/gmail/callback",
    });
  });

  it("strictly decodes a successful token response without retaining the ID token", () => {
    const decoded = decodeGmailTokenResponse({
      access_token: "access-secret",
      refresh_token: "refresh-secret",
      expires_in: 3_600,
      refresh_token_expires_in: 604_800,
      token_type: "Bearer",
      scope: "openid email https://mail.google.com/",
      id_token: "identity-secret",
      future_google_field: "ignored for protocol compatibility",
    });

    expect(decoded).toEqual({
      accessToken: "access-secret",
      refreshToken: "refresh-secret",
      expiresIn: 3_600,
      refreshTokenExpiresIn: 604_800,
      tokenType: "Bearer",
      scopes: ["openid", "email", "https://mail.google.com/"],
    });
    expect(JSON.stringify(decoded)).not.toContain("identity-secret");
  });

  it.each([
    [null, "must be an object"],
    [{ access_token: "", expires_in: 3_600, token_type: "Bearer", scope: "email" }, "access_token"],
    [{ access_token: "a", expires_in: 0, token_type: "Bearer", scope: "email" }, "expires_in"],
    [{ access_token: "a", expires_in: 3_600, token_type: "bearer", scope: "email" }, "token_type"],
    [{ access_token: "a", expires_in: 3_600, token_type: "Bearer", scope: "" }, "scope"],
    [{ error: "invalid_grant", error_description: "sensitive provider detail" }, "OAuth error"],
  ])("rejects malformed token payload %#", (payload, message) => {
    expect(() => decodeGmailTokenResponse(payload)).toThrow(message);
  });

  it("builds a bearer-authenticated identity lookup without query credentials", () => {
    const request = buildGmailIdentityRequest("access-secret");

    expect(request.url).toBe(GMAIL_PROVIDER.identityUrl);
    expect(request.method).toBe("GET");
    expect(request.headers.get("accept")).toBe("application/json");
    expect(request.headers.get("authorization")).toBe("Bearer access-secret");
    expect(new URL(request.url).search).toBe("");
  });

  it("strictly decodes the stable Google subject and email display label", () => {
    expect(decodeGmailIdentity({
      sub: "google-account-123",
      email: "reader@example.com",
      email_verified: true,
      name: "Ignored Optional Profile",
    })).toEqual({
      accountId: "google-account-123",
      displayLabel: "reader@example.com",
    });

    expect(() => decodeGmailIdentity({
      sub: "google-account-123",
      email: "reader@example.com",
      email_verified: "true",
    })).toThrow("email_verified must be a boolean");
    expect(() => decodeGmailIdentity({
      sub: "",
      email: "reader@example.com",
      email_verified: true,
    })).toThrow("identity sub");
  });
});
