import {
  QueryClient,
  QueryClientProvider,
  useMutation,
  useQuery,
} from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { formatUnits, parseUnits, type Address } from "viem";
import { Actions } from "viem/tempo";

import type { PaymentStatus } from "./nanocodex";
import {
  MPP_ACCESS_KEY_LIMIT,
  MPP_MIN_WALLET_BALANCE,
  USDC_E,
} from "./tempo-policy";
import { tempoAccount } from "./tempoAccount";

const queryClient = new QueryClient();

export function MppControls(props: {
  jsonl: readonly string[];
  payment?: PaymentStatus;
  onDisconnect(): void;
  onReady(address: Address): void;
}) {
  return (
    <QueryClientProvider client={queryClient}>
      <ConnectedMppControls {...props} />
    </QueryClientProvider>
  );
}

function ConnectedMppControls({ jsonl, payment, onDisconnect, onReady }: {
  jsonl: readonly string[];
  payment?: PaymentStatus;
  onDisconnect(): void;
  onReady(address: Address): void;
}) {
  const [address, setAddress] = useState<Address>();
  const [authorized, setAuthorized] = useState(false);
  const reportedAddress = useRef<string | undefined>(undefined);

  const refreshAccount = useCallback(async () => {
    const accounts = await tempoAccount.request({ method: "eth_accounts" });
    setAddress(accounts[0]);
  }, []);

  useEffect(() => {
    const accountsChanged = (accounts: readonly Address[]) => {
      setAddress(accounts[0]);
      if (accounts.length === 0) {
        setAuthorized(false);
        onDisconnect();
      }
    };
    tempoAccount.on("accountsChanged", accountsChanged);
    return () => {
      tempoAccount.removeListener("accountsChanged", accountsChanged);
    };
  }, [onDisconnect]);

  const connect = useMutation({
    mutationFn: async () => {
      await tempoAccount.request({ method: "wallet_connect" });
      await refreshAccount();
      setAuthorized(true);
    },
  });
  const disconnect = useMutation({
    mutationFn: async () => {
      onDisconnect();
      await tempoAccount.request({ method: "wallet_disconnect" });
      setAuthorized(false);
      setAddress(undefined);
    },
  });
  const deposit = useMutation({
    mutationFn: async () => {
      if (!address) throw new Error("Tempo account is disconnected");
      await tempoAccount.request({
        method: "wallet_deposit",
        params: [{
          address,
          amount: MPP_ACCESS_KEY_LIMIT,
          displayName: "Nanocodex",
          token: USDC_E,
        }],
      });
      await queryClient.invalidateQueries({ queryKey: ["tempo", "balances", address] });
    },
  });
  const balances = useQuery({
    queryKey: ["tempo", "balances", address],
    enabled: authorized && address !== undefined,
    refetchInterval: 5_000,
    retry: 2,
    queryFn: async () => {
      if (!address) throw new Error("Tempo account is disconnected");
      return Actions.token.getBalance(tempoAccount.getClient(), {
        account: address,
        token: USDC_E,
      });
    },
  });

  const minimumDeposit = parseUnits(MPP_MIN_WALLET_BALANCE, 6);
  const funded = balances.data !== undefined
    && balances.data.amount >= minimumDeposit;

  useEffect(() => {
    if (!authorized || !address || !funded) {
      reportedAddress.current = undefined;
      return;
    }
    if (reportedAddress.current === address) return;
    reportedAddress.current = address;
    onReady(address);
  }, [address, authorized, funded, onReady]);

  const connected = authorized && address !== undefined;
  const ready = connected && funded;
  const connecting = connect.isPending;
  return (
    <aside className="agent-byok agent-mpp" aria-label="Tempo MPP payment">
      <div className="agent-byok-summary">
        <span>
          <i className={ready ? "is-ready" : ""} aria-hidden="true" />
          {ready
            ? "Tempo Wallet ready"
            : connected
              ? balances.isPending
                ? "Checking Tempo balance…"
                : "Fund Tempo Wallet to continue"
            : "Use Tempo Wallet for MPP"}
        </span>
        <div>
          {connected ? (
            <>
              {!funded ? (
                <button type="button" disabled={deposit.isPending} onClick={() => deposit.mutate()}>
                  {deposit.isPending ? "Opening deposit…" : "Add funds"}
                </button>
              ) : null}
              <button type="button" disabled={disconnect.isPending} onClick={() => disconnect.mutate()}>
                {disconnect.isPending ? "Disconnecting…" : "Disconnect"}
              </button>
            </>
          ) : (
            <button
              type="button"
              disabled={connecting}
              onClick={() => connect.mutate()}
            >
              {connecting ? "Opening Tempo Wallet…" : "Continue with Tempo Wallet"}
            </button>
          )}
        </div>
      </div>
      {connect.error ? <p className="agent-byok-error" role="alert">{connect.error.message}</p> : null}
      {disconnect.error ? <p className="agent-byok-error" role="alert">{disconnect.error.message}</p> : null}
      {deposit.error ? <p className="agent-byok-error" role="alert">{deposit.error.message}</p> : null}
      {balances.error ? (
        <p className="agent-byok-error" role="alert">Could not refresh Tempo balances.</p>
      ) : null}
      {connected ? (
        <dl className="agent-mpp-details">
          <Detail label="Tempo account" value={address} />
          <Detail label="Payer" value={payment?.rootAddress ?? address} />
          <Detail
            label="USDC.e"
            value={balances.data === undefined
              ? "Loading…"
              : formatTokenBalance(balances.data.amount, "USDC.e")}
          />
          <Detail label="Signer" value={payment?.accessKeyAddress ?? "Managed by Tempo Accounts"} />
          <Detail label="Channel" value={payment?.channelId ?? "Opens on first paid request"} />
          <Detail label="Cumulative" value={payment ? formatTokenBalance(BigInt(payment.cumulative), "USDC.e") : "0 USDC.e"} />
        </dl>
      ) : null}
      {jsonl.length ? (
        <details className="agent-mpp-jsonl">
          <summary>MPP run JSONL ({jsonl.length})</summary>
          <pre>{jsonl.join("\n")}</pre>
        </details>
      ) : null}
    </aside>
  );
}

function Detail({ label, value }: { label: string; value: string | undefined }) {
  return <><dt>{label}</dt><dd title={value}>{value}</dd></>;
}

function formatTokenBalance(amount: bigint, symbol: string) {
  return `${formatUnits(amount, 6)} ${symbol}`;
}
