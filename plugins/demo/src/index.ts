import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

import { PLUGIN_ID } from "#src/constants.ts";

export default function demoPlugin(pi: ExtensionAPI) {
  const z = pi.zod;

  pi.registerCommand("demo-hello", {
    description: "Print a greeting from the demo plugin",
    handler: async (args, ctx) => {
      ctx.ui.notify(`Hello, ${args.trim() || "world"} — from ${PLUGIN_ID}`, "info");
    },
  });

  // Declared separately so `execute` can annotate its params: `registerTool`
  // infers `Static<TParams>` as `unknown` for the injected zod builder.
  const parameters = z.object({
    text: z.string().describe("Text to count"),
  });

  pi.registerTool({
    name: "demo_word_count",
    label: "Demo Word Count",
    description: "Count the words in a string",
    approval: "read",
    parameters,
    async execute(_id, params: typeof parameters.infer) {
      const count = params.text.split(/\s+/).filter(Boolean).length;
      return {
        content: [{ type: "text", text: String(count) }],
        details: { count },
      };
    },
  });
}
