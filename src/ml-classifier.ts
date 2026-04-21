import * as fs from "fs";
import * as path from "path";
import { createRequire } from "module";
import { fileURLToPath } from "url";
import { dirname } from "path";

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
// Both src/ml-classifier.ts (tsx) and dist/ml-classifier.js sit one level below project root
export const MODEL_PATH = path.join(__dirname, "..", "models", "classifier.json");
export const TRAINING_DATA_PATH = path.join(__dirname, "..", "models", "training_data.json");
export const TRAINING_DIR = path.join(__dirname, "..", "training");

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
    if (!fs.existsSync(MODEL_PATH)) return false;
    const json = fs.readFileSync(MODEL_PATH, "utf-8");
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

export function loadTrainingData(): TrainingExample[] {
  if (!fs.existsSync(TRAINING_DATA_PATH)) return [];
  return JSON.parse(fs.readFileSync(TRAINING_DATA_PATH, "utf-8")) as TrainingExample[];
}

export function saveTrainingData(examples: TrainingExample[]): void {
  fs.mkdirSync(path.dirname(TRAINING_DATA_PATH), { recursive: true });
  fs.writeFileSync(TRAINING_DATA_PATH, JSON.stringify(examples, null, 2));
}
