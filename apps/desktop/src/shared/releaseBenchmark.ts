export type BenchmarkMark = 'success' | 'partial' | 'failure'

export function benchmarkOutcome(status: string): BenchmarkMark {
  if (status === 'success_verified') {
    return 'success'
  }
  if (status === 'changed_but_unverified' || status === 'needs_permission') {
    return 'partial'
  }
  return 'failure'
}
