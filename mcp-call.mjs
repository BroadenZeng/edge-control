#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline';

const [tool, rawArgsText = '{}', serverPath = 'C:\\Users\\Broaden\\Documents\\deepseek-harness\\default-workspace\\mcp-edge-server.mjs'] = process.argv.slice(2);

function fail(message) {
  process.stderr.write(`${message}\n`);
  process.exitCode = 1;
}

function responseLine(child, lines, timeoutMs, expectedId) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`Timed out waiting ${timeoutMs} ms for MCP response id ${expectedId}.`)), timeoutMs);
    const onLine = (line) => {
      try {
        const response = JSON.parse(line);
        if (response.id === expectedId) finish(null, response);
        else lines.push(line);
      } catch {
        lines.push(line);
      }
    };
    const onClose = () => finish(new Error('MCP server closed stdout before replying.'));
    const onError = (error) => finish(error);
    const finish = (error, value) => {
      clearTimeout(timer);
      lines.off('line', onLine);
      lines.off('close', onClose);
      child.off('error', onError);
      error ? reject(error) : resolve(value);
    };
    lines.on('line', onLine);
    lines.once('close', onClose);
    child.once('error', onError);
  });
}

async function main() {
  if (!tool) throw new Error('Usage: node mcp-call.mjs <tool> [arguments-json] [server-path]');
  let argsText = rawArgsText;
  if (argsText.startsWith('@')) argsText = readFileSync(argsText.slice(1), 'utf8');
  argsText = argsText.replace(/^\uFEFF/, '');
  let args;
  try {
    args = JSON.parse(argsText);
  } catch (error) {
    throw new Error(`Invalid arguments JSON: ${error.message}`);
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Tool arguments must be a JSON object.');

  const child = spawn(process.execPath, [serverPath], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-12000); });

  const closePromise = new Promise((resolve) => child.once('close', (code, signal) => resolve({ code, signal })));
  const init = { jsonrpc: '2.0', id: 1, method: 'initialize', params: {
    protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 'codex-edge-control-skill', version: '1.0' },
  } };

  try {
    child.stdin.write(`${JSON.stringify(init)}\n`);
    const initResponse = await responseLine(child, lines, 5000, 1);
    if (initResponse.error) throw new Error(`MCP initialize failed: ${initResponse.error.message}`);

    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: tool, arguments: args } })}\n`);
    child.stdin.end();

    const callTimeout = tool === 'tm_push' ? 120000 : tool === 'run_command'
      ? Math.max(10000, Number(args.timeoutMs ?? 60000) + 5000)
      : 15000;
    const response = await responseLine(child, lines, callTimeout, 2);
    if (response.error) throw new Error(`MCP tool call failed: ${response.error.message}`);
    if (response.result?.isError) {
      const detail = response.result.content?.map((item) => item.text || '').filter(Boolean).join('\n');
      throw new Error(`MCP tool returned an error${detail ? `: ${detail}` : '.'}`);
    }
    process.stdout.write(`${JSON.stringify(response.result)}\n`);
    child.stdin.destroy();
    child.kill();
    await closePromise;
  } catch (error) {
    child.stdin.destroy();
    if (child.exitCode === null) child.kill();
    await Promise.race([closePromise, new Promise((resolve) => setTimeout(resolve, 500))]);
    const details = stderr.trim();
    throw new Error(`${error.message}${details ? `\nServer stderr:\n${details}` : ''}`);
  } finally {
    lines.close();
  }
}

main().catch(fail);

