import { PfColors } from '../components/Pf/PfColors';
import { getName } from '../utils/RateIntervals';

interface HealthItem {
  status: Status;
  title: string;
  text?: string;
  children?: HealthSubItem[];
}

interface HealthSubItem {
  status: Status;
  text: string;
}

export interface WorkloadStatus {
  name: string;
  replicas: number;
  available: number;
}

export interface RequestHealth {
  errorRatio: number;
  inboundErrorRatio: number;
  outboundErrorRatio: number;
}

export interface Status {
  name: string;
  color: string;
  priority: number;
  icon?: string;
  text?: string;
}

export const FAILURE: Status = {
  name: 'Failure',
  color: PfColors.Red100,
  priority: 3,
  icon: 'error-circle-o'
};
export const DEGRADED: Status = {
  name: 'Degraded',
  color: PfColors.Orange400,
  priority: 2,
  icon: 'warning-triangle-o'
};
export const HEALTHY: Status = {
  name: 'Healthy',
  color: PfColors.Green400,
  priority: 1,
  icon: 'ok'
};
export const NA: Status = {
  name: 'No health information',
  color: PfColors.Gray,
  priority: 0,
  text: 'N/A'
};

interface Thresholds {
  degraded: number;
  failure: number;
  unit: string;
}

export const REQUESTS_THRESHOLDS: Thresholds = {
  degraded: 0.1,
  failure: 20,
  unit: '%'
};

interface ThresholdStatus {
  value: number;
  status: Status;
  violation?: string;
}

// Use -1 rather than NaN to allow straigthforward comparison
const RATIO_NA = -1;

export const ratioCheck = (valid: number, total: number): Status => {
  if (total === 0) {
    return NA;
  } else if (valid === 0) {
    return FAILURE;
  } else if (valid === total) {
    return HEALTHY;
  }
  return DEGRADED;
};

export const mergeStatus = (s1: Status, s2: Status): Status => {
  return s1.priority > s2.priority ? s1 : s2;
};

const ascendingThresholdCheck = (value: number, thresholds: Thresholds): ThresholdStatus => {
  if (value >= thresholds.failure) {
    return {
      value: value,
      status: FAILURE,
      violation: value.toFixed(2) + thresholds.unit + '>=' + thresholds.failure + thresholds.unit
    };
  } else if (value >= thresholds.degraded) {
    return {
      value: value,
      status: DEGRADED,
      violation: value.toFixed(2) + thresholds.unit + '>=' + thresholds.degraded + thresholds.unit
    };
  }
  return { value: value, status: HEALTHY };
};

export const getRequestErrorsStatus = (ratio: number): ThresholdStatus => {
  if (ratio < 0) {
    return {
      value: RATIO_NA,
      status: NA
    };
  }
  return ascendingThresholdCheck(100 * ratio, REQUESTS_THRESHOLDS);
};

export const getRequestErrorsSubItem = (thresholdStatus: ThresholdStatus, prefix: string): HealthSubItem => {
  return {
    status: thresholdStatus.status,
    text: prefix + ': ' + (thresholdStatus.status === NA ? 'No requests' : thresholdStatus.value.toFixed(2) + '%')
  };
};

export const getRequestErrorsViolations = (reqIn: ThresholdStatus, reqOut: ThresholdStatus): string => {
  const violations: string[] = [];
  if (reqIn.violation) {
    violations.push(`Inbound errors: ${reqIn.violation}`);
  }
  if (reqOut.violation) {
    violations.push(`Outbound errors: ${reqOut.violation}`);
  }
  return violations.join(', ');
};

export abstract class Health {
  items: HealthItem[];

  constructor(items: HealthItem[]) {
    this.items = items;
  }

  getGlobalStatus(): Status {
    return this.items.map(i => i.status).reduce((prev, cur) => mergeStatus(prev, cur), NA);
  }
}

export class ServiceHealth extends Health {
  public static fromJson = (json: any, rateInterval: number) => new ServiceHealth(json.requests, rateInterval);

  private static computeItems(requests: RequestHealth, rateInterval: number): HealthItem[] {
    const items: HealthItem[] = [];
    {
      // Request errors
      const reqErrorsRatio = getRequestErrorsStatus(requests.errorRatio);
      const reqErrorsText = reqErrorsRatio.status === NA ? 'No requests' : reqErrorsRatio.value.toFixed(2) + '%';
      const item: HealthItem = {
        title: 'Error Rate',
        status: reqErrorsRatio.status,
        text: reqErrorsText + ' over ' + getName(rateInterval).toLowerCase()
      };
      items.push(item);
    }
    return items;
  }

  constructor(public requests: RequestHealth, public rateInterval: number) {
    super(ServiceHealth.computeItems(requests, rateInterval));
  }
}

export class AppHealth extends Health {
  public static fromJson = (json: any, rateInterval: number) =>
    new AppHealth(json.workloadStatuses, json.requests, rateInterval);

  private static computeItems(
    workloadStatuses: WorkloadStatus[],
    requests: RequestHealth,
    rateInterval: number
  ): HealthItem[] {
    const items: HealthItem[] = [];
    {
      // Pods
      let countInactive = 0;
      const children: HealthSubItem[] = workloadStatuses.map(d => {
        const status = ratioCheck(d.available, d.replicas);
        if (status === NA) {
          countInactive++;
        }
        return {
          text: d.name + ': ' + d.available + ' / ' + d.replicas,
          status: status
        };
      });
      const podsStatus = children.map(i => i.status).reduce((prev, cur) => mergeStatus(prev, cur), NA);
      const item: HealthItem = {
        title: 'Pods Status',
        status: podsStatus,
        children: children
      };
      if (countInactive > 0 && countInactive === workloadStatuses.length) {
        // No active deployment => special case for failure
        item.status = FAILURE;
      }
      items.push(item);
    }
    {
      // Request errors
      const reqIn = getRequestErrorsStatus(requests.inboundErrorRatio);
      const reqOut = getRequestErrorsStatus(requests.outboundErrorRatio);
      const both = mergeStatus(reqIn.status, reqOut.status);
      const item: HealthItem = {
        title: 'Error Rate over ' + getName(rateInterval).toLowerCase(),
        status: both,
        children: [getRequestErrorsSubItem(reqIn, 'Inbound'), getRequestErrorsSubItem(reqOut, 'Outbound')]
      };
      items.push(item);
    }
    return items;
  }

  constructor(public workloadStatuses: WorkloadStatus[], public requests: RequestHealth, public rateInterval: number) {
    super(AppHealth.computeItems(workloadStatuses, requests, rateInterval));
  }
}

export class WorkloadHealth extends Health {
  public static fromJson = (json: any, rateInterval: number) =>
    new WorkloadHealth(json.workloadStatus, json.requests, rateInterval);

  private static computeItems(
    workloadStatus: WorkloadStatus,
    requests: RequestHealth,
    rateInterval: number
  ): HealthItem[] {
    const items: HealthItem[] = [];
    {
      // Pods
      const podsStatus = ratioCheck(workloadStatus.available, workloadStatus.replicas);
      const item: HealthItem = {
        title: 'Pods Status',
        status: podsStatus,
        text: String(workloadStatus.available + ' / ' + workloadStatus.replicas)
      };
      items.push(item);
    }
    {
      // Request errors
      const reqIn = getRequestErrorsStatus(requests.inboundErrorRatio);
      const reqOut = getRequestErrorsStatus(requests.outboundErrorRatio);
      const both = mergeStatus(reqIn.status, reqOut.status);
      const item: HealthItem = {
        title: 'Error Rate over ' + getName(rateInterval).toLowerCase(),
        status: both,
        children: [getRequestErrorsSubItem(reqIn, 'Inbound'), getRequestErrorsSubItem(reqOut, 'Outbound')]
      };
      items.push(item);
    }
    return items;
  }

  constructor(public workloadStatus: WorkloadStatus, public requests: RequestHealth, public rateInterval: number) {
    super(WorkloadHealth.computeItems(workloadStatus, requests, rateInterval));
  }
}

export const healthNotAvailable = (): AppHealth => {
  return new AppHealth([], { errorRatio: -1, inboundErrorRatio: -1, outboundErrorRatio: -1 }, 60);
};

export type NamespaceAppHealth = { [app: string]: AppHealth };
export type NamespaceServiceHealth = { [service: string]: ServiceHealth };
export type NamespaceWorkloadHealth = { [workload: string]: WorkloadHealth };
