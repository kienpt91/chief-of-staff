import fs from "node:fs";
import path from "node:path";
import type { Ctx } from "./context.js";
import { CosError } from "./errors.js";
import { atomicWriteJson } from "./fsutil.js";
import { refreshTx } from "./tasks.js";
import { MESSAGE_TYPES, type Message, type MessageType } from "./types.js";

export interface SendInput {
  runId: string;
  type: MessageType;
  body: string;
  from?: string;
  /** "coordinator" (default) or a task id: the message is also delivered to the task's worktree inbox */
  to?: string;
  taskId?: string;
  dispatchId?: string;
  payload?: Record<string, unknown>;
}

export function sendMessage(ctx: Ctx, input: SendInput): Message {
  if (!MESSAGE_TYPES.includes(input.type)) {
    throw new CosError(`message type must be one of: ${MESSAGE_TYPES.join(", ")}`);
  }
  if (input.body.trim() === "") throw new CosError("message body must not be empty");
  const to = input.to ?? "coordinator";
  ctx.store.getRun(input.runId);
  const message = ctx.store.tx(input.runId, (s) => {
    if (input.taskId) s.getTask(input.runId, input.taskId);
    if (to !== "coordinator") s.getTask(input.runId, to);
    return s.addMessage({
      runId: input.runId,
      type: input.type,
      from: input.from ?? "coordinator",
      to,
      taskId: input.taskId ?? (to === "coordinator" ? undefined : to),
      dispatchId: input.dispatchId,
      body: input.body,
      payload: input.payload,
    });
  });
  if (to !== "coordinator") deliverToWorktree(ctx, message);
  return message;
}

/** Best-effort delivery of a coordinator-to-task message into the task's `.cos/inbox/`. */
function deliverToWorktree(ctx: Ctx, message: Message): void {
  const task = ctx.store.findTask(message.runId, message.to);
  const dispatch = task?.lastDispatchId ? ctx.store.findDispatch(message.runId, task.lastDispatchId) : undefined;
  if (!dispatch?.worktree || !fs.existsSync(dispatch.worktree)) return;
  atomicWriteJson(path.join(dispatch.worktree, ".cos", "inbox", `${message.id}.json`), message);
}

export interface InboxQuery {
  runId: string;
  /** include acknowledged messages */
  all?: boolean;
  type?: MessageType;
}

export function listInbox(ctx: Ctx, q: InboxQuery): Message[] {
  ctx.store.getRun(q.runId);
  return ctx.store
    .listMessages(q.runId)
    .filter((m) => m.to === "coordinator")
    .filter((m) => q.all || (!m.ackedAt && !(m.type === "question" && m.answer)))
    .filter((m) => !q.type || m.type === q.type);
}

export function ackMessages(ctx: Ctx, runId: string, ids: string[] | "all"): string[] {
  return ctx.store.tx(runId, (s) => {
    const targets =
      ids === "all"
        ? s.listMessages(runId).filter((m) => m.to === "coordinator" && !m.ackedAt)
        : ids.map((id) => s.getMessage(runId, id));
    const acked: string[] = [];
    const now = new Date().toISOString();
    for (const m of targets) {
      if (m.ackedAt) continue;
      m.ackedAt = now;
      s.putMessage(m);
      acked.push(m.id);
    }
    return acked;
  });
}

/**
 * Answers a worker question. If the worker is still running it receives `.cos/answer.json`;
 * if it exited to wait for the answer, its task becomes schedulable again.
 */
export function answerQuestion(ctx: Ctx, runId: string, messageId: string, text: string): Message {
  if (text.trim() === "") throw new CosError("an answer needs non-empty text");
  const { message, worktree, running } = ctx.store.tx(runId, (s) => {
    const m = s.getMessage(runId, messageId);
    if (m.type !== "question") throw new CosError(`message ${messageId} is a ${m.type}, not a question`);
    if (m.answer) throw new CosError(`question ${messageId} is already answered`);
    const now = new Date().toISOString();
    m.answer = { text: text.trim(), at: now };
    m.ackedAt = m.ackedAt ?? now;
    s.putMessage(m);

    const dispatch = m.dispatchId ? s.findDispatch(runId, m.dispatchId) : undefined;
    const task = m.taskId ? s.findTask(runId, m.taskId) : undefined;
    if (task?.blocked?.kind === "question" && task.blocked.ref === m.id) {
      task.blocked = undefined;
      task.status = "pending";
      s.putTask(task);
      refreshTx(s, runId);
    }
    return {
      message: m,
      worktree: dispatch?.worktree,
      running: dispatch?.status === "running",
    };
  });
  if (running && worktree) {
    atomicWriteJson(path.join(worktree, ".cos", "answer.json"), {
      messageId: message.id,
      question: message.body,
      answer: message.answer?.text,
      answeredAt: message.answer?.at,
    });
  }
  return message;
}
