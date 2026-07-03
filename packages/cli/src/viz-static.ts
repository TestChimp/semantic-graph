import fs from 'fs';
import path from 'path';

/** Resolve bundled viz assets (published tarball or monorepo dev layout). */
export function resolveVizDistDir(): string {
  const candidates = [
    path.join(__dirname, '..', 'static', 'viz'),
    path.join(__dirname, '..', '..', 'viz', 'dist'),
  ];
  for (const dir of candidates) {
    if (fs.existsSync(path.join(dir, 'index.html'))) {
      return dir;
    }
  }
  throw new Error(
    'Viz UI not found. Reinstall @testchimp/semantic-graph or run npm run build in the monorepo.',
  );
}
