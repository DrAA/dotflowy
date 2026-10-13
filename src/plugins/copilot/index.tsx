// Microsoft 365 Copilot slash command (ADR 0062). Seam C only: `/copilot`
// opens the prompt dialog (slash can't carry args — whitespace closes the
// menu). The Worker holds the delegated Graph token; reply replaces the
// bullet via onTextChange. No Node field, no side-collection.

import { SparklesIcon } from "lucide-react";

import { openCopilotDialog } from "../../components/copilot-opener";
import { definePlugin } from "../types";

export default definePlugin({
  id: "copilot",

  commands: [
    {
      id: "copilot",
      label: "Copilot",
      description: "Ask Microsoft 365 Copilot",
      icon: SparklesIcon,
      keywords: ["copilot", "microsoft", "m365", "ai", "ask", "work"],
      available: () => true,
      run: (id, ctx) =>
        openCopilotDialog({
          nodeId: id,
          onTextChange: ctx.mutations.onTextChange,
        }),
    },
  ],
});
