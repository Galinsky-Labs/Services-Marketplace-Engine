import type {MetricSample} from '@services-marketplace/contracts';

/** Bounded in-process metric samples used by /metrics and alert evaluation. */
export class MetricsRecorder {
  readonly #samples: MetricSample[] = [];
  readonly #counters = new Map<string, number>();
  readonly startedAt: number;

  constructor(private readonly now: () => number, private readonly capacity = 20_000) {
    this.startedAt = now();
  }

  record(metric: string, value: number): void {
    this.#samples.push({metric, at: this.now(), value});
    if (this.#samples.length > this.capacity) this.#samples.splice(0, this.#samples.length - this.capacity);
    this.#counters.set(metric, (this.#counters.get(metric) ?? 0) + 1);
  }

  samples(): readonly MetricSample[] {
    return this.#samples;
  }

  counters(): Readonly<Record<string, number>> {
    return Object.fromEntries([...this.#counters.entries()].sort(([left], [right]) =>
      left < right ? -1 : 1));
  }
}
