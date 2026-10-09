/** Retitles the session through the host title generator once Atlas starts executing a plan. */

/** Verbatim copy of the host's private bundled title prompt (`prompts/system/title-system.md`, OMP 18.5.1+). */
const HOST_DEFAULT_TITLE_PROMPT = `You name coding-agent sessions. Write a 3-6 word title for the task in the next message.

Output exactly one line: the title inside \`<title>\` tags, or \`<title/>\` when there is no task to name.

Rules:
- Name the user's goal as a short imperative phrase built from the user's own key words (the feature, component, or error they name). Avoid vague filler like "logic", "issues", "functionality".
- \`[Image #N, WxH]\` marks an image you cannot see. Never mention it or guess what it shows; title the task the surrounding words name.
- Answer \`<title/>\` for greetings, acknowledgements, gibberish, or requests too vague to name without context you cannot see ("help", "fix this", "what's wrong?").
- A \`<chat>\` block summarizes a longer session: its first \`<user>\` turn is the opening request, followed by recent turns (often the assistant's working notes). Title the goal the session is working on, using the opening request unless later turns clearly moved to a new task; never title the current micro-step, and ignore file names and symbols unless they are the subject.
- No quotes, trailing punctuation, or explanations.

Examples:
- "the retry queue drops jobs when redis restarts, can u look" → \`<title>Fix retry queue dropping jobs</title>\`
- "can we get rid of the npm run build warning about peer deps" → \`<title>Remove peer dependency build warning</title>\`
- \`<chat>\` with only assistant notes like "adding a backoff field to RetryPolicy… now wiring jitter into schedule()" → \`<title>Add retry backoff with jitter</title>\``;

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
