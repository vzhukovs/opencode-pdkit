/**********************************************************************
 * Copyright (C) 2026 Red Hat, Inc.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 *
 * SPDX-License-Identifier: Apache-2.0
 ***********************************************************************/

// Does the receipt gate still hold an implementer that stops without a receipt?
//
// The gate stands on Open Code's experimental.idle hook: when a subagent's
// session is about to go idle, the hook bridge runs the subagent-stop handler,
// and a refusal is added to the session as its next instruction. Nothing else
// in CI reaches that. The suite drives the bridge with a fake ctx, and
// check-plugin-load.js calls no model, while Open Code calls the hook only
// after a model step. Open Code also accepts a hook under any name, so an
// experimental.idle renamed in a new version registers without a complaint,
// the doctor's `hooks` line stays ok, and the gate is off in silence. This
// check is the direct signal of that, on the minimum Open Code and on latest.
//
// One run, on a real model:
//
//   1. the plugin loads as check-plugin-load.js loads it (scripts/plugin-server.js),
//      with pd-implementer on the model given (the plugin's `options.models`),
//      and a throwaway PDKIT_HOME holding issue 101's task T1, whose `Done
//      when` is `echo T1-DONE`;
//   2. model:    the model is one Open Code can run here (a missing key shows
//                here, before anything is spent);
//      home:     `pdkit doctor --json` in the server's environment names that
//                PDKIT_HOME, before any hook could write;
//   3. session:  a session on the model, T1 recorded as running in it (what
//                `pdkit task start` writes), asked to start pd-implementer with
//                a task that ends without a receipt; then
//                POST /api/experimental/session/{id}/wait until the subagent's
//                report is in and the session is idle;
//   4. what the records say, not what the model says:
//      subagent: one child session, pd-implementer's;
//      hold:     exactly one message of the plugin's in it (synthetic,
//                metadata.source "opencode-pdkit"), the refusal for a missing
//                receipt, and the child idle at the end, succeeded;
//      journal:  the child's two stops counted (agent-done) and T1 accepted
//                once (task-receipt): the hold had it run `pdkit receipt
//                write`, and the stop after that was let go, as
//                lib/hooks/task-completed.js decides;
//      doctor:   `pdkit doctor --json`: hooks:agent-done ok, the doctor's own
//                reading of the same thing against Open Code's session
//                database;
//      usage:    tokens and cost of the two sessions, for the record.
//
// The model is told what to do in words and can do otherwise: start no
// subagent, or not run the command the hold names. Each of those fails a step
// of its own and shows what the model did, so a model's slip does not read as
// the gate's.
//
// Usage: node scripts/check-receipt-gate.js --model <provider/model[#variant]>
//          [--root <package dir>] [--config <opencode.json>] [--keep] [--log]
//
// The provider's key comes from the environment the script runs in, under the
// name Open Code reads for that provider (DEEPSEEK_API_KEY, OPENAI_API_KEY…):
// the server gets the caller's environment minus every OPENCODE_* variable,
// and a fresh HOME. --config gives the server a global opencode.json, for a
// provider Open Code does not know by itself. --keep and --log are
// check-plugin-load.js's. Runs on Linux and macOS, with `opencode`, `npm` and
// `git` on PATH.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

import { start as startTask } from '../lib/active.js';
import { issueDir } from '../lib/config.js';
import { read as readJournal } from '../lib/journal.js';
import { IMPLEMENTER } from '../lib/hooks/task-completed.js';
import { modelRef, modelText, unavailable } from '../lib/opencode-models.js';
import { setOwns, transition } from '../lib/state.js';
import { location, reporter, run, withPluginServer } from './plugin-server.js';

const ROOT = fileURLToPath(new URL('../', import.meta.url));

/** How long the run on the model may take, from the prompt to the parent's last idle. */
const RUN_SECONDS = 300;

/** The task the implementer is held for. */
export const TASK = Object.freeze({ issue: 101, id: 'T1', done: 'echo T1-DONE', owns: 'src/a.ts' });

/** The command the hold names, as lib/hooks/task-completed.js writes it. */
export const CAPTURE = `pdkit receipt write --issue ${TASK.issue} --task ${TASK.id}`;

/**
 * What the implementer is asked to do: stop at once, with no receipt, and
 * capture when it is told to.
 */
export const IMPLEMENTER_TASK =
  'receipt-gate check: this checks a hook, there is nothing to implement. Do not read, write or search any file. ' +
  'Reply with exactly `IMPLEMENTER: done`. If a message then tells you that you cannot finish yet, run the command ' +
  'it names with the shell tool, exactly as written, then reply with exactly `IMPLEMENTER: captured`.';

/** What the session the check opens is asked to do. */
export const PARENT_PROMPT =
  `receipt-gate check. Use the subagent tool once, to start the ${IMPLEMENTER} agent with the description ` +
  `\`Implement ${TASK.id}\` and exactly this task: "${IMPLEMENTER_TASK}" Use no other tool and start no other ` +
  'agent. When its report arrives, reply with exactly one line: `PARENT GOT: <the report>`.';

/**
 * The items of a listing the API answers either as an array or as `{ items }`.
 *
 * @param {unknown} data
 * @returns {any[]}
 */
export const items = (data) => (Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : []);

/**
 * The sessions of a GET /api/session listing started from a session.
 *
 * @param {unknown} listing
 * @param {string} parentID
 */
export const childrenOf = (listing, parentID) => items(listing).filter((session) => session?.parentID === parentID);

/**
 * The tool calls of a session's messages, by name, with what they were given.
 *
 * @param {unknown} messages GET /api/session/{id}/message
 * @returns {{name: string, input: unknown, status: unknown}[]}
 */
export function toolCalls(messages) {
  return items(messages)
    .filter((message) => message?.type === 'assistant' && Array.isArray(message.content))
    .flatMap((message) => message.content.filter((part) => part?.type === 'tool'))
    .map((part) => ({ name: part.name, input: part.state?.input, status: part.state?.status }));
}

/** The holds in a session: what the plugin added to it, as the hook bridge marks it. */
export const holdsIn = (messages) =>
  items(messages).filter((message) => message?.type === 'synthetic' && message.metadata?.source === 'opencode-pdkit');

/**
 * Whether the parent is done: idle, last, and either with its subagent's
 * report or without having started one. The subagent runs in the background,
 * so the parent goes idle once before the report wakes it again.
 *
 * @param {unknown} messages the parent's
 */
export function settled(messages) {
  const list = items(messages);
  if (list.at(-1)?.type !== 'idle') return false;
  const reported = list.some((message) => message?.metadata?.source === 'subagent');
  return reported || !toolCalls(list).some((call) => call.name === 'subagent');
}

/**
 * Whether the parent started exactly one subagent, the implementer.
 *
 * @param {readonly any[]} children the parent's child sessions
 * @param {unknown} messages the parent's
 */
export function subagentVerdict(children, messages) {
  if (children.length === 1 && children[0].agent === IMPLEMENTER) {
    return { ok: true, detail: `${children[0].id}, ${IMPLEMENTER}` };
  }
  const calls = toolCalls(messages).map((call) => `${call.name}(${JSON.stringify(call.input ?? {}).slice(0, 160)})`);
  const text = items(messages)
    .filter((message) => message?.type === 'assistant')
    .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
    .filter((part) => part?.type === 'text')
    .map((part) => part.text)
    .join(' ')
    .replace(/\s+/g, ' ')
    .slice(0, 300);
  const started = children.length === 0 ? 'no subagent' : children.map((child) => `${child.agent ?? '(no agent)'} ${child.id}`).join(', ');
  return {
    ok: false,
    detail:
      `expected one ${IMPLEMENTER} subagent, the session started ${started}: the model did not do what it was asked, ` +
      `not the gate's doing. Its calls: ${calls.length > 0 ? calls.join('; ') : 'none'}; its text: ${JSON.stringify(text)}`,
  };
}

/**
 * Whether the implementer was held exactly once, for the missing receipt, and
 * then let go.
 *
 * No hold at all is the failure this check exists for: the implementer
 * stopped and nothing ran the subagent-stop handler, which is what a renamed
 * or changed experimental.idle looks like. More than one is the model not
 * running the command the hold named; the calls say so.
 *
 * @param {unknown} messages the child's
 */
export function holdVerdict(messages) {
  const list = items(messages);
  const holds = holdsIn(list);
  const last = list.at(-1);
  const end = last?.type === 'idle' ? `idle ${last.outcome}` : `last message ${last?.type ?? 'none'}`;
  if (holds.length === 0) {
    return {
      ok: false,
      detail:
        `the implementer was not held (${end}): no message of the plugin's in its session, so the subagent-stop ` +
        'handler did not run when it stopped. If Open Code renamed or changed experimental.idle, the receipt gate ' +
        'is off on this version (see the journal and doctor lines too).',
    };
  }
  const refusal = `pdkit: ${TASK.id} of issue ${TASK.issue} cannot be completed — there is no receipt.`;
  const problems = [];
  if (holds.length > 1) {
    const calls = toolCalls(list).map((call) => `${call.name}(${JSON.stringify(call.input ?? {}).slice(0, 120)})`);
    problems.push(
      `held ${holds.length} times, not once: after the first hold the model did not run \`${CAPTURE}\` ` +
        `(its calls: ${calls.length > 0 ? calls.join('; ') : 'none'})`,
    );
  }
  if (!String(holds[0].text ?? '').startsWith(refusal)) problems.push(`the hold is not the no-receipt refusal: ${JSON.stringify(String(holds[0].text).slice(0, 200))}`);
  if (last?.type !== 'idle' || last.outcome !== 'succeeded') problems.push(`the implementer did not end idle and succeeded (${end})`);
  if (problems.length > 0) return { ok: false, detail: problems.join('; ') };
  return { ok: true, detail: `once, ${JSON.stringify(holds[0].description ?? refusal)}; then ${end}` };
}

/**
 * Whether the journal counted both of the implementer's stops and accepted
 * the task once, as the handler does after a hold and a capture.
 *
 * @param {{stops: readonly {detail: string}[], receipts: readonly {detail: string}[]}} journal
 *   the agent-done and task-receipt entries
 * @param {string} child the implementer's session
 */
export function journalVerdict({ stops, receipts }, child) {
  const mine = stops.filter((entry) => entry.detail.startsWith(`agent task ${child};`));
  const accepted = receipts.filter((entry) => entry.detail === `${TASK.id} accepted; agent task ${child}`);
  const problems = [];
  if (mine.length !== 2) problems.push(`${mine.length} agent-done for ${child}, expected 2: the held stop and the one after the capture`);
  const off = mine.filter((entry) => !entry.detail.startsWith(`agent task ${child}; ${IMPLEMENTER}; while ${TASK.id} was active`));
  if (off.length > 0) problems.push(`not filed as ${IMPLEMENTER} while ${TASK.id} was active: ${off.map((entry) => JSON.stringify(entry.detail)).join(', ')}`);
  if (accepted.length !== 1) problems.push(`${TASK.id} accepted ${accepted.length} times, expected once`);
  if (problems.length > 0) return { ok: false, detail: `${problems.join('; ')} (${stops.length} agent-done in all)` };
  return { ok: true, detail: `2 stops of ${child} counted, ${TASK.id} accepted` };
}

/**
 * The doctor's word on where the hooks write and whether they ran.
 *
 * @param {unknown} json `pdkit doctor --json`
 * @param {string} home the PDKIT_HOME the server was given
 * @param {{agentDone?: boolean}} [want] also expect hooks:agent-done ok
 */
export function doctorVerdict(json, home, { agentDone = false } = {}) {
  if (!json || typeof json !== 'object' || !Array.isArray(json.checks)) return { ok: false, detail: 'no doctor report' };
  if (json.home !== home) return { ok: false, detail: `the doctor's home is ${json.home}, not the throwaway ${home}` };
  if (!agentDone) return { ok: true, detail: `home ${home}` };
  const line = json.checks.find((check) => check?.id === 'hooks:agent-done');
  if (line?.status !== 'ok') return { ok: false, detail: `hooks:agent-done ${line?.status ?? 'missing'}: ${line?.detail ?? ''}` };
  return { ok: true, detail: `hooks:agent-done ok: ${line.detail}` };
}

/**
 * Tokens and cost of the sessions, from their records.
 *
 * @param {readonly any[]} records GET /api/session/{id}
 */
export function usage(records) {
  const sum = (pick) => records.reduce((total, record) => total + (Number(pick(record)) || 0), 0);
  const input = sum((record) => record?.tokens?.input);
  const output = sum((record) => record?.tokens?.output) + sum((record) => record?.tokens?.reasoning);
  const cached = sum((record) => record?.tokens?.cache?.read);
  const cost = sum((record) => record?.cost);
  return `${records.length} session${records.length === 1 ? '' : 's'}: ${input} input tokens (${cached} more read from cache), ${output} output, $${cost.toFixed(4)}`;
}

/** Issue 101 triaged, with T1 planned: what `pdkit receipt write` needs to run its `Done when`. */
async function plan(home) {
  await transition(TASK.issue, 'triaged', { home });
  await setOwns(TASK.issue, TASK.id, [TASK.owns], { home });
  const tasks = join(issueDir(home, TASK.issue), 'tasks');
  await mkdir(tasks, { recursive: true });
  await writeFile(
    join(tasks, `${TASK.id}.md`),
    `# ${TASK.id}: a task for the receipt gate's check\n\n- Issue: ${TASK.issue}\n- Satisfies: R1\n\n` +
      `## Owns\n- ${TASK.owns}\n\n## Done when\n\`\`\`bash\n${TASK.done}\n\`\`\`\n`,
  );
}

async function check({ root, model, config, keep, printLog }) {
  const out = reporter();
  const { report } = out;
  const ref = modelRef(model);
  if (!ref) {
    report('model', false, 0, `--model ${JSON.stringify(model)} is not provider/model#variant`);
    return out.result();
  }
  const name = modelText(ref);

  await withPluginServer(
    {
      root,
      prefix: 'opencode-pdkit-gate-',
      out,
      keep,
      printLog,
      config,
      entry: (target) => ({ package: target, options: { models: { [IMPLEMENTER]: name } } }),
      prepare: async ({ project, pdkitHome }) => {
        // Pinned for this process too: nothing below may reach a live journal.
        process.env.PDKIT_HOME = pdkitHome;
        await writeFile(join(project, 'README.md'), 'A project for the receipt gate check.\n');
        const git = (...args) => run('git', ['-c', 'user.name=check', '-c', 'user.email=check@example.invalid', ...args], { cwd: project });
        git('add', '-A');
        git('commit', '-q', '-m', 'project');
        await plan(pdkitHome);
      },
    },
    async ({ project, pdkitHome, env, loaded, api }) => {
      if (!loaded) return;

      const catalog = api('GET', `/api/model?${location(project)}`);
      const missing = catalog.code === 0 ? unavailable(items(catalog.data), ref) : catalog.stderr;
      report(
        'model',
        !missing,
        catalog.seconds,
        missing ? `${name}: ${missing} — is the provider's key in the environment?` : `${name} available`,
      );
      if (missing) return;

      const doctor = () => {
        const call = run(process.execPath, [join(root, 'bin', 'pdkit'), 'doctor', '--json'], {
          cwd: project,
          env: { ...env, PWD: project },
          timeout: 180_000,
        });
        let json;
        try {
          json = JSON.parse(call.stdout);
        } catch {
          json = undefined;
        }
        return { json, seconds: call.seconds, stderr: `${call.stderr ?? ''}`.trim() };
      };
      // D10: where the hooks write is checked before the first hook does.
      const before = doctor();
      const home = doctorVerdict(before.json, pdkitHome);
      report('home', home.ok, before.seconds, home.ok ? home.detail : `${home.detail} ${before.stderr.slice(-300)}`.trim());
      if (!home.ok) return;

      const started = performance.now();
      const created = api('POST', '/api/session', { location: { directory: project }, model: ref });
      const id = created.data?.id;
      if (!id) {
        report('session', false, created.seconds, `no session: exit ${created.code} ${created.stderr || created.stdout.trim()}`);
        return;
      }
      await startTask({ issue: TASK.issue, taskId: TASK.id, worktree: project, session: id, home: pdkitHome });
      const sent = api('POST', `/api/session/${id}/prompt`, { text: PARENT_PROMPT });
      if (sent.code !== 0) {
        report('session', false, sent.seconds, `the prompt was not taken: exit ${sent.code} ${sent.stderr || sent.stdout.trim()}`);
        return;
      }

      // The wait returns when the session is idle, and the parent goes idle
      // once while its subagent still runs: then the child is waited on, and
      // the parent again.
      const deadline = performance.now() + RUN_SECONDS * 1000;
      const left = () => Math.max(1_000, Math.round(deadline - performance.now()));
      const messagesOf = (session) => items(api('GET', `/api/session/${session}/message?order=asc`).data);
      const childrenNow = () => childrenOf(api('GET', `/api/session?${location(project)}`).data, id);
      let parent = [];
      while (performance.now() < deadline) {
        api('POST', `/api/experimental/session/${id}/wait`, undefined, left());
        parent = messagesOf(id);
        if (settled(parent)) break;
        for (const child of childrenNow()) api('POST', `/api/experimental/session/${child.id}/wait`, undefined, left());
        await sleep(1_000);
      }
      const done = settled(parent);
      const outcome = parent.at(-1)?.type === 'idle' ? parent.at(-1).outcome : `still ${parent.at(-1)?.type ?? 'empty'}`;
      report(
        'session',
        done,
        (performance.now() - started) / 1000,
        done ? `${id} on ${name}, idle ${outcome}` : `${id} on ${name} not done in ${RUN_SECONDS}s (${outcome})`,
      );

      const children = childrenNow();
      const records = [id, ...children.map((child) => child.id)].map((session) => api('GET', `/api/session/${session}`).data).filter(Boolean);
      const subagent = subagentVerdict(children, parent);
      report('subagent', subagent.ok, 0, subagent.detail);
      if (subagent.ok) {
        const child = children[0].id;
        const messages = messagesOf(child);
        const held = holdVerdict(messages);
        report('hold', held.ok, 0, held.detail);

        const stops = await readJournal({ event: 'agent-done' }, { home: pdkitHome });
        const receipts = await readJournal({ event: 'task-receipt' }, { home: pdkitHome });
        const counted = journalVerdict({ stops, receipts }, child);
        report('journal', counted.ok, 0, counted.detail);
      }

      const after = doctor();
      const agentDone = doctorVerdict(after.json, pdkitHome, { agentDone: true });
      report('doctor', agentDone.ok, after.seconds, agentDone.ok ? agentDone.detail : `${agentDone.detail} ${after.stderr.slice(-300)}`.trim());

      report('usage', true, 0, usage(records));
    },
  );
  return out.result();
}

async function main(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      model: { type: 'string' },
      root: { type: 'string' },
      config: { type: 'string' },
      keep: { type: 'boolean' },
      log: { type: 'boolean' },
    },
  });
  if (!values.model) {
    console.error('usage: node scripts/check-receipt-gate.js --model <provider/model[#variant]> [--root <dir>] [--config <file>] [--keep] [--log]');
    return 2;
  }
  const config = values.config ? JSON.parse(await readFile(resolve(values.config), 'utf8')) : undefined;
  return check({ root: resolve(values.root ?? ROOT), model: values.model, config, keep: values.keep === true, printLog: values.log === true });
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  process.exitCode = await main(process.argv.slice(2));
}
