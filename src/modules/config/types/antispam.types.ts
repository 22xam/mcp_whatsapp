export interface AntispamConfig {
  delayMin_ms: number;
  delayMax_ms: number;
  delayFirstContact_ms: number;
  maxPerDay: number;
  maxPerHour: number;
  pauseAfterBatch: number;
  batchSize: number;
  sendWindowStart: string;
  sendWindowEnd: string;
  maxConsecutiveDays: number;
  warmupMode: boolean;
  warmupSchedule: number[];
}
