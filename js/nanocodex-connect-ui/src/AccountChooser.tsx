import { useId, useState, type ReactNode } from "react";

export type StoredPasskey = Readonly<{
  address: `0x${string}`;
  credentialId: string;
  current?: boolean | undefined;
  label?: string | undefined;
}>;

export type AccountSelection = Readonly<{
  current?: boolean | undefined;
  mode: "login" | "register";
  label: string;
  address?: `0x${string}` | undefined;
  credentialId?: string | undefined;
  discoverCredential?: boolean | undefined;
}>;

export function AccountChooser({
  confirmationCode,
  description = "Continue to Nanocodex CLI with a saved passkey, or create a new account.",
  disabled,
  failure,
  requestContext,
  newAccountDetail = "Create one passkey to sign in and authorize this hosted CLI connection.",
  onCancel,
  onChooseAccount,
  storedPasskeys,
}: Readonly<{
  confirmationCode?: string | undefined;
  description?: string | undefined;
  disabled: boolean;
  failure?: string | null | undefined;
  requestContext?: ReactNode;
  newAccountDetail?: string | undefined;
  onCancel?: (() => void) | undefined;
  onChooseAccount(account: AccountSelection): void;
  storedPasskeys: readonly StoredPasskey[];
}>) {
  const [creatingAccount, setCreatingAccount] = useState(false);
  const accountNameId = useId();

  return (
    <div className="wizard-page wizard-account-page">
      <header className="wizard-intro">
        <div className="wizard-app">
          <h1>Choose an account</h1>
          <p>{description}</p>
        </div>
        {confirmationCode ? (
          <div className="wizard-terminal-code" role="status">
            <span>Terminal code</span>
            <strong>{confirmationCode.slice(0, 4)}-{confirmationCode.slice(4)}</strong>
          </div>
        ) : null}
      </header>

      {failure ? <div className="account-failure" role="alert"><p>{failure}</p></div> : null}
      {requestContext ? <div className="wizard-sections">{requestContext}</div> : null}

      <div className="wizard-account-chooser" role="group" aria-label="Choose a Nanocodex account">
        {orderedPasskeys(storedPasskeys).map((account) => (
          <button
            className={`wizard-account-choice${account.current ? " is-current" : ""}`}
            disabled={disabled}
            key={account.credentialId}
            onClick={() => onChooseAccount({
              current: account.current,
              mode: "login",
              label: account.label || shortAddress(account.address),
              address: account.address,
              credentialId: account.credentialId,
            })}
            type="button"
          >
            <span className="wizard-account-avatar" aria-hidden="true">
              {(account.label?.trim().slice(0, 1) || "N").toUpperCase()}
            </span>
            <span className="wizard-account-copy">
              <strong>{account.label || shortAddress(account.address)}</strong>
              <small>{account.current
                ? `Current account · ${shortAddress(account.address)}`
                : account.label ? shortAddress(account.address) : "Saved passkey"}</small>
            </span>
            <span className="wizard-account-arrow" aria-hidden="true">
              {account.current ? "Continue" : "→"}
            </span>
          </button>
        ))}
        <button
          className="wizard-account-choice"
          disabled={disabled}
          onClick={() => onChooseAccount({
            mode: "login",
            label: "Another passkey",
            discoverCredential: true,
          })}
          type="button"
        >
          <span className="wizard-account-avatar wizard-passkey-avatar" aria-hidden="true">◇</span>
          <span className="wizard-account-copy">
            <strong>Use another passkey</strong>
            <small>Choose a passkey available on this device.</small>
          </span>
          <span className="wizard-account-arrow" aria-hidden="true">→</span>
        </button>
        {creatingAccount ? (
          <form
            className="wizard-account-choice wizard-account-create-form"
            onSubmit={(event) => {
              event.preventDefault();
              const name = String(new FormData(event.currentTarget).get("account-name") ?? "").trim();
              if (!name) return;
              onChooseAccount({ mode: "register", label: name.slice(0, 80) });
            }}
          >
            <span className="wizard-account-avatar" aria-hidden="true">+</span>
            <label className="wizard-account-copy" htmlFor={accountNameId}>
              <strong>Name this account</strong>
              <input
                autoFocus
                id={accountNameId}
                maxLength={80}
                name="account-name"
                placeholder="Work, personal, laptop…"
                required
              />
            </label>
            <button
              aria-label="Cancel new account"
              disabled={disabled}
              onClick={() => setCreatingAccount(false)}
              type="button"
            >×</button>
            <button disabled={disabled} type="submit">Continue</button>
          </form>
        ) : (
          <button
            className="wizard-account-choice wizard-new-account"
            disabled={disabled}
            onClick={() => setCreatingAccount(true)}
            type="button"
          >
            <span className="wizard-account-avatar" aria-hidden="true">+</span>
            <span className="wizard-account-copy">
              <strong>Create a new account</strong>
              <small>{newAccountDetail}</small>
            </span>
            <span className="wizard-account-arrow" aria-hidden="true">→</span>
          </button>
        )}
      </div>
      {onCancel ? (
        <button className="wizard-cancel" disabled={disabled} onClick={onCancel} type="button">Cancel</button>
      ) : null}
    </div>
  );
}

export function orderedPasskeys(storedPasskeys: readonly StoredPasskey[]): readonly StoredPasskey[] {
  return storedPasskeys.some((account) => account.current)
    ? [...storedPasskeys].sort((left, right) => Number(right.current === true) - Number(left.current === true))
    : storedPasskeys;
}

function shortAddress(value: unknown) {
  return typeof value === "string" && value.length > 15
    ? `${value.slice(0, 8)}…${value.slice(-6)}`
    : "Unavailable";
}
