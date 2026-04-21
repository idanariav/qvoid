import * as fs from "fs";
import * as path from "path";
import {
  listCollections,
  loadCollection,
  registerCollection,
  removeCollection,
  resolveCollection,
  updateCollectionConfig,
} from "../config.js";
import { Classifier } from "../classifier.js";
import { buildIndex, readJsonl, writeJsonl } from "../indexer.js";
import { buildVectors, clusterDuplicates, findSimilar } from "../embeddings.js";
import { filterLinks, formatDetailed, formatSummary } from "../query.js";
import { startMcp } from "../mcp/server.js";
import { MlClassifier, MODEL_PATH, TRAINING_DATA_PATH, TRAINING_DIR, loadTrainingData, saveTrainingData } from "../ml-classifier.js";

// ---------------------------------------------------------------------------
// Terminal / progress helpers (same pattern as qimg)
// ---------------------------------------------------------------------------

const isTTY = process.stderr.isTTY;
const useColor = isTTY && !process.env["NO_COLOR"];
const c = {
  reset:  useColor ? "\x1b[0m"  : "",
  dim:    useColor ? "\x1b[2m"  : "",
  bold:   useColor ? "\x1b[1m"  : "",
  cyan:   useColor ? "\x1b[36m" : "",
};

const cursor = {
  hide() { if (isTTY) process.stderr.write("\x1b[?25l"); },
  show() { if (isTTY) process.stderr.write("\x1b[?25h"); },
};
process.on("SIGINT",  () => { cursor.show(); process.exit(130); });
process.on("SIGTERM", () => { cursor.show(); process.exit(143); });

// OSC 9;4 taskbar progress (WezTerm, Windows Terminal)
const osc = {
  set(pct: number)   { if (isTTY) process.stderr.write(`\x1b]9;4;1;${Math.round(pct)}\x07`); },
  clear()            { if (isTTY) process.stderr.write(`\x1b]9;4;0\x07`); },
  indeterminate()    { if (isTTY) process.stderr.write(`\x1b]9;4;3\x07`); },
};

function renderBar(pct: number, width = 30): string {
  const filled = Math.round((pct / 100) * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

function formatETA(sec: number): string {
  if (!isFinite(sec) || sec < 0) return "...";
  if (sec < 60) return `${Math.round(sec)}s`;
  if (sec < 3600) return `${Math.floor(sec / 60)}m ${Math.round(sec % 60)}s`;
  return `${Math.floor(sec / 3600)}h ${Math.floor((sec % 3600) / 60)}m`;
}

function makeProgressCallback(label: string): (done: number, total: number) => void {
  const t0 = Date.now();
  cursor.hide();
  osc.indeterminate();
  return (done, total) => {
    const pct = total > 0 ? (done / total) * 100 : 0;
    osc.set(pct);
    if (!isTTY) return;
    const elapsed = (Date.now() - t0) / 1000;
    const rate = done / (elapsed || 0.001);
    const eta = done < total ? formatETA((total - done) / rate) : "done";
    const bar = renderBar(pct);
    const pctStr = pct.toFixed(0).padStart(3);
    process.stderr.write(
      `\r${c.dim}${label}${c.reset} ${c.cyan}${bar}${c.reset} ${c.bold}${pctStr}%${c.reset} ${c.dim}${done}/${total} ${rate.toFixed(0)}/s ETA ${eta}${c.reset}   `,
    );
  };
}

function finishProgress(): void {
  osc.clear();
  cursor.show();
  if (isTTY) process.stderr.write("\n");
}

// ---------------------------------------------------------------------------
// Arg parsing (same hand-rolled style as qnode)
// ---------------------------------------------------------------------------

interface ParsedArgs {
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a.startsWith("--")) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function flagStr(v: string | boolean | undefined): string | undefined {
  return typeof v === "string" ? v : undefined;
}

function flagNum(v: string | boolean | undefined, fallback?: number): number | undefined {
  if (typeof v !== "string") return fallback;
  const n = Number(v);
  return isNaN(n) ? fallback : n;
}


// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function cmdCollections(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const removeName = flagStr(flags["remove"]);
  if (removeName) {
    if (removeCollection(removeName)) {
      console.log(`Removed collection ${JSON.stringify(removeName)}`);
    } else {
      console.error(`No collection named ${JSON.stringify(removeName)}`);
      process.exit(1);
    }
    return;
  }
  const cols = listCollections();
  if (Object.keys(cols).length === 0) {
    console.log("No collections registered. Run `qvoid collection <name> --path <vault>`.");
    return;
  }
  const width = Math.max(...Object.keys(cols).map((n) => n.length));
  for (const [name, entry] of Object.entries(cols)) {
    console.log(`  ${name.padEnd(width)}  ${entry.path}`);
  }
}

function cmdCollection(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const name = argv[0];
  if (!name) {
    console.error("Usage: qvoid collection <name> --path <vault-path>");
    process.exit(1);
  }
  const vaultPath = flagStr(flags["path"]);
  if (vaultPath !== undefined) {
    const resolved = path.resolve(vaultPath);
    registerCollection(name, resolved);
    console.log(`Registered collection ${JSON.stringify(name)} → ${resolved}`);
    console.log(`Edit ~/.config/qvoid/collections/${name}.toml to tune settings.`);
    return;
  }
  const col = loadCollection(name);
  const src = col.config.source;
  const clf = col.config.classifier;
  console.log(`Collection:         ${col.name}`);
  console.log(`Vault path:         ${col.path}`);
  console.log(`citation_folders:   ${clf.citation_folders.length > 0 ? JSON.stringify(clf.citation_folders) : "(none)"}`);
  console.log(`person_prefix:      ${JSON.stringify(clf.person_prefix)}`);
  console.log(`annotation_pattern: ${JSON.stringify(src.annotation_pattern)}`);
}

async function cmdIndex(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const col = resolveCollection(flagStr(flags["collection"]));
  const force = flags["force"] === true;
  const classifier = new Classifier(col.config);
  process.stderr.write(`Indexing collection ${JSON.stringify(col.name)} at ${col.path}\n`);
  const onProgress = makeProgressCallback("scanning");
  const links = await buildIndex(col.path, col.config, classifier, {
    existingJsonl: force ? undefined : col.jsonlPath,
    scanManifestPath: force ? undefined : col.scanManifestPath,
    onProgress,
  });
  finishProgress();
  writeJsonl(links, col.jsonlPath);
  process.stderr.write(`Wrote ${links.length} records → ${col.jsonlPath}\n`);
}

async function cmdEmbed(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const col = resolveCollection(flagStr(flags["collection"]));
  const force = flags["force"] === true;
  if (!fs.existsSync(col.jsonlPath)) {
    process.stderr.write(`No index found for ${JSON.stringify(col.name)}. Run \`qvoid index\` first.\n`);
    process.exit(1);
  }
  if (force) {
    for (const p of [col.vectorsPath, col.manifestPath]) {
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
  }
  const links = readJsonl(col.jsonlPath);
  const modelName = col.config.embeddings.model;
  const mode = force ? "full" : "incremental";
  process.stderr.write(`Embedding ${links.length} records with ${modelName} (${mode})...\n`);
  const onProgress = makeProgressCallback("encoding");
  await buildVectors(links, col.vectorsPath, col.manifestPath, modelName, onProgress);
  finishProgress();
  process.stderr.write(`Wrote vectors → ${col.vectorsPath}\n`);
}

function cmdQuery(argv: string[]): void {
  const { flags } = parseArgs(argv);
  const col = resolveCollection(flagStr(flags["collection"]));
  if (!fs.existsSync(col.jsonlPath)) {
    process.stderr.write(`No index found for ${JSON.stringify(col.name)}. Run \`qvoid index\` first.\n`);
    process.exit(1);
  }
  const links = readJsonl(col.jsonlPath);
  const filtered = filterLinks(links, {
    origin: flagStr(flags["origin"]),
    destination: flagStr(flags["destination"]),
    semanticType: flagStr(flags["semantic-type"]),
    minOccurrences: flagNum(flags["min-occurrences"]),
    search: flagStr(flags["search"]),
    limit: flagNum(flags["limit"]),
  });

  const fmt = flagStr(flags["format"]) ?? "summary";

  if (fmt === "json") {
    for (const link of filtered) console.log(JSON.stringify(link));
    return;
  }
  if (fmt === "detailed") {
    console.log(formatDetailed(filtered));
  } else {
    console.log(formatSummary(filtered));
  }
  process.stderr.write(`\n${filtered.length} of ${links.length} targets match.\n`);
}

async function cmdFindSimilar(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const col = resolveCollection(flagStr(flags["collection"]));
  const cluster = flags["cluster"] === true;
  const threshold = flagNum(flags["threshold"]) ?? 0.82;
  const topK = flagNum(flags["top-k"]) ?? 10;
  const minScore = flagNum(flags["min-score"]) ?? 0.5;

  if (!fs.existsSync(col.vectorsPath) || !fs.existsSync(col.manifestPath)) {
    process.stderr.write(`No vector index for ${JSON.stringify(col.name)}. Run \`qvoid embed\` first.\n`);
    process.exit(1);
  }

  if (cluster) {
    const groups = clusterDuplicates(col.vectorsPath, col.manifestPath, threshold);
    groups.sort((a, b) => b.length - a.length);
    for (const g of groups) {
      console.log(`\n--- cluster (${g.length} targets)`);
      for (const t of g) console.log(`  ${t}`);
    }
    process.stderr.write(`\n${groups.length} clusters at threshold ${threshold}.\n`);
    return;
  }

  const query = positional[0];
  if (!query) {
    process.stderr.write("Provide a query string or pass --cluster.\n");
    process.exit(1);
  }
  const results = await findSimilar(query, col.vectorsPath, col.manifestPath, { topK, minScore });
  if (results.length === 0) {
    process.stderr.write("No matches above threshold.\n");
    return;
  }
  console.log(`Top ${results.length} similar targets to: ${JSON.stringify(query)}`);
  for (const { target, score } of results) {
    console.log(`  ${score.toFixed(3)}  ${target}`);
  }
}

// ---------------------------------------------------------------------------
// ML classification commands
// ---------------------------------------------------------------------------

async function cmdClassify(argv: string[]): Promise<void> {
  const { flags } = parseArgs(argv);
  const col = resolveCollection(flagStr(flags["collection"]));
  const dryRun = flags["dry-run"] === true;
  if (!fs.existsSync(col.jsonlPath)) {
    process.stderr.write(`No index found for ${JSON.stringify(col.name)}. Run \`qvoid index\` first.\n`);
    process.exit(1);
  }
  const mlc = new MlClassifier();
  if (!mlc.load()) {
    process.stderr.write(`No trained model found at ${MODEL_PATH}. Run \`qvoid classifier train <path> <label>\` first.\n`);
    process.exit(1);
  }
  const links = readJsonl(col.jsonlPath);
  const lowConf = links.filter((l) => l.classification_confidence === "low");
  if (lowConf.length === 0) {
    process.stderr.write(`No low-confidence entries to reclassify.\n`);
    return;
  }

  if (dryRun) {
    const targetW = Math.min(50, Math.max(6, ...lowConf.map((l) => l.target.length)));
    const categoryW = 8;
    const header = `${"target".padEnd(targetW)}  ${"current".padEnd(categoryW)}  predicted`;
    const sep = "-".repeat(header.length);
    console.log(header);
    console.log(sep);
    let changed = 0;
    for (const link of lowConf) {
      const prediction = mlc.predict(link.target) ?? "—";
      const marker = prediction !== link.expected_destination && prediction !== "unknown" ? " *" : "";
      if (marker) changed++;
      console.log(`${link.target.padEnd(targetW)}  ${link.expected_destination.padEnd(categoryW)}  ${prediction}${marker}`);
    }
    process.stderr.write(`\n${lowConf.length} low-confidence entries — ${changed} would change (* = change). Dry run, nothing written.\n`);
    return;
  }

  let updated = 0;
  for (const link of links) {
    if (link.classification_confidence !== "low") continue;
    const prediction = mlc.predict(link.target);
    if (prediction !== null && prediction !== "unknown") {
      link.expected_destination = prediction;
      link.classification_confidence = "medium";
      updated++;
    }
  }
  writeJsonl(links, col.jsonlPath);
  process.stderr.write(`Reclassified ${updated}/${lowConf.length} low-confidence entries → ${col.jsonlPath}\n`);
}

async function cmdClassifierTrain(argv: string[]): Promise<void> {
  const { positional, flags } = parseArgs(argv);
  const subCmd = positional[0];

  if (subCmd === "retrain") {
    const outputPath = flagStr(flags["output"]) ?? MODEL_PATH;
    if (!fs.existsSync(TRAINING_DIR)) {
      process.stderr.write(`No training directory found at ${TRAINING_DIR}\n`);
      process.exit(1);
    }
    const txtFiles = fs.readdirSync(TRAINING_DIR).filter((f) => f.endsWith(".txt"));
    if (txtFiles.length === 0) {
      process.stderr.write(`No .txt files found in ${TRAINING_DIR}\n`);
      process.exit(1);
    }
    const mlc = new MlClassifier();
    const allExamples: Array<{ text: string; label: string }> = [];
    for (const file of txtFiles) {
      const label = path.basename(file, ".txt");
      const lines = fs.readFileSync(path.join(TRAINING_DIR, file), "utf-8")
        .split("\n").map((l) => l.trim()).filter(Boolean);
      for (const line of lines) mlc.learn(line, label);
      allExamples.push(...lines.map((text) => ({ text, label })));
      process.stderr.write(`Loaded ${lines.length} examples for label "${label}"\n`);
    }
    const labels = new Set(allExamples.map((e) => e.label));
    if (labels.size < 2) {
      process.stderr.write(`Need at least 2 label files in ${TRAINING_DIR}\n`);
      process.exit(1);
    }
    saveTrainingData(allExamples);
    const json = mlc.finalize();
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    fs.writeFileSync(outputPath, json);
    process.stderr.write(`Model saved → ${outputPath} (labels: ${[...labels].join(", ")})\n`);
    return;
  }

  if (subCmd !== "train") {
    process.stderr.write(
      "Usage:\n" +
      "  qvoid classifier train <path> <label> [--append] [--output <path>]\n" +
      "  qvoid classifier retrain [--output <path>]\n"
    );
    process.exit(1);
  }
  const trainingPath = positional[1];
  const label = positional[2];
  if (!trainingPath || !label) {
    process.stderr.write("Usage: qvoid classifier train <path> <label> [--append] [--output <path>]\n");
    process.exit(1);
  }
  const append = flags["append"] === true;
  const outputPath = flagStr(flags["output"]) ?? MODEL_PATH;

  // Load accumulated training data from previous runs
  const existingExamples = append ? loadTrainingData() : [];
  if (append && existingExamples.length > 0) {
    process.stderr.write(`Loaded ${existingExamples.length} existing training examples from ${TRAINING_DATA_PATH}\n`);
  }

  const files = fs.readdirSync(trainingPath)
    .filter((f) => f.endsWith(".md"))
    .map((f) => path.basename(f, ".md"));
  if (files.length === 0) {
    process.stderr.write(`No .md files found in ${trainingPath}\n`);
    process.exit(1);
  }

  const newExamples = files.map((stem) => ({ text: stem, label }));
  const allExamples = [...existingExamples, ...newExamples];

  // Always persist accumulated training data so --append works on the next run
  saveTrainingData(allExamples);
  process.stderr.write(`Learned ${newExamples.length} examples for label "${label}" (${allExamples.length} total)\n`);

  const labels = new Set(allExamples.map((e) => e.label));
  if (labels.size < 2) {
    process.stderr.write(
      `Training data saved to ${TRAINING_DATA_PATH}\n` +
      `Need at least 2 labels to finalize the model — currently have: ${[...labels].join(", ")}\n` +
      `Run again with --append to add more labels.\n`
    );
    return;
  }

  // Rebuild classifier from all accumulated examples and consolidate
  const mlc = new MlClassifier();
  for (const { text, label: lbl } of allExamples) {
    mlc.learn(text, lbl);
  }
  const json = mlc.finalize();
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, json);
  process.stderr.write(`Model saved → ${outputPath} (labels: ${[...labels].join(", ")})\n`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const [, , cmd, ...rest] = process.argv;
  try {
    switch (cmd) {
      case "collections": cmdCollections(rest); break;
      case "collection":  cmdCollection(rest); break;
      case "index":       await cmdIndex(rest); break;
      case "embed":       await cmdEmbed(rest); break;
      case "query":       cmdQuery(rest); break;
      case "find-similar": await cmdFindSimilar(rest); break;
      case "classify":    await cmdClassify(rest); break;
      case "classifier":  await cmdClassifierTrain(rest); break;
      case "mcp":         await startMcp(); break;
      default:
        console.error(
          "Usage: qvoid <command> [...args]\n" +
          "Commands: collections, collection, index, embed, query, find-similar, classify, classifier [train|retrain], mcp"
        );
        process.exit(1);
    }
  } catch (e) {
    process.stderr.write(`error: ${e instanceof Error ? e.message : String(e)}\n`);
    process.exit(1);
  }
}

main();
