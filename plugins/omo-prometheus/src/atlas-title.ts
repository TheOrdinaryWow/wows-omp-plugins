/** Retitles the session through the host title generator once Atlas starts executing a plan. */

/** Verbatim copy of the host's private bundled title prompt (`prompts/system/title-system.md`). */
const HOST_DEFAULT_TITLE_PROMPT = `Write a ~5 word title using only the task described in the next user message.
- You MUST ONLY answer with the title, inside the <title> tag.
- If the message names no concrete task, answer \`<title/>\`. This covers greetings and requests too vague to title without context you cannot see (e.g. "help", "fix this", "what's wrong?" about an attachment). NEVER guess the task.`;

const ATLAS_TITLE_RULES = `This session has left planning and is now executing the approved plan in the next user message (Atlas execution mode).
- Title the work the plan carries out, not the act of planning it.
- Start the title with "Atlas" so the session reads as an execution session.
- Every rule above still applies and wins wherever it conflicts with these.`;

/** The host truncates title input to 2000 characters; keep the plan's opening, where its goal lives. */
const PLAN_EXCERPT_CHARS = 1800;

export interface AtlasTitleSession {
  readonly titleSystemPrompt: string | undefined;
  readonly titleGenerationSignal: AbortSignal;
  readonly sessionManager: { getSessionId(): string; readonly titleSource: "auto" | "user" | undefined };
  generateTitle(input: string, customSystemPrompt?: string): Promise<string | null>;
  setSessionName(name: string, source: "auto" | "user"): Promise<boolean>;
}

/** The user's TITLE_SYSTEM.md override, or the host default, followed by the Atlas rules. */
export function atlasTitlePrompt(override: string | undefined): string {
  return `${override?.trim() || HOST_DEFAULT_TITLE_PROMPT}\n\n${ATLAS_TITLE_RULES}`;
}

export function atlasTitleInput(planName: string, content: string): string {
  return `Approved plan: ${planName}\n\n${content.trim().slice(0, PLAN_EXCERPT_CHARS)}`;
}

const latestRequest = new WeakMap<AtlasTitleSession, object>();

/**
 * Generates an Atlas title for the session and stores it as an automatic name, falling back to
 * `Atlas: <plan name>` when the model yields none. Names the user chose are never replaced, and a
 * later call for the same session supersedes an earlier one still in flight.
 */
export async function retitleForAtlas(session: AtlasTitleSession, plan: { name: string; content: string }): Promise<void> {
  const manager = session.sessionManager;
  // A local keeps TypeScript from narrowing `manager.titleSource` across the await below.
  const initialSource = manager.titleSource;
  if (process.env.PI_NO_TITLE || initialSource === "user") return;
  const sessionId = manager.getSessionId();
  const request = {};
  latestRequest.set(session, request);
  const title = await session
    .generateTitle(atlasTitleInput(plan.name, plan.content), atlasTitlePrompt(session.titleSystemPrompt))
    .catch(() => null);
  if (
    latestRequest.get(session) !== request ||
    // The host aborts this signal for good only on disposal; interrupts replace it with a fresh one.
    session.titleGenerationSignal.aborted ||
    manager.getSessionId() !== sessionId ||
    manager.titleSource === "user"
  )
    return;
  await session.setSessionName(title ?? `Atlas: ${plan.name}`, "auto");
}
