import type {
  HarnessDescriptor,
  HarnessStatus,
  Model,
  QuestionAnswer,
  QuestionDefinition,
  RunItem,
} from '@isles/contracts';
import type { AgentRecord } from '../storage/store.js';

export type HarnessRequestId = string | number;

export interface HarnessContextUsage {
  usedTokens: number;
  maxTokens: number | null;
  estimated: boolean;
}

export interface HarnessCatalog {
  status(): Promise<HarnessStatus>;
  models(): Promise<Model[]>;
  invalidate?(): void;
}

export type HarnessEvent =
  | { type: 'context_usage'; sessionId: string; usage: HarnessContextUsage | null }
  | { type: 'turn_started'; sessionId: string; turnId: string }
  | {
      type: 'turn_completed';
      sessionId: string;
      turnId: string;
      status: 'completed' | 'interrupted' | 'failed';
      error: string | null;
    }
  | {
      type: 'item';
      sessionId: string;
      turnId: string | null;
      item: RunItem;
      append: boolean;
    };

export interface HarnessQuestion {
  sessionId: string;
  turnId: string;
  requestId: HarnessRequestId;
  questions: QuestionDefinition[];
}

export interface HarnessHandlers {
  /** Publish before native initialization waits, so stop/shutdown can close the process. */
  connected(session: HarnessSession): void;
  event(event: HarnessEvent): void;
  question(question: HarnessQuestion): void;
  exit(error: Error): void;
}

export interface HarnessTurnInput {
  sessionId: string;
  runId: string;
  text: string;
  model: string;
  reasoningEffort: string;
  workspace: string;
}

export interface HarnessSteerInput {
  sessionId: string;
  expectedTurnId: string;
  batchId: string;
  text: string;
}

/** Protocol-specific initialization, parameters and event parsing belong to the adapter. */
export interface HarnessSession {
  /** Persist the native ID before initialization or guidance verification can fail. */
  createSession(onCreated: (sessionId: string) => void): Promise<string>;
  resumeSession(sessionId: string): Promise<string>;
  submit(input: HarnessTurnInput): Promise<{ turnId: string }>;
  /** Append to the exact active turn; optional only when the adapter declares no steer support. */
  steer?(input: HarnessSteerInput): Promise<{ turnId: string }>;
  interrupt(sessionId: string, turnId: string): Promise<void>;
  answer(requestId: HarnessRequestId, answer: QuestionAnswer): void;
  rejectQuestion(requestId: HarnessRequestId, reason: string): void;
  close(): Promise<void>;
}

export interface HarnessAdapter {
  readonly descriptor: HarnessDescriptor;
  readonly nativeHome: string;
  readonly catalog: HarnessCatalog;
  connect(agent: AgentRecord, baseUrl: string, handlers: HarnessHandlers): Promise<HarnessSession>;
  /** Clear discovery/model caches after explicit refresh or application configuration changes. */
  invalidate(): void;
}

/** A definite native refusal; other submission errors retain an uncertain outcome. */
export class HarnessSubmissionRejected extends Error {}
