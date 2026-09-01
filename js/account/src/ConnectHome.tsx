import { AccountMenu } from "./AccountMenu";

export function ConnectHome() {
  return (
    <div className="device-connect-route connect-home" data-testid="connect-home">
      <section className="connect-wizard">
        <div className="wizard-content">
          <AccountMenu inline />
        </div>
      </section>
    </div>
  );
}
