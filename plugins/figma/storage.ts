import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";

/** Plugin-owned secrets only. The directory must come from scoped BB storage. */
export function privateJsonStore(directory: string, name: string) {
  if (!/^[a-z][a-z0-9-]*$/.test(name)) throw new Error("Invalid credential store name.");
  const path = join(directory, `${name}.json`);
  let tail: Promise<void> = Promise.resolve();
  const serialize = <T>(action: () => Promise<T>): Promise<T> => {
    const result = tail.then(action);
    tail = result.then(() => undefined, () => undefined);
    return result;
  };
  return {
    read(): Promise<Record<string, unknown> | null> {
      return serialize(async () => {
        let raw: string;
        try { raw = await readFile(path, "utf8"); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
          throw new Error("Could not read the saved Figma connection.");
        }
        try {
          const parsed: unknown = JSON.parse(raw);
          if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
          return parsed as Record<string, unknown>;
        } catch { throw new Error("Saved Figma connection is invalid. Reconnect in settings."); }
      });
    },
    write(value: Record<string, unknown> | null): Promise<void> {
      // Capture now so a caller cannot mutate data while a queued write waits.
      const encoded = value === null ? null : JSON.stringify(value);
      return serialize(async () => {
        if (encoded === null) {
          try { await unlink(path); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw new Error("Could not remove the saved Figma connection.");
          }
          return;
        }
        let temporary: string | undefined;
        try {
          await mkdir(directory, { recursive: true, mode: 0o700 });
          await chmod(directory, 0o700);
          temporary = join(directory, `.${name}-${randomUUID()}.tmp`);
          await writeFile(temporary, encoded, { mode: 0o600, flag: "wx" });
          await rename(temporary, path);
        } catch {
          throw new Error("Could not save the Figma connection.");
        } finally {
          if (temporary) await unlink(temporary).catch(() => undefined);
        }
      });
    },
  };
}
