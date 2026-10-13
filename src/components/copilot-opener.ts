export type CopilotOpenArgs = {
  nodeId: string;
  /** Replace the bullet text with the Copilot reply (`mutations.onTextChange`). */
  onTextChange: (id: string, text: string) => void;
};

let opener: ((args: CopilotOpenArgs) => void) | null = null;

export function setCopilotDialogOpener(fn: typeof opener) {
  opener = fn;
}

/** Open the Microsoft 365 Copilot prompt dialog for one bullet (`/copilot`). */
export function openCopilotDialog(args: CopilotOpenArgs) {
  opener?.(args);
}
