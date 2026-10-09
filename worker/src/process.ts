import { spawn } from "node:child_process";

export async function runProcess(
  command: string,
  args: string[],
  options: { timeoutMs?: number; onStderr?: (chunk: string) => void; maxOutputBytes?: number } = {},
): Promise<{ stdout: string; stderr: string }> {
  const timeoutMs = options.timeoutMs ?? Number(process.env.PROCESS_TIMEOUT_MS || "180000");
  const maxOutputBytes = options.maxOutputBytes ?? 16384;
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32" });
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      // Kill ffmpeg descendants too, otherwise they keep pipes and files open.
      try {
        if (process.platform !== "win32" && child.pid) process.kill(-child.pid, "SIGKILL");
        else child.kill("SIGKILL");
      } catch { child.kill("SIGKILL"); }
    }, timeoutMs);
    child.stdout.on("data", (chunk: Buffer) => { stdout = (stdout + chunk.toString()).slice(-maxOutputBytes); });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr = (stderr + chunk.toString()).slice(-16384);
      options.onStderr?.(chunk.toString());
    });
    child.on("error", (error) => { clearTimeout(timer); reject(error); });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (timedOut) reject(new Error(`${command} timeout after ${timeoutMs}ms: ${stderr}`));
      else if (code !== 0) reject(new Error(`${command} exit ${code ?? signal}: ${stderr}`));
      else resolve({ stdout, stderr });
    });
  });
}
