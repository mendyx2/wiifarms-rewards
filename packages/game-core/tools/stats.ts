// Statistical evidence that the engine's random choices are uniform: every
// outcome, position and entry equally likely. Uses chi-square goodness-of-fit
// tests with fixed seeds, so the report is reproducible exactly.
// Usage: node tools/stats.ts [scale]   (scale 1 = the full report; tests use a smaller scale)
import { fileURLToPath } from "node:url";
import path from "node:path";
import { SeededStream, generateOutcomes, runDraw, shuffle } from "../src/index.ts";
import { fixed } from "./vectors.ts";

/** Regularised upper incomplete gamma Q(a, x), for chi-square p-values (Numerical Recipes method). */
function gammaQ(a: number, x: number): number {
  const lnGamma = (z: number) => {
    const c = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, 0.1208650973866179e-2, -0.5395239384953e-5];
    let y = z, t = z + 5.5; t -= (z + 0.5) * Math.log(t);
    let ser = 1.000000000190015;
    for (const ci of c) ser += ci / ++y;
    return -t + Math.log(2.5066282746310005 * ser / z);
  };
  if (x <= 0) return 1;
  if (x < a + 1) {
    let sum = 1 / a, del = sum, ap = a;
    for (let n = 0; n < 1000; n++) { ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-14) break; }
    return 1 - sum * Math.exp(-x + a * Math.log(x) - lnGamma(a));
  }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i < 1000; i++) {
    const an = -i * (i - a); b += 2;
    d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300;
    c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300;
    d = 1 / d; const del = d * c; h *= del;
    if (Math.abs(del - 1) < 1e-14) break;
  }
  return Math.exp(-x + a * Math.log(x) - lnGamma(a)) * h;
}

export interface Result { name: string; samples: number; categories: number; chiSquare: number; pValue: number }

function chi(name: string, counts: number[], expected: number, df = counts.length - 1): Result {
  const x = counts.reduce((s, c) => s + (c - expected) ** 2 / expected, 0);
  return { name, samples: counts.reduce((a, b) => a + b, 0), categories: counts.length, chiSquare: Math.round(x * 100) / 100, pValue: gammaQ(df / 2, x / 2) };
}

export function runStats(scale = 1): Result[] {
  const out: Result[] = [];
  // 1. Every value of nextInt(n) equally likely.
  for (const n of [2, 3, 7, 10, 100, 1000]) {
    const N = Math.round(1_000_000 * scale), counts = new Array<number>(n).fill(0), s = new SeededStream(fixed(`stats-int-${n}`));
    for (let i = 0; i < N; i++) counts[s.nextInt(n)]!++;
    out.push(chi(`nextInt(${n}): each value`, counts, N / n));
  }
  // 2. Shuffle: each item equally likely to end up in each position.
  {
    const k = 10, N = Math.round(200_000 * scale), counts = new Array<number>(k * k).fill(0), s = new SeededStream(fixed("stats-shuffle"));
    const items = Array.from({ length: k }, (_, i) => i);
    for (let i = 0; i < N; i++) shuffle(items, s).forEach((item, pos) => counts[item * k + pos]!++);
    // A table whose rows and columns both have fixed totals: (k-1)^2 degrees of freedom.
    out.push(chi("shuffle of 10: each item in each position", counts, N / k, (k - 1) ** 2));
  }
  // 3. Inventory: a single prize equally likely to land on any card.
  {
    const n = 100, N = Math.round(100_000 * scale), counts = new Array<number>(n).fill(0);
    for (let i = 0; i < N; i++) counts[generateOutcomes(n, [{ outcome: "CASH:1", count: 1 }], fixed(`stats-inv-${i}`)).indexOf("CASH:1")]!++;
    out.push(chi("inventory of 100: position of the prize card", counts, N / n));
  }
  // 4. Draw: every entry equally likely to win the first prize, and the second.
  {
    const n = 50, N = Math.round(100_000 * scale), first = new Array<number>(n).fill(0), second = new Array<number>(n).fill(0);
    const entries = Array.from({ length: n }, (_, i) => `E${String(i).padStart(2, "0")}`);
    for (let i = 0; i < N; i++) {
      const w = runDraw(entries, [{ prizeId: "a", quantity: 1 }, { prizeId: "b", quantity: 1 }], fixed(`stats-draw-${i}`));
      first[Number(w[0]!.serial.slice(1))]!++; second[Number(w[1]!.serial.slice(1))]!++;
    }
    out.push(chi("draw of 50 entries: winner of first prize", first, N / n));
    out.push(chi("draw of 50 entries: winner of second prize", second, N / n));
  }
  return out;
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  const scale = Number(process.argv[2] ?? 1);
  console.log("| Test | Samples | Categories | Chi-square | p-value |\n|------|--------:|-----------:|-----------:|--------:|");
  for (const r of runStats(scale)) console.log(`| ${r.name} | ${r.samples.toLocaleString("en")} | ${r.categories} | ${r.chiSquare} | ${r.pValue.toFixed(3)} |`);
}
