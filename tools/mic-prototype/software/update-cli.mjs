import { fileURLToPath } from 'node:url';
import { resolve, isAbsolute } from 'node:path';
import { runUpdateCommand, safeUpdateError } from './updates.mjs';

export function parseUpdateArguments(args) {
  const names = new Map([['--package-root', 'packageRoot'], ['--data-root', 'dataRoot'], ['--command', 'command']]), result = {};
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]), value = args[index + 1];
    if (!name || Object.hasOwn(result, name) || typeof value !== 'string' || value.length === 0 || /[\u0000-\u001f]/.test(value))
      throw Object.assign(new Error('update_arguments_invalid'), { safeCode: 'update_arguments_invalid' });
    result[name] = value;
  }
  if (!isAbsolute(result.packageRoot ?? '') || !isAbsolute(result.dataRoot ?? '') || !['check', 'download-app', 'download-components'].includes(result.command))
    throw Object.assign(new Error('update_arguments_invalid'), { safeCode: 'update_arguments_invalid' });
  return result;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  let command = null;
  const emit = value => process.stdout.write(JSON.stringify(value) + '\n');
  try {
    const options = parseUpdateArguments(process.argv.slice(2)); command = options.command;
    await runUpdateCommand(options, { emit });
  } catch (error) {
    emit({ event: 'failed', command, code: safeUpdateError(error) }); process.exitCode = 1;
  }
}
