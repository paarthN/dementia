import { agentBusy, type AgentStatus } from '../../shared/agentStatus'

export function AgentProgress({
  status,
  onPause,
  onResume,
  onStop,
  onConfirm,
  onAllowScreen,
  onGuide
}: {
  status: AgentStatus | null
  onPause: () => void
  onResume: () => void
  onStop: () => void
  onConfirm: () => void
  onAllowScreen: () => void
  onGuide: () => void
}): React.JSX.Element | null {
  if (!status) {
    return null
  }
  const busy = agentBusy(status)
  const screenAccess = status.permissionReason?.includes('screen access') === true
  const showGuide =
    Boolean(status.permissionReason) ||
    status.state === 'failed' ||
    status.state === 'partial' ||
    status.state === 'uncertain'
  const primary = status.approval ? 'confirm' : screenAccess ? 'screen' : null

  return (
    <section className="agent-progress" aria-label="Task progress">
      <p>{`I'm helping you: ${status.goal}`}</p>
      {status.current !== status.permissionReason ? (
        <p aria-live="polite">{status.current}</p>
      ) : null}
      {status.verified && status.completed ? <p>{status.completed}</p> : null}
      {status.step > 0 ? <p>{`Step ${status.step}`}</p> : null}
      {status.observing ? <p>Companion is looking at this screen.</p> : null}
      {status.permissionReason ? (
        <section aria-label={screenAccess ? 'Screen access' : 'Permission'}>
          <p>{status.permissionReason}</p>
          {screenAccess ? (
            <button
              type="button"
              className={primary === 'screen' ? 'primary' : 'quiet'}
              onClick={onAllowScreen}
            >
              Allow screen access
            </button>
          ) : null}
        </section>
      ) : null}
      {status.approval ? (
        <section aria-label="Approval">
          <p>{status.approval.what}</p>
          <button
            type="button"
            className={primary === 'confirm' ? 'primary' : 'quiet'}
            onClick={onConfirm}
          >
            {status.approval.confirmLabel}
          </button>
          <button type="button" className="quiet" onClick={onStop}>
            Cancel
          </button>
        </section>
      ) : null}
      <div className="choice-row">
        {busy && status.state !== 'paused' ? (
          <button type="button" className="quiet" onClick={onPause}>
            Pause
          </button>
        ) : null}
        {status.state === 'paused' ? (
          <button type="button" className="quiet" onClick={onResume}>
            Resume
          </button>
        ) : null}
        {busy ? (
          <button type="button" className="quiet" onClick={onStop}>
            Stop
          </button>
        ) : null}
        {showGuide ? (
          <button type="button" className="quiet" onClick={onGuide}>
            Do it myself
          </button>
        ) : null}
      </div>
    </section>
  )
}
