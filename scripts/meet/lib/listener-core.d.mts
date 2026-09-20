/**
 * Types for `listener-core.mjs`, so `tests/meetLive.test.ts` can drive the real loop under strict
 * TypeScript. The module itself stays JavaScript: it runs on the Mac under plain `node`, with no
 * build step, exactly as the seat claimer does.
 */
export const VERSION: string;
export const RETRY_FAILED_MS: number;
export const SCOPE_PROBE_EVERY_MS: number;
export const SPACE_RECHECK_MS: number;
export const SCOPES: { meetRead: string; meetMedia: string };

export interface ListenerSlice {
  audio_base64: string;
  content_type: string;
  seconds: number;
}

export interface ListenerPeer {
  createOffer(): Promise<string>;
  setAnswer(answer: string): Promise<void>;
  onSlice(cb: (slice: ListenerSlice) => void): void;
  onStatus(cb: (status: { state: "WAITING" | "JOINED" | "DISCONNECTED"; reason?: string }) => void): void;
  leave(): Promise<void>;
}

export interface ListenerDeps {
  worker(path: string, body?: unknown, method?: string): Promise<{ status: number; body: any }>;
  google: {
    token(scopes: string[], subject: string | null): Promise<string>;
    getSpace(token: string, spaceName: string): Promise<any>;
    connectActiveConference(token: string, spaceName: string, offer: string): Promise<{ answer: string }>;
  };
  createPeer(): Promise<ListenerPeer>;
  now(): number;
  log(line: string): void;
  deviceId: string;
  subject: string | null;
}

export interface ActiveEntry {
  sessionId: string;
  conferenceRecord: string;
  spaceName: string;
  peer: ListenerPeer;
  sequence: number;
  lastSpaceCheck: number;
  ended: boolean;
  pending?: Promise<void>;
}

export function createListener(deps: ListenerDeps): {
  cycle(): Promise<{ due: number; active: number; media_scope?: string }>;
  shutdown(reason?: string): Promise<void>;
  active: Map<string, ActiveEntry>;
};

export function selfTest(): Promise<{ calls: number; reports: number; chunks: number }>;
