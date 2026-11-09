import { spawn } from 'node:child_process';
import { delimiter, resolve } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const child = spawn(
  process.env.PYTHON ?? 'python',
  ['-m', 'uv', ...process.argv.slice(2)],
  {
    cwd: resolve(root, 'services/ai-service'),
    env: {
      ...process.env,
      PYTHONPATH: [resolve(root, '.tools/uv'), process.env.PYTHONPATH]
        .filter(Boolean)
        .join(delimiter),
    },
    stdio: 'inherit',
  },
);
child.on('error', () => {
  console.error('无法启动 Python/uv；先按 README 安装项目工具。');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
