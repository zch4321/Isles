import type {
  HarnessDescriptor,
  HarnessStatus,
  ImageMimeType,
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

/** Live activities from the bound root or a descendant whose ownership the adapter verified. */
export type HarnessEvent =
  | { type: 'context_usage'; sessionId: string; usage: HarnessContextUsage | null }
  | {
      type: 'question_expired';
      sessionId: string;
      turnId: string;
      requestId: HarnessRequestId;
    }
  | { type: 'turn_started'; sessionId: string; turnId: string }
  | {
      type: 'turn_completed';
      sessionId: string;
      turnId: string;
      status: 'completed' | 'interrupted' | 'failed';
      error: string | null;
    }
  | {
      /** item_delta stays in memory; item publishes a complete output or discrete state. */
      type: 'item' | 'item_delta';
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
  images?: HarnessInputImage[];
  /** Notify the Runtime around adapter preflight and immediately before native dispatch. */
  submissionState?: (state: 'preparing' | 'submitting') => void;
}

/** Normal input carries image bytes; steer carries only paths in its text envelope. */
export interface HarnessInputImage {
  id: string;
  path: string;
  mimeType: ImageMimeType;
  data: string;
  label: string;
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
  /** Resolve on native input consumption; activity completion arrives independently as an event. */
  submit(input: HarnessTurnInput): Promise<{ turnId: string }>;
  /** Target expectedTurnId; return the actual consuming turn, including a native queued continuation. */
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

/** The selected native model or harness cannot consume image input. */
export class HarnessImageInputUnsupported extends HarnessSubmissionRejected {}
