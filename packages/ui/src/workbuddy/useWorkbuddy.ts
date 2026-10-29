import { useCallback, useEffect, useRef, useState } from "react";
import type { WorkbuddyAccountView, WorkbuddyCommand } from "./contract.js";
import { useServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";

/** 只轮询 Host 的本地投影；status 不请求 WorkBuddy 余额或任何上游接口。 */
export function useWorkbuddy(providerId?: string, sessionId?: string) {
  const { providerSettingsService } = useServices();
  const { intl } = useZCodeIntl();
  const [state, setState] = useState<WorkbuddyAccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const epoch = useRef(0);
  const actionPending = useRef(false);
  const execute = useCallback(
    async (command: WorkbuddyCommand) => {
      if (!providerSettingsService.workbuddy)
        throw new Error(intl.formatMessage({ id: "workbuddy.localOnly" }));
      return providerSettingsService.workbuddy(command);
    },
    [providerSettingsService, intl],
  );

  useEffect(() => {
    const current = ++epoch.current;
    let reading = false;
    setState(undefined);
    setError("");
    setBusy(false);
    actionPending.current = false;
    if (!providerId) return;
    const read = async () => {
      if (reading || actionPending.current) return;
      reading = true;
      try {
        const next = await execute({ type: "status", providerId, sessionId });
        if (epoch.current === current && !actionPending.current) {
          setState(next);
          setError("");
        }
      } catch (reason) {
        if (epoch.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : intl.formatMessage({ id: "workbuddy.failed" }),
          );
      } finally {
        reading = false;
      }
    };
    void read();
    const timer = setInterval(() => {
      void read();
    }, 3000);
    return () => {
      clearInterval(timer);
      epoch.current++;
    };
  }, [execute, providerId, sessionId, intl]);

  const run = useCallback(
    async (
      type: Exclude<WorkbuddyCommand["type"], "create" | "poll"> | "poll",
      argument?: string | boolean,
    ) => {
      if (!providerId || actionPending.current) return;
      const current = epoch.current;
      actionPending.current = true;
      setBusy(true);
      setError("");
      try {
        const next = await execute(
          type === "poll"
            ? { type, providerId, loginId: String(argument) }
            : type === "import-login"
              ? { type, providerId, text: String(argument) }
              : type === "set-model-fallback"
                ? { type, providerId, enabled: argument === true }
                : { type, providerId, sessionId },
        );
        if (epoch.current === current) {
          if (type !== "export-login") setState(next);
          return next;
        }
      } catch (reason) {
        if (epoch.current === current)
          setError(
            reason instanceof Error
              ? reason.message
              : intl.formatMessage({ id: "workbuddy.failed" }),
          );
        return undefined;
      } finally {
        if (epoch.current === current) {
          actionPending.current = false;
          setBusy(false);
        }
      }
    },
    [execute, providerId, sessionId, intl],
  );

  return {
    state: state?.providerId === providerId ? state : undefined,
    busy,
    error,
    run,
    setError,
  };
}
