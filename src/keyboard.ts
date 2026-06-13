export type PromptKeyState = {
  key: string;
  shiftKey?: boolean;
  altKey?: boolean;
  isComposing?: boolean;
  keyCode?: number;
};

export function shouldSubmitPromptOnKeydown(event: PromptKeyState, compositionActive: boolean): boolean {
  return event.key === "Enter" && event.shiftKey !== true && event.altKey !== true && event.isComposing !== true && !compositionActive && event.keyCode !== 229;
}
