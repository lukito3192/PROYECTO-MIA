/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
*/

import { Transaction, RFMRecord, ClusterCentroid } from './types';

export const generateId = () => Date.now().toString(36) + Math.random().toString(36).substring(2);

// --- K-MEANS LOGIC ---

function distance(a: number[], b: number[]): number {
  return Math.sqrt(
    (a[0] - b[0]) ** 2 + 
    (a[1] - b[1]) ** 2 + 
    (a[2] - b[2]) ** 2
  );
}

// Normalize data to 0-1 range to ensure fair weighting in K-Means
function normalize(data: RFMRecord[]): { normalized: number[][], mins: number[], maxs: number[] } {
  const r = data.map(d => d.recency);
  const f = data.map(d => d.frequency);
  const m = data.map(d => d.monetary);

  const minR = Math.min(...r), maxR = Math.max(...r);
  const minF = Math.min(...f), maxF = Math.max(...f);
  const minM = Math.min(...m), maxM = Math.max(...m);

  const safeDiv = (val: number, min: number, max: number) => (max - min === 0) ? 0 : (val - min) / (max - min);

  const normalized = data.map(d => [
    safeDiv(d.recency, minR, maxR),
    safeDiv(d.frequency, minF, maxF),
    safeDiv(d.monetary, minM, maxM)
  ]);

  return { normalized, mins: [minR, minF, minM], maxs: [maxR, maxF, maxM] };
}

export function performKMeans(data: RFMRecord[], k: number = 4): RFMRecord[] {
  if (!data || data.length === 0) return [];
  
  // Safety: Cannot have more clusters than data points
  const safeK = Math.min(k, data.length);
  if (safeK === 0) return data;

  const { normalized } = normalize(data);
  
  // Randomly initialize centroids
  // We use a set to ensure unique initial starting points if possible
  const uniqueIndices = new Set<number>();
  while (uniqueIndices.size < safeK) {
    uniqueIndices.add(Math.floor(Math.random() * normalized.length));
  }
  let centroids = Array.from(uniqueIndices).map(idx => normalized[idx]);
  
  let assignments = new Array(normalized.length).fill(-1);
  let iterations = 0;
  const maxIterations = 20;

  while (iterations < maxIterations) {
    let changed = false;

    // Assignment Step
    for (let i = 0; i < normalized.length; i++) {
      let minDist = Infinity;
      let clusterIdx = 0; // Default to 0
      
      for (let c = 0; c < safeK; c++) {
        const d = distance(normalized[i], centroids[c]);
        if (d < minDist) {
          minDist = d;
          clusterIdx = c;
        }
      }

      if (assignments[i] !== clusterIdx) {
        assignments[i] = clusterIdx;
        changed = true;
      }
    }

    // Update Centroids Step
    if (!changed) break;

    const newCentroids = Array(safeK).fill(0).map(() => [0, 0, 0]);
    const counts = Array(safeK).fill(0);

    for (let i = 0; i < normalized.length; i++) {
      const cluster = assignments[i];
      // Guard clause in case assignment somehow went out of bounds
      if (cluster >= 0 && cluster < safeK) {
          newCentroids[cluster][0] += normalized[i][0];
          newCentroids[cluster][1] += normalized[i][1];
          newCentroids[cluster][2] += normalized[i][2];
          counts[cluster]++;
      }
    }

    centroids = newCentroids.map((c, i) => counts[i] > 0 ? [c[0]/counts[i], c[1]/counts[i], c[2]/counts[i]] : centroids[i]);
    iterations++;
  }

  // Map results back to original data
  return data.map((record, i) => ({
    ...record,
    clusterIndex: assignments[i]
  }));
}

// --- RFM CALCULATION LOGIC ---

export function calculateRFM(transactions: Transaction[]): RFMRecord[] {
  const customerMap = new Map<string, { lastDate: Date; count: number; total: number }>();
  
  // Find generic column names if CSV headers are messy, but assuming clean input for now
  // In a prod app, we'd do smarter column mapping.
  
  transactions.forEach(t => {
    if (!t.CustomerID || !t.Date) return;

    // Basic cleaning
    const amountStr = String(t.Amount).replace(/[^0-9.-]+/g,"");
    const amount = amountStr ? parseFloat(amountStr) : 0;
    const date = new Date(t.Date);
    
    // Invalid date check
    if (isNaN(date.getTime())) return;

    const existing = customerMap.get(t.CustomerID);
    if (existing) {
      existing.lastDate = date > existing.lastDate ? date : existing.lastDate;
      existing.count += 1;
      existing.total += amount;
    } else {
      customerMap.set(t.CustomerID, { lastDate: date, count: 1, total: amount });
    }
  });

  if (customerMap.size === 0) return [];

  const now = new Date(); // Or max date in dataset for historical accuracy
  // Find the absolute latest date in the dataset to calculate "Recency" relative to that, 
  // ensuring the data isn't skewed if the CSV is old.
  const datasetMaxDate = new Date(Math.max(...Array.from(customerMap.values()).map(c => c.lastDate.getTime())));

  const rfmData: RFMRecord[] = [];

  customerMap.forEach((value, key) => {
    // Recency: Days since last purchase
    const diffTime = Math.abs(datasetMaxDate.getTime() - value.lastDate.getTime());
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24)); 

    rfmData.push({
      customerId: key,
      recency: diffDays,
      frequency: value.count,
      monetary: parseFloat(value.total.toFixed(2)),
      clusterIndex: 0
    });
  });

  return rfmData;
}

export function getClusterStats(data: RFMRecord[], k: number): ClusterCentroid[] {
  const stats: ClusterCentroid[] = [];
  // Calculate actual number of clusters found (max index + 1)
  const maxClusterIndex = data.reduce((max, d) => Math.max(max, d.clusterIndex), -1);
  const actualK = maxClusterIndex + 1;
  
  for(let i=0; i<actualK; i++) {
    const clusterData = data.filter(d => d.clusterIndex === i);
    const count = clusterData.length;
    
    if (count === 0) {
      stats.push({ recency: 0, frequency: 0, monetary: 0, count: 0 });
      continue;
    }

    const avgR = clusterData.reduce((sum, d) => sum + d.recency, 0) / count;
    const avgF = clusterData.reduce((sum, d) => sum + d.frequency, 0) / count;
    const avgM = clusterData.reduce((sum, d) => sum + d.monetary, 0) / count;

    stats.push({
      recency: Math.round(avgR),
      frequency: parseFloat(avgF.toFixed(1)),
      monetary: parseFloat(avgM.toFixed(2)),
      count
    });
  }
  return stats;
}