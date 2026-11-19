export function needsTranslation(text: string): boolean {
  return /(?=\p{L})\P{Script=Latin}/u.test(text);
}

export class TranslationCache {
  readonly #messages = new Map<string, Promise<string>>();

  constructor(
    private readonly translateToEnglish: (text: string) => Promise<string>,
    seed?: ReadonlyMap<string, string>,
    private readonly onTranslated?: (messageId: string, text: string) => void,
  ) {
    for (const [id, text] of seed ?? []) this.#messages.set(id, Promise.resolve(text));
  }

  async translate(text: string, messageId?: string): Promise<string> {
    if (!needsTranslation(text)) return text;
    if (messageId === undefined) return this.translateToEnglish(text);
    let translation = this.#messages.get(messageId);
    if (!translation) {
      translation = this.translateToEnglish(text).then(
        (english) => {
          this.onTranslated?.(messageId, english);
          return english;
        },
        (error: unknown) => {
          this.#messages.delete(messageId);
          throw error;
        },
      );
      this.#messages.set(messageId, translation);
    }
    return translation;
  }
}
