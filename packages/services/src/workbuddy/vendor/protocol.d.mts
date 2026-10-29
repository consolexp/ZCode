import type { ServerResponse } from "node:http";
import type { WorkbuddyCore } from "./wb-proxy.mjs";

type Stream = AsyncIterable<Uint8Array>;
export function responseRequest(
  wb: WorkbuddyCore,
  body: Record<string, unknown>,
): Record<string, unknown>;
export function events(
  stream: Stream,
): AsyncGenerator<{ done?: boolean; event?: { usage?: { credit?: number } } }>;
export function relay(
  stream: Stream,
  res: ServerResponse,
  options: {
    wb: WorkbuddyCore;
    alias: string;
    expected: string;
    responses: boolean;
    stream: boolean;
  },
): Promise<void>;
