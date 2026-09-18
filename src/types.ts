export interface BridgeInstance {
  name: string;
  cwd: string;
  pid: number;
  environmentId: string;
  capacity: number;
  workers: number;
  spawnMode: string | null;
}

export interface SessionSummary {
  id: string;
  title: string;
  status: string;
  statusBucket: string;
  workerStatus: string;
  connectionStatus: string;
  environmentId: string;
  lastEventAt: string;
  spawnedBy: string | null;
  createdByThisServer: boolean;
}

export interface TurnResult {
  text: string;
  isError: boolean;
  stopReason: string | null;
  numTurns: number | null;
  permissionDenials: unknown[];
  costUsd: number | null;
}
