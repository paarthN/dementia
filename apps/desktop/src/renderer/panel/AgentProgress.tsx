import { agentProgressView } from '../../shared/agentProgressView'
import type { SessionSnapshot } from '../../shared/session'

export function AgentProgress({
  session,
  onEdit
}: {
  session: SessionSnapshot
  onEdit: (text: string) => void
}): React.JSX.Element | null {
  const view = agentProgressView({
    messages: session.messages,
    activeTask: session.activeTask,
    pendingApproval: session.pendingApproval
  })
  if (!view) {
    return null
  }
  const approval = view.approval
  const permission = view.permission

  return (
    <section className="progress-strip" aria-label="Current task">
      <p className="progress-status" role="status">
        {view.status}
      </p>
      {view.goal ? <p>You asked: {view.goal}</p> : null}
      {view.now ? <p>{view.now}</p> : null}
      {view.finished ? <p className="muted">Finished: {view.finished}</p> : null}
      {approval ? (
        <div className="progress-card">
          <p>{approval.what}</p>
          <p>{approval.change}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() =>
                void window.companion.confirmChat(approval.taskId, approval.approvalId)
              }
            >
              {approval.confirmLabel}
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => {
                if (approval.editText) {
                  onEdit(approval.editText)
                }
                void window.companion.cancelChat(approval.taskId)
              }}
            >
              Edit
            </button>
            <button
              type="button"
              className="quiet"
              onClick={() => void window.companion.cancelChat(approval.taskId)}
            >
              Cancel
            </button>
          </div>
        </div>
      ) : null}
      {permission ? (
        <div className="progress-card">
          <p>{permission.reason}</p>
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => void window.companion.setScreenAccess(true)}
            >
              Allow screen access
            </button>
            {permission.goal ? (
              <button
                type="button"
                className="quiet"
                onClick={() =>
                  void window.companion.submitChat({ text: permission.goal ?? '', mode: 'guide' })
                }
              >
                Show me how instead
              </button>
            ) : null}
            <button
              type="button"
              className="quiet"
              onClick={() => void window.companion.cancelChat(permission.taskId)}
            >
              Stop
            </button>
          </div>
        </div>
      ) : null}
      {view.stopTaskId ? (
        <button
          type="button"
          className="quiet"
          onClick={() => void window.companion.cancelChat(view.stopTaskId ?? '')}
        >
          Stop
        </button>
      ) : null}
    </section>
  )
}
