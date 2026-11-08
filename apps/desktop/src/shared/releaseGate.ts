export function releaseBlockers(input: {
  developerId: boolean
  notarized: boolean
  gatekeeperAccepted: boolean
}): string[] {
  const blockers: string[] = []
  if (!input.developerId) {
    blockers.push('No Developer ID certificate.')
  }
  if (!input.notarized) {
    blockers.push('Notarization has not been run.')
  }
  if (!input.gatekeeperAccepted) {
    blockers.push('Gatekeeper has not accepted this build.')
  }
  return blockers
}
