export interface PipelineTimings {
  rmsMs: number;
  smoothMs: number;
  bleCallMs: number;
  totalTickMs: number;
}

let _timings: PipelineTimings = { rmsMs: 0, smoothMs: 0, bleCallMs: 0, totalTickMs: 0 };

export function setPipelineTimings(t: PipelineTimings) { _timings = t; }
export function getPipelineTimings(): PipelineTimings { return _timings; }
