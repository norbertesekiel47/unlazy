#!/usr/bin/env node
// gate-check.mjs : run the CHECK commands in gate files, flip boxes, record evidence.
// Zero dependencies. Node 16+. Part of the unlazy skill (v2).
//
// Usage:
//   node gate-check.mjs [file ...]          run unmet gates' checks, update files
//   node gate-check.mjs --status [file ...] report only, change nothing
//   node gate-check.mjs --jobs 8 ...        run up to N checks concurrently (default 1)
//   node gate-check.mjs --timeout 60 ...    per-check timeout in seconds (default 120)
//
// Files default to GATES.md plus gates/*.md in the current directory. Naming the
// files you care about is the fast path: a leaf verify should re-run that leaf,
// not the whole tree.
//
// Identical CHECK commands run once per invocation and share their output, so a
// branch gate that re-runs its children's checks pays for each distinct command
// once. EXPECT is still evaluated per gate.
//
// Exit codes: 0 = all gates met (or honestly abandoned), 1 = unmet gates remain,
//             2 = usage or parse error.

import { readFileSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

const MAX_OUTPUT = 8 * 1024 * 1024;

function usage(message) {
  console.error(`gate-check: ${message}`);
  console.error("usage: gate-check.mjs [--status] [--jobs N] [--timeout SECONDS] [file ...]");
  process.exit(2);
}

// --- argument parsing -------------------------------------------------------
// Flags consume their value explicitly; everything left over is a file. The
// previous positional filter dropped the first argument whenever --timeout was
// absent, which silently globbed the whole tree (or skipped a named file).

const argv = process.argv.slice(2);
let statusOnly = false;
let timeoutSec = 120;
let jobs = 1;
const files = [];

for (let i = 0; i < argv.length; i++) {
  const arg = argv[i];
  if (arg === "--status") { statusOnly = true; continue; }
  if (arg === "--timeout" || arg === "--jobs") {
    const raw = argv[++i];
    if (raw === undefined) usage(`${arg} needs a value`);
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 1) usage(`${arg} needs a positive number, got "${raw}"`);
    if (arg === "--timeout") timeoutSec = value; else jobs = Math.floor(value);
    continue;
  }
  if (arg.startsWith("--")) usage(`unknown option "${arg}"`);
  files.push(arg);
}

function defaultFiles(dir) {
  const found = [];
  const top = join(dir, "GATES.md");
  if (existsSync(top)) found.push(top);
  const gdir = join(dir, "gates");
  if (existsSync(gdir)) {
    for (const f of readdirSync(gdir)) {
      if (f.endsWith(".md")) found.push(join(gdir, f));
    }
  }
  return found;
}

const targets = files.length ? files : defaultFiles(process.cwd());
if (!targets.length) {
  console.error("gate-check: no gate files found (GATES.md or gates/*.md)");
  process.exit(2);
}

// --- gate file parsing (format spec: references/gates.md) -------------------

const GATE_RE = /^- \[( |x|X)\] (.*)$/;
const ATTR_RE = /^\s+(CHECK|EXPECT|EVIDENCE):\s?(.*)$/;
const ABANDON_RE = /^ABANDON:\s*(\S+)\s*(.*)$/;

function parse(lines) {
  const gates = [];
  const abandoned = new Map(); // id -> reason
  let cur = null;
  lines.forEach((line, i) => {
    const g = line.match(GATE_RE);
    if (g) {
      const id = (g[2].match(/^(\S+?):/) || [null, `line${i + 1}`])[1];
      cur = {
        line: i, checked: g[1].toLowerCase() === "x",
        title: g[2].trim().replace(/^\S+?:\s*/, ""),
        id,
        check: null, expect: null, evidence: null, evidenceLine: -1,
      };
      gates.push(cur);
      return;
    }
    const a = cur && line.match(ATTR_RE);
    if (a) {
      const key = a[1].toLowerCase();
      cur[key] = a[2].trim();
      if (key === "evidence") cur.evidenceLine = i;
      return;
    }
    const ab = line.match(ABANDON_RE);
    if (ab) abandoned.set(ab[1].replace(/:$/, ""), ab[2] || "(no reason)");
    if (/^#|^- /.test(line) && !g) cur = null;
  });
  return { gates, abandoned };
}

function expectMatches(expect, output) {
  const rx = expect.match(/^\/(.+)\/([a-z]*)$/);
  if (rx) {
    try { return new RegExp(rx[1], rx[2]).test(output); } catch { return false; }
  }
  return output.includes(expect);
}

function tail(output, max = 200) {
  const lines = output.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
  const last = lines.slice(-2).join(" | ");
  return (last || "(no output)").slice(0, max);
}

// --- check execution --------------------------------------------------------

function runCommand(command) {
  return new Promise(resolve => {
    let child;
    try {
      child = spawn(command, {
        shell: true, timeout: timeoutSec * 1000, killSignal: "SIGKILL",
      });
    } catch (e) {
      resolve({ output: "", status: null, error: e.message });
      return;
    }
    let out = "";
    let truncated = false;
    const collect = chunk => {
      if (truncated) return;
      out += chunk;
      if (out.length > MAX_OUTPUT) { out = out.slice(0, MAX_OUTPUT); truncated = true; child.kill("SIGKILL"); }
    };
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", collect);
    child.stderr?.on("data", collect);
    child.on("error", e => resolve({ output: out, status: null, error: e.message }));
    child.on("close", (status, signal) => {
      const error = signal && !truncated ? `killed by ${signal} (timeout ${timeoutSec}s?)` : null;
      resolve({ output: out, status, error });
    });
  });
}

// One promise per distinct command: a shared CHECK runs once, every gate that
// names it reads the same output and applies its own EXPECT.
const commandRuns = new Map();
function runShared(command) {
  let run = commandRuns.get(command);
  if (!run) { run = runCommand(command); commandRuns.set(command, run); }
  return run;
}

async function pool(tasks, size) {
  const results = new Array(tasks.length);
  let next = 0;
  const worker = async () => {
    while (true) {
      const i = next++;
      if (i >= tasks.length) return;
      results[i] = await tasks[i]();
    }
  };
  await Promise.all(Array.from({ length: Math.min(size, tasks.length) }, worker));
  return results;
}

// --- main -------------------------------------------------------------------

const documents = [];
for (const file of targets) {
  let text;
  try { text = readFileSync(file, "utf8"); } catch (e) {
    console.error(`gate-check: cannot read ${file}: ${e.message}`);
    process.exit(2);
  }
  const lines = text.split(/\r?\n/);
  documents.push({ file, lines, ...parse(lines) });
}

// Collect the gates that need a run, then execute every distinct command.
const pending = [];
for (const doc of documents) {
  for (const gate of doc.gates) {
    if (doc.abandoned.has(gate.id)) continue;
    const pendingEvidence = !gate.evidence || /^pending$/i.test(gate.evidence);
    if (!statusOnly && gate.check && (!gate.checked || pendingEvidence)) pending.push(gate);
  }
}

const distinct = [...new Set(pending.map(g => g.check))];
console.log(`Jobs: ${jobs}`);
if (distinct.length < pending.length) {
  console.log(`Checks: ${distinct.length} distinct, ${pending.length - distinct.length} shared`);
}

await pool(distinct.map(command => () => runShared(command)), jobs);

// Apply results in file order so output stays deterministic under any job count.
let totalUnmet = 0;
let totalMet = 0;
let totalAbandoned = 0;

for (const doc of documents) {
  const { file, lines, gates, abandoned } = doc;
  if (!gates.length) { console.log(`${file}: no gates found`); continue; }
  let changed = false;

  for (const gate of gates) {
    if (abandoned.has(gate.id)) { totalAbandoned++; continue; }
    const pendingEvidence = !gate.evidence || /^pending$/i.test(gate.evidence);
    const needsRun = !statusOnly && gate.check && (!gate.checked || pendingEvidence);

    if (needsRun) {
      const res = await runShared(gate.check);
      const output = res.output;
      // With an EXPECT, the match decides (a check may exit non-zero by design);
      // without one, the exit code decides.
      const ok = gate.expect ? expectMatches(gate.expect, output) : res.status === 0;
      if (ok) {
        lines[gate.line] = lines[gate.line].replace(/^- \[ \]/, "- [x]");
        if (gate.evidenceLine !== -1) {
          const indent = lines[gate.evidenceLine].match(/^\s*/)[0];
          lines[gate.evidenceLine] = `${indent}EVIDENCE: ${tail(output)}`;
        }
        gate.checked = true;
        gate.evidence = tail(output);
        changed = true;
        console.log(`  PASS ${gate.id}: ${gate.title}`);
      } else {
        console.log(`  FAIL ${gate.id}: ${gate.title}\n       ${res.error || tail(output)}`);
      }
    }

    const evidenceNow = gate.evidence && !/^pending$/i.test(gate.evidence);
    if (gate.checked && evidenceNow) totalMet++;
    else {
      totalUnmet++;
      if (statusOnly) {
        const why = !gate.checked ? "unchecked" : "checked but EVIDENCE pending";
        console.log(`  UNMET ${gate.id} (${why}): ${gate.title}`);
      }
    }
  }

  if (changed) writeFileSync(file, lines.join("\n"));
  console.log(`${file}: ${gates.length} gates`);
}

if (totalUnmet === 0) {
  console.log(`ALL MET (${totalMet} met${totalAbandoned ? `, ${totalAbandoned} abandoned` : ""})`);
  process.exit(0);
} else {
  console.log(`UNMET: ${totalUnmet} (met: ${totalMet}${totalAbandoned ? `, abandoned: ${totalAbandoned}` : ""})`);
  process.exit(1);
}
