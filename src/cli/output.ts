export interface OutputContext {
  readonly json: boolean;
  readonly plain: boolean;
  readonly isTTY: boolean;
}

export type HumanRenderer<T> = (value: T) => string;

export function usesHumanOutput(context: OutputContext): boolean {
  if (context.json) return false;
  return context.plain || context.isTTY;
}

export function renderOutput<T>(
  value: T,
  context: OutputContext,
  humanRenderer?: HumanRenderer<T>,
): string {
  if (humanRenderer !== undefined && usesHumanOutput(context)) {
    const rendered = humanRenderer(value);
    return rendered.endsWith("\n") ? rendered : `${rendered}\n`;
  }
  return `${JSON.stringify(value, null, 2)}\n`;
}
