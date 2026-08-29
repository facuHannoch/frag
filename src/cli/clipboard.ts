import { spawn } from "node:child_process";

interface ClipboardCommand {
  readonly command: string;
  readonly args: readonly string[];
}

export interface ClipboardRunner {
  run(command: string, args: readonly string[], content: string): Promise<boolean>;
}

class ProcessClipboardRunner implements ClipboardRunner {
  run(command: string, args: readonly string[], content: string): Promise<boolean> {
    return new Promise((resolve) => {
      const child = spawn(command, [...args], { stdio: ["pipe", "ignore", "ignore"] });
      child.once("error", () => resolve(false));
      child.once("exit", (code) => resolve(code === 0));
      child.stdin.on("error", () => undefined);
      child.stdin.end(content);
    });
  }
}

export function clipboardCommands(platform: NodeJS.Platform): readonly ClipboardCommand[] {
  if (platform === "darwin") return [{ command: "pbcopy", args: [] }];
  if (platform === "win32") return [{ command: "clip.exe", args: [] }];
  return [
    { command: "wl-copy", args: [] },
    { command: "xclip", args: ["-selection", "clipboard"] },
    { command: "xsel", args: ["--clipboard", "--input"] },
  ];
}

export async function copyToClipboard(
  content: string,
  options: { readonly platform?: NodeJS.Platform; readonly runner?: ClipboardRunner } = {},
): Promise<void> {
  const platform = options.platform ?? process.platform;
  const runner = options.runner ?? new ProcessClipboardRunner();
  for (const candidate of clipboardCommands(platform)) {
    if (await runner.run(candidate.command, candidate.args, content)) return;
  }
  const expected = clipboardCommands(platform).map(({ command }) => command).join(", ");
  throw new Error(`Could not access the system clipboard. Install or enable one of: ${expected}`);
}
