declare module 'density-clustering' {
  export class DBSCAN {
    run(dataset: number[][], epsilon: number, minPts: number): number[][];
  }
}
