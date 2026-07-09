export interface JobOptions {
  singletonKey?: string;
  retryLimit?: number;
}

export interface Queue {
  publish(jobName: string, data: unknown, opts?: JobOptions): Promise<void>;
  subscribe(jobName: string, handler: (data: unknown) => Promise<void>): Promise<void>;
}
