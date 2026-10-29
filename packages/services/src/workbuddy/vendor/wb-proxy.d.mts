import type { EventEmitter } from "node:events";
import type { PassThrough, Readable } from "node:stream";
import type { WorkbuddyAuth } from "../upstream.js";

export interface UpstreamResponse {
  ok: boolean;
  status: number;
  stream: Readable & { statusCode: number };
  text(): Promise<string>;
}
export interface WorkbuddyCore {
  handleChat(req: EventEmitter, res: PassThrough, body: string): Promise<void>;
  responsesToChat(body: Record<string, unknown>): Record<string, unknown>;
  chatToResponseObject(body: Record<string, unknown>): Record<string, unknown>;
  mapUsage(usage: unknown): unknown;
}
export function createWorkbuddy(embedding: {
  endpoint: string;
  request(
    url: string,
    options: { method: string; headers: Record<string, string>; body: string },
  ): Promise<Readable & { statusCode: number }>;
  withAuthRetry(
    fn: (auth: WorkbuddyAuth) => Promise<UpstreamResponse>,
  ): Promise<{ up: UpstreamResponse }>;
}): WorkbuddyCore;
