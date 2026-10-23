import { appendFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

function escapeData(value) {
  return String(value).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
}

export function createIO({ env = process.env, write = (text) => process.stdout.write(text) } = {}) {
  const outputs = {};
  return {
    outputs,
    info(message) {
      write(`${message}\n`);
    },
    warning(message) {
      write(`::warning::${escapeData(message)}\n`);
    },
    error(message) {
      write(`::error::${escapeData(message)}\n`);
    },
    mask(value) {
      if (value) {
        write(`::add-mask::${value}\n`);
      }
    },
    setOutput(name, value) {
      const text = value === null || value === undefined ? '' : String(value);
      outputs[name] = text;
      if (!env.GITHUB_OUTPUT) {
        write(`${name}=${text}\n`);
        return;
      }
      if (text.includes('\n')) {
        const delimiter = `EOF_${randomUUID()}`;
        appendFileSync(env.GITHUB_OUTPUT, `${name}<<${delimiter}\n${text}\n${delimiter}\n`);
      } else {
        appendFileSync(env.GITHUB_OUTPUT, `${name}=${text}\n`);
      }
    },
    summary(markdown) {
      if (env.GITHUB_STEP_SUMMARY) {
        appendFileSync(env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
      }
    },
  };
}
