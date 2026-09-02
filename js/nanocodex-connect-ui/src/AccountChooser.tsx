import { useId, useState, type ReactNode } from "react";

export type StoredPasskey = Readonly<{
  address: `0x${string}`;
  credentialId: string;
  current?: boolean | undefined;
  label?: string | undefined;
}>;

export type AccountSelection = Readonly<{
  address?: `0x${string}` | undefined;
  authentication?: "sms_otp" | undefined;
  current?: boolean | undefined;
  mode: "login" | "register";
  label: string;
  credentialId?: string | undefined;
  discoverCredential?: boolean | undefined;
}>;

type OtpChallenge = Readonly<{
  challengeId: string;
  expiresAt: number;
  phone: string;
}>;

export function AccountChooser({
  confirmationCode,
  description = "Sign in with the code sent to your phone.",
  disabled,
  failure,
  requestContext,
  onCancel,
  onChooseAccount,
  authOrigin = "",
}: Readonly<{
  authOrigin?: string | undefined;
  confirmationCode?: string | undefined;
  description?: string | undefined;
  disabled: boolean;
  failure?: string | null | undefined;
  requestContext?: ReactNode;
  newAccountDetail?: string | undefined;
  onCancel?: (() => void) | undefined;
  onChooseAccount(account: AccountSelection): void;
  storedPasskeys?: readonly StoredPasskey[] | undefined;
}>) {
  const phoneId = useId();
  const codeId = useId();
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [challenge, setChallenge] = useState<OtpChallenge>();
  const [operation, setOperation] = useState<"send" | "verify">();
  const [localFailure, setLocalFailure] = useState<string>();

  async function sendCode() {
    if (operation) return;
    setOperation("send");
    setLocalFailure(undefined);
    try {
      const response = await fetch(`${authOrigin}/v1/auth/sms/start`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ phone }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(otpError(body, "Couldn’t send the code."));
      if (!isRecord(body)
        || typeof body.challenge_id !== "string"
        || typeof body.expires_in !== "number") {
        throw new Error("The account service returned an invalid challenge.");
      }
      setChallenge({
        challengeId: body.challenge_id,
        expiresAt: Date.now() + body.expires_in * 1_000,
        phone,
      });
      setCode("");
    } catch (cause) {
      setLocalFailure(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  async function verifyCode() {
    if (!challenge || operation) return;
    setOperation("verify");
    setLocalFailure(undefined);
    try {
      const response = await fetch(`${authOrigin}/v1/auth/sms/verify`, {
        method: "POST",
        credentials: "include",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          challenge_id: challenge.challengeId,
          code,
          phone: challenge.phone,
        }),
      });
      const body: unknown = await response.json().catch(() => undefined);
      if (!response.ok) throw new Error(otpError(body, "That code didn’t work."));
      if (!isRecord(body) || !isRecord(body.user)
        || typeof body.user.id !== "string"
        || (body.user.address !== undefined
          && (typeof body.user.address !== "string"
            || !/^0x[0-9a-f]{40}$/.test(body.user.address)))) {
        throw new Error("The account service returned an invalid session.");
      }
      onChooseAccount({
        ...(body.user.address ? { address: body.user.address as `0x${string}` } : {}),
        authentication: "sms_otp",
        current: true,
        label: maskedPhone(challenge.phone),
        mode: "login",
      });
    } catch (cause) {
      setLocalFailure(errorMessage(cause));
    } finally {
      setOperation(undefined);
    }
  }

  const unavailable = disabled || operation !== undefined;
  return (
    <div className="wizard-page wizard-account-page">
      <header className="wizard-intro">
        <div className="wizard-app">
          <h1>Sign in with your phone</h1>
          <p>{description}</p>
        </div>
        {confirmationCode ? (
          <div className="wizard-terminal-code" role="status">
            <span>Terminal code</span>
            <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
          </div>
        ) : null}
      </header>

      {failure || localFailure ? (
        <div className="account-failure" role="alert"><p>{localFailure ?? failure}</p></div>
      ) : null}
      {requestContext ? <div className="wizard-sections">{requestContext}</div> : null}

      {!challenge ? (
        <form className="sms-otp-form" onSubmit={(event) => {
          event.preventDefault();
          void sendCode();
        }}>
          <label htmlFor={phoneId}>Mobile number</label>
          <p>Include the country code, for example +1 or +30.</p>
          <div className="sms-otp-input-row">
            <input
              autoComplete="tel"
              autoFocus
              disabled={unavailable}
              id={phoneId}
              inputMode="tel"
              onChange={(event) => setPhone(event.target.value)}
              placeholder="+30 69…"
              required
              type="tel"
              value={phone}
            />
            <button disabled={unavailable || phone.trim().length < 8} type="submit">
              {operation === "send" ? "Sending…" : "Send code"}
            </button>
          </div>
        </form>
      ) : (
        <form className="sms-otp-form" onSubmit={(event) => {
          event.preventDefault();
          void verifyCode();
        }}>
          <label htmlFor={codeId}>6-digit code</label>
          <p>Sent to {maskedPhone(challenge.phone)}. It expires at {new Date(challenge.expiresAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}.</p>
          <div className="sms-otp-input-row">
            <input
              autoComplete="one-time-code"
              autoFocus
              disabled={unavailable}
              id={codeId}
              inputMode="numeric"
              maxLength={6}
              onChange={(event) => setCode(event.target.value.replace(/\D/g, "").slice(0, 6))}
              pattern="[0-9]{6}"
              placeholder="000000"
              required
              value={code}
            />
            <button disabled={unavailable || code.length !== 6} type="submit">
              {operation === "verify" ? "Checking…" : "Continue"}
            </button>
          </div>
          <button
            className="sms-otp-change"
            disabled={unavailable}
            onClick={() => {
              setChallenge(undefined);
              setCode("");
              setLocalFailure(undefined);
            }}
            type="button"
          >Use a different number</button>
        </form>
      )}
      {onCancel ? (
        <button className="wizard-cancel" disabled={unavailable} onClick={onCancel} type="button">Cancel</button>
      ) : null}
    </div>
  );
}

export function orderedPasskeys(storedPasskeys: readonly StoredPasskey[]): readonly StoredPasskey[] {
  return storedPasskeys.some((account) => account.current)
    ? [...storedPasskeys].sort((left, right) => Number(right.current === true) - Number(left.current === true))
    : storedPasskeys;
}

function maskedPhone(value: string): string {
  const normalized = value.replace(/\D/g, "");
  return normalized.length > 4 ? `+••• ••${normalized.slice(-4)}` : "your phone";
}

function otpError(value: unknown, fallback: string): string {
  if (!isRecord(value) || typeof value.error !== "string") return fallback;
  if (value.error === "rate_limited") return "Too many codes requested. Wait a minute and try again.";
  if (value.error === "invalid_phone") return "Enter a mobile number with its country code.";
  if (value.error === "invalid_or_expired_otp") return "That code is invalid or expired.";
  if (value.error === "sms_delivery_failed") return "The code could not be delivered. Try again.";
  return fallback;
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : "The account service is unavailable.";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
