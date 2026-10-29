import type { WorkbuddyPort } from "./contract.js";

export async function createWorkbuddyChannel(port: WorkbuddyPort) {
  const account = await port.execute({ type: "create", name: "WorkBuddy 国内" });
  return port.execute({ type: "login", providerId: account.providerId });
}

export async function importWorkbuddyLogin(
  port: WorkbuddyPort,
  providerId: string,
  pastedText: string,
) {
  await port.execute({ type: "import-login", providerId, text: pastedText });
  return port.execute({ type: "set-model-fallback", providerId, enabled: false });
}
