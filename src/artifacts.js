import fs from 'node:fs/promises';
import path from 'node:path';

/** Dossier d'artefacts d'une compilation : captures, différences, HTML candidat, rapport. */
export function artifactStore(baseDir) {
  return {
    dir: baseDir,
    scope(sub) {
      const dir = path.join(baseDir, sub);
      return async (name, data) => {
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(path.join(dir, name), data);
      };
    },
    async save(name, data) {
      await fs.mkdir(baseDir, { recursive: true });
      await fs.writeFile(path.join(baseDir, name), data);
    },
  };
}

/** Supprime les dossiers de compilation plus anciens que la durée de conservation. */
export async function purgeArtifacts(jobsDir, retentionDays, now = Date.now()) {
  let removed = 0;
  let entries = [];
  try {
    entries = await fs.readdir(jobsDir, { withFileTypes: true });
  } catch {
    return 0;
  }
  const limit = now - retentionDays * 24 * 3600 * 1000;
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const full = path.join(jobsDir, e.name);
    const stat = await fs.stat(full);
    if (stat.mtimeMs < limit) {
      await fs.rm(full, { recursive: true, force: true });
      removed += 1;
    }
  }
  return removed;
}
