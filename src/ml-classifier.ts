import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";
import { type LinkRecord, isDestination } from "./types.js";
import { mlModelPath, mlTrainingDataPath } from "./paths.js";

const require = createRequire(import.meta.url);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const naiveBayesTextClassifier: () => NaiveBayesInstance = require("wink-naive-bayes-text-classifier");

interface NaiveBayesInstance {
  definePrepTasks(tasks: Array<(input: string) => string[]>): number;
  learn(input: string, label: string): boolean;
  consolidate(): boolean;
  predict(input: string): string;
  exportJSON(): string;
  importJSON(json: string): boolean;
}

const __dirname = dirname(fileURLToPath(import.meta.url));
// Both src/ml-classifier.ts (tsx) and dist/ml-classifier.js sit one level below project root.
// `training/` is a bundled read-only seed corpus shipped with the package (used by
// `classifier retrain`); the model and its accumulated training data are user-writable
// state and live in the XDG data dir instead, with the bundled model as a read-only
// fallback so `classifier train`/global npm upgrades never touch (or lose write access to)
// files inside the package install directory.
export const BUNDLED_MODEL_PATH = path.join(__dirname, "..", "models", "classifier.json");
export const TRAINING_DIR = path.join(__dirname, "..", "training");
export const MODEL_PATH = mlModelPath();
export const TRAINING_DATA_PATH = mlTrainingDataPath();

interface TrainingExample {
  text: string;
  label: string;
}

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .split(/\s+/)
    .filter((s) => s.length > 1);
}

export class MlClassifier {
  private nbc: NaiveBayesInstance;
  private loaded = false;

  constructor() {
    this.nbc = naiveBayesTextClassifier();
    this.nbc.definePrepTasks([tokenize]);
  }

  load(): boolean {
    // A user-trained model in the XDG data dir takes priority over the bundled default.
    const modelPath = fs.existsSync(MODEL_PATH) ? MODEL_PATH : BUNDLED_MODEL_PATH;
    if (!fs.existsSync(modelPath)) return false;
    const json = fs.readFileSync(modelPath, "utf-8");
    this.nbc.importJSON(json);
    this.nbc.consolidate();
    this.loaded = true;
    return true;
  }

  predict(target: string): string | null {
    if (!this.loaded) return null;
    return this.nbc.predict(target);
  }

  learn(text: string, label: string): void {
    this.nbc.learn(text, label);
  }

  finalize(): string {
    this.nbc.consolidate();
    return this.nbc.exportJSON();
  }
}

/**
 * Reclassifies every low-confidence link in place using a trained MlClassifier.
 * Returns the number of records updated.
 */
export function reclassifyLowConfidence(links: LinkRecord[], mlc: MlClassifier): number {
  let updated = 0;
  for (const link of links) {
    if (link.classification_confidence !== "low") continue;
    const prediction = mlc.predict(link.target);
    if (prediction !== null && prediction !== "unknown" && isDestination(prediction)) {
      link.expected_destination = prediction;
      link.classification_confidence = "medium";
      updated++;
    }
  }
  return updated;
}

export function loadTrainingData(): TrainingExample[] {
  if (!fs.existsSync(TRAINING_DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(TRAINING_DATA_PATH, "utf-8")) as TrainingExample[];
}

export function saveTrainingData(examples: TrainingExample[]): void {
  fs.mkdirSync(path.dirname(TRAINING_DATA_PATH), { recursive: true });
  fs.writeFileSync(TRAINING_DATA_PATH, JSON.stringify(examples, null, 2));
}
